import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJestLike, parsePytestXml, renderFailures, digestGeneric, stripAnsi } from '../lib/digest.mjs';

const OPTS = { root: '/r', maxLines: 24, maxLineChars: 200, stackFrames: 2 };

const REPORT = {
  numTotalTests: 3, numPassedTests: 1, numFailedTests: 2, numPendingTests: 1, numTodoTests: 0,
  testResults: [{
    name: '/r/src/a.test.ts', status: 'failed',
    assertionResults: [
      { ancestorTitles: ['add'], title: 'ok', status: 'passed', failureMessages: [] },
      {
        ancestorTitles: ['add'], title: 'bad', status: 'failed',
        failureMessages: ['AssertionError: expected 1 to be 2\n    at /r/src/a.test.ts:5:3\n    at node_modules/vitest/dist/x.js:1:1\n    at /r/src/helper.ts:9:9'],
      },
      { ancestorTitles: [], title: 'worse', status: 'failed', failureMessages: ['Error: boom'] },
    ],
  }, { name: '/r/src/broken.test.ts', status: 'failed', message: 'SyntaxError: Unexpected token', assertionResults: [] }],
};

test('jest-like report: counts, relative paths, suite-level failures', () => {
  const r = parseJestLike(REPORT, '/r');
  assert.deepEqual(r.counts, { total: 3, passed: 1, failed: 3, skipped: 1 });
  assert.deepEqual(r.passed, ['src/a.test.ts::add > ok']);
  assert.equal(r.failed[0].file, 'src/a.test.ts');
  assert.equal(r.failed[0].title, 'src/a.test.ts > add > bad');
  assert.equal(r.failed[2].title, 'src/broken.test.ts (suite failed to run)');
});

test('digest shows message and two non-noise frames, never more failures than the cap allows', () => {
  const lines = renderFailures(parseJestLike(REPORT, '/r').failed, OPTS);
  const text = lines.join('\n');
  assert.match(text, /✗ src\/a\.test\.ts > add > bad/);
  assert.match(text, /expected 1 to be 2/);
  assert.match(text, /at src\/a\.test\.ts:5:3/);
  assert.match(text, /at src\/helper\.ts:9:9/);
  assert.doesNotMatch(text, /node_modules/);
  assert.ok(lines.length <= OPTS.maxLines - 3, `${lines.length} lines`);
});

test('many failures: three are shown, the rest are counted', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, title: `t${i}`, kind: 'js', message: `Error: e${i}` }));
  const lines = renderFailures(many, OPTS);
  assert.equal(lines.filter((l) => l.startsWith('✗')).length, 3);
  assert.match(lines.at(-1), /\+6 more failing/);
});

test('long lines are clipped', () => {
  const lines = renderFailures([{ id: 'x', title: 't', kind: 'js', message: `Error: ${'y'.repeat(900)}` }], OPTS);
  assert.ok(lines.every((l) => l.length <= OPTS.maxLineChars + 4));
});

const XML = `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="pytest" tests="3"><testcase classname="tests.test_mod.TestMod" name="test_neg" time="0.001"><failure message="assert 1 == -1&#10; +  where 1 = neg(1)">self = &lt;tests.test_mod.TestMod object&gt;&#10;&#10;    def test_neg(self):&#10;&gt;       assert neg(1) == -1&#10;E       assert 1 == -1&#10;E        +  where 1 = neg(1)&#10;&#10;tests/test_mod.py:8: AssertionError</failure></testcase><testcase classname="tests.test_mod" name="test_top" time="0.000"/><testcase classname="tests.test_mod" name="test_skip"><skipped message="x"/></testcase></testsuite></testsuites>`;

test('pytest junit xml: file lookup, class-qualified names, E lines', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tbud-py-'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests/test_mod.py'), '');
  const r = parsePytestXml(XML, { root, cwd: root });
  assert.deepEqual(r.counts, { total: 3, passed: 1, failed: 1, skipped: 1 });
  assert.equal(r.failed[0].file, 'tests/test_mod.py');
  assert.equal(r.failed[0].title, 'tests/test_mod.py > TestMod.test_neg');
  const text = renderFailures(r.failed, { ...OPTS, root }).join('\n');
  assert.match(text, /assert 1 == -1/);
  assert.match(text, /tests\/test_mod\.py:8: AssertionError/);
  assert.doesNotMatch(text, /def test_neg/);
});

test('generic digest keeps error lines and the tail inside the cap', () => {
  const noise = Array.from({ length: 400 }, (_, i) => `noise ${i}`);
  const text = [...noise.slice(0, 200), 'Error: the real problem', ...noise.slice(200), 'done'].join('\n');
  const out = digestGeneric(text, { maxLines: 24, maxLineChars: 200 });
  assert.ok(out.length <= 21);
  assert.ok(out.includes('Error: the real problem'));
  assert.equal(out.at(-1), 'done');
});

test('stripAnsi', () => {
  assert.equal(stripAnsi('\u001b[31mred\u001b[0m'), 'red');
});

test('relativize strips the real path of a symlinked root, not just the given one', async () => {
  const { relativize } = await import('../lib/digest.mjs');
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'tbud-real-'));
  const link = `${real}-link`;
  fs.symlinkSync(real, link);
  const realPath = fs.realpathSync(real);
  assert.equal(relativize(`${realPath}/src/a.test.ts:6:40`, link), 'src/a.test.ts:6:40');
  assert.equal(relativize(`file://${link}/src/a.ts`, link), 'src/a.ts');
});
