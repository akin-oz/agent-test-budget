import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../lib/cli.mjs';

const BIN = fileURLToPath(new URL('../bin/tbudget', import.meta.url));

// A fake runner stands in for vitest/jest/pytest so these tests need no network and no installs.
const FAKE = `
import fs from 'node:fs';
const dir = new URL('.', import.meta.url);
const mode = fs.readFileSync(new URL('mode.txt', dir), 'utf8').trim();
fs.appendFileSync(new URL('calls.txt', dir), 'x');
// no process.exit(): it can cut off output that is still queued on a pipe
if (mode === 'pass') console.log('ok');
else if (mode === 'fail') {
  const out = Array.from({ length: 300 }, (_, i) => 'noise line ' + i);
  out.push('Error: expected 1 to be 2');
  process.stdout.write(out.join('\\n') + '\\n');
  process.exitCode = 1;
} else if (mode === 'hang') {
  fs.writeFileSync(new URL('child.pid', dir), String(process.pid));
  setInterval(() => {}, 1000);
}
`;

function project(policy = {}, mode = 'pass') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbud-cli-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.mkdirSync(path.join(dir, '.test-budget'));
  fs.writeFileSync(path.join(dir, '.test-budget/policy.json'), JSON.stringify({ runner: 'generic', generic: { cmd: 'node fake.mjs' }, ...policy }));
  fs.writeFileSync(path.join(dir, 'fake.mjs'), FAKE);
  fs.writeFileSync(path.join(dir, 'mode.txt'), mode);
  fs.writeFileSync(path.join(dir, 'calls.txt'), '');
  fs.writeFileSync(path.join(dir, 'a.test.js'), "it('x', () => {});\n");
  fs.writeFileSync(path.join(dir, 'b.test.js'), "it('y', () => {});\n");
  fs.writeFileSync(path.join(dir, 'src.js'), 'export const f = () => 1;\n');
  return dir;
}
const setMode = (dir, m) => fs.writeFileSync(path.join(dir, 'mode.txt'), m);
const calls = (dir) => fs.readFileSync(path.join(dir, 'calls.txt'), 'utf8').length;
async function tb(dir, argv) {
  const lines = [];
  const code = await main(argv, { cwd: dir, out: (s) => lines.push(...String(s).split('\n')) });
  return { code, lines, text: lines.join('\n') };
}

test('a pass costs exactly one line', async () => {
  const dir = project();
  const r = await tb(dir, ['run', 'a.test.js']);
  assert.equal(r.code, 0);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /^tb: PASS generic \| exit 0 \| [\d.]+s \| 1 target$/);
});

test('a failure is capped at policy.digest.maxLines and the full log keeps everything', async () => {
  const dir = project({ digest: { maxLines: 10 } }, 'fail');
  const r = await tb(dir, ['run', 'a.test.js']);
  assert.equal(r.code, 1);
  assert.ok(r.lines.length <= 10, `${r.lines.length} lines`);
  assert.match(r.lines[0], /^tb: FAIL generic/);
  assert.match(r.lines.at(-1), /^log: \.test-budget\/\.state\/last-run\.log/);
  assert.ok(r.text.includes('Error: expected 1 to be 2'));
  const log = fs.readFileSync(path.join(dir, '.test-budget/.state/last-run.log'), 'utf8');
  assert.ok(log.includes('noise line 0') && log.includes('noise line 299'));
});

test('loop breaker: 3rd identical failure trips, then the runner is not started at all', async () => {
  const dir = project({}, 'fail');
  assert.equal((await tb(dir, ['run', 'a.test.js'])).code, 1);
  const second = await tb(dir, ['run', 'a.test.js']);
  assert.match(second.text, /same failure 2\/3/);
  const third = await tb(dir, ['run', 'a.test.js']);
  assert.equal(third.code, 3);
  assert.match(third.text, /STOP - same failure 3\/3/);
  assert.equal(calls(dir), 3);
  const fourth = await tb(dir, ['run', 'a.test.js']);
  assert.equal(fourth.code, 3);
  assert.match(fourth.text, /Do not re-run it/);
  assert.equal(calls(dir), 3, 'refused before running anything');
  assert.equal((await tb(dir, ['reset'])).code, 0);
  assert.equal((await tb(dir, ['run', 'a.test.js'])).code, 1);
  assert.equal(calls(dir), 4);
});

test('a pass in between resets the count', async () => {
  const dir = project({}, 'fail');
  await tb(dir, ['run', 'a.test.js']);
  await tb(dir, ['run', 'a.test.js']);
  setMode(dir, 'pass');
  assert.equal((await tb(dir, ['run', 'a.test.js'])).code, 0);
  setMode(dir, 'fail');
  const again = await tb(dir, ['run', 'a.test.js']);
  assert.doesNotMatch(again.text, /same failure/);
});

test('run budget refuses before spending anything', async () => {
  const dir = project({ loop: { maxRunsPerWindow: 2 } });
  assert.equal((await tb(dir, ['run', 'a.test.js'])).code, 0);
  assert.equal((await tb(dir, ['run', 'b.test.js'])).code, 0);
  const r = await tb(dir, ['run', 'a.test.js']);
  assert.equal(r.code, 3);
  assert.match(r.text, /run budget used: 2 runs/);
  assert.equal(calls(dir), 2);
});

test('timeout kills the runner and reports it', async () => {
  const dir = project({ timeoutSec: 1 }, 'hang');
  const r = await tb(dir, ['run', 'a.test.js']);
  assert.equal(r.code, 4);
  assert.match(r.lines[0], /^tb: TIMEOUT generic/);
  assert.match(r.text, /killed after 1s/);
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (ok, ms = 5000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await new Promise((r) => setTimeout(r, 25))) if (ok()) return true;
  return false;
};

for (const sig of ['SIGTERM', 'SIGINT']) {
  test(`${sig} to tbudget kills the runner too, no orphan left behind`, { skip: process.platform === 'win32' }, async () => {
    const dir = project({ timeoutSec: 60 }, 'hang');
    const tbProc = spawn(process.execPath, [BIN, 'run', 'a.test.js'], { cwd: dir, stdio: 'ignore' });
    const exited = new Promise((r) => tbProc.on('exit', (code, signal) => r({ code, signal })));
    const pidFile = path.join(dir, 'child.pid');
    assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')), 'runner never started');
    const runner = Number(fs.readFileSync(pidFile, 'utf8'));
    tbProc.kill(sig);
    const { code } = await exited;
    assert.equal(code, 128 + os.constants.signals[sig]);
    const gone = await until(() => !alive(runner));
    if (!gone) process.kill(runner, 'SIGKILL');
    assert.ok(gone, `runner ${runner} survived ${sig}`);
  });
}

// A fake `pytest` on PATH: records its arguments, optionally writes an empty junit report, exits 5
// (pytest's "no tests collected").
function fakePytest(dir, { report }) {
  const bin = path.join(dir, 'fakebin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pytest'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(path.join(dir, 'pytest-args.json'))}, JSON.stringify(args));
const j = args.find((a) => a.startsWith('--junitxml='));
if (${report} && j) fs.writeFileSync(j.slice(11), '<testsuites><testsuite name="pytest" tests="0"></testsuite></testsuites>');
process.exitCode = 5;
`, { mode: 0o755 });
  return bin;
}
async function withPath(bin, fn) {
  const old = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${old}`;
  try { return await fn(); } finally { process.env.PATH = old; }
}
function pytestProject(report) {
  const dir = project({ runner: 'pytest' });
  fs.writeFileSync(path.join(dir, 'test_a.py'), 'def test_x():\n    assert True\n');
  return { dir, bin: fakePytest(dir, { report }) };
}

for (const report of [true, false]) {
  test(`pytest exit 5 (nothing collected) is NO TESTS, not a runner error (${report ? 'with' : 'without'} a report)`, { skip: process.platform === 'win32' }, async () => {
    const { dir, bin } = pytestProject(report);
    const r = await withPath(bin, () => tb(dir, ['run', 'test_a.py']));
    assert.equal(r.code, 1);
    assert.match(r.lines[0], /^tb: NO TESTS pytest/);
    assert.match(r.text, /no tests matched/);
  });
}

test('-k is accepted as the test-name filter and reaches pytest as -k', { skip: process.platform === 'win32' }, async () => {
  const { dir, bin } = pytestProject(true);
  const r = await withPath(bin, () => tb(dir, ['run', 'test_a.py', '-k', 'total']));
  const args = JSON.parse(fs.readFileSync(path.join(dir, 'pytest-args.json'), 'utf8'));
  assert.deepEqual(args.slice(args.indexOf('-k'), args.indexOf('-k') + 2), ['-k', 'total']);
  assert.match(r.lines[0], /\| -k total$/);
  const g = await tb(project(), ['run', 'a.test.js', '-k', 'x']);
  assert.equal(g.code, 0);
  assert.match(g.lines[0], /\| -t x$/);
});

// a stand-in for gotestsum / Gradle / Bazel: writes JUnit XML to the path it is given
const JUNIT_FAKE = `
import fs from 'node:fs';
import path from 'node:path';
const out = process.argv[2];
const xml = '<testsuites><testsuite name="pkg">'
  + '<testcase classname="pkg/cart" name="TestTotal" file="cart_test.go"/>'
  + '<testcase classname="pkg/cart" name="TestEmpty"/>'
  + '<testcase classname="pkg/cart" name="TestDiscount" file="cart_test.go"><failure message="discount off by one">cart_test.go:42: got 9, want 10</failure></testcase>'
  + '<testcase classname="pkg/cart" name="TestLater"><skipped/></testcase>'
  + '</testsuite></testsuites>';
const file = out.endsWith('/') ? path.join(out, 'TEST-pkg.xml') : out;
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, xml);
process.exitCode = 1;
`;

test('junit runner: any tool that writes JUnit XML gets the digest and the loop breaker', async () => {
  const dir = project({ runner: 'junit', junit: { cmd: 'node junit.mjs {report}' } });
  fs.writeFileSync(path.join(dir, 'junit.mjs'), JUNIT_FAKE);
  const r = await tb(dir, ['run', 'a.test.js']);
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /^tb: FAIL junit \| 1 failed, 2 passed, 1 skipped/);
  assert.match(r.text, /✗ cart_test\.go > pkg\/cart\.TestDiscount/);
  assert.match(r.text, /got 9, want 10/);
});

test('junit runner: a report directory only counts files written by this run', async () => {
  const dir = project({ runner: 'junit', junit: { cmd: 'node junit.mjs out/', report: 'out' } });
  fs.writeFileSync(path.join(dir, 'junit.mjs'), JUNIT_FAKE);
  fs.mkdirSync(path.join(dir, 'out'));
  const stale = path.join(dir, 'out', 'TEST-old.xml');
  fs.writeFileSync(stale, '<testsuite><testcase classname="old" name="x"><failure message="stale"/></testcase></testsuite>');
  fs.utimesSync(stale, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  const r = await tb(dir, ['run', 'a.test.js']);
  assert.match(r.lines[0], /1 failed, 2 passed/);
  assert.doesNotMatch(r.text, /stale/);
});

test('junit runner: no report found is said out loud and judged by exit code', async () => {
  const dir = project({ runner: 'junit', junit: { cmd: 'node fake.mjs', report: 'nowhere' } });
  const r = await tb(dir, ['run', 'a.test.js']);
  assert.equal(r.code, 0);
  assert.match(r.text, /no JUnit XML found at nowhere; judged by exit code only/);
  assert.equal((await tb(project({ runner: 'junit' }), ['run', 'a.test.js'])).code, 2); // junit.cmd missing
});

const CLAMP = `export function clamp(x, lo, hi) {
  if (lo > hi) throw new RangeError('lo > hi');
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
`;
const WEAK = "import assert from 'node:assert/strict';\nimport { clamp } from './clamp.mjs';\nassert.equal(clamp(5, 0, 10), 5);\n";
const STRONG = `${WEAK}assert.throws(() => clamp(1, 5, 0), RangeError);\nassert.equal(clamp(1, 3, 3), 3);\nassert.equal(clamp(-1, 0, 10), 0);\nassert.equal(clamp(11, 0, 10), 10);\n`;

function mutateProject(policy = {}) {
  const dir = project({ generic: { cmd: 'node {files}' }, ...policy });
  fs.writeFileSync(path.join(dir, 'clamp.mjs'), CLAMP);
  fs.writeFileSync(path.join(dir, 'weak.test.mjs'), WEAK);
  fs.writeFileSync(path.join(dir, 'strong.test.mjs'), STRONG);
  return dir;
}

test('mutate: weak tests let mutants survive, strong tests kill them, the source is restored', async () => {
  const dir = mutateProject();
  const weak = await tb(dir, ['mutate', 'clamp.mjs', '--tests', 'weak.test.mjs']);
  assert.equal(weak.code, 0);
  assert.match(weak.lines[0], /^tb: MUTATE clamp\.mjs \| 0\/4 killed \(0%\)/);
  assert.match(weak.text, /survived L2: ">" -> ">=" \| if \(lo > hi\) throw/);
  assert.match(weak.text, /survived L2: "throw" -> "void"/);
  assert.match(weak.text, /add an assertion that fails on that change/);
  const strong = await tb(dir, ['mutate', 'clamp.mjs', '--tests', 'strong.test.mjs']);
  // x <= lo and x >= hi return the same value: equivalent mutants no test can kill
  assert.match(strong.lines[0], /^tb: MUTATE clamp\.mjs \| 2\/4 killed \(50%\)/);
  assert.equal(fs.readFileSync(path.join(dir, 'clamp.mjs'), 'utf8'), CLAMP);
  assert.ok(!fs.existsSync(path.join(dir, '.test-budget/.state/mutate-backup.json')));
  assert.deepEqual(records(dir).filter((r) => r.type === 'mutate').map((r) => r.killed), [0, 2]);
});

test('mutate: refuses without green tests, without --tests on a generic runner, and gates on minScore', async () => {
  const dir = mutateProject({ mutate: { minScore: 0.75 } });
  fs.writeFileSync(path.join(dir, 'red.test.mjs'), "import assert from 'node:assert/strict';\nassert.equal(1, 2);\n");
  assert.equal((await tb(dir, ['mutate', 'clamp.mjs', '--tests', 'red.test.mjs'])).code, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'clamp.mjs'), 'utf8'), CLAMP);
  assert.equal((await tb(dir, ['mutate', 'clamp.mjs'])).code, 2);
  assert.equal((await tb(dir, ['mutate', 'weak.test.mjs'])).code, 2);
  const r = await tb(dir, ['mutate', 'clamp.mjs', '--tests', 'strong.test.mjs']);
  assert.equal(r.code, 1);
  assert.match(r.text, /below policy\.mutate\.minScore \(75%\)/);
});

test('mutate: a run killed mid-way is undone by the next tbudget command', async () => {
  const dir = mutateProject();
  fs.mkdirSync(path.join(dir, '.test-budget/.state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'clamp.mjs'), CLAMP.replace(' > hi', ' >= hi'));
  fs.writeFileSync(path.join(dir, '.test-budget/.state/mutate-backup.json'), JSON.stringify({ file: path.join(dir, 'clamp.mjs'), text: CLAMP }));
  const r = await tb(dir, ['stats']);
  assert.match(r.lines[0], /restored clamp\.mjs from an interrupted mutate run/);
  assert.equal(fs.readFileSync(path.join(dir, 'clamp.mjs'), 'utf8'), CLAMP);
});

test('report: what enforcement actually did, not only what it would have done', async () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.test-budget/.state'), { recursive: true });
  const t = Date.now();
  fs.writeFileSync(path.join(dir, '.test-budget/.state/runs.jsonl'), [
    { ts: t, type: 'deny', rule: 'raw-runner', tool: 'Bash', agent: 'main' },
    { ts: t, type: 'deny', rule: 'raw-runner-inproc', tool: 'process', agent: 'in-process' },
    { ts: t, type: 'block', kind: 'repeat' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = await tb(dir, ['report']);
  assert.match(r.text, /enforced: 2 denied \(raw-runner 1, raw-runner-inproc 1\) \| 1 runs refused \(repeat 1\)/);
});

test('--all needs policy.allowAll', async () => {
  const off = await tb(project(), ['run', '--all']);
  assert.equal(off.code, 2);
  assert.match(off.text, /--all is disabled/);
  const on = await tb(project({ allowAll: true }), ['run', '--all']);
  assert.equal(on.code, 0);
  assert.match(on.lines[0], /full suite/);
});

test('bad arguments are refused without running anything', async () => {
  const dir = project();
  for (const argv of [
    ['run', '--watch'], ['run', 'nope.test.js'], ['run', 'a.test.js', 'src.js'], ['run', '--all', 'a.test.js'], ['run', '-t'], ['bogus'],
  ]) {
    assert.equal((await tb(dir, argv)).code, 2, argv.join(' '));
  }
  assert.equal(calls(dir), 0);
});

test('policy typos are surfaced in the first line of a run, not silently ignored', async () => {
  const r = await tb(project({ digets: {} }), ['run', 'a.test.js']);
  assert.equal(r.code, 0);
  assert.match(r.text, /policy warning: unknown key digets/);
});

test('stats summarises runs, denials and trips', async () => {
  const dir = project({}, 'fail');
  for (let i = 0; i < 4; i++) await tb(dir, ['run', 'a.test.js']);
  const s = await tb(dir, ['stats']);
  assert.match(s.text, /runs: 3 \| FAIL 3/);
  assert.match(s.text, /loop breaker: 1 tripped, 1 runs refused/);
  assert.match(s.text, /kept out of context/);
});

test('brief: exports, existing tests and a style exemplar in one call', async () => {
  const dir = project();
  const r = await tb(dir, ['brief', 'src.js']);
  assert.equal(r.code, 0);
  assert.match(r.text, /export const f = \(\) => 1;/);
  assert.match(r.text, /existing tests: none/);
  assert.match(r.text, /style exemplar: a\.test\.js/);
});

const records = (dir) => fs.readFileSync(path.join(dir, '.test-budget/.state/runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('shadow mode: the loop breaker records would-block but the runs still happen', async () => {
  const dir = project({ mode: 'shadow' }, 'fail');
  for (let i = 0; i < 5; i++) {
    const r = await tb(dir, ['run', 'a.test.js']);
    assert.equal(r.code, 1, `run ${i + 1}`);
    assert.doesNotMatch(r.text, /STOP|same failure/);
    assert.match(r.lines.at(-1), /^log: /, 'digest still capped and pointed at the log');
  }
  assert.equal(calls(dir), 5);
  const recs = records(dir);
  assert.deepEqual(recs.filter((r) => r.type === 'would-block').map((r) => r.kind), ['repeat', 'repeat']);
  assert.ok(!recs.some((r) => r.type === 'block'));
  assert.equal(recs.filter((r) => r.type === 'run').reduce((a, r) => a + r.tripped, 0), 1);
});

test('shadow mode: the run budget records would-block but does not refuse', async () => {
  const dir = project({ mode: 'shadow', loop: { maxRunsPerWindow: 2 } });
  for (let i = 0; i < 3; i++) assert.equal((await tb(dir, ['run', 'a.test.js'])).code, 0);
  assert.equal(calls(dir), 3);
  assert.deepEqual(records(dir).filter((r) => r.type === 'would-block').map((r) => r.kind), ['rate']);
});

test('report: period, would-deny by rule, would-block, output sizes, labelled token estimate, <=12 lines', async () => {
  const empty = await tb(project({ mode: 'shadow' }), ['report']);
  assert.equal(empty.code, 0);
  assert.match(empty.text, /nothing recorded yet/);

  const dir = project({ mode: 'shadow' }, 'fail');
  fs.mkdirSync(path.join(dir, '.test-budget/.state'), { recursive: true });
  const day = 86_400_000;
  const t0 = Date.now() - 7 * day;
  fs.writeFileSync(path.join(dir, '.test-budget/.state/runs.jsonl'), [
    { ts: t0, type: 'would-deny', rule: 'raw-runner', tool: 'Bash', agent: 'main', command: 'npx vitest run' },
    { ts: t0 + day, type: 'would-deny', rule: 'raw-runner', tool: 'Bash', agent: 'test-writer', command: 'npm test' },
    { ts: t0 + 2 * day, type: 'would-deny', rule: 'protected', tool: 'Edit', agent: 'main', command: '.claude/settings.json' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  for (let i = 0; i < 4; i++) await tb(dir, ['run', 'a.test.js']);
  const r = await tb(dir, ['report']);
  assert.equal(r.code, 0);
  assert.ok(r.lines.length <= 12, `${r.lines.length} lines`);
  assert.match(r.lines[0], /^tbudget report \| mode: shadow \| \d{4}-\d\d-\d\d \d\d:\d\d to \d{4}-\d\d-\d\d \d\d:\d\d UTC \(7\.0 days, \d+ records\)$/);
  assert.match(r.text, /would-deny: 3 \| by rule: raw-runner 2, protected 1/);
  assert.match(r.text, /by agent: main 2, test-writer 1/);
  assert.match(r.text, /would-block: 1 runs \| by kind: repeat 1 \| breaker would have tripped 1x/);
  assert.match(r.text, /tbudget runs: 4 \| FAIL 4/);
  assert.match(r.text, /runner output: [\d.]+k? chars raw -> [\d.]+k? chars digest \(\d+% less\)/);
  assert.match(r.text, /~[\d.]+k? tokens kept out of context \(ESTIMATE: chars\/4/);
  assert.match(r.text, /plus 2 raw runner calls/);
});
