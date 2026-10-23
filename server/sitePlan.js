// Read-only test plans for user-named external websites.
// Hard rule: plans for external sites contain ONLY non-mutating checks.
// The agent may look at a named page; it never fills, clicks, submits,
// logs in, signs up, posts or buys anything there. Requests that need
// state changes are marked stateChange so the UI can say so honestly,
// and those steps are never generated.
import { inspectPage } from './webInspect.js';

const CHECK_TYPES = new Set(['page-loads', 'title-contains', 'heading-visible', 'text-visible', 'link-visible', 'form-present']);
const MAX_VAL = 90;

export const CHECK_LABELS = {
  'page-loads': 'The page loads successfully (HTTP status below 400)',
  'title-contains': 'The page title contains the expected text',
  'heading-visible': 'An expected heading is visible on the page',
  'text-visible': 'Expected text is visible on the page',
  'link-visible': 'An expected link is visible on the page',
  'form-present': 'The form is present with its fields (displayed, never submitted)',
};

const STATE_CHANGE_RE = /sign[ -]?up|register|create (an? )?account|log[ -]?in|sign[ -]?in|submit|purchase|buy|checkout|add to cart|post (a )?(comment|message)|delete|book|order|pay/i;

const clean = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_VAL);

// Keep only known read-only check types with safe scalar values.
export function validateSiteChecks(rawChecks) {
  const checks = [];
  const repairs = [];
  for (const c of Array.isArray(rawChecks) ? rawChecks : []) {
    if (!c || !CHECK_TYPES.has(c.type)) {
      repairs.push(`Dropped an unsupported or state-changing step ("${clean(c?.type) || 'unknown'}"): external-site runs are read-only.`);
      continue;
    }
    const value = clean(c.value);
    if (c.type !== 'page-loads' && c.type !== 'form-present' && !value) continue;
    checks.push({ type: c.type, value });
  }
  if (!checks.some((c) => c.type === 'page-loads')) {
    checks.unshift({ type: 'page-loads', value: '' });
    repairs.push('Added the basic "page loads" check: every external test includes it.');
  }
  return { checks, repairs };
}

const PLAN_SCHEMA_HINT = `Reply with ONLY a JSON object, no markdown:
{
  "goal": "one sentence describing what the check proves",
  "checks": [{ "type": "<one of: page-loads, title-contains, heading-visible, text-visible, link-visible, form-present>", "value": "<exact short text from the page summary, empty for page-loads/form-present>" }],
  "stateChangeIntent": false
}
Rules: read-only checks only. NEVER plan filling, clicking, submitting, logging in, signing up, buying or posting. If the request asks for any of those, set "stateChangeIntent": true and include only the read-only checks that still make sense. Values must come from the page summary verbatim (title, headings, links).`;

async function geminiSitePlan(message, inspection) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const summary = {
    url: inspection.source.finalUrl || inspection.source.url,
    httpStatus: inspection.source.httpStatus,
    title: inspection.title,
    headings: inspection.headings,
    links: inspection.links.map((l) => l.text).slice(0, 12),
    forms: inspection.forms.map((f) => ({ method: f.method, fields: f.inputs.map((i) => i.name || i.type), buttons: f.buttons.map((b) => b.label), hasCaptcha: f.hasCaptcha, hasOtp: f.hasOtp })),
  };
  const prompt = `A user named this website and described what to check. Page summary (read-only capture):\n${JSON.stringify(summary, null, 1)}\n\nUser request: "${clean(message)}"\n\n${PLAN_SCHEMA_HINT}`;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    signal: AbortSignal.timeout(Number(process.env.GEMINI_TIMEOUT_MS) || 20000),
  });
  if (!res.ok) throw new Error(`Gemini ${model} HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const match = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Gemini ${model} returned no JSON`);
  return { parsed: JSON.parse(match[0]), model };
}

const SKIP_WORDS = new Set(['visible', 'shown', 'showing', 'displayed', 'present', 'correct', 'right', 'there', 'loaded', 'loads', 'appears', 'appearing', 'exists', 'existing', 'working', 'works']);

// Extract the checks the user EXPLICITLY asked for. These are a floor:
// a planner (LLM or rules) must never silently drop a requested check and
// report success against a weaker set. A requested check that the page does
// not satisfy must FAIL in the open, not vanish.
export function requestedChecks(message) {
  const m = String(message || '');
  const out = [];
  const grab = (re) => {
    const x = m.match(re);
    if (!x) return null;
    let v = clean(x[1].replace(/^["']|["']$/g, '').replace(/^(the|a|an)\s+/i, ''));
    v = v.replace(/\s+(is|are|was|appears?|shows?|visible|displayed|present|exists?|works?|to be)$/i, '').trim();
    if (!v || v.length < 2 || SKIP_WORDS.has(v.toLowerCase())) return null;
    return v;
  };
  const TERM = `(?:[\\.,;]|$|\\s+(?:is|appears?|shows?|visible|displayed|present|to\\s+be|exists?|and|expected result)\\b)`;
  const heading = grab(new RegExp(`heading\\s+(?:that\\s+)?(?:says\\s+|reads\\s+|called\\s+|is\\s+)?["']?([A-Za-z0-9][^"'\\.,;]{1,59}?)["']?\\s*` + TERM, 'i'))
    || grab(/\bh1\b\s+(?:that\s+)?(?:says\s+|reads\s+|is\s+)?["']?([A-Za-z0-9][^"'\.,;]{1,59}?)["']?\s*(?:[\.,;]|$)/i);
  if (heading) out.push({ type: 'heading-visible', value: heading });
  const title = grab(new RegExp(`title\\s+(?:that\\s+)?(?:says\\s+|reads\\s+|contains?\\s+|is\\s+)?["']?([A-Za-z0-9][^"'\\.,;]{1,59}?)["']?\\s*` + TERM, 'i'));
  if (title) out.push({ type: 'title-contains', value: title });
  const link = grab(new RegExp(`link\\s+(?:that\\s+)?(?:says\\s+|labeled\\s+|called\\s+|is\\s+)?["']?([A-Za-z0-9][^"'\\.,;]{1,59}?)["']?\\s*` + TERM, 'i'));
  if (link) out.push({ type: 'link-visible', value: link });
  if (/\bform\b/i.test(m) && /present|visible|shows?|displays?|exists?|has|loads/i.test(m)) out.push({ type: 'form-present', value: '' });
  // generic quoted text the user says the page shows
  const q = (m.match(/(?:shows?|displays?|contains?|says|sees?)\s+["'"']([^"'"']{2,80})["'"']/i) || [])[1];
  if (q) {
    const v = clean(q);
    if (v && !out.some((c) => c.value.toLowerCase() === v.toLowerCase())) out.push({ type: 'text-visible', value: v });
  }
  return out;
}

// Deterministic fallback: build read-only checks from the actual page.
function ruleSitePlan(message, inspection) {
  const checks = [{ type: 'page-loads', value: '' }];
  const text = message.toLowerCase();
  const quoted = (message.match(/"([^"]{2,90})"/) || message.match(/'([^']{2,90})'/))?.[1];
  if (quoted) checks.push({ type: 'text-visible', value: clean(quoted) });
  if (/title/.test(text) && inspection.title) checks.push({ type: 'title-contains', value: clean(inspection.title) });
  if (/heading|header|h1/.test(text) && inspection.h1) checks.push({ type: 'heading-visible', value: clean(inspection.h1) });
  if (/link/.test(text) && inspection.links[0]) checks.push({ type: 'link-visible', value: clean(inspection.links[0].text) });
  if (/form|field|input/.test(text) && inspection.forms.length) checks.push({ type: 'form-present', value: '' });
  if (checks.length === 1) {
    if (inspection.title) checks.push({ type: 'title-contains', value: clean(inspection.title) });
    if (inspection.h1) checks.push({ type: 'heading-visible', value: clean(inspection.h1) });
  }
  return {
    goal: `The page at ${inspection.source.url} loads and shows what was asked.`,
    checks,
    stateChangeIntent: STATE_CHANGE_RE.test(message),
  };
}

export async function createSitePlan(message, url) {
  const inspection = await inspectPage(url, { allowPrivate: process.env.INSPECT_ALLOW_PRIVATE === '1' });
  if (inspection.source.httpStatus >= 400) {
    throw new Error(`The page answered HTTP ${inspection.source.httpStatus}. Nothing was tested.`);
  }
  let goal, checksRaw, stateChangeIntent, llm;
  try {
    const { parsed, model } = await geminiSitePlan(message, inspection);
    goal = clean(parsed.goal) || `Read-only checks on ${inspection.source.url}`;
    checksRaw = parsed.checks;
    stateChangeIntent = Boolean(parsed.stateChangeIntent) || STATE_CHANGE_RE.test(message);
    llm = { used: true, note: `Plan generated by ${model}` };
  } catch (e) {
    const p = ruleSitePlan(message, inspection);
    goal = p.goal;
    checksRaw = p.checks;
    stateChangeIntent = p.stateChangeIntent;
    llm = { used: false, note: `Plan generated by the built-in planner (${e.message})` };
  }
  // The user's explicitly requested checks are a floor: merge them back in
  // even when a planner omitted them, so a run never goes green on a
  // silently reduced goal.
  const floor = requestedChecks(message);
  const merged = Array.isArray(checksRaw) ? [...checksRaw] : [];
  let restored = 0;
  for (const fc of floor) {
    if (!merged.some((c) => c && c.type === fc.type && clean(c.value).toLowerCase() === fc.value.toLowerCase())) {
      merged.push(fc);
      restored++;
    }
  }
  const { checks, repairs } = validateSiteChecks(merged);
  if (restored) {
    repairs.push(`Restored ${restored} check(s) the request explicitly asked for (${floor.map((f) => `${f.type} "${f.value}"`).join(', ')}): requested checks are never silently dropped.`);
  }
  if (stateChangeIntent && !/not automated|read-only/i.test(goal)) {
    goal = `${goal} (Read-only only: the part of the request that would change the site, like creating an account or submitting a form, is NOT automated.)`;
  }
  const captchaGuard = inspection.forms.some((f) => f.hasCaptcha || f.hasOtp);
  if (captchaGuard) {
    repairs.push('CAPTCHA/OTP detected on this page: the agent never bypasses security checks, so any verification step stays manual.');
  }
  return {
    plan: {
      goal,
      url: inspection.source.finalUrl || inspection.source.url,
      version: 'site',
      checks,
      assertions: checks.map((c) => `site:${c.type}:${c.value}`),
      stateChangeIntent,
      weakRequestUpgraded: false,
    },
    inspection,
    llm,
    validation: { repairs },
  };
}

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escSq = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');

// A Playwright test that only READS the named page. No fill, no click, no submit.

// The ordered plain-language list of read-only checks the generated site
// test performs, with the locator each one uses. Shared between the
// approval gate view and the live per-action progress reports.
export function siteSteps({ url, checks }) {
  const steps = [{ label: 'Open the page (read-only)', locator: `page.goto('${url}')` }];
  for (const c of checks) {
    if (c.type === 'page-loads') steps.push({ label: 'Check the page loads (HTTP < 400)', locator: 'response.status() < 400' });
    else if (c.type === 'title-contains') steps.push({ label: `Check the title mentions "${c.value}"`, locator: `toHaveTitle(/${c.value}/i)` });
    else if (c.type === 'heading-visible') steps.push({ label: `Check heading "${c.value}" is visible`, locator: `getByRole('heading', { name: '${c.value}' })` });
    else if (c.type === 'text-visible') steps.push({ label: `Check the text "${c.value}" is visible`, locator: `getByText('${c.value}')` });
    else if (c.type === 'link-visible') steps.push({ label: `Check the link "${c.value}" is visible`, locator: `getByRole('link', { name: '${c.value}' })` });
    else if (c.type === 'form-present') steps.push({ label: 'Check a form is present', locator: "locator('form')" });
  }
  return steps;
}

export function generateSiteTest({ url, goal, checks }) {
  const lines = [];
  lines.push(`// Generated by TestPilot AI - read-only external-site check`);
  lines.push(`// Goal: ${goal}`);
  lines.push(`// Target: ${url}`);
  lines.push(`// This test never fills, clicks, submits or changes anything on the site.`);
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push(`import { assertPublicUrl } from '../server/webInspect.js';`);
lines.push(`import { startLiveStream, reportAction, reportEvidence } from '../server/liveStream.js';`);
  lines.push(``);
  lines.push(`const ALLOW_PRIVATE = process.env.INSPECT_ALLOW_PRIVATE === '1';`);
  lines.push(``);
  lines.push(`// Network guard: every request the browser makes - the navigation, any`);
  lines.push(`// redirect hop, and every subresource - must stay a public http(s) address.`);
  lines.push(`// Anything else (private IPs, localhost names, file:, non-http) is aborted.`);
  lines.push(`test.beforeEach(async ({ page }) => {`);
  lines.push(`  await page.route('**/*', async (route) => {`);
  lines.push(`    try {`);
  lines.push(`      const u = new URL(route.request().url());`);
  lines.push(`      if (u.protocol === 'data:' || u.protocol === 'about:') return route.continue();`);
  lines.push(`      if (u.protocol !== 'http:' && u.protocol !== 'https:') return route.abort();`);
  lines.push(`      await assertPublicUrl(u.hostname, { allowPrivate: ALLOW_PRIVATE });`);
  lines.push(`      return route.continue();`);
  lines.push(`    } catch {`);
  lines.push(`      return route.abort();`);
  lines.push(`    }`);
  lines.push(`  });`);
  lines.push(`});`);
  lines.push(``);
  lines.push(`test('${escSq(goal)}', async ({ page }, testInfo) => {`);
lines.push(`  // Stream the real browser screen to the page while this test reads the site.`);
lines.push(`  const stopLive = await startLiveStream(page);`);
  lines.push(`  let currentStep = -1;`);
  lines.push(`  const act = async (i, status) => { if (status === 'running') currentStep = i; await reportAction(i, status); };`);
lines.push(`  try {`);
  lines.push(`    await act(0, 'running');`);
  lines.push(`    const response = await page.goto('${escSq(url)}', { waitUntil: 'domcontentloaded', timeout: 20000 });`);
  lines.push(`    await act(0, 'done');`);
  let checkIdx = 0;
  for (const c of checks) {
    checkIdx++;
    lines.push(`    await act(${checkIdx}, 'running');`);
    if (c.type === 'page-loads') {
      lines.push(`    expect(response, 'the page returned no response').toBeTruthy();`);
      lines.push(`    expect(response.status(), 'the page should load with an HTTP status below 400').toBeLessThan(400);`);
    } else if (c.type === 'title-contains') {
      lines.push(`    await expect(page).toHaveTitle(/${escRe(c.value)}/i);`);
    } else if (c.type === 'heading-visible') {
      lines.push(`    await expect(page.getByRole('heading', { name: '${escSq(c.value)}' }).first()).toBeVisible({ timeout: 8000 });`);
    } else if (c.type === 'text-visible') {
      lines.push(`    await expect(page.getByText('${escSq(c.value)}', { exact: false }).first()).toBeVisible({ timeout: 8000 });`);
    } else if (c.type === 'link-visible') {
      lines.push(`    await expect(page.getByRole('link', { name: '${escSq(c.value)}' }).first()).toBeVisible({ timeout: 8000 });`);
    } else if (c.type === 'form-present') {
      lines.push(`    await expect(page.locator('form').first()).toBeVisible({ timeout: 8000 });`);
    }
    lines.push(`    await act(${checkIdx}, 'done');`);
  }
  lines.push(`  } catch (err) {`);
  lines.push(`    if (currentStep >= 0) await reportAction(currentStep, 'failed');`);
  lines.push(`    throw err;`);
  lines.push(`  } finally {`);
lines.push(`    if (stopLive) await stopLive();`);
lines.push(`    const aria = await page.locator('body').ariaSnapshot().catch(() => null);`);
lines.push(`    if (aria) await reportEvidence('aria-snapshot', aria);`);
lines.push(`    const shot = await page.screenshot().catch(() => null);`);
  lines.push(`    if (shot) await testInfo.attach('final-page-state', { body: shot, contentType: 'image/png' });`);
  lines.push(`  }`);
  lines.push(`});`);
  lines.push(``);
  return lines.join('\n');
}
