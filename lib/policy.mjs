import fs from 'node:fs';
import path from 'node:path';

// One source of truth. Committed as .test-budget/policy.json; the guard stops agents editing it.
export const DEFAULTS = {
  version: 1,
  mode: 'enforce', // enforce | shadow (observe only: nothing is denied or refused, would-be denials are recorded)
  runner: 'auto', // auto | vitest | jest | pytest | junit | generic
  allowAll: false, // `tbudget run --all` (full suite) is CI-only unless you flip this
  timeoutSec: 120,
  failFast: true,
  digest: { maxLines: 24, maxLineChars: 200, stackFrames: 2 },
  loop: { maxAttemptsPerFailure: 3, ttlMin: 60, maxRunsPerWindow: 12, windowMin: 60 },
  guard: {
    blockRawRunners: true,
    blockRunnerCmd: true, // with runner junit/generic: also block the configured command itself when run raw
    inProcess: true, // also refuse vitest/jest/pytest inside the process when started outside tbudget (SessionStart sets it up)
    enforce: ['vitest', 'jest', 'pytest'],
    blockPatterns: [], // extra regexes for commands to block, e.g. "^go test", "^turbo (run )?test"
    preferEditOverRewrite: true,
    rewriteOverlap: 0.6,
    rewriteMinLines: 40,
    protectedPaths: [
      '.test-budget/policy.json',
      '.test-budget/.state',
      '.claude/settings.json',
      '.claude/settings.local.json',
    ],
  },
  testGlobs: ['**/*.test.*', '**/*.spec.*', '**/test_*.py', '**/*_test.py'],
  generic: { cmd: '' }, // e.g. "go test ./... {files}" ; {files} is optional
  // any runner that writes JUnit XML. {report}: a file path tbudget picks; otherwise set `report` to the
  // file or directory the tool writes, e.g. { cmd: "./gradlew test {name}", report: "build/test-results/test" }
  junit: { cmd: '', report: '' },
  mutate: { maxMutants: 12, minScore: 0 }, // `tbudget mutate`: mutants per run; minScore (0-1) > 0 makes it fail below that
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merge(base, over, problems, trail = '') {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!isObj(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (!(k in base)) { problems.push(`unknown key ${trail}${k}`); continue; }
    const b = base[k];
    if (isObj(b)) out[k] = merge(b, v, problems, `${trail}${k}.`);
    else if (Array.isArray(b)) {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v;
      else problems.push(`${trail}${k} must be string[]`);
    } else if (typeof v === typeof b) out[k] = v;
    else problems.push(`${trail}${k} must be ${typeof b}`);
  }
  return out;
}

export function findRoot(start) {
  const from = path.resolve(start);
  for (const marker of [path.join('.test-budget', 'policy.json'), '.git']) {
    let dir = from;
    for (;;) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return from;
}

const clamp = (n, lo, hi) => Math.min(Math.max(Math.floor(n), lo), hi);

export function loadPolicy(cwd) {
  const root = findRoot(cwd);
  const file = path.join(root, '.test-budget', 'policy.json');
  const problems = [];
  let user = {};
  let from = null;
  if (fs.existsSync(file)) {
    from = file;
    try { user = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { problems.push(`policy.json is not valid JSON: ${e.message}`); }
  }
  const policy = merge(DEFAULTS, user, problems);
  for (const p of policy.guard.blockPatterns) {
    try { new RegExp(p); } catch { problems.push(`guard.blockPatterns: invalid regex ${JSON.stringify(p)}`); }
  }
  if (!['enforce', 'shadow'].includes(policy.mode)) {
    problems.push(`mode must be "enforce" or "shadow", got ${JSON.stringify(policy.mode)}; using "enforce"`);
    policy.mode = 'enforce';
  }
  policy.timeoutSec = clamp(policy.timeoutSec, 1, 1800);
  policy.digest.maxLines = clamp(policy.digest.maxLines, 8, 80);
  policy.digest.maxLineChars = clamp(policy.digest.maxLineChars, 40, 400);
  policy.digest.stackFrames = clamp(policy.digest.stackFrames, 0, 6);
  policy.loop.maxAttemptsPerFailure = clamp(policy.loop.maxAttemptsPerFailure, 1, 20);
  policy.loop.ttlMin = clamp(policy.loop.ttlMin, 1, 10080);
  policy.loop.maxRunsPerWindow = clamp(policy.loop.maxRunsPerWindow, 1, 1000);
  policy.loop.windowMin = clamp(policy.loop.windowMin, 1, 10080);
  policy.mutate.maxMutants = clamp(policy.mutate.maxMutants, 1, 60);
  policy.mutate.minScore = Math.min(Math.max(Number(policy.mutate.minScore) || 0, 0), 1);
  return { policy, root, file: from, problems };
}
