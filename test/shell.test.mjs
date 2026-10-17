import test from 'node:test';
import assert from 'node:assert/strict';
import { splitSegments, tokenize, nestedCommands, substitutions, globToRegExp } from '../lib/shell.mjs';

test('splitSegments splits on unquoted operators only', () => {
  assert.deepEqual(splitSegments('a && b | c; d\ne'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(splitSegments('git commit -m "a && b; c"'), ['git commit -m "a && b; c"']);
  assert.deepEqual(splitSegments("echo 'x | y' || true"), ["echo 'x | y'", 'true']);
});

test('splitSegments keeps redirections intact', () => {
  assert.deepEqual(splitSegments('npm run x 2>&1 | tail -5'), ['npm run x 2>&1', 'tail -5']);
  assert.deepEqual(splitSegments('cmd &> out.log'), ['cmd &> out.log']);
});

test('tokenize honours quotes and escapes', () => {
  assert.deepEqual(tokenize('bash -c "npx vitest run"'), ['bash', '-c', 'npx vitest run']);
  assert.deepEqual(tokenize("echo 'a b' c\\ d ''"), ['echo', 'a b', 'c d', '']);
  assert.deepEqual(tokenize('FOO=1   cmd'), ['FOO=1', 'cmd']);
});

test('nestedCommands finds $(...) and backticks', () => {
  assert.deepEqual(nestedCommands('echo $(npx vitest) `jest`'), ['npx vitest', 'jest']);
});

test('substitutions cuts out balanced bodies and leaves a placeholder word', () => {
  assert.deepEqual(substitutions('echo $( (a) ) x'), { text: 'echo $__SUBST x', bodies: [' (a) '] });
  assert.deepEqual(substitutions('$(echo npx) vitest').text, '$__SUBST vitest');
  assert.deepEqual(nestedCommands('cat <(a) >(b) "$(c)" `d`'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(nestedCommands("echo '$(not run)' \\$(nor this)"), []);
  assert.deepEqual(nestedCommands('echo $(a $(b))'), ['a $(b)']);
});

test('tokenize drops the $ of $\'..\' and $".." quoting', () => {
  assert.deepEqual(tokenize("$'vitest' run"), ['vitest', 'run']);
  assert.deepEqual(tokenize('$"vitest"'), ['vitest']);
});

test('globToRegExp', () => {
  const m = (g, p) => globToRegExp(g).test(p);
  assert.ok(m('**/*.test.*', 'a.test.ts'));
  assert.ok(m('**/*.test.*', 'src/deep/a.test.tsx'));
  assert.ok(!m('**/*.test.*', 'src/a.ts'));
  assert.ok(m('**/test_*.py', 'tests/test_a.py'));
  assert.ok(!m('*.ts', 'src/a.ts'));
});
