import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { envLines } from '../hooks/session-env.mjs';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(PLUGIN, 'hooks', 'session-env.mjs');
const has = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).status === 0;
const BASH = process.platform !== 'win32' && has('bash', ['-c', 'true']);
const PYTEST = BASH && has('python3', ['-m', 'pytest', '--version']);

function project(policy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbud-inproc-'));
  fs.mkdirSync(path.join(dir, '.git'));
  if (policy) {
    fs.mkdirSync(path.join(dir, '.test-budget'));
    fs.writeFileSync(path.join(dir, '.test-budget', 'policy.json'), JSON.stringify(policy));
  }
  // a stand-in vitest package and a Node script that spawns it: the shell guard cannot see that one
  fs.mkdirSync(path.join(dir, 'node_modules', 'vitest'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'vitest', 'vitest.mjs'), "console.log('vitest ran');\n");
  fs.writeFileSync(path.join(dir, 'spawn.mjs'), "import { spawnSync } from 'node:child_process';\nprocess.exitCode = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs'], { stdio: 'inherit' }).status;\n");
  fs.writeFileSync(path.join(dir, 'test_x.py'), 'def test_x():\n    assert True\n');
  return dir;
}

// run a command the way the agent's Bash tool would, after the CLAUDE_ENV_FILE preamble
function agentShell(dir, cmd, env = {}) {
  const envFile = path.join(dir, 'claude-env.sh');
  fs.writeFileSync(envFile, `${envLines(PLUGIN).join('\n')}\n`);
  const clean = { ...process.env };
  delete clean.TBUDGET_INSIDE;
  Object.assign(clean, env);
  return spawnSync('bash', ['-c', `. ${JSON.stringify(envFile)}; . ${JSON.stringify(envFile)}; ${cmd}`], { cwd: dir, env: clean, encoding: 'utf8' });
}
const records = (dir) => {
  try { return fs.readFileSync(path.join(dir, '.test-budget/.state/runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; }
};

test('SessionStart writes an idempotent, additive preamble to CLAUDE_ENV_FILE', { skip: !BASH }, () => {
  const dir = project();
  const envFile = path.join(dir, 'env.sh');
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: dir }), env: { ...process.env, CLAUDE_ENV_FILE: envFile }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const out = spawnSync('bash', ['-c', `. ${envFile}; . ${envFile}; printf '%s\\n' "$NODE_OPTIONS" "$PYTEST_PLUGINS"`], {
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096', PYTEST_PLUGINS: 'xdist' }, encoding: 'utf8',
  }).stdout.split('\n');
  assert.equal(out[0].match(/preload\.cjs/g)?.length, 1, out[0]); // sourced twice, added once
  assert.match(out[0], /^--max-old-space-size=4096 --require /); // the user's options survive
  assert.equal(out[1], 'xdist,tbudget_pytest');
  const off = path.join(dir, 'off.sh');
  spawnSync(process.execPath, [HOOK], { input: '{}', env: { ...process.env, CLAUDE_ENV_FILE: off, TBUDGET_GUARD: 'off' } });
  assert.ok(!fs.existsSync(off));
});

test('a vitest started outside tbudget is refused inside the process, even from a Node script', { skip: !BASH }, () => {
  const dir = project();
  for (const cmd of ['node node_modules/vitest/vitest.mjs run', 'node spawn.mjs', 'R=node_modules/vitest/vitest.mjs; node $R']) {
    const r = agentShell(dir, cmd);
    assert.equal(r.status, 2, cmd);
    assert.match(r.stderr, /tb-guard: raw vitest blocked inside the process/, cmd);
    assert.doesNotMatch(r.stdout, /vitest ran/, cmd);
  }
  assert.ok(records(dir).every((x) => x.type === 'deny' && x.rule === 'raw-runner-inproc'));
  assert.match(agentShell(dir, 'node node_modules/vitest/vitest.mjs', { TBUDGET_INSIDE: '1' }).stdout, /vitest ran/); // tbudget's own runs
  assert.match(agentShell(dir, 'node node_modules/vitest/vitest.mjs --version').stdout, /vitest ran/);
  assert.equal(agentShell(dir, 'node -e "console.log(42)"').stdout.trim(), '42'); // everything else is untouched
});

test('in-process guard follows the policy: shadow records, enforce list and inProcess switch it off', { skip: !BASH }, () => {
  const shadow = project({ mode: 'shadow' });
  assert.match(agentShell(shadow, 'node spawn.mjs').stdout, /vitest ran/);
  assert.equal(records(shadow)[0].type, 'would-deny');
  for (const guard of [{ enforce: ['pytest'] }, { inProcess: false }, { blockRawRunners: false }]) {
    assert.match(agentShell(project({ guard }), 'node spawn.mjs').stdout, /vitest ran/, JSON.stringify(guard));
  }
});

test('a pytest started outside tbudget is refused inside the process', { skip: !PYTEST }, () => {
  const dir = project();
  const r = agentShell(dir, 'python3 -m pytest -q test_x.py');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /tb-guard: raw pytest blocked inside the process/);
  assert.equal(agentShell(dir, 'python3 -m pytest -q test_x.py', { TBUDGET_INSIDE: '1' }).status, 0);
  assert.equal(agentShell(dir, 'python3 -m pytest --version').status, 0);
  const shadow = project({ mode: 'shadow' });
  assert.equal(agentShell(shadow, 'python3 -m pytest -q test_x.py').status, 0);
  assert.equal(records(shadow)[0].type, 'would-deny');
});

test('session starts are recorded, including the escape hatch, only in projects that use the plugin', { skip: !BASH }, () => {
  const dir = project({ mode: 'enforce' });
  const start = (env) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: dir, session_id: 's' }), env: { ...process.env, ...env } });
  start({ CLAUDE_ENV_FILE: path.join(dir, 'a.sh') });
  start({ CLAUDE_ENV_FILE: path.join(dir, 'b.sh'), TBUDGET_GUARD: 'off' });
  const starts = records(dir).filter((r) => r.type === 'session-start');
  assert.deepEqual(starts.map((r) => [r.guard, r.inProcess, r.why]), [['on', true, null], ['off', false, 'TBUDGET_GUARD=off']]);
  const plain = project();
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ cwd: plain }), env: { ...process.env, CLAUDE_ENV_FILE: path.join(plain, 'c.sh') } });
  assert.ok(!fs.existsSync(path.join(plain, '.test-budget')));
});
