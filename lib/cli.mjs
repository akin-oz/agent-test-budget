import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from './policy.mjs';
import { ensure, paths, readState, writeState, appendRun, readRuns, logError, trimRuns } from './state.mjs';
import { detectRunner, plan, execute } from './runner.mjs';
import { parseJestLike, parsePytestXml, parseJUnit, readJUnit, renderFailures, digestGeneric, stripAnsi } from './digest.mjs';
import { checkBefore, recordAfter, relTo, budgetNote, budgetUsed } from './loop.mjs';
import { generateMutants, applyAt } from './mutate.mjs';
import { brief } from './brief.mjs';
import { globToRegExp, toPosix } from './shell.mjs';

export const HELP = [
  'tbudget - scoped, capped, loop-safe test runs',
  '  tbudget run [file|dir ...] [-t name]   run only these tests; one summary line on success (-k works too)',
  '  tbudget run <src-file>                 run the tests related to that source file',
  '  tbudget run                            run tests related to uncommitted changes',
  '  tbudget brief <src-file>               exports + existing tests + one style exemplar',
  '  tbudget mutate <src-file> [--tests f..] do the tests catch small bugs in this file? (test quality)',
  '  tbudget stats                          what the guard and runner kept out of context',
  '  tbudget report                         shadow-mode summary: what enforcement would have stopped',
  '  tbudget reset [--reason "..."]         human only: clear loop-breaker state and run budget',
  'full output of the last run: .test-budget/.state/last-run.log',
];

// what a human pastes into their own terminal: the CLI is only on the agent's PATH
const RESET_CMD = `node ${JSON.stringify(fileURLToPath(new URL('../bin/tbudget', import.meta.url)))} reset --reason "<why>"`;

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const ago = (ms) => `${Math.max(1, Math.round(ms / 60000))} min`;
const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function parseRunArgs(args) {
  const o = { files: [], all: false, name: '' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--all') o.all = true;
    else if (a === '-t' || a === '--test' || a === '-k') {
      o.name = args[++i] ?? '';
      if (!o.name) return { error: `${a} needs a test name` };
    } else if (a.startsWith('--test=')) o.name = a.slice(7);
    else if (a.startsWith('-')) return { error: `unknown flag ${a}. Supported: --all, -t <test name> (-k is the same)` };
    else o.files.push(a);
  }
  return o;
}

// Keep the whole answer inside policy.digest.maxLines; the footer always survives.
function cap(head, footer, maxLines) {
  const room = Math.max(1, maxLines - footer.length);
  return [...head.slice(0, room), ...footer];
}

// What one runner execution means: the parsed report, if there is one, and the verdict.
function verdict({ pl, res, runner, files, root, cwd }) {
  let parsed = null;
  try {
    if (pl.report === 'json' && fs.existsSync(pl.outFile)) parsed = parseJestLike(JSON.parse(fs.readFileSync(pl.outFile, 'utf8')), root);
    else if (pl.report === 'junit' && fs.existsSync(pl.outFile)) parsed = parsePytestXml(fs.readFileSync(pl.outFile, 'utf8'), { root, cwd });
    else if (pl.report === 'junit-any') {
      const xml = readJUnit(pl.outFile, pl.since);
      if (xml) parsed = parseJUnit(xml, { root, cwd });
    }
  } catch (e) { logError(root, e); }
  // no JUnit report: judge by the exit code like the generic runner
  const noReport = pl.report === 'junit-any' && !parsed;
  const kind = noReport ? 'none' : pl.report;
  const c = parsed?.counts;
  const failedN = c?.failed ?? 0;
  // pytest exits 5 when it collected nothing: zero tests, not a runner error
  const noTests = runner === 'pytest' && res.code === 5;
  const ran = c ? c.passed + c.failed : noTests ? 0 : null;
  let status;
  if (res.timedOut) status = 'TIMEOUT';
  else if (failedN > 0 || (!parsed && res.code !== 0 && kind === 'none')) status = 'FAIL';
  else if (noTests) status = files.length ? 'NO TESTS' : 'PASS';
  else if (!parsed && kind !== 'none') status = res.code === 0 ? 'PASS' : 'ERROR';
  else if (res.code !== 0) status = 'ERROR';
  else if (ran === 0 && files.length) status = 'NO TESTS';
  else status = 'PASS';
  return { parsed, status, ran, noReport };
}

async function run(args, { cwd, root, policy, problems, out }) {
  const opt = parseRunArgs(args);
  if (opt.error) { out(`tb: ${opt.error}`); return 2; }
  if (opt.all && opt.files.length) { out('tb: pass files or --all, not both'); return 2; }
  if (opt.all && !policy.allowAll) {
    out('tb: --all is disabled by policy.allowAll (the full suite is a CI job). Run the affected tests: tbudget run <test-file|src-file>');
    return 2;
  }
  for (const f of opt.files) {
    if (!fs.existsSync(path.resolve(cwd, f.split('::')[0]))) { out(`tb: not found: ${f}. Pass an existing test file, directory or source file.`); return 2; }
  }
  const isTest = (f) => policy.testGlobs.some((g) => globToRegExp(g).test(toPosix(f).replace(/^\.\//, '')));
  const targets = opt.files.map((f) => {
    const rel = relTo(root, cwd, f);
    const isDir = fs.statSync(path.resolve(cwd, f.split('::')[0])).isDirectory();
    return { rel, kind: isDir ? 'dir' : isTest(rel) || f.includes('::') ? 'test' : 'src' };
  });
  if (targets.some((t) => t.kind === 'src') && targets.some((t) => t.kind !== 'src')) {
    out('tb: pass test files/dirs OR source files, not a mix');
    return 2;
  }
  const runner = detectRunner(cwd, root, policy);
  if (!runner) {
    out('tb: no test runner detected. Set "runner" in .test-budget/policy.json (vitest | jest | pytest | junit + junit.cmd | generic + generic.cmd).');
    return 2;
  }
  if (runner === 'generic' && !policy.generic.cmd) { out('tb: runner "generic" needs generic.cmd in .test-budget/policy.json'); return 2; }
  if (runner === 'junit' && !policy.junit.cmd) { out('tb: runner "junit" needs junit.cmd (and junit.report unless the cmd uses {report}) in .test-budget/policy.json'); return 2; }

  const head = problems.length ? [`tb: policy warning: ${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}`] : [];

  // 1. refuse before spending anything (shadow mode: record it and run anyway)
  const shadow = policy.mode === 'shadow';
  const state = readState(root);
  const runs = readRuns(root);
  const gate = checkBefore({ state, runs, policy, targets });
  if (gate.blocked && shadow) appendRun(root, { type: 'would-block', kind: gate.kind });
  else if (gate.blocked) {
    appendRun(root, { type: 'block', kind: gate.kind });
    if (gate.kind === 'repeat') {
      out(`tb: STOP - the same failure repeated ${policy.loop.maxAttemptsPerFailure}x, so runs touching it are refused:`);
      for (const e of gate.entries.slice(0, 3)) out(`✗ ${e.title}\n  ${e.headline}`);
      out(`Do not re-run it. Report the failure and your best hypothesis to the user, or take a different approach.`);
      out(`(clears after ${policy.loop.ttlMin} min without a repeat. To clear it now, a human runs: ${RESET_CMD})`);
    } else {
      out(`tb: STOP - run budget used: ${gate.count} runs in the last ${policy.loop.windowMin} min (limit ${policy.loop.maxRunsPerWindow}).`);
      out('Stop running tests. Summarize what passes, what fails and what you tried, and hand back to the user.');
      out(`(to lift it now, a human runs: ${RESET_CMD})`);
    }
    return 3;
  }

  // 2. run
  const p = ensure(root);
  const report = path.join(p.st, runner === 'pytest' || runner === 'junit' ? 'report.xml' : 'report.json');
  fs.rmSync(report, { force: true });
  const pl = plan(runner, { files: opt.files, all: opt.all, name: opt.name, policy, root, cwd, outFile: report });
  if (pl.none) {
    out(`tb: no test file found for ${opt.files.length ? opt.files.join(', ') : 'the changed files'}. Create one (tbudget brief <src-file>) or pass test files explicitly.`);
    return 0;
  }
  const res = await execute(pl, { cwd, timeoutSec: policy.timeoutSec });
  const clean = stripAnsi(res.output);
  const logRel = toPosix(path.relative(cwd, p.log));
  fs.writeFileSync(
    p.log,
    `$ ${[pl.cmd, ...pl.args].join(' ')}\n# exit=${res.code} signal=${res.signal ?? ''} ms=${res.ms}${res.timedOut ? ' TIMEOUT' : ''}${res.truncated ? ' (output truncated at 8 MB)' : ''}\n\n${clean}`,
  );

  // 3. digest
  const { parsed, status, ran, noReport } = verdict({ pl, res, runner, files: opt.files, root, cwd });
  if (noReport) head.push(`tb: no JUnit XML found at ${toPosix(path.relative(cwd, pl.outFile)) || '.'}; judged by exit code only. Check junit.report.`);
  const c = parsed?.counts;

  const scope = opt.all ? 'full suite' : opt.files.length ? plural(opt.files.length, 'target') : 'changed files';
  const counts = c
    ? [c.failed ? `${c.failed} failed` : '', `${c.passed} passed`, c.skipped ? `${c.skipped} skipped` : ''].filter(Boolean).join(', ')
    : `exit ${res.code}`;
  const lines = [`tb: ${status} ${runner} | ${counts} | ${(res.ms / 1000).toFixed(1)}s | ${scope}${opt.name ? ` | ${runner === 'pytest' ? '-k' : '-t'} ${opt.name}` : ''}`];
  const dopts = { root, ...policy.digest };

  let loopNotes = [];
  let trippedN = 0;
  if (status === 'FAIL' && parsed?.failed.length) {
    lines.push(...renderFailures(parsed.failed, dopts));
  } else if (status === 'FAIL' || status === 'ERROR') {
    lines.push(...digestGeneric(clean, dopts));
  } else if (status === 'TIMEOUT') {
    lines.push(`runner killed after ${policy.timeoutSec}s (policy.timeoutSec). Likely a hang: unresolved promise, open handle, watch mode.`);
    lines.push(...digestGeneric(clean, { ...dopts, maxLines: 8 }));
  } else if (status === 'NO TESTS') {
    lines.push('no tests matched. Check the path and the runner include patterns; a pass here would be a false green.');
  } else if (status === 'PASS' && opt.files.length === 0 && ran === 0) {
    lines.push('no tests relate to the uncommitted changes. Pass test files explicitly if you expected some.');
  }

  // 4. loop breaker bookkeeping. A run without per-test detail (crash, timeout, generic runner)
  // counts as one pseudo failure, so a stuck config error or a hang trips the breaker too.
  const pseudoId = `run::${opt.files.join(',') || '*'}`;
  const passedIds = new Set(parsed?.passed ?? []);
  let failedForLoop = parsed?.failed ?? [];
  if (status === 'PASS') passedIds.add(pseudoId);
  else if (!failedForLoop.length) {
    const firstErr = clean.split('\n').find((l) => /error|fail|cannot|not found|exception|timeout/i.test(l))?.trim().slice(0, 160) ?? status;
    failedForLoop = [{
      id: pseudoId,
      file: targets.length === 1 && targets[0].kind === 'test' ? targets[0].rel : null,
      title: `${status} (${opt.files.join(', ') || 'changed files'})`,
      message: firstErr,
      kind: 'run',
    }];
  }
  const rec = recordAfter({ state, failed: failedForLoop, passedIds, policy });
  writeState(root, rec.state);
  // shadow: later runs keep counting past the limit; only the crossing is a trip, the rest are would-blocks
  if (shadow) trippedN = rec.tripped.filter((e) => e.count === policy.loop.maxAttemptsPerFailure).length;
  for (const e of shadow ? [] : rec.repeats.slice(0, 2)) {
    loopNotes.push(`tb: same failure ${e.count}/${policy.loop.maxAttemptsPerFailure} (${e.title}). Change something real before the next run; ${policy.loop.maxAttemptsPerFailure}/${policy.loop.maxAttemptsPerFailure} stops further runs.`);
  }
  if (rec.tripped.length && !shadow) {
    trippedN = rec.tripped.length;
    loopNotes.push(`tb: STOP - same failure ${policy.loop.maxAttemptsPerFailure}/${policy.loop.maxAttemptsPerFailure}. Runs touching ${rec.tripped[0].file ?? 'it'} are refused for ${policy.loop.ttlMin} min. Report to the user.`);
  }
  const note = shadow ? null : budgetNote((gate.used ?? 0) + 1, policy);
  if (note && !trippedN) loopNotes.push(note);
  const footer = [...head, ...loopNotes, ...(status === 'PASS' ? [] : [`log: ${logRel} (full output, read only if this digest is not enough)`])];
  const final = cap(lines, footer, policy.digest.maxLines);
  final.forEach(out);

  trimRuns(root);
  appendRun(root, {
    type: 'run', runner, status, files: opt.files.length, all: opt.all, code: res.code, ms: res.ms,
    counts: c ?? null, rawChars: clean.length, digestChars: final.join('\n').length, tripped: trippedN,
  });
  if (trippedN && !shadow) return 3;
  return { PASS: 0, FAIL: 1, 'NO TESTS': 1, TIMEOUT: 4, ERROR: 4 }[status];
}

const backupPath = (root) => path.join(paths(root).st, 'mutate-backup.json');

// A mutate run that was killed hard (SIGKILL, power loss) leaves a mutant behind; undo it first thing.
function restoreInterrupted(root, out) {
  try {
    const f = backupPath(root);
    if (!fs.existsSync(f)) return;
    const b = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(b.file, b.text);
    fs.rmSync(f, { force: true });
    out(`tb: restored ${toPosix(path.relative(root, b.file))} from an interrupted mutate run`);
  } catch (e) { logError(root, e); }
}

async function mutate(args, { cwd, root, policy, out }) {
  const o = { src: null, tests: [], max: policy.mutate.maxMutants };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tests') while (args[i + 1] && !args[i + 1].startsWith('-')) o.tests.push(args[++i]);
    else if (args[i] === '--max') o.max = Math.min(Math.max(Number(args[++i]) || 0, 1), 60);
    else if (!args[i].startsWith('-') && !o.src) o.src = args[i];
    else { out(`tb: unknown argument ${args[i]}. usage: tbudget mutate <src-file> [--tests <test-file ...>] [--max n]`); return 2; }
  }
  const abs = o.src && path.resolve(cwd, o.src);
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) { out('usage: tbudget mutate <src-file> [--tests <test-file ...>] [--max n]'); return 2; }
  const rel = relTo(root, cwd, o.src);
  if (policy.testGlobs.some((g) => globToRegExp(g).test(rel))) { out(`tb: ${o.src} is a test file. Pass the source file it tests.`); return 2; }
  for (const t of o.tests) if (!fs.existsSync(path.resolve(cwd, t))) { out(`tb: not found: ${t}`); return 2; }
  const runner = detectRunner(cwd, root, policy);
  if (!runner) { out('tb: no test runner detected. Set "runner" in .test-budget/policy.json.'); return 2; }
  if ((runner === 'generic' || runner === 'junit') && !o.tests.length) { out(`tb: with runner "${runner}", name the tests: tbudget mutate ${o.src} --tests <test-file ...>`); return 2; }

  // one entry against the run budget, like a run
  const used = budgetUsed({ runs: readRuns(root), policy });
  if (used >= policy.loop.maxRunsPerWindow) {
    if (policy.mode !== 'shadow') { out(`tb: STOP - run budget used (${used}/${policy.loop.maxRunsPerWindow}); mutate counts as a run.`); return 3; }
    appendRun(root, { type: 'would-block', kind: 'rate' });
  }

  const p = ensure(root);
  const report = path.join(p.st, runner === 'pytest' || runner === 'junit' ? 'report.xml' : 'report.json');
  const files = o.tests.length ? o.tests : [o.src];
  const once = async () => {
    fs.rmSync(report, { force: true });
    const pl = plan(runner, { files, all: false, name: '', policy: { ...policy, failFast: true }, root, cwd, outFile: report });
    if (pl.none) return { status: 'NO TESTS' };
    return verdict({ pl, res: await execute(pl, { cwd, timeoutSec: policy.timeoutSec }), runner, files, root, cwd });
  };
  const t0 = Date.now();
  const base = await once();
  if (base.status !== 'PASS') {
    out(`tb: MUTATE needs green tests first: the tests for ${o.src} are ${base.status}. Run: tbudget run ${o.tests.join(' ') || o.src}`);
    return 1;
  }
  const orig = fs.readFileSync(abs, 'utf8');
  const mutants = generateMutants(orig, { py: abs.endsWith('.py'), max: o.max });
  if (!mutants.length) { out(`tb: MUTATE found nothing to mutate in ${rel}`); return 0; }

  fs.writeFileSync(backupPath(root), JSON.stringify({ file: abs, text: orig }));
  const restore = () => { try { fs.writeFileSync(abs, orig); fs.rmSync(backupPath(root), { force: true }); } catch { /* the backup restores it next time */ } };
  process.on('exit', restore); // a signal exits through process.exit, past any finally
  let killed = 0;
  let invalid = 0;
  const survived = [];
  try {
    for (const m of mutants) {
      fs.writeFileSync(abs, applyAt(orig, m));
      const v = await once();
      if (v.status === 'FAIL' || v.status === 'TIMEOUT') killed++;
      else if (v.status === 'PASS') survived.push(m);
      else invalid++; // the mutant broke loading or collection: says nothing about the tests
    }
  } finally {
    restore();
    process.off('exit', restore);
  }
  const valid = mutants.length - invalid;
  const score = valid ? killed / valid : 0;
  const lines = [`tb: MUTATE ${rel} | ${killed}/${valid} killed (${Math.round(score * 100)}%)${invalid ? ` | ${invalid} invalid` : ''} | ${((Date.now() - t0) / 1000).toFixed(1)}s | tests: ${o.tests.join(', ') || 'related'}`];
  const src = orig.split('\n');
  for (const m of survived) lines.push(`survived L${m.line}: ${JSON.stringify(m.from.trim())} -> ${JSON.stringify(m.to.trim() || '(removed)')} | ${src[m.line - 1].trim().slice(0, 100)}`);
  const footer = survived.length ? ['each survivor is a behaviour no test checks: add an assertion that fails on that change'] : [];
  const min = policy.mutate.minScore;
  if (min && score < min) footer.push(`tb: below policy.mutate.minScore (${Math.round(min * 100)}%)`);
  cap(lines, footer, policy.digest.maxLines).forEach(out);
  appendRun(root, { type: 'mutate', file: rel, total: mutants.length, killed, invalid, score, ms: Date.now() - t0 });
  return min && score < min ? 1 : 0;
}

function doBrief(args, { cwd, root, policy, out }) {
  if (args.length !== 1) { out('usage: tbudget brief <src-file>'); return 2; }
  const r = brief(args[0], { cwd, root, policy, runner: detectRunner(cwd, root, policy) });
  r.lines.forEach(out);
  return r.code;
}

function stats({ root, out }) {
  const recs = readRuns(root, 5000);
  if (!recs.length) { out('tbudget: no runs recorded yet in this project'); return 0; }
  const rs = recs.filter((r) => r.type === 'run');
  const sum = (key) => rs.reduce((a, r) => a + (r[key] ?? 0), 0);
  const tally = (arr, key) => Object.entries(arr.reduce((m, r) => ({ ...m, [r[key]]: (m[r[key]] ?? 0) + 1 }), {})).map(([n, v]) => `${n} ${v}`).join(', ') || 'none';
  const raw = sum('rawChars');
  const dig = sum('digestChars');
  const ms = rs.map((r) => r.ms ?? 0).sort((a, b) => a - b);
  out(`tbudget stats (${recs.length} records)`);
  out(`runs: ${rs.length} | ${tally(rs, 'status')} | median ${ms.length ? (ms[Math.floor(ms.length / 2)] / 1000).toFixed(1) : '0.0'}s`);
  out(`kept out of context: ${k(raw)} chars of runner output -> ${k(dig)} chars of digest (~${k(Math.round((raw - dig) / 4))} tokens, ${raw ? Math.round((1 - dig / raw) * 100) : 0}% less)`);
  out(`guard denials: ${tally(recs.filter((r) => r.type === 'deny'), 'rule')}`);
  out(`loop breaker: ${sum('tripped')} tripped, ${recs.filter((r) => r.type === 'block').length} runs refused`);
  return 0;
}

const when = (ts) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');

// The evidence for (or against) switching enforcement on. Kept to <=12 lines.
function report({ root, policy, out }) {
  const recs = readRuns(root, 5000);
  if (!recs.length) {
    out('tbudget report: nothing recorded yet. Set "mode": "shadow" in .test-budget/policy.json and work as usual for a week.');
    return 0;
  }
  const count = (arr, key) => arr.reduce((m, r) => ({ ...m, [r[key] ?? '?']: (m[r[key] ?? '?'] ?? 0) + 1 }), {});
  const list = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([n, v]) => `${n} ${v}`).join(', ') || 'none';
  const rs = recs.filter((r) => r.type === 'run');
  const wd = recs.filter((r) => r.type === 'would-deny');
  const wb = recs.filter((r) => r.type === 'would-block');
  const raw = rs.reduce((a, r) => a + (r.rawChars ?? 0), 0);
  const dig = rs.reduce((a, r) => a + (r.digestChars ?? 0), 0);
  const t0 = recs[0].ts;
  const t1 = recs.at(-1).ts;
  out(`tbudget report | mode: ${policy.mode} | ${when(t0)} to ${when(t1)} UTC (${((t1 - t0) / 86_400_000).toFixed(1)} days, ${recs.length} records)`);
  out(`would-deny: ${wd.length} | by rule: ${list(count(wd, 'rule'))}`);
  if (wd.length) out(`  by agent: ${list(count(wd, 'agent'))}`);
  out(`would-block: ${wb.length} runs | by kind: ${list(count(wb, 'kind'))} | breaker would have tripped ${rs.reduce((a, r) => a + (r.tripped ?? 0), 0)}x`);
  out(`tbudget runs: ${rs.length} | ${list(count(rs, 'status'))}`);
  out(`runner output: ${k(raw)} chars raw -> ${k(dig)} chars digest (${raw ? Math.round((1 - dig / raw) * 100) : 0}% less)`);
  out(`  ~${k(Math.round((raw - dig) / 4))} tokens kept out of context (ESTIMATE: chars/4, not measured token telemetry)`);
  const rawRuns = wd.filter((r) => r.rule === 'raw-runner').length;
  if (rawRuns) out(`  plus ${rawRuns} raw runner calls whose full output went to context (size not recorded)`);
  // measured, not estimated: usage from the transcripts, the latest record per transcript
  const sessions = [...new Map(recs.filter((r) => r.type === 'session').map((r) => [r.transcript, r])).values()];
  if (sessions.length) {
    const t = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    const models = new Set();
    for (const s of sessions) for (const [m, u] of Object.entries(s.models ?? {})) { models.add(m); for (const key of Object.keys(t)) t[key] += u[key] ?? 0; }
    const tool = sessions.reduce((a, s) => a + (s.toolChars ?? 0), 0);
    const tests = sessions.reduce((a, s) => a + (s.testChars ?? 0), 0);
    out(`measured: ${sessions.length} transcripts (${sessions.filter((s) => s.agent !== 'main').length} subagent) | tokens in ${k(t.input + t.cacheWrite + t.cacheRead)} (cache read ${k(t.cacheRead)}, write ${k(t.cacheWrite)}), out ${k(t.output)} | ${[...models].join(', ')}`);
    out(`  test commands: ${tool ? Math.round((tests / tool) * 100) : 0}% of all tool output (${k(tests)} of ${k(tool)} chars, ${sessions.reduce((a, s) => a + (s.testCalls ?? 0), 0)} calls)`);
  } else out('measured: no transcripts yet (recorded when a session or subagent ends)');
  const resets = recs.filter((r) => r.type === 'reset');
  if (resets.length) out(`resets: ${resets.length}${resets.some((r) => r.reason) ? ` | ${resets.filter((r) => r.reason).slice(-2).map((r) => JSON.stringify(r.reason)).join(', ')}` : ''}`);
  if (policy.mode === 'shadow') out('enforce: set "mode": "enforce" in .test-budget/policy.json');
  return 0;
}

function reset(args, { root, out }) {
  const i = args.indexOf('--reason');
  const reason = i >= 0 ? String(args[i + 1] ?? '').slice(0, 200) : '';
  writeState(root, { failures: {} });
  appendRun(root, { type: 'reset', reason });
  out(`tb: loop-breaker state and run budget cleared${reason ? '' : ' (tip: --reason "..." is kept in the audit log, so the report shows why limits were lifted)'}`);
  return 0;
}

export async function main(argv, { cwd = process.cwd(), out = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const [cmd, ...rest] = argv;
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') { HELP.forEach(out); return 0; }
  if (!cmd) { HELP.forEach(out); return 2; }
  const { policy, root, problems } = loadPolicy(cwd);
  const ctx = { cwd, root, policy, problems, out };
  try {
    restoreInterrupted(root, out);
    if (cmd === 'run') return await run(rest, ctx);
    if (cmd === 'brief') return doBrief(rest, ctx);
    if (cmd === 'mutate') return await mutate(rest, ctx);
    if (cmd === 'stats') return stats(ctx);
    if (cmd === 'report') return report(ctx);
    if (cmd === 'reset') return reset(rest, ctx);
  } catch (e) {
    logError(root, e);
    out(`tb: internal error: ${e.message} (details: .test-budget/.state/errors.log)`);
    return 4;
  }
  out(`tb: unknown command "${cmd}"`);
  HELP.forEach(out);
  return 2;
}
