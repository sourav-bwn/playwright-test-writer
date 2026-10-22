import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.PORT = '3977';
process.env.INSPECT_ALLOW_PRIVATE = '1';
const { app } = await import('../server/index.js');
const { validateSiteChecks, generateSiteTest } = await import('../server/sitePlan.js');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}
function startHtmlServer(routes) {
  const server = http.createServer((req, res) => {
    const body = routes[req.url];
    if (body == null) return res.writeHead(404).end('nope');
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });
  return listen(server).then((baseUrl) => ({ server, baseUrl }));
}

const PAGE = `<html><head><title>ShopLite - Home</title></head><body>
<h1>Welcome to ShopLite</h1><a href="/about">About us</a>
<form action="/signup" method="post"><input name="email" type="email"><button type="submit">Create account</button></form>
</body></html>`;

test('validateSiteChecks keeps only read-only checks and always includes page-loads', () => {
  const { checks, repairs } = validateSiteChecks([
    { type: 'fill-form', value: 'x' },
    { type: 'title-contains', value: 'ShopLite' },
    { type: 'text-visible', value: '' },
  ]);
  assert.deepEqual(checks.map((c) => c.type), ['page-loads', 'title-contains']);
  assert.ok(repairs.some((r) => /read-only/.test(r)));
});

test('generateSiteTest emits read-only Playwright code (no fill/click/submit)', () => {
  const code = generateSiteTest({
    url: 'https://example.com/',
    goal: "It's reachable",
    checks: [
      { type: 'page-loads', value: '' },
      { type: 'title-contains', value: 'Example (test) [1]' },
      { type: 'link-visible', value: "It's a link" },
    ],
  });
  assert.ok(!/\.fill\(|\.click\(|\.submit\(/.test(code));
  assert.ok(code.includes("It\\'s reachable") || code.includes("It\\’s") || code.includes("It\\'s"));
  assert.ok(code.includes('Example \\(test\\) \\[1\\]')); // regex-escaped
  assert.ok(code.includes("getByRole('link', { name: 'It\\'s a link' })"));
});

let server, baseUrl, appServer, appUrl;
before(async () => {
  const t = await startHtmlServer({ '/': PAGE });
  server = t.server; baseUrl = t.baseUrl;
  appServer = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  appUrl = `http://127.0.0.1:${appServer.address().port}`;
});
after(() => { server.close(); appServer.close(); });

test('POST /api/plan-site plans read-only checks against a named site', async () => {
  const r = await fetch(`${appUrl}/api/plan-site`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: baseUrl + '/', message: 'Check the page loads and shows the heading' }),
  });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.status, 'awaiting-approval');
  assert.equal(d.plan.version, 'site');
  assert.ok(d.plan.checks.some((c) => c.type === 'page-loads'));
  assert.ok(d.evidence.source.url.startsWith(baseUrl));
  assert.match(d.code, /read-only external-site check/);
  assert.ok(!/\.fill\(|\.click\(/.test(d.code));
});

test('a signup request on an external site is flagged, never generated', async () => {
  const r = await fetch(`${appUrl}/api/plan-site`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: baseUrl + '/', message: 'Sign up for a new account on this site' }),
  });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.plan.stateChangeIntent, true);
  assert.ok(!/\.fill\(|\.click\(|\/signup/.test(d.code)); // no navigation to the form action, no input actions
});

test('an approved read-only run executes twice and returns real screenshots', async (t) => {
  const pr = await fetch(`${appUrl}/api/plan-site`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: baseUrl + '/', message: 'Check the page loads and the title says ShopLite' }),
  });
  const { id } = await pr.json();
  const rr = await fetch(`${appUrl}/api/run/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(rr.status, 200);
  const d = await rr.json();
  assert.equal(d.status, 'done');
  assert.equal(d.result.passed, true);
  assert.equal(d.result.runs.length, 2);
  for (const run of d.result.runs) {
    assert.ok(run.shot?.startsWith('data:image/png;base64,'));
  }
});
