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
