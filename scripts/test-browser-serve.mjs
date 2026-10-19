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
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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

  // 4. A signed-in browser can neither read nor write a `.git` folder: its
  //    config and hooks name programs git runs, so a file there is code that
  //    runs on this computer, code execution switch or not.
  const gitAnswers = await page.evaluate(async () => {
    const out = {};
    for (const path of ['.git/config', '.GIT/config', '.git./hooks/pre-commit', 'chapters/.git/config']) {
      out[`write ${path}`] = (await fetch(`/workspace/file?path=${encodeURIComponent(path)}`, { method: 'POST', body: '[core]\n\tfsmonitor = touch /tmp/hilbert-pwned\n' })).status;
    }
    out['read .git/config'] = (await fetch('/workspace/file?path=.git/config')).status;
    out['make .git/hooks'] = (await fetch('/workspace/mkdir?path=.git/hooks', { method: 'POST' })).status;
    out['write notes.typ'] = (await fetch('/workspace/file?path=notes.typ', { method: 'POST', body: 'fine' })).status;
    return out;
  });
  const refused = Object.entries(gitAnswers).filter(([k]) => k !== 'write notes.typ').every(([, status]) => status >= 400);
  check('a browser cannot read or write .git', refused && gitAnswers['write notes.typ'] === 200 && !existsSync(join(ws, '.git')), JSON.stringify(gitAnswers));

  // Copying the project to a folder named in the request would let a browser
  // write anywhere on this computer, so a hosted server refuses it.
  const outside = join(dir, 'outside-copy');
  const syncStatus = await page.evaluate(async folder => (await fetch('/drive/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) })).status, outside);
  check('a browser cannot copy the project to a folder of its choosing', syncStatus === 403 && !existsSync(outside), String(syncStatus));

  // The server knows which versions on disk it wrote itself. A file written by
  // the session (here an upload, the way unopened shared files arrive) is its
  // own; one written by another copy of Hilbert is not.
  const ownership = await page.evaluate(async () => {
    await fetch('/workspace/upload?path=shared.typ', { method: 'POST', body: 'from the session' });
    return (await (await fetch('/workspace/file/state?path=shared.typ')).json()).ours;
  });
  await fetch(`${origin}/workspace/file?path=shared.typ`, { method: 'POST', body: 'from the desktop', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' } });
  const afterDesktop = await page.evaluate(async () => (await (await fetch('/workspace/file/state?path=shared.typ')).json()).ours);
  check("the server tells its own writes from another program's", ownership === true && afterDesktop === false, `session upload: ${ownership}, desktop save: ${afterDesktop}`);

  // 5. The desktop window changes the open file while the browser has it open.
  //    The browser's next save must ask which version to keep, not write over
  //    the desktop's text without a word.
  await page.click('.view-lines');
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(mod); await page.keyboard.press('End'); await page.keyboard.up(mod);
  await page.keyboard.type(' browserword', { delay: 15 });
  await sleep(2500);
  const desktopSave = await fetch(`${origin}/workspace/file?path=main.typ`, { method: 'POST', body: '= Served\n\nWritten in the desktop window.\n', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' } });
  check('the desktop window saves its own change', desktopSave.ok, String(desktopSave.status));
  await page.keyboard.type(' secondword', { delay: 15 });
  let asked = false;
  for (let i = 0; i < 60 && !asked; i++) { await sleep(100); asked = await page.evaluate(() => /File changed outside Hilbert/.test(document.body.innerText)); }
  const onDisk = await readFile(join(ws, 'main.typ'), 'utf8');
  check('the browser asks before saving over it', asked);
  check("and the desktop's text is still on disk", onDisk.includes('Written in the desktop window') && !onDisk.includes('secondword'), JSON.stringify(onDisk));
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
