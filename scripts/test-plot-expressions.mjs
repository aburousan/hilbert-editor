// The Plot Studio draws a curve on screen with JavaScript and writes the same
// curve into the document as Typst. Both come from one parser, and this checks
// the two really do agree: every expression is evaluated here, and again by
// typst itself, and the numbers have to match.
//
//   node scripts/test-plot-expressions.mjs
//
// Needs a built frontend (npm run build) and typst on PATH.
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Node reads the TypeScript source directly (types are stripped); the module
// under test is the one the app ships, not a copy.
const root = resolve(import.meta.dirname, '..');
const { compileExpr, parseExpr } = await import(pathToFileURL(join(root, 'src/plotExpr.ts')).href);

let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

// What people type, and what it has to mean.
const CASES = [
  { src: 'sin(x)', at: [0.3, 1.7, -2.2] },
  { src: 'x^2', at: [0.5, 3, -2] },
  { src: '2x', at: [1.5, -4] },
  { src: '3(x + 1)', at: [2, -0.5] },
  { src: 'x^2/4', at: [2, 5] },
  { src: '-x^2 + 3x - 1', at: [1, -1.5] },
  { src: 'exp(-x^2/2)', at: [0, 1.4] },
  { src: 'calc.sin(x) * calc.exp(x)', at: [0.7] },     // the old Typst spelling
  { src: 'sqrt(abs(x))', at: [4, -9] },
  { src: 'log(x)', at: [100, 3] },                      // base ten
  { src: 'ln(x)', at: [Math.E, 5] },
  { src: 'sin(x)/x', at: [0.6, 3.3] },
  { src: 'tanh(2x)', at: [0.4, -1.1] },
  { src: 'pow(x, 3) - 2', at: [1.7] },
  { src: 'max(x, 1)', at: [0.2, 4] },
  { src: 'pi*x', at: [2] },
  { src: 'x^(1/3)', at: [8] },
  { src: '1/(1 + exp(-x))', at: [0.8, -2] },
  // The ones where Typst and JavaScript do not line up by themselves: the
  // logarithm's base is a named argument, the inverse trig returns an angle,
  // and a half rounds away from zero rather than upwards.
  { src: 'log(x, 2)', at: [8, 1024] },
  { src: 'atan(x)', at: [0.7, -3] },
  { src: 'asin(x/4)', at: [1.5, -2] },
  { src: 'atan2(x, 2)', at: [1.5, -1.5] },
  { src: 'round(x)', at: [-1.5, 1.5, 2.5] },
  { src: 'floor(x)', at: [-1.2, 3.7] },
  { src: 'rem(x, 3)', at: [-5, 7] },
  // Written the way it is on paper, including a bracket straight after a
  // variable or a constant.
  { src: 'x(x + 1)', at: [2, -1.5] },
  { src: 'pi(x + 1)', at: [0.5] },
  { src: '2x^2', at: [3] },
];

const dir = await mkdtemp(join(tmpdir(), 'hilbert-plotexpr-'));
try {
  const rows = [];
  for (const c of CASES) {
    const built = compileExpr(c.src, ['x']);
    if (!built.ok) { check(`reads ${c.src}`, false, built.error); continue; }
    for (const x of c.at) rows.push({ src: c.src, x, typst: built.typst, here: built.fn(x) });
  }
  // One Typst document evaluates every case; `typst query` reads the numbers
  // back out, so this is typst's own arithmetic, not a transcription of it.
  const doc = rows.map(({ typst, x }) => `#metadata({ let x = ${x}; float(${typst}) }) <value>`).join('\n');
  await writeFile(join(dir, 'e.typ'), `#set page(width: 30cm, height: auto)\n${doc}\n`);
  const queried = execFileSync('typst', ['query', join(dir, 'e.typ'), '<value>', '--field', 'value', '--format', 'json'],
    { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const printed = JSON.parse(queried).map(Number);
  check('typst evaluated every case', printed.length === rows.length, `${printed.length} of ${rows.length}`);
  let worst = 0, worstAt = '';
  rows.forEach((row, i) => {
    const there = printed[i];
    const diff = Math.abs(there - row.here) / Math.max(1, Math.abs(row.here));
    if (!(diff < 1e-9)) { worst = Math.max(worst, diff); worstAt = `${row.src} at x=${row.x}: here ${row.here}, typst ${there}`; }
  });
  check('every expression means the same here and in typst', !worstAt, worstAt);

  // Nonsense has to be reported, not silently drawn as a flat line.
  for (const bad of ['sin(', 'x +', 'wobble(x)', 'y^2', '2 $ 3', 'sin(x, x)', '1.2.3', '1e309']) {
    const r = parseExpr(bad, ['x']);
    check(`refuses ${JSON.stringify(bad)}`, !r.ok, r.ok ? 'it was accepted' : r.error);
  }
  // A pole is not an error; the caller decides what to do with infinity.
  const tan = compileExpr('tan(x)', ['x']);
  check('a pole evaluates rather than throwing', tan.ok && Math.abs(tan.fn(Math.PI / 2)) > 1e15);

  // How a curve is cut up for drawing and for the document.
  const { sampleCurve, clipRun } = await import(pathToFileURL(join(root, 'src/plotSampling.ts')).href);
  const view = { xMin: -6.3, xMax: 6.3, yMin: -2.2, yMax: 2.2 };
  const pieces = fn => sampleCurve(fn, view, 420).flatMap(run => clipRun(run, view));
  check('a pole splits the curve in two', sampleCurve(x => 1 / x, view, 420).length === 2);
  check('a steep straight line survives whole', pieces(x => 1000 * (x - 0.01)).length === 1);
  check('tan is cut into its branches', sampleCurve(Math.tan, view, 420).length >= 3);
  check('a smooth curve is one piece', pieces(Math.sin).length === 1);
  const zigzag = clipRun([{ x: 0, y: 2 }, { x: 1, y: -2 }, { x: 2, y: 2 }], { xMin: 0, xMax: 2, yMin: -1, yMax: 1 });
  check('two passes through the window are two pieces', zigzag.length === 2, JSON.stringify(zigzag));
  check('and neither wanders outside it', zigzag.flat().every(p => p.y >= -1.000001 && p.y <= 1.000001));
} catch (error) {
  failures++;
  console.error(error.message);
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\nplot expressions: ${failures} check(s) failed` : '\nplot expressions: the canvas and the document agree');
process.exit(failures ? 1 : 0);
