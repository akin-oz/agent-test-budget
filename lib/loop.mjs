// Loop breaker: pure functions over the persisted state, so they are testable without running anything.
import crypto from 'node:crypto';
import path from 'node:path';
import { stripAnsi } from './digest.mjs';
import { toPosix } from './shell.mjs';

const MIN = 60_000;

// First meaningful line of a failure: what the assertion actually said.
export function headline(f) {
  const lines = stripAnsi(f.message ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (f.kind === 'py') {
    const e = lines.find((l) => /^E\s/.test(l));
    if (e) return e.replace(/^E\s+/, '');
  }
  return lines.find((l) => !/^at\s/.test(l) && !/^_{3,}/.test(l)) ?? '';
}

// Same test + same complaint (numbers and addresses blurred) = same failure.
export const normalize = (s) => s.toLowerCase().replace(/0x[0-9a-f]+/g, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 200);

export function signature(f) {
  return crypto.createHash('sha1').update(`${f.id}\n${normalize(headline(f))}`).digest('hex').slice(0, 12);
}

export const relTo = (root, cwd, arg) => toPosix(path.relative(root, path.resolve(cwd, String(arg).split('::')[0])));

// target = { rel, kind: 'test' | 'src' | 'dir' }
function touches(targets, file) {
  if (!targets.length || !file) return true; // changed-mode, --all or unknown file: assume it could include it
  return targets.some((t) => {
    if (t.kind === 'src') return true; // related-tests mode may pull the file in
    if (t.kind === 'dir') return t.rel === '' || t.rel === '.' || file.startsWith(`${t.rel.replace(/\/$/, '')}/`);
    return t.rel === file;
  });
}

const lastResetOf = (runs) => runs.filter((r) => r.type === 'reset').reduce((m, r) => Math.max(m, r.ts), 0);

// runs counted against the budget right now (since the last reset, inside the window)
export function budgetUsed({ runs, policy, now = Date.now() }) {
  const lastReset = lastResetOf(runs);
  // a mutate run counts as one: it is many runner executions, but the agent asked for it once
  return runs.filter((r) => (r.type === 'run' || r.type === 'mutate') && r.ts > lastReset && now - r.ts < policy.loop.windowMin * MIN).length;
}

export function checkBefore({ state, runs, policy, targets, now = Date.now() }) {
  const { ttlMin, maxRunsPerWindow } = policy.loop;
  const lastReset = lastResetOf(runs);
  const hit = Object.values(state.failures).filter((e) => e.tripped && e.last > lastReset && now - e.last < ttlMin * MIN && touches(targets, e.file));
  if (hit.length) return { blocked: true, kind: 'repeat', entries: hit };
  const used = budgetUsed({ runs, policy, now });
  if (used >= maxRunsPerWindow) return { blocked: true, kind: 'rate', count: used };
  return { blocked: false, used };
}

// A warning before the hard stop: from 70% of the budget on, every run says how much is left.
export function budgetNote(used, policy) {
  const max = policy.loop.maxRunsPerWindow;
  if (used < Math.ceil(max * 0.7) || used >= max) return null;
  return `tb: run budget ${used}/${max} used in the last ${policy.loop.windowMin} min. Plan the remaining ${max - used}: fix several things per run, then report.`;
}

export function recordAfter({ state, failed, passedIds, policy, now = Date.now() }) {
  const { ttlMin, maxAttemptsPerFailure: max } = policy.loop;
  const next = {};
  for (const [sig, e] of Object.entries(state.failures)) {
    if (now - e.last < ttlMin * MIN && !passedIds.has(e.id)) next[sig] = e;
  }
  const repeats = [];
  const tripped = [];
  for (const f of failed) {
    const sig = signature(f);
    const prev = next[sig];
    const count = (prev?.count ?? 0) + 1;
    const e = { id: f.id, file: f.file ?? null, title: f.title, headline: headline(f).slice(0, 160), count, first: prev?.first ?? now, last: now, tripped: count >= max };
    next[sig] = e;
    if (e.tripped) tripped.push(e);
    else if (count > 1) repeats.push(e);
  }
  return { state: { failures: next }, repeats, tripped };
}
