// Issues #48 and #49.
//
//   node scripts/test-print-and-new-file.mjs     (needs npm run build and a backend: BIN=... or target/*/hilbert)
//
// #49: New File adds .typ to a name with no extension; a name with one (data.csv, .gitignore) stays as typed;
// with the box unticked an extensionless name (Makefile) stays, and the choice is remembered.
// #48: Ctrl/Cmd+P prints the PDF preview: a print-only layer holds one image per PDF page, and what the
// print dialog would print has exactly those pages and none of the app's interface.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const binary = process.env.BIN || ['release', 'debug'].map(m => join(root, 'src-tauri/target', m, 'hilbert')).find(existsSync);
assert.ok(binary, 'Build the backend first, or set BIN.');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = await mkdtemp(join(tmpdir(), 'hilbert-print-'));
const ws = join(dir, 'ws');
await mkdir(ws);
await writeFile(join(ws, 'main.typ'), '= First page\n\nHello.\n#pagebreak()\n= Second page\n#pagebreak()\n= Third page\n');
const token = 'hilbert-print-test-token-0123456789abcd';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(process.env.PORT || 3751), TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
    HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: join(dir, 'settings.json'),
    HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'), HILBERT_API_TOKEN: token, HILBERT_COLLAB: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bound = null;
for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });
let browser, failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

try {
  for (let i = 0; i < 300 && !bound; i++) await sleep(100);
  assert.ok(bound, 'backend did not start');
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setCookie({ name: 'hilbert_session', value: token, domain: '127.0.0.1', path: '/' });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${bound}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.view-line', { timeout: 60000 });

  // #49 ---------------------------------------------------------------
  const newFile = async (name, tick) => {
    await page.evaluate(() => [...document.querySelectorAll('.menu-item, .menu-title, [class*="menu"]')].find(e => e.textContent.trim() === 'File')?.click());
    await sleep(150);
    await page.evaluate(() => [...document.querySelectorAll('.dropdown-item')].find(e => e.textContent.startsWith('New File'))?.click());
    await page.waitForSelector('.modal-content input[type="text"]', { timeout: 10000 });
    await page.$eval('.modal-content input[type="text"]', el => { el.value = ''; });
    await page.type('.modal-content input[type="text"]', name);
    const box = await page.$('.modal-content input[type="checkbox"]');
    const ticked = await box.evaluate(el => el.checked);
    if (tick !== undefined && ticked !== tick) await box.click();
    await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent.trim() === 'Create')?.click());
    await sleep(700);
    return ticked;
  };
  await newFile('notes');
  check('"notes" becomes notes.typ', existsSync(join(ws, 'notes.typ')) && !existsSync(join(ws, 'notes')));
  await newFile('data.csv');
  check('"data.csv" keeps its extension', existsSync(join(ws, 'data.csv')) && !existsSync(join(ws, 'data.csv.typ')));
  await newFile('.gitignore');
  check('".gitignore" stays as typed', existsSync(join(ws, '.gitignore')) && !existsSync(join(ws, '.gitignore.typ')));
  await newFile('chapters/intro');
  check('"chapters/intro" becomes chapters/intro.typ', existsSync(join(ws, 'chapters/intro.typ')));
  await newFile('Makefile', false);
  check('with the box unticked, "Makefile" stays extensionless', existsSync(join(ws, 'Makefile')) && !existsSync(join(ws, 'Makefile.typ')));
  const remembered = await newFile('LICENSE');
  check('the unticked box is remembered', remembered === false && existsSync(join(ws, 'LICENSE')));

  // #48 ---------------------------------------------------------------
  await page.waitForFunction(() => document.querySelectorAll('.pdf-scroll canvas, .pdf-page canvas').length > 0 || document.querySelector('.pdf-scroll'), { timeout: 60000 });
  await sleep(1500);
  await page.click('.view-lines');
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(mod); await page.keyboard.press('p'); await page.keyboard.up(mod);
  const pages = await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('#hilbert-print img')];
    return imgs.length && imgs.every(i => i.complete && i.naturalWidth > 0) ? imgs.length : 0;
  }, { timeout: 30000 }).then(h => h.jsonValue()).catch(() => 0);
  check('Ctrl/Cmd+P draws one image per PDF page into the print layer', pages === 3, `${pages} page(s)`);
  const hiddenOnScreen = await page.$eval('#hilbert-print', el => getComputedStyle(el).display === 'none').catch(() => false);
  check('the print layer is hidden on screen', hiddenOnScreen);
  const size = await page.$eval('#hilbert-print img', el => [el.style.width, el.style.height]).catch(() => []);
  check('pages keep the PDF page size', size[0] === '595.276pt' && size[1] === '841.89pt', size.join(' x '));
  // What a print dialog would print: Chrome's PDF of the page in print media.
  await page.emulateMediaType('print');
  const appHidden = await page.$eval('#root', el => getComputedStyle(el).display === 'none').catch(() => false);
  check('in print, the app interface is hidden', appHidden);
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  if (process.env.PRINT_OUT) await writeFile(process.env.PRINT_OUT, pdf);
  const printedPages = (String.fromCharCode(...pdf.subarray(0, Math.min(pdf.length, 2_000_000))).match(/\/Type\s*\/Page[^s]/g) || []).length;
  check('what would print has exactly the 3 PDF pages', printedPages === 3, `${printedPages} page(s)`);
  await page.emulateMediaType('screen');
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser?.close();
  server.kill();
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nprint and new file: all checks passed');
process.exit(failures ? 1 : 0);
