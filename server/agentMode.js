// Step-by-step agent mode: instead of generating one deterministic test up
// front, the agent observes the live page structure (accessibility snapshot
// text, NOT screenshot pixels), asks Gemini for ONE next action, validates
// that action against the real page and the safety policy, executes it with
// Playwright, and repeats - bounded by a step count and a time budget, inside
// the bundled DemoShop only. Every decision, guard rejection and outcome is
// recorded as evidence. Requires GEMINI_API_KEY; there is no scripted
// stand-in for model decisions in this mode.
import { chromium } from 'playwright';
import { inspectSignupPage } from './inspector.js';

const MAX_STEPS = 12;
const MAX_MS = 300000;
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest';
const VALID_ACTIONS = ['fill', 'click', 'check-visible', 'done', 'fail'];

const PII_PATTERNS = [
  /[\w.+-]+@(?!example\.(com|test|org))[\w-]+\.[\w.]+/, // email outside reserved example domains
  /\b\d{12,16}\b/,
  /(?:\+?\d[\d\s()-]{8,}\d)/,
];

export const AGENT_LIMITS = { maxSteps: MAX_STEPS, maxSeconds: MAX_MS / 1000, actions: VALID_ACTIONS };

export function agentAvailable() {
  return Boolean(process.env.GEMINI_API_KEY);
}

async function callGemini(model, prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Gemini ${model} HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const match = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Gemini ${model} returned no JSON`);
  return JSON.parse(match[0]);
}

async function decide(prompt) {
  try {
    return { decision: await callGemini(PRIMARY_MODEL, prompt), model: PRIMARY_MODEL };
  } catch {
    return { decision: await callGemini(FALLBACK_MODEL, prompt), model: FALLBACK_MODEL };
  }
}

function syntheticValue(testId, run) {
  const id = String(testId).toLowerCase();
  const stamp = `${Date.now().toString(36)}${run}`;
  if (id.includes('email')) return `agent-${stamp}@example.test`;
  if (id.includes('pass')) return 'Passw0rd!agent';
  if (id.includes('profile') && id.includes('name')) return `Agent Profile ${stamp}`;
  if (id.includes('name')) return `Agent User ${stamp}`;
  return `agent-${stamp}`;
}

function buildPrompt({ goal, aria, elements, history, guardNote, token }) {
  return `You are a cautious test agent driving a web page one action at a time.

GOAL: ${goal}

PAGE ACCESSIBILITY SNAPSHOT (text structure of the live page right now):
${aria.slice(0, 4000)}

INTERACTIVE ELEMENTS ON THE PAGE (data-testid / role / label):
${elements.map((e) => `- ${e.testId} (${e.tag}) ${e.text}`).join('\n')}

ACTIONS ALREADY TAKEN (do not repeat a completed action):
${history.length ? history.map((h) => `${h.step}. ${h.action} ${h.testId || ''} -> ${h.ok ? 'ok' : 'failed: ' + h.error}`).join('\n') : '(none yet)'}
${guardNote ? `\nYOUR LAST ANSWER WAS REJECTED: ${guardNote}\n` : ''}
RULES:
- Choose exactly ONE next action.
- "fill" and "click" and "check-visible" need a testId copied EXACTLY from the INTERACTIVE ELEMENTS list.
- Never invent or reuse real personal data. For fill values use obviously synthetic data on reserved domains only (e.g. someone@example.test); if unsure, omit "value" and safe synthetic data will be used.
- Say "done" only when the goal is visibly achieved in the snapshot. Say "fail" when the goal cannot be achieved.
- When the goal includes updating the profile: once a "profile saved" confirmation or your saved values appear in the snapshot, the task IS complete - say "done" immediately instead of navigating again.
- Never try to leave this site, open OTP/CAPTCHA flows, or submit real data.
- Uniqueness token for this run: ${token}. Include it in any email or name you invent (e.g. user-${token}@example.test) so repeated runs never collide.

Reply with ONLY a JSON object, no markdown:
{"action":"fill|click|check-visible|done|fail","testId":"...","value":"...(optional, fill only)","reason":"one short sentence"}`;
}

async function postJson(url, body) {
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    // live reporting is best-effort and must never fail a run
  }
}

async function startFrameStream(page, frameUrl) {
  if (!frameUrl) return null;
  let client;
  try {
    client = await page.context().newCDPSession(page);
  } catch {
    return null;
  }
  let stopped = false;
  let inFlight = false;
  client.on('Page.screencastFrame', (ev) => {
    client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    if (stopped || inFlight) return;
    inFlight = true;
    let pageUrl = '';
    try { pageUrl = page.url(); } catch {}
    postJson(frameUrl, { data: ev.data, url: pageUrl }).finally(() => { inFlight = false; });
  });
  try {
    await client.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 960, maxHeight: 600, everyNthFrame: 1 });
  } catch {
    return null;
  }
  return async () => {
    stopped = true;
    try { await client.send('Page.stopScreencast'); } catch {}
  };
}

async function listInteractiveElements(page) {
  return page.$$eval('[data-testid]', (nodes) =>
    nodes.slice(0, 25).map((n) => ({
      testId: n.getAttribute('data-testid'),
      tag: n.tagName.toLowerCase(),
      text: (n.textContent || n.getAttribute('placeholder') || '').trim().slice(0, 60),
    }))
  );
}

export async function runAgentLoop({ goal, version, baseUrl, live, decideFn = decide, family = 'signup' }) {
  const startedAt = Date.now();
  const token = startedAt.toString(36);
  const history = [];
  const models = new Set();
  let browser;
  const finish = (passed, explanation, extra = {}) => ({
    passed,
    explanation,
    durationMs: Date.now() - startedAt,
    steps: history,
    modelsUsed: [...models],
    limits: AGENT_LIMITS,
    ...extra,
  });

  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const stopStream = await startFrameStream(page, live?.frameUrl);
    await page.goto(`${baseUrl}/demo/${version}/signup`, { waitUntil: 'domcontentloaded' });

    let guardNote = '';
    let guardRejections = 0;
    for (let step = 1; step <= MAX_STEPS; step++) {
      if (Date.now() - startedAt > MAX_MS) {
        return finish(false, `Stopped at the ${MAX_MS / 1000}s time limit after ${history.length} action(s). The goal was not confirmed.`);
      }
      const aria = await page.locator('body').ariaSnapshot();
      const elements = await listInteractiveElements(page);
      const { decision, model } = await decideFn(buildPrompt({ goal, aria, elements, history, guardNote, token }));
      models.add(model);
      const action = String(decision?.action || '').trim();
      const testId = decision?.testId ? String(decision.testId).trim() : null;
      let value = decision?.value != null ? String(decision.value) : null;
      const reason = String(decision?.reason || '').slice(0, 200);

      // Safety validation: the model proposes, deterministic checks dispose.
      let rejected = null;
      if (!VALID_ACTIONS.includes(action)) rejected = `unknown action "${action}"`;
      else if (['fill', 'click', 'check-visible'].includes(action)) {
        if (!testId || !elements.some((e) => e.testId === testId)) rejected = `testId "${testId}" is not on the page`;
        else if (action === 'fill' && value && PII_PATTERNS.some((re) => re.test(value))) rejected = 'proposed value looks like real personal data';
      }
      if (rejected) {
        guardRejections++;
        history.push({ step, action: action || '(invalid)', testId, reason, ok: false, error: `guard rejected: ${rejected}`, model });
        if (guardRejections >= 2) {
          return finish(false, `Stopped: the model's proposed action was rejected by safety checks twice (${rejected}). No unsafe action was executed.`);
        }
        guardNote = rejected;
        continue; // same step number retries with the rejection explained
      }
      guardNote = '';
      // Values for identity fields are generated deterministically, never
      // trusted to the model: unique per run so repeat runs never collide,
      // and always on reserved example domains.
      if (action === 'fill' && (!value || (/(email|name)/i.test(testId) && !value.includes(token)))) {
        value = syntheticValue(testId, token);
      }

      await postJson(live?.actionUrl, { index: step, status: 'running', at: new Date().toISOString() });
      const rec = { step, action, testId, value: action === 'fill' ? value : undefined, reason, ok: true, model };
      try {
        const loc = page.getByTestId(testId || '');
        if (action === 'fill') await loc.fill(value, { timeout: 5000 });
        else if (action === 'click') await loc.click({ timeout: 5000 });
        else if (action === 'check-visible') await loc.waitFor({ state: 'visible', timeout: 5000 });
        if (live?.slowmoMs) await page.waitForTimeout(live.slowmoMs);
      } catch (err) {
        rec.ok = false;
        rec.error = String(err.message || err).split('\n')[0].slice(0, 160);
      }
      history.push(rec);
      await postJson(live?.actionUrl, { index: step, status: rec.ok ? 'done' : 'failed', at: new Date().toISOString() });

      // Boundary: the agent must never navigate away from DemoShop.
      if (!page.url().startsWith(baseUrl)) {
        return finish(false, 'Stopped: the browser navigated outside the DemoShop boundary. The run was aborted before anything else happened.');
      }
      if (!rec.ok) continue; // let the model see the failure and choose again

      if (action === 'done') {
        // The model claims success - verify against the real page, not its word.
        const aria2 = await page.locator('body').ariaSnapshot().catch(() => '');
        await postJson(live?.evidenceUrl, { kind: 'aria-snapshot', text: aria2.slice(0, 8000), at: new Date().toISOString() });
        if (family === 'profile') {
          // Profile task: the saved values must survive a fresh page load.
          const nameFill = [...history].reverse().find((h) => h.ok && h.action === 'fill' && h.testId === 'profile-name-input');
          const catClick = [...history].reverse().find((h) => h.ok && h.action === 'click' && /^category-radio-/.test(h.testId || ''));
          if (!nameFill) {
            return finish(false, 'The agent declared done on a profile task, but it never edited the display name - the claim was not accepted without a real edit.');
          }
          if (!catClick) {
            return finish(false, 'The agent declared done on a profile task, but it never chose a favorite category - the claim was not accepted without a real edit.');
          }
          const expectedName = nameFill.value;
          const expectedCategory = catClick.testId.replace('category-radio-', '');
          const uid = new URL(page.url()).searchParams.get('uid');
          if (!uid) {
            return finish(false, 'The agent declared done on a profile task, but no saved account session exists to verify against.');
          }
          await page.goto(`${baseUrl}/demo/profile?uid=${uid}`, { waitUntil: 'domcontentloaded' });
          const savedName = await page.getByTestId('profile-name-input').inputValue().catch(() => null);
          const savedCategory = await page.locator(`#cat-${expectedCategory}`).isChecked().catch(() => false);
          await page.goto(`${baseUrl}/demo/dashboard?uid=${uid}`, { waitUntil: 'domcontentloaded' });
          const welcomeText = (await page.getByTestId('welcome-heading').textContent().catch(() => '')) || '';
          const categoryText = ((await page.getByTestId('saved-category').textContent().catch(() => '')) || '').trim();
          const aria3 = await page.locator('body').ariaSnapshot().catch(() => '');
          await postJson(live?.evidenceUrl, { kind: 'aria-snapshot', text: aria3.slice(0, 8000), at: new Date().toISOString() });
          const nameOk = savedName === expectedName && welcomeText.includes(expectedName);
          const categoryOk = savedCategory && categoryText === expectedCategory;
          if (nameOk && categoryOk) {
            return finish(true, `Supported task complete in ${history.length} step(s): the agent created a fresh DemoShop account, edited the profile (display name "${expectedName}", category "${expectedCategory}"), and the saved values are verified on a fresh page load - the name on the dashboard and the stored profile record match what the agent entered.`);
          }
          return finish(false, `The agent declared done on a profile task, but the saved state did not verify after a fresh load (name match: ${nameOk ? 'yes' : 'no'}, category match: ${categoryOk ? 'yes' : 'no'}). The claim was not accepted without evidence.`);
        }
        const onDashboard = page.url().includes('/demo/dashboard');
        const welcomeVisible = await page.getByTestId('welcome-heading').isVisible().catch(() => false);
        if (onDashboard || welcomeVisible) {
          return finish(true, `Supported task complete in ${history.length} step(s): the agent chose each action itself, created a fresh DemoShop account, and the dashboard welcome is verified on the real page.`);
        }
        return finish(false, 'The agent declared done, but the dashboard welcome is NOT visible on the real page - the claim was not accepted without evidence.');
      }
      if (action === 'fail') {
        return finish(false, `The agent concluded the goal cannot be achieved: ${reason || 'no reason given'}`);
      }
    }
    const ariaEnd = await page.locator('body').ariaSnapshot().catch(() => '');
    await postJson(live?.evidenceUrl, { kind: 'aria-snapshot', text: ariaEnd.slice(0, 8000), at: new Date().toISOString() });
    return finish(false, `Step limit (${MAX_STEPS}) reached before the goal was confirmed.`);
  } catch (err) {
    return finish(false, `Agent run stopped by an error: ${String(err.message || err).split('\n')[0].slice(0, 180)}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export async function inspectForAgent(baseUrl, version) {
  return inspectSignupPage(baseUrl, version);
}
