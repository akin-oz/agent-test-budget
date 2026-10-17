#!/usr/bin/env node
// SessionEnd and SubagentStop: read the transcript Claude Code already wrote and record its real token
// usage, plus how much tool output came from test commands. Local only; never blocks anything.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../lib/policy.mjs';
import { appendRunIfTracked, logError } from '../lib/state.mjs';
import { createCtx, analyzeCommand } from '../lib/guard-core.mjs';
import { summarizeTranscript } from '../lib/transcript.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX = 200 * 1024 * 1024;

let input = null;
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { /* nothing to do */ }
const sub = input?.hook_event_name === 'SubagentStop';
// a SubagentStop without its own transcript would recount the main session
const file = sub ? input?.agent_transcript_path : input?.transcript_path;
if (file && process.env.TBUDGET_GUARD !== 'off') {
  let root = input.cwd || process.cwd();
  try {
    const { policy, root: r } = loadPolicy(root);
    root = r;
    if (policy.measure.transcripts && fs.existsSync(path.join(root, '.test-budget')) && fs.statSync(file).size <= MAX) {
      const ctx = createCtx({ cwd: input.cwd || root, root, policy, pluginRoot });
      const isTest = (cmd) => { try { return analyzeCommand(cmd, ctx).some((f) => f.block || f.tb === 'run'); } catch { return false; } };
      const s = summarizeTranscript(fs.readFileSync(file, 'utf8'), isTest);
      appendRunIfTracked(root, { type: 'session', transcript: file, session: input.session_id ?? null, agent: sub ? (input.agent_type ?? 'subagent') : 'main', ...s });
    }
  } catch (e) { logError(root, e); }
}
