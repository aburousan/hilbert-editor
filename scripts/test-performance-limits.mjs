import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile('src/performanceLimits.ts', 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);

const discarded = mod.inactiveModelsToDiscard([
  { path: 'active.typ', active: true, dirty: false, lastUsed: 1 },
  { path: 'dirty.typ', active: false, dirty: true, lastUsed: 0 },
  { path: 'old.typ', active: false, dirty: false, lastUsed: 2 },
  { path: 'middle.typ', active: false, dirty: false, lastUsed: 3 },
  { path: 'new.typ', active: false, dirty: false, lastUsed: 4 },
], 2);
assert.deepEqual(discarded, ['old.typ']);

const unicode = 'a'.repeat(20) + '😀' + 'b'.repeat(20) + '🧪' + 'tail';
const limitedUnicode = mod.limitRetainedText(unicode, 30, 'stdout');
assert.equal(limitedUnicode.truncated, true);
assert.ok(limitedUnicode.text.length <= 30);
assert.ok(!/[\uD800-\uDBFF]$/.test(limitedUnicode.text));
assert.ok(!/^[\uDC00-\uDFFF]/.test(limitedUnicode.text));

const limitedRun = mod.limitRunResult({ stdout: 'x'.repeat(400_000), stderr: 'important tail' }, 2048);
assert.equal(limitedRun.outputTruncated, true);
assert.ok(limitedRun.stdout.length + limitedRun.stderr.length <= 2048);

const notebook = mod.limitNotebookResults(Array.from({ length: 20 }, (_, i) => ({
  stdout: `${i}:` + 'z'.repeat(100_000), error: '', images: [],
})));
const retained = notebook.reduce((sum, item) => sum + item.stdout.length + item.error.length, 0);
assert.ok(retained <= mod.MAX_RETAINED_NOTEBOOK_TEXT);
assert.ok(notebook.some(item => item.outputTruncated));

const pdf = await readFile('src/components/PdfPreview.tsx', 'utf8');
assert.match(pdf, /const context = words\.slice\(from, to\)/);
assert.doesNotMatch(pdf, /if \(selectedWord\) words\[focus\] = selectedWord/);
assert.match(pdf, /MAX_PDF_PAGE_WORD_INDEXES/);

console.log('performance limits: ok');
