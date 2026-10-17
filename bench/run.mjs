#!/usr/bin/env node
// A/B harness: the same task, with and without the plugin, judged by an outside test run.
// It spends real money (every run is a full `claude -p` session), so it refuses to start without --yes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ARMS, parseArgs, schedule, worstCaseUsd, pickResult, metricsOf, summarize, renderTable,
  rewriteAgentModel, applyMutant, countTargetTests, allowedChange, targetCmd, mutantOutcome,
} from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');

const opts = parseArgs(process.argv.slice(2));
if (opts.error) { console.error(`bench: ${opts.error}`); process.exit(2); }
const taskDir = path.join(here, 'tasks', opts.task);
if (!fs.existsSync(path.join(taskDir, 'task.json'))) { console.error(`bench: no such task: ${opts.task}`); process.exit(2); }
const task = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'));
const mutants = task.check.mutants ?? [];
const plan = schedule(opts.arms, opts.runs);

// a broken mutant would silently score as "survived", so refuse before spending anything
for (const m of mutants) {
  const src = path.join(taskDir, m.file);
  if (!fs.existsSync(src) || applyMutant(fs.readFileSync(src, 'utf8'), m) === null) {
    console.error(`bench: mutant ${m.id} does not apply exactly once to ${m.file}`);
    process.exit(2);
  }
}

// The plugin arm runs a copy of the plugin whose test-writer uses --subagent-model (default: inherit
// the session model), so both arms are billed for the same model.
const PLUGIN_SKIP = new Set(['bench', 'test', '.git', '.idea', 'node_modules']);
function preparePlugin() {
  if (opts.subagentModel === 'shipped') return pluginRoot;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbud-plugin-'));
  fs.cpSync(pluginRoot, dir, { recursive: true, filter: (p) => !PLUGIN_SKIP.has(path.relative(pluginRoot, p).split(path.sep)[0]) });
  const agent = path.join(dir, 'agents', 'test-writer.md');
  fs.writeFileSync(agent, rewriteAgentModel(fs.readFileSync(agent, 'utf8'), opts.subagentModel));
  return dir;
}

const claudeArgs = (arm, pluginDir) => [
  '-p', task.prompt,
  '--output-format', 'json',
  '--permission-mode', 'acceptEdits',
  '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep,Task,Agent',
  '--setting-sources', 'project', // keep personal settings out of both arms
  '--no-session-persistence',
  '--max-budget-usd', String(opts.maxBudget),
  ...(opts.model ? ['--model', opts.model] : []),
  ...(ARMS[arm].pluginDir ? ['--plugin-dir', pluginDir] : []),
];

const pluginDir = () => (cache.plugin ??= preparePlugin());
const cache = {};

console.log(`task: ${task.id} | arms: ${opts.arms.join(', ')} | runs per arm: ${opts.runs} | model: ${opts.model || '(default)'} | test-writer model: ${opts.subagentModel}`);
console.log(`judge: suite green, ${task.check.minTests}+ tests in ${task.check.testFiles.join(', ')}, nothing else in ${task.check.sourceDir}/ changed${mutants.length ? `, ${Math.round((task.check.minMutationScore ?? 0) * 100)}%+ of ${mutants.length} mutants killed` : ''}`);
console.log(`worst-case spend: $${worstCaseUsd(opts).toFixed(2)} (${plan.length} sessions x $${opts.maxBudget} cap; the cap is soft, a session can overshoot slightly)`);
console.log(`example: claude ${claudeArgs(opts.arms[0], '<plugin copy>').map((a) => (/\s/.test(a) ? JSON.stringify(a.slice(0, 40) + '...') : a)).join(' ')}`);
const sh = (cmd, args, cwd, extra = {}) => spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...extra });
const env = { ...process.env, CI: '1' };

async function prepare() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbud-bench-'));
  fs.cpSync(taskDir, dir, { recursive: true, filter: (p) => !['task.json', 'generate.mjs'].includes(path.relative(taskDir, p)) });
  const gen = path.join(taskDir, 'generate.mjs');
  if (fs.existsSync(gen)) (await import(pathToFileURL(gen).href)).default(dir); // e.g. a large pre-existing suite
  sh('git', ['init', '-q'], dir);
  sh('git', ['config', 'user.email', 'bench@example.com'], dir);
  sh('git', ['config', 'user.name', 'bench'], dir);
  const i = sh('npm', ['install', '--silent', '--no-audit', '--no-fund'], dir);
  if (i.status !== 0) throw new Error(`npm install failed: ${i.stderr}`);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.test-budget/.state\n');
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '-qm', 'baseline'], dir);
  return dir;
}

function runClaude(arm, dir, pluginDir) {
  return new Promise((resolve) => {
    const child = spawn('claude', claudeArgs(arm, pluginDir), { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('close', (code) => resolve({ code, out, err }));
    child.on('error', (e) => resolve({ code: 127, out, err: String(e) }));
  });
}

// Test quality: re-run only the agent's test files against hand-written bugs. A mutant counts as killed
// when a test fails (or the run hangs into the timeout). The original source is always restored.
// The narrowed command must pass on the unmutated code first, or every "kill" would be noise.
function mutationScore(dir) {
  const [cmd, ...args] = targetCmd(task.check.cmd, task.check.testFiles);
  const run = () => sh(cmd, args, dir, { env, timeout: 120_000 });
  const base = { killed: 0, total: mutants.length, survived: [], errors: [] };
  if (mutantOutcome(run()) !== 'survived') return { ...base, score: NaN, errors: ['unmutated run did not pass: mutation score not measured'] };
  for (const m of mutants) {
    const file = path.join(dir, m.file);
    const orig = fs.readFileSync(file, 'utf8');
    const mutated = applyMutant(orig, m);
    if (mutated === null) { base.errors.push(`${m.id}: did not apply`); continue; }
    fs.writeFileSync(file, mutated);
    try {
      const outcome = mutantOutcome(run());
      if (outcome === 'killed') base.killed++;
      else if (outcome === 'survived') base.survived.push(m.id);
      else base.errors.push(`${m.id}: runner error`);
    } finally {
      fs.writeFileSync(file, orig);
    }
  }
  return { ...base, score: base.errors.length ? NaN : base.killed / mutants.length };
}

// Judged outside the agent, with the real runner: the agent cannot grade itself.
function judge(dir) {
  const r = sh(task.check.cmd[0], task.check.cmd.slice(1), dir, { env, timeout: 600_000 });
  let tests = 0;
  let passed = false;
  try {
    const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
    tests = countTargetTests(j, task.check.testFiles); // the agent's tests, not the pre-existing suite
    passed = r.status === 0 && j.numFailedTests === 0;
  } catch { /* unparsable output counts as a failure */ }
  const filesOk = task.check.testFiles.every((f) => fs.existsSync(path.join(dir, f)));
  const changed = sh('git', ['status', '--porcelain', '-uall', '--', task.check.sourceDir], dir).stdout.split('\n').filter((l) => l.trim());
  const srcTouched = changed.some((l) => !allowedChange(l, task.check.testFiles));
  const mutation = passed && filesOk && !srcTouched ? mutationScore(dir) : { killed: 0, total: mutants.length, score: mutants.length ? 0 : NaN, survived: [], errors: [] };
  // an unmeasurable score (runner errors) fails the run rather than passing it unchecked
  const qualityOk = !mutants.length || mutation.score >= (task.check.minMutationScore ?? 0);
  return { ok: passed && filesOk && !srcTouched && tests >= task.check.minTests && qualityOk, tests, passed, filesOk, srcTouched, mutation };
}

function tbudgetStats(dir) {
  try {
    const recs = fs.readFileSync(path.join(dir, '.test-budget/.state/runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    return { tbRuns: recs.filter((r) => r.type === 'run').length, denies: recs.filter((r) => r.type === 'deny').length };
  } catch { return { tbRuns: 0, denies: 0 }; }
}

// task authoring, no spend: build a repo, write a reference suite into it, then judge it
if (opts.prepareOnly) { console.log(await prepare()); process.exit(0); }
if (opts.judge) { console.log(JSON.stringify(judge(path.resolve(opts.judge)), null, 2)); process.exit(0); }
if (opts.dryRun) process.exit(0);
if (!opts.yes) { console.error('bench: this spends real money. Re-run with --yes to start (or --dry-run to only print the plan).'); process.exit(2); }

const rows = [];
for (const { arm, run } of plan) {
  process.stdout.write(`[${rows.length + 1}/${plan.length}] ${arm} #${run} ... `);
  let row;
  try {
    const dir = await prepare();
    const res = await runClaude(arm, dir, ARMS[arm].pluginDir ? pluginDir() : null);
    let metrics;
    try { metrics = metricsOf(pickResult(res.out)); } catch { metrics = metricsOf(null); }
    const verdict = judge(dir);
    row = { arm, run, dir, metrics, ...verdict, ...tbudgetStats(dir), exit: res.code };
  } catch (e) {
    row = { arm, run, metrics: metricsOf(null), ok: false, tests: 0, error: String(e.message ?? e) };
  }
  rows.push(row);
  const mut = row.mutation?.total ? ` | ${row.mutation.killed}/${row.mutation.total} mutants killed` : '';
  const models = row.metrics.models?.length ? ` | ${row.metrics.models.join('+')}` : '';
  console.log(`${row.ok ? 'ok' : 'FAILED'} | $${Number.isFinite(row.metrics.costUsd) ? row.metrics.costUsd.toFixed(3) : '?'} | ${row.metrics.turns} turns | ${row.tests} tests${mut}${models}${row.error ? ` | ${row.error}` : ''}`);
}

const summary = summarize(rows);
const table = renderTable(summary);
console.log(`\n${table}`);
const outDir = opts.out || path.join(here, 'results');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(path.join(outDir, `${task.id}-${stamp}.json`), JSON.stringify({ task: task.id, opts, rows, summary }, null, 2));
fs.writeFileSync(path.join(outDir, `${task.id}-${stamp}.md`), `${table}\n`);
console.log(`\nsaved to ${outDir}`);
