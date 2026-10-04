// Using Hilbert from a web browser (issue #40).
//
// The desktop app's address answers only its own window. A browser opened on it
// used to get an editor that could neither load nor save; it now gets a page
// saying so and what to do. Help → Use in a Browser writes the command that
// serves the open project to browsers: this runs that command exactly as the
// dialog shows it, signs in with its token, and checks the project compiles.
//
//   node scripts/test-browser-serve.mjs
//
// Needs a built frontend and backend, and typst. macOS and Linux (the command
// is run with sh).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const binary = process.env.BIN || ['debug', 'release']
  .map(m => join(root, 'src-tauri/target', m, process.platform === 'win32' ? 'hilbert.exe' : 'hilbert')).find(existsSync);
assert.ok(binary, 'Build the backend with cargo build before running this test.');
if (process.platform === 'win32') { console.log('browser serve: the command is checked on macOS and Linux'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), 'hilbert-browser-serve-'));
const ws = join(dir, "my project's folder");   // a space and a quote, to test the quoting
await mkdir(ws);
await writeFile(join(ws, 'main.typ'), '= Served\n\nWritten in a browser.\n');
await writeFile(join(dir, 'session.json'), JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
await writeFile(join(dir, 'settings.json'), JSON.stringify({ proofreading: false }));
const token = 'hilbert-browser-serve-token-0123456789ab';
const desktop = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(process.env.PORT || 3461), TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
    HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: join(dir, 'settings.json'),
    HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'), HILBERT_API_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bound = null;
for (const s of [desktop.stdout, desktop.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });

let browser, hosted, failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
try {
  for (let i = 0; i < 300 && !bound; i++) await sleep(50);
  assert.ok(bound, 'the desktop backend never said which port it bound');
  const origin = `http://127.0.0.1:${bound}`;
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });

  // 1. A plain browser on the desktop app's address.
  const stranger = await browser.newPage();
  await stranger.goto(origin, { waitUntil: 'networkidle2' });
  await sleep(800);
  const strangerText = await stranger.evaluate(() => document.body.innerText);
  check("a plain browser is told this is the app's private address", /private address/.test(strangerText) && /--serve/.test(strangerText));
  check('and is not shown an editor that cannot work', !(await stranger.$('.view-line')));

  // 2. The app's own window still gets the editor.
  const own = await browser.newPage();
  await own.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; }, token);
  await own.goto(origin, { waitUntil: 'networkidle2' });
  const editor = await own.waitForSelector('.view-line', { timeout: 30000 }).then(() => true, () => false);
  check("the app's own window still opens the editor", editor);

  // 3. The command the dialog writes. Shown as the desktop window would show
  //    it: Help → Use in a Browser.
  await own.evaluateOnNewDocument(() => { (window).__TAURI_INTERNALS__ = (window).__TAURI_INTERNALS__ || { invoke: () => Promise.reject(new Error('no tauri in a test')), transformCallback: () => 0 }; });
  await own.reload({ waitUntil: 'networkidle2' });
  await own.waitForSelector('.view-line', { timeout: 30000 });
  await own.evaluate(() => [...document.querySelectorAll('.menu-item, [class*="menu"]')].find(e => e.textContent.trim().startsWith('Help'))?.click());
  await sleep(300);
  const opened = await own.evaluate(() => {
    const item = [...document.querySelectorAll('.dropdown-item')].find(e => e.textContent.includes('Use in a Browser'));
    item?.click();
    return !!item;
  });
  check('Help offers Use in a Browser in the app window', opened);
  let command = '';
  for (let i = 0; i < 40 && !command; i++) { command = await own.evaluate(() => document.querySelector('.modal-content code')?.textContent || ''); if (!command) await sleep(100); }
  check('the dialog writes a command for this project', command.includes('--serve') && command.includes('--port 3101'), command.slice(0, 120));
  const served = /HILBERT_SERVER_TOKEN='([0-9a-f]{48})'/.exec(command)?.[1];
  check('with a fresh token of at least 32 characters', !!served);

  // Run it exactly as copied, but on a free port of our own.
  const port = Number(process.env.SERVE_PORT || 3471);
  hosted = spawn('sh', ['-c', `${command.replace('--port 3101', `--port ${port}`)} </dev/null`], {
    env: { ...process.env, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'), HILBERT_SETTINGS_FILE: join(dir, 'hosted-settings.json') },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let hostedLog = '';
  for (const s of [hosted.stdout, hosted.stderr]) s.on('data', d => { hostedLog += d; });
  for (let i = 0; i < 200 && !/hosted workspace: http/.test(hostedLog); i++) await sleep(50);
  check('the command starts a browser workspace on the project', /hosted workspace: http/.test(hostedLog) && hostedLog.includes(ws), hostedLog.split('\n')[0]);

  const visitor = await browser.createBrowserContext();
  const page = await visitor.newPage();
  await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle2' });
  await page.type('#token', served || 'missing');
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}), page.click('button[type="submit"]')]);
  const signedIn = await page.waitForSelector('.view-line', { timeout: 30000 }).then(() => true, () => false);
  check('signing in with the token opens the editor', signedIn);
  const notRefused = !(await page.evaluate(() => /private address/.test(document.body.innerText)));
  check('a signed-in browser is not mistaken for a stray one', notRefused);
  let pdf = false;
  for (let i = 0; i < 200 && !pdf; i++) { pdf = await page.evaluate(() => [...document.querySelectorAll('.textLayer span')].some(s => s.textContent.includes('Written in a browser'))); if (!pdf) await sleep(100); }
  check('and the project compiles in the browser', pdf);
} catch (error) {
  failures++;
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  desktop.kill('SIGKILL');
  if (hosted?.pid) { try { process.kill(-hosted.pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(300);
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\nbrowser serve: ${failures} check(s) failed` : '\nbrowser serve: a browser is told what to do, and the command works');
process.exit(failures ? 1 : 0);
