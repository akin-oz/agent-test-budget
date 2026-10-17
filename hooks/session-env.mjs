#!/usr/bin/env node
// SessionStart: export the in-process guards into every later Bash command of this session, through
// the CLAUDE_ENV_FILE preamble. Idempotent (the preamble may run more than once) and additive: it keeps
// whatever NODE_OPTIONS, PYTHONPATH and PYTEST_PLUGINS the user already has.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../lib/policy.mjs';
import { appendRunIfTracked } from '../lib/state.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function envLines(root) {
  const preload = path.join(root, 'lib', 'preload.cjs');
  const py = path.join(root, 'python');
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    `case " $NODE_OPTIONS " in *preload.cjs*) ;; *) export NODE_OPTIONS="\${NODE_OPTIONS:+$NODE_OPTIONS }--require ${JSON.stringify(preload).replace(/"/g, '\\"')}";; esac`,
    `case ":$PYTHONPATH:" in *:${q(py)}:*) ;; *) export PYTHONPATH="\${PYTHONPATH:+$PYTHONPATH:}"${q(py)};; esac`,
    `case ",$PYTEST_PLUGINS," in *,tbudget_pytest,*) ;; *) export PYTEST_PLUGINS="\${PYTEST_PLUGINS:+$PYTEST_PLUGINS,}tbudget_pytest";; esac`,
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv.includes('--print')) {
  // for other agents: paste these lines into the shell profile the agent's commands run under
  console.log(envLines(pluginRoot).join('\n'));
} else if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const envFile = process.env.CLAUDE_ENV_FILE;
    let input = {};
    try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { /* no payload */ }
    const { policy, root } = loadPolicy(input.cwd || process.cwd());
    const off = process.env.TBUDGET_GUARD === 'off';
    const want = !off && policy.guard.inProcess && policy.guard.blockRawRunners;
    if (want && envFile) fs.appendFileSync(envFile, `${envLines(pluginRoot).join('\n')}\n`);
    // Every session start is counted, so the report can show how often the escape hatch is used.
    // Without a record here, a session with TBUDGET_GUARD=off would leave no trace at all.
    const why = off ? 'TBUDGET_GUARD=off' : !want ? 'policy' : !envFile ? 'no CLAUDE_ENV_FILE' : null;
    appendRunIfTracked(root, { type: 'session-start', session: input.session_id ?? null, guard: off ? 'off' : 'on', inProcess: Boolean(want && envFile), why, platform: process.platform });
    // PowerShell skips the preamble's shell lines; say so instead of failing silently
    if (want && envFile && process.platform === 'win32') {
      console.log('agent-test-budget: the in-process test guard needs a bash shell. Under PowerShell only the command guard applies this session.');
    }
  } catch { /* never block a session start */ }
}
