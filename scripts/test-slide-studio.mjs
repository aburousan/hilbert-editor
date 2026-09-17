// A deck built in the Slide Studio must compile, and must come back.
//
// The studio writes the deck into the document between two markers, with the
// whole layout packed into the first one. Everything the builder can make has
// to survive that round trip — reopen the studio and the slides should be the
// ones you left — and the Typst it writes has to compile, or the first thing
// the person sees after building a deck is a red error.
//
// Every template the studio offers is added, then the deck is inserted and
// compiled, then the studio is reopened and the slides counted.
//
//   node scripts/test-slide-studio.mjs
//
// Needs a built frontend, a built backend, and typst on PATH.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const exe = process.platform === 'win32' ? 'typst-editor.exe' : 'typst-editor';
const binary = process.env.BIN || ['debug', 'release'].map(m => join(root, 'src-tauri/target', m, exe)).find(existsSync);
assert.ok(binary, 'Build the backend with cargo build before running this test.');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), 'hilbert-slides-'));
const ws = join(dir, 'workspace');
await mkdir(ws);
await writeFile(join(ws, 'main.typ'), '= Talk\n\nSome prose before the deck.\n');
await mkdir(join(ws, 'images'));
// A real picture for the pair that gets only one of its two. Portrait, three
// times taller than wide, so sizing it as half the pair would overflow the slide.
await writeFile(join(ws, 'images', 'one.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAeCAIAAACaFxhnAAAAF0lEQVR4nGNwaDiABzGMSo9Kj0oPpDQA/3LCEP6h0pcAAAAASUVORK5CYII=', 'base64'));
await writeFile(join(dir, 'session.json'), JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
const token = 'hilbert-slides-token-0123456789abcd';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(Number(process.env.PORT || 3081)), TYPST_WORKSPACE: ws, TYPST_DIST: join(root, 'dist'),
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
  const serving = await (await fetch(`${origin}/workspace/root`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(serving.root, ws, 'the backend answering is not the one this test started');

  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; }, token);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(origin, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.view-line', { timeout: 60000 });
  await sleep(3500);

  const openStudio = async () => {
    await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control');
    await page.waitForSelector('.palette-input');
    await page.type('.palette-input', 'Slide Studio');
    await sleep(400);
    await page.evaluate(() => [...document.querySelectorAll('.palette-item')].find(e => /slide studio/i.test(e.textContent))?.click());
    await page.waitForSelector('.modal-content select', { timeout: 20000 });
    await sleep(1500);
  };
  const templates = async () => page.evaluate(() => {
    const select = [...document.querySelectorAll('.modal-content select')].find(s => /template/i.test(s.options[0]?.text || ''));
    return [...select.options].slice(1).map(o => o.value);
  });
  const addTemplate = async value => page.evaluate(v => {
    const select = [...document.querySelectorAll('.modal-content select')].find(s => /template/i.test(s.options[0]?.text || ''));
    select.value = v;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  const slideCount = async () => page.evaluate(() => document.querySelectorAll('.modal-content [title="Drag to reorder"]').length);

  await openStudio();
  const names = await templates();
  check('the studio offers its templates', names.length >= 8, `${names.length} of them`);
  for (const name of names) { await addTemplate(name); await sleep(350); }
  await sleep(2500);
  const built = await slideCount();
  check('every template added a slide', built >= names.length, `${built} slides for ${names.length} templates`);

  // Hand the deck to the document.
  await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => /insert deck/i.test(b.textContent))?.click());
  await sleep(3000);
  const source = await readFile(join(ws, 'main.typ'), 'utf8');
  check('the deck reached the document', source.includes('>>> hilbert-slides'), `${source.length} bytes`);
  check('the prose that was there is still there', source.includes('Some prose before the deck.'));

  // The Typst it wrote has to compile.
  let compiled = '';
  try {
    execFileSync('typst', ['compile', '--root', ws, '--diagnostic-format', 'short', join(ws, 'main.typ'), join(dir, 'out.pdf')], { stdio: ['ignore', 'pipe', 'pipe'] });
    compiled = 'ok';
  } catch (error) { compiled = (String(error.stderr || '') + String(error.stdout || '')).trim().split('\n')[0]; }
  check('the deck compiles', compiled === 'ok', compiled);

  // And reopening the studio brings the same deck back.
  await openStudio();
  const reopened = await slideCount();
  check('reopening the studio brings the deck back', reopened === built, `${reopened} slides, built ${built}`);
  // A pair with only its first picture chosen: that picture has to be in the
  // deck, and only the missing one may be a placeholder.
  const thumbs = await page.$$('.modal-content [title="Drag to reorder"]');
  const pairIndex = names.findIndex(n => /two images/i.test(n)) + 1;
  await thumbs[pairIndex].click();
  await sleep(800);
  const box = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.modal-content div')]
      .filter(d => d.style.background.includes('repeating-linear-gradient'))
      .map(d => ({ d, r: d.getBoundingClientRect() }))
      .sort((a, b) => b.r.width - a.r.width);
    const r = boxes[0]?.r;
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });
  check('the pair is on the canvas', !!box);
  if (box) {
    await page.mouse.click(box.x, box.y);
    await sleep(600);
    // Typed in first: nothing measures a typed path, so the pair stays as wide
    // as it was and the studio has to say it runs off the slide.
    const set = await page.evaluate(() => {
      const input = document.querySelector('.modal-content input[placeholder="No picture chosen yet"]');
      if (!input) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'images/one.png');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    });
    check('the first picture of the pair can be chosen', set);
    await sleep(1200);
    const warned = await page.evaluate(() => [...document.querySelectorAll('.modal-content .form-hint')].some(h => /runs off the bottom/.test(h.textContent)));
    check('a pair too tall for the slide says so', warned);
    // Picking from the list measures the picture and shrinks the pair itself.
    const picked = await page.evaluate(() => {
      const select = [...document.querySelectorAll('.modal-content select')].find(s => [...s.options].some(o => o.value === 'images/one.png'));
      if (!select) return false;
      select.value = '';
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'images/one.png');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    });
    check('the picture can be picked from the project', picked);
    await sleep(1200);
    const still = await page.evaluate(() => [...document.querySelectorAll('.modal-content .form-hint')].some(h => /runs off the bottom/.test(h.textContent)));
    check('and picking it shrinks the pair onto the slide', !still);
    // With a deck already in the document the button offers to update it.
    const pressed = await page.evaluate(() => {
      const button = [...document.querySelectorAll('.modal-content button')].find(b => /insert deck|update deck/i.test(b.textContent));
      button?.click();
      return button?.textContent.trim() || null;
    });
    check('the studio offers to update the deck it reopened', /update deck/i.test(pressed || ''), pressed || 'no button');
    // The editor saves on its own schedule; wait for the new deck to reach disk.
    let deck = '';
    for (let i = 0; i < 40; i++) {
      deck = await readFile(join(ws, 'main.typ'), 'utf8');
      if (deck.includes('images/one.png')) break;
      await sleep(500);
    }
    check('the chosen picture is in the deck', /image\("images\/one\.png", width:/.test(deck));
    const placed = /#absolute-place\(dx: ([\d.]+)pt, dy: ([\d.]+)pt, image\("images\/one\.png", width: ([\d.]+)pt\)\)\n#absolute-place\(dx: ([\d.]+)pt, dy: [\d.]+pt, box\(width: ([\d.]+)pt, height: ([\d.]+)pt/.exec(deck);
    check('and the missing one is a placeholder right beside it', !!placed);
    if (placed) {
      const [x1, y1, w1, x2, w2, h2] = placed.slice(1).map(Number);
      // The canvas sizes a pair by each picture's shape, and the deck has to
      // match it: the portrait comes out narrow and exactly as tall as its box.
      check('the picture is sized by its shape, not half the pair', Math.abs(w1 * 3 - h2) < 1 && w1 < w2, `picture ${w1}pt wide, box ${w2}×${h2}pt`);
      check('the pair keeps its gap', Math.abs(x2 - (x1 + w1) - 16) < 1, `${x2 - x1 - w1}pt`);
      check('and the picture stays on the slide', y1 + w1 * 3 <= 473.56 - 15, `bottom at ${y1 + w1 * 3}pt`);
    }
    // An unchosen second picture still makes a pair, sized as one: treated as a
    // single picture the full width of the pair, the box ran off the slide.
    const tallest = Math.max(0, ...[...deck.matchAll(/box\(width: [\d.]+pt, height: ([\d.]+)pt, radius: 4pt, stroke: \(paint: rgb\("#94a3b8"\)/g)].map(m => Number(m[1])));
    check('and the placeholder fits on the slide', tallest > 0 && tallest < 473.56, `${tallest}pt tall on a 473.56pt slide`);
    let again = '';
    try {
      execFileSync('typst', ['compile', '--root', ws, '--diagnostic-format', 'short', join(ws, 'main.typ'), join(dir, 'out2.pdf')], { stdio: ['ignore', 'pipe', 'pipe'] });
      again = 'ok';
    } catch (error) { again = (String(error.stderr || '') + String(error.stdout || '')).trim().split('\n')[0]; }
    check('and the deck still compiles', again === 'ok', again);
  }
  check('no errors were thrown in the page', errors.length === 0, errors[0]?.slice(0, 120) || '');
} catch (error) {
  failures++;
  console.error(error.message);
} finally {
  await browser?.close().catch(() => {});
  server.kill(); await sleep(300); server.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\nslide studio: ${failures} check(s) failed` : '\nslide studio: decks compile and come back');
process.exit(failures ? 1 : 0);
