import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarizeTranscript } from '../lib/transcript.mjs';
import { main } from '../lib/cli.mjs';

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(PLUGIN, 'hooks', 'session-end.mjs');

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite });
const asst = (id, model, u, content = []) => ({ type: 'assistant', message: { id, model, usage: u, content } });
const bash = (id, command) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
const result = (id, text) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

// streaming writes one message as several lines with the same id and the same usage
const LINES = [
  asst('m1', 'claude-opus-5-5', usage(10, 5, 100, 50), [{ type: 'text', text: 'running tests' }]),
  asst('m1', 'claude-opus-5-5', usage(10, 5, 100, 50), [bash('t1', 'npx vitest run')]),
  result('t1', 'x'.repeat(3000)),
  asst('m2', 'claude-opus-5-5', usage(20, 7, 300, 0), [bash('t2', 'git status')]),
  result('t2', [{ type: 'text', text: 'y'.repeat(500) }]),
  asst('m3', 'claude-sonnet-5-5', usage(1, 2), [bash('t3', 'tbudget run src/a.test.ts')]),
  result('t3', 'tb: PASS vitest | 3 passed'),
  'not json',
];
const TEXT = LINES.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
const isTest = (cmd) => /vitest|tbudget run/.test(cmd);

test('summarizeTranscript counts usage once per message and attributes tool output to test commands', () => {
  const s = summarizeTranscript(TEXT, isTest);
  assert.equal(s.messages, 3);
  assert.deepEqual(s.models['claude-opus-5-5'], { input: 30, cacheWrite: 50, cacheRead: 400, output: 12 });
  assert.deepEqual(s.models['claude-sonnet-5-5'], { input: 1, cacheWrite: 0, cacheRead: 0, output: 2 });
  assert.equal(s.toolChars, 3000 + 500 + 'tb: PASS vitest | 3 passed'.length);
  assert.equal(s.testChars, 3000 + 'tb: PASS vitest | 3 passed'.length);
  assert.equal(s.testCalls, 2);
});

test('session-end hook records measured usage, and the report shows it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbud-tx-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.mkdirSync(path.join(dir, '.test-budget'));
  const tx = path.join(dir, 'session.jsonl');
  fs.writeFileSync(tx, TEXT);
  const hook = (payload) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(hook({ hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: tx, cwd: dir }).status, 0);
  assert.equal(hook({ hook_event_name: 'SessionEnd', session_id: 's1', transcript_path: tx, cwd: dir }).status, 0); // same transcript twice
  hook({ hook_event_name: 'SubagentStop', session_id: 's1', transcript_path: tx, cwd: dir }); // no agent transcript: skipped
  const recs = fs.readFileSync(path.join(dir, '.test-budget/.state/runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(recs.length, 2);
  assert.equal(recs[0].type, 'session');
  assert.equal(recs[0].testCalls, 2); // the real guard decides what a test command is
  const lines = [];
  await main(['report'], { cwd: dir, out: (s) => lines.push(...String(s).split('\n')) });
  const text = lines.join('\n');
  assert.match(text, /measured: 1 transcripts \(0 subagent\) \| tokens in 481 \(cache read 400, write 50\), out 14 \| claude-opus-5-5, claude-sonnet-5-5/);
  assert.match(text, /test commands: 86% of all tool output \(3\.0k of 3\.5k chars, 2 calls\)/);
});

test('session-end leaves projects that do not use the plugin alone, and honours measure.transcripts', () => {
  const tx = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tbud-tx-')), 'session.jsonl');
  fs.writeFileSync(tx, TEXT);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tbud-plain-'));
  fs.mkdirSync(path.join(plain, '.git'));
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'SessionEnd', transcript_path: tx, cwd: plain }) });
  assert.ok(!fs.existsSync(path.join(plain, '.test-budget')));
  const off = fs.mkdtempSync(path.join(os.tmpdir(), 'tbud-off-'));
  fs.mkdirSync(path.join(off, '.test-budget'));
  fs.writeFileSync(path.join(off, '.test-budget/policy.json'), JSON.stringify({ measure: { transcripts: false } }));
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'SessionEnd', transcript_path: tx, cwd: off }) });
  assert.ok(!fs.existsSync(path.join(off, '.test-budget/.state/runs.jsonl')));
});
