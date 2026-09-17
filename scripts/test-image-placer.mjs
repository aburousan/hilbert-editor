// Adding a picture should not mean leaving the app.
//
// The image dialog could only offer pictures already sitting in the project
// folder; anything else meant copying the file in by hand, outside Hilbert, and
// typing its path. A picture can now be handed straight to the dialog — chosen
// or dropped on it — and it is copied into the project's `images` folder, which
// is the only place a Typst document can read it from.
//
//   node scripts/test-image-placer.mjs
//
// Needs a built frontend (npm run build) and backend (cd src-tauri && cargo build).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const exe = process.platform === 'win32' ? 'typst-editor.exe' : 'typst-editor';
const binary = process.env.BIN || ['debug', 'release'].map(m => join(root, 'src-tauri/target', m, exe)).find(existsSync);
assert.ok(binary, 'Build the backend with cargo build before running this test.');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), 'hilbert-image-'));
const ws = join(dir, 'workspace');
await mkdir(ws);
await writeFile(join(ws, 'main.typ'), '= Figures\n\nProse here.\n');
await writeFile(join(dir, 'session.json'), JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
const token = 'hilbert-image-token-0123456789abcd';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(Number(process.env.PORT || 3080)), TYPST_WORKSPACE: ws, TYPST_DIST: join(root, 'dist'),
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
  await page.setViewport({ width: 1500, height: 950 });
  await page.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; }, token);
  await page.goto(origin, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.view-line', { timeout: 60000 });
  await sleep(3000);

  // The dialog should be reachable without hunting through menus.
  await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control');
  await page.waitForSelector('.palette-input');
  await page.type('.palette-input', 'Place Image');
  await sleep(500);
  const inPalette = await page.evaluate(() => {
    const item = [...document.querySelectorAll('.palette-item')].find(e => /place image/i.test(e.textContent));
    if (item) item.click();
    return !!item;
  });
  check('the visual placer is in the command palette', inPalette);
  await page.waitForSelector('.modal-content', { timeout: 15000 });
  await sleep(800);

  const said = () => page.evaluate(() => [...document.querySelectorAll('.modal-content .form-hint')].map(e => e.textContent).join(' | '));
  check('it says the project has no pictures yet', /No pictures in this project/i.test(await said()), await said());

  // Drop a picture on the dialog, the way a person drags one from a folder.
  const dropped = await page.evaluate(async () => {
    // A one-pixel PNG.
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
    const file = new File([bytes], 'my photo.png', { type: 'image/png' });
    const data = new DataTransfer();
    data.items.add(file);
    const modal = document.querySelector('.modal-content');
    modal.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    modal.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    return true;
  });
  check('the dialog accepted a dropped file', dropped);
  await sleep(3000);

  const files = await readdir(join(ws, 'images')).catch(() => []);
  check('the picture was copied into the project', files.length === 1, files.join(', ') || 'images/ is empty');
  check('its name was made safe to use', files[0] === 'my photo.png' || /my[-_ ]photo\.png/.test(files[0] || ''), files[0] || '');

  const field = await page.evaluate(() => [...document.querySelectorAll('.modal-content input[type="text"]')].map(i => i.value).join(' | '));
  check('the dialog now points at it', field.includes('images/'), field);

  // A second picture whose name differs only in case. On a Mac or Windows disk
  // that is the same file, and it must not replace the first.
  const original = await readFile(join(ws, 'images', files[0]));
  await page.evaluate(async () => {
    const bytes = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));
    const file = new File([bytes], 'My Photo.png', { type: 'image/png' });
    const data = new DataTransfer();
    data.items.add(file);
    const modal = document.querySelector('.modal-content');
    modal.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    modal.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await sleep(3000);
  const after = await readdir(join(ws, 'images'));
  check('a picture with the same name in another case is kept apart', after.length === 2, after.join(', '));
  check('and the first picture is untouched', Buffer.compare(original, await readFile(join(ws, 'images', files[0]))) === 0);

  // Insert, and check the document refers to the picture that was added.
  await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => /insert|place/i.test(b.textContent) && !/cancel/i.test(b.textContent))?.click());
  await sleep(2500);
  const source = await readFile(join(ws, 'main.typ'), 'utf8');
  check('the inserted code uses that picture', /image\("images\/[^"]+"/.test(source), source.split('\n').find(l => l.includes('image(')) || 'no image( in the file');
} catch (error) {
  failures++;
  console.error(error.message);
} finally {
  await browser?.close().catch(() => {});
  server.kill(); await sleep(300); server.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\nimage placer: ${failures} check(s) failed` : '\nimage placer: a picture can be added without leaving the app');
process.exit(failures ? 1 : 0);
