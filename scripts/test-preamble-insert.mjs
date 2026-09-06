// Imports added by the menus must not land inside a rule that spans lines.
//
// "Insert -> Page setup" writes a #set page(...) across several lines. The old
// search for somewhere to put an import read one line at a time: the first line
// looked like preamble, the second did not, so the import went between them —
// straight through the middle of the function call. Typst then complained that
// "the character '#' is not valid in code" on a line the writer never touched,
// which is what the Slides -> pinit annotations did to a real document.
//
// The insertion point is checked here, and then the documents it produces are
// handed to typst, because the only convincing answer is that they compile.
//
//   node scripts/test-preamble-insert.mjs
//
// Needs typst on PATH.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

function loadTypeScriptModule(relativePath) {
  const source = readFileSync(join(root, relativePath), 'utf8');
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

const { preambleInsertLine } = loadTypeScriptModule('src/preamble.ts');

const PINIT = '#import "@preview/pinit:0.2.2": *\n';
const HIGHLIGHT = '\nA simple #pin(1)highlighted phrase#pin(2) in the flow of text.\n#pinit-highlight(1, 2)\n#pinit-point-from(2)[And a note about it.]\n';
const ARROW = '\nFrom here#pin(1) #h(6em) #pin(2)to there.\n#pinit-arrow(1, 2, end-dy: -0.4em)\n';

// What the page-setup dialog actually writes into a document.
const PAGE_SETUP = '#set page(\n  paper: "a4",\n  margin: 2cm,\n)\n';

const insertAt = (doc, text) => {
  const lines = doc.split('\n');
  const at = preambleInsertLine(lines);
  lines.splice(at - 1, 0, ...text.replace(/\n$/, '').split('\n'));
  return lines.join('\n');
};

let failures = 0;
const check = (name, run) => {
  try { run(); console.log(`  ok   ${name}`); }
  catch (error) { failures++; console.log(`  FAIL ${name}\n       ${error.message.split('\n')[0]}`); }
};

console.log('where the line goes\n');

check('an empty document takes it at the top', () => {
  assert.equal(preambleInsertLine(['']), 2);
  assert.equal(preambleInsertLine([]), 1);
});

check('prose at the top means the very top', () => {
  assert.equal(preambleInsertLine(['= Title', '', 'Words.']), 1);
});

check('a one-line preamble is stepped over', () => {
  assert.equal(preambleInsertLine(['#import "@preview/cetz:0.3.0"', '#set text(size: 11pt)', '', '= Title']), 4);
});

check('a rule spanning lines is stepped over whole', () => {
  const lines = ['#set page(', '  paper: "a4",', '  margin: 2cm,', ')', '', '= Title'];
  assert.equal(preambleInsertLine(lines), 6, 'must land after the closing bracket, not inside the call');
});

check('nested brackets are counted', () => {
  const lines = ['#set page(', '  header: [', '    #align(right)[draft]', '  ],', ')', '= Title'];
  assert.equal(preambleInsertLine(lines), 6);
});

check('a bracket inside a string is not a bracket', () => {
  assert.equal(preambleInsertLine(['#set page(paper: "a4)")', '= Title']), 2);
});

check('a bracket inside a comment is not a bracket', () => {
  assert.equal(preambleInsertLine(['#set text(size: 11pt) // widen ( later', '= Title']), 2);
});

check('an escaped quote does not end the string', () => {
  assert.equal(preambleInsertLine(['#set text(font: "a\\"b(")', '= Title']), 2);
});

check('an unclosed rule never offers a spot inside itself', () => {
  assert.equal(preambleInsertLine(['#set page(', '  paper: "a4",']), 1);
});

console.log('\nand the documents it produces compile\n');

const dir = mkdtempSync(join(tmpdir(), 'hilbert-preamble-'));
const cases = [
  ['plain document, highlight + arrow note', '= Title\n\nSome prose.\n', [PINIT, HIGHLIGHT]],
  ['plain document, arrow between two words', '= Title\n\nSome prose.\n', [PINIT, ARROW]],
  ['after Page setup, highlight + arrow note', PAGE_SETUP + '\n= Title\n\nSome prose.\n', [PINIT, HIGHLIGHT]],
  ['after Page setup, arrow between two words', PAGE_SETUP + '\n= Title\n\nSome prose.\n', [PINIT, ARROW]],
  ['after Page setup, a font rule', PAGE_SETUP + '\n= Title\n\nSome prose.\n', ['#set text(font: "Libertinus Serif")\n']],
  ['Page setup with a bracketed header', '#set page(\n  paper: "a4",\n  header: [\n    #align(right)[draft]\n  ],\n)\n\n= Title\n', [PINIT, HIGHLIGHT]],
];

for (const [name, start, additions] of cases) {
  // The import goes to the top; the snippet itself goes where the cursor is,
  // which for this check is the end of the document.
  let doc = start;
  for (const addition of additions) {
    doc = addition.startsWith('#import') || addition.startsWith('#set') ? insertAt(doc, addition) : doc + addition;
  }
  const file = join(dir, `${name.replace(/[^a-z]+/gi, '-')}.typ`);
  writeFileSync(file, doc);
  try {
    await run('typst', ['compile', '--diagnostic-format', 'short', file, join(dir, 'out.pdf')], { cwd: dir });
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    const text = (String(error.stderr || '') + String(error.stdout || '')).trim().split('\n')[0];
    console.log(`  FAIL ${name}\n       ${text}\n${doc.split('\n').map((l, i) => `       ${String(i + 1).padStart(3)} | ${l}`).join('\n')}`);
  }
}
rmSync(dir, { recursive: true, force: true });

console.log(failures ? `\n${failures} failed` : '\nall preamble checks passed');
process.exit(failures ? 1 : 0);
