// Real runners on real projects. Needs network (npm install) and python+pytest, so it only runs with TBUDGET_E2E=1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../lib/cli.mjs';

const E2E = process.env.TBUDGET_E2E === '1';
const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(here, '..', 'hooks', 'guard.mjs');
const hasPytest = spawnSync('pytest', ['--version']).status === 0;

const SPECS = [
  {
    name: 'vitest', fx: 'vitest-proj', npm: true, test: 'src/add.test.ts', src: 'src/add.ts', failTitle: /✗ src\/add\.test\.ts > add > negates/,
    fixed: 'export function add(a: number, b: number): number { return a + b; }\nexport function neg(a: number): number { return -a; }\n', raw: 'npx vitest run',
  },
  {
    name: 'jest', fx: 'jest-proj', npm: true, test: 'src/add.test.js', src: 'src/add.js', failTitle: /✗ src\/add\.test\.js > add > negates/,
    fixed: 'exports.add = (a, b) => a + b;\nexports.neg = (a) => -a;\n', raw: 'npx jest --ci',
  },
  {
    name: 'pytest', fx: 'pytest-proj', npm: false, skip: !hasPytest && 'pytest not installed', test: 'tests/test_mod.py', src: 'pkg/mod.py',
    failTitle: /✗ tests\/test_mod\.py > TestMod\.test_neg/, fixed: 'def add(a, b):\n    return a + b\n\n\ndef neg(a):\n    return -a\n', raw: 'pytest -x',
  },
];

function setup(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tbud-e2e-${spec.name}-`));
  fs.cpSync(path.join(here, 'fixtures', spec.fx), dir, { recursive: true });
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  if (spec.npm) {
    const r = spawnSync('npm', ['install', '--silent', '--no-audit', '--no-fund'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `npm install failed: ${r.stderr}`);
  }
  git('add', '-A'); git('commit', '-qm', 'fixture');
  return dir;
}

async function tb(dir, argv) {
  const lines = [];
  const code = await main(argv, { cwd: dir, out: (s) => lines.push(...String(s).split('\n')) });
  return { code, lines, text: lines.join('\n') };
}

for (const spec of SPECS) {
  test(`${spec.name}: failing run digest, fix, pass, related mode, guard`, { skip: !E2E ? 'set TBUDGET_E2E=1' : spec.skip, timeout: 240_000 }, async () => {
    const dir = setup(spec);

    const bad = await tb(dir, ['run', spec.test]);
    assert.equal(bad.code, 1, bad.text);
    assert.match(bad.lines[0], new RegExp(`^tb: FAIL ${spec.name} \\| 1 failed, 1 passed`));
    assert.match(bad.text, spec.failTitle);
    assert.ok(bad.lines.length <= 24, `${bad.lines.length} lines`);
    assert.ok(fs.statSync(path.join(dir, '.test-budget/.state/last-run.log')).size > 0);

    fs.writeFileSync(path.join(dir, spec.src), spec.fixed);
    const good = await tb(dir, ['run', spec.test]);
    assert.equal(good.code, 0, good.text);
    assert.equal(good.lines.length, 1);
    assert.match(good.lines[0], new RegExp(`^tb: PASS ${spec.name} \\| 2 passed`));

    const related = await tb(dir, ['run', spec.src]);
    assert.equal(related.code, 0, related.text);

    const one = await tb(dir, ['run', spec.test, '-t', spec.name === 'pytest' ? 'test_add' : 'adds']);
    assert.equal(one.code, 0, one.text);
    assert.match(one.lines[0], /1 passed/);

    const g = spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: spec.raw }, cwd: dir }),
      cwd: dir, encoding: 'utf8',
    });
    assert.equal(JSON.parse(g.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });
}
