// A file the document reads, changed outside Hilbert, shows in the preview by
// itself (issue #39).
//
// `typst watch` recompiles when a file behind #read, #image or #bibliography
// changes, but the preview only fetched a PDF after asking for a compile, so
// the old one stayed until the next keystroke. This changes such a file on disk
// and touches nothing in the app.
//
//   node scripts/test-external-change.mjs
//
// Needs a built frontend and backend, and typst.
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), 'hilbert-external-'));
const ws = join(dir, 'workspace');
await mkdir(ws);
await writeFile(join(ws, 'main.typ'), '= External\n\nThe note says: #read("note.txt")\n');
await writeFile(join(ws, 'note.txt'), 'firstversion');
await writeFile(join(dir, 'session.json'), JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
await writeFile(join(dir, 'settings.json'), JSON.stringify({ compileDelay: 100, proofreading: false }));
const token = 'hilbert-external-token-0123456789abcd';
const PORT = Number(process.env.PORT || 3451);
const launch = () => spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(PORT), TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
    HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: join(dir, 'settings.json'),
    HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'), HILBERT_API_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bound = null, log = '';
const listen = child => { for (const s of [child.stdout, child.stderr]) s.on('data', d => { log += d; bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; }); };
let server = launch();
listen(server);

let browser, failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const shown = page => page.evaluate(() => [...document.querySelectorAll('.textLayer span')].map(s => s.textContent).join(' '));
try {
  for (let i = 0; i < 300 && !bound; i++) await sleep(50);
  assert.ok(bound, 'the backend never said which port it bound');
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  await page.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; }, token);
  await page.goto(`http://127.0.0.1:${bound}`, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.view-line', { timeout: 60000 });
  let text = '';
  for (let i = 0; i < 200 && !/firstversion/.test(text); i++) { text = await shown(page); await sleep(100); }
  check('the preview shows what the file says', /firstversion/.test(text));
  const compilesBefore = (log.match(/compile: served/g) || []).length;

  for (const [round, word] of ['secondversion', 'thirdversion'].entries()) {
    await sleep(1500);
    await writeFile(join(ws, 'note.txt'), word);
    const t0 = Date.now();
    for (let i = 0; i < 100 && !text.includes(word); i++) { await sleep(50); text = await shown(page); }
    check(`round ${round + 1}: a change made outside Hilbert reaches the preview on its own`, text.includes(word),
      text.includes(word) ? `${Date.now() - t0} ms` : 'not after 5 s');
  }

  // Nothing extra: with the file left alone, the preview is not fetched again
  // and again, and one change is fetched once.
  const served = (log.match(/compile: served/g) || []).length - compilesBefore;
  await sleep(4000);
  const later = (log.match(/compile: served/g) || []).length - compilesBefore;
  check('one fetch per change, and none while nothing changes', served <= 3 && later === served, `${served} fetched for 2 changes, ${later - served} more while idle`);

  // Typing still works as before, and a compile of this window's own is not
  // fetched a second time.
  await page.click('.view-lines');
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control'); await page.keyboard.press('End'); await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  const before = (log.match(/compile: served/g) || []).length;
  await page.keyboard.type(' typedword', { delay: 20 });
  for (let i = 0; i < 100 && !text.includes('typedword'); i++) { await sleep(50); text = await shown(page); }
  await sleep(2500);
  const ownFetches = (log.match(/compile: served/g) || []).length - before;
  check('typing still updates the preview', text.includes('typedword'));
  check('and its compiles are not fetched twice', ownFetches <= 2, `${ownFetches} fetch(es) for one burst of typing`);

  // The backend restarts under an open page, and its count of compiles starts
  // again from nothing. The page must not wait for it to catch up.
  server.kill('SIGKILL');
  await sleep(800);
  bound = null;
  server = launch();
  listen(server);
  for (let i = 0; i < 300 && !bound; i++) await sleep(50);
  await sleep(4500);
  await writeFile(join(ws, 'note.txt'), 'afterrestart');
  const t1 = Date.now();
  for (let i = 0; i < 200 && !text.includes('afterrestart'); i++) { await sleep(50); text = await shown(page); }
  check('after the backend restarts, an outside change still reaches the preview', text.includes('afterrestart'),
    text.includes('afterrestart') ? `${Date.now() - t1} ms` : 'not after 10 s');
} catch (error) {
  failures++;
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\nexternal change: ${failures} check(s) failed` : '\nexternal change: the preview follows files changed outside Hilbert');
process.exit(failures ? 1 : 0);
