// Issue #50: open the file a path in #include / #import points at (Cmd/Ctrl+click or the right-click
// menu), a package import's Typst Universe page, and a missing .typ only after asking.
//
//   node scripts/test-open-include.mjs     (needs npm run build and a backend: BIN=... or target/*/hilbert)
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
const dir = await mkdtemp(join(tmpdir(), 'hilbert-open-'));
const ws = join(dir, 'ws');
await mkdir(ws);
await writeFile(join(ws, 'main.typ'), '// CHAPTER 1\n  #include "content/ch-1/_intro.typ"\n#import "@preview/cetz:0.4.2": canvas\n#include "content/ch-2/new.typ"\nplain text line\n'
  + '#include "content/ch3/geometry.typ"\n#include "content/ch-1/extra.typ"\n');
await mkdir(join(ws, 'content/ch-1'), { recursive: true });
await mkdir(join(ws, 'content/ch-3'), { recursive: true });
await writeFile(join(ws, 'content/ch-3/ergun.typ'), '= Ergun\n');
await writeFile(join(ws, 'content/ch-1/_intro.typ'), '= Introduction chapter\n');
const token = 'hilbert-open-test-token-0123456789abcd';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(process.env.PORT || 3755), TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
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

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.evaluate(() => { window.__opened = []; window.open = (url) => { window.__opened.push(String(url)); return null; }; });
  const firstLine = () => page.$eval('.view-line', e => e.textContent.replace(/\u00a0/g, ' '));
  // The screen point of a text inside a given editor line.
  const pointOf = async (lineIndex, text) => page.evaluate((lineIndex, text) => {
    const line = [...document.querySelectorAll('.view-lines .view-line')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[lineIndex];
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.textContent.indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at + 2); range.setEnd(node, at + 3);
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  }, lineIndex, text);
  const backToMain = async () => {
    await page.evaluate(() => [...document.querySelectorAll('.tab')].find(t => t.textContent.includes('main.typ'))?.click());
    await page.waitForFunction(() => document.querySelector('.view-line')?.textContent.includes('CHAPTER'), { timeout: 10000 });
    await sleep(400);
  };
  const menuItems = () => page.$$eval('.context-menu .dropdown-item', els => els.map(e => e.firstElementChild?.textContent.trim() || e.textContent.trim()));
  const clickMenu = label => page.evaluate(label => {
    const item = [...document.querySelectorAll('.context-menu .dropdown-item')].find(e => (e.firstElementChild?.textContent.trim() || '') === label);
    item?.click();
    return !!item;
  }, label);

  // 1. Cmd/Ctrl+click on the #include path opens that file.
  let p = await pointOf(1, 'content/ch-1');
  check('the include path is on screen', !!p);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down(mod);
  await page.mouse.move(p.x + 1, p.y);
  await sleep(300);
  const underlined = await page.evaluate(() => document.querySelectorAll('.detected-link, .detected-link-active').length);
  await page.mouse.click(p.x + 1, p.y);
  await page.keyboard.up(mod);
  const opened = await page.waitForFunction(() => document.querySelector('.view-line')?.textContent.replace(/\u00a0/g, ' ').includes('Introduction chapter'), { timeout: 8000 }).then(() => true).catch(() => false);
  check('the paths are links (include, import, missing include)', underlined >= 3, `${underlined}`);
  check('Cmd/Ctrl+click opens content/ch-1/_intro.typ', opened, await firstLine());

  // 2. Right-click on the path: "Open File" is in the menu and opens it.
  await backToMain();
  p = await pointOf(1, 'content/ch-1');
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await sleep(400);
  const onPath = await menuItems();
  check('right-click on a path offers Open File', onPath.includes('Open File'), onPath.slice(0, 6).join(' | '));
  await clickMenu('Open File');
  const viaMenu = await page.waitForFunction(() => document.querySelector('.view-line')?.textContent.replace(/\u00a0/g, ' ').includes('Introduction chapter'), { timeout: 8000 }).then(() => true).catch(() => false);
  check('Open File from the menu opens it', viaMenu);

  // 3. Right-click on plain text: no Open File.
  await backToMain();
  p = await pointOf(4, 'plain');
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await sleep(400);
  const offPath = await menuItems();
  check('right-click away from a path does not offer it', offPath.length > 0 && !offPath.includes('Open File') && !offPath.some(t => t.startsWith('Open Package')), offPath.slice(0, 4).join(' | '));
  await page.keyboard.press('Escape');

  // 4. A package import opens its Typst Universe page.
  p = await pointOf(2, '@preview');
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await sleep(400);
  const onPkg = await menuItems();
  check('right-click on a package offers its Universe page', onPkg.includes('Open Package Page on Typst Universe'));
  await clickMenu('Open Package Page on Typst Universe');
  await sleep(300);
  const urls = await page.evaluate(() => window.__opened);
  check('it opens https://typst.app/universe/package/cetz/0.4.2', urls[0] === 'https://typst.app/universe/package/cetz/0.4.2', urls.join(' '));

  const ctrlClick = async (line, text) => {
    const at = await pointOf(line, text);
    await page.mouse.move(at.x, at.y);
    await page.keyboard.down(mod);
    await page.mouse.move(at.x + 1, at.y);
    await sleep(300);
    await page.mouse.click(at.x + 1, at.y);
    await page.keyboard.up(mod);
  };
  const dialogText = () => page.waitForFunction(() => [...document.querySelectorAll('.modal-content')].find(m => /does not exist yet/.test(m.textContent))?.textContent, { timeout: 8000 })
    .then(h => h.jsonValue()).catch(() => '');
  const dialogButton = label => page.evaluate(label => {
    const b = [...document.querySelectorAll('.modal-content button')].find(b => b.textContent.trim() === label);
    b?.click();
    return !!b;
  }, label);
  const tabOpen = name => page.evaluate(name => [...document.querySelectorAll('.tab')].some(t => t.textContent.includes(name)), name);

  // 5. A missing file in a folder that exists: the menu says Create File…, and creating asks plainly.
  await backToMain();
  p = await pointOf(6, 'content/ch-1/extra');
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await sleep(500);
  const onMissing = await menuItems();
  check('right-click on a missing file offers Create File… instead of Open File', onMissing.includes('Create File…') && !onMissing.includes('Open File'), onMissing.slice(0, 4).join(' | '));
  await clickMenu('Create File…');
  let text = await dialogText();
  check('it asks first, with no folder warning (content/ch-1 exists)', text.includes('content/ch-1/extra.typ does not exist yet') && !text.includes('folder') && !existsSync(join(ws, 'content/ch-1/extra.typ')), text);
  check('…and the button is Create', await dialogButton('Create'));
  await sleep(1200);
  check('after Create the file exists and is open', existsSync(join(ws, 'content/ch-1/extra.typ')) && await tabOpen('extra.typ'));

  // 6. The reporter's typo: content/ch3 for content/ch-3. The warning names the new folder and the near one;
  // Cancel creates nothing.
  await backToMain();
  await ctrlClick(5, 'content/ch3');
  text = await dialogText();
  check('a missing folder is named before anything is created', text.includes('The folder content/ch3/ does not exist either') && text.includes('Check the path for a typo'), text);
  check('the folder with the close name is suggested', text.includes('Did you mean the folder content/ch-3/?'), text);
  check('…and confirming says it makes a folder', await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].some(b => b.textContent.trim() === 'Create File and Folder')));
  await dialogButton('Cancel');
  await sleep(400);
  check('Cancel creates neither the folder nor the file', !existsSync(join(ws, 'content/ch3')));

  // 7. A new chapter folder (content/ch-2): warned, no false suggestion of ch-1 or ch-3, and created on confirm.
  await backToMain();
  await ctrlClick(3, 'content/ch-2');
  text = await dialogText();
  check('a genuinely new folder is warned about, with no suggestion', text.includes('The folder content/ch-2/ does not exist either') && !text.includes('Did you mean'), text);
  await dialogButton('Create File and Folder');
  await sleep(1200);
  check('after confirming, the folder and file exist and the file is open', existsSync(join(ws, 'content/ch-2/new.typ')) && await tabOpen('new.typ'));
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser?.close();
  server.kill();
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nopen from include: all checks passed');
process.exit(failures ? 1 : 0);
