import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// index.js bakes BASE_URL from PORT at import time, so the test app must
// listen on that same port: set it before the module is imported.
process.env.PORT = '3977';
const { app } = await import('../server/index.js');
const { inspectSignupPage } = await import('../server/inspector.js');
const { generateTest, escapeSq } = await import('../server/generator.js');
const { explain } = await import('../server/runner.js');
const { createPlan } = await import('../server/agent.js');

function listen(server, port = 0) {
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

// Serve arbitrary HTML for inspector tests.
function startHtmlServer(routes) {
  const server = http.createServer((req, res) => {
    const body = routes[req.url];
    if (body == null) return res.writeHead(404).end('nope');
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });
  return listen(server).then((baseUrl) => ({ server, baseUrl }));
}

let server, baseUrl;
before(async () => {
  server = http.createServer(app);
  baseUrl = await listen(server, Number(process.env.PORT));
});
after(() => server.close());

test('inspector reads fields and prefers the submit button', async () => {
  const { server: s, baseUrl: b } = await startHtmlServer({
    '/demo/v9/signup': `<form>
      <input id="name" name="name" data-testid="name-input" required>
      <input id="email" name="email" type="email" data-testid="email-input" required>
      <input id="password" name="password" type="password" data-testid="password-input" required>
      <button type="button" data-testid="cancel-btn">Cancel</button>
      <button type="submit" id="go" data-testid="go-submit">Go</button>
    </form>`,
  });
  try {
    const r = await inspectSignupPage(b, 'v9');
    assert.equal(r.selectors.submit, 'go-submit', 'must prefer the type=submit button, not the first button');
    assert.equal(r.selectors.email, 'email-input');
    assert.ok(r.fields.every((f) => f.required === true));
    assert.equal(r.source.httpStatus, 200);
  } finally {
    s.close();
  }
});

test('inspector does not treat "required" inside an attribute value as the attribute', async () => {
  const { server: s, baseUrl: b } = await startHtmlServer({
    '/demo/v9/signup': `<form>
      <input id="name" name="name" data-testid="not-required-field">
      <button type="submit" data-testid="signup-submit">Sign up</button>
    </form>`,
  });
  try {
    const r = await inspectSignupPage(b, 'v9');
    assert.equal(r.fields[0].required, false);
  } finally {
    s.close();
  }
});

test('inspector reports a clear error when the page cannot be loaded', async () => {
  const { server: s, baseUrl: b } = await startHtmlServer({});
  try {
    await assert.rejects(() => inspectSignupPage(b, 'v9'), /Could not load .*HTTP 404/);
  } finally {
    s.close();
  }
});

test('escapeSq makes goals safe for single-quoted generated code', () => {
  const escaped = escapeSq("it's a \\path\ntest");
  assert.equal(escaped, "it\\'s a \\\\path test");
  assert.ok(!escaped.includes('\n'), 'raw newlines must not reach the generated file');
});

test('generateTest uses inspected selectors and a collision-proof email', () => {
  const inspection = {
    source: { url: 'http://x/demo/v1/signup', retrievedAt: 'now' },
    selectors: { name: 'name-input', email: 'email-input', password: 'password-input', submit: 'signup-submit' },
  };
  const plan = {
    goal: "it's fine",
    version: 'v1',
    baseUrl: 'http://x',
    fields: { name: 'Test User', password: 'pw' },
    assertions: ['welcome-visible', 'user-record-exists', 'no-duplicate-account'],
  };
  const code = generateTest({ plan, inspection });
  assert.match(code, /getByTestId\('signup-submit'\)/);
  assert.match(code, /test\('it\\'s fine'/);
  assert.match(code, /Math\.random\(\)\.toString\(36\)/, 'email needs a random suffix, not Date.now() alone');
  assert.match(code, /expect\(mine\.length\)\.toBe\(1\)/, 'no-duplicate assertion generated');
});

test('explain names the missing element on a selector timeout', () => {
  const r = explain({
    passed: false,
    errors: ["Error: locator.click: Timeout 7000ms exceeded.\nwaiting for getByTestId('signup-submit')"],
    rawTail: '',
  });
  assert.match(r, /could not find the element "signup-submit"/);
  assert.match(r, /page seems to have changed/);
});

test('explain recognizes assertion failures and passes', () => {
  assert.match(explain({ passed: false, errors: ['expect(received).toBeVisible()'], rawTail: '' }), /did not match what was expected/);
  assert.match(explain({ passed: true, errors: [], rawTail: '' }), /passed/);
});

test('demo app serves v1 and v2 signup pages with different submit selectors', async () => {
  const v1 = await (await fetch(`${baseUrl}/demo/v1/signup`)).text();
  const v2 = await (await fetch(`${baseUrl}/demo/v2/signup`)).text();
  assert.match(v1, /data-testid="signup-submit"/);
  assert.match(v2, /data-testid="create-account-submit"/);
});

test('demo signup creates a user, rejects duplicates, and resets', async () => {
  const post = (email) =>
    fetch(`${baseUrl}/demo/v1/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'T', email, password: 'pw' }),
      redirect: 'manual',
    });
  assert.equal((await post('a@x.com')).status, 303);
  assert.equal((await post('a@x.com')).status, 409, 'duplicate email must be rejected');
  const users = await (await fetch(`${baseUrl}/demo/api/users`)).json();
  assert.equal(users.count, 1);
  await fetch(`${baseUrl}/demo/api/reset`, { method: 'POST' });
  assert.equal((await (await fetch(`${baseUrl}/demo/api/users`)).json()).count, 0);
});

test('createPlan plans the signup flow against the live page', async () => {
  const { plan, inspection, validation } = await createPlan('Test that a user can sign up and see the dashboard', baseUrl, 'v1');
  assert.equal(plan.flow, 'signup');
  assert.equal(inspection.selectors.submit, 'signup-submit');
  assert.equal(validation.ok, true, JSON.stringify(validation.problems));
});

test('a URL-only request is upgraded and still validates as ok', async () => {
  const { plan, validation } = await createPlan('Only check the URL after signup', baseUrl, 'v1');
  assert.equal(plan.weakRequestUpgraded, true);
  assert.ok(!plan.assertions.includes('url-contains-dashboard'));
  assert.equal(validation.ok, true, `an upgraded plan is valid: ${validation.problems}`);
});

test('createPlan rejects flows it does not know', async () => {
  await assert.rejects(() => createPlan('Delete all user accounts', baseUrl, 'v1'), /only know the sign-up flow/);
});

test('POST /api/plan validates input and returns an awaiting-approval session', async () => {
  const bad = await fetch(`${baseUrl}/api/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '' }),
  });
  assert.equal(bad.status, 400);

  const res = await fetch(`${baseUrl}/api/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Test that a user can sign up and see the dashboard', version: 'v1' }),
  });
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.status, 'awaiting-approval', 'nothing runs before human approval');
  assert.match(s.code, /getByTestId\('signup-submit'\)/);
  assert.equal(s.evidence.submitFound.testId, 'signup-submit');

  const again = await (await fetch(`${baseUrl}/api/session/${s.id}`)).json();
  assert.equal(again.id, s.id);
});

test('unknown sessions are 404 on read and run', async () => {
  assert.equal((await fetch(`${baseUrl}/api/session/nope`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/run/nope`, { method: 'POST' })).status, 404);
});
