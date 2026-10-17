// Tiny shell-aware helpers. Not a full parser: they only need to be right about
// "which program sits in command position" and to fail toward "no match".

export function splitSegments(raw) {
  const cmd = joinContinuations(raw);
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else if (c === q) q = null;
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '&' && (cur.endsWith('>') || cmd[i + 1] === '>')) { cur += c; continue; } // 2>&1, &>
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++;
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// backslash-newline is a line continuation: the shell deletes both characters
export const joinContinuations = (cmd) => String(cmd).replace(/\\\r?\n/g, '');

export function tokenize(seg) {
  const toks = [];
  let cur = '';
  let q = null;
  let has = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (c === '\\' && q === '"' && i + 1 < seg.length) { cur += seg[++i]; continue; }
      cur += c;
      continue;
    }
    if (c === '\\' && i + 1 < seg.length) { cur += seg[++i]; has = true; continue; }
    if (c === '$' && (seg[i + 1] === "'" || seg[i + 1] === '"')) continue; // $'ansi-c' and $"locale" quoting
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (/\s/.test(c)) {
      if (has) { toks.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) toks.push(cur);
  return toks;
}

// index of the `)` that closes a `(` opened just before `start`, or -1
function closeParen(cmd, start) {
  let depth = 1;
  let q = null;
  for (let i = start; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '\\') i++;
    else if (c === '"' || c === "'") q = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

export const SUBST = '$__SUBST';

// Cut $(...), `...`, <(...) and >(...) out of a command: their bodies run as commands of their own.
// Each one leaves a placeholder word behind, so `$(echo npx) vitest` still reads as "<unknown> vitest".
export function substitutions(cmd) {
  const bodies = [];
  let text = '';
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") { text += c; if (c === "'") q = null; continue; }
    if (c === '\\' && i + 1 < cmd.length) { text += c + cmd[++i]; continue; }
    if (c === "'" && !q) { q = c; text += c; continue; }
    if (c === '"') { q = q ? null : c; text += c; continue; }
    if (cmd[i + 1] === '(' && (c === '$' || (!q && (c === '<' || c === '>')))) {
      const end = closeParen(cmd, i + 2);
      if (end > 0) { bodies.push(cmd.slice(i + 2, end)); text += SUBST; i = end; continue; }
    }
    if (c === '`') {
      const end = cmd.indexOf('`', i + 1);
      if (end > 0) { bodies.push(cmd.slice(i + 1, end)); text += SUBST; i = end; continue; }
    }
    text += c;
  }
  return { text, bodies };
}

export const nestedCommands = (cmd) => substitutions(cmd).bodies;

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const toPosix = (p) => p.split('\\').join('/');
