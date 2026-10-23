// Demo app: a tiny signup + dashboard + profile site that the agent writes tests against.
// Two versions exist on purpose:
//   v1 - the normal app
//   v2 - the same app after a "redesign" that renamed the submit button
//        (used to show the agent failing clearly when a selector changes)
// Saved state lives in memory for the life of this server process only.
import { Router } from 'express';

const CATEGORIES = ['Electronics', 'Books', 'Fashion', 'Home'];

const THEME = `<style>
*{margin:0;box-sizing:border-box;font-family:'Inter',system-ui,sans-serif}
body{background:linear-gradient(160deg,#0f172a,#111c33);min-height:100vh;color:#e2e8f0;padding:40px 16px}
.wrap{max-width:440px;margin:0 auto}
.logo{display:flex;align-items:center;gap:10px;margin-bottom:22px}
.mark{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#2dd4bf,#0ea5e9);display:flex;align-items:center;justify-content:center;font-size:18px}
.logo b{color:#f1f5f9;font-size:17px}
h1{color:#f8fafc;font-size:22px;margin-bottom:6px}
.sub{color:#94a3b8;font-size:13px;margin-bottom:20px}
label{display:block;color:#7dd3fc;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;margin:14px 0 6px}
input[type=text],input[type=email],input[type=password]{width:100%;background:#0b1626;border:1px solid #1e3a4c;border-radius:10px;padding:11px 13px;color:#e2e8f0;font-size:14px;outline:none}
input:focus{border-color:#2dd4bf}
.btn{display:block;width:100%;margin-top:22px;padding:13px;border:none;border-radius:12px;background:linear-gradient(90deg,#2dd4bf,#38bdf8);color:#04202b;font-weight:700;font-size:15px;cursor:pointer}
.foot{margin-top:16px;text-align:center;color:#64748b;font-size:12px}
.card{background:#0b1626;border:1px solid #1e3a4c;border-radius:12px;padding:14px 16px;margin-bottom:10px}
.card p{color:#94a3b8;font-size:12px;margin:2px 0}
.card p b{color:#e2e8f0;font-weight:600}
.avatar{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#2dd4bf,#0ea5e9);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;color:#04202b}
.urow{display:flex;align-items:center;gap:14px;margin-bottom:20px}
.urow b{color:#f8fafc;font-size:18px;display:block}
.urow i{color:#94a3b8;font-size:12px;font-style:normal}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
.topbar a{color:#7dd3fc;font-size:12px;text-decoration:none;border:1px solid #1e3a4c;padding:8px 14px;border-radius:8px;display:inline-block}
.toast{background:#052e2b;border:1px solid #2dd4bf;color:#5eead4;border-radius:10px;padding:10px 14px;font-size:13px;font-weight:600;margin-bottom:16px}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
.chips input{position:absolute;opacity:0}
.chips label.chip{margin:0;padding:9px 14px;border:1px solid #1e3a4c;border-radius:999px;color:#94a3b8;font-size:13px;font-weight:500;letter-spacing:0;text-transform:none;cursor:pointer;background:#0b1626}
.chips input:checked + label.chip{border-color:#2dd4bf;color:#5eead4;background:#052e2b}
a.inline{color:#38bdf8;font-size:13px}
</style>`;

const LOGO = '<div class="logo"><div class="mark">&#128717;</div><b>DemoShop</b></div>';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function createDemoApp() {
  const router = Router();
  const users = []; // in-memory store; mock data only, lives until this process restarts

  function signupPage(version) {
    const isV2 = version === 'v2';
    // v2 simulates selector drift: new button id/test-id and label.
    const button = isV2
      ? '<button type="submit" id="create-account-btn" class="btn" data-testid="create-account-submit">Create account</button>'
      : '<button type="submit" id="signup-btn" class="btn" data-testid="signup-submit">Sign up</button>';
    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DemoShop - Sign up</title>${THEME}</head>
<body><div class="wrap">
${LOGO}
<h1 data-testid="signup-title">Create your account</h1>
<p class="sub">One minute, and your dashboard is ready.</p>
<form method="post" action="/demo/${version}/signup">
  <label for="name">Full name</label>
  <input id="name" name="name" type="text" data-testid="name-input" required>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" data-testid="email-input" required>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" data-testid="password-input" required>
  ${button}
</form>
<p class="foot">Demo app - synthetic data only</p>
</div></body></html>`;
  }

  function dashboardPage(user, saved) {
    const displayName = user.displayName || user.name;
    const toast = saved
      ? '<div class="toast" data-testid="profile-saved">Profile saved - the saved values below update instantly and survive a reload.</div>'
      : '';
    const category = user.category
      ? `<p>Favorite category: <b data-testid="saved-category">${esc(user.category)}</b></p>`
      : '<p>Favorite category: <b data-testid="saved-category">not set yet</b></p>';
    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DemoShop - Dashboard</title>${THEME}</head>
<body><div class="wrap">
<div class="topbar">${LOGO}<a href="/demo/profile?uid=${user.id}" data-testid="edit-profile-link">Edit profile</a></div>
${toast}
<div class="urow"><div class="avatar">${esc(displayName.trim().charAt(0).toUpperCase() || '?')}</div><div><b><h1 data-testid="welcome-heading" style="margin:0">Welcome, ${esc(displayName)}</h1></b><i>Member #${user.id} - joined today</i></div></div>
<section class="card" data-testid="user-record">
  <p><b>Account record</b></p>
  <p>Account #${user.id}</p>
  <p data-testid="user-email">${esc(user.email)}</p>
  <p>Created ${esc(user.createdAt)}</p>
  ${category}
</section>
<div class="card"><p><b>What the agent verifies</b></p><p>The welcome heading and this account record - proof on the real page, not the model's word.</p></div>
</div></body></html>`;
  }

  function profilePage(user) {
    const chips = CATEGORIES.map((c) => {
      const checked = user.category === c ? ' checked' : '';
      return `<input type="radio" id="cat-${c}" name="category" value="${c}"${checked}><label class="chip" for="cat-${c}" data-testid="category-radio-${c}">${c}</label>`;
    }).join('\n      ');
    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DemoShop - Edit profile</title>${THEME}</head>
<body><div class="wrap">
<div class="topbar">${LOGO}<a href="/demo/dashboard?uid=${user.id}">Back to dashboard</a></div>
<div class="urow"><div class="avatar">${esc((user.displayName || user.name).trim().charAt(0).toUpperCase() || '?')}</div><div><b>Your profile</b><i>Saved state - proves the app really works</i></div></div>
<form method="post" action="/demo/profile?uid=${user.id}">
  <label for="displayName">Display name</label>
  <input id="displayName" name="displayName" type="text" data-testid="profile-name-input" value="${esc(user.displayName || user.name)}" required>
  <label>Favorite category</label>
  <div class="chips">
      ${chips}
  </div>
  <button type="submit" class="btn" data-testid="profile-save-submit">Save changes</button>
</form>
</div></body></html>`;
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
    res.type('html').send(dashboardPage(user, req.query.saved === '1'));
  });

  router.get('/profile', (req, res) => {
    const user = users.find((u) => u.id === Number(req.query.uid));
    if (!user) return res.status(404).type('html').send('<h1>User not found</h1>');
    res.type('html').send(profilePage(user));
  });

  router.post('/profile', (req, res) => {
    const user = users.find((u) => u.id === Number(req.query.uid));
    if (!user) return res.status(404).type('html').send('<h1>User not found</h1>');
    const { displayName, category } = req.body || {};
    if (!displayName) {
      return res.status(400).type('html').send('<h1 data-testid="error-heading">Missing display name</h1>');
    }
    user.displayName = String(displayName).slice(0, 80);
    if (category && CATEGORIES.includes(category)) user.category = category;
    res.redirect(303, `/demo/dashboard?uid=${user.id}&saved=1`);
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
