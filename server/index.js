import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDemoApp } from './demoApp.js';
import { createPlan } from './agent.js';
import { generateTest } from './generator.js';
import { runWithStabilityCheck } from './runner.js';
import { createSitePlan, generateSiteTest } from './sitePlan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.SELF_BASE_URL || `http://127.0.0.1:${PORT}`;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(root, 'public')));
app.use('/demo', createDemoApp());

// In-memory session store: one entry per planned test.
const sessions = new Map();
let nextId = 1;

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
  s.status = 'running';
  s.approvedAt = new Date().toISOString();
  const versionOverride = req.body?.versionOverride === 'v2' ? 'v2' : req.body?.versionOverride === 'v1' ? 'v1' : null;
  s.runAgainst = versionOverride || s.plan.version;
  try {
    s.result = await runWithStabilityCheck(s.file, root, 1, versionOverride ? { DEMO_TARGET_VERSION: versionOverride } : {});
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
  }
  res.json(publicView(s));
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
