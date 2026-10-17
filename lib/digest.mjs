// Turns runner reports into a few lines an agent can act on. Everything else stays in the log file.
import fs from 'node:fs';
import path from 'node:path';
import { toPosix } from './shell.mjs';

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s) => String(s ?? '').replace(ANSI, '');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isFrame = (l) => /^\s*at\s/.test(l);
const isNoise = (l) => /node_modules|node:internal|\(<anonymous>\)|jest-circus|jest-jasmine|vitest\/dist/.test(l);
// Runners report real paths: on macOS /var/folders/x is /private/var/folders/x. Strip the longer form
// first, or "/private" is left glued to the relative path.
const realRoots = new Map();
const rootsOf = (root) => {
  if (!realRoots.has(root)) {
    let real = root;
    try { real = fs.realpathSync(root); } catch { /* not on disk */ }
    realRoots.set(root, [...new Set([real, root])].sort((a, b) => b.length - a.length));
  }
  return realRoots.get(root);
};
export const relativize = (text, root) => {
  if (!root) return text;
  let out = text;
  for (const r of rootsOf(root)) out = out.split(`file://${r}/`).join('').split(`${r}/`).join('');
  return out;
};

// vitest --reporter=json and jest --json share one shape.
export function parseJestLike(j, root) {
  const failed = [];
  const passed = [];
  for (const s of j.testResults ?? []) {
    const file = relativize(s.name ?? '', root);
    let nFail = 0;
    for (const a of s.assertionResults ?? []) {
      const name = [...(a.ancestorTitles ?? []), a.title].filter(Boolean).join(' > ') || a.fullName || '';
      const id = `${file}::${name}`;
      if (a.status === 'failed') {
        nFail++;
        failed.push({ id, file, title: `${file} > ${name}`, message: (a.failureMessages ?? []).join('\n'), kind: 'js' });
      } else if (a.status === 'passed') passed.push(id);
    }
    if (s.status === 'failed' && nFail === 0) {
      failed.push({ id: `${file}::<suite>`, file, title: `${file} (suite failed to run)`, message: s.message ?? '', kind: 'js' });
    }
  }
  const counts = {
    total: j.numTotalTests ?? 0,
    passed: j.numPassedTests ?? passed.length,
    failed: Math.max(j.numFailedTests ?? 0, failed.length),
    skipped: (j.numPendingTests ?? 0) + (j.numTodoTests ?? 0),
  };
  return { failed, passed, counts };
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#10;/g, '\n').replace(/&#13;/g, '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&amp;/g, '&');
const attr = (s, k) => { const m = new RegExp(`\\b${k}="([^"]*)"`).exec(s ?? ''); return m ? unxml(m[1]) : ''; };

// junit classname "pkg.mod.Class" -> { file: "pkg/mod.py", rest: "Class" } when the file exists.
function pyLocate(classname, root, cwd) {
  const parts = classname.split('.').filter(Boolean);
  for (let i = parts.length; i > 0; i--) {
    const rel = `${parts.slice(0, i).join('/')}.py`;
    for (const base of new Set([cwd, root].filter(Boolean))) {
      if (fs.existsSync(path.join(base, rel))) return { file: toPosix(path.relative(root, path.join(base, rel))), rest: parts.slice(i).join('.') };
    }
  }
  return { file: null, rest: classname };
}

// Any JUnit XML (pytest, gotestsum, Gradle, Maven, Bazel, cargo-nextest...). For pytest the classname
// is mapped back to a .py file; elsewhere the file comes from a `file` attribute when the tool writes one.
export function parseJUnit(xml, { root = '', cwd = root, py = false } = {}) {
  const failed = [];
  const passed = [];
  let total = 0;
  let skipped = 0;
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const [, attrs, body = ''] = m;
    const name = attr(attrs, 'name');
    const classname = attr(attrs, 'classname');
    const fileAttr = attr(attrs, 'file');
    const { file, rest } = py ? pyLocate(classname, root, cwd)
      : { file: fileAttr ? toPosix(relativize(fileAttr, root)) : null, rest: classname };
    const label = rest ? `${rest}.${name}` : name;
    const id = `${file ?? ''}::${label}`;
    total++;
    const f = /<(?:failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:failure|error)>)/.exec(body);
    if (f) {
      const message = `${attr(f[1], 'message')}\n${unxml((f[2] ?? '').replace(/^<!\[CDATA\[|\]\]>$/g, ''))}`;
      failed.push({ id, file, title: [file, label].filter(Boolean).join(' > '), message, kind: py ? 'py' : 'junit' });
    } else if (/<skipped\b/.test(body)) skipped++;
    else passed.push(id);
  }
  return { failed, passed, counts: { total, passed: passed.length, failed: failed.length, skipped } };
}

export const parsePytestXml = (xml, opts = {}) => parseJUnit(xml, { ...opts, py: true });

// A report path is one file, or a directory the tool fills (Gradle, Maven, Bazel): take the .xml files
// written since the run started, so last week's reports do not count.
export function readJUnit(p, since) {
  const files = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 8 && e.name !== 'node_modules') walk(f, depth + 1);
      else if (e.isFile() && e.name.endsWith('.xml') && fs.statSync(f).mtimeMs >= since - 2000) files.push(f);
    }
  };
  try {
    if (fs.statSync(p).isDirectory()) walk(p, 0);
    else if (fs.statSync(p).mtimeMs >= since - 2000) files.push(p);
  } catch { return null; }
  return files.length ? files.sort().map((f) => fs.readFileSync(f, 'utf8')).join('\n') : null;
}

function blockLines(f, { root, maxLineChars, stackFrames, per }) {
  const text = relativize(stripAnsi(f.message), root).split('\n');
  const msgMax = Math.max(1, per - 1 - stackFrames);
  let body;
  let frames;
  if (f.kind === 'py') {
    const e = text.filter((l) => /^E\s/.test(l)).map((l) => l.replace(/^E\s+/, ''));
    body = e.length ? e : text.filter((l) => l.trim() && !/^_{3,}/.test(l));
    frames = text.filter((l) => /^\S+\.py:\d+:/.test(l)).slice(-stackFrames);
  } else {
    body = text.filter((l) => l.trim() && !isFrame(l));
    frames = text.filter((l) => isFrame(l) && !isNoise(l)).map((l) => l.trim()).slice(0, stackFrames);
  }
  return [
    `✗ ${f.title}`,
    ...body.slice(0, msgMax).map((l) => `  ${clip(l.trimEnd(), maxLineChars)}`),
    ...(stackFrames > 0 ? frames : []).map((l) => `  ${clip(l, maxLineChars)}`),
  ];
}

export function renderFailures(failed, opts) {
  const shown = failed.slice(0, 3);
  const per = Math.max(4, Math.min(16, Math.floor((opts.maxLines - 4) / Math.max(1, shown.length))));
  const lines = shown.flatMap((f) => blockLines(f, { ...opts, per }));
  if (failed.length > shown.length) lines.push(`… +${failed.length - shown.length} more failing (see log)`);
  return lines;
}

// For runners without a structured report: keep error-looking lines and the tail.
export function digestGeneric(text, { maxLines, maxLineChars }) {
  const lines = stripAnsi(text).split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const room = Math.max(4, maxLines - 3);
  if (lines.length <= room) return lines.map((l) => clip(l, maxLineChars));
  const errs = lines.filter((l) => /fail|error|panic|✗|✘|assert|exception|timeout/i.test(l));
  const head = errs.slice(0, Math.max(0, room - 6));
  const tail = lines.slice(-(room - head.length - 1));
  return [...head, '…', ...tail].map((l) => clip(l, maxLineChars));
}
