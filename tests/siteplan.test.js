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
    if (typeof body === 'function') return body(req, res);
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
  const t = await startHtmlServer({
    '/': PAGE,
    '/slow': (req, res) => setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE), 4000),
  });
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

test('explicitly requested checks are never silently dropped (floor merge)', async () => {
  const r = await fetch(`${appUrl}/api/plan-site`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: baseUrl + '/', message: 'Check the page loads and shows the heading Welcome to ShopLite' }),
  });
  const d = await r.json();
  assert.ok(d.plan.checks.some((c) => c.type === 'heading-visible' && c.value === 'Welcome to ShopLite'),
    'requested heading check must be present: ' + JSON.stringify(d.plan.checks));
});

test('a requested heading that is NOT on the page fails honestly (never green for a reduced goal)', async (t) => {
  const pr = await fetch(`${appUrl}/api/plan-site`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: baseUrl + '/', message: 'Check the page shows the heading Definitely Not On This Page' }),
  });
  const plan = await pr.json();
  assert.ok(plan.plan.checks.some((c) => c.type === 'heading-visible' && /Definitely Not On This Page/.test(c.value)));
  const rr = await fetch(`${appUrl}/api/run/${plan.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const d = await rr.json();
  assert.equal(d.status, 'done');
  assert.equal(d.result.passed, false, 'run must FAIL when the requested heading is absent');
  assert.ok(d.result.runs.every((x) => x.passed === false));
});

test('generated external specs carry the browser-side network guard', () => {
  const code = generateSiteTest({ url: 'https://example.com/', goal: 'g', checks: [{ type: 'page-loads', value: '' }] });
  assert.ok(code.includes("page.route('**/*'"));
  assert.ok(code.includes('assertPublicUrl'));
  assert.ok(code.includes("import { assertPublicUrl } from '../server/webInspect.js'"));
});

test('a state-changing request is flagged and its goal says that part is not automated', async () => {
  const r = await fetch(`${appUrl}/api/plan-site`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: baseUrl + '/', message: 'Sign up for a new account on this site' }),
  });
  const d = await r.json();
  assert.equal(d.plan.stateChangeIntent, true);
  assert.match(d.plan.goal, /NOT automated/i);
  assert.ok(!/\.fill\(|\.click\(|\/signup/.test(d.code));
});

test('global capacity: a competing session gets an honest 409 busy, the per-session lock still works, and the slot is released', async (t) => {
  const post = (path, body) => fetch(`${appUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const a = await (await post('/api/plan-site', { url: baseUrl + '/slow', message: 'Check the page loads' })).json();
  const b = await (await post('/api/plan-site', { url: baseUrl + '/', message: 'Check the page loads and shows the heading Welcome to ShopLite' })).json();

  // A takes the slot (slow page: two runs, seconds of hold)
  const runA = post(`/api/run/${a.id}`).then((r) => r.json());
  let aRunning = false;
  for (let i = 0; i < 30 && !aRunning; i++) {
    await new Promise((r) => setTimeout(r, 200));
    aRunning = (await (await fetch(`${appUrl}/api/session/${a.id}`)).json()).status === 'running';
  }
  assert.ok(aRunning, 'session A should be running');

  // competing different-session run: declined honestly, never launched
  const rb = await post(`/api/run/${b.id}`);
  assert.equal(rb.status, 409);
  const rbBody = await rb.json();
  assert.equal(rbBody.code, 'capacity');
  assert.match(rbBody.error, /one browser job at a time|in progress/i);
  // b was NOT started
  assert.equal((await (await fetch(`${appUrl}/api/session/${b.id}`)).json()).status, 'awaiting-approval');

  // the original per-session lock still works
  const ra2 = await post(`/api/run/${a.id}`);
  assert.equal(ra2.status, 409);
  assert.match((await ra2.json()).error, /Already running/);

  // A completes; slot released; B can now run
  const da = await runA;
  assert.equal(da.status, 'done');
  assert.equal(da.result.passed, true);
  const rb2 = await post(`/api/run/${b.id}`);
  assert.equal(rb2.status, 200);
  const db = await rb2.json();
  assert.equal(db.result.passed, true);
});
