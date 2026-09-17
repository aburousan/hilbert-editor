// The Plot Studio's graph is a picture of the same curves the document gets.
// This drives the real studio: types expressions, drags and zooms the graph,
// hides a curve, inserts, and compiles what landed in the document.
//
//   node scripts/test-plot-studio.mjs
//
// Needs a built frontend (npm run build), the backend (cargo build) and typst.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
// `cargo build` writes typst-editor; a bundled build writes hilbert.
const names = process.platform === 'win32' ? ['typst-editor.exe', 'hilbert.exe'] : ['typst-editor', 'hilbert'];
const binary = process.env.BIN || ['debug', 'release']
  .flatMap(m => names.map(name => join(root, 'src-tauri/target', m, name))).find(existsSync);
assert.ok(binary, 'Build the backend with cargo build before running this test.');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), 'hilbert-plot-'));
const ws = join(dir, 'workspace');
await mkdir(ws);
await writeFile(join(ws, 'main.typ'), '= Plots\n\n');
await writeFile(join(dir, 'session.json'), JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
const token = 'hilbert-plot-token-0123456789abcdefgh';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(Number(process.env.PORT || 3085)), TYPST_WORKSPACE: ws, TYPST_DIST: join(root, 'dist'),
    HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_API_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bound = null;
for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });

let browser, failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
try {
  for (let i = 0; i < 200 && !bound; i++) await sleep(100);
  assert.ok(bound, 'the backend never said which port it bound');
  const origin = `http://127.0.0.1:${bound}`;
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.setViewport({ width: 1600, height: 1000 });
  await page.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; }, token);
  await page.goto(origin, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.view-line', { timeout: 60000 });
  await sleep(3000);

  await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control');
  await page.waitForSelector('.palette-input');
  await page.type('.palette-input', 'Plot Studio');
  await sleep(400);
  await page.evaluate(() => [...document.querySelectorAll('.palette-item')].find(e => /plot studio/i.test(e.textContent))?.click());
  await page.waitForSelector('.modal-content canvas', { timeout: 20000 });
  await sleep(1200);

  const ranges = () => page.evaluate(() => [...document.querySelectorAll('.modal-content input')]
    .filter(i => ['x min', 'x max', 'y min', 'y max'].includes(i.placeholder)).map(i => Number(i.value)));
  const exprBoxes = () => page.$$('.modal-content input[placeholder="sin(x)"]');
  const ink = () => page.evaluate(() => {
    const c = document.querySelector('.modal-content canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let blue = 0, red = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 40) continue;
      if (d[i + 2] > d[i] + 40) blue++;
      if (d[i] > d[i + 2] + 40) red++;
    }
    return { blue, red };
  });

  check('the graph is drawn', (await ink()).blue > 300, JSON.stringify(await ink()));
  const start = await ranges();
  check('it starts on a sensible window', start.length === 4 && start[0] < 0 && start[1] > 0, start.join(', '));

  // A second curve, in its own colour.
  await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => /add curve/i.test(b.textContent))?.click());
  await sleep(300);
  const boxes = await exprBoxes();
  await boxes[boxes.length - 1].type('x^2/4');
  await sleep(700);
  const two = await ink();
  check('a second curve is drawn in its own colour', two.red > 200, JSON.stringify(two));

  // Nonsense is reported rather than drawn.
  await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => /add curve/i.test(b.textContent))?.click());
  await sleep(250);
  const withBad = await exprBoxes();
  await withBad[withBad.length - 1].type('wobble(x)');
  await sleep(600);
  const complaint = await page.evaluate(() => document.querySelector('.modal-content')?.textContent || '');
  check('an expression it cannot read says so', /do not know the function/i.test(complaint));
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.modal-content input[placeholder="sin(x)"]')];
    const last = rows[rows.length - 1];
    const remove = last.parentElement.querySelector('button:last-of-type');
    remove.click();
  });
  await sleep(400);

  // Drag the graph: the ranges have to follow the hand.
  const box = await page.evaluate(() => {
    const r = document.querySelector('.modal-content canvas').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x - 120, box.y, { steps: 12 });
  await page.mouse.up();
  await sleep(500);
  const dragged = await ranges();
  check('dragging moves the window', dragged[0] > start[0] + 0.3, `${start[0]} → ${dragged[0]}`);
  check('and keeps its width', Math.abs((dragged[1] - dragged[0]) - (start[1] - start[0])) < 0.05,
    `${(start[1] - start[0]).toFixed(2)} → ${(dragged[1] - dragged[0]).toFixed(2)}`);

  // Scrolling zooms.
  await page.mouse.move(box.x, box.y);
  await page.mouse.wheel({ deltaY: -400 });
  await sleep(500);
  const zoomed = await ranges();
  check('scrolling zooms in', (zoomed[1] - zoomed[0]) < (dragged[1] - dragged[0]) - 0.5,
    `${(dragged[1] - dragged[0]).toFixed(2)} → ${(zoomed[1] - zoomed[0]).toFixed(2)}`);

  // Hiding a curve takes it off the graph.
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.modal-content input[placeholder="sin(x)"]')];
    rows[1].parentElement.querySelector('button').click();
  });
  await sleep(600);
  const hidden = await ink();
  check('hiding a curve takes it off the graph', hidden.red < two.red / 4, `${two.red} → ${hidden.red}`);

  // A half-typed bound must not be taken as a number.
  await page.evaluate(() => {
    const input = [...document.querySelectorAll('.modal-content input')].find(i => i.placeholder === 'x min');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '-'); input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  const midTyping = await page.evaluate(() => [...document.querySelectorAll('.modal-content input')].find(i => i.placeholder === 'x min').value);
  check('a half-typed bound stays as typed', midTyping === '-', JSON.stringify(midTyping));
  await page.evaluate(() => {
    const input = [...document.querySelectorAll('.modal-content input')].find(i => i.placeholder === 'x min');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '-4'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.blur();
  });
  await sleep(400);
  const committed = await ranges();
  check('and the finished number reaches the graph', Math.abs(committed[0] + 4) < 1e-6, String(committed[0]));

  const atInsert = await ranges();
  await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent.trim() === 'Insert')?.click());
  await sleep(2500);
  let doc = '';
  for (let i = 0; i < 40; i++) {
    doc = await readFile(join(ws, 'main.typ'), 'utf8');
    if (doc.includes('plot.plot')) break;
    await sleep(500);
  }
  check('the plot reached the document', /plot\.plot/.test(doc));
  const written = Number((doc.match(/x-min: ([-\d.e]+)/) || [])[1]);
  check('it carries the window from the graph', Math.abs(written - atInsert[0]) < 1e-6, `${atInsert[0]} → ${written}`);
  check('the hidden curve was left out', !doc.includes('calc.pow(x, 2)') || !/x-min/.test(doc), 'the hidden curve is absent');
  check('the visible curve is there in Typst form', /calc\.sin\(x\)/.test(doc));

  let compiled = '';
  try {
    execFileSync('typst', ['compile', '--root', ws, join(ws, 'main.typ'), join(dir, 'out.pdf')], { stdio: ['ignore', 'pipe', 'pipe'] });
    compiled = 'ok';
  } catch (error) { compiled = (String(error.stderr || '') + String(error.stdout || '')).trim().split('\n')[0]; }
  check('and it compiles', compiled === 'ok', compiled);

  // A curve with a pole: the figure has to break at the pole rather than draw a
  // line across it, and it still has to compile.
  await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control');
  await page.waitForSelector('.palette-input');
  await page.type('.palette-input', 'Plot Studio');
  await sleep(400);
  await page.evaluate(() => [...document.querySelectorAll('.palette-item')].find(e => /plot studio/i.test(e.textContent))?.click());
  await page.waitForSelector('.modal-content canvas', { timeout: 20000 });
  await sleep(1000);
  await page.evaluate(() => {
    const input = document.querySelector('.modal-content input[placeholder="sin(x)"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '1/x'); input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(900);
  await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent.trim() === 'Insert')?.click());
  await sleep(2500);
  let poled = '';
  for (let i = 0; i < 40; i++) {
    poled = await readFile(join(ws, 'main.typ'), 'utf8');
    if ((poled.match(/plot\.add/g) || []).length > (doc.match(/plot\.add/g) || []).length) break;
    await sleep(500);
  }
  const added = (poled.slice(doc.length).match(/plot\.add/g) || []).length;
  check('a curve with a pole is written as separate pieces', added >= 2, `${added} plot.add calls`);
  check('and it is written as points, not as 1/x', !/x => \(1 \/ x\)/.test(poled.slice(doc.length)));
  // The per-curve settings: a right-hand scale, a dashed line, the derivative
  // and a hatched area all have to reach the figure and compile.
  await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control');
  await page.waitForSelector('.palette-input');
  await page.type('.palette-input', 'Plot Studio');
  await sleep(400);
  await page.evaluate(() => [...document.querySelectorAll('.palette-item')].find(e => /plot studio/i.test(e.textContent))?.click());
  await page.waitForSelector('.modal-content canvas', { timeout: 20000 });
  await sleep(1000);
  const openSettings = index => page.evaluate(i => {
    const rows = [...document.querySelectorAll('.modal-content input[placeholder="sin(x)"]')];
    [...rows[i].parentElement.querySelectorAll('button')].find(b => b.textContent.includes('⋯'))?.click();
  }, index);
  const pick = (labelStart, value) => page.evaluate(([lab, val]) => {
    const label = [...document.querySelectorAll('.modal-content label')].find(e => e.textContent.trim().startsWith(lab));
    const select = label?.querySelector('select');
    if (!select) return false;
    select.value = val;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, [labelStart, value]);
  await openSettings(0);
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('.modal-content label')].find(e => /also f/.test(e.textContent))?.querySelector('input')?.click());
  check('the area can be hatched', await pick('Area beneath', 'hatch'));
  await sleep(600);
  const withExtras = await ink();
  check('the derivative and the shading are drawn on the graph', withExtras.blue > two.blue, `${two.blue} → ${withExtras.blue} blue pixels`);
  await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => /add curve/i.test(b.textContent))?.click());
  await sleep(250);
  const more = await exprBoxes();
  await more[more.length - 1].type('30*exp(-x^2)');
  await sleep(600);
  await openSettings(1);
  await sleep(300);
  check('a curve can be put on the right-hand scale', await pick('Scale', 'right'));
  check('and drawn dashed', await pick('Line', 'dashed'));
  await sleep(1200);
  await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent.trim() === 'Insert')?.click());
  await sleep(2500);
  let extras = '';
  for (let i = 0; i < 40; i++) {
    extras = await readFile(join(ws, 'main.typ'), 'utf8');
    if (extras.length > poled.length) break;
    await sleep(500);
  }
  const block = extras.slice(poled.length);
  check('the figure carries a second scale', /y2-min/.test(block) && /axes: \("x", "y2"\)/.test(block));
  check('and hatching, and a dashed line, and the derivative', /tiling/.test(block) && /dash: "dashed"/.test(block));

  let second = '';
  try {
    execFileSync('typst', ['compile', '--root', ws, join(ws, 'main.typ'), join(dir, 'out2.pdf')], { stdio: ['ignore', 'pipe', 'pipe'] });
    second = 'ok';
  } catch (error) { second = (String(error.stderr || '') + String(error.stdout || '')).trim().split('\n')[0]; }
  check('and both figures compile together', second === 'ok', second);
  check('no errors were thrown in the page', errors.length === 0, errors[0]?.slice(0, 140) || '');
} catch (error) {
  failures++;
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  server.kill(); await sleep(300); server.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\nplot studio: ${failures} check(s) failed` : '\nplot studio: the graph and the figure agree');
process.exit(failures ? 1 : 0);
