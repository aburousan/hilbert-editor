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
  await page.setViewport({ width: 1400, height: 1400 });   // tall enough that the dialog does not scroll the canvas under the code box
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
  // The canvas moves on screen as the side panel grows, so it is measured again for every point.
  // It is also re-centred when the dialog's height changes, so wait until two readings agree.
  const at = async (x, y) => {
    let box = await (await page.$(svgSel)).boundingBox();
    for (let i = 0; i < 20; i++) {
      await sleep(60);
      const again = await (await page.$(svgSel)).boundingBox();
      const same = Math.abs(again.x - box.x) < 0.5 && Math.abs(again.y - box.y) < 0.5 && Math.abs(again.height - box.height) < 0.5;
      box = again;
      if (same) break;
    }
    return { x: box.x + x * box.width / 680, y: box.y + y * box.height / 400 };
  };
  const drag = async (a, b) => { const p = await at(...a), q = await at(...b); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 6 }); await page.mouse.up(); await sleep(120); };
  const setSelect = (label, value) => page.evaluate((label, value) => {
    const f = [...document.querySelectorAll('label.form-field')].find(l => l.firstElementChild?.textContent.startsWith(label));
    const s = f?.querySelector('select');
    if (!s) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    set.call(s, value); s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, label, value);

  let c;
  // Zoom: scrolling zooms about the pointer (that point stays put), Space-drag pans, the % button resets.
  const viewBox = () => page.$eval('.modal-body svg[aspect-ratio], .modal-body svg', () => [...document.querySelectorAll('.modal-body svg')].find(x => x.getAttribute('style')?.includes('aspect-ratio'))?.getAttribute('viewBox'));
  const fixed = await at(200, 100);
  await page.mouse.move(fixed.x, fixed.y);
  await page.mouse.wheel({ deltaY: -400 });
  await sleep(200);
  const zoomed = await viewBox();
  const pct = await page.$eval('.zoom-level', b => b.textContent);
  check('scrolling up zooms in', zoomed !== '0 0 680 400' && parseInt(pct) > 150, `${pct}, viewBox ${zoomed}`);
  await clickText('.seg button', 'Vertex');
  await page.mouse.click(fixed.x, fixed.y);
  await sleep(150);
  c = await code();
  check('the point under the pointer stayed put: a vertex there is at (5, 7.5)', /circle\(\(5, 7\.5\), radius/.test(c), c.split('\n').find(l => l.includes('circle(')));
  await page.keyboard.down('Space');
  await page.mouse.move(fixed.x, fixed.y); await page.mouse.down(); await page.mouse.move(fixed.x + 100, fixed.y, { steps: 5 }); await page.mouse.up();
  await page.keyboard.up('Space');
  await sleep(150);
  const panned = await viewBox();
  check('Space-drag pans (the view moves left by 100 screen px)', Number(panned.split(' ')[0]) < Number(zoomed.split(' ')[0]) - 10 && (await code()) === c, `${zoomed} → ${panned}`);
  await page.click('.zoom-level');
  await sleep(150);
  check('the % button goes back to 100%', await viewBox() === '0 0 680 400' && await page.$eval('.zoom-level', b => b.textContent) === '100%');
  await clickText('button', 'Clear');

  await clickText('.seg button', 'Oval');
  await drag([340, 200], [500, 260]);
  c = await code();
  check('oval tool: drag from the centre draws a 4 × 1.5 oval', /circle\(\(8\.5, 5\), radius: \(4, 1\.5\), fill: gray\.lighten\(50%\), stroke: 1pt\)/.test(c), c.split('\n').find(l => l.includes('circle(')));
  check('oval: shading and right half', await setSelect('Fill', 'gradient') && await setSelect('Fill only', 'right'));
  await sleep(150);
  c = await code();
  check('…gives a half arc with the radial shading', /arc\(\(8\.5, 5\), start: -90deg, delta: 180deg, radius: \(4, 1\.5\), anchor: "origin", mode: "CLOSE", fill: gradient\.radial/.test(c));
  check('oval outline: coiled, with clockwise arrows', await setSelect('Line type', 'gluon') && await setSelect('Fermion flow', '1'));
  await sleep(150);
  c = await code();
  check('…a coil around the oval and two arrow marks', /decorations\.coil\(circle\(\(8\.5, 5\), radius: \(4, 1\.5\)\)/.test(c) && (c.match(/mark\(\([\d.]+, (6\.5|3\.5)\)/g) || []).length === 2);

  // A circle shaded in 3-D, whole and then its left half only.
  await clickText('.seg button', 'Circle');
  await drag([100, 320], [140, 320]);
  check('circle: 3-D shading', await setSelect('Fill', 'gradient'));
  await sleep(150);
  c = await code();
  check('…the whole circle shaded', /circle\(\(2\.5, 2\), radius: 1, stroke: 1\.2pt, fill: gradient\.radial\(luma\(60%\)/.test(c), c.split('\n').find(l => l.includes('(2.5, 2)')));
  check('circle: left half only', await setSelect('Fill only', 'left'));
  await sleep(150);
  c = await code();
  check('…a shaded half-disc and the whole outline',
    /arc\(\(2\.5, 2\), start: 90deg, delta: 180deg, radius: 1, anchor: "origin", mode: "CLOSE", fill: gradient\.radial/.test(c) && /circle\(\(2\.5, 2\), radius: 1, stroke: 1\.2pt\)/.test(c));

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
  const sp = await at(340 - 160 * 0.5, 200 - 80 * Math.sin(Math.PI / 3));
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
  let v = await at(600, 340); await page.mouse.click(v.x, v.y);
  await clickText('.seg button', 'Select');
  v = await at(600, 340);
  await page.mouse.click(v.x, v.y);
  check('vertex shape: cross', await setSelect('Shape', 'cross'));
  await sleep(120);
  c = await code();
  check('…draws two crossing lines', (c.match(/line\([^\n]*stroke: 1\.2pt \+ black\)/g) || []).length === 2);

  // Several at once: a box around the circle, shift-click the cross, drag them together, duplicate, delete.
  await clickText('.seg button', 'Select');
  await page.keyboard.press('Escape');
  await drag([50, 270], [150, 370]);
  check('a box around the circle selects just it', await page.evaluate(() => [...document.querySelectorAll('label.form-field span')].some(s => s.textContent === 'Circle type')));
  v = await at(600, 340);
  await page.keyboard.down('Shift'); await page.mouse.click(v.x, v.y); await page.keyboard.up('Shift');
  await sleep(150);
  const howMany = () => page.evaluate(() => /(\d+) selected/.exec([...document.querySelectorAll('.form-hint b')].map(b => b.textContent).join(' '))?.[1]);
  check('shift-click adds the cross: 2 selected', await howMany() === '2', await howMany());
  await drag([100, 320], [140, 320]);
  c = await code();
  check('dragging one moves both', /arc\(\(3\.5, 2\)/.test(c) && !/arc\(\(2\.5, 2\)/.test(c) && /line\(\(15\.9, /.test(c), (c.match(/line\(\(1[45]\.[\d]+, [^\n]*1\.2pt \+ black/g) || []).join(' '));
  await page.keyboard.down(mod); await page.keyboard.press('d'); await page.keyboard.up(mod);
  await sleep(150);
  c = await code();
  check(`${mod}+D duplicates both, 20 px down and right`, /arc\(\(4, 1\.5\)/.test(c) && (c.match(/line\([^\n]*1\.2pt \+ black/g) || []).length === 4);
  await page.keyboard.press('Backspace');
  await sleep(150);
  c = await code();
  check('Delete removes the selected copies only', !/arc\(\(4, 1\.5\)/.test(c) && /arc\(\(3\.5, 2\)/.test(c));
  await page.keyboard.down(mod); await page.keyboard.press('a'); await page.keyboard.up(mod);
  await sleep(150);
  const all = await howMany();
  await page.evaluate(() => [...document.querySelectorAll('button[title="#2563eb"]')][0]?.click());
  await sleep(150);
  c = await code();
  check(`${mod}+A selects everything (5) and a colour applies to all`, all === '5' && !/stroke: 1\.2pt\)|stroke: 1pt\)|\+ black/.test(c), `${all} selected`);
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
