import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../server/agent.js';
const base = (assertions) => ({ flow: 'signup', assertions });
test('plan that omits no-duplicate-account gets it added and recorded', () => {
  const plan = base(['welcome-visible', 'user-record-exists', 'url-contains-dashboard']);
  const { problems, repairs } = validatePlan(plan);
  assert.deepEqual(problems, []);
  assert.ok(plan.assertions.includes('no-duplicate-account'));
  assert.deepEqual(repairs, ['missing required assertion added: no-duplicate-account']);
});
test('url-only plan is upgraded, stays ok, repair recorded', () => {
  const plan = base(['url-contains-dashboard']);
  const { problems, repairs } = validatePlan(plan);
  assert.deepEqual(problems, []);
  for (const a of ['welcome-visible', 'user-record-exists', 'no-duplicate-account']) assert.ok(plan.assertions.includes(a));
  assert.ok(repairs.some((r) => r.startsWith('url-only')));
});
test('unsupported assertions are rejected', () => {
  const plan = base(['welcome-visible', 'user-record-exists', 'no-duplicate-account', 'page-is-pretty']);
  const { repairs } = validatePlan(plan);
  assert.ok(!plan.assertions.includes('page-is-pretty'));
  assert.ok(repairs.some((r) => r.includes('page-is-pretty')));
});
test('complete plan untouched; non-signup flow is a problem', () => {
  const ok = base(['welcome-visible', 'user-record-exists', 'no-duplicate-account']);
  assert.deepEqual(validatePlan(ok), { problems: [], repairs: [] });
  assert.deepEqual(validatePlan({ flow: 'checkout', assertions: ok.assertions }).problems, ['unknown flow']);
});
