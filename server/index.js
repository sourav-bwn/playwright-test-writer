import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoApp } from './demoApp.js';
import { createPlan } from './agent.js';
import { inspectSignupPage } from './inspector.js';
import { generateTest, signupSteps } from './generator.js';
import { runWithStabilityCheck } from './runner.js';
import { createSitePlan, generateSiteTest, siteSteps } from './sitePlan.js';
import { runAgentLoop, agentAvailable, AGENT_LIMITS } from './agentMode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.SELF_BASE_URL || `http://127.0.0.1:${PORT}`;

// Live browser frames are small base64 jpegs; the default 100kb limit would reject them.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(root, 'public')));
app.use('/demo', createDemoApp());

// In-memory session store: one entry per planned test.
const sessions = new Map();
let nextId = 1;

// Global capacity control: the free tier cannot run two browser jobs at once
// (two Playwright instances OOM-restart the instance and wipe in-memory
// sessions). One run at a time across BOTH demo and external jobs; every
// other approval gets an honest "busy" answer instead of a crashed server.
// The slot is released in a finally block, on success AND on every failure.
const MAX_CONCURRENT_RUNS = Math.max(1, Number(process.env.MAX_CONCURRENT_RUNS) || 1);
let activeRuns = 0;

app.get('/health', (req, res) => res.json({ ok: true }));

// Guardrail: prompts must use synthetic data only. Blocks obvious personal-data
// patterns (real-looking emails, phone numbers, long ID/card numbers). This is
// a basic pattern check, not a guarantee that all personal data is detected.
const PII_PATTERNS = [
  /[\w.+-]+@[\w-]+\.[\w.]+/, // email address
  /\b\d{12,16}\b/, // Aadhaar / card-length number
  /(?:\+?\d[\d\s()-]{8,}\d)/, // phone-like run of 10+ digits
];
function findObviousPii(text) {
  return PII_PATTERNS.some((re) => re.test(text));
}
const PII_ERROR = 'That looks like it contains personal data (an email, phone or ID number). Use synthetic test data only - the agent never runs real personal information.';

// Step 1-3: collect details, inspect the app, plan the test. Nothing runs yet.
app.post('/api/plan', async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    const version = req.body?.version === 'v2' ? 'v2' : 'v1';
    if (!message) return res.status(400).json({ error: 'Describe the flow to test.' });
    if (findObviousPii(message)) return res.status(400).json({ error: PII_ERROR, code: 'pii-detected' });
    const { plan, inspection, llm, validation } = await createPlan(message, BASE_URL, version);
    const code = generateTest({ plan, inspection });
    const id = `run-${nextId++}`;
    const file = path.join(root, 'generated-tests', `${id}.spec.js`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, code);
    sessions.set(id, {
      id,
      message,
      plan,
      inspection,
      llm,
      validation,
      code,
      file,
      steps: signupSteps({ plan, inspection }),
      status: 'awaiting-approval', // human approval required before any run
      createdAt: new Date().toISOString(),
      result: null,
    });
    const s = sessions.get(id);
    res.json({ ...publicView(s) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Plan read-only checks against a user-named external website. The generated
// test only reads the page: no filling, clicking, submitting or signing up.
app.post('/api/plan-site', async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    const url = String(req.body?.url || '').trim();
    if (!message) return res.status(400).json({ error: 'Describe what to check on the page.' });
    if (!url) return res.status(400).json({ error: 'Give the full website address to check.' });
    if (findObviousPii(message)) return res.status(400).json({ error: PII_ERROR, code: 'pii-detected' });
    const { plan, inspection, llm, validation } = await createSitePlan(message, url);
    const code = generateSiteTest({ url: plan.url, goal: plan.goal, checks: plan.checks });
    const id = `run-${nextId++}`;
    const file = path.join(root, 'generated-tests', `${id}.spec.js`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, code);
    sessions.set(id, {
      id,
      kind: 'site',
      message,
      plan,
      inspection: {
        source: inspection.source,
        selectors: {},
        fields: inspection.forms.flatMap((f) => f.inputs),
        submit: { label: inspection.forms[0]?.buttons?.[0]?.label || '(none)' },
        forms: inspection.forms,
        title: inspection.title,
        h1: inspection.h1,
      },
      llm,
      validation,
      code,
      file,
      steps: siteSteps({ url: plan.url, checks: plan.checks }),
      status: 'awaiting-approval', // human approval required before any run
      createdAt: new Date().toISOString(),
      result: null,
    });
    res.json({ ...publicView(sessions.get(id)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Step 4: human approved -> run the test, then rerun to check stability.
app.post('/api/run/:id', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Unknown session.' });
  if (s.status === 'running') return res.status(409).json({ error: 'Already running.' });
  // Idempotency lock: a deterministic signature of this exact approved request
  // (generated test + target version). Once it has executed, a retry of the
  // same request returns the existing result instead of executing twice.
  const runSignature = crypto
    .createHash('sha256')
    .update(s.code + '|' + (req.body?.versionOverride || s.plan.version))
    .digest('hex')
    .slice(0, 16);
  s.executedSignatures = s.executedSignatures || [];
  if (s.executedSignatures.includes(runSignature)) {
    return res.status(409).json({
      error: 'This approved request was already executed; retrying it does not run it twice. Start a new plan to run the flow again.',
      code: 'already-executed',
      runSignature,
      result: s.result,
    });
  }
  if (activeRuns >= MAX_CONCURRENT_RUNS) {
    // Global busy: another session's run holds the single browser slot.
    // The session stays awaiting-approval so the user can approve again once
    // the other run finishes. We never launch a second browser job.
    return res.status(409).json({
      error: 'Another run is in progress right now. This demo runs one browser job at a time (free tier); wait for it to finish, then approve again.',
      code: 'capacity',
    });
  }
  activeRuns++;
  s.status = 'running';
  s.approvedAt = new Date().toISOString();
  s.liveFrame = null; // drop any frame left over from an earlier run
  s.liveFrames = []; // filmstrip of recent real frames from this run
  s.liveActions = {}; // per-step live progress reported by the running test
  // The spawned test posts its browser's real frames to this loopback address.
  const liveEnv = {
      LIVE_FRAME_URL: `http://127.0.0.1:${PORT}/api/live/${s.id}/frame`,
      LIVE_ACTION_URL: `http://127.0.0.1:${PORT}/api/live/${s.id}/action`,
      LIVE_EVIDENCE_URL: `http://127.0.0.1:${PORT}/api/live/${s.id}/evidence`,
      // Approved runs are what a person watches; pace them so the live view
      // shows each action instead of a blur. Unit tests and CI keep speed.
      LIVE_SLOWMO_MS: process.env.LIVE_SLOWMO_MS || '450',
    };
  const versionOverride = req.body?.versionOverride === 'v2' ? 'v2' : req.body?.versionOverride === 'v1' ? 'v1' : null;
  s.runAgainst = versionOverride || s.plan.version;
  try {
    s.result = await runWithStabilityCheck(s.file, root, 1, { ...liveEnv, ...(versionOverride ? { DEMO_TARGET_VERSION: versionOverride } : {}) });
    s.executedSignatures.push(runSignature);
    // Evidence-based failure diagnosis: when a demo run fails, re-inspect the
    // page it actually ran against and compare it with the page the plan was
    // approved for. The explanation then names the concrete change, not just
    // the runner's error text.
    if (!s.result.passed && s.kind !== 'site') {
      try {
        const now = await inspectSignupPage(BASE_URL, s.runAgainst);
        const expectedIds = [s.inspection.selectors.name, s.inspection.selectors.email, s.inspection.selectors.password, s.inspection.selectors.submit];
        const actualIds = new Set([...now.fields.map((f) => f.testId).filter(Boolean), now.submit.testId, now.submit.id].filter(Boolean));
        const missing = expectedIds.filter((id) => id && !actualIds.has(id));
        const added = [...actualIds].filter((id) => !expectedIds.includes(id));
        s.domDiff = { checkedAt: new Date().toISOString(), ranAgainst: s.runAgainst, missing, added };
        if (missing.length || added.length) {
          const parts = [];
          if (missing.length) parts.push(`expected element(s) no longer present: ${missing.join(', ')}`);
          if (added.length) parts.push(`page now offers: ${added.join(', ')}`);
          const evidenceNote = ` Evidence re-check of the live page at ${s.domDiff.checkedAt}: ${parts.join('; ')}.`;
          for (const r of s.result.runs) if (!r.passed) r.explanation = (r.explanation || '') + evidenceNote;
        }
      } catch {
        // diagnosis is best-effort; the original explanation stands
      }
    }
    if (s.plan?.version === 'site' && s.result?.runs) {
      // honest plain-English wording for read-only external checks
      for (const r of s.result.runs) {
        if (r.passed) r.explanation = 'The read-only checks passed: the page loaded and showed what was asked. Nothing was filled, clicked, or changed.';
      }
    }
    s.status = 'done';
  } catch (err) {
    s.status = 'error';
    s.result = { error: err.message };
  } finally {
    activeRuns--;
  }
  res.json(publicView(s));
});


// Step-by-step agent mode: the agent observes the live page structure and
// chooses one action at a time (bounded, validated, DemoShop only). Same
// approval gate, capacity gate and idempotency lock as the generated-test
// flow. Plan first; nothing runs until the human approves.
// Scope gate for step-by-step agent mode: the demo's agent handles ONE job -
// creating a DemoShop account and verifying the dashboard. The final success
// assertion is hardwired to that outcome, so anything beyond it could false-pass.
// Conservative by design: a goal passes only when it clearly asks for the
// supported signup task AND names no other action, object or negation we do
// not handle. Uncertain goals are rejected with an honest scope message rather
// than allowed to run and risk a false pass.
const SIGNUP_INTENT = /\bsign([ -]?up| (me|us) up)\b|\bregister\b|\b(sign|create|make|open|start|join)\b.{0,40}\b(account|dashboard|membership)\b|\b(account|dashboard)\b.{0,40}\b(sign|create|make|open|register|join)\b/i;
const PROFILE_INTENT = /\b(edit|update|change|set|save)\b.{0,40}\b(profile|display[ -]?name|name|favorite|favourite|category|preferences?)\b|\b(profile|display[ -]?name|favorite|favourite|category)\b.{0,40}\b(edit|update|change|save)\b/i;
const UNSUPPORTED_TERMS = /\b(book|booking|flight|fly|hotel|ticket|movie|buy|purchase|order|cart|product|shop(?!.*account)|pay|payment|price|photo|picture|avatar|image|upload|delete|remove|cancel|reset|logout|log[ -]?out|log[ -]?in|login|search|browse|food|pizza|ride|cab|weather|phone|marathon|race|event|concert|webinar|newsletter|subscription|class|course|gym|club|contest|giveaway|trip|email(?!\s*(address|id))|password\s*(change|reset)|profile\s*(photo|picture))\b/i;
const NEGATION = /\b(don't|dont|do not|never|no\b|without|avoid|skip|not)\b/i;
const SCOPE_ERROR = "This demo's step-by-step agent handles exactly two tasks on DemoShop: creating a fresh account and verifying the dashboard, and editing the profile (display name + favorite category) with the saved values verified after a reload. Your goal is outside that scope (or asks for more than those tasks), so nothing was run - try 'create a fresh account and land on my dashboard' or 'create an account and update my profile'.";
function goalFamily(message) {
  const m = String(message || '').trim();
  if (!SIGNUP_INTENT.test(m) && !PROFILE_INTENT.test(m)) return null; // must clearly ask for a supported task
  if (NEGATION.test(m)) return null;            // negations make intent uncertain - reject conservatively
  if (UNSUPPORTED_TERMS.test(m)) return null;   // any other action/object (incl. compound goals) is unhandled
  return PROFILE_INTENT.test(m) ? 'profile' : 'signup'; // profile goals get the stronger saved-state assertion
}

app.post('/api/agent/plan', async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    const version = req.body?.version === 'v2' ? 'v2' : 'v1';
    if (!message) return res.status(400).json({ error: 'Describe the goal for the agent.' });
    if (findObviousPii(message)) return res.status(400).json({ error: PII_ERROR, code: 'pii-detected' });
    const family = goalFamily(message);
    if (!family) return res.status(400).json({ error: SCOPE_ERROR, code: 'out-of-scope' });
    if (!agentAvailable()) {
      return res.status(503).json({ error: 'Step-by-step agent mode needs its AI decision model, which is not configured on this server right now. The standard test flow still works.', code: 'agent-unavailable' });
    }
    const inspection = await inspectSignupPage(BASE_URL, version);
    const id = `run-${nextId++}`;
    sessions.set(id, {
      id,
      kind: 'agent',
      message,
      plan: {
        goal: message,
        taskFamily: family,
        version,
        flow: 'step-by-step-agent',
        mode: 'step-by-step',
        allowedActions: AGENT_LIMITS.actions,
        maxSteps: AGENT_LIMITS.maxSteps,
        maxSeconds: AGENT_LIMITS.maxSeconds,
        boundary: 'DemoShop only - the run aborts if the browser leaves the demo app',
      },
      inspection: { source: inspection.source, selectors: inspection.selectors, fields: inspection.fields, submit: inspection.submit },
      llm: { provider: 'gemini', note: 'Step-by-step mode: the model chooses each action live from the page structure; deterministic safety checks validate every proposed action before it executes.' },
      status: 'awaiting-approval',
      createdAt: new Date().toISOString(),
    });
    res.json(publicView(sessions.get(id)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent/run/:id', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || s.kind !== 'agent') return res.status(404).json({ error: 'Unknown agent session.' });
  if (s.status === 'running') return res.status(409).json({ error: 'Already running.' });
  const runSignature = crypto
    .createHash('sha256')
    .update('agent|' + s.message + '|' + s.plan.version)
    .digest('hex')
    .slice(0, 16);
  s.executedSignatures = s.executedSignatures || [];
  if (s.executedSignatures.includes(runSignature)) {
    return res.status(409).json({
      error: 'This approved request was already executed; retrying it does not run it twice. Start a new plan to run the flow again.',
      code: 'already-executed',
      runSignature,
      result: s.result,
    });
  }
  if (activeRuns >= MAX_CONCURRENT_RUNS) {
    return res.status(409).json({
      error: 'Another run is in progress right now. This demo runs one browser job at a time (free tier); wait for it to finish, then approve again.',
      code: 'capacity',
    });
  }
  activeRuns++;
  s.status = 'running';
  s.approvedAt = new Date().toISOString();
  s.liveFrame = null;
  s.liveFrames = [];
  s.liveActions = {};
  const live = {
    frameUrl: `http://127.0.0.1:${PORT}/api/live/${s.id}/frame`,
    actionUrl: `http://127.0.0.1:${PORT}/api/live/${s.id}/action`,
    evidenceUrl: `http://127.0.0.1:${PORT}/api/live/${s.id}/evidence`,
    slowmoMs: Number(process.env.LIVE_SLOWMO_MS || '450'),
  };
  try {
    const outcome = await runAgentLoop({ goal: s.message, version: s.plan.version, baseUrl: BASE_URL, live, family: s.plan.taskFamily || 'signup' });
    s.executedSignatures.push(runSignature);
    s.steps = outcome.steps;
    s.result = {
      passed: outcome.passed,
      stable: true, // single exploratory run; no rerun pair to compare
      mode: 'step-by-step',
      runs: [{ passed: outcome.passed, explanation: outcome.explanation, durationMs: outcome.durationMs, steps: outcome.steps, modelsUsed: outcome.modelsUsed }],
    };
    s.status = 'done';
  } catch (err) {
    s.status = 'error';
    s.result = { error: err.message };
  } finally {
    activeRuns--;
  }
  res.json(publicView(s));
});

// Live view: the approved test's own browser streams its real screen here,
// one jpeg frame at a time, while it navigates, types and clicks. Only the
// latest frame is kept - this is a live window, not a recording.
app.post('/api/live/:id/frame', (req, res) => {
  const s = sessions.get(req.params.id);
  // Frames are only meaningful while their session's approved run is active.
  if (!s || s.status !== 'running') return res.status(409).json({ ok: false });
  const data = String(req.body?.data || '');
  if (!data || data.length > 1_400_000) return res.status(400).json({ ok: false });
  s.liveFrame = {
    data,
    url: String(req.body?.url || ''),
    at: new Date().toISOString(),
    seq: (s.liveFrame?.seq || 0) + 1,
  };
  // Keep a short real frame history for the filmstrip (newest last).
  s.liveFrames = s.liveFrames || [];
  s.liveFrames.push({ data, at: s.liveFrame.at });
  if (s.liveFrames.length > 8) s.liveFrames.splice(0, s.liveFrames.length - 8);
  res.json({ ok: true });
});

// Live per-action progress: the running generated test reports which step of
// the approved plan it is performing right now (running/done/failed), keyed
// by the same step indices shown at the approval gate.
app.post('/api/live/:id/action', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || s.status !== 'running') return res.status(409).json({ ok: false });
  const index = Number(req.body?.index);
  const status = String(req.body?.status || '');
  if (!Number.isInteger(index) || index < 0 || index > 60) return res.status(400).json({ ok: false });
  if (!['running', 'done', 'failed'].includes(status)) return res.status(400).json({ ok: false });
  s.liveActions = s.liveActions || {};
  s.liveActions[index] = { index, status, at: String(req.body?.at || new Date().toISOString()) };
  res.json({ ok: true });
});

// One poll for the whole live workspace: latest frame, recent frames, and
// per-step progress, so the page does not need three separate pollers.
app.get('/api/live/:id/state', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Unknown session.' });
  const actions = Object.values(s.liveActions || {}).sort((a, b) => a.index - b.index);
  const current = actions.filter((a) => a.status === 'running').map((a) => a.index);
  res.json({
    status: s.status,
    frame: s.liveFrame || null,
    frames: s.liveFrames || [],
    actions,
    currentIndex: current.length ? Math.max(...current) : -1,
  });
});

// Run evidence posted by the test browser itself (aria snapshot of the page
// it actually ran against). Same rules as frames: only while running.
app.post('/api/live/:id/evidence', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || s.status !== 'running') return res.status(409).json({ ok: false });
  const kind = String(req.body?.kind || '');
  const text = String(req.body?.text || '');
  if (kind !== 'aria-snapshot' || !text || text.length > 9000) return res.status(400).json({ ok: false });
  s.ariaSnapshot = { at: String(req.body?.at || new Date().toISOString()), text: text.slice(0, 8000) };
  res.json({ ok: true });
});

app.get('/api/live/:id/frame', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s || !s.liveFrame) return res.status(204).end();
  res.json(s.liveFrame);
});

app.get('/api/session/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Unknown session.' });
  res.json(publicView(s));
});

app.get('/api/sessions', (req, res) => {
  res.json([...sessions.values()].map((s) => ({ id: s.id, message: s.message, status: s.status, createdAt: s.createdAt })));
});

function publicView(s) {
  return {
    id: s.id,
    message: s.message,
    status: s.status,
    createdAt: s.createdAt,
    approvedAt: s.approvedAt || null,
    plan: s.plan,
    llm: s.llm,
    validation: s.validation,
    evidence: {
      source: s.inspection.source,
      selectors: s.inspection.selectors,
      fieldsFound: s.inspection.fields,
      submitFound: s.inspection.submit,
      ariaSnapshot: s.ariaSnapshot || null,
    },
    domDiff: s.domDiff || null,
    executedSignatures: s.executedSignatures || [],
    code: s.code,
    steps: s.steps || [],
    runAgainst: s.runAgainst || s.plan.version,
    result: s.result,
  };
}

export { app };

// Listen only when run directly (`node server/index.js`), so tests can import
// the app and bind it to an ephemeral port instead.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(PORT, () => {
    console.log(`Plain-English Playwright Test Writer on :${PORT} (demo at /demo/v1/signup)`);
  });
}
