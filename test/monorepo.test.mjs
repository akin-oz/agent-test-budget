import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../lib/cli.mjs';

// A harrier-shaped monorepo: no runner at the root, vitest in apps/web, pytest under uv in services/api.
// The runners are stand-ins that record where they ran and with which arguments, then write a report.
const FAKE_VITEST = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TB_CALLS, JSON.stringify({ bin: 'vitest', cwd: process.cwd(), args }) + '\\n');
const out = args.find((a) => a.startsWith('--outputFile.json='))?.slice(18);
const file = require('path').resolve(args.find((a) => a.endsWith('.test.ts')) ?? 'src/a.test.ts');
if (out) fs.writeFileSync(out, JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0,
  testResults: [{ name: file, status: 'passed', assertionResults: [{ status: 'passed', title: 'works', ancestorTitles: [] }] }] }));
`;
const FAKE_UV = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TB_CALLS, JSON.stringify({ bin: 'uv', cwd: process.cwd(), args }) + '\\n');
const out = args.find((a) => a.startsWith('--junitxml='))?.slice(11);
if (out) fs.writeFileSync(out, '<testsuites><testsuite><testcase classname="tests.test_mod" name="test_x"/></testsuite></testsuites>');
`;

function monorepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tbud-mono-')));
  const w = (f, c, mode) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c, { mode }); };
  w('package.json', JSON.stringify({ name: 'mono', private: true, workspaces: ['apps/*'] }));
  w('apps/web/package.json', JSON.stringify({ name: 'web', devDependencies: { vitest: '^3' } }));
  w('apps/web/src/a.ts', 'export const a = 1;\n');
  w('apps/web/src/a.test.ts', "import { a } from './a';\n");
  w('apps/web/node_modules/.bin/vitest', FAKE_VITEST, 0o755);
  w('services/api/pyproject.toml', '[project]\nname = "api"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
  w('services/api/uv.lock', 'version = 1\n');
  w('services/api/mod.py', 'def x():\n    return 1\n');
  w('services/api/tests/test_mod.py', 'def test_x():\n    assert True\n');
  w('services/api/tests/conftest.py', '');
  w('bin/uv', FAKE_UV, 0o755);
  const git = (...a) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\nbin\n.test-budget/.state\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return root;
}

async function tb(root, cwd, argv) {
  const calls = path.join(root, 'calls.jsonl');
  fs.writeFileSync(calls, '');
  const old = { PATH: process.env.PATH, TB_CALLS: process.env.TB_CALLS };
  process.env.PATH = `${path.join(root, 'bin')}${path.delimiter}${old.PATH}`;
  process.env.TB_CALLS = calls;
  const lines = [];
  try {
    const code = await main(argv, { cwd: path.join(root, cwd), out: (s) => lines.push(...String(s).split('\n')) });
    const ran = fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { code, lines, text: lines.join('\n'), ran };
  } finally {
    process.env.PATH = old.PATH;
    if (old.TB_CALLS === undefined) delete process.env.TB_CALLS; else process.env.TB_CALLS = old.TB_CALLS;
  }
}

const skip = process.platform === 'win32' && 'shebang stand-ins';

test('from the repo root, a vitest target runs inside the package that owns it', { skip }, async () => {
  const root = monorepo();
  const r = await tb(root, '.', ['run', 'apps/web/src/a.test.ts']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.lines[0], /^tb: PASS vitest \| 1 passed \| [\d.]+s \| 1 target \| in apps\/web$/);
  assert.equal(r.ran[0].cwd, path.join(root, 'apps/web'));
  assert.deepEqual(r.ran[0].args.slice(0, 2), ['run', 'src/a.test.ts']);
  const here = await tb(root, 'apps/web', ['run', 'src/a.test.ts']); // already in the package: no "in" suffix
  assert.match(here.lines[0], /\| 1 target$/);
  assert.match((await tb(root, '.', ['brief', 'apps/web/src/a.ts'])).text, /runner: vitest/);
});

test('a pytest target in a uv project runs through `uv run` inside that project', { skip }, async () => {
  const root = monorepo();
  const r = await tb(root, '.', ['run', 'services/api/tests/test_mod.py']);
  assert.equal(r.code, 0, r.text);
  assert.match(r.lines[0], /^tb: PASS pytest \| 1 passed .*\| in services\/api$/);
  assert.equal(r.ran[0].bin, 'uv');
  assert.equal(r.ran[0].cwd, path.join(root, 'services/api'));
  assert.deepEqual(r.ran[0].args.slice(0, 3), ['run', '--frozen', 'pytest']);
  assert.equal(r.ran[0].args.at(-1), 'tests/test_mod.py');
  // a source file maps to its test inside the package
  const src = await tb(root, '.', ['run', 'services/api/mod.py']);
  assert.equal(src.ran[0].args.at(-1), path.join(root, 'services/api/tests/test_mod.py'));
});

test('targets in two packages, or changes in two packages, are refused: one run is one package', { skip }, async () => {
  const root = monorepo();
  const mixed = await tb(root, '.', ['run', 'apps/web/src/a.test.ts', 'services/api/tests/test_mod.py']);
  assert.equal(mixed.code, 2);
  assert.match(mixed.text, /these targets belong to 2 packages \(apps\/web, services\/api\)/);
  assert.equal(mixed.ran.length, 0);

  fs.appendFileSync(path.join(root, 'apps/web/src/a.ts'), 'export const b = 2;\n');
  const one = await tb(root, '.', ['run']);
  assert.equal(one.ran[0].cwd, path.join(root, 'apps/web')); // the one package with changes
  assert.ok(one.ran[0].args.includes('--changed'));
  fs.appendFileSync(path.join(root, 'services/api/mod.py'), 'y = 2\n');
  const two = await tb(root, '.', ['run']);
  assert.equal(two.code, 2);
  assert.match(two.text, /the uncommitted changes are in 2 packages \(apps\/web, services\/api\)/);
  const inside = await tb(root, 'services/api', ['run']); // standing in a package picks that package
  assert.equal(inside.ran[0].bin, 'uv');
});
