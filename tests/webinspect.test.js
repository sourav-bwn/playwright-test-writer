import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { inspectPage, readOnlyCheckIdeas } = await import('../server/webInspect.js');

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
<h1>Welcome to ShopLite</h1>
<h2>Deals today</h2>
<a href="/about">About us</a>
<form action="/signup" method="post">
  <input name="name" type="text" required>
  <input name="email" type="email" required>
  <input name="password" type="password" required>
  <button type="submit">Create account</button>
</form></body></html>`;

const CAPTCHA_PAGE = `<html><body><form action="/join" method="post">
<input name="email" type="email"><div class="g-recaptcha" data-sitekey="x"></div>
<button type="submit">Join</button></form></body></html>`;

test('inspectPage reads title, headings, form fields and links as evidence', async () => {
  const { server, baseUrl } = await startHtmlServer({ '/': PAGE });
  try {
    const r = await inspectPage(baseUrl + '/', { allowPrivate: true });
    assert.equal(r.source.httpStatus, 200);
    assert.ok(r.source.retrievedAt.endsWith('Z'));
    assert.equal(r.title, 'ShopLite - Home');
    assert.equal(r.h1, 'Welcome to ShopLite');
    assert.equal(r.forms.length, 1);
    assert.equal(r.forms[0].method, 'post');
    assert.deepEqual(r.forms[0].inputs.map((i) => i.name), ['name', 'email', 'password']);
    assert.equal(r.forms[0].hasPassword, true);
    assert.equal(r.forms[0].hasCaptcha, false);
    assert.equal(r.forms[0].buttons[0].label, 'Create account');
    assert.ok(r.links.some((l) => l.text === 'About us'));
    assert.ok(r.headings.includes('Deals today'));
  } finally { server.close(); }
});

test('inspectPage flags CAPTCHA so the guardrail can refuse', async () => {
  const { server, baseUrl } = await startHtmlServer({ '/': CAPTCHA_PAGE });
  try {
    const r = await inspectPage(baseUrl + '/', { allowPrivate: true });
    assert.equal(r.forms[0].hasCaptcha, true);
  } finally { server.close(); }
});

test('inspectPage refuses private and non-http targets by default', async () => {
  await assert.rejects(() => inspectPage('http://127.0.0.1:9/'), /not allowed/);
  await assert.rejects(() => inspectPage('http://localhost/'), /not allowed/);
  await assert.rejects(() => inspectPage('http://192.168.1.10/'), /not allowed/);
  await assert.rejects(() => inspectPage('file:///etc/passwd'), /http/);
  await assert.rejects(() => inspectPage('not a url'), /valid URL/i);
});

test('readOnlyCheckIdeas suggests only non-mutating checks', async () => {
  const { server, baseUrl } = await startHtmlServer({ '/': PAGE });
  try {
    const r = await inspectPage(baseUrl + '/', { allowPrivate: true });
    const ideas = readOnlyCheckIdeas(r);
    assert.ok(ideas.find((i) => i.id === 'page-loads'));
    assert.ok(ideas.find((i) => i.id === 'title-contains'));
    assert.ok(ideas.find((i) => i.id === 'form-present'));
    assert.ok(!ideas.some((i) => /submit|sign ?up|create/i.test(i.label) && i.id !== 'form-present'));
  } finally { server.close(); }
});

function startRouteServer(handler) {
  const server = http.createServer(handler);
  return listen(server).then((baseUrl) => ({ server, baseUrl }));
}

test('inspector rejects private hosts when the test-only escape is off', async () => {
  const { server, baseUrl } = await startRouteServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<title>x</title>'));
  try {
    await assert.rejects(() => inspectPage(baseUrl + '/', { allowPrivate: false }), /not allowed/);
    await assert.rejects(() => inspectPage('http://169.254.169.254/latest/meta-data', { allowPrivate: false }), /not allowed/);
    await assert.rejects(() => inspectPage('http://localhost:3461/', { allowPrivate: false }), /not allowed/);
  } finally { server.close(); }
});

test('redirects are followed hop-by-hop with the guard on each hop', async () => {
  const { server, baseUrl } = await startRouteServer((req, res) => {
    if (req.url === '/redir') return res.writeHead(302, { location: '/final' }).end();
    if (req.url === '/final') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>Landed</title></head><body><h1>Final page</h1></body></html>');
    res.writeHead(404).end();
  });
  try {
    const d = await inspectPage(baseUrl + '/redir', { allowPrivate: true });
    assert.equal(d.source.httpStatus, 200);
    assert.match(d.source.finalUrl, /\/final$/);
    assert.equal(d.source.redirects.length, 1);
    assert.equal(d.title, 'Landed');
  } finally { server.close(); }
});

test('a redirect to a non-http(s) target is never followed', async () => {
  const { server, baseUrl } = await startRouteServer((req, res) => {
    if (req.url === '/redir-file') return res.writeHead(302, { location: 'file:///etc/passwd' }).end();
    res.writeHead(404).end();
  });
  try {
    await assert.rejects(() => inspectPage(baseUrl + '/redir-file', { allowPrivate: true }), /http/);
  } finally { server.close(); }
});
