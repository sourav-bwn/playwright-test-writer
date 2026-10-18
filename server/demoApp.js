// Demo app: a tiny signup + dashboard site that the agent writes tests against.
// Two versions exist on purpose:
//   v1 - the normal app
//   v2 - the same app after a "redesign" that renamed the submit button
//        (used to show the agent failing clearly when a selector changes)
import { Router } from 'express';

export function createDemoApp() {
  const router = Router();
  const users = []; // in-memory store; mock data only

  function signupPage(version) {
    const isV2 = version === 'v2';
    // v2 simulates selector drift: new button id/test-id and label.
    const button = isV2
      ? '<button type="submit" id="create-account-btn" data-testid="create-account-submit">Create account</button>'
      : '<button type="submit" id="signup-btn" data-testid="signup-submit">Sign up</button>';
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>DemoShop - Sign up</title>
<style>body{font-family:system-ui;max-width:420px;margin:60px auto;padding:0 16px}
label{display:block;margin:12px 0 4px}input{width:100%;padding:8px}
button{margin-top:16px;padding:10px 18px}</style></head>
<body>
<h1 data-testid="signup-title">Create your DemoShop account</h1>
<form method="post" action="/demo/${version}/signup">
  <label for="name">Full name</label>
  <input id="name" name="name" data-testid="name-input" required>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" data-testid="email-input" required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" data-testid="password-input" required>
  ${button}
</form>
</body></html>`;
  }

  router.get('/:version(v1|v2)/signup', (req, res) => {
    res.type('html').send(signupPage(req.params.version));
  });

  router.post('/:version(v1|v2)/signup', (req, res) => {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).type('html').send('<h1 data-testid="error-heading">Missing fields</h1>');
    }
    if (users.some((u) => u.email === email)) {
      return res.status(409).type('html').send('<h1 data-testid="error-heading">Account already exists</h1>');
    }
    const user = { id: users.length + 1, name, email, createdAt: new Date().toISOString() };
    users.push(user);
    res.redirect(303, `/demo/dashboard?uid=${user.id}`);
  });

  router.get('/dashboard', (req, res) => {
    const user = users.find((u) => u.id === Number(req.query.uid));
    if (!user) return res.status(404).type('html').send('<h1>User not found</h1>');
    res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>DemoShop - Dashboard</title></head>
<body>
<h1 data-testid="welcome-heading">Welcome, ${user.name}</h1>
<section data-testid="user-record">
  <p>Account #${user.id}</p>
  <p data-testid="user-email">${user.email}</p>
  <p>Created ${user.createdAt}</p>
</section>
</body></html>`);
  });

  // Source of truth the agent can query to prove a record really exists.
  router.get('/api/users', (req, res) => {
    res.json({ count: users.length, users });
  });

  router.post('/api/reset', (req, res) => {
    users.length = 0;
    res.json({ ok: true, count: 0 });
  });

  return router;
}
