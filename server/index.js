import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoApp } from './demoApp.js';
import { createPlan } from './agent.js';
import { generateTest, signupSteps } from './generator.js';
import { runWithStabilityCheck } from './runner.js';
import { createSitePlan, generateSiteTest, siteSteps } from './sitePlan.js';

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

// Step 1-3: collect details, inspect the app, plan the test. Nothing runs yet.
app.post('/api/plan', async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    const version = req.body?.version === 'v2' ? 'v2' : 'v1';
    if (!message) return res.status(400).json({ error: 'Describe the flow to test.' });
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
      // Approved runs are what a person watches; pace them so the live view
      // shows each action instead of a blur. Unit tests and CI keep speed.
      LIVE_SLOWMO_MS: process.env.LIVE_SLOWMO_MS || '450',
    };
  const versionOverride = req.body?.versionOverride === 'v2' ? 'v2' : req.body?.versionOverride === 'v1' ? 'v1' : null;
  s.runAgainst = versionOverride || s.plan.version;
  try {
    s.result = await runWithStabilityCheck(s.file, root, 1, { ...liveEnv, ...(versionOverride ? { DEMO_TARGET_VERSION: versionOverride } : {}) });
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
    },
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
