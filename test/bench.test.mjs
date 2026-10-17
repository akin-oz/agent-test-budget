import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseArgs, schedule, worstCaseUsd, pickResult, metricsOf, summarize, renderTable, median,
  rewriteAgentModel, applyMutant, countTargetTests, allowedChange, targetCmd, mutantOutcome,
} from '../bench/lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = path.join(ROOT, 'bench', 'run.mjs');
const TASKS = path.join(ROOT, 'bench', 'tasks');

test('parseArgs: defaults, overrides and refusals', () => {
  assert.deepEqual(parseArgs([]).arms, ['baseline', 'plugin']);
  const o = parseArgs(['--runs', '5', '--model', 'sonnet', '--max-budget-usd', '1.5', '--yes']);
  assert.equal(o.runs, 5); assert.equal(o.model, 'sonnet'); assert.equal(o.maxBudget, 1.5); assert.equal(o.yes, true);
  for (const bad of [['--runs', '0'], ['--runs', '99'], ['--arms', 'nope'], ['--max-budget-usd', '-1'], ['--wat']]) assert.ok(parseArgs(bad).error, bad.join(' '));
});

test('schedule interleaves arms and worst case is runs x arms x cap', () => {
  assert.deepEqual(schedule(['baseline', 'plugin'], 2).map((s) => `${s.arm}${s.run}`), ['baseline1', 'plugin1', 'baseline2', 'plugin2']);
  assert.equal(worstCaseUsd({ runs: 3, arms: ['a', 'b'], maxBudget: 2 }), 12);
});

test('pickResult handles object and event-array output; metricsOf survives gaps', () => {
  const r = { type: 'result', total_cost_usd: 0.12, num_turns: 7, duration_ms: 4000, usage: { input_tokens: 10, output_tokens: 20 } };
  assert.equal(pickResult(JSON.stringify(r)).num_turns, 7);
  assert.equal(pickResult(JSON.stringify([{ type: 'system' }, r])).total_cost_usd, 0.12);
  assert.deepEqual([metricsOf(r).costUsd, metricsOf(r).outputTokens], [0.12, 20]);
  assert.ok(Number.isNaN(metricsOf(null).costUsd));
});

const row = (arm, cost, turns, ok) => ({ arm, ok, tests: 20, metrics: { costUsd: cost, turns, durationMs: 1000, outputTokens: 100 } });

test('summary and table: cost per success punishes cheap failures', () => {
  const s = summarize([row('baseline', 1, 10, true), row('baseline', 3, 20, true), row('plugin', 0.5, 5, true), row('plugin', 0.5, 5, false)]);
  assert.equal(s.baseline.costMean, 2);
  assert.equal(s.plugin.costPerSuccess, 1);
  const t = renderTable(s);
  assert.match(t, /\| agent-test-budget \| 2 \| 1\/2 \|/);
  assert.match(t, /Plugin vs baseline: cost mean -75%, cost per successful run -50%/);
  assert.match(t, /anecdote/);
  assert.equal(median([3, 1, 2]), 2);
});

test('run.mjs refuses to spend without --yes, and --dry-run never starts a session', () => {
  const noYes = spawnSync(process.execPath, [RUN, '--runs', '1'], { encoding: 'utf8' });
  assert.equal(noYes.status, 2);
  assert.match(noYes.stderr, /spends real money/);
  const dry = spawnSync(process.execPath, [RUN, '--runs', '2', '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /worst-case spend: \$8\.00/);
  assert.match(dry.stdout, /--plugin-dir|--setting-sources project/);
});

test('the test-writer model follows the session unless asked otherwise', () => {
  const md = fs.readFileSync(path.join(ROOT, 'agents', 'test-writer.md'), 'utf8');
  assert.match(md, /^model: inherit$/m); // what ships: the session model, not a cheaper one picked for you
  assert.match(rewriteAgentModel(md, 'sonnet'), /^model: sonnet$/m);
  assert.match(rewriteAgentModel(md, 'inherit'), /^model: inherit$/m);
  assert.doesNotMatch(rewriteAgentModel(md, 'inherit'), /model: sonnet/);
  assert.equal(rewriteAgentModel(md, 'shipped'), md);
  assert.match(rewriteAgentModel('---\nname: x\n---\n', 'opus'), /^---\nmodel: opus\nname: x/);
  assert.equal(parseArgs([]).subagentModel, 'inherit');
  assert.equal(parseArgs(['--subagent-model', 'shipped']).subagentModel, 'shipped');
  assert.ok(parseArgs(['--subagent-model', 'a b']).error);
  assert.deepEqual(metricsOf({ modelUsage: { 'claude-opus-5-5': {}, 'claude-sonnet-5-5': {} } }).models, ['claude-opus-5-5', 'claude-sonnet-5-5']);
});

test('every shipped task mutant applies exactly once to its source file', () => {
  for (const id of fs.readdirSync(TASKS)) {
    const task = JSON.parse(fs.readFileSync(path.join(TASKS, id, 'task.json'), 'utf8'));
    assert.ok(task.check.mutants?.length >= 8, `${id}: too few mutants`);
    assert.ok(task.check.minMutationScore > 0, `${id}: no quality bar`);
    assert.equal(new Set(task.check.mutants.map((m) => m.id)).size, task.check.mutants.length, `${id}: duplicate ids`);
    for (const m of task.check.mutants) {
      const src = fs.readFileSync(path.join(TASKS, id, m.file), 'utf8');
      const out = applyMutant(src, m);
      assert.ok(out !== null && out !== src, `${id}/${m.id}`);
    }
  }
  assert.equal(applyMutant('a a', { find: 'a', replace: 'b' }), null); // ambiguous
  assert.equal(applyMutant('abc', { find: 'x', replace: 'y' }), null); // missing
});

test('judge helpers: target tests, allowed changes, narrowed command, mutant outcomes', () => {
  const report = { testResults: [
    { name: '/tmp/x/src/pricing.test.ts', assertionResults: [{ status: 'passed' }, { status: 'passed' }, { status: 'failed' }] },
    { name: '/tmp/x/src/legacy/m01.test.ts', assertionResults: [{ status: 'passed' }] },
  ] };
  assert.equal(countTargetTests(report, ['src/pricing.test.ts']), 2);
  assert.ok(allowedChange('?? src/pricing.test.ts', ['src/pricing.test.ts']));
  assert.ok(!allowedChange(' M src/legacy/m01.test.ts', ['src/pricing.test.ts']));
  assert.ok(!allowedChange(' M src/pricing.ts', ['src/pricing.test.ts']));
  assert.deepEqual(targetCmd(['npx', 'vitest', 'run', '--reporter=json', '--silent=true'], ['a.test.ts']),
    ['npx', 'vitest', 'run', 'a.test.ts', '--reporter=json', '--silent=true']);
  const json = (o) => `noise ${JSON.stringify(o)}`;
  assert.equal(mutantOutcome({ status: 1, stdout: json({ numFailedTests: 2 }) }), 'killed');
  assert.equal(mutantOutcome({ status: 0, stdout: json({ numFailedTests: 0 }) }), 'survived');
  assert.equal(mutantOutcome({ status: 1, stdout: 'TypeError: bad flag' }), 'error'); // a crash is not a kill
  assert.equal(mutantOutcome({ status: null, signal: 'SIGTERM', stdout: '', error: { code: 'ETIMEDOUT' } }), 'killed');
});

test('summary reports mutation score and the models billed', () => {
  const r = (arm, score, models) => ({ arm, ok: true, tests: 20, mutation: { score }, metrics: { costUsd: 1, turns: 5, durationMs: 1000, outputTokens: 100, models } });
  const s = summarize([r('baseline', 0.5, ['claude-opus-5-5']), r('plugin', 1, ['claude-opus-5-5'])]);
  assert.equal(s.plugin.mutationMean, 1);
  const t = renderTable(s);
  assert.match(t, /\| mutants killed \|/);
  assert.match(t, /Mutants killed \(test quality\): 100% vs 50%/);
  assert.match(t, /Models billed: plugin claude-opus-5-5; baseline claude-opus-5-5/);
});

test('big-suite generator writes a deterministic 40-module legacy suite', async () => {
  const { default: generate, MODULES, TESTS_PER_MODULE } = await import(pathToFileURL(path.join(TASKS, 'big-suite', 'generate.mjs')).href);
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'tbud-gen-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'tbud-gen-'));
  generate(a);
  generate(b);
  const files = fs.readdirSync(path.join(a, 'src', 'legacy')).sort();
  assert.equal(files.length, MODULES * 2);
  for (const f of files) assert.equal(fs.readFileSync(path.join(a, 'src/legacy', f), 'utf8'), fs.readFileSync(path.join(b, 'src/legacy', f), 'utf8'));
  assert.match(fs.readFileSync(path.join(a, 'src/legacy/m04.ts'), 'utf8'), /console\.warn/);
  assert.match(fs.readFileSync(path.join(a, 'src/legacy/m01.test.ts'), 'utf8'), new RegExp(`length: ${TESTS_PER_MODULE}`));
});

test('dry run names the test-writer model and the mutation bar', () => {
  const dry = spawnSync(process.execPath, [RUN, '--task', 'big-suite', '--runs', '1', '--dry-run'], { encoding: 'utf8' });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /test-writer model: inherit/);
  assert.match(dry.stdout, /70%\+ of 10 mutants killed/);
});
