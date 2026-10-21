// The agent brain: turns a plain-English flow into a validated test plan.
// Two paths:
//   1. Gemini (when GEMINI_API_KEY is set) - retries, then falls back to a second model.
//   2. Built-in rule planner - deterministic fallback so the agent still works
//      when the free LLM tier is overloaded or no key is set.
import { inspectSignupPage } from './inspector.js';

const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest';

const PLAN_SCHEMA_HINT = `Reply with ONLY a JSON object, no markdown:
{
  "goal": "one sentence describing what the test proves",
  "flow": "signup",
  "fields": { "name": "person name to type", "email": "email to type", "password": "password to type" },
  "expectedEndState": "what the user should see at the end",
  "assertions": ["welcome-visible", "user-record-exists", "no-duplicate-account"]
}
Valid assertions: welcome-visible, user-record-exists, no-duplicate-account, url-contains-dashboard.`;

async function callGemini(model, prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini ${model} HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const match = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Gemini ${model} returned no JSON`);
  return JSON.parse(match[0]);
}

// Deterministic planner used as fallback and for offline development.
function ruleBasedPlan(message) {
  const text = message.toLowerCase();
  const asksUrlOnly = /only (check|assert).*url|just (check|assert).*url|url only/.test(text);
  const mentionsSignup = /sign[ -]?up|register|create (an? )?account/.test(text);
  if (!mentionsSignup) {
    throw new Error('I only know the sign-up flow of the demo app for now. Try: "Test that a user can sign up and see the dashboard".');
  }
  return {
    goal: 'A new user can sign up and land on their dashboard.',
    flow: 'signup',
    fields: { name: 'Test User', email: 'AUTO_GENERATED', password: 'Passw0rd!123' },
    expectedEndState: 'The dashboard welcomes the new user by name.',
    // A URL check alone is weak: the agent upgrades it to real state assertions.
    assertions: asksUrlOnly
      ? ['welcome-visible', 'user-record-exists', 'no-duplicate-account']
      : ['welcome-visible', 'user-record-exists', 'no-duplicate-account'],
    weakRequestUpgraded: asksUrlOnly,
  };
}

const SUPPORTED_ASSERTIONS = ['welcome-visible', 'user-record-exists', 'no-duplicate-account', 'url-contains-dashboard'];
const REQUIRED_ASSERTIONS = ['welcome-visible', 'user-record-exists', 'no-duplicate-account'];

// Deterministic validator: the model is advisory. Returns { problems, repairs }.
// Repairs are fixes applied in place (recorded, not failures); problems are unresolved.
export function validatePlan(plan) {
  const problems = [];
  const repairs = [];
  if (!plan || typeof plan !== 'object') return { problems: ['plan is not an object'], repairs };
  if (plan.flow !== 'signup') problems.push('unknown flow');
  let assertions = Array.isArray(plan.assertions) ? [...plan.assertions] : [];
  if (!assertions.length) problems.push('no assertions');
  const unsupported = assertions.filter((a) => !SUPPORTED_ASSERTIONS.includes(a));
  if (unsupported.length) {
    assertions = assertions.filter((a) => SUPPORTED_ASSERTIONS.includes(a));
    repairs.push(`unsupported assertion(s) rejected: ${unsupported.join(', ')}`);
  }
  if (assertions.length && assertions.every((a) => a === 'url-contains-dashboard')) {
    repairs.push('url-only test rejected: upgraded to state assertions');
    plan.weakRequestUpgraded = true;
  }
  for (const req of REQUIRED_ASSERTIONS) {
    if (!assertions.includes(req)) {
      assertions.push(req);
      repairs.push(`missing required assertion added: ${req}`);
    }
  }
  plan.assertions = assertions;
  return { problems, repairs };
}

export async function createPlan(message, baseUrl, version) {
  // Step "Find the information": look at the real app under test first, so
  // selectors come from the live page, not from the model's imagination.
  const inspection = await inspectSignupPage(baseUrl, version);

  let plan = null;
  let llm = { used: false, model: null, note: 'GEMINI_API_KEY not set; used the built-in planner.' };
  if (process.env.GEMINI_API_KEY) {
    const prompt = `You are a test-planning agent for a demo web app.
The user asked: "${message}"
The sign-up page currently has these fields: ${inspection.fields.map((f) => `${f.name} (${f.testId})`).join(', ')} and submit button ${inspection.submit.testId}.
${PLAN_SCHEMA_HINT}`;
    for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
      try {
        plan = await callGemini(model, prompt);
        llm = { used: true, model, note: `Plan generated by ${model}.` };
        break;
      } catch (err) {
        llm = { used: false, model, note: `${model} failed (${err.message}).` };
      }
    }
  }
  if (!plan) {
    plan = ruleBasedPlan(message);
    llm.note += ' Built-in planner produced the plan.';
  }

  const { problems, repairs } = validatePlan(plan);
  plan.version = version;
  plan.baseUrl = baseUrl;
  return { plan, inspection, llm, validation: { ok: problems.length === 0, problems, repairs } };
}
// The agent brain: turns a plain-English flow into a validated test plan.
// Two paths:
//   1. Gemini (when GEMINI_API_KEY is set) - retries, then falls back to a second model.
//   2. Built-in rule planner - deterministic fallback so the agent still works
//      when the free LLM tier is overloaded or no key is set.
import { inspectSignupPage } from './inspector.js';

const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest';

const PLAN_SCHEMA_HINT = `Reply with ONLY a JSON object, no markdown:
{
  "goal": "one sentence describing what the test proves",
  "flow": "signup",
  "fields": { "name": "person name to type", "email": "email to type", "password": "password to type" },
  "expectedEndState": "what the user should see at the end",
  "assertions": ["welcome-visible", "user-record-exists", "no-duplicate-account"]
}
Valid assertions: welcome-visible, user-record-exists, no-duplicate-account, url-contains-dashboard.`;

async function callGemini(model, prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini ${model} HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const match = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Gemini ${model} returned no JSON`);
  return JSON.parse(match[0]);
}

// Deterministic planner used as fallback and for offline development.
function ruleBasedPlan(message) {
  const text = message.toLowerCase();
  const asksUrlOnly = /only (check|assert).*url|just (check|assert).*url|url only/.test(text);
  const mentionsSignup = /sign[ -]?up|register|create (an? )?account/.test(text);
  if (!mentionsSignup) {
    throw new Error('I only know the sign-up flow of the demo app for now. Try: "Test that a user can sign up and see the dashboard".');
  }
  return {
    goal: 'A new user can sign up and land on their dashboard.',
    flow: 'signup',
    fields: { name: 'Test User', email: 'AUTO_GENERATED', password: 'Passw0rd!123' },
    expectedEndState: 'The dashboard welcomes the new user by name.',
    // A URL check alone is weak: the agent upgrades it to real state assertions.
    assertions: asksUrlOnly
      ? ['welcome-visible', 'user-record-exists', 'no-duplicate-account']
      : ['welcome-visible', 'user-record-exists', 'no-duplicate-account'],
    weakRequestUpgraded: asksUrlOnly,
  };
}

function validatePlan(plan) {
  const problems = [];
  if (!plan || typeof plan !== 'object') problems.push('plan is not an object');
  if (plan && plan.flow !== 'signup') problems.push('unknown flow');
  const valid = new Set(['welcome-visible', 'user-record-exists', 'no-duplicate-account', 'url-contains-dashboard']);
  for (const a of plan?.assertions || []) {
    if (!valid.has(a)) problems.push(`unknown assertion: ${a}`);
  }
  if (!plan?.assertions?.length) problems.push('no assertions');
  // "Validate fields before running the agent": a test with no real state
  // assertion is rejected and rebuilt stronger rather than run as-is.
  if (plan?.assertions?.every((a) => a === 'url-contains-dashboard')) {
    // Upgraded in place, so this is a note, not an unresolved problem: the
    // final plan is valid and validation.ok should stay true for it.
    plan.assertions = ['welcome-visible', 'user-record-exists', 'no-duplicate-account'];
    plan.weakRequestUpgraded = true;
  }
  return problems;
}

export async function createPlan(message, baseUrl, version) {
  // Step "Find the information": look at the real app under test first, so
  // selectors come from the live page, not from the model's imagination.
  const inspection = await inspectSignupPage(baseUrl, version);

  let plan = null;
  let llm = { used: false, model: null, note: 'GEMINI_API_KEY not set; used the built-in planner.' };
  if (process.env.GEMINI_API_KEY) {
    const prompt = `You are a test-planning agent for a demo web app.
The user asked: "${message}"
The sign-up page currently has these fields: ${inspection.fields.map((f) => `${f.name} (${f.testId})`).join(', ')} and submit button ${inspection.submit.testId}.
${PLAN_SCHEMA_HINT}`;
    for (const model of [PRIMARY_MODEL, FALLBACK_MODEL]) {
      try {
        plan = await callGemini(model, prompt);
        llm = { used: true, model, note: `Plan generated by ${model}.` };
        break;
      } catch (err) {
        llm = { used: false, model, note: `${model} failed (${err.message}).` };
      }
    }
  }
  if (!plan) {
    plan = ruleBasedPlan(message);
    llm.note += ' Built-in planner produced the plan.';
  }

  const problems = validatePlan(plan);
  plan.version = version;
  plan.baseUrl = baseUrl;
  return { plan, inspection, llm, validation: { ok: problems.length === 0, problems } };
}
