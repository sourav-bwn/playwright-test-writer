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
  const { checks, repairs } = validateSiteChecks(checksRaw);
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
export function generateSiteTest({ url, goal, checks }) {
  const lines = [];
  lines.push(`// Generated by TestPilot AI - read-only external-site check`);
  lines.push(`// Goal: ${goal}`);
  lines.push(`// Target: ${url}`);
  lines.push(`// This test never fills, clicks, submits or changes anything on the site.`);
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push(``);
  lines.push(`test('${escSq(goal)}', async ({ page }, testInfo) => {`);
  lines.push(`  try {`);
  lines.push(`    const response = await page.goto('${escSq(url)}', { waitUntil: 'domcontentloaded', timeout: 20000 });`);
  for (const c of checks) {
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
  }
  lines.push(`  } finally {`);
  lines.push(`    const shot = await page.screenshot().catch(() => null);`);
  lines.push(`    if (shot) await testInfo.attach('final-page-state', { body: shot, contentType: 'image/png' });`);
  lines.push(`  }`);
  lines.push(`});`);
  lines.push(``);
  return lines.join('\n');
}
