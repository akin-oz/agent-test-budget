import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../lib/policy.mjs';
import { createCtx, decideBash, decideEdit } from '../lib/guard-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.join(here, '..');
const GUARD = path.join(PLUGIN, 'hooks', 'guard.mjs');

function project(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbud-'));
  fs.mkdirSync(path.join(dir, '.git'));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
}

function ctxFor(dir) {
  const { policy, root } = loadPolicy(dir);
  return createCtx({ cwd: dir, root, policy, pluginRoot: PLUGIN });
}

const PKG = JSON.stringify({
  scripts: { test: 'vitest run', check: 'tsc && npm run unit', unit: 'jest --ci', lint: 'eslint .', e2e: 'playwright test' },
});

const BLOCK = [
  'vitest', 'npx vitest run', 'npx --yes vitest@latest run', 'pnpm exec vitest', 'pnpm vitest run', 'yarn vitest',
  'bunx vitest', 'npm exec -- vitest', './node_modules/.bin/jest --watch', 'node node_modules/vitest/vitest.mjs run',
  'FOO=1 CI=true npx jest', 'time npx vitest', 'timeout 60 pytest -q', 'cd app && npx vitest',
  'bash -c "npx vitest run"', "sh -c 'cd x; jest'", 'python -m pytest', 'python3 -m pytest tests/', 'pytest -x',
  'py.test', 'uv run pytest', 'poetry run python -m pytest', 'npm test', 'npm t', 'npm run test', 'pnpm test',
  'yarn test', 'npm run check', 'npm run unit', 'npm run vitest', 'echo $(npx vitest)', 'ls | xargs echo; npx jest',
];

const ALLOW = [
  'ls -la', 'git status', 'git commit -m "fix vitest config"', 'grep -r jest src', 'cat vitest.config.ts',
  'npm install -D vitest', 'pnpm add -D jest', 'npm run lint', 'npx tsc --noEmit', 'npx vitest --version',
  'pytest --help', 'tbudget run src/a.test.ts', 'npx tbudget run', 'node bin/tbudget run', 'echo "run pytest later"',
  'npm run e2e', 'python script.py', 'python -m http.server', 'bun test', 'cat .claude/settings.json',
  'jq . .claude/settings.json > /tmp/o.json', 'ls .test-budget/.state', 'cat .test-budget/.state/last-run.log',
  'npm run lint 2>&1 | tail -5',
];

// shell syntax and wrappers an agent reaches for without thinking
const BLOCK_SYNTAX = [
  '(npx vitest run)', '{ npx vitest run; }', 'if true; then npx vitest run; fi', 'for f in a b; do npx vitest $f; done',
  'while true; do pytest; done', 'cd x && (pytest -x)', '! npx jest', 'npx vitest run &', 'nice -n 5 pytest', 'sudo -u x pytest',
  'timeout -s KILL 60 npx vitest', 'xargs -I{} npx vitest {}', 'echo a | xargs pytest', 'find . -name "*.test.ts" -exec npx vitest run {} \\;',
  'watch -n1 pytest', 'watch "pytest -x"', 'coverage run -m pytest', 'python -m coverage run -m pytest', 'case $x in a) npx vitest;; esac',
];
const ALLOW_SYNTAX = [
  '(cd x && ls)', 'if [ -f x ]; then echo hi; fi', 'for f in a b; do echo $f; done', 'nice -n 5 ls', 'sudo -u x ls', 'xargs echo',
  'find . -name "*.ts"', 'find . -name x -exec cat {} \\;', 'watch -n1 date', 'coverage report', 'make build', 'cat run-tests.sh', 'just build',
];
// scripts, Makefile and justfile recipes that wrap a runner
const WRAPPED = {
  'run-tests.sh': '#!/usr/bin/env bash\nset -e\n# run everything\nnpx vitest run "$@"\n',
  'ci.sh': '#!/bin/sh\n./run-tests.sh\n',
  'build.sh': '#!/bin/sh\necho build\n',
  'loop.sh': '#!/bin/sh\nsource ./loop.sh\n',
  Makefile: 'VITEST = npx vitest\n.PHONY: test build\ntest: build\n\t@$(VITEST) run\nbuild:\n\techo build\nlint:\n\techo lint\n',
  justfile: 'build:\n  echo build\ntest: build\n  pytest -x\n',
};
const BLOCK_WRAPPED = [
  'bash run-tests.sh', 'sh ./run-tests.sh', './run-tests.sh', 'source run-tests.sh', '. ./run-tests.sh', 'bash ci.sh', 'sh -c "./run-tests.sh"',
  'make test', 'make', 'make -C . test', 'make -j4 test', 'just test', 'cd sub && bash ../run-tests.sh',
];
const ALLOW_WRAPPED = ['bash build.sh', './build.sh', 'make build', 'make lint', 'just build', 'bash loop.sh', 'bash missing.sh', './missing.sh'];

test('raw test runners are blocked in every common spelling', () => {
  const ctx = ctxFor(project({ 'package.json': PKG }));
  for (const cmd of [...BLOCK, ...BLOCK_SYNTAX]) assert.equal(decideBash(cmd, ctx)?.rule, 'raw-runner', cmd);
});

test('unrelated commands and the tbudget CLI are left alone', () => {
  const ctx = ctxFor(project({ 'package.json': PKG }));
  for (const cmd of [...ALLOW, ...ALLOW_SYNTAX]) assert.equal(decideBash(cmd, ctx), null, cmd);
});

test('scripts, Makefile and justfile recipes that wrap a runner are blocked, harmless ones are not', () => {
  const dir = project(WRAPPED);
  fs.mkdirSync(path.join(dir, 'sub'));
  const fresh = () => createCtx({ cwd: dir, root: dir, policy: ctxFor(dir).policy, pluginRoot: PLUGIN });
  for (const cmd of BLOCK_WRAPPED) {
    const cwdCtx = cmd.startsWith('cd sub') ? createCtx({ cwd: path.join(dir, 'sub'), root: dir, policy: ctxFor(dir).policy, pluginRoot: PLUGIN }) : fresh();
    assert.equal(decideBash(cmd.replace(/^cd sub && /, ''), cwdCtx)?.rule, 'raw-runner', cmd);
  }
  for (const cmd of ALLOW_WRAPPED) assert.equal(decideBash(cmd, fresh()), null, cmd);
  assert.match(decideBash('make test', fresh()).reason, /make test .*-> vitest/);
});

test('tbudget reset hidden in a script is still human-only', () => {
  const dir = project({ 'fix.sh': '#!/bin/sh\ntbudget reset\n' });
  assert.equal(decideBash('bash fix.sh', ctxFor(dir))?.rule, 'tb-reset');
});

test('policy.guard.blockPatterns adds project-specific commands', () => {
  const dir = project({ '.test-budget/policy.json': JSON.stringify({ guard: { blockPatterns: ['^go test', '^turbo (run )?test'] } }) });
  const ctx = ctxFor(dir);
  for (const cmd of ['go test ./...', 'FOO=1 go test', 'turbo run test', 'bash -c "go test ./..."', 'cd x && turbo test']) {
    assert.equal(decideBash(cmd, ctx)?.rule, 'raw-runner', cmd);
  }
  for (const cmd of ['go build ./...', 'echo go test', 'turbo build']) assert.equal(decideBash(cmd, ctx), null, cmd);
  const bad = project({ '.test-budget/policy.json': JSON.stringify({ guard: { blockPatterns: ['('] } }) });
  assert.match(loadPolicy(bad).problems.join(), /invalid regex/);
});

test('tbudget reset is human-only', () => {
  const ctx = ctxFor(project());
  for (const cmd of ['tbudget reset', 'npx tbudget reset', 'cd x && tbudget reset']) {
    assert.equal(decideBash(cmd, ctx)?.rule, 'tb-reset', cmd);
  }
});

test('shell edits to policy, state and hook config are blocked', () => {
  const ctx = ctxFor(project());
  const bad = [
    'echo x > .test-budget/policy.json', 'sed -i s/3/99/ .test-budget/policy.json', 'rm -rf .test-budget',
    'tee .claude/settings.json', 'echo hi | tee -a .claude/settings.local.json', 'mv x .test-budget/policy.json',
  ];
  for (const cmd of bad) assert.equal(decideBash(cmd, ctx)?.rule, 'protected', cmd);
});

// monorepo: the root has no test script, the workspace package does
const MONO = {
  'package.json': JSON.stringify({ workspaces: ['packages/*'], scripts: { build: 'tsc -b', lint: 'eslint .' } }),
  'packages/app/package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run', build: 'tsc', lint: 'eslint .' } }),
};
const BLOCK_MONO = [
  'pnpm --filter app test', 'pnpm -F app test', 'pnpm --filter=app test', 'pnpm --filter app run test', 'pnpm -r test',
  'pnpm --recursive run test', 'pnpm --filter app exec vitest', 'npm -w packages/app test', 'npm test -w packages/app',
  'npm run test --workspace=packages/app', 'npm --workspaces test', 'npm --prefix packages/app test', 'npm -C packages/app test',
  'pnpm -C packages/app test', 'pnpm --dir packages/app test', 'yarn --cwd packages/app test', 'yarn workspace app test',
  'yarn workspace app run test', 'yarn workspaces foreach -A run test', 'yarn workspaces foreach --include app run test',
  'yarn workspaces run test', 'bun run --filter app test',
];
const ALLOW_MONO = [
  'pnpm --filter app build', 'pnpm -F app lint', 'pnpm -r build', 'npm -w packages/app run lint', 'npm --prefix packages/app install',
  'pnpm --filter app add -D vitest', 'yarn workspace app build', 'yarn workspaces foreach -A run build', 'pnpm -C packages/app build',
  'pnpm vitest --version', 'npm test', 'npm run build',
];

test('package-manager options that take a value do not hide the subcommand (monorepos)', () => {
  const ctx = ctxFor(project(MONO));
  for (const cmd of BLOCK_MONO) assert.equal(decideBash(cmd, ctx)?.rule, 'raw-runner', cmd);
  for (const cmd of ALLOW_MONO) assert.equal(decideBash(cmd, ctx), null, cmd);
  assert.match(decideBash('pnpm --filter app test', ctx).reason, /workspaces.*-> vitest/);
});

test('backslash-newline line continuations are joined before analysis', () => {
  const ctx = ctxFor(project(MONO));
  for (const cmd of ['npx \\\nvitest run', 'npx \\\r\n  vitest run', 'pnpm \\\n  --filter app \\\n  test', 'echo $(npx \\\nvitest)']) {
    assert.equal(decideBash(cmd, ctx)?.rule, 'raw-runner', JSON.stringify(cmd));
  }
  assert.equal(decideBash('ls \\\n  -la', ctx), null);
});

test('state and policy cannot be wiped through cd, globs, git clean or a case variant', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, 'src'));
  const ctx = ctxFor(dir);
  const bad = [
    'cd .test-budget && rm -rf .state', 'cd .test-budget; rm -rf .state/state.json', 'pushd .test-budget && echo {} > policy.json',
    'cd src && rm -rf ../.test-budget/.state', 'cd .claude && echo {} > settings.json', 'rm -rf .test-b*', 'rm -rf .t*',
    'rm -rf .test-budget/.s*', 'rm -rf .test-budget/{.state,x}', 'rm -rf .test-budget/.stat?', `rm -rf ${dir}/.test-b*`, 'mv .claude /tmp/c',
    'git clean -fdX', 'git clean -xfd', 'git clean -f -d -x', 'git -C . clean -fdx', 'git clean -fd .test-budget', 'git stash -a',
    'git stash push --all', 'git stash push .test-budget/policy.json',
    'rm -rf .TEST-BUDGET/.state', 'echo {} > .Test-Budget/policy.json', 'sed -i s/3/99/ .TEST-BUDGET/POLICY.JSON', 'tee .CLAUDE/settings.json',
  ];
  for (const cmd of bad) assert.equal(decideBash(cmd, ctx)?.rule, 'protected', cmd);
  assert.match(decideBash('git clean -fdX', ctx).reason, /-e \.test-budget/);
  const ok = [
    'git clean -fdX -e .test-budget', 'git clean -fdx --exclude=.test-budget/', 'git clean -fd', 'git clean -ndX', 'git stash',
    'rm -rf *', 'rm -rf src/*.tmp', 'cp -r . /tmp/backup', 'cd .test-budget && ls .state', 'cat .TEST-BUDGET/policy.json',
    'cd src && rm -rf build', 'jq . .claude/settings.json > /tmp/o.json', 'npm run lint 2>&1 | tail -5',
  ];
  for (const cmd of ok) assert.equal(decideBash(cmd, ctx), null, cmd);
});

test('edits: protected paths match case-insensitively', () => {
  const dir = project();
  const ctx = ctxFor(dir);
  for (const f of ['.TEST-BUDGET/policy.json', '.Test-Budget/.State/state.json', '.Claude/Settings.json', path.join(dir, '.CLAUDE/settings.local.json')]) {
    assert.equal(decideEdit('Write', { file_path: f, content: '{}' }, ctx)?.rule, 'protected', f);
  }
  assert.equal(decideEdit('Write', { file_path: path.join(PLUGIN.toUpperCase(), 'lib/policy.mjs'), content: 'x' }, ctx)?.rule, 'protected');
  assert.equal(decideEdit('Write', { file_path: '.test-budget-notes.md', content: 'x' }, ctx), null);
});

const BLOCK_INDIRECT = [
  "$'vitest' run", '$"vitest" run', 'R=vitest; npx $R run', 'export R=vitest && npx $R run', 'C="npx vitest"; $C run',
  'x=npx; ${x} vitest run', '$RUNNER vitest run', '$(echo npx) vitest run', '`which npx` vitest', 'cat <(npx vitest run)',
  'diff <(pytest -q) /dev/null', 'tee >(npx jest) < /dev/null', 'echo $( (npx vitest run) )', 'echo "$(npx vitest run)"',
  'echo $(echo $(npx jest))', 'out=$(npx vitest run)', 'echo $(a; npx vitest run)',
];
const ALLOW_INDIRECT = [
  "echo 'npx vitest' $(date)", 'R=vitest; echo $R', 'echo $((1 + 2))', 'x=1; ls $x', '$EDITOR notes.md', "echo '$(npx vitest)'",
  'git log -1 $(git rev-parse HEAD)', 'diff <(ls a) <(ls b)',
];

test('variables, $(...), backticks and process substitution do not hide a runner', () => {
  const ctx = ctxFor(project({ 'package.json': PKG }));
  for (const cmd of BLOCK_INDIRECT) assert.equal(decideBash(cmd, ctx)?.rule, 'raw-runner', cmd);
  for (const cmd of ALLOW_INDIRECT) assert.equal(decideBash(cmd, ctx), null, cmd);
});

const BLOCK_LAUNCH = [
  'uvx pytest', 'uvx --from pytest==8 pytest', 'uvx pytest@8 -x', 'pipx run pytest', 'pipx run --spec pytest pytest',
  'uv run --with pytest-cov pytest', 'hatch test', 'script -q /dev/null npx vitest run', 'script -qc "npx vitest run" /dev/null',
  'caffeinate -i npx vitest run', 'doas -u ci pytest', 'unbuffer npx jest', 'chronic pytest -x', 'cross-env CI=1 vitest run',
  'npx cross-env NODE_ENV=test jest', 'dotenv -e .env.test -- npx vitest run', 'xvfb-run -a npx jest',
];
const ALLOW_LAUNCH = [
  'uvx ruff check', 'pipx run black .', 'hatch build', 'uv run python script.py', 'script -q /dev/null ls', 'caffeinate -i ls',
  'cross-env CI=1 tsc', 'tox', 'nox',
];

test('python launchers and command wrappers are followed to the runner', () => {
  const ctx = ctxFor(project({ 'package.json': PKG }));
  for (const cmd of BLOCK_LAUNCH) assert.equal(decideBash(cmd, ctx)?.rule, 'raw-runner', cmd);
  for (const cmd of ALLOW_LAUNCH) assert.equal(decideBash(cmd, ctx), null, cmd); // no tox/nox config here
});

test('tox and nox are blocked when their config runs pytest', () => {
  const ctx = ctxFor(project({
    'tox.ini': '[testenv]\ndeps = pytest\ncommands = pytest {posargs}\n',
    'noxfile.py': 'import nox\n@nox.session\ndef tests(session):\n    session.run("pytest")\n',
  }));
  for (const cmd of ['tox', 'tox -e py312', 'tox run -e py312', 'nox', 'nox -s tests']) assert.equal(decideBash(cmd, ctx)?.rule, 'raw-runner', cmd);
  for (const cmd of ['tox -l', 'tox --version', 'nox --list', 'nox -l']) assert.equal(decideBash(cmd, ctx), null, cmd);
});

test('the plugin cannot be disabled and the guard escape hatch cannot be set by the agent', () => {
  const ctx = ctxFor(project());
  const bad = [
    'claude plugin disable agent-test-budget@agent-test-budget', 'claude plugin disable agent-test-budget@agent-test-budget --scope project',
    'claude plugin uninstall agent-test-budget', 'claude plugins remove agent-test-budget@agent-test-budget',
    'claude plugin marketplace remove agent-test-budget', 'TBUDGET_GUARD=off claude -p "run the tests"', 'export TBUDGET_GUARD=off',
    'env TBUDGET_GUARD=off claude', 'env -i TBUDGET_GUARD=off claude -p x', 'cd x && TBUDGET_GUARD=off claude',
  ];
  for (const cmd of bad) assert.equal(decideBash(cmd, ctx)?.rule, 'protected', cmd);
  const ok = [
    'claude plugin list', 'claude plugin disable other-plugin', 'claude plugin install agent-test-budget@agent-test-budget', 'claude --version',
    'git commit -m "document TBUDGET_GUARD=off"', 'echo TBUDGET_GUARD=off', 'grep TBUDGET_GUARD README.md',
  ];
  for (const cmd of ok) assert.equal(decideBash(cmd, ctx), null, cmd);
});

test('with runner junit/generic the configured command itself is blocked when run raw', () => {
  const go = ctxFor(project({ '.test-budget/policy.json': JSON.stringify({ runner: 'generic', generic: { cmd: 'go test ./... {files}' } }) }));
  for (const cmd of ['go test ./...', 'go test -run TestX ./pkg', 'cd pkg && go test .', 'bash -c "go test ./..."']) assert.equal(decideBash(cmd, go)?.rule, 'raw-runner', cmd);
  for (const cmd of ['go build ./...', 'go testing', 'go vet ./...']) assert.equal(decideBash(cmd, go), null, cmd);
  assert.match(decideBash('go test ./...', go).reason, /policy\.generic\.cmd/);
  const gradle = ctxFor(project({ '.test-budget/policy.json': JSON.stringify({ runner: 'junit', junit: { cmd: './gradlew test {name}', report: 'build/test-results' } }) }));
  assert.equal(decideBash('./gradlew test --tests Foo', gradle)?.rule, 'raw-runner');
  assert.equal(decideBash('./gradlew build', gradle), null);
  const off = ctxFor(project({ '.test-budget/policy.json': JSON.stringify({ runner: 'generic', generic: { cmd: 'go test ./...' }, guard: { blockRunnerCmd: false } }) }));
  assert.equal(decideBash('go test ./...', off), null);
});

test('here-documents: a message or file body is data, a script fed to a shell is not', () => {
  const ctx = ctxFor(project({ 'package.json': PKG }));
  const allow = [
    "git commit -m \"$(cat <<'EOF'\nRun tests with tbudget, not npx vitest run\n\n- `pytest -x` is blocked too\nnpm test\nEOF\n)\"",
    "cat > notes.md <<'EOF'\n- `uv run --frozen pytest` when there is a uv.lock\nnpx jest\nEOF",
    "python3 - <<'EOF'\nprint('pytest')\nEOF",
    'cat <<EOF\nplain text that mentions pytest and npm test\nEOF',
    "cat <<-'EOF'\n\tnpx vitest\n\tEOF",
  ];
  for (const cmd of allow) assert.equal(decideBash(cmd, ctx), null, cmd);
  const block = [
    "bash <<'EOF'\nnpx vitest run\nEOF",
    'sh -s <<EOF\npytest -x\nEOF',
    'cat <<EOF\n$(npx vitest run)\nEOF', // unquoted: the substitution runs
    'echo "a << b"\nnpx vitest run', // `<<` inside quotes is not a here-document
    "cat <<'EOF' > x.txt\nhello\nEOF\nnpx vitest run", // after the body, commands again
  ];
  for (const cmd of block) assert.equal(decideBash(cmd, ctx)?.rule, 'raw-runner', cmd);
  assert.equal(decideBash("cat > .test-budget/policy.json <<'EOF'\n{}\nEOF", ctx)?.rule, 'protected');
});

test('policy can switch raw-runner blocking off', () => {
  const dir = project({ '.test-budget/policy.json': JSON.stringify({ guard: { blockRawRunners: false } }) });
  assert.equal(decideBash('npx vitest', ctxFor(dir)), null);
});

test('enforce list limits which runners are blocked', () => {
  const dir = project({ '.test-budget/policy.json': JSON.stringify({ guard: { enforce: ['jest'] } }) });
  const ctx = ctxFor(dir);
  assert.equal(decideBash('npx vitest', ctx), null);
  assert.equal(decideBash('npx jest', ctx)?.rule, 'raw-runner');
});

test('edits: protected paths and the plugin itself', () => {
  const dir = project();
  const ctx = ctxFor(dir);
  assert.equal(decideEdit('Write', { file_path: '.test-budget/policy.json', content: '{}' }, ctx)?.rule, 'protected');
  assert.equal(decideEdit('Edit', { file_path: path.join(dir, '.claude/settings.json') }, ctx)?.rule, 'protected');
  assert.equal(decideEdit('Write', { file_path: path.join(PLUGIN, 'lib/policy.mjs'), content: 'x' }, ctx)?.rule, 'protected');
  assert.equal(decideEdit('Write', { file_path: '.test-budget/.state/state.json', content: '{}' }, ctx)?.rule, 'protected');
  assert.equal(decideEdit('Write', { file_path: '/etc/hosts', content: 'x' }, ctx), null);
});

test('edits: whole-file rewrite of an existing test is denied, new content is not', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `  it('case ${i}', () => { expect(f(${i})).toBe(${i}); });`);
  const dir = project({ 'src/a.test.ts': lines.join('\n'), 'src/b.ts': lines.join('\n'), 'src/tiny.test.ts': 'it("x", () => {});\n' });
  const ctx = ctxFor(dir);
  const tweaked = lines.map((l, i) => (i === 7 ? '  it("case 7 fixed", () => {});' : l)).join('\n');
  assert.equal(decideEdit('Write', { file_path: 'src/a.test.ts', content: tweaked }, ctx)?.rule, 'rewrite');
  const different = Array.from({ length: 60 }, (_, i) => `  test('other ${i}', () => { assert(${i}); });`).join('\n');
  assert.equal(decideEdit('Write', { file_path: 'src/a.test.ts', content: different }, ctx), null);
  assert.equal(decideEdit('Write', { file_path: 'src/new.test.ts', content: tweaked }, ctx), null);
  assert.equal(decideEdit('Write', { file_path: 'src/tiny.test.ts', content: 'it("x", () => {});\n' }, ctx), null);
  assert.equal(decideEdit('Write', { file_path: 'src/b.ts', content: tweaked }, ctx), null);
  assert.equal(decideEdit('Edit', { file_path: 'src/a.test.ts', old_string: 'a', new_string: 'b' }, ctx), null);
});

function runGuard(dir, payload, env = {}) {
  return spawnSync(process.execPath, [GUARD], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}
const bash = (dir, command) => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: dir });

test('hook process: deny JSON on stdout, exit 0, audit record written', () => {
  const dir = project({ 'package.json': PKG });
  const r = runGuard(dir, bash(dir, 'npx vitest run'));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'PreToolUse');
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /tbudget run/);
  assert.match(fs.readFileSync(path.join(dir, '.test-budget/.state/runs.jsonl'), 'utf8'), /"rule":"raw-runner"/);
});

test('hook process: silent for allowed commands, bad payloads and the human escape hatch', () => {
  const dir = project({ 'package.json': PKG });
  for (const r of [
    runGuard(dir, bash(dir, 'git status')),
    runGuard(dir, 'not json'),
    runGuard(dir, ''),
    runGuard(dir, bash(dir, 'npx vitest'), { TBUDGET_GUARD: 'off' }),
  ]) {
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

test('hook process: internal error fails closed on test commands, open on everything else', () => {
  const dir = project();
  const env = { TBUDGET_SELFTEST_THROW: '1' };
  assert.equal(JSON.parse(runGuard(dir, bash(dir, 'npx vitest'), env).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(runGuard(dir, bash(dir, 'ls'), env).stdout, '');
  assert.match(fs.readFileSync(path.join(dir, '.test-budget/.state/errors.log'), 'utf8'), /selftest/);
});

test('hook process: file edits go through the same guard', () => {
  const dir = project();
  const r = runGuard(dir, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '.claude/settings.json' }, cwd: dir });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

const SHADOW = JSON.stringify({ mode: 'shadow' });
const records = (dir) => fs.readFileSync(path.join(dir, '.test-budget/.state/runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('shadow mode: the hook denies nothing and records would-deny with the command', () => {
  const dir = project({ 'package.json': PKG, '.test-budget/policy.json': SHADOW });
  const long = `npx vitest run ${'x'.repeat(300)}`;
  for (const p of [
    bash(dir, long),
    bash(dir, 'rm -rf .test-budget/.state'),
    { ...bash(dir, 'npm test'), agent_type: 'test-writer' },
    { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '.claude/settings.json' }, cwd: dir },
  ]) {
    const r = runGuard(dir, p);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
  const recs = records(dir);
  assert.deepEqual(recs.map((r) => [r.type, r.rule, r.tool, r.agent]), [
    ['would-deny', 'raw-runner', 'Bash', 'main'],
    ['would-deny', 'protected', 'Bash', 'main'],
    ['would-deny', 'raw-runner', 'Bash', 'test-writer'],
    ['would-deny', 'protected', 'Edit', 'main'],
  ]);
  assert.equal(recs[0].command, long.slice(0, 200));
  assert.equal(recs[3].command, '.claude/settings.json');
  assert.ok(!recs.some((r) => r.type === 'deny'));
});

test('shadow mode: an internal error on a test command is recorded, not denied', () => {
  const dir = project({ '.test-budget/policy.json': SHADOW });
  const r = runGuard(dir, bash(dir, 'npx vitest'), { TBUDGET_SELFTEST_THROW: '1' });
  assert.equal(r.stdout, '');
  assert.equal(records(dir).at(-1).rule, 'internal-error');
});

test('mode: an unknown value falls back to enforce and is reported', () => {
  const dir = project({ '.test-budget/policy.json': JSON.stringify({ mode: 'shadwo' }) });
  const { policy, problems } = loadPolicy(dir);
  assert.equal(policy.mode, 'enforce');
  assert.match(problems.join('\n'), /mode must be "enforce" or "shadow"/);
  assert.equal(JSON.parse(runGuard(dir, bash(dir, 'npx vitest')).stdout).hookSpecificOutput.permissionDecision, 'deny');
});
