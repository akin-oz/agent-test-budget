import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../lib/policy.mjs';
import { signature, headline, checkBefore, recordAfter } from '../lib/loop.mjs';

const policy = structuredClone(DEFAULTS);
const MIN = 60_000;
const fail = (over = {}) => ({
  id: 'a.test.ts::add > x', file: 'a.test.ts', title: 'a.test.ts > add > x', kind: 'js',
  message: 'AssertionError: expected 1 to be 2\n    at a.test.ts:3:1', ...over,
});
const none = new Set();
const t = (rel, kind) => ({ rel, kind });

function tripped(now = 3000) {
  let state = { failures: {} };
  for (const at of [1000, 2000, now]) state = recordAfter({ state, failed: [fail()], passedIds: none, policy, now: at }).state;
  return state;
}

test('signature blurs numbers but keeps test identity and the complaint', () => {
  const a = signature(fail());
  assert.equal(signature(fail({ message: 'AssertionError: expected 7 to be 9' })), a);
  assert.notEqual(signature(fail({ id: 'a.test.ts::add > y' })), a);
  assert.notEqual(signature(fail({ message: 'TypeError: x is not a function' })), a);
});

test('python headline is the first E line', () => {
  assert.equal(headline({ kind: 'py', message: 'def t():\n>  assert 1 == 2\nE  assert 1 == 2\nE  +  where' }), 'assert 1 == 2');
});

test('repeats are reported, the 3rd identical failure trips', () => {
  let r = recordAfter({ state: { failures: {} }, failed: [fail()], passedIds: none, policy, now: 1000 });
  assert.equal(r.repeats.length + r.tripped.length, 0);
  r = recordAfter({ state: r.state, failed: [fail()], passedIds: none, policy, now: 2000 });
  assert.equal(r.repeats[0].count, 2);
  r = recordAfter({ state: r.state, failed: [fail()], passedIds: none, policy, now: 3000 });
  assert.equal(r.tripped[0].count, 3);
  assert.equal(Object.values(r.state.failures)[0].tripped, true);
});

test('a different complaint is a new failure, not a repeat', () => {
  let r = recordAfter({ state: { failures: {} }, failed: [fail()], passedIds: none, policy, now: 1000 });
  r = recordAfter({ state: r.state, failed: [fail({ message: 'TypeError: boom' })], passedIds: none, policy, now: 2000 });
  assert.equal(r.repeats.length, 0);
});

test('a pass clears the entry and the ttl expires it', () => {
  const state = tripped();
  assert.deepEqual(recordAfter({ state, failed: [], passedIds: new Set([fail().id]), policy, now: 4000 }).state.failures, {});
  const later = recordAfter({ state, failed: [fail()], passedIds: none, policy, now: 3000 + 61 * MIN });
  assert.equal(Object.values(later.state.failures)[0].count, 1);
});

test('tripped failure refuses runs that could include it, not unrelated ones', () => {
  const state = tripped();
  const gate = (targets, now = 4000) => checkBefore({ state, runs: [], policy, targets, now }).blocked;
  assert.equal(gate([t('a.test.ts', 'test')]), true);
  assert.equal(gate([]), true, 'changed-mode may include it');
  assert.equal(gate([t('src/a.ts', 'src')]), true, 'related-tests mode may include it');
  assert.equal(gate([t('', 'dir')]), true);
  assert.equal(gate([t('b.test.ts', 'test')]), false);
  assert.equal(gate([t('lib', 'dir')]), false);
  assert.equal(gate([t('a.test.ts', 'test')], 3000 + 61 * MIN), false, 'ttl');
});

test('a reset record lifts a trip and the run budget', () => {
  const state = tripped();
  const reset = [{ type: 'reset', ts: 5000 }];
  assert.equal(checkBefore({ state, runs: reset, policy, targets: [t('a.test.ts', 'test')], now: 6000 }).blocked, false);
  const runs = Array.from({ length: 12 }, (_, i) => ({ type: 'run', ts: 6000 + i }));
  assert.equal(checkBefore({ state: { failures: {} }, runs, policy, targets: [], now: 7000 }).kind, 'rate');
  assert.equal(checkBefore({ state: { failures: {} }, runs: [...runs, { type: 'reset', ts: 8000 }], policy, targets: [], now: 9000 }).blocked, false);
});

test('run budget: 11 runs pass, 12 refuse, old runs age out', () => {
  const mk = (n, at) => Array.from({ length: n }, (_, i) => ({ type: 'run', ts: at + i }));
  const g = (runs, now) => checkBefore({ state: { failures: {} }, runs, policy, targets: [], now }).blocked;
  assert.equal(g(mk(11, 1000), 5000), false);
  assert.equal(g(mk(12, 1000), 5000), true);
  assert.equal(g(mk(12, 1000), 1000 + 61 * MIN), false);
});
