// Writes a legacy suite next to the module under test: 40 modules with 30 tests each, a short async
// setup per file and deprecation warnings from every fourth module. An unscoped run is slow and loud,
// which is the situation the plugin's scoping exists for. Deterministic, so every run sees the same repo.
import fs from 'node:fs';
import path from 'node:path';

export const MODULES = 40;
export const TESTS_PER_MODULE = 30;

export default function generate(dir) {
  const lib = path.join(dir, 'src', 'legacy');
  fs.mkdirSync(lib, { recursive: true });
  for (let i = 1; i <= MODULES; i++) {
    const id = String(i).padStart(2, '0');
    const k = (i % 7) + 1;
    const warn = i % 4 === 0
      ? `  console.warn(\`[deprecated] f${id}() will be removed in v3; use g${id}() instead (called with \${x})\`);\n`
      : '';
    fs.writeFileSync(path.join(lib, `m${id}.ts`), `export function f${id}(x: number): number {\n${warn}  return x * ${k} + ${i};\n}\n`);
    fs.writeFileSync(path.join(lib, `m${id}.test.ts`), [
      "import { beforeAll, describe, expect, it } from 'vitest';",
      `import { f${id} } from './m${id}';`,
      '',
      `describe('f${id}', () => {`,
      '  beforeAll(() => new Promise((r) => setTimeout(r, 250)));',
      `  it.each(Array.from({ length: ${TESTS_PER_MODULE} }, (_, i) => i))('maps %i', (x) => {`,
      `    expect(f${id}(x)).toBe(x * ${k} + ${i});`,
      '  });',
      '});',
      '',
    ].join('\n'));
  }
}
