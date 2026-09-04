// The matcher behind double-click sync, in the case that used to get it wrong:
// a document that says the same thing more than once.
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

const { bestMatch, tokenizeRenderedText, wordAtOffset, blockEquationStart } = loadTypeScriptModule('src/syncMatch.ts');

// A document that says the same thing over and over: twenty identical lines,
// which is what makes the ±8-word window the PDF sends useless on its own —
// the words around the fourth "world" are identical to those around the tenth.
const line = 'Hello world ';
const source = tokenizeRenderedText(line.repeat(20));
const worldAt = (n) => n * 2 + 1;          // index of the nth (0-based) "world"

// What the PDF sends: the focus word with eight words either side of it.
const windowAround = (n) => {
  const focusIndex = worldAt(n);
  const from = Math.max(0, focusIndex - 8);
  const to = Math.min(source.length, focusIndex + 9);
  return { words: source.slice(from, to), focus: focusIndex - from };
};

// Clicking the tenth "world", with the geometric prior pointing at the top of
// the document (the case where the guess is least helpful).
{
  const { words, focus } = windowAround(9);
  const withRepeat = bestMatch(source, words, focus, 0, { index: 9, count: 20 });
  assert.equal(withRepeat.index, worldAt(9), 'the tenth "world" must resolve to the tenth "world"');
  assert.equal(withRepeat.ambiguous, false);

  // Without the repeat — what reverse sync used to send — the identical context
  // cannot separate the candidates and the click lands somewhere else. This is
  // the bug the fix removes, asserted so a regression is visible.
  const blind = bestMatch(source, words, focus, 0, null);
  assert.notEqual(blind.index, worldAt(9), 'without a repeat the twenty lines are indistinguishable');
}

// The second and third lines, which is how the report described it: clicking
// line 3 used to land on line 2.
{
  const { words, focus } = windowAround(2);
  const hit = bestMatch(source, words, focus, 0, { index: 2, count: 20 });
  assert.equal(hit.index, worldAt(2), 'the third line resolves to the third line');
}

// Right-to-left text goes through the same path: the words are logical order on
// both sides, so nothing about the matcher changes, but assert it anyway.
{
  const hebrewSource = tokenizeRenderedText('שלום עולם שלום עולם שלום עולם');
  const hebrewPhrase = tokenizeRenderedText('שלום עולם שלום עולם שלום עולם');
  const second = bestMatch(hebrewSource, hebrewPhrase, 3, 0, { index: 1, count: 3 });
  assert.equal(second.index, 3, 'Hebrew resolves by repeat exactly as Latin does');
}

// A word that appears once still resolves without any repeat information.
{
  const hay = tokenizeRenderedText('the tidal radius is where the star breaks up');
  const said = tokenizeRenderedText('the star breaks');
  const hit = bestMatch(hay, said, 1, 0, null);
  assert.equal(hay[hit.index], 'star');
}

// Counts that disagree (the PDF has pages the source does not, or vice versa)
// must not be trusted: the guard only fires when both sides agree.
{
  const { words, focus } = windowAround(4);
  const hit = bestMatch(source, words, focus, worldAt(4), { index: 2, count: 7 });
  assert.equal(typeof hit.index, 'number', 'a mismatched count falls back rather than throwing');
}

console.log('sync matcher tests passed');

// Resolving a click inside one rendered span. pdf.js gives a whole phrase a
// single box, so which word was clicked is decided by the character under the
// pointer — not by cutting the box into one equal share per word, which is what
// used to send a click on the first word of "rearrangement of the terms." to
// the third.
{
  const text = 'rearrangement of the terms.';
  const spanWords = ['rearrangement', 'of', 'the', 'terms'];
  const at = (offset) => spanWords[wordAtOffset(text, spanWords, offset)];

  assert.equal(at(0), 'rearrangement', 'the first character');
  assert.equal(at(6), 'rearrangement', 'the middle of a long first word');
  assert.equal(at(12), 'rearrangement', 'its last character');
  assert.equal(at(14), 'of', 'the second word');
  assert.equal(at(17), 'the', 'the third');
  assert.equal(at(21), 'terms', 'the fourth');
  assert.equal(at(100), 'terms', 'past the end');

  // The share-per-word split this replaced: a quarter of the way along the text
  // is still inside "rearrangement", but is the second of four equal shares.
  const quarter = Math.floor(0.25 * text.length);
  assert.equal(at(quarter), 'rearrangement',
    'a quarter of the way along the text is still in the first word');
  assert.equal(spanWords[Math.floor(0.25 * spanWords.length)], 'of',
    'and equal shares per word is exactly what got this wrong');

  // A space belongs to whichever word is nearer, which for the gap right after
  // a word is the word that just ended.
  assert.equal(at(13), 'rearrangement', 'the space just after a word still reads as that word');

  // Words the text does not contain are skipped rather than shifting the rest.
  assert.equal(spanWords[wordAtOffset(text, ['missing', 'of', 'the'], 15)], 'of');
  assert.equal(wordAtOffset(text, ['nothing', 'here'], 3), -1, 'no word found at all');
  assert.equal(wordAtOffset('', [], 0), -1, 'nothing to look in');

  // Tokens are lower-cased, so the text has to be searched that way or every
  // capitalised word goes missing and drags the rest of the mapping with it.
  const sentence = 'The Quick Brown Fox';
  const caps = ['the', 'quick', 'brown', 'fox'];
  assert.equal(caps[wordAtOffset(sentence, caps, 1)], 'the', 'a capitalised first word');
  assert.equal(caps[wordAtOffset(sentence, caps, 5)], 'quick', 'and the one after it');
  assert.equal(caps[wordAtOffset(sentence, caps, 17)], 'fox', 'and the last');

  // A maths glyph arrives as its name and is nowhere in the text it came from.
  // It still has to keep its place, or clicking an operator picks its neighbour.
  const formula = '∑ x = 1';
  const atoms = ['sum', 'x', '1'];
  assert.equal(atoms[wordAtOffset(formula, atoms, 0)], 'sum', 'the operator itself');
  assert.equal(atoms[wordAtOffset(formula, atoms, 2)], 'x', 'the variable after it');
  assert.equal(atoms[wordAtOffset(formula, atoms, 6)], '1', 'and the number');
}
console.log('  ok    click-inside-a-span resolves by character, not by equal shares');

// A repeat count that agrees with the source only by accident.
//
// The count comes from the pages the preview has rendered, not from the whole
// document, so it can equal the number of occurrences in the source without
// meaning the same thing. When that happened it used to decide the match
// outright — and sent a click on a word with unmistakable neighbours to some
// unrelated occurrence chosen by its ordinal.
{
  const source = tokenizeRenderedText(
    'the map value is defined here. ' +           // occurrence 0
    'the number actually stored in the map pixel. ' + // occurrence 1 — the one clicked
    'doubling halves every map value. ' +          // occurrence 2
    'the map is then reported.',                   // occurrence 3
  );
  const phrase = tokenizeRenderedText('the number actually stored in the map pixel');
  const focus = phrase.indexOf('map');
  const hay = source.map(w => w);

  // Context alone finds it.
  const plain = bestMatch(hay, phrase, focus, 0, null);
  assert.equal(hay.slice(plain.index - 5, plain.index).join(' '), 'number actually stored in the',
    'the surrounding words point at one occurrence only');

  // The same click, now carrying a repeat that happens to match the count but
  // names a different occurrence. Context must still win.
  const misleading = bestMatch(hay, phrase, focus, 0, { index: 3, count: 4 });
  assert.equal(misleading.index, plain.index,
    'a coincidental repeat must not override words that plainly match');

  // And where context genuinely cannot tell them apart, the repeat still does.
  const repeated = tokenizeRenderedText('hello world '.repeat(4));
  const both = tokenizeRenderedText('hello world');
  const picked = bestMatch(repeated, both, 0, 0, { index: 2, count: 4 });
  assert.equal(picked.index, 4, 'with nothing to choose between them, the repeat decides');
}
console.log('  ok    a coincidental repeat count no longer overrules the context');

// Finding the nth block equation in a source file.
//
// This is what a click on a numbered equation in the PDF resolves through. It
// counts block equations whether or not they are numbered — the number a reader
// sees is translated into an ordinal separately, by asking Typst what it
// actually printed, because a paper has block equations it does not number and
// counting only the numbered ones puts the two out of step.
{
  const doc = `#set math.equation(numbering: "(1)")

Inline $a = b$ does not count, nor does $x$ in a sentence.

$ E = m c^2 $ <eq:one>

Some prose with $E$ inline again.

$ F = m a $ <eq:two>

// $ this = commented out $

$ p = h \\/ lambda $ <eq:three>
`.split('\n');

  const at = (n) => {
    const found = blockEquationStart(doc, n);
    return found && { line: found.line, text: found.text.trim() };
  };

  assert.equal(at(1).line, 5, 'the first block equation');
  assert.match(at(1).text, /E = m c\^2/);
  assert.equal(at(2).line, 9, 'inline maths in between is not counted');
  assert.match(at(2).text, /F = m a/);
  assert.equal(at(3).line, 13, 'a commented-out equation is not counted');
  assert.match(at(3).text, /p = h/);
  assert.equal(blockEquationStart(doc, 4), null, 'there is no fourth');

  // An equation split across lines is still one equation.
  const wrapped = `$
  alpha = beta
  + gamma
$ <eq:long>

$ delta = 1 $
`.split('\n');
  assert.equal(blockEquationStart(wrapped, 1).line, 1, 'a multi-line equation opens where it opens');
  assert.equal(blockEquationStart(wrapped, 2).line, 6, 'and the next one follows it');

  // An escaped dollar is a dollar sign, not a formula.
  const money = ['It cost \\$5 and then \\$6.', '', '$ a = b $', ''];
  assert.equal(blockEquationStart(money, 1).line, 3, 'escaped dollars are not equations');
}
console.log('  ok    block equations are counted the way the numbering resolver needs');
