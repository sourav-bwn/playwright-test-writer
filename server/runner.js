// Runs a generated test only AFTER human approval, then reruns it to check
// stability. Results come back with a plain-English explanation.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RUN_TIMEOUT_MS = Number(process.env.RUN_TIMEOUT_MS) || 120000;

function runOnce(testFile, cwd, extraEnv = {}) {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    let child;
    try {
      child = spawn('npx', ['playwright', 'test', testFile, '--reporter=json', '--workers=1'], {
        cwd,
        env: { ...process.env, CI: '1', ...extraEnv },
      });
    } catch (e) {
      resolve(failureResult(startedAt, `Could not start the test runner: ${e.message}`));
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Without this handler a missing npx/playwright emits an unhandled 'error'
    // event and crashes the whole server process.
    child.on('error', (e) => {
      finish(failureResult(startedAt, `Could not start the test runner: ${e.message}`));
    });
    // A hung run must not pin the session in "running" forever.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(failureResult(startedAt, `Test run timed out after ${RUN_TIMEOUT_MS / 1000}s and was stopped.`));
    }, RUN_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      if (settled) return;
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
      // Real run evidence: pull the final-page screenshot the generated test
      // attached to the report, hand it to the UI as a data URL, then clean up.
      const shotPaths = [];
      const shotBodies = [];
      const walkShots = (suite) => {
        for (const spec of suite.specs || []) {
          for (const t of spec.tests || []) {
            for (const r of t.results || []) {
              for (const a of r.attachments || []) {
                if (a.contentType !== 'image/png') continue;
                if (a.body) shotBodies.push(a.body);
                else if (a.path) shotPaths.push(a.path);
              }
            }
          }
        }
        for (const nested of suite.suites || []) walkShots(nested);
      };
      for (const suite of report?.suites || []) walkShots(suite);
      let shot = null;
      if (shotBodies[0]) {
        shot = 'data:image/png;base64,' + shotBodies[0];
      } else if (shotPaths[0]) {
        try {
          const abs = path.isAbsolute(shotPaths[0]) ? shotPaths[0] : path.join(cwd, shotPaths[0]);
          shot = 'data:image/png;base64,' + fs.readFileSync(abs).toString('base64');
          fs.rmSync(abs, { force: true });
        } catch {}
      }
      finish({
        startedAt,
        shot,
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

function failureResult(startedAt, message) {
  return {
    startedAt,
    shot: null,
    exitCode: null,
    passed: false,
    expected: null,
    failed: null,
    durationMs: null,
    errors: [message],
    rawTail: message,
  };
}

export function explain(result) {
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
