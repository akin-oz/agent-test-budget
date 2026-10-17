// Loaded into every Node process the agent's shell starts (NODE_OPTIONS=--require, set by the
// SessionStart hook). For anything but vitest or jest it is one regex on argv[1]. A runner started
// outside tbudget is refused here, inside the process, however the shell command was spelled:
// variables, a Node script that spawns it, a package script the guard could not read.
// CommonJS on purpose: --require works on every supported Node, and it must never break a process.
'use strict';
(() => {
  try {
    if (process.env.TBUDGET_INSIDE === '1' || process.env.TBUDGET_GUARD === 'off') return;
    const main = String(process.argv[1] ?? '').replace(/\\/g, '/');
    const m = /(?:^|\/)(vitest|jest)(?:-cli)?(?:\/|\.[cm]?js$|$)/.exec(main);
    if (!m) return;
    const args = process.argv.slice(2);
    if (args.some((a) => ['--version', '-v', '--help', '-h'].includes(a))) return;
    const fs = require('node:fs');
    const path = require('node:path');
    const findRoot = (start) => {
      for (const marker of [path.join('.test-budget', 'policy.json'), '.git']) {
        for (let d = path.resolve(start); ; d = path.dirname(d)) {
          if (fs.existsSync(path.join(d, marker))) return d;
          if (path.dirname(d) === d) break;
        }
      }
      return path.resolve(start);
    };
    const root = findRoot(process.cwd());
    let policy = {};
    try { policy = JSON.parse(fs.readFileSync(path.join(root, '.test-budget', 'policy.json'), 'utf8')) ?? {}; } catch { /* defaults */ }
    const guard = policy.guard ?? {};
    const runner = m[1];
    if (guard.blockRawRunners === false || guard.inProcess === false || !(guard.enforce ?? ['vitest', 'jest', 'pytest']).includes(runner)) return;
    const shadow = policy.mode === 'shadow';
    try {
      const st = path.join(root, '.test-budget', '.state');
      fs.mkdirSync(st, { recursive: true });
      const rec = { ts: Date.now(), type: shadow ? 'would-deny' : 'deny', rule: 'raw-runner-inproc', tool: 'process', agent: 'in-process', command: [runner, ...args].join(' ').slice(0, 200) };
      fs.appendFileSync(path.join(st, 'runs.jsonl'), `${JSON.stringify(rec)}\n`);
    } catch { /* logging must never break a run */ }
    if (shadow) return;
    process.stderr.write(`tb-guard: raw ${runner} blocked inside the process (it was started outside tbudget). Run: tbudget run [test-file ...]\n`);
    process.exit(2);
  } catch { /* never break an unrelated Node process */ }
})();
