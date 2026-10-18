// Runs a generated test only AFTER human approval, then reruns it to check
// stability. Results come back with a plain-English explanation.
import { spawn } from 'node:child_process';
import path from 'node:path';

function runOnce(testFile, cwd, extraEnv = {}) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const child = spawn('npx', ['playwright', 'test', testFile, '--reporter=json', '--workers=1'], {
      cwd,
      env: { ...process.env, CI: '1', ...extraEnv },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      let report = null;
      try {
        report = JSON.parse(out);
      } catch {}
      const stats = report?.stats || {};
      const strip = (t) => String(t).replace(/\x1b\[[0-9;]*m/g, '');
      const errors = [];
      for (const suite of report?.suites || []) {
        for (const spec of suite.specs || []) {
          for (const t of spec.tests || []) {
            for (const r of t.results || []) {
              if (r.error?.message) errors.push(strip(r.error.message).split('\n').slice(0, 12).join('\n'));
            }
          }
          for (const nested of suite.suites || []) {
            for (const spec2 of nested.specs || []) {
              for (const t of spec2.tests || []) {
                for (const r of t.results || []) {
                  if (r.error?.message) errors.push(strip(r.error.message).split('\n').slice(0, 12).join('\n'));
                }
              }
            }
          }
        }
      }
      resolve({
        startedAt,
        exitCode: code,
        passed: code === 0,
        expected: stats.expected ?? null,
        failed: stats.unexpected ?? null,
        durationMs: stats.duration ?? null,
        errors,
        rawTail: strip(err || out).split('\n').slice(-15).join('\n'),
      });
    });
  });
}

function explain(result) {
  if (result.passed) return 'The test passed: the flow works end to end.';
  const text = [result.errors.join('\n'), result.rawTail].join('\n');
  const sel = text.match(/getByTestId\('([^']+)'\)/)?.[1] || text.match(/locator\('([^']+)'\)/)?.[1];
  if (/timeout[^\n]*exceeded|waiting for/i.test(text) && sel) {
    return `The test failed because it could not find the element "${sel}" on the page. The page seems to have changed: the element the test was told to use no longer exists.`;
  }
  if (/expect(ed)?[\s\S]*to (be|contain|have)/i.test(text) || /expect\(received\)/.test(text)) {
    return 'The test failed on an assertion: what the page showed did not match what was expected.';
  }
  return 'The test failed. See the raw output for details.';
}

export async function runWithStabilityCheck(testFile, cwd, reruns = 1, extraEnv = {}) {
  const first = await runOnce(testFile, cwd, extraEnv);
  const runs = [first];
  for (let i = 0; i < reruns; i++) {
    runs.push(await runOnce(testFile, cwd, extraEnv));
  }
  const stable = runs.every((r) => r.passed === runs[0].passed);
  return {
    file: path.basename(testFile),
    runs: runs.map((r) => ({ ...r, explanation: explain(r) })),
    stable,
    passed: runs[0].passed,
  };
}
