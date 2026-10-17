import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp, toPosix } from './shell.mjs';

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'coverage', '.venv', 'venv', '__pycache__', '.test-budget']);
const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts'];

// signature only: drop a function body that starts on the same line
const signatureOf = (l) => {
  const m = /^(export\s+(?:default\s+)?(?:async\s+)?function\b.*?\)(?::\s*[^{]+?)?)\s*\{/.exec(l);
  return (m ? m[1] : l.replace(/\s*\{\s*$/, '')).trim();
};
const jsExports = (src) => src.split('\n').filter((l) => /^export\s/.test(l)).map((l) => clip(signatureOf(l), 160)).slice(0, 25);
const pyExports = (src) => src.split('\n').filter((l) => /^(?:async\s+)?def\s+[a-zA-Z]|^class\s+[A-Za-z]/.test(l)).map((l) => clip(l.replace(/:\s*$/, '').trim(), 160)).slice(0, 25);

function testTitles(src, py) {
  const out = [];
  const re = py ? /^\s*(?:async\s+)?def\s+(test_\w+)/gm : /\b(?:it|test)(?:\.\w+)*\s*\(\s*(['"`])(.+?)\1/g;
  for (const m of src.matchAll(re)) out.push(py ? m[1] : m[2]);
  return out.slice(0, 20);
}

function siblingCandidates(abs, root, py) {
  const dir = path.dirname(abs);
  const ext = path.extname(abs);
  const name = path.basename(abs, ext);
  if (py) {
    return [path.join(dir, `test_${name}.py`), path.join(dir, `${name}_test.py`), path.join(dir, 'tests', `test_${name}.py`),
      path.join(root, 'tests', `test_${name}.py`), path.join(root, 'test', `test_${name}.py`)];
  }
  const out = [];
  for (const e of new Set([ext, ...JS_EXTS])) {
    for (const kind of ['test', 'spec']) {
      out.push(path.join(dir, `${name}.${kind}${e}`), path.join(dir, '__tests__', `${name}.${kind}${e}`));
    }
    out.push(path.join(root, 'tests', `${name}.test${e}`), path.join(root, 'test', `${name}.test${e}`));
  }
  return out;
}

function listTests(dir, isTest, depth, found, skipAbs) {
  if (found.length >= 1 || depth < 0) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isFile() && isTest(e.name) && path.join(dir, e.name) !== skipAbs) { found.push(path.join(dir, e.name)); return; }
  }
  for (const e of entries) {
    if (e.isDirectory() && !SKIP.has(e.name)) listTests(path.join(dir, e.name), isTest, depth - 1, found, skipAbs);
    if (found.length) return;
  }
}

function pickExemplar(abs, root, policy, skipAbs) {
  const isTest = (n) => policy.testGlobs.some((g) => globToRegExp(g).test(n));
  const found = [];
  for (let dir = path.dirname(abs); !found.length; dir = path.dirname(dir)) {
    listTests(dir, isTest, dir === path.dirname(abs) ? 1 : 0, found, skipAbs);
    if (dir === root || path.dirname(dir) === dir) break;
  }
  if (!found.length) listTests(root, isTest, 3, found, skipAbs);
  return found[0] ?? null;
}

export function brief(fileArg, { cwd, root, policy, runner }) {
  const abs = path.resolve(cwd, fileArg);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { code: 2, lines: [`tb: ${fileArg} not found`] };
  const rel = (p) => toPosix(path.relative(cwd, p));
  const py = abs.endsWith('.py');
  const src = fs.readFileSync(abs, 'utf8');
  const exps = py ? pyExports(src) : jsExports(src);
  const existing = siblingCandidates(abs, root, py).find((p) => fs.existsSync(p));
  const exemplarPath = pickExemplar(abs, root, policy, existing ?? '');
  const ext = path.extname(abs);
  const name = path.basename(abs, ext);
  const suggested = py ? rel(path.join(fs.existsSync(path.join(root, 'tests')) ? path.join(root, 'tests') : path.dirname(abs), `test_${name}.py`))
    : rel(path.join(path.dirname(abs), `${name}.test${ext}`));

  const lines = [`# brief: ${rel(abs)}`, `runner: ${runner ?? 'unknown'} | run tests only with: tbudget run <test-file> (raw runners are blocked)`, '', 'exports:'];
  lines.push(...(exps.length ? exps.map((e) => `- ${e}`) : ['- (none found; read the file)']));
  lines.push('');
  if (existing) {
    const titles = testTitles(fs.readFileSync(existing, 'utf8'), py);
    lines.push(`existing tests: ${rel(existing)} (${titles.length} found) - extend with Edit, do not rewrite`);
    lines.push(...titles.map((t) => `- ${clip(t, 100)}`));
  } else lines.push(`existing tests: none. create ${suggested}`);
  if (exemplarPath) {
    lines.push('', `style exemplar: ${rel(exemplarPath)} (first 40 lines)`, '---');
    lines.push(...fs.readFileSync(exemplarPath, 'utf8').split('\n').slice(0, 40).map((l) => clip(l, 160)));
  }
  return { code: 0, lines };
}
