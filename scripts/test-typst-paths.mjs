// Issue #50: finding the paths in Typst source that the editor can open.
//
//   node scripts/test-typst-paths.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'src/typstPaths.ts'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
const module = { exports: {} };
Function('exports', 'module', 'require', output)(module.exports, module, () => { throw new Error('unexpected import'); });
const { typstPathLinks, typstPathAt, resolveTypstPath, universeUrl } = module.exports;

const raws = line => typstPathLinks(line).map(l => l.raw);

// The reporter's main.typ lines, indented as they wrote them.
assert.deepEqual(raws('    #include "content/ch-1/_intro.typ"'), ['content/ch-1/_intro.typ']);
assert.deepEqual(raws('#import "lib/utils.typ": *'), ['lib/utils.typ']);
assert.deepEqual(raws('#import "lib/utils.typ" as u'), ['lib/utils.typ']);
// Code mode (no #), and the reading functions.
assert.deepEqual(raws('  include "a.typ"'), ['a.typ']);
assert.deepEqual(raws('#figure(image("figs/plot.png", width: 80%))'), ['figs/plot.png']);
assert.deepEqual(raws('#let data = json( "data/x.json" )'), ['data/x.json']);
assert.deepEqual(raws('#bibliography("refs.bib")'), ['refs.bib']);
assert.deepEqual(raws('#let a = read("a.txt"); let b = csv("b.csv")'), ['a.txt', 'b.csv']);
// Not paths: other strings, method calls with the same name, URLs, plain words.
assert.deepEqual(raws('#let title = "content/ch-1/_intro.typ"'), []);
assert.deepEqual(raws('#let x = image.decode("<svg/>")'), []);
assert.deepEqual(raws('#let x = myimage("a.png")'), []);
assert.deepEqual(raws('#link("https://typst.app")'), []);
assert.deepEqual(raws('We include "this" in the text'), [], 'prose: no #, and not a file name');
assert.deepEqual(raws('#{ include "a.typ" }'), ['a.typ'], 'code without # still counts when it names a file');
// Commented out: nothing to open. A // inside a string is not a comment.
assert.deepEqual(raws('// #include "old.typ"'), []);
assert.deepEqual(raws('#include "a.typ" // #include "b.typ"'), ['a.typ']);
// Escapes inside the string.
assert.deepEqual(raws('#include "we\\"ird.typ"'), ['we"ird.typ']);

// Packages are told apart.
const [pkg] = typstPathLinks('#import "@preview/cetz:0.4.2": canvas, draw');
assert.equal(pkg.kind, 'package');
assert.deepEqual([pkg.namespace, pkg.name, pkg.version], ['preview', 'cetz', '0.4.2']);
assert.equal(universeUrl(pkg), 'https://typst.app/universe/package/cetz/0.4.2');
const [local] = typstPathLinks('#import "@local/mytemplate:1.0.0": *');
assert.equal(local.kind, 'package');
assert.equal(universeUrl(local), null, '@local packages are not on Universe');
assert.deepEqual(raws('#image("@preview/x:1.0.0")'), [], 'a package spec only means a package after import/include');

// Columns: Monaco's, 1-based, covering exactly the text inside the quotes.
const line = '    #include "content/ch-1/_intro.typ"';
const [link] = typstPathLinks(line);
assert.equal(line.slice(link.startColumn - 1, link.endColumn - 1), 'content/ch-1/_intro.typ');
assert.equal(typstPathAt(line, link.startColumn + 3)?.raw, 'content/ch-1/_intro.typ', 'cursor inside the path');
assert.equal(typstPathAt(line, link.startColumn - 1)?.raw, 'content/ch-1/_intro.typ', 'cursor on the opening quote');
assert.equal(typstPathAt(line, link.endColumn + 1)?.raw, 'content/ch-1/_intro.typ', 'cursor just after the closing quote');
assert.equal(typstPathAt(line, 2), null, 'cursor in the indent');

// Resolving: relative to the file it is written in; a leading / from the project root.
assert.equal(resolveTypstPath('main.typ', 'content/ch-1/_intro.typ'), 'content/ch-1/_intro.typ');
assert.equal(resolveTypstPath('content/ch-1/_intro.typ', 'sections/a.typ'), 'content/ch-1/sections/a.typ');
assert.equal(resolveTypstPath('content/ch-1/_intro.typ', '../ch-2/_intro.typ'), 'content/ch-2/_intro.typ');
assert.equal(resolveTypstPath('content/ch-1/_intro.typ', '/template.typ'), 'template.typ');
assert.equal(resolveTypstPath('content/ch-1/_intro.typ', './figs//a.png'), 'content/ch-1/figs/a.png');
assert.equal(resolveTypstPath('main.typ', '../outside.typ'), null, 'cannot climb out of the project');
assert.equal(resolveTypstPath('a/b.typ', '../../x.typ'), null);

console.log('typst-paths tests passed');
