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
assert.deepEqual(unicode.graphemeBoundaries('ខ្មែរ'), [0, 4, 5]);
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

console.log('unicode range tests: passed');
