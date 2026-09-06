// A diagram builder's import belongs at the top of the document, once.
//
// The Feynman and diagram builders used to paste their cetz import in front of
// the figure and hand the whole lot over as one insertion, so the import landed
// wherever the cursor happened to be — in the middle of a sentence, splitting a
// word in half — and a second diagram added a second copy of the same line.
//
// The import is now handed over separately, to be placed at the top only if it
// is not already there. What is checked here is that the builders no longer
// bake it into the body, and that a document built the new way compiles with
// two diagrams in it and one import.
//
//   node scripts/test-builder-imports.mjs
//
// Needs typst on PATH.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

let failures = 0;
const check = (name, run) => {
  try { run(); console.log(`  ok   ${name}`); }
  catch (error) { failures++; console.log(`  FAIL ${name}\n       ${error.message.split('\n')[0]}`); }
};

const builders = [
  ['Feynman builder', 'src/components/FeynmanBuilder.tsx'],
  ['diagram builder', 'src/components/DiagramBuilder.tsx'],
];

console.log('the builders hand the import over instead of pasting it\n');

for (const [label, file] of builders) {
  const source = readFileSync(join(root, file), 'utf8');
  check(`${label} passes the import to the caller`, () => {
    const call = source.match(/onInsert\('\\n' \+ body \+ '\\n\\n'([^)]*)\)/);
    assert.ok(call, 'could not find the onInsert call — has it been renamed?');
    assert.match(call[1], /,\s*imports/, 'the import must be a second argument, not glued onto the body');
  });
  check(`${label} keeps the import out of the body`, () => {
    const bodies = source.match(/body = `[^`]*`/g) || [];
    assert.ok(bodies.length, 'could not find the body templates');
    for (const body of bodies)
      assert.ok(!body.includes('${imports}'), `the import is still baked into a body: ${body.slice(0, 60)}…`);
  });
}

// The exact line each builder asks for, read from the builders themselves.
const importLine = file => {
  const m = readFileSync(join(root, file), 'utf8').match(/const imports = `([^`\\]*)/);
  assert.ok(m, `no import line found in ${file}`);
  return m[1];
};
const FEYNMAN = importLine('src/components/FeynmanBuilder.tsx');
const DIAGRAM = importLine('src/components/DiagramBuilder.tsx');

// What App.tsx does with it: put it at line 1, but only if it is not there yet.
function ensureRule(doc, rule) {
  return doc.includes(rule) ? doc : `${rule}\n${doc}`;
}

console.log('\nand a document built that way compiles\n');

const FIGURE = body => `\n#figure(\n  ${body},\n  caption: [A diagram],\n)\n\n`;
const CANVAS = 'canvas({\n  import draw: *\n  circle((0, 0), radius: 1, stroke: 1pt)\n  line((0, 0), (2, 1), stroke: 1pt)\n})';

const dir = mkdtempSync(join(tmpdir(), 'hilbert-builder-'));
const cases = [
  ['one Feynman diagram', [FEYNMAN]],
  ['two Feynman diagrams', [FEYNMAN, FEYNMAN]],
  ['a Feynman diagram and a cetz diagram', [FEYNMAN, DIAGRAM]],
  ['two of each', [FEYNMAN, DIAGRAM, FEYNMAN, DIAGRAM]],
];

for (const [name, inserts] of cases) {
  // The prose is what the cursor sits in the middle of.
  let doc = '= Notes\n\nA sentence the cursor is parked inside.\n';
  for (const rule of inserts) { doc = ensureRule(doc, rule); doc += FIGURE(CANVAS); }

  // A shorter member list is a substring of a longer one, so asking for
  // "canvas, draw" when "canvas, draw, decorations" is already there correctly
  // adds nothing. What must never happen is the same line twice.
  const importLines = doc.split('\n').filter(l => l.startsWith('#import "@preview/cetz'));
  const duplicate = importLines.find((line, i) => importLines.indexOf(line) !== i);
  if (duplicate) {
    failures++;
    console.log(`  FAIL ${name}\n       this import line appears ${importLines.filter(l => l === duplicate).length} times: ${duplicate}`);
    continue;
  }
  const importCount = importLines.length;
  const firstBody = doc.split('\n').findIndex(l => l.startsWith('#figure'));
  const lastImport = doc.split('\n').findLastIndex(l => l.startsWith('#import'));
  if (lastImport > firstBody) {
    failures++;
    console.log(`  FAIL ${name}\n       an import line sits below the first figure`);
    continue;
  }
  const file = join(dir, `${name.replace(/[^a-z]+/gi, '-')}.typ`);
  writeFileSync(file, doc);
  try {
    await run('typst', ['compile', '--diagnostic-format', 'short', file, join(dir, 'out.pdf')], { cwd: dir });
    console.log(`  ok   ${name} (${importCount} import line, ${inserts.length} figures)`);
  } catch (error) {
    failures++;
    const text = (String(error.stderr || '') + String(error.stdout || '')).trim().split('\n')[0];
    console.log(`  FAIL ${name}\n       ${text}`);
  }
}
rmSync(dir, { recursive: true, force: true });

console.log(failures ? `\n${failures} failed` : '\nall builder-import checks passed');
process.exit(failures ? 1 : 0);
