// Every ready-made equation in the Insert menus must actually compile.
//
// The snippets that use physica's macros — expval, braket, dv, mel and the
// rest — only work if the import goes in with them, and each entry carries a
// flag saying so. Miss the flag on one entry and the menu quietly inserts an
// equation that fails to compile: "unknown variable: expval", pointing at a
// line the reader never wrote by hand.
//
// Every snippet in the three menus is compiled here, once without physica and
// once with it, which says exactly what each one needs and whether it is
// typeset-able at all.
//
//   node scripts/test-equation-library.mjs
//
// Needs typst on PATH.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT = '#import "@preview/physica:0.9.8": *';

// Walks to the ']' that closes the '[' at `from`, ignoring brackets that are
// only there inside a string — '[hat(x), hat(p)]' is a commutator, not nesting.
function arrayLiteral(source, from) {
  let depth = 0, quote = null;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return source.slice(from, i + 1);
  }
  throw new Error('unterminated array literal');
}

function readArray(file, declaration) {
  const source = readFileSync(join(root, file), 'utf8');
  const at = source.indexOf(declaration);
  assert.notEqual(at, -1, `${declaration} is no longer in ${file} — update this test`);
  const open = source.indexOf('[', source.indexOf('=', at));
  return Function(`return ${arrayLiteral(source, open)}`)();
}

// Tab stops are for the editor, not for typst: ${1:x} is typed as x.
const plain = text => text
  .replace(/\$\{\d+:([^}]*)\}/g, '$1')
  .replace(/\$\{\d+\}/g, '')
  .replace(/\$\d+/g, '')
  .replace(/\s*\n\s*/g, ' ')
  .trim();

const entries = [];
for (const eq of readArray('src/App.tsx', 'const PHYSICS_EQS'))
  entries.push({ menu: 'Insert → Physics & Cosmology', name: `${eq.group} / ${eq.name}`, code: plain(eq.code), physica: !!eq.physica });
for (const [file, menu] of [['src/components/EquationGallery.tsx', 'Equation gallery'], ['src/components/PhysicsGallery.tsx', 'Insert Physics']])
  for (const category of readArray(file, 'const CATEGORIES'))
    for (const item of category.items)
      entries.push({ menu, name: `${category.name} / ${item.name}`, code: plain(item.snippet), physica: !!item.physica });

assert.ok(entries.length > 50, `only found ${entries.length} snippets — the parser is probably wrong`);
console.log(`${entries.length} snippets from three menus\n`);

const dir = mkdtempSync(join(tmpdir(), 'hilbert-eqlib-'));
// One snippet per compile. Batching them into a single document looks tempting
// and is useless: typst reports the first error and stops, so every snippet
// after the first broken one goes unchecked.
const run = promisify(execFile);
async function compileOne(index, code, withPhysica) {
  const file = join(dir, `s${index}${withPhysica ? '-p' : ''}.typ`);
  writeFileSync(file, `${withPhysica ? IMPORT + '\n' : ''}$ ${code} $\n`);
  try {
    await run('typst', ['compile', '--diagnostic-format', 'short', file, join(dir, `s${index}.pdf`)], { cwd: dir });
    return null;
  } catch (error) {
    const text = String(error.stderr || '') + String(error.stdout || '');
    const first = text.split('\n').map(l => l.match(/: error: (.*)$/)).find(Boolean);
    return first ? first[1].trim() : text.trim().split('\n')[0] || 'failed to compile';
  }
}

// typst spends most of a run starting up, so a handful at a time keeps this
// to a few seconds rather than a minute.
async function pool(items, worker, width = 8) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  }));
  return out;
}

process.stdout.write('compiling each snippet without physica... ');
const plainResults = await pool(entries, (entry, i) => compileOne(i, entry.code, false));
console.log('done');
const needsChecking = entries.map((entry, i) => ({ entry, i })).filter(({ i }) => plainResults[i]);
process.stdout.write(`re-compiling the ${needsChecking.length} that failed, with physica... `);
const withResults = await pool(needsChecking, ({ entry, i }) => compileOne(i, entry.code, true));
console.log('done\n');
rmSync(dir, { recursive: true, force: true });

const missingFlag = [], broken = [];
needsChecking.forEach(({ entry, i }, slot) => {
  const stillBroken = withResults[slot];
  if (stillBroken) broken.push({ entry, reason: stillBroken });
  else if (!entry.physica) missingFlag.push({ entry, reason: plainResults[i] });
});

if (missingFlag.length) {
  console.log(`${missingFlag.length} snippet(s) need physica but are not marked, so they insert an equation that will not compile:`);
  for (const { entry, reason } of missingFlag) console.log(`  ${entry.menu} — ${entry.name}\n      ${reason}\n      ${entry.code}`);
  console.log();
}
if (broken.length) {
  console.log(`${broken.length} snippet(s) do not compile even with physica:`);
  for (const { entry, reason } of broken) console.log(`  ${entry.menu} — ${entry.name}\n      ${reason}\n      ${entry.code}`);
  console.log();
}

assert.equal(missingFlag.length, 0, 'every snippet using physica must be marked physica: true');
assert.equal(broken.length, 0, 'every snippet in the Insert menus must compile');
console.log(`all ${entries.length} snippets compile, and each one that needs physica asks for it`);
