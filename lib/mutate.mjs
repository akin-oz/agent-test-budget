// Test-quality check without a framework: small, valid edits to one source file ("mutants"). A good
// suite fails on most of them. Line-based on purpose: no parser per language, operators that keep the
// code valid, and nothing inside strings or comments.

// [pattern, replacement]; spaced operators only, so `a<T>`, `=>` and `->` are never touched
const JS = [
  [/ === /, ' !== '], [/ !== /, ' === '], [/ == /, ' != '], [/ != /, ' == '],
  [/ <= /, ' < '], [/ >= /, ' > '], [/ < /, ' <= '], [/ > /, ' >= '],
  [/ && /, ' || '], [/ \|\| /, ' && '], [/ \+ /, ' - '], [/ - /, ' + '], [/ \* /, ' / '],
  [/\btrue\b/, 'false'], [/\bfalse\b/, 'true'], [/\bthrow (?=\S)/, 'void '], [/(?<![\w.])(\d+)(?![\w.])/, (n) => String(Number(n) + 1)],
];
const PY = [
  [/ == /, ' != '], [/ != /, ' == '], [/ <= /, ' < '], [/ >= /, ' > '], [/ < /, ' <= '], [/ > /, ' >= '],
  [/ and /, ' or '], [/ or /, ' and '], [/ \+ /, ' - '], [/ - /, ' + '], [/ \* /, ' / '],
  [/\bTrue\b/, 'False'], [/\bFalse\b/, 'True'], [/\braise (?=\S)/, ''], [/(?<![\w.])(\d+)(?![\w.])/, (n) => String(Number(n) + 1)],
];

// columns of a line that are code: not inside quotes, not after a comment marker
function codeMask(line, py) {
  const mask = new Array(line.length).fill(true);
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { mask[i] = false; if (c === '\\') { mask[++i] = false; } else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || (!py && c === '`')) { q = c; mask[i] = false; continue; }
    if ((py && c === '#') || (!py && c === '/' && line[i + 1] === '/')) { for (let j = i; j < line.length; j++) mask[j] = false; break; }
    // a JS regex literal: `/` where an expression starts. Its digits and operators are not code to mutate.
    if (!py && c === '/' && /(?:^|[(,=:[!&|?{};]|\breturn)\s*$/.test(line.slice(0, i))) {
      let j = i + 1;
      for (let cls = false; j < line.length; j++) {
        if (line[j] === '\\') { j++; continue; }
        if (line[j] === '[') cls = true;
        else if (line[j] === ']') cls = false;
        else if (line[j] === '/' && !cls) break;
      }
      for (let k = i; k <= j && k < line.length; k++) mask[k] = false;
      i = j;
    }
  }
  return mask;
}

const SKIP_LINE = /^\s*(?:import\b|export\s+(?:\*|\{[^}]*\})\s+from\b|from\s+\S+\s+import\b|\/\/|#|\*|\/\*|@)/;

export function generateMutants(text, { py = false, max = 12 } = {}) {
  const lines = text.split('\n');
  const all = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    if (!line.trim() || SKIP_LINE.test(line)) continue;
    const mask = codeMask(line, py);
    for (const [re, rep] of py ? PY : JS) {
      const g = new RegExp(re.source, 'g');
      for (const m of line.matchAll(g)) {
        if (!mask[m.index] || !mask[m.index + m[0].length - 1]) continue;
        if (re.source.startsWith('\\braise') && /^\s*raise\s*$/.test(line)) continue;
        const to = typeof rep === 'function' ? rep(m[1] ?? m[0]) : rep;
        all.push({ line: n + 1, col: m.index, from: m[0], to });
      }
    }
  }
  // spread the picks across the file instead of taking the first few lines
  const step = Math.max(1, all.length / max);
  const picked = [];
  for (let i = 0; i < all.length && picked.length < max; i += step) picked.push(all[Math.floor(i)]);
  return picked;
}

export function applyAt(text, m) {
  const lines = text.split('\n');
  const l = lines[m.line - 1];
  lines[m.line - 1] = l.slice(0, m.col) + m.to + l.slice(m.col + m.from.length);
  return lines.join('\n');
}
