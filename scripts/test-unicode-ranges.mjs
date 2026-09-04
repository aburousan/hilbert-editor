import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadTypeScriptModule(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
    fileName: relativePath,
  }).outputText;
  const module = { exports: {} };
  Function('exports', 'module', 'require', output)(module.exports, module, () => {
    throw new Error(`${relativePath} unexpectedly imported another module`);
  });
  return module.exports;
}

const unicode = loadTypeScriptModule('src/unicodeRanges.ts');
const sync = loadTypeScriptModule('src/syncMatch.ts');

assert.deepEqual(unicode.graphemeBoundaries('A😀B'), [0, 1, 3, 4]);
assert.deepEqual(unicode.graphemeBoundaries('e\u0301'), [0, 2]);
assert.deepEqual(unicode.graphemeBoundaries('👨‍👩‍👧‍👦'), [0, 11]);
assert.deepEqual(unicode.graphemeBoundaries('क्‍ष'), [0, 4]);
// Khmer is the one case the answer depends on which Unicode version the
// runtime carries: 16 splits `ខ្មែរ` after the coeng pair, 17 does not. What
// the editor needs is that the boundaries are usable, not that they match one
// version's table, so assert that instead.
{
  const khmer = 'ខ្មែរ';
  const found = unicode.graphemeBoundaries(khmer);
  assert.equal(found[0], 0, 'boundaries start at the beginning');
  assert.equal(found[found.length - 1], khmer.length, 'and end at the end');
  assert.deepEqual([...found].sort((a, b) => a - b), found, 'in order');
  assert.equal(new Set(found).size, found.length, 'without repeats');
  for (const at of found) {
    const before = khmer.charCodeAt(at - 1);
    assert.ok(!(before >= 0xd800 && before <= 0xdbff), `boundary ${at} splits a surrogate pair`);
  }
  // Both tables agree on these two, whatever they do in between.
  assert.ok(found.includes(4) && found.includes(5), `unexpected boundaries ${JSON.stringify(found)}`);
}
assert.deepEqual(unicode.graphemeBoundaries('🇮🇳'), [0, 4]);

assert.deepEqual(unicode.snapUtf16RangeToGraphemes('e\u0301x', 0, 1), { start: 0, end: 2 });
assert.equal(unicode.snapUtf16OffsetToGrapheme('A😀B', 2, 'backward'), 1);
assert.equal(unicode.snapUtf16OffsetToGrapheme('A😀B', 2, 'forward'), 3);

assert.deepEqual(sync.tokenizeLine('Cafe\u0301 noir'), [
  { w: 'cafe\u0301', offset: 0 },
  { w: 'noir', offset: 6 },
]);
assert.deepEqual(sync.tokenizeLine('ភាសាខ្មែរ'), [{ w: 'ភាសាខ្មែរ', offset: 0 }]);
assert.deepEqual(sync.tokenizeLine('हिन्दी भाषा').map(({ w }) => w), ['हिन्दी', 'भाषा']);

// PDF math uses presentation glyphs rather than Typst's source spellings.
assert.deepEqual(sync.tokenizeRenderedText('−𝑥²'), ['x2']);
assert.deepEqual(sync.tokenizeRenderedText('𝑘=1'), ['k', '1']);
assert.deepEqual(sync.tokenizeRenderedText('𝑛(𝑛+1)'), ['n', 'n', '1']);
assert.deepEqual(sync.tokenizeRenderedText('∑'), ['sum']);
assert.deepEqual(sync.tokenizeRenderedText('∫₀∞'), ['integral', '0', 'infinity']);
assert.deepEqual(sync.tokenizeRenderedText('√𝜋'), ['sqrt', 'pi']);
assert.deepEqual(sync.tokenizeRenderedText('α + β = γ'), ['alpha', 'beta', 'gamma']);
assert.deepEqual(
  sync.tokenizeTypstMathSource('$ integral_0^infinity e^(-2x^2) dif x = sqrt(pi) / 2 $'),
  ['integral', '0', 'infinity', 'e', '2', 'x', '2', 'dif', 'x', 'sqrt', 'pi', '2'],
);

console.log('unicode range tests: passed');
