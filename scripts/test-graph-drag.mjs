// Dragging the label graph must slide it, not shake it.
//
// The pan measured each movement against the view it was moving, so the
// movement fed back into its own input: every other pointer event cancelled
// itself, the drawing travelled less than half as far as the cursor, and what
// you saw was a stutter rather than a slide.
//
// The pointer is walked steadily in one direction here and the drawing's
// transform is read after every step. A slide gives equal steps and ends up
// where the cursor did; anything else is the bug coming back.
//
//   node scripts/test-graph-drag.mjs
//
// Needs a built frontend (npm run build) and backend (cd src-tauri && cargo build).
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const TOKEN = 'graph-drag-token-0123456789abcdefgh';
const PORT = Number(process.env.PORT || 3097);
const WIDTH = 1600; // the graph's own coordinate width, from LabelGraph.tsx
const sleep = ms => new Promise(r => setTimeout(r, ms));

const binary = ['target/release/typst-editor', 'target/debug/typst-editor']
  .map(p => join(root, 'src-tauri', p)).find(existsSync);
if (!binary) {
  console.error('No backend binary. Run: cd src-tauri && cargo build');
  process.exit(2);
}
if (!existsSync(join(root, 'dist/index.html'))) {
  console.error('No built frontend. Run: npm run build');
  process.exit(2);
}

const dir = await mkdtemp(join(tmpdir(), 'hilbert-graphdrag-'));
const home = join(dir, 'home');
const ws = join(dir, 'ws');
for (const d of [join(home, 'Library/Application Support/hilbert'), join(home, '.config/hilbert'), ws]) {
  await mkdir(d, { recursive: true });
}

// Enough labels that there is a graph worth dragging.
let doc = '#set math.equation(numbering: "(1)")\n\n= A document with labels\n\n';
for (let i = 1; i <= 12; i++) {
  doc += `== Section ${i} <sec:s${i}>\n\n`
    + `Prose for section ${i}, referring to @eq:e${Math.max(1, i - 1)}.\n\n`
    + `$ x_${i} = y_${i} + ${i} $ <eq:e${i}>\n\n`;
}
await writeFile(join(ws, 'main.typ'), doc);

const session = JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' });
const sessionFile = join(home, 'Library/Application Support/hilbert/session.json');
await writeFile(sessionFile, session);
await writeFile(join(home, '.config/hilbert/session.json'), session);

const server = spawn(binary, ['--headless'], {
  env: { ...process.env, HOME: home, TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
         HILBERT_SESSION_FILE: sessionFile, HILBERT_API_TOKEN: TOKEN, PORT: String(PORT) },
  stdio: 'ignore',
});

let browser;
const cleanup = async () => {
  try { await browser?.close(); } catch {}
  server.kill();
  try { await once(server, 'exit'); } catch {}
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(dir, { recursive: true, force: true }); return; } catch { await sleep(250); }
  }
};

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {}
    await sleep(500);
  }

  browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--window-size=1500,950'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  await page.setCookie({ name: 'hilbert_session', value: TOKEN, domain: '127.0.0.1', path: '/' });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(14000);

  // View → Label Graph
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.menu-item'))
      .find(e => e.textContent.trim().startsWith('View'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await sleep(800);
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.dropdown-item'))
      .find(e => /Label Graph/.test(e.textContent))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await sleep(6000);

  const translation = () => page.evaluate(() => {
    const g = document.querySelector('.modal-content svg > g');
    const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(g?.getAttribute('transform') || '');
    return m ? Number(m[1]) : null;
  });
  if ((await translation()) === null) throw new Error('the label graph did not open');

  // Somewhere on the background, not on a label.
  const box = await page.evaluate(() => {
    const b = document.querySelector('.modal-content svg').getBoundingClientRect();
    return { x: Math.round(b.left + b.width * 0.35), y: Math.round(b.top + b.height * 0.78), width: b.width };
  });

  const STEP = 12;
  const STEPS = 12;
  const before = await translation();
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  const seen = [];
  for (let step = 1; step <= STEPS; step++) {
    await page.mouse.move(box.x + step * STEP, box.y);
    await sleep(90);
    seen.push(await translation());
  }
  await page.mouse.up();

  const deltas = seen.slice(1).map((v, i) => +(v - seen[i]).toFixed(2));
  const backwards = deltas.filter(d => d < 0).length;
  const stalled = deltas.filter(d => d === 0).length;
  const travelled = seen[seen.length - 1] - before;
  const expected = STEPS * STEP * (WIDTH / box.width);
  const ratio = travelled / expected;
  const spread = Math.max(...deltas) - Math.min(...deltas);

  console.log(`  steps: ${deltas.join(' ')}`);
  console.log(`  ${backwards === 0 ? 'ok  ' : 'FAIL'}  none of the ${deltas.length} steps went backwards`);
  console.log(`  ${stalled === 0 ? 'ok  ' : 'FAIL'}  none of them stalled`);
  console.log(`  ${spread < 1 ? 'ok  ' : 'FAIL'}  the steps are even (spread ${spread.toFixed(2)})`);
  console.log(`  ${ratio > 0.9 && ratio < 1.1 ? 'ok  ' : 'FAIL'}  it followed the cursor `
    + `(${travelled.toFixed(0)} against ${expected.toFixed(0)}, ${(ratio * 100).toFixed(0)}%)`);

  // The other half of the feature: dragging a label, which lives inside the
  // zoom rather than outside it and so converts differently.
  const label = await page.evaluate(() => {
    const circle = document.querySelector('.modal-content svg g[transform] g circle');
    if (!circle) return null;
    const b = circle.getBoundingClientRect();
    const g = circle.closest('g');
    const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(g.getAttribute('transform') || '');
    return m ? { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), at: Number(m[1]) } : null;
  });
  let labelMoved = null;
  if (label) {
    await page.mouse.move(label.x, label.y);
    await page.mouse.down();
    for (let step = 1; step <= 6; step++) {
      await page.mouse.move(label.x + step * 10, label.y);
      await sleep(80);
    }
    await page.mouse.up();
    await sleep(300);
    labelMoved = await page.evaluate((startedAt) => {
      const circles = Array.from(document.querySelectorAll('.modal-content svg g[transform] g'));
      const hit = circles.find(g => {
        const m = /translate\(([-\d.]+) /.exec(g.getAttribute('transform') || '');
        return m && Math.abs(Number(m[1]) - startedAt) < 200;
      });
      const m = hit && /translate\(([-\d.]+) /.exec(hit.getAttribute('transform') || '');
      return m ? Number(m[1]) - startedAt : null;
    }, label.at);
  }
  const labelExpected = 60 * (WIDTH / box.width);
  const labelOk = labelMoved !== null && labelMoved > labelExpected * 0.7 && labelMoved < labelExpected * 1.4;
  console.log(`  ${labelOk ? 'ok  ' : 'FAIL'}  a label follows the cursor too `
    + `(moved ${labelMoved === null ? 'nothing' : labelMoved.toFixed(0)}, cursor worth ${labelExpected.toFixed(0)})`);

  // Zooming should keep what is under the pointer under the pointer. Scaling
  // about the corner instead sends the label you were reading off the side.
  const circleAt = () => page.evaluate(() => {
    const c = document.querySelectorAll('.modal-content svg g[transform] g circle')[8];
    if (!c) return null;
    const b = c.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  });
  const zoomFrom = await circleAt();
  let drift = null;
  if (zoomFrom) {
    await page.mouse.move(zoomFrom.x, zoomFrom.y);
    for (let i = 0; i < 4; i++) { await page.mouse.wheel({ deltaY: -120 }); await sleep(200); }
    await sleep(500);
    const zoomTo = await circleAt();
    if (zoomTo) drift = Math.hypot(zoomTo.x - zoomFrom.x, zoomTo.y - zoomFrom.y);
  }
  const zoomOk = drift !== null && drift < 15;
  console.log(`  ${zoomOk ? 'ok  ' : 'FAIL'}  zooming holds the pointer's label in place `
    + `(drifted ${drift === null ? 'unknown' : drift.toFixed(1)}px over four steps)`);

  await cleanup();
  if (backwards || stalled || spread >= 1 || ratio <= 0.9 || ratio >= 1.1 || !labelOk || !zoomOk) {
    console.error('\ngraph drag: the view does not follow the cursor smoothly');
    process.exit(1);
  }
  console.log('\ngraph drag: the graph slides with the cursor, one step per movement');
} catch (error) {
  await cleanup();
  console.error('graph drag could not run:', error.message);
  process.exit(2);
}
