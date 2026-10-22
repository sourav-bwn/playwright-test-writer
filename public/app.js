// Test Writer UI - wired to the real backend only. No scripted results.
const $ = (sel) => document.querySelector(sel);
const msgInput = $('#msgInput');
const versionSelect = $('#versionSelect');
const planBtn = $('#planBtn');
const activityLog = $('#activityLog');
const state = { session: null, busy: false, timer: null };

const stepEls = {};
document.querySelectorAll('.pstep').forEach((el) => { stepEls[el.dataset.step] = el; });

function setStep(name, status) {
  const el = stepEls[name];
  if (el) el.className = 'pstep' + (status ? ' ' + status : '');
}
function resetPipeline() {
  Object.keys(stepEls).forEach((k) => setStep(k, ''));
}
function logActivity(msg) {
  $('#activityEmpty').classList.add('hidden');
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  const row = document.createElement('div');
  row.className = 'act-row';
  const time = document.createElement('span');
  time.className = 'act-time';
  time.textContent = `${hh}:${mm}:${ss}`;
  const body = document.createElement('span');
  body.className = 'act-msg';
  body.innerHTML = msg;
  row.appendChild(time);
  row.appendChild(body);
  activityLog.appendChild(row);
  row.scrollIntoView({ block: 'nearest' });
}
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + name));
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { msgInput.value = c.dataset.msg; msgInput.focus(); }));

function startTicker(el, text, note) {
  stopTicker();
  const t0 = Date.now();
  el.textContent = text;
  state.timer = setInterval(() => {
    const sec = Math.round((Date.now() - t0) / 1000);
    el.innerHTML = `${text} <b>${sec}s</b>. ${note}`;
  }, 1000);
  return t0;
}
function stopTicker() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const ASSERTION_LABELS = {
  'url-contains-dashboard': 'Lands on the dashboard page (URL check)',
  'welcome-visible': 'Welcome message with the new user\u2019s name is visible',
  'user-record-exists': 'The account record really exists (checked via the app\u2019s API)',
  'no-duplicate-account': 'No duplicate account was created for this user',
};

async function postPlan() {
  if (state.busy) return;
  const message = msgInput.value.trim();
  if (!message) { msgInput.focus(); logActivity('Please describe the flow first - one sentence is enough.'); showTab('activity'); return; }
  state.busy = true;
  planBtn.disabled = true;
  planBtn.textContent = 'Agent is working\u2026';
  resetPipeline();
  $('#planEmpty').classList.add('hidden');
  $('#planContent').classList.add('hidden');
  $('#resultArea').innerHTML = '';
  setStep('request', 'done');
  logActivity(`You asked: <b>${esc(message)}</b> (target: DemoShop ${versionSelect.value})`);
  setStep('inspect', 'active');
  const tickerEl = document.createElement('span');
  logActivity('Reading the live sign-up page and drafting a plan\u2026');
  activityLog.lastChild.querySelector('.act-msg').appendChild(tickerEl);
  startTicker(tickerEl, '\u2002', 'The agent fetches the real page, then a model writes the plan. First request after idle can take ~40s while the free server wakes.');
  showTab('activity');
  try {
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, version: versionSelect.value }),
    });
    const data = await res.json();
    stopTicker();
    if (!res.ok) throw new Error(data.error || 'Planning failed.');
    state.session = data;
    setStep('inspect', 'done');
    setStep('plan', 'done');
    setStep('validate', 'done');
    setStep('approval', 'wait');
    logActivity(`Read <b>${esc(data.evidence.source.url)}</b> - found ${data.evidence.fieldsFound.length} fields and the submit button.`);
    logActivity(`Plan ready: <b>${esc(data.plan.goal)}</b> (${esc(data.llm.note)})`);
    if (data.validation.repairs.length) logActivity(`Safety checker added ${data.validation.repairs.length} missing check(s): <b>${data.validation.repairs.map(esc).join(', ')}</b>`);
    logActivity('Waiting for your approval. Nothing runs until you approve.');
    renderPlan(data);
    showTab('plan');
  } catch (err) {
    stopTicker();
    setStep('inspect', 'failed');
    logActivity(`<b>Planning failed:</b> ${esc(err.message)}`);
    showTab('activity');
  }
  state.busy = false;
  planBtn.disabled = false;
  planBtn.textContent = 'Ask the agent';
}

function renderPlan(s) {
  $('#planContent').classList.remove('hidden');
  const modelPill = s.llm.used
    ? `<span class="pill pill-model">${esc(s.llm.note)}</span>`
    : `<span class="pill pill-warn">${esc(s.llm.note)}</span>`;
  $('#planMeta').innerHTML = `
    <div class="plan-head">
      <span class="plan-goal">${esc(s.plan.goal)}</span>
      ${modelPill}
      <span class="pill pill-ok">checks reviewed by the safety checker</span>
    </div>`;
  const repairs = new Set(s.validation.repairs);
  $('#assertionList').innerHTML = `<div class="mini-title">What the test will check</div><ul class="assert-list">${
    s.plan.assertions.map((a) => `<li><span>${esc(ASSERTION_LABELS[a] || a)} <code>${esc(a)}</code></span>${repairs.has(a) ? '<span class="added-tag">added by safety checker</span>' : ''}</li>`).join('')
  }</ul>`;
  $('#weakUpgrade').innerHTML = s.plan.weakRequestUpgraded
    ? `<div class="weak-box"><b>Weak request upgraded.</b> You asked for a URL-only check. That can pass while the feature is broken, so the plan now also checks the dashboard welcome, that the record exists, and that no duplicate account is created. Added checks are marked above.</div>`
    : '';
  $('#codeView').textContent = s.code;
  // evidence pane
  $('#evidenceEmpty').classList.add('hidden');
  $('#evidenceContent').classList.remove('hidden');
  const src = s.evidence.source;
  $('#evidenceMeta').innerHTML = `
    <div class="ev-row"><span>Source page</span><span>${esc(src.url)}</span></div>
    <div class="ev-row"><span>Read at</span><span>${esc(new Date(src.retrievedAt).toLocaleString())}</span></div>
    <div class="ev-row"><span>HTTP status</span><span>${esc(String(src.httpStatus))}</span></div>`;
  $('#fieldsFound').innerHTML = s.evidence.fieldsFound.map((f) =>
    `<div class="field-chip"><span>${esc(f.name)} <span class="mini-note">(${esc(f.type)})</span></span><code>data-testid="${esc(f.testId)}"</code>${f.required ? '<span class="req">required</span>' : ''}</div>`
  ).join('') + `<div class="field-chip"><span>submit button "${esc(s.evidence.submitFound.label)}"</span><code>data-testid="${esc(s.evidence.submitFound.testId)}"</code></div>`;
  const sel = s.evidence.selectors;
  $('#selectorsUsed').innerHTML = Object.entries(sel).map(([k, v]) =>
    `<div class="ev-row"><span>${esc(k)}</span><span><code>${esc(v)}</code></span></div>`).join('');
  $('#liveFrame').src = `/demo/${s.plan.version}/signup`;
  $('#runTarget').value = '';
}

async function approve() {
  if (state.busy || !state.session) return;
  const s = state.session;
  const override = $('#runTarget').value;
  state.busy = true;
  $('#approveBtn').disabled = true;
  setStep('approval', 'done');
  setStep('run', 'active');
  const target = override || s.plan.version;
  logActivity(`<b>You approved.</b> Running the test against DemoShop ${target}, then rerunning it to check stability\u2026`);
  const tickerEl = document.createElement('span');
  activityLog.lastChild.querySelector('.act-msg').appendChild(tickerEl);
  startTicker(tickerEl, '\u2002', 'Two real browser runs usually take 40-90s on the free server.');
  showTab('activity');
  const t0 = Date.now();
  try {
    const res = await fetch(`/api/run/${s.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(override ? { versionOverride: override } : {}),
    });
    const data = await res.json();
    stopTicker();
    if (!res.ok) throw new Error(data.error || 'Run failed.');
    state.session = data;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    setStep('run', 'done');
    setStep('proof', 'done');
    logActivity(`Run complete in ${secs}s: <b>${data.result.passed ? 'PASS' : 'FAIL'}</b> against DemoShop ${data.runAgainst}, stable across both runs: ${data.result.stable ? 'yes' : 'no'}.`);
    logActivity(`Plain-English read: ${esc(data.result.runs[0].explanation)}`);
    renderResult(data, secs);
    addHistory(data, secs);
    showTab('plan');
  } catch (err) {
    stopTicker();
    setStep('run', 'failed');
    logActivity(`<b>Run failed:</b> ${esc(err.message)}`);
  }
  state.busy = false;
  $('#approveBtn').disabled = false;
}

function decline() {
  if (state.busy || !state.session) return;
  logActivity(`<b>You declined</b> the plan "${esc(state.session.plan.goal)}". Nothing was run.`);
  setStep('approval', 'failed');
  state.session = null;
  $('#planContent').classList.add('hidden');
  $('#planEmpty').classList.remove('hidden');
  showTab('activity');
}

function renderResult(s, secs) {
  const r = s.result;
  const pass = r.passed;
  const rows = r.runs.map((run, i) => `
    <div class="run-row">
      <span class="tag ${run.passed ? 'tag-pass' : 'tag-fail'}">${run.passed ? 'PASS' : 'FAIL'}</span>
      <span>run ${i + 1} of ${r.runs.length}</span>
      <span class="rr-time">${run.durationMs != null ? (run.durationMs / 1000).toFixed(1) + 's' : 'n/a'}</span>
      <span class="rr-expl">${esc(run.explanation)}</span>
    </div>`).join('');
  const raw = r.runs[0].errors.length || r.runs[0].rawTail
    ? `<details class="raw"><summary>Raw runner output (first run)</summary><pre>${esc(r.runs[0].errors.join('\n') || r.runs[0].rawTail)}</pre></details>` : '';
  $('#resultArea').innerHTML = `
    <div class="result-card ${pass ? '' : 'fail'}">
      <div class="result-top">
        <span class="verdict ${pass ? 'pass' : 'fail'}">${pass ? '\u2713 Test passed' : '\u2717 Test failed'}</span>
        <span class="result-meta">${esc(r.file)} &middot; ran against <b>DemoShop ${esc(s.runAgainst)}</b> &middot; ${r.runs.filter((x) => x.passed).length}/${r.runs.length} runs passed &middot; ${secs}s total</span>
      </div>
      <div class="result-explain">${esc(r.runs[0].explanation)}</div>
      <div class="run-rows">${rows}</div>
      <div class="stable-note">${r.stable
        ? `Both runs agreed, so this result is stable${pass ? ' - and a fresh mock account was created each time, with no duplicates.' : '.'}`
        : 'The two runs disagreed - this test is flaky and needs a closer look.'}</div>
      ${raw}
      <p class="hint">Want to see the other case? Pick a different version in the "Run it against" box above and approve again - the same generated test will replay against that version.</p>
    </div>`;
  $('#resultArea').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function addHistory(s, secs) {
  $('#historyEmpty').classList.add('hidden');
  const r = s.result;
  const pass = r.passed;
  const card = document.createElement('div');
  card.className = 'hist-card';
  card.innerHTML = `
    <div class="hist-top">
      <span class="tag ${pass ? 'tag-pass' : 'tag-fail'}">${pass ? 'PASS' : 'FAIL'}</span>
      <span class="q">${esc(s.message)}</span>
      <span class="mini-note">${esc(new Date().toLocaleTimeString())}</span>
    </div>
    <div class="hist-grid">
      <div class="hist-cell"><div class="hc-label">You asked</div><div class="hc-val">${esc(s.message)}</div></div>
      <div class="hist-cell"><div class="hc-label">Expected</div><div class="hc-val">${esc(s.plan.expectedEndState)}</div></div>
      <div class="hist-cell"><div class="hc-label">What happened</div><div class="hc-val">${esc(r.runs[0].explanation)}</div></div>
      <div class="hist-cell"><div class="hc-label">Proof</div><div class="hc-val">${r.runs.filter((x) => x.passed).length}/${r.runs.length} runs passed &middot; ${r.stable ? 'stable' : 'flaky'} &middot; ${secs}s &middot; DemoShop ${esc(s.runAgainst)}</div></div>
      <div class="hist-cell"><div class="hc-label">Selectors used</div><div class="hc-val"><code>${esc(Object.values(s.evidence.selectors).join(', '))}</code></div></div>
      <div class="hist-cell"><div class="hc-label">Plan source</div><div class="hc-val">${esc(s.llm.note)}</div></div>
    </div>`;
  $('#historyList').prepend(card);
}

planBtn.addEventListener('click', postPlan);
$('#approveBtn').addEventListener('click', approve);
$('#declineBtn').addEventListener('click', decline);
msgInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) postPlan();
});
