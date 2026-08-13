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

const {
  BIDI_MARKS,
  HAS_RTL,
  INVISIBLE,
  INVISIBLE_ALL,
  blockAfter,
  detectedDirection,
  findTextRules,
  invisibleName,
  isolateMarks,
  isRtlLanguage,
  isTextDirection,
  lineDirection,
  namedArgument,
  segmentLine,
  setNamedArgument,
  unquoteTypstString,
} = loadTypeScriptModule('src/textDirection.ts');

// The direction Typst gives each of these was measured by compiling a document
// per language and reading which way the line came out, not taken on trust.
for (const code of ['ar', 'he', 'fa', 'ur', 'dv', 'ps', 'sd', 'ug', 'yi']) {
  assert.equal(isRtlLanguage(code), true, `${code} is right-to-left`);
}
for (const code of ['en', 'hi', 'bn', 'ku', 'de', 'ja']) {
  assert.equal(isRtlLanguage(code), false, `${code} is left-to-right`);
}
// Regional forms still name the same language.
assert.equal(isRtlLanguage('AR'), true);
assert.equal(isRtlLanguage('fa-IR'), true);
assert.equal(isRtlLanguage('en_GB'), false);

assert.equal(isTextDirection('auto'), true);
assert.equal(isTextDirection('rtl'), true);
assert.equal(isTextDirection('sideways'), false);
assert.equal(isTextDirection(null), false);

// Isolates have to be the real code points; a mangled one would be invisible
// in a diff and would quietly stop fencing anything off.
assert.deepEqual(isolateMarks('rtl'), ['⁧', '⁩']);
assert.deepEqual(isolateMarks('ltr'), ['⁦', '⁩']);
assert.deepEqual(isolateMarks('auto'), ['⁨', '⁩']);
assert.deepEqual(
  BIDI_MARKS.map(m => m.char),
  ['‏', '‎', '؜', '⁧', '⁦', '⁨', '⁩'],
);
for (const mark of BIDI_MARKS) {
  assert.equal(mark.char.length, 1, `${mark.id} is a single character`);
}

// Typst is not prose --------------------------------------------------------

// The reason the heuristic has to know Typst at all: the first letter of this
// line is the "e" of emph, so the literal first-strong rule calls it
// left-to-right and the whole line comes out backwards.
assert.equal(lineDirection('#emph[שלום]'), 'rtl');
assert.equal(lineDirection('#text(fill: red)[שלום] and more'), 'rtl');
assert.equal(lineDirection('עברית #strong[מודגש] סוף'), 'rtl');
// Maths and raw are written in Latin whatever the sentence around them is.
assert.equal(lineDirection('שלום $x = 1$ עולם'), 'rtl');
assert.equal(lineDirection('טקסט `code` עוד'), 'rtl');
assert.equal(lineDirection('Hello $x = 1$ world'), 'ltr');
// A line that is only maths, or only code, has no prose to ask.
assert.equal(lineDirection('$ E = m c^2 $'), 'ltr');
assert.equal(lineDirection('#set text(lang: "he")'), 'ltr');
assert.equal(lineDirection('#let x = 5'), 'ltr');
assert.equal(lineDirection('#import "@preview/x:0.1.0": *'), 'ltr');
// A caption inside a call is still inside the call, so the line reads as code.
assert.equal(lineDirection('#figure(image("a.png"), caption: [כיתוב])'), 'ltr');
// Labels and references are syntax; the sentence holding them is not.
assert.equal(lineDirection('ראה @sec:intro <sec:one>'), 'rtl');

const code = line => segmentLine(line).filter(s => s.code).map(s => line.slice(s.start, s.end));
assert.deepEqual(code('שלום $x = 1$ עולם'), ['$x = 1$']);
assert.deepEqual(code('#emph[שלום]'), ['#emph']);
assert.deepEqual(code('ראה @sec:intro <sec:one>'), ['@sec:intro', '<sec:one>']);
assert.deepEqual(code('a ```rust let x ``` b'), ['```rust let x ```']);
// A bracket inside a string must not end the call early.
assert.deepEqual(code('#link("a)b")[שלום]'), ['#link("a)b")']);
// An escaped dollar is a dollar sign, not the start of a formula.
assert.deepEqual(code('\\$5 and \\$6'), []);
// Unclosed maths runs to the end of the line instead of hanging the scanner.
assert.deepEqual(code('שלום $x = 1'), ['$x = 1']);
// Every line is covered exactly once, whatever it contains.
for (const sample of ['#emph[שלום]', 'שלום $x = 1$ עולם', '', 'plain', '#let x = 5', '$$', '#']) {
  const segments = segmentLine(sample);
  assert.equal(segments.map(s => sample.slice(s.start, s.end)).join(''), sample, sample);
  for (let i = 1; i < segments.length; i++) assert.equal(segments[i].start, segments[i - 1].end, sample);
}



// Which way a line runs -----------------------------------------------------

assert.equal(lineDirection('Plain English line.'), 'ltr');
assert.equal(lineDirection('שלום עולם.'), 'rtl');
assert.equal(lineDirection('مرحبا Hilbert'), 'rtl');
// Leading punctuation is neutral, so the heuristic looks past it — which is
// what makes a Typst heading in Hebrew come out right.
assert.equal(lineDirection('= כותרת'), 'rtl');
assert.equal(lineDirection('= Title'), 'ltr');
// A line of Typst code stays left-to-right even in a right-to-left document.
assert.equal(lineDirection('#set text(lang: "he")'), 'ltr');
// Nothing strong at all falls back rather than guessing.
assert.equal(lineDirection(''), 'ltr');
assert.equal(lineDirection('   123 ...'), 'ltr');
// A mark at the start is how you flip a line by hand.
assert.equal(lineDirection('\u200f123 ILS'), 'rtl');
assert.equal(lineDirection('\u200eשלום'), 'ltr');
// A document with no RTL in it can be skipped without looking at its lines.
assert.equal(HAS_RTL.test('#set text(lang: "en")\nplain ascii'), false);
assert.equal(HAS_RTL.test('שלום'), true);

// Reading the document ------------------------------------------------------

assert.deepEqual(detectedDirection(''), { lang: 'en', dir: 'auto' });
assert.deepEqual(
  detectedDirection('#set text(font: "Amiri", lang: "ar")'),
  { lang: 'ar', dir: 'auto' },
);
assert.deepEqual(
  detectedDirection('#set text(lang: "he", dir: rtl)'),
  { lang: 'he', dir: 'rtl' },
);
// Typst applies the last rule it reads, so the dialog has to show that one.
assert.deepEqual(
  detectedDirection('#set text(lang: "en")\n= Title\n#set text(lang: "he")'),
  { lang: 'he', dir: 'auto' },
);
// A rule inside a nested call must not end the outer one early.
assert.deepEqual(
  detectedDirection('#set text(font: ("Amiri", "Noto Naskh Arabic"), lang: "fa")'),
  { lang: 'fa', dir: 'auto' },
);
// Nor may a parenthesis inside a string.
assert.equal(namedArgument(findTextRules('#set text(font: "A (B)", lang: "ur")')[0].body, 'lang'), '"ur"');

// An explicit direction is read back as itself, so the dialog can show that a
// document overrules its own language.
assert.equal(detectedDirection('#set text(lang: "he", dir: ltr)').dir, 'ltr');
assert.equal(detectedDirection('#set text(lang: "en", dir: rtl)').dir, 'rtl');

assert.equal(unquoteTypstString('"he"'), 'he');
assert.equal(unquoteTypstString('"say \\"hi\\""'), 'say "hi"');
assert.equal(unquoteTypstString('rtl'), null);
assert.equal(unquoteTypstString(null), null);

// Writing it back -----------------------------------------------------------

// An existing argument keeps its place in the list rather than moving to the end.
assert.equal(
  setNamedArgument('font: "Amiri", lang: "en", size: 11pt', 'lang', '"ar"'),
  'font: "Amiri", lang: "ar", size: 11pt',
);
assert.equal(
  setNamedArgument('font: "Amiri"', 'lang', '"ar"'),
  'font: "Amiri", lang: "ar"',
);
// Choosing "from the language" takes dir back out instead of pinning it.
assert.equal(
  setNamedArgument('lang: "he", dir: rtl', 'dir', null),
  'lang: "he"',
);
assert.equal(setNamedArgument('lang: "he"', 'dir', null), 'lang: "he"');
// Removing the only argument leaves nothing behind, not a stray space.
assert.equal(setNamedArgument('dir: rtl', 'dir', null), '');
// Whitespace around a multi-line rule survives being edited.
assert.equal(
  setNamedArgument('\n  font: "Amiri",\n  size: 11pt,\n', 'lang', '"ar"'),
  '\n  font: "Amiri",\n  size: 11pt, lang: "ar"\n',
);

// A round trip through both halves has to agree with itself.
for (const lang of ['ar', 'he', 'en', 'fa']) {
  for (const dir of ['auto', 'ltr', 'rtl']) {
    const body = setNamedArgument(setNamedArgument('size: 11pt', 'lang', `"${lang}"`), 'dir', dir === 'auto' ? null : dir);
    const read = detectedDirection(`#set text(${body})`);
    assert.deepEqual(read, { lang, dir }, `round trip for ${lang}/${dir}`);
  }
}

// Blocks that outlive the line that opened them. Walking a document is a fold
// over these: whatever comes back is the state the next line starts in.
function walk(source) {
  let open = null;
  return source.split('\n').map(line => {
    const before = open;
    open = blockAfter(line, open);
    return before ? before.kind : null;
  });
}
assert.deepEqual(walk('```python\nprint("שלום")\n```\nafter'), [null, 'raw', 'raw', null]);
assert.deepEqual(walk('$\n  "טקסט" + x\n$\nafter'), [null, 'math', 'math', null]);
// A longer fence is not closed by a shorter one.
assert.deepEqual(walk('````\n```\nstill raw\n````\nafter'), [null, 'raw', 'raw', 'raw', null]);
// Inline raw and inline maths stay on their line.
assert.deepEqual(walk('a `x` b\nc'), [null, null]);
assert.deepEqual(walk('a $x$ b\nc'), [null, null]);
// An escaped dollar is a dollar sign, not the start of a formula.
assert.deepEqual(walk('costs \\$5 today\nplain'), [null, null]);
// Backticks inside a formula are maths, not a fence.
assert.deepEqual(walk('$ a ` b $\nplain'), [null, null]);
// A dollar in a comment or a string opens nothing. Either false positive would
// leave the whole rest of the document looking like the inside of a formula.
assert.deepEqual(walk('// costs $5 today\nשלום'), [null, null]);
assert.deepEqual(walk('#let sign = "$"\nשלום'), [null, null]);
assert.deepEqual(walk('He said "it costs $5" and left\nשלום'), [null, null]);
// The slashes in a URL are inside a string, so they are not a comment.
assert.deepEqual(walk('#link("https://a.b")[$x$]\nשלום'), [null, null]);
// An unclosed quote is punctuation, not a string, so what follows still counts.
assert.deepEqual(walk('התשפ"ו $\n  x\n$'), [null, 'math', 'math']);

// Invisible characters. Every mark the Insert menu can drop into a document
// has to be one the editor will then draw a hairline for, or the reader ends up
// with a file that reorders itself around nothing they can see.
for (const mark of BIDI_MARKS) {
  assert.ok(INVISIBLE.test(mark.char), `${mark.id} is marked as invisible`);
  assert.equal(invisibleName(mark.char), `${mark.label} (U+${mark.char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`);
}
// The older embedding codes are not on the Insert menu but turn up in pasted
// text, and a right-to-left override is worth being loud about.
assert.equal(invisibleName('\u202e'), 'Right-to-left override (U+202E)');
assert.equal(invisibleName('\u0007'), 'Control character (U+0007)');
// Tab and newline are structure, not contraband.
assert.equal(INVISIBLE.test('\t'), false);
assert.equal(INVISIBLE.test('\n'), false);
assert.equal(INVISIBLE.test('plain text'), false);
// The global copy has to find every one of them, not just the first.
assert.deepEqual(
  [...'a\u200fb\u2066c'.matchAll(INVISIBLE_ALL)].map(m => m[0]),
  ['\u200f', '\u2066'],
);

console.log('text direction: ok');
