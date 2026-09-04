// Which language the proofreader thinks a document is in. Getting this wrong is
// quiet and expensive: a French paper checked against an English dictionary
// comes back with every second word underlined, and a French paper checked
// against nothing comes back suspiciously clean.
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

const { documentLanguage } = loadTypeScriptModule('src/documentLanguage.ts');

const cases = [
  ['a document that says nothing', 'Bonjour tout le monde.', 'en', ''],
  ['the plain form', '#set text(lang: "fr")\nBonjour.', 'fr', ''],
  ['spaces around the call', '#set  text ( lang: "de" )\nHallo.', 'de', ''],
  ['with a region', '#set text(lang: "en", region: "GB")\nColour.', 'en', 'GB'],
  ['region before language', '#set text(region: "CH", lang: "de")', 'de', 'CH'],
  ['alongside other settings', '#set text(font: "New Computer Modern", size: 11pt, lang: "es")', 'es', ''],
  // A font list is parenthesised, so anything that stops at the first ")" reads
  // the arguments short and misses the language behind it.
  ['after a nested list', '#set text(font: ("Libertinus Serif", "DejaVu Sans"), lang: "it")', 'it', ''],
  // A paren or a colon inside a string must not be mistaken for structure.
  ['a string holding a paren', '#set text(font: "Weird (Font)", lang: "pt")', 'pt', ''],
  ['a string holding an escape', '#set text(font: "A\\"B", lang: "nl")', 'nl', ''],
  ['upper case tag', '#set text(lang: "FR")', 'fr', ''],
  ['three-letter tag', '#set text(lang: "ckb")', 'ckb', ''],
  // The first set rule is the one that applies to the body.
  ['two declarations', '#set text(lang: "fr")\n\n#set text(lang: "de")', 'fr', ''],
  // Only `#set text` counts. Package arguments called `lang` are somebody
  // else's business.
  ['another function\'s argument', '#codly(lang: "rust")\nHello.', 'en', ''],
  ['a set rule for something else', '#set raw(lang: "python")\nHello.', 'en', ''],
  ['language named in prose', 'We set text(lang: "fr") in the preamble.', 'en', ''],
  ['a show rule around it', '#show: doc => doc\n#set text(lang: "he")', 'he', ''],
  ['leading whitespace', '  \n\n  #set text(lang: "ar")', 'ar', ''],
];

let failures = 0;
for (const [what, text, lang, region] of cases) {
  const got = documentLanguage(text);
  try {
    assert.equal(got.lang, lang, `lang for ${what}`);
    assert.equal(got.region, region, `region for ${what}`);
    console.log(`  ok   ${what} -> ${got.lang}${got.region ? '-' + got.region : ''}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${what}: ${e.message}`);
  }
}

// An unclosed call must not send the scanner off the end of the document.
const truncated = documentLanguage('#set text(lang: "fr"');
assert.equal(truncated.lang, 'fr', 'an unfinished call should still be readable');

if (failures) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log(`\nPASS document language (${cases.length} cases)`);
