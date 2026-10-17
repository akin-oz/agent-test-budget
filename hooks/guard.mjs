#!/usr/bin/env node
// PreToolUse guard for Bash and file-edit tools. Emits a deny decision or nothing at all
// (it never emits "allow", so Claude Code's normal permission flow still applies).
// In shadow mode it never denies: it only records what it would have denied.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../lib/policy.mjs';
import { appendRun, logError } from '../lib/state.mjs';
import { createCtx, decideBash, decideEdit, looksLikeRunner, outcome } from '../lib/guard-core.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }),
  );
}

let input = null;
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { /* unreadable payload: stay out of the way */ }

// Human escape hatch: launch Claude Code with TBUDGET_GUARD=off. An agent cannot set it for this process.
if (input && process.env.TBUDGET_GUARD !== 'off') {
  const cwd = input.cwd || process.cwd();
  let policy = null;
  let root = cwd;
  try {
    ({ policy, root } = loadPolicy(cwd));
    if (process.env.TBUDGET_SELFTEST_THROW) throw new Error('selftest');
    const ctx = createCtx({ cwd, root, policy, pluginRoot });
    const d = input.tool_name === 'Bash'
      ? decideBash(String(input.tool_input?.command ?? ''), ctx)
      : decideEdit(input.tool_name, input.tool_input, ctx);
    if (d) {
      const o = outcome(d, input, policy);
      appendRun(root, o.rec);
      if (o.deny) deny(d.reason);
    }
  } catch (e) {
    logError(root, e);
    // A bug must not brick the agent, but a bug on a test command must not leak cost either.
    if (looksLikeRunner(input)) {
      const o = outcome({ rule: 'internal-error' }, input, policy);
      if (o.deny) deny('tb-guard: internal error while checking a test command; failing closed. Run: tbudget run [test-file ...]');
      else appendRun(root, o.rec);
    }
  }
}
