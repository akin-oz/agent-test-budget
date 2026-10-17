import fs from 'node:fs';
import path from 'node:path';
import { splitSegments, tokenize, substitutions, globToRegExp, toPosix } from './shell.mjs';

export const BIN = 'tbudget';
const ALIASES = { vitest: 'vitest', jest: 'jest', pytest: 'pytest', 'py.test': 'pytest' };
const WRAPPERS = new Set(['env', 'time', 'nice', 'nohup', 'command', 'exec', 'sudo', 'builtin', 'stdbuf', 'setsid', 'ionice',
  'doas', 'caffeinate', 'unbuffer', 'chronic', 'cross-env', 'dotenv', 'xvfb-run']);
// options of a wrapper that consume the next token
const WRAPPER_ARGS = {
  nice: ['-n', '--adjustment'], ionice: ['-c', '-n', '-p'], env: ['-u', '-C', '-S'], exec: ['-a'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group'],
  timeout: ['-s', '-k', '--signal', '--kill-after'], time: ['-f', '-o', '--format', '--output'],
  doas: ['-u', '-C'], caffeinate: ['-t', '-w'], dotenv: ['-e', '-c', '-v'],
  'xvfb-run': ['-n', '-s', '-f', '-e', '-p', '--server-num', '--server-args', '--auth-file', '--error-file'],
};
// options of `uvx`, `uv run`, `pipx run` and friends that consume the next token
const PY_RUN_ARGS = new Set(['--from', '--with', '--with-editable', '--with-requirements', '-p', '--python', '--package', '--project',
  '--directory', '--env-file', '--extra', '--group', '--index', '--index-url', '--default-index', '--extra-index-url', '--spec', '--pip-args']);
const SCRIPT_ARGS = new Set(['-t', '-T', '-F', '-B', '-E', '-I', '-O']);
const TOX_INFO = new Set(['-l', '--listenvs', '-a', '--listenvs-all', '--list', '--list-sessions', '--version', '--help', '-h']);
// words that can precede a command inside compound statements: `if x; then CMD`, `do CMD`, `! CMD`
const LEADING = new Set(['(', '{', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'coproc']);
const XARGS_ARGS = new Set(['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a', '-J']);
const PKG_MGRS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PY_LAUNCHERS = new Set(['uv', 'poetry', 'pipenv', 'hatch', 'pdm', 'rye', 'pipx']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const INFO_FLAGS = new Set(['--version', '--help', '-h']);
const SCRIPT_MAX = 256 * 1024;

const base = (t) => path.basename(t ?? '');
const stripExt = (t) => base(t).replace(/\.(c|m)?js$|\.cmd$|\.exe$/, '');
const isDashC = (t) => /^-[a-z]*c[a-z]*$/.test(t);

function runnerOf(name) {
  if (!name) return null;
  return ALIASES[stripExt(name).replace(/@[^/@]*$/, '')] ?? null;
}

function dropOpts(a, withArg = new Set()) {
  let i = 0;
  while (i < a.length && a[i].startsWith('-') && a[i] !== '--') i += withArg.has(a[i]) ? 2 : 1;
  if (a[i] === '--') i++;
  return a.slice(i);
}
const dropFlags = (a) => dropOpts(a);

// `(npx x)`, `{ x; }`, `if c; then x`, `! x`, `a) x` -> the command itself
function unwrap(toks) {
  const t = [...toks];
  for (let n = 0; n < 8 && t.length; n++) {
    if (t[0] === 'case') { // case $x in a) CMD
      const j = t.findIndex((x, k) => k > t.indexOf('in') && x.endsWith(')'));
      if (t.includes('in') && j >= 0) { t.splice(0, j + 1); continue; }
    }
    if (LEADING.has(t[0])) { t.shift(); continue; }
    const m = /^[({]+(.+)$/.exec(t[0]);
    if (m) { t[0] = m[1]; continue; }
    if (t.length > 1 && /^[^\s()]+\)$/.test(t[0])) { t.shift(); continue; }
    break;
  }
  if (t.length) t[t.length - 1] = t[t.length - 1].replace(/[)}]+$/, '');
  return t.filter((x, i) => x !== '' || i < t.length - 1);
}

function skipWrappers(toks) {
  let i = 0;
  for (;;) {
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
    const t = toks[i];
    if (!t) break;
    const b = base(t);
    if (!WRAPPERS.has(b) && b !== 'timeout') break;
    i++;
    const takesArg = new Set(WRAPPER_ARGS[b] ?? []);
    while (i < toks.length && toks[i].startsWith('-')) i += takesArg.has(toks[i]) ? 2 : 1;
    if (b === 'timeout') i++; // the duration
  }
  return toks.slice(i);
}

function readScripts(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {}; } catch { /* keep walking */ }
    const up = path.dirname(dir);
    if (up === dir) return {};
    dir = up;
  }
}

const hit = (runner, args, via, ctx) =>
  !runner || !ctx.enforce.has(runner) || args.some((a) => INFO_FLAGS.has(a)) ? [] : [{ block: runner, via }];

const withVia = (hits, via) => hits.map((f) => (f.block ? { ...f, via: `${via} -> ${f.block}` } : f));

function scriptHit(name, via, ctx, depth, scope = null) {
  if (depth > 3) return [];
  const bodies = scriptMaps(scope, ctx).map((m) => m[name]).filter((b) => typeof b === 'string');
  if (!bodies.length) return hit(runnerOf(name), [], via, ctx); // `npm run vitest` runs the bin
  return withVia(bodies.flatMap((b) => analyzeCommand(b, ctx, depth + 1)), via);
}

// ---- local shell scripts, Makefile and justfile recipes -------------------------------------
const commandLines = (text) => text.replace(/\\\r?\n/g, ' ').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

function readText(abs, shellOnly) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > SCRIPT_MAX) return null;
    const text = fs.readFileSync(abs, 'utf8');
    if (shellOnly && !/\.(sh|bash|zsh)$/.test(abs) && !/^#!.*\b(?:ba|z|da|k)?sh\b/.test(text.slice(0, 120))) return null;
    return text;
  } catch { return null; }
}

function scriptHits(file, ctx, depth, shellOnly) {
  if (!file || depth > 3) return [];
  const abs = path.resolve(ctx.cwd, file);
  if (ctx.stack.has(abs)) return []; // a script that sources itself
  const text = readText(abs, shellOnly);
  if (text === null) return [];
  ctx.stack.add(abs);
  try {
    return withVia(commandLines(text).flatMap((l) => analyzeCommand(l, ctx, depth + 1)), base(file));
  } finally {
    ctx.stack.delete(abs);
  }
}

function parseRules(text, style) {
  const vars = { MAKE: 'make' };
  const rules = {};
  const order = [];
  let cur = [];
  for (const raw of text.replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const body = style === 'make' ? raw.startsWith('\t') : /^\s+\S/.test(raw);
    if (body) {
      for (const r of cur) r.recipe.push(line.trim().replace(/^[@+-]+\s*/, ''));
      continue;
    }
    const asg = /^([A-Za-z_][\w.]*)\s*(?:[:?+]?=)\s*(.*)$/.exec(line);
    if (asg) { vars[asg[1]] = asg[2]; cur = []; continue; }
    const m = /^@?([^\s:=#][^:=#]*?)\s*:(?!=)\s*([^#]*)$/.exec(line);
    if (!m) { cur = []; continue; }
    const names = style === 'just' ? [m[1].split(/\s+/)[0]] : m[1].trim().split(/\s+/);
    const prereqs = m[2].trim().split(/\s+/).filter(Boolean);
    cur = names.map((n) => (rules[n] ??= { prereqs, recipe: [] }));
    order.push(...names);
  }
  return { rules, vars, first: order.find((n) => !n.startsWith('.')) };
}

const expand = (s, vars) => s.replace(/\$[({]([A-Za-z_][\w.]*)[)}]/g, (m, k) => vars[k] ?? m);

function walkRules(parsed, targets, ctx, depth, via) {
  const out = [];
  const seen = new Set();
  const visit = (name, d) => {
    if (seen.has(name) || d > 4 || !parsed.rules[name]) return;
    seen.add(name);
    for (const p of parsed.rules[name].prereqs) visit(p, d + 1);
    for (const line of parsed.rules[name].recipe) {
      out.push(...withVia(analyzeCommand(expand(expand(line, parsed.vars), parsed.vars), ctx, depth + 1), `${via} ${name}`));
    }
  };
  for (const t of targets.length ? targets : [parsed.first]) if (t) visit(t, 0);
  return out;
}

function makeHits(args, ctx, depth) {
  if (depth > 3) return [];
  let file = null;
  let dir = ctx.cwd;
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f' || a === '--file' || a === '--makefile') file = args[++i];
    else if (a === '-C' || a === '--directory') dir = path.resolve(ctx.cwd, args[++i] ?? '.');
    else if (a === '-j' && /^\d+$/.test(args[i + 1] ?? '')) i++;
    else if (!a.startsWith('-') && !a.includes('=')) targets.push(a);
  }
  const mf = file ? path.resolve(dir, file) : ['GNUmakefile', 'makefile', 'Makefile'].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
  if (!mf) return [];
  try {
    const text = fs.readFileSync(mf, 'utf8');
    return text.length > SCRIPT_MAX ? [] : walkRules(parseRules(text, 'make'), targets, ctx, depth, 'make');
  } catch { return []; }
}

function justHits(args, ctx, depth) {
  if (depth > 3) return [];
  const jf = ['justfile', 'Justfile', '.justfile'].map((n) => path.join(ctx.cwd, n)).find((p) => fs.existsSync(p));
  if (!jf) return [];
  try {
    const text = fs.readFileSync(jf, 'utf8');
    return text.length > SCRIPT_MAX ? [] : walkRules(parseRules(text, 'just'), args.filter((a) => !a.startsWith('-')).slice(0, 1), ctx, depth, 'just');
  } catch { return []; }
}

const coverageHits = (args, ctx) => {
  const j = args.indexOf('-m');
  return j >= 0 ? hit(runnerOf(args[j + 1]), args, `coverage run -m ${args[j + 1]}`, ctx) : [];
};

// ---- package managers ------------------------------------------------------------------------
// options that consume the next token (`pnpm --filter app test`: "app" is not the subcommand)
const PM_VALUE = {
  npm: ['--prefix', '-C', '-w', '--workspace', '--userconfig', '--cache', '--registry', '--loglevel', '--include', '--omit'],
  pnpm: ['--filter', '-F', '--filter-prod', '-C', '--dir', '--reporter', '--loglevel', '--workspace-concurrency', '--test-pattern', '--changed-files-ignore-pattern'],
  yarn: ['--cwd', '--mutex', '--cache-folder', '--modules-folder', '--network-timeout'],
  bun: ['--cwd', '--filter', '-F'],
};
const PM_DIR = new Set(['--prefix', '-C', '--dir', '--cwd']);
// options that run the script in other workspace packages, whose package.json we cannot pin down
const PM_WS = {
  npm: ['-w', '--workspace', '--workspaces', '-ws'],
  pnpm: ['--filter', '-F', '--filter-prod', '-r', '--recursive'],
  yarn: [],
  bun: ['--filter', '-F'],
};
const FOREACH_VALUE = new Set(['--include', '--exclude', '--from', '-j', '--jobs', '--since']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo', '.venv', 'venv']);

// npm parses its options anywhere before `--`; collect them and the positional words
function pmParse(mgr, args) {
  const takes = new Set(PM_VALUE[mgr]);
  const ws = new Set(PM_WS[mgr]);
  const o = { pos: [], idx: [], dir: null, ws: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (!a.startsWith('-') || a === '-') { o.pos.push(a); o.idx.push(i); continue; }
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    const value = inline ?? (takes.has(flag) ? args[++i] : null);
    if (ws.has(flag)) o.ws = true;
    if (PM_DIR.has(flag) && value) o.dir = value;
    if (mgr === 'pnpm' && (flag === '-w' || flag === '--workspace-root')) o.dir = '<root>';
  }
  return o;
}

// script maps the command could read: one directory, or every package.json in the workspace
function scriptMaps(scope, ctx) {
  if (!scope) return [ctx.scripts()];
  if (scope.dir) {
    const dir = scope.dir === '<root>' ? ctx.root : path.resolve(ctx.cwd, scope.dir);
    return [readScripts(dir)];
  }
  ctx.wsScripts ??= (() => {
    const maps = [];
    const walk = (dir, d) => {
      if (d > 3 || maps.length >= 200) return;
      try { maps.push(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {}); } catch { /* no package here */ }
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), d + 1);
    };
    walk(ctx.root, 0);
    return maps;
  })();
  return [ctx.scripts(), ...ctx.wsScripts];
}

function analyzePkgMgr(mgr, args, ctx, depth, scope = null) {
  const o = pmParse(mgr, args);
  const sub = o.pos[0];
  if (!sub) return [];
  const sc = o.ws ? { ws: true } : o.dir ? { dir: o.dir } : scope;
  const tag = o.ws || o.dir ? `${mgr} (${o.ws ? 'workspaces' : o.dir})` : mgr;
  if (['exec', 'dlx', 'x'].includes(sub)) {
    const r = dropFlags(args.slice(o.idx[0] + 1));
    if (base(r[0]) === BIN) return [{ tb: r[1] ?? 'help' }];
    return hit(runnerOf(r[0]), r, `${mgr} ${sub} ${r[0] ?? ''}`.trim(), ctx);
  }
  if (mgr === 'yarn' && sub === 'workspace' && o.pos[1]) { // yarn workspace <name> <command...>
    return analyzePkgMgr(mgr, args.slice(o.idx[1] + 1), ctx, depth, { ws: true });
  }
  if (mgr === 'yarn' && sub === 'workspaces') {
    if (o.pos[1] === 'foreach') return analyzePkgMgr(mgr, dropOpts(args.slice(o.idx[1] + 1), FOREACH_VALUE), ctx, depth, { ws: true });
    if (o.pos[1] === 'run' && o.pos[2]) return scriptHit(o.pos[2], 'yarn workspaces run', ctx, depth, { ws: true });
    return [];
  }
  if (['test', 't', 'tst'].includes(sub) && mgr !== 'bun') return scriptHit('test', `${tag} ${sub}`, ctx, depth, sc);
  if (['run', 'run-script'].includes(sub)) {
    const name = o.pos[1];
    return name ? scriptHit(name, `${tag} run ${name}`, ctx, depth, sc) : [];
  }
  if (mgr === 'pnpm' || mgr === 'yarn') {
    const direct = hit(runnerOf(sub), args.slice(o.idx[0]), `${mgr} ${sub}`, ctx);
    return direct.length || runnerOf(sub) ? direct : scriptHit(sub, `${tag} ${sub}`, ctx, depth, sc);
  }
  return [];
}

// ---- main analysis ---------------------------------------------------------------------------

// `claude plugin disable|uninstall agent-test-budget`, `claude plugin marketplace remove agent-test-budget`
function pluginTamper(args) {
  const i = args.findIndex((t) => t === 'plugin' || t === 'plugins');
  if (i < 0) return [];
  const a = args.slice(i + 1).filter((t) => !t.startsWith('-'));
  const act = a[0] === 'marketplace' ? a[1] : a[0];
  return ['disable', 'uninstall', 'remove', 'rm'].includes(act) && a.some((t) => t.includes('agent-test-budget')) ? [{ tamper: true }] : [];
}

function analyzeTokens(toks, ctx, depth) {
  if (!toks.length || depth > 5) return [];
  const head = stripExt(toks[0]);
  const rest = toks.slice(1);
  if (head === BIN) return [{ tb: rest[0] ?? 'help' }];
  // `$RUNNER vitest`, `$(echo npx) vitest`: the program is unknown, so judge the words after it
  if (head.startsWith('$')) return analyzeTokens(skipWrappers(rest), ctx, depth + 1);
  if (head === 'npx' || head === 'bunx' || head === 'pnpx' || head === 'uvx') {
    const r = head === 'uvx' ? dropOpts(rest, PY_RUN_ARGS) : dropFlags(rest);
    if (base(r[0]) === BIN) return [{ tb: r[1] ?? 'help' }];
    if (WRAPPERS.has(base(r[0]))) return analyzeTokens(skipWrappers(r), ctx, depth + 1); // npx cross-env CI=1 vitest
    return hit(runnerOf(r[0]), r, `${head} ${r[0] ?? ''}`.trim(), ctx);
  }
  if (head === 'claude') return pluginTamper(rest);
  if (head === 'hatch' && dropFlags(rest)[0] === 'test') return hit('pytest', rest, 'hatch test', ctx);
  if (head === 'tox' || head === 'nox') { // sessions defined in config; they run pytest when the config says so
    if (rest.some((a) => TOX_INFO.has(a)) || ['list', 'l', 'config', 'c', 'quickstart', 'q'].includes(rest[0])) return [];
    const files = head === 'tox' ? ['tox.ini', 'tox.toml', 'setup.cfg', 'pyproject.toml'] : ['noxfile.py'];
    const runs = files.some((f) => /\bpy(?:\.)?test\b/.test(readText(path.resolve(ctx.cwd, f), false) ?? ''));
    return runs ? hit('pytest', rest, head, ctx) : [];
  }
  if (head === 'script') { // util-linux: script -c "cmd" file; BSD/macOS: script [-q] file cmd ...
    const j = rest.findIndex((t) => isDashC(t) || t === '--command');
    if (j >= 0) return rest[j + 1] ? analyzeCommand(rest[j + 1], ctx, depth + 1) : [];
    const a = dropOpts(rest, SCRIPT_ARGS);
    return a.length > 1 ? analyzeTokens(skipWrappers(a.slice(1)), ctx, depth + 1) : [];
  }
  if (head === 'node') {
    const i = rest.findIndex((t) => !t.startsWith('-'));
    const target = i >= 0 ? rest[i] : null;
    if (!target) return [];
    if (stripExt(target) === BIN) return [{ tb: rest[i + 1] ?? 'help' }];
    const m = /(^|\/)(vitest|jest)(\/|\.m?js$|$)/.exec(target.replace(/\\/g, '/'));
    return m ? hit(m[2], rest, `node ${target}`, ctx) : [];
  }
  if (SHELLS.has(head)) {
    const i = rest.findIndex(isDashC);
    if (i >= 0) return rest[i + 1] ? analyzeCommand(rest[i + 1], ctx, depth + 1) : [];
    return scriptHits(rest.find((t) => !t.startsWith('-')), ctx, depth, false);
  }
  if (head === 'source' || head === '.') return scriptHits(rest[0], ctx, depth, false);
  if (head === 'eval') return analyzeCommand(rest.join(' '), ctx, depth + 1);
  if (head === 'make' || head === 'gmake') return makeHits(rest, ctx, depth);
  if (head === 'just') return justHits(rest, ctx, depth);
  if (head === 'xargs') return analyzeTokens(skipWrappers(dropOpts(rest, XARGS_ARGS)), ctx, depth + 1);
  if (head === 'watch') {
    const a = dropOpts(rest, new Set(['-n', '--interval']));
    return a.length === 1 ? analyzeCommand(a[0], ctx, depth + 1) : analyzeTokens(skipWrappers(a), ctx, depth + 1);
  }
  if (head === 'find') {
    const out = [];
    for (let i = 0; i < rest.length; i++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(rest[i])) continue;
      const cmd = [];
      for (let j = i + 1; j < rest.length && rest[j] !== ';' && rest[j] !== '+'; j++) cmd.push(rest[j]);
      out.push(...analyzeTokens(skipWrappers(cmd), ctx, depth + 1));
    }
    return out;
  }
  if (head === 'coverage' && rest[0] === 'run') return coverageHits(rest.slice(1), ctx);
  if (PKG_MGRS.has(head)) return analyzePkgMgr(head, rest, ctx, depth);
  if (PY_LAUNCHERS.has(head)) {
    const i = rest.indexOf('run');
    return i < 0 || depth > 3 ? [] : analyzeTokens(skipWrappers(dropOpts(rest.slice(i + 1), PY_RUN_ARGS)), ctx, depth + 1);
  }
  if (/^python[\d.]*$/.test(head) || head === 'py') {
    const i = rest.indexOf('-m');
    if (i < 0) return [];
    if (rest[i + 1] === 'coverage' && rest[i + 2] === 'run') return coverageHits(rest.slice(i + 3), ctx);
    return hit(runnerOf(rest[i + 1]), rest, `${head} -m ${rest[i + 1]}`, ctx);
  }
  const direct = hit(runnerOf(toks[0]), rest, base(toks[0]), ctx);
  if (direct.length || runnerOf(toks[0])) return direct;
  return toks[0].includes('/') ? scriptHits(toks[0], ctx, depth, true) : []; // ./run-tests.sh
}

// ---- simple commands and variables ------------------------------------------------------------
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DECL = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);

// `R=vitest` or `export R=vitest` on its own: remember it for the rest of the command
function recordAssignments(toks, vars) {
  const t = DECL.has(toks[0]) ? toks.slice(1).filter((x) => !x.startsWith('-')) : toks;
  if (!t.length || !t.every((x) => ASSIGN.test(x))) return false;
  for (const x of t) vars.set(x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1));
  return true;
}

// expanded before tokenizing, so `C="npx vitest"; $C run` splits into words like the shell does
const expandVars = (seg, vars) =>
  vars.size ? seg.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => vars.get(a ?? b) ?? m) : seg;

// Every simple command in cmd, including $(...), `...` and <(...) bodies, with variables that were
// assigned earlier in the same command expanded. Assignment-only segments come back flagged.
function* simpleCommands(cmd, depth = 0, vars = new Map()) {
  if (depth > 4) return;
  const { text, bodies } = substitutions(String(cmd));
  for (const raw of splitSegments(text)) {
    const seg = expandVars(raw, vars);
    const toks = unwrap(tokenize(seg));
    yield { seg, toks, depth, assign: recordAssignments(toks, vars) };
  }
  for (const b of bodies) yield* simpleCommands(b, depth + 1, vars);
}

// TBUDGET_GUARD=off is the human escape hatch; set by the agent it would reach a nested `claude`
function setsGuardEnv(toks) {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^TBUDGET_(?:GUARD|INSIDE)=/.test(t)) return true;
    if (!(ASSIGN.test(t) || DECL.has(t) || base(t) === 'env' || (i > 0 && t.startsWith('-')))) return false;
  }
  return false;
}

export function analyzeCommand(cmd, ctx, depth = 0) {
  if (depth > 4) return [];
  const out = [];
  for (const c of simpleCommands(cmd, depth)) {
    if (setsGuardEnv(c.toks)) out.push({ guardEnv: true });
    if (!c.assign) out.push(...analyzeTokens(skipWrappers(c.toks), ctx, c.depth));
  }
  return out;
}

// every command segment, including bash -c strings and $(...) bodies, for user-supplied patterns
function* deepSegments(cmd, depth = 0) {
  if (depth > 4) return;
  for (const c of simpleCommands(cmd, depth)) {
    const toks = skipWrappers(c.toks);
    if (c.assign || !toks.length) continue;
    yield toks.join(' ');
    if (SHELLS.has(stripExt(toks[0]))) {
      const i = toks.slice(1).findIndex(isDashC);
      if (i >= 0 && toks[i + 2]) yield* deepSegments(toks[i + 2], c.depth + 1);
    }
  }
}

const VERBS = /(?:^|\s)(?:rm|mv|cp|tee|truncate|chmod|chown|dd|install|ln|rsync|patch|touch)\s|\bsed\s[^|;&]*-[a-zA-Z]*i|\bperl\s[^|;&]*-[a-zA-Z]*i|\bgit\s+(?:checkout|restore|stash|rm|clean|apply)\b|\b(?:writeFile|appendFile|writeFileSync|appendFileSync|open)\s*\(/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Paths compare lowercased: macOS and Windows file systems are case-insensitive by default,
// so `.TEST-BUDGET/policy.json` is the policy file there.
const lc = (p) => toPosix(p).toLowerCase();
const protectedList = (ctx) => [...new Set([...ctx.policy.guard.protectedPaths, '.test-budget'].map(lc))];

// rel (project-relative, lowercased) is a protected path, inside one, or a directory holding one
function protectedHit(rel, prot) {
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return prot.find((p) => rel === p || rel.startsWith(`${p}/`) || p.startsWith(`${rel}/`)) ?? null;
}

// one glob path component -> RegExp; a leading dot is only matched literally, as in the shell
function componentRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[' && g.indexOf(']', i + 2) > 0) {
      const j = g.indexOf(']', i + 2);
      re += `[${g.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = j;
    } else if (c === '{' && g.indexOf('}', i) > 0) {
      const j = g.indexOf('}', i);
      re += `(?:${g.slice(i + 1, j).split(',').map(escapeRe).join('|')})`;
      i = j;
    } else re += escapeRe(c);
  }
  return new RegExp(`^${re}$`);
}

const isGlob = (t) => /[*?[{]/.test(t);

function globHit(relGlob, prot) {
  const pc = relGlob.split('/').filter((x) => x && x !== '.');
  if (!pc.length || pc[0] === '..') return null;
  const res = pc.map(componentRe);
  for (const p of prot) {
    const parts = p.split('/');
    if (pc.length > parts.length) continue; // the glob names the protected path or a directory above it
    if (parts.slice(0, pc.length).every((c, k) => res[k].test(c) && !(c.startsWith('.') && /^[*?[]/.test(pc[k])))) return p;
  }
  return null;
}

// `git clean -x/-X` and `git stash -a` delete ignored files, and .test-budget/.state is ignored
const gitSub = (toks) => {
  let i = 1;
  while (i < toks.length && toks[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(toks[i]) ? 2 : 1;
  return i;
};

function gitWipesState(toks) {
  const i = gitSub(toks);
  const sub = toks[i];
  const rest = toks.slice(i + 1);
  const short = rest.filter((t) => /^-[a-zA-Z]+$/.test(t)).join('');
  if (sub === 'stash') return rest.includes('--all') || /a/.test(short) ? '.test-budget/.state' : null;
  if (sub !== 'clean' || !/[xX]/.test(short) || /n/.test(short) || rest.includes('--dry-run')) return null;
  const excl = [];
  for (let k = 0; k < rest.length; k++) {
    if (rest[k] === '-e' || rest[k] === '--exclude') excl.push(rest[k + 1] ?? '');
    else if (rest[k].startsWith('--exclude=')) excl.push(rest[k].slice(10));
    else if (/^-e./.test(rest[k])) excl.push(rest[k].slice(2));
  }
  return excl.some((e) => lc(e).replace(/^\/|\/$/g, '').startsWith('.test-budget')) ? null : '.test-budget/.state';
}

// Accident-proofing, not a sandbox: catches the obvious ways an agent edits its own guard rails.
function touchesProtected(command, ctx) {
  const prot = protectedList(ctx);
  let dir = ctx.cwd;
  for (const c of simpleCommands(command)) {
    if (c.assign) continue;
    const { seg } = c;
    const toks = skipWrappers(c.toks);
    if (toks[0] === 'cd' || toks[0] === 'pushd') { // follow `cd .test-budget && rm -rf .state`
      const t = toks.slice(1).find((x) => !x.startsWith('-'));
      if (t && !/[$~`]/.test(t)) dir = path.resolve(dir, t);
      continue;
    }
    if (toks[0] === 'git') {
      const p = gitWipesState(toks);
      if (p) return { path: p, hint: ' To clean the repo, add: -e .test-budget' };
      const i = gitSub(toks);
      if (toks[i] === 'clean') { // judge its pathspecs, not the words: `-e .test-budget` is fine
        const specs = toks.slice(i + 1).filter((t, k, a) => !t.startsWith('-') && a[k - 1] !== '-e' && a[k - 1] !== '--exclude');
        for (const t of specs) {
          const rel = lc(path.relative(ctx.root, path.resolve(dir, t)));
          const hitP = isGlob(t) ? globHit(rel, prot) : protectedHit(rel, prot);
          if (hitP) return { path: hitP };
        }
        continue;
      }
    }
    const norm = lc(seg).replace(/\.\//g, '');
    const verb = VERBS.test(norm);
    for (const p of prot) {
      if (!norm.includes(p)) continue;
      if (verb) return { path: p };
      if (new RegExp(`(?<![0-9&])>>?\\s*['"]?[^\\s'";|&]*${escapeRe(p)}`).test(norm)) return { path: p };
    }
    // with a write verb every operand counts; otherwise only redirection targets do
    const operands = [];
    for (let k = 1; k < toks.length; k++) {
      const m = /^\d*&?>>?(.*)$/.exec(toks[k]);
      if (m) operands.push(m[1] || toks[++k] || '');
      else if (verb) operands.push(toks[k]);
    }
    for (const t of operands) {
      if (!t || t.startsWith('-')) continue;
      const rel = lc(path.relative(ctx.root, path.resolve(dir, t)));
      const p = isGlob(t) ? globHit(rel, prot) : protectedHit(rel, prot);
      if (p) return { path: p };
    }
  }
  return null;
}

const protectedMsg = (p) => `tb-guard: ${p} is protected (policy, state and hook config are human-edited). Do not retry; ask the user.`;

// "go test ./..." -> /^go test\b/: the program plus the plain words after it, for the guard
function runnerCmdPattern(policy) {
  const tpl = policy.runner === 'junit' ? policy.junit.cmd : policy.runner === 'generic' ? policy.generic.cmd : '';
  const toks = tpl.trim().split(/\s+/).filter(Boolean);
  if (!toks.length || /[{$]/.test(toks[0])) return null;
  const words = [toks[0]];
  for (const t of toks.slice(1)) {
    if (words.length >= 3 || !/^[a-z][\w-]*$/.test(t)) break;
    words.push(t);
  }
  return new RegExp(`^${words.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);
}

export function createCtx({ cwd, root, policy, pluginRoot }) {
  let cache;
  const patterns = [];
  for (const p of policy.guard.blockPatterns ?? []) {
    try { patterns.push(new RegExp(p)); } catch { /* reported by loadPolicy */ }
  }
  const runnerCmd = policy.guard.blockRunnerCmd ? runnerCmdPattern(policy) : null;
  return {
    cwd, root, policy, pluginRoot, patterns, runnerCmd, stack: new Set(),
    enforce: new Set(policy.guard.enforce),
    scripts: () => (cache ??= readScripts(cwd)),
  };
}

const useTb = (ctx) => `Run: ${BIN} run [test-file ...] (scoped to affected tests, stops early on failure, prints a <=${ctx.policy.digest.maxLines}-line digest; full log in .test-budget/.state/last-run.log).`;

export function decideBash(command, ctx) {
  const g = ctx.policy.guard;
  for (const f of analyzeCommand(command, ctx)) {
    if (f.tamper) {
      return { rule: 'protected', reason: 'tb-guard: disabling or removing the agent-test-budget plugin is human-only. Do not retry; ask the user.' };
    }
    if (f.guardEnv) {
      return { rule: 'protected', reason: 'tb-guard: TBUDGET_GUARD and TBUDGET_INSIDE belong to the human and to tbudget; the agent may not set them. Do not retry; ask the user.' };
    }
    if (f.tb === 'reset') {
      return { rule: 'tb-reset', reason: `tb-guard: ${BIN} reset is human-only. Do not retry. Tell the user which test keeps failing and what you suspect; they can clear it in their own terminal: node ${JSON.stringify(path.join(ctx.pluginRoot ?? '<plugin dir>', 'bin', BIN))} reset --reason "<why>".` };
    }
    if (f.block && g.blockRawRunners) {
      const via = f.via && f.via !== f.block ? ` (${f.via})` : '';
      return { rule: 'raw-runner', reason: `tb-guard: raw ${f.block} blocked${via}. ${useTb(ctx)}` };
    }
  }
  if (g.blockRawRunners && (ctx.patterns.length || ctx.runnerCmd)) {
    for (const s of deepSegments(command)) {
      if (ctx.runnerCmd?.test(s)) return { rule: 'raw-runner', reason: `tb-guard: "${s.slice(0, 60)}" is this project's test command (policy.${ctx.policy.runner}.cmd); run it through tbudget. ${useTb(ctx)}` };
      const re = ctx.patterns.find((r) => r.test(s));
      if (re) return { rule: 'raw-runner', reason: `tb-guard: "${s.slice(0, 60)}" blocked by policy guard.blockPatterns. ${useTb(ctx)}` };
    }
  }
  const p = touchesProtected(command, ctx);
  return p ? { rule: 'protected', reason: protectedMsg(p.path) + (p.hint ?? '') } : null;
}

const isUnder = (abs, dir) => {
  const r = path.relative(dir.toLowerCase(), abs.toLowerCase());
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

function overlap(oldLines, newLines) {
  const counts = new Map();
  for (const l of oldLines) {
    const t = l.trim();
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  let common = 0;
  let total = 0;
  for (const l of newLines) {
    const t = l.trim();
    if (!t) continue;
    total++;
    const c = counts.get(t);
    if (c) { common++; counts.set(t, c - 1); }
  }
  return total ? common / total : 0;
}

export function decideEdit(tool, input, ctx) {
  const file = input?.file_path ?? input?.notebook_path;
  if (!file) return null;
  const abs = path.resolve(ctx.cwd, file);
  const g = ctx.policy.guard;
  if (ctx.pluginRoot && isUnder(abs, ctx.pluginRoot)) {
    return { rule: 'protected', reason: `tb-guard: ${file} is inside the test-budget plugin. Do not edit it.` };
  }
  const rel = toPosix(path.relative(ctx.root, abs));
  if (rel.startsWith('..')) return null;
  const lrel = rel.toLowerCase();
  for (const p of g.protectedPaths) {
    const lp = lc(p);
    if (lrel === lp || lrel.startsWith(`${lp}/`)) return { rule: 'protected', reason: protectedMsg(p) };
  }
  if (tool === 'Write' && g.preferEditOverRewrite && typeof input.content === 'string' && ctx.policy.testGlobs.some((p) => globToRegExp(p).test(rel))) {
    let old = null;
    try { old = fs.readFileSync(abs, 'utf8'); } catch { /* new file: fine */ }
    if (old !== null) {
      const oldLines = old.split('\n');
      const ratio = oldLines.length >= g.rewriteMinLines ? overlap(oldLines, input.content.split('\n')) : 0;
      if (ratio >= g.rewriteOverlap) {
        return { rule: 'rewrite', reason: `tb-guard: Write would resend ${oldLines.length} lines of ${rel}, ${Math.round(ratio * 100)}% unchanged (~${Math.round(input.content.length / 4)} output tokens). Use Edit with only the changed hunk.` };
      }
    }
  }
  return null;
}

export const looksLikeRunner = (input) =>
  input?.tool_name === 'Bash' &&
  /\b(vitest|jest|pytest|py\.test)\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?[\w:-]*test|\b(?:make|just)\b/.test(String(input?.tool_input?.command ?? ''));

// Shadow mode: the same decision, recorded as would-deny instead of enforced.
export function outcome(d, input, policy) {
  const shadow = policy?.mode === 'shadow';
  const rec = { type: shadow ? 'would-deny' : 'deny', rule: d.rule, tool: input.tool_name, agent: input.agent_type ?? 'main' };
  if (shadow) rec.command = String(input.tool_input?.command ?? input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '').slice(0, 200);
  return { rec, deny: !shadow };
}
