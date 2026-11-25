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

const { commentEdits, commentEditsForRanges, commentTokenFor } = loadTypeScriptModule('src/commentLines.ts');

// Apply edits the way Monaco does: every range is in the coordinates of the
// text as it was before any of them were applied.
function applyEdits(text, edits) {
  const lines = text.split('\n');
  for (const e of edits) {
    const { startLineNumber, startColumn, endColumn } = e.range;
    assert.equal(e.range.endLineNumber, startLineNumber, 'edits stay within one line');
    const line = lines[startLineNumber - 1];
    lines[startLineNumber - 1] = line.slice(0, startColumn - 1) + e.text + line.slice(endColumn - 1);
  }
  return lines.join('\n');
}

function toggle(text, token = '//', first = 1, last = text.split('\n').length) {
  const texts = text.split('\n').slice(first - 1, last);
  return applyEdits(text, commentEdits(texts, first, token));
}

// Round trip: commenting then uncommenting gives back exactly what we started with.
for (const [sample, token] of [
  ['#set page(paper: "a4")\n#let x = 1', '//'],
  ['import numpy\nprint(1)', '#'],
  ['@article{key,\n  title = {A}\n}', '%'],
]) {
  const commented = toggle(sample, token);
  assert.notEqual(commented, sample, 'commenting changes the text');
  assert.equal(toggle(commented, token), sample, 'uncommenting restores the original');
}

// The token matches the file type, defaulting to // for anything unknown.
assert.equal(commentTokenFor('slides.typ'), '//');
assert.equal(commentTokenFor('analysis.py'), '#');
assert.equal(commentTokenFor('solve.jl'), '#');
assert.equal(commentTokenFor('refs.bib'), '%');
assert.equal(commentTokenFor('Makefile'), '//');
assert.equal(commentTokenFor('SHOUT.PY'), '#', 'extensions are matched case-insensitively');

// Indented blocks are commented from the shallowest indent, so the block keeps
// its shape rather than each line being commented at its own depth.
assert.equal(
  toggle('  a\n    b', '#'),
  '  # a\n  #   b',
);
assert.equal(toggle(toggle('  a\n    b', '#'), '#'), '  a\n    b');

// Blank lines are left alone but don't block the toggle.
assert.equal(toggle('a\n\nb', '#'), '# a\n\n# b');
assert.deepEqual(commentEdits(['', '   '], 1, '#'), [], 'nothing to do in an all-blank block');

// A block counts as commented only when every non-blank line is, so a partly
// commented selection comments the rest rather than uncommenting.
assert.equal(toggle('# a\nb', '#'), '# # a\n# b');
assert.equal(toggle('# a\n# b', '#'), 'a\nb');

// Uncommenting removes the token, and the single space only if it is there.
assert.equal(toggle('#a\n# b', '#'), 'a\nb');

// Line numbers are absolute, not relative to the slice handed in.
assert.deepEqual(
  commentEdits(['b'], 4, '#').map(e => e.range.startLineNumber),
  [4],
);

// A multi-character token is matched as a whole.
assert.equal(toggle('local x = 1', '--'), '-- local x = 1');
assert.equal(toggle('-- local x = 1', '--'), 'local x = 1');

// Several cursors (issue #51). `cursors` are 1-based line spans, as Monaco's selections give them.
function toggleAt(text, cursors, token = '//') {
  const lines = text.split('\n');
  return applyEdits(text, commentEditsForRanges(cursors.map(([first, last = first]) => ({ first, last })), n => lines[n - 1], token));
}
// The reported case: three cursors on three lines, made from the bottom up, comment all three, the same
// as a selection over them; and the same cursors uncomment them again.
const three = 'a\nb\nc';
assert.equal(toggleAt(three, [[3], [2], [1]]), '// a\n// b\n// c');
assert.equal(toggleAt(three, [[3], [2], [1]]), toggle(three));
assert.equal(toggleAt('// a\n// b\n// c', [[1], [2], [3]]), three);
// Cursors far apart each get their line, lined up at their own indent, and nothing in between changes.
assert.equal(toggleAt('a\nkeep\n    b\nkeep\n  c', [[1], [3], [5]], '#'), '# a\nkeep\n    # b\nkeep\n  # c');
// Two cursors on one line, or overlapping selections, toggle that line once.
assert.equal(toggleAt('a\nb', [[1], [1]]), '// a\nb');
assert.equal(toggleAt('a\nb\nc\nd', [[1, 3], [2, 4]]), '// a\n// b\n// c\n// d');
// One decision for all cursors: mixed lines are all commented, never some commented and some uncommented.
assert.equal(toggleAt('// a\nkeep\nb', [[1], [3]]), '// // a\nkeep\n// b');
// A blank line under a cursor is left alone; all-blank does nothing.
assert.equal(toggleAt('a\n\nb', [[1], [2], [3]]), '// a\n\n// b');
assert.deepEqual(commentEditsForRanges([{ first: 1, last: 1 }], () => '  ', '#'), []);
// One cursor behaves exactly as before.
assert.equal(toggleAt('  a\n    b', [[1, 2]], '#'), toggle('  a\n    b', '#'));

console.log('comment-lines tests passed');
