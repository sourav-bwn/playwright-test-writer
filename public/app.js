const out = document.getElementById('output');
const planBtn = document.getElementById('planBtn');

planBtn.addEventListener('click', async () => {
  const message = document.getElementById('message').value.trim();
  const version = document.getElementById('version').value;
  if (!message) return;
  planBtn.disabled = true;
  render(`<div class="card"><p>Inspecting the app and planning...</p></div>`);
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
    render(`<div class="card error"><p>${esc(err.message)}</p></div>`);
  } finally {
    planBtn.disabled = false;
  }
});

function renderPlan(s) {
  const weak = s.plan.weakRequestUpgraded
    ? `<p class="warn">You asked for a URL-only check. That is a weak test, so I upgraded it to real state assertions (dashboard welcome + record exists + no duplicate account).</p>`
    : '';
  render(`
    <div class="card">
      <h2>1. Plan</h2>
      <p><strong>Goal:</strong> ${esc(s.plan.goal)}</p>
      <p><strong>Expected end state:</strong> ${esc(s.plan.expectedEndState || 'n/a')}</p>
      <p><strong>Assertions:</strong> ${s.plan.assertions.map(esc).join(', ')}</p>
      ${weak}
      <p class="muted">${esc(s.llm.note)}</p>
    </div>
    <div class="card">
      <h2>2. What I found on the live page</h2>
      <p>Source: <code>${esc(s.evidence.source.url)}</code> (retrieved ${esc(s.evidence.source.retrievedAt)})</p>
      <p>Fields: ${s.evidence.fieldsFound.map((f) => `<code>${esc(f.testId || f.name)}</code>`).join(' ')}</p>
      <p>Submit button: <code>${esc(s.evidence.submitFound.testId || s.evidence.submitFound.id)}</code> ("${esc(s.evidence.submitFound.label)}")</p>
    </div>
    <div class="card">
      <h2>3. Generated test</h2>
      <pre><code>${esc(s.code)}</code></pre>
      <div class="runrow">
        <button class="approve" data-id="${s.id}">Approve &amp; run</button>
        <label>against
          <select id="runTarget">
            <option value="">v${s.plan.version.slice(1)} (as planned)</option>
            <option value="${s.plan.version === 'v1' ? 'v2' : 'v1'}">${s.plan.version === 'v1' ? 'v2 - the app changed (button renamed)' : 'v1 - before the change'}</option>
          </select>
        </label>
      </div>
      <p class="muted">Nothing runs until you approve. Pick v2 to replay this exact test after the "redesign" - it should fail and explain why.</p>
    </div>
    <div id="runResult"></div>
  `);
  document.querySelector('.approve').addEventListener('click', (e) => run(e.target.dataset.id));
}

async function run(id) {
  const box = document.getElementById('runResult');
  const versionOverride = document.getElementById('runTarget')?.value || null;
  box.innerHTML = `<div class="card"><p>Approved. Running the test, then rerunning it to check stability...</p></div>`;
  try {
    const res = await fetch(`/api/run/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionOverride }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Run failed');
    const r = data.result;
    const badge = r.passed ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>';
    const runs = r.runs
      .map(
        (run, i) => `
      <div class="run">
        <h3>Run ${i + 1}: ${run.passed ? 'passed' : 'failed'} ${run.durationMs ? `(${(run.durationMs / 1000).toFixed(1)}s)` : ''}</h3>
        <p>${esc(run.explanation)}</p>
        ${run.errors.length ? `<pre><code>${esc(run.errors.join('\n---\n'))}</code></pre>` : ''}
      </div>`
      )
      .join('');
    box.innerHTML = `
      <div class="card">
        <h2>4. Result ${badge} <span class="muted">(ran against ${esc(data.runAgainst)})</span></h2>
        ${runs}
        <p><strong>Stability check:</strong> ${r.stable ? 'stable - both runs agree' : 'flaky - runs disagree'}</p>
      </div>`;
  } catch (err) {
    box.innerHTML = `<div class="card error"><p>${esc(err.message)}</p></div>`;
  }
}

function render(html) {
  out.innerHTML = html;
}
function esc(text) {
  return String(text ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
