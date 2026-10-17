import fs from 'node:fs';
import path from 'node:path';

export function paths(root) {
  const dir = path.join(root, '.test-budget');
  const st = path.join(dir, '.state');
  return {
    dir,
    st,
    policy: path.join(dir, 'policy.json'),
    state: path.join(st, 'state.json'),
    runs: path.join(st, 'runs.jsonl'),
    log: path.join(st, 'last-run.log'),
    errors: path.join(st, 'errors.log'),
  };
}

export function ensure(root) {
  const p = paths(root);
  fs.mkdirSync(p.st, { recursive: true });
  const gi = path.join(p.dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '.state/\n');
  return p;
}

export function readState(root) {
  try {
    const s = JSON.parse(fs.readFileSync(paths(root).state, 'utf8'));
    return { failures: s.failures ?? {} };
  } catch {
    return { failures: {} };
  }
}

export function writeState(root, state) {
  const p = ensure(root);
  const tmp = `${p.state}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, p.state);
}

export function appendRun(root, rec) {
  try {
    const p = ensure(root);
    fs.appendFileSync(p.runs, JSON.stringify({ ts: Date.now(), ...rec }) + '\n');
  } catch { /* logging must never break a run */ }
}

// For hooks that fire in every session (start, end): record only in projects that use the plugin,
// so a user-wide install does not leave a .test-budget/ folder in every repository it touches.
export function appendRunIfTracked(root, rec) {
  if (fs.existsSync(paths(root).dir)) appendRun(root, rec);
}

export function readRuns(root, limit = 1000) {
  try {
    const lines = fs.readFileSync(paths(root).runs, 'utf8').trim().split('\n').slice(-limit);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

// Keep the audit log from growing without bound: past 1 MB keep the newest 2000 records.
export function trimRuns(root) {
  try {
    const f = paths(root).runs;
    if (fs.statSync(f).size < 1_000_000) return;
    const keep = fs.readFileSync(f, 'utf8').trim().split('\n').slice(-2000);
    fs.writeFileSync(f, `${keep.join('\n')}\n`);
  } catch { /* nothing to trim */ }
}

export function logError(root, err) {
  try {
    const p = ensure(root);
    fs.appendFileSync(p.errors, `${new Date().toISOString()} ${err?.stack ?? err}\n`);
  } catch { /* ignore */ }
}
