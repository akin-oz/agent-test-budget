#!/usr/bin/env node
// What the in-process guard costs a Node process that is not a test runner: start `node -e 0` many
// times with and without the preload, interleaved, and compare medians. No network, no spend.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const preload = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'preload.cjs');
const n = Math.max(10, Number(process.argv[2]) || 60);
const env = { ...process.env };
delete env.NODE_OPTIONS;
const time = (extra) => {
  const t0 = process.hrtime.bigint();
  spawnSync(process.execPath, ['-e', '0'], { env: { ...env, ...extra } });
  return Number(process.hrtime.bigint() - t0) / 1e6;
};
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const base = [];
const withPreload = [];
for (let i = 0; i < n; i++) { // interleaved, so load drift hits both
  base.push(time({}));
  withPreload.push(time({ NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }));
}
const b = median(base);
const w = median(withPreload);
console.log(`node ${process.version} ${process.platform}-${process.arch} | ${n} starts each`);
const d = w - b; // can come out negative: the difference is inside run-to-run noise
const sign = d >= 0 ? '+' : '';
console.log(`node -e 0: ${b.toFixed(1)} ms median without, ${w.toFixed(1)} ms with the preload: ${sign}${d.toFixed(1)} ms (${sign}${((d / b) * 100).toFixed(1)}%)`);
