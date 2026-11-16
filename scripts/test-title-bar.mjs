// Settings → Hide Hilbert's own title bar (issue #43).
//
// On Wayland GTK draws a title bar on every decorated window, and a tiling
// window manager like sway cannot take it away. The option is offered only in
// the desktop app on Linux, is saved to the settings file and is not dropped
// when the app writes its settings back. (The window itself reads it when it is
// built; that part is checked on Linux with xprop.)
//
//   node scripts/test-title-bar.mjs
//
// Needs a built frontend and backend.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const binary = process.env.BIN || ['release', 'debug']
  .map(m => join(root, 'src-tauri/target', m, process.platform === 'win32' ? 'hilbert.exe' : 'hilbert')).find(existsSync);
assert.ok(binary, 'Build the backend with cargo build before running this test.');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), 'hilbert-title-bar-'));
const ws = join(dir, 'ws');
await mkdir(ws);
await writeFile(join(ws, 'main.typ'), '= Title bar\n');
const settingsFile = join(dir, 'settings.json');
await writeFile(settingsFile, JSON.stringify({ proofreading: false }));
const token = 'hilbert-title-bar-token-0123456789abcd';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(process.env.PORT || 3541), TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
    HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: settingsFile,
    HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'), HILBERT_API_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bound = null;
for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });

let browser, failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

// A page that looks like the desktop app's window on the given system.
async function appWindow(userAgent) {
  const page = await browser.newPage();
  await page.setUserAgent(userAgent);
  await page.setViewport({ width: 1400, height: 900 });
  await page.evaluateOnNewDocument(t => {
    document.cookie = `hilbert_session=${t}; path=/`;
    window.__TAURI_INTERNALS__ = { invoke: () => Promise.reject(new Error('no tauri in a test')), transformCallback: () => 0 };
  }, token);
  await page.goto(`http://127.0.0.1:${bound}`, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.view-line', { timeout: 60000 });
  await sleep(800);
  return page;
}
async function openSettings(page) {
  // The App Settings button at the foot of the side panel.
  await page.evaluate(() => [...document.querySelectorAll('div')].reverse().find(e => e.textContent.trim() === 'App Settings')?.click());
  await sleep(800);
}
const option = page => page.$$eval('label', ls => ls.find(l => l.textContent.includes('Hide Hilbert’s own title bar'))?.querySelector('input')?.checked ?? null);

try {
  for (let i = 0; i < 300 && !bound; i++) await sleep(50);
  assert.ok(bound, 'the backend never said which port it bound');
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });

  const linux = await appWindow('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)');
  await openSettings(linux);
  check('the desktop app on Linux offers the option', (await option(linux)) === false);
  await linux.$$eval('label', ls => ls.find(l => l.textContent.includes('Hide Hilbert’s own title bar'))?.querySelector('input')?.click());
  await sleep(1200);
  const saved = JSON.parse(await readFile(settingsFile, 'utf8'));
  check('ticking it saves it to the settings file', saved.linuxHideTitleBar === true, JSON.stringify(saved.linuxHideTitleBar));

  // A later write of the settings must keep it: a reload reads it back and
  // the next save writes it again.
  await linux.reload({ waitUntil: 'networkidle2' });
  await linux.waitForSelector('.view-line', { timeout: 60000 });
  await sleep(1500);
  await openSettings(linux);
  check('it is still ticked after a restart', (await option(linux)) === true);
  const again = JSON.parse(await readFile(settingsFile, 'utf8'));
  check('and the settings file still has it', again.linuxHideTitleBar === true);

  const mac = await appWindow('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko)');
  await openSettings(mac);
  check('it is not offered on a Mac', (await option(mac)) === null);
} catch (error) {
  failures++;
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGKILL');
  await sleep(300);
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\ntitle bar: ${failures} check(s) failed` : '\ntitle bar: the option is offered on Linux and kept');
process.exit(failures ? 1 : 0);
