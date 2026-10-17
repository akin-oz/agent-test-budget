import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globToRegExp, toPosix } from './shell.mjs';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const onPath = (name) => (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, name)));

export function detectRunner(cwd, root, policy) {
  if (policy.runner !== 'auto') return policy.runner;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg) {
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps.vitest) return 'vitest';
      if (deps.jest || pkg.jest) return 'jest';
    }
    if (['pytest.ini', 'conftest.py', 'tox.ini'].some((f) => fs.existsSync(path.join(dir, f)))) return 'pytest';
    try {
      if (/\[tool\.pytest/.test(fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8'))) return 'pytest';
    } catch { /* no pyproject */ }
    if (dir === root || path.dirname(dir) === dir) break;
  }
  return policy.generic.cmd ? 'generic' : null;
}

export function findBin(name, cwd) {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const p = path.join(dir, 'node_modules', '.bin', name);
    if (fs.existsSync(p)) return p;
    if (path.dirname(dir) === dir) return null;
  }
}

export function changedFiles(root) {
  const r = spawnSync('git', ['-C', root, 'status', '--porcelain', '-uall'], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''));
}

// Map changed python sources to the test files that conventionally cover them.
function pyTestsFor(root, files, isTest) {
  const out = new Set();
  for (const f of files.filter((x) => x.endsWith('.py'))) {
    if (isTest(f)) { out.add(f); continue; }
    const n = path.basename(f, '.py');
    for (const c of [`tests/test_${n}.py`, `test/test_${n}.py`, path.join(path.dirname(f), `test_${n}.py`), `test_${n}.py`]) {
      if (fs.existsSync(path.join(root, c))) out.add(c);
    }
  }
  return [...out].map((f) => path.join(root, f));
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

export function plan(runner, { files, all, name, policy, root, cwd, outFile }) {
  const isTest = (f) => policy.testGlobs.some((g) => globToRegExp(g).test(toPosix(f).replace(/^\.\//, '')));
  const isDir = (f) => { try { return fs.statSync(path.resolve(cwd, f)).isDirectory(); } catch { return false; } };
  // directories and pytest node ids select tests like test files do; anything else is a source file
  const tests = files.filter((f) => isTest(f) || isDir(f) || f.includes('::'));
  const srcs = files.filter((f) => !tests.includes(f));
  const bail = policy.failFast;

  if (runner === 'vitest') {
    const bin = findBin('vitest', cwd);
    let args;
    if (!files.length) args = all ? ['run'] : ['run', '--changed'];
    else if (srcs.length && !tests.length) args = ['related', ...srcs, '--run'];
    else args = ['run', ...files];
    // default reporter keeps the human log; json feeds the digest.
    args.push('--reporter=default', '--reporter=json', `--outputFile.json=${outFile}`, '--passWithNoTests', '--coverage.enabled=false');
    if (bail) args.push('--bail=1');
    if (name) args.push('-t', name);
    return { cmd: bin ?? 'npx', args: bin ? args : ['--no-install', 'vitest', ...args], report: 'json', outFile };
  }
  if (runner === 'jest') {
    const bin = findBin('jest', cwd);
    const args = [];
    if (!files.length) { if (!all) args.push('--onlyChanged'); }
    else if (srcs.length && !tests.length) args.push('--findRelatedTests', ...srcs);
    else args.push(...files);
    args.push('--json', `--outputFile=${outFile}`, '--ci', '--passWithNoTests', '--coverage=false');
    if (bail) args.push('--bail=1'); // counts failed suites: jest has no per-test bail, so one file always runs to its end
    if (name) args.push('-t', name);
    return { cmd: bin ?? 'npx', args: bin ? args : ['--no-install', 'jest', ...args], report: 'json', outFile };
  }
  if (runner === 'pytest') {
    let targets = files;
    if (srcs.length && !tests.length) {
      targets = pyTestsFor(root, srcs.map((f) => toPosix(path.relative(root, path.resolve(cwd, f)))), isTest);
      if (!targets.length) return { none: true };
    } else if (!files.length && !all) {
      targets = pyTestsFor(root, changedFiles(root), isTest);
      if (!targets.length) return { none: true };
    }
    const base = ['-q', '--tb=short', '--no-header', '-p', 'no:cacheprovider', `--junitxml=${outFile}`, ...(bail ? ['-x'] : []),
      ...(name ? ['-k', name] : []), ...targets];
    const direct = onPath('pytest');
    return {
      cmd: direct ? 'pytest' : onPath('python3') ? 'python3' : 'python',
      args: direct ? base : ['-m', 'pytest', ...base],
      report: 'junit',
      outFile,
    };
  }
  // junit and generic: one shell command from the policy. A function replacer, so `$&` in a file name stays literal.
  const tpl = runner === 'junit' ? policy.junit.cmd : policy.generic.cmd;
  const sub = { '{name}': name ? shq(name) : '', '{files}': files.map(shq).join(' '), '{report}': shq(outFile) };
  let cmd = tpl.replace(/\{name\}|\{files\}|\{report\}/g, (m) => sub[m]);
  if (!tpl.includes('{files}') && files.length) cmd = `${cmd} ${sub['{files}']}`;
  if (runner !== 'junit') return { cmd, args: [], shell: true, report: 'none', outFile };
  const reportPath = tpl.includes('{report}') ? outFile : path.resolve(root, policy.junit.report || '.');
  return { cmd, args: [], shell: true, report: 'junit-any', outFile: reportPath, since: Date.now() };
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

export function execute(p, { cwd, timeoutSec, env = {} }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const cap = 8 * 1024 * 1024;
    let out = '';
    let truncated = false;
    let timedOut = false;
    const child = spawn(p.cmd, p.args, {
      cwd,
      shell: Boolean(p.shell),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', TBUDGET_INSIDE: '1', ...env }, // INSIDE: the in-process guards let this run through
    });
    const take = (b) => { if (out.length < cap) out += b.toString('utf8'); else truncated = true; };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const killTree = () => {
      try { if (process.platform === 'win32') child.kill(); else process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutSec * 1000);
    // The runner has its own process group, so a signal to tbudget (the Bash tool timing out,
    // Ctrl-C) would not reach it: take the group down with us instead of leaving an orphan.
    const onSignal = (sig) => { killTree(); process.exit(128 + (os.constants.signals[sig] ?? 1)); };
    for (const sig of STOP_SIGNALS) process.on(sig, onSignal);
    const done = () => {
      clearTimeout(timer);
      for (const sig of STOP_SIGNALS) process.off(sig, onSignal);
    };
    child.on('error', (e) => {
      done();
      resolve({ code: 127, signal: null, timedOut, output: `${out}\n${e.message}`, truncated, ms: Date.now() - t0 });
    });
    child.on('close', (code, signal) => {
      done();
      resolve({ code, signal, timedOut, output: out, truncated, ms: Date.now() - t0 });
    });
  });
}
