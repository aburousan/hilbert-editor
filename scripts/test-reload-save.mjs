// Saving after a file was reloaded because it changed outside Hilbert. In 0.2.12 the save check still
// compared the disk with the text from before the reload, so the next Ctrl+S reported the change it had
// just taken in as a conflict ("changed outside Hilbert") and did not save.
//
//   node scripts/test-reload-save.mjs     (needs npm run build and a backend: BIN=... or target/*/hilbert)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const binary = process.env.BIN || ['release', 'debug'].map(m => join(root, 'src-tauri/target', m, 'hilbert')).find(existsSync);
assert.ok(binary, 'Build the backend first, or set BIN.');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = await mkdtemp(join(tmpdir(), 'hilbert-reload-save-'));
const ws = join(dir, 'ws');
await mkdir(ws);
const file = join(ws, 'main.typ');
await writeFile(file, '= Start\n\nfirst line\n');
await writeFile(join(dir, 'session.json'), JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
const token = 'hilbert-reload-save-token-0123456789ab';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(process.env.PORT || 3759), TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
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
  const editorHas = text => page.waitForFunction(t => [...document.querySelectorAll('.view-line')].some(l => l.textContent.replace(/ /g, ' ').includes(t)), { timeout: 15000 }, text).then(() => true).catch(() => false);
  check('the file opens', await editorHas('first line'));
  await sleep(1500);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const toEnd = async () => { await page.click('.view-lines'); await page.keyboard.down(mod); await page.keyboard.press('End'); await page.keyboard.up(mod); };

  // Hilbert writes the file once (typing saves it on the way to the preview)…
  await toEnd();
  await page.keyboard.type(' typed before', { delay: 15 });
  await sleep(2500);
  check('Hilbert wrote it', (await readFile(file, 'utf8')).includes('typed before'));

  // …then another program changes it while it is open and unedited: Hilbert reloads it.
  await writeFile(file, (await readFile(file, 'utf8')) + '\nchanged outside\n');
  check('the outside change is reloaded into the editor', await editorHas('changed outside'));
  await sleep(800);

  // Then more typing (written again on the way to the preview) and Ctrl/Cmd+S.
  await toEnd();
  await page.keyboard.type('typed after reload', { delay: 15 });
  await sleep(3000);
  await page.keyboard.down(mod); await page.keyboard.press('s'); await page.keyboard.up(mod);
  await sleep(1500);
  const conflict = await page.evaluate(() => [...document.querySelectorAll('.modal-content')].map(m => m.textContent).find(t => /outside|changed on disk|conflict/i.test(t)) ?? '');
  check('no false "changed outside Hilbert" prompt', !conflict, conflict.slice(0, 120));
  const disk = await readFile(file, 'utf8');
  check('the save reached the disk, keeping the outside change', disk.includes('changed outside') && disk.includes('typed after reload'), JSON.stringify(disk));
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser?.close();
  server.kill();
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nreload then save: all checks passed');
process.exit(failures ? 1 : 0);
