// Pure helpers for the A/B harness, kept separate so they can be unit-tested without spending anything.

export const ARMS = {
  baseline: { label: 'baseline (no plugin)', pluginDir: false },
  plugin: { label: 'agent-test-budget', pluginDir: true },
};

export function parseArgs(argv) {
  const o = { task: 'slugify-cart', runs: 3, arms: ['baseline', 'plugin'], model: '', subagentModel: 'inherit', maxBudget: 2, yes: false, dryRun: false, out: '', prepareOnly: false, judge: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--task') o.task = val();
    else if (a === '--runs') o.runs = Number(val());
    else if (a === '--arms') o.arms = String(val()).split(',').filter(Boolean);
    else if (a === '--model') o.model = val();
    else if (a === '--subagent-model') o.subagentModel = val();
    else if (a === '--max-budget-usd') o.maxBudget = Number(val());
    else if (a === '--out') o.out = val();
    else if (a === '--yes') o.yes = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--prepare-only') o.prepareOnly = true; // no spend: build one task repo and print its path
    else if (a === '--judge') o.judge = val(); // no spend: judge an existing task repo
    else return { error: `unknown argument ${a}` };
  }
  if (!Number.isInteger(o.runs) || o.runs < 1 || o.runs > 20) return { error: '--runs must be an integer from 1 to 20' };
  if (!(o.maxBudget > 0)) return { error: '--max-budget-usd must be a positive number' };
  if (!/^[\w.:-]+$/.test(o.subagentModel ?? '')) return { error: '--subagent-model takes inherit (default), shipped, or a model name' };
  const bad = o.arms.filter((a) => !ARMS[a]);
  if (bad.length || !o.arms.length) return { error: `--arms takes: ${Object.keys(ARMS).join(', ')}` };
  return o;
}

// Interleave arms (A B A B ...) so drift in model behaviour or load hits both equally.
export function schedule(arms, runs) {
  return Array.from({ length: runs }, (_, r) => arms.map((arm) => ({ arm, run: r + 1 }))).flat();
}

export const worstCaseUsd = (o) => o.runs * o.arms.length * o.maxBudget;

// `claude -p --output-format json` prints one result object (older versions print an array of events).
export function pickResult(stdout) {
  const parsed = JSON.parse(stdout);
  if (Array.isArray(parsed)) return parsed.findLast?.((e) => e?.type === 'result') ?? [...parsed].reverse().find((e) => e?.type === 'result') ?? null;
  return parsed;
}

export function metricsOf(result) {
  const u = result?.usage ?? {};
  return {
    costUsd: Number(result?.total_cost_usd ?? NaN),
    turns: Number(result?.num_turns ?? NaN),
    durationMs: Number(result?.duration_ms ?? NaN),
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    isError: Boolean(result?.is_error),
    models: Object.keys(result?.modelUsage ?? {}),
    subtype: result?.subtype ?? '',
  };
}

const finite = (xs) => xs.filter((x) => Number.isFinite(x));
export const mean = (xs) => { const f = finite(xs); return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN; };
export const median = (xs) => {
  const f = finite(xs).sort((a, b) => a - b);
  if (!f.length) return NaN;
  const m = Math.floor(f.length / 2);
  return f.length % 2 ? f[m] : (f[m - 1] + f[m]) / 2;
};

// rows: [{ arm, ok, metrics, tests, tbRuns, denies }]
export function summarize(rows) {
  const out = {};
  for (const arm of new Set(rows.map((r) => r.arm))) {
    const mine = rows.filter((r) => r.arm === arm);
    const good = mine.filter((r) => r.ok);
    out[arm] = {
      n: mine.length,
      ok: good.length,
      costMean: mean(mine.map((r) => r.metrics.costUsd)),
      costMedian: median(mine.map((r) => r.metrics.costUsd)),
      costPerSuccess: good.length ? mine.reduce((a, r) => a + (r.metrics.costUsd || 0), 0) / good.length : NaN,
      turnsMean: mean(mine.map((r) => r.metrics.turns)),
      outputTokensMean: mean(mine.map((r) => r.metrics.outputTokens)),
      secondsMean: mean(mine.map((r) => r.metrics.durationMs / 1000)),
      testsMean: mean(mine.map((r) => r.tests)),
      mutationMean: mean(mine.map((r) => r.mutation?.score)),
      models: [...new Set(mine.flatMap((r) => r.metrics.models ?? []))],
    };
  }
  return out;
}

const usd = (x) => (Number.isFinite(x) ? `$${x.toFixed(3)}` : 'n/a');
const num = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');
const share = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : 'n/a');
const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? `${a <= b ? '' : '+'}${(((a - b) / b) * 100).toFixed(0)}%` : 'n/a');

export function renderTable(summary) {
  const arms = Object.keys(summary);
  const head = '| arm | runs | success | cost mean | cost median | cost / success | turns | out tokens | seconds | tests | mutants killed |';
  const rule = '|---|---|---|---|---|---|---|---|---|---|---|';
  const rows = arms.map((a) => {
    const s = summary[a];
    return `| ${ARMS[a]?.label ?? a} | ${s.n} | ${s.ok}/${s.n} | ${usd(s.costMean)} | ${usd(s.costMedian)} | ${usd(s.costPerSuccess)} | ${num(s.turnsMean)} | ${num(s.outputTokensMean, 0)} | ${num(s.secondsMean, 0)} | ${num(s.testsMean)} | ${share(s.mutationMean)} |`;
  });
  const lines = [head, rule, ...rows];
  if (summary.baseline && summary.plugin) {
    const b = summary.baseline;
    const p = summary.plugin;
    lines.push('', `Plugin vs baseline: cost mean ${pct(p.costMean, b.costMean)}, cost per successful run ${pct(p.costPerSuccess, b.costPerSuccess)}, turns ${pct(p.turnsMean, b.turnsMean)}, success ${p.ok}/${p.n} vs ${b.ok}/${b.n}.`);
    lines.push(`Mutants killed (test quality): ${share(p.mutationMean)} vs ${share(b.mutationMean)}.`);
    const models = (s) => (s.models.length ? s.models.join(', ') : 'unknown');
    lines.push(`Models billed: plugin ${models(p)}; baseline ${models(b)}.`);
    if (p.n < 5 || b.n < 5) lines.push('With fewer than 5 runs per arm this is an anecdote, not a measurement: run-to-run variance is large.');
  }
  return lines.join('\n');
}

// The shipped test-writer pins `model: sonnet`. Left alone, `--model opus` would compare Opus against
// Opus-delegating-to-Sonnet and credit the plugin for a cheaper model. Default: inherit the session model.
export function rewriteAgentModel(md, model) {
  if (model === 'shipped') return md;
  if (/^model:.*$/m.test(md)) return md.replace(/^model:.*$/m, `model: ${model}`);
  return md.replace(/^---\n/, `---\nmodel: ${model}\n`);
}

// A mutant is one exact, unique edit to a source file; anything else is a broken task definition.
export function applyMutant(text, m) {
  const at = text.indexOf(m.find);
  if (at < 0 || text.indexOf(m.find, at + 1) >= 0) return null;
  return text.slice(0, at) + m.replace + text.slice(at + m.find.length);
}

const posix = (p) => String(p).split('\\').join('/');

// passed tests in the files the agent was asked to write, not in the whole (pre-existing) suite
export function countTargetTests(report, testFiles) {
  let n = 0;
  for (const s of report?.testResults ?? []) {
    if (!testFiles.some((f) => posix(s.name).endsWith(`/${f}`))) continue;
    n += (s.assertionResults ?? []).filter((a) => a.status === 'passed').length;
  }
  return n;
}

// the judge command narrowed to the target test files: right after `run`, so no option swallows them
export function targetCmd(cmd, testFiles) {
  const i = cmd.indexOf('run');
  return i < 0 ? [...cmd, ...testFiles] : [...cmd.slice(0, i + 1), ...testFiles, ...cmd.slice(i + 1)];
}

// A mutant is killed only by a test that fails (or a hang). A run that crashed without a report says
// nothing about the tests, so it is an error, not a kill.
export function mutantOutcome(r) {
  if (r.error?.code === 'ETIMEDOUT' || r.signal) return 'killed';
  try {
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    if (j.numFailedTests > 0 || j.numFailedTestSuites > 0) return 'killed';
    return r.status === 0 ? 'survived' : 'error';
  } catch { return 'error'; }
}

// one `git status --porcelain` line: is this a file the task allows the agent to create or change?
export function allowedChange(line, testFiles) {
  const file = line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, '');
  return testFiles.includes(file);
}
