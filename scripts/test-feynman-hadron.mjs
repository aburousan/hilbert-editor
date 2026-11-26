// Feynman studio tools for hadron-correlator figures: ovals (half filled, shaded), cross vertices, lines
// bent as half ellipses, splitting a line at a point, and the hadron-correlator templates. Every generated
// snippet is compiled with Typst.
//
//   node scripts/test-feynman-hadron.mjs   (needs npm run build and a backend: BIN=... or target/*/hilbert)
//   FEYN_OUT=<folder> also keeps the compiled pictures (one PNG per diagram) and canvas screenshots.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const binary = process.env.BIN || ['release', 'debug'].map(m => join(root, 'src-tauri/target', m, 'hilbert')).find(existsSync);
assert.ok(binary, 'Build the backend first, or set BIN.');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = await mkdtemp(join(tmpdir(), 'hilbert-hadron-'));
const ws = join(dir, 'ws');
await mkdir(ws);
await writeFile(join(ws, 'main.typ'), '= Notes\n');
const token = 'hilbert-hadron-test-token-0123456789ab';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(process.env.PORT || 3758), TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
    HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: join(dir, 'settings.json'),
    HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'), HILBERT_API_TOKEN: token, HILBERT_COLLAB: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bound = null;
for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });
let browser, failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const out = process.env.FEYN_OUT;

// Compile one generated snippet; returns the error text, or '' when it compiles.
const compile = async (name, code) => {
  const file = join(dir, `${name}.typ`);
  await writeFile(file, `#set page(width: auto, height: auto, margin: 8pt)\n${code}\n`);
  try {
    execFileSync(process.env.TYPST_BIN || 'typst', ['compile', '--package-path', join(root, 'src-tauri/resources/typst-packages'),
      '--ppi', '110', file, out ? join(out, `${name}.png`) : join(dir, `${name}.png`)], { timeout: 60000, stdio: 'pipe' });
    return '';
  } catch (e) { return String(e.stderr || e).slice(0, 400); }
};

try {
  for (let i = 0; i < 300 && !bound; i++) await sleep(100);
  assert.ok(bound, 'backend did not start');
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 950 });
  await page.setCookie({ name: 'hilbert_session', value: token, domain: '127.0.0.1', path: '/' });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${bound}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.view-line', { timeout: 60000 });

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.click('.view-lines');
  await page.keyboard.down(mod); await page.keyboard.down('Shift'); await page.keyboard.press('f'); await page.keyboard.up('Shift'); await page.keyboard.up(mod);
  await page.waitForFunction(() => [...document.querySelectorAll('.modal-header h2')].some(h => h.textContent.includes('Feynman')), { timeout: 10000 });
  const clickText = (sel, text) => page.evaluate((sel, text) => { const el = [...document.querySelectorAll(sel)].find(e => e.textContent.trim() === text); el?.click(); return !!el; }, sel, text);
  await page.evaluate(() => { const box = [...document.querySelectorAll('label.form-check')].find(l => l.textContent.includes('Show generated Typst code'))?.querySelector('input'); if (box && !box.checked) box.click(); });
  const code = () => page.$eval('.modal-content pre', p => p.textContent);
  const svgSel = '.modal-body svg[viewBox="0 0 680 400"]';
  const shot = async name => { if (out) await (await page.$(svgSel)).screenshot({ path: join(out, `canvas-${name}.png`) }); };
  const openExample = async name => {
    await clickText('button', 'Examples…');
    await sleep(200);
    const opened = await page.evaluate(name => {
      const card = [...document.querySelectorAll('.modal-body div')].find(d => d.querySelector(':scope > div:nth-child(2) > div')?.textContent === name);
      card?.firstElementChild?.click();
      return !!card;
    }, name);
    await sleep(250);
    return opened;
  };

  // 1. The templates: each opens, and its code compiles.
  const snippets = {};
  const names = ['Proton three-point function', 'Fixed-sink sequential source', 'Baryon contraction: current on a line',
    'Baryon contraction: exchanged', 'Baryon contraction: disconnected loop'];
  for (const name of names) {
    const opened = await openExample(name);
    const c = await code();
    snippets[name] = c;
    const slug = name.replace(/[^a-z0-9]+/gi, '-');
    const err = await compile(slug, c);
    check(`"${name}" opens and compiles`, opened && c.includes('canvas(') && !err, err);
    await shot(slug);
  }
  const p3 = snippets['Proton three-point function'];
  check('3-pt: the top line is two half-ellipse pieces (cubic quarters), one red', (p3.match(/merge-path\(/g) || []).length === 3 && p3.includes('rgb("#c0504d")'));
  check('3-pt: a cross at the insertion', (p3.match(/line\([^\n]*stroke: 1\.2pt \+ black\)/g) || []).length === 2);
  const fs = snippets['Fixed-sink sequential source'];
  check('fixed sink: right half of an oval, shaded from the colour, no outline',
    /arc\([^\n]*start: -90deg, delta: 180deg[^\n]*mode: "CLOSE", fill: gradient\.radial\(rgb\("#b0702f"\)/.test(fs) && !/circle\([^\n]*radius: \(4\.25/.test(fs));
  check('fixed sink: ovals are drawn before (under) the lines', fs.indexOf('arc(') < fs.indexOf('merge-path('));
  const bc = snippets['Baryon contraction: current on a line'];
  check('baryon: two grey operator ovals with outlines', (bc.match(/circle\([^\n]*radius: \(0\.28, 1\.4\), fill: gray\.lighten\(50%\), stroke: 1pt\)/g) || []).length === 2);
  check('baryon disconnected: a gluon from the loop', snippets['Baryon contraction: disconnected loop'].includes('decorations.coil('));

  // 2. By hand: an oval, half filled; a line bent as a half ellipse and split; a cross vertex.
  await clickText('button', 'Clear');
  const box = await (await page.$(svgSel)).boundingBox();
  const at = (x, y) => ({ x: box.x + x * box.width / 680, y: box.y + y * box.height / 400 });
  const drag = async (a, b) => { const p = at(...a), q = at(...b); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 6 }); await page.mouse.up(); await sleep(120); };
  const setSelect = (label, value) => page.evaluate((label, value) => {
    const f = [...document.querySelectorAll('label.form-field')].find(l => l.firstElementChild?.textContent.startsWith(label));
    const s = f?.querySelector('select');
    if (!s) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    set.call(s, value); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, label, value);

  await clickText('.seg button', 'Oval');
  await drag([340, 200], [500, 260]);
  let c = await code();
  check('oval tool: drag from the centre draws a 4 × 1.5 oval', /circle\(\(8\.5, 5\), radius: \(4, 1\.5\), fill: gray\.lighten\(50%\), stroke: 1pt\)/.test(c), c.split('\n').find(l => l.includes('circle(')));
  check('oval: shading and right half', await setSelect('Fill', 'gradient') && await setSelect('Fill only', 'right'));
  await sleep(150);
  c = await code();
  check('…gives a half arc with the radial shading', /arc\(\(8\.5, 5\), start: -90deg, delta: 180deg, radius: \(4, 1\.5\), anchor: "origin", mode: "CLOSE", fill: gradient\.radial/.test(c));

  await clickText('.seg button', 'Line');
  await drag([180, 200], [500, 200]);
  check('line: bend it and make it a half ellipse', await page.evaluate(() => {
    const f = [...document.querySelectorAll('label.form-field')].find(l => l.firstElementChild?.textContent.startsWith('Bend —'));
    const r = f?.querySelector('input');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(r, '-80'); r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }) && await setSelect('Bend shape', 'ellipse'));
  await sleep(150);
  c = await code();
  check('half ellipse: two cubic quarters reaching the top at (8.5, 7)', /merge-path\(\{ bezier\(\(4\.5, 5\), \(8\.5, 7\)/.test(c), c.split('\n').find(l => l.includes('merge-path')));
  // Split at a third of the way along (angle π/3 from the start): x = 340 − 160·cos 60°, y = 200 − 80·sin 60°.
  check('split button', await clickText('button', 'Split line at a point…'));
  const sp = at(340 - 160 * 0.5, 200 - 80 * Math.sin(Math.PI / 3));
  await page.mouse.click(sp.x, sp.y);
  await sleep(200);
  c = await code();
  const pieces = (c.match(/merge-path\(\{[^\n]*/g) || []);
  const meet = /^merge-path\(\{ bezier\(\(([\d.]+), ([\d.]+)\)/.exec(pieces[1] ?? '');
  check('split: two pieces meeting at the click', pieces.length === 2 && !!meet && Math.abs(meet[1] - 6.5) < 0.06 && Math.abs(meet[2] - 6.73) < 0.06
    && pieces[0].includes(`, (${meet[1]}, ${meet[2]}), `), pieces.join(' | '));
  // The first piece is selected: colour it red.
  await page.evaluate(() => [...document.querySelectorAll('button[title="#dc2626"]')][0]?.click());
  await sleep(120);
  c = await code();
  check('one piece red, the other black', /merge-path[^\n]*rgb\("#dc2626"\)/.test(c) && /merge-path[^\n]*stroke: 1\.2pt\)/.test(c));
  await clickText('.seg button', 'Vertex');
  const v = at(600, 340); await page.mouse.click(v.x, v.y);
  await clickText('.seg button', 'Select');
  await page.mouse.click(v.x, v.y);
  check('vertex shape: cross', await setSelect('Shape', 'cross'));
  await sleep(120);
  c = await code();
  check('…draws two crossing lines', (c.match(/line\([^\n]*stroke: 1\.2pt \+ black\)/g) || []).length === 2);
  const err = await compile('by-hand', c);
  check('the hand-made diagram compiles', !err, err);
  await shot('by-hand');
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser?.close();
  server.kill();
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nfeynman hadron tools: all checks passed');
process.exit(failures ? 1 : 0);
