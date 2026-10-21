const out = document.getElementById('output');
const planBtn = document.getElementById('planBtn');
const steps = document.getElementById('steps');
const tip = document.getElementById('tip');
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const HINTS = {
  'welcome-visible': 'The dashboard welcome heading is visible after sign up.',
  'user-record-exists': 'The new user exists in the app data, not just on screen.',
  'url-contains-dashboard': 'The browser landed on the dashboard URL.',
  'no-duplicate-account': 'Running with the same data twice never creates a second account.',
};
const CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function setStep(n) {
  [...steps.children].forEach((li) => {
    const s = Number(li.dataset.step);
    li.classList.toggle('on', s === n);
    li.classList.toggle('done', s < n);
  });
}

// theme: light by default, dark sweeps across the screen from the button
const themeBtn = document.getElementById('themeBtn');
themeBtn.addEventListener('click', (e) => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  const apply = () => { document.documentElement.dataset.theme = next; };
  if (!document.startViewTransition || REDUCED) return apply();
  const r = themeBtn.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  document.startViewTransition(apply).ready.then(() =>
    document.documentElement.animate(
      { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
      { duration: 650, easing: 'cubic-bezier(.2,.8,.2,1)', pseudoElement: '::view-transition-new(root)' }
    ));
});

document.getElementById('examples').addEventListener('click', (e) => {
  const t = e.target.closest('.chip')?.dataset.t;
  if (t) { const m = document.getElementById('message'); m.value = t; m.focus(); }
});

// tooltips on assertion chips
document.addEventListener('mouseover', (e) => {
  const c = e.target.closest('[data-hint]');
  if (!c) return;
  const r = c.getBoundingClientRect();
  tip.textContent = c.dataset.hint;
  tip.style.left = Math.max(8, Math.min(innerWidth - 270, r.left)) + 'px';
  tip.style.top = r.bottom + 8 + 'px';
  tip.classList.add('show');
});
document.addEventListener('mouseout', (e) => { if (e.target.closest('[data-hint]')) tip.classList.remove('show'); });

planBtn.addEventListener('click', async () => {
  const message = document.getElementById('message').value.trim();
  const version = document.getElementById('version').value;
  if (!message) return;
  planBtn.disabled = true;
  setStep(2);
  render(`<div class="card reveal"><div class="thinking"><span class="spinner"></span><span>Inspecting the app and planning...</span></div></div>`);
  try {
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, version }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Planning failed');
    renderPlan(data);
  } catch (err) {
    setStep(1);
    render(`<div class="card error reveal"><p>${esc(err.message)}</p></div>`);
  } finally {
    planBtn.disabled = false;
  }
});

function renderPlan(s) {
  const added = (s.validation?.repairs || []).map((r) => (r.match(/added: (.+)$/) || [])[1]).filter(Boolean);
  const weak = s.plan.weakRequestUpgraded
    ? `<p class="upgrade"><b>Weak request upgraded.</b> You asked for a URL-only check. That can pass while the feature is broken, so the plan now checks the dashboard welcome, that the record exists, and that no duplicate account is created.</p>`
    : '';
  const fb = /fail|timed|abort|503|built-in/i.test(s.llm.note || '') ;
  const chips = s.plan.assertions
    .map((a, i) => `<span class="a-chip ${added.includes(a) ? 'added' : ''}" style="--i:${i}" data-hint="${esc(HINTS[a] || a)}${added.includes(a) ? ' Added by the code validator.' : ''}">${CHECK}${esc(a)}${added.includes(a) ? ' (added)' : ''}</span>`)
    .join('');
  const alt = s.plan.version === 'v1' ? 'v2' : 'v1';
  render(`
    <div class="card reveal">
      <h2><span class="num">1</span>The plan</h2>
      <p class="goal">${esc(s.plan.goal)}</p>
      <p class="muted">Expected end state: ${esc(s.plan.expectedEndState || 'n/a')}</p>
      <div class="k">Checks it will make</div>
      <div class="assertions">${chips}</div>
      ${weak}
      <span class="note"><span class="dot ${fb ? 'fb' : ''}"></span>${esc(s.llm.note)}</span>
    </div>
    <div class="card reveal" style="--d:120ms">
      <h2><span class="num">2</span>What it found on the live page</h2>
      <div class="found">Source <code>${esc(s.evidence.source.url)}</code></div>
      <div class="found">Retrieved ${esc(s.evidence.source.retrievedAt)}</div>
      <div class="found">Fields ${s.evidence.fieldsFound.map((f) => `<code>${esc(f.testId || f.name)}</code>`).join(' ')}</div>
      <div class="found">Submit button <code>${esc(s.evidence.submitFound.testId || s.evidence.submitFound.id)}</code> "${esc(s.evidence.submitFound.label)}"</div>
    </div>
    <div class="card reveal" style="--d:240ms">
      <h2><span class="num">3</span>Your approval</h2>
      <details><summary>View the generated Playwright test</summary><pre><code>${esc(s.code)}</code></pre></details>
      <div class="runrow">
        <button class="approve" data-id="${s.id}">Approve &amp; run</button>
        <label class="target">against
          <select id="runTarget">
            <option value="">v${s.plan.version.slice(1)} (as planned)</option>
            <option value="${alt}">${alt === 'v2' ? 'v2 - the app changed (button renamed)' : 'v1 - before the change'}</option>
          </select>
        </label>
      </div>
      <p class="gate">Nothing runs until you approve. Pick v2 to replay this exact test after the "redesign" - it should fail and explain why.</p>
    </div>
    <div id="runResult"></div>
  `);
  setStep(3);
  window.rig && rig.planned(s.plan.assertions.length);
  document.querySelector('.approve').addEventListener('click', (e) => run(e.target.dataset.id));
}

function countUp(el, to, dec = 0) {
  if (REDUCED) { el.textContent = to.toFixed(dec); return; }
  const t0 = performance.now();
  const tick = (t) => {
    const p = Math.min(1, (t - t0) / 900);
    el.textContent = (to * (1 - Math.pow(1 - p, 3))).toFixed(dec);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function run(id) {
  const box = document.getElementById('runResult');
  const versionOverride = document.getElementById('runTarget')?.value || null;
  setStep(4);
  window.rig && rig.running();
  box.innerHTML = `<div class="card reveal"><div class="thinking"><span class="spinner"></span><span>Approved. Running the test, then rerunning it to check stability...</span></div></div>`;
  try {
    const t0 = Date.now();
    const msg = box.querySelector('.thinking span:last-child');
    const tick = setInterval(() => {
      const sec = Math.round((Date.now() - t0) / 1000);
      if (msg) msg.textContent = `Approved. Running the test, then rerunning it to check stability... ${sec}s. The free server usually needs 40-90s for both runs.`;
    }, 1000);
    // The POST can outlive the host's proxy timeout, so also poll the session until it settles.
    let post = fetch(`/api/run/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionOverride }),
    }).then(async (r) => ({ ok: r.ok, status: r.status, d: await r.json() })).catch(() => null);
    let data = null;
    try {
      while (!data) {
        const got = await Promise.race([post, new Promise((r) => setTimeout(() => r('poll'), 3000))]);
        if (got && got !== 'poll' && got.ok) { data = got.d; break; }
        if (got !== 'poll') post = new Promise(() => {});
        if (got && got !== 'poll' && !got.ok && got.status !== 409) throw new Error(got.d.error || 'Run failed');
        const sres = await fetch(`/api/session/${id}`).catch(() => null);
        if (sres && sres.ok) {
          const sd = await sres.json();
          if (sd.status === 'done') data = sd;
          else if (sd.status === 'error') throw new Error(sd.result?.error || 'Run failed');
        }
        if (!data && Date.now() - t0 > 300000) throw new Error('The run is still going after 5 minutes. The server may be overloaded. Reload and try again; nothing was hidden.');
      }
    } finally { clearInterval(tick); }
    const r = data.result;
    const passedRuns = r.runs.filter((x) => x.passed).length;
    const total = r.runs.length;
    const secs = r.runs.reduce((a, x) => a + (x.durationMs || 0), 0) / 1000;
    const runs = r.runs
      .map((run, i) => `
      <div class="run ${run.passed ? '' : 'bad'}">
        <h3><span>Run ${i + 1}: ${run.passed ? 'passed' : 'failed'}</span><span class="muted">${run.durationMs ? (run.durationMs / 1000).toFixed(1) + 's' : ''}</span></h3>
        <div class="bar"><i data-w="100"></i></div>
        <p>${esc(run.explanation)}</p>
        ${run.errors.length ? `<details><summary>Technical detail</summary><pre><code>${esc(run.errors.join('\n---\n'))}</code></pre></details>` : ''}
      </div>`).join('');
    box.innerHTML = `
      <div class="card reveal">
        <h2><span class="num">4</span>Proof <span class="muted">ran against ${esc(data.runAgainst)}</span></h2>
        <div class="verdict">
          <div class="ring ${r.passed ? '' : 'bad'}">
            <svg viewBox="0 0 120 120" width="124" height="124"><circle class="bg" cx="60" cy="60" r="52" fill="none" stroke-width="10"/><circle class="fg" cx="60" cy="60" r="52" fill="none" stroke-width="10"/></svg>
            <div class="lbl"><span><span id="cu-runs">0</span>/${total}</span></div>
          </div>
          <div>
            <span class="badge ${r.passed ? 'pass' : 'fail'}">${r.passed ? 'PASS' : 'FAIL'}</span>
            <h2>${r.passed ? 'The feature works end to end' : 'The test caught a change'}</h2>
            <p class="muted">${r.stable ? 'Stability check: both runs agree.' : 'Stability check: the runs disagree, so this test is flaky.'}</p>
          </div>
        </div>
        <div class="stats">
          <div class="stat"><b id="cu-a">0</b><span>checks in the plan</span></div>
          <div class="stat"><b id="cu-p">0</b><span>runs passed of ${total}</span></div>
          <div class="stat"><b><span id="cu-s">0</span>s</b><span>total run time</span></div>
        </div>
        ${runs}
      </div>`;
    window.rig && rig.done(passedRuns, r.runs.length);
    const planCount = document.querySelectorAll('.a-chip').length;
    requestAnimationFrame(() => {
      const fg = box.querySelector('.ring .fg');
      fg.style.strokeDashoffset = String(327 * (1 - (r.passed ? 1 : Math.max(passedRuns, 0.04 * total) / total)));
      box.querySelectorAll('.bar i').forEach((b) => (b.style.width = b.dataset.w + '%'));
      countUp(box.querySelector('#cu-runs'), passedRuns);
      countUp(box.querySelector('#cu-p'), passedRuns);
      countUp(box.querySelector('#cu-a'), planCount);
      countUp(box.querySelector('#cu-s'), secs, 1);
    });
    box.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' });
  } catch (err) {
    window.rig && rig.done(0, 1);
    box.innerHTML = `<div class="card error reveal"><p>${esc(err.message)}</p></div>`;
  }
}

function render(html) { out.innerHTML = html; }
function esc(text) {
  return String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
