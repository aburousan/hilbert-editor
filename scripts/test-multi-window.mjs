import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const dir = await mkdtemp(join(tmpdir(), 'hilbert-windows-'));
const binary = process.env.BIN || join(root, 'src-tauri/target/debug', process.platform === 'win32' ? 'typst-editor.exe' : 'typst-editor');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const instances = [];
let browser;
const request = (instance, path, init = {}) => fetch(instance.origin + path, {
  ...init, headers: { Authorization: `Bearer ${instance.token}`, ...init.headers }, signal: AbortSignal.timeout(45000),
});
const stop = async child => {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
};
const shortcut = async (page, key, shift = false) => {
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(mod);
  if (shift) await page.keyboard.down('Shift');
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up('Shift');
  await page.keyboard.up(mod);
};
const sourceText = page => page.$eval('.view-lines', el => el.textContent);
const editorFocus = async page => { await page.bringToFront(); await page.click('.view-line'); };
const checkFile = async (instance, expected) => {
  for (let n = 0; n < 100; n++) {
    if ((await readFile(join(instance.ws, 'main.typ'), 'utf8')).includes(expected)) return;
    await pause(100);
  }
  assert.fail(`File was not saved with ${expected}`);
};
try {
  for (let i = 0; i < 2; i++) {
    const ws = join(dir, `project-${i}`);
    await mkdir(ws);
    const marker = i ? 'WINDOW_B' : 'WINDOW_A';
    await writeFile(join(ws, 'main.typ'), `= ${marker}\n\nOriginal text.\n`);
    await writeFile(join(ws, 'notes.typ'), '= Other tab\n\nNotes.\n');
    const session = join(dir, `session-${i}.json`);
    await writeFile(session, JSON.stringify({ workspacePath: ws, openPaths: ['main.typ', 'notes.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
    const settings = join(dir, `settings-${i}.json`);
    await writeFile(settings, JSON.stringify({ proofreading: false, compileDelay: 500 }));
    const port = Number(process.env.PORT || 3106) + i;
    const token = `hilbert-window-${i}-0123456789abcdef0123456789`;
    const child = spawn(binary, ['--headless'], { env: { ...process.env, PORT: String(port), HILBERT_API_TOKEN: token,
      TYPST_DIST: join(root, 'dist'), TYPST_WORKSPACE: ws, HILBERT_SESSION_FILE: session,
      HILBERT_SETTINGS_FILE: settings, HILBERT_INTERPRETERS_FILE: join(dir, 'interpreters.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
    const instance = { ws, session, child, token, origin: `http://127.0.0.1:${port}`, logs: '' };
    instances.push(instance);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { instance.logs = (instance.logs + data).slice(-10000); });
    let ready = false;
    for (let n = 0; n < 100; n++) {
      if (child.exitCode !== null) throw Error(instance.logs);
      try { if ((await request(instance, '/workspace/root')).ok) { ready = true; break; } } catch {}
      await pause(100);
    }
    assert.ok(ready, instance.logs);
  }
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const errors = [];
  for (const instance of instances) {
    const page = await browser.newPage();
    instance.page = page;
    await page.setViewport({ width: 1440, height: 920 });
    await page.evaluateOnNewDocument(token => { window.__HILBERT_API_TOKEN__ = token; }, instance.token);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(instance.origin, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.view-line');
    await page.waitForSelector('.pdf-page canvas', { timeout: 60000 });
  }
  const [a, b] = instances;
  // Type through Monaco, not by replacing its model, so the real undo stack runs.
  for (const [instance, marker] of [[a, 'FIRST_EDIT'], [b, 'SECOND_EDIT']]) {
    await editorFocus(instance.page);
    await shortcut(instance.page, 'End');
    await instance.page.keyboard.type(marker, { delay: 25 });
    await shortcut(instance.page, 's');
    await checkFile(instance, marker);
  }
  assert.ok(!(await sourceText(a.page)).includes('SECOND_EDIT'));
  assert.ok(!(await sourceText(b.page)).includes('FIRST_EDIT'));
  await editorFocus(a.page);
  await shortcut(a.page, 'z');
  await a.page.waitForFunction(() => !document.querySelector('.view-lines').textContent.includes('FIRST_EDIT'));
  assert.ok((await sourceText(b.page)).includes('SECOND_EDIT'), 'Undo in A must not undo B');
  await shortcut(a.page, 'z', true);
  await a.page.waitForFunction(() => document.querySelector('.view-lines').textContent.includes('FIRST_EDIT'));
  await a.page.click('.tree-file[data-path="notes.typ"]');
  await a.page.waitForFunction(() => /Other\s+tab/.test(document.querySelector('.view-lines').textContent));
  await a.page.click('.tree-file[data-path="main.typ"]');
  await a.page.waitForFunction(() => document.querySelector('.view-lines').textContent.includes('FIRST_EDIT'));
  await editorFocus(a.page);
  await shortcut(a.page, 'z');
  await a.page.waitForFunction(() => !document.querySelector('.view-lines').textContent.includes('FIRST_EDIT'));
  await shortcut(a.page, 'z', true);
  await shortcut(a.page, 's');
  await checkFile(a, 'FIRST_EDIT');
  console.log('Two windows: edits, undo/redo, tab-switch history and saves are independent.');

  let polls = 0;
  a.page.on('request', req => { if (req.url().endsWith('/workspace/files/state')) polls++; });
  await a.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await pause(2400);
  const hiddenPolls = polls;
  await pause(2400);
  assert.equal(polls, hiddenPolls, 'A hidden window must stop file polling');
  await a.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
  await pause(300);
  assert.ok(polls > hiddenPolls, 'Becoming visible must immediately check files');
  console.log('Hidden-window polling pauses and resumes immediately.');

  const sa = JSON.parse(await readFile(a.session, 'utf8'));
  const sb = JSON.parse(await readFile(b.session, 'utf8'));
  assert.equal(sa.workspacePath, a.ws);
  assert.equal(sb.workspacePath, b.ws);
  assert.notEqual(a.session, b.session);
  assert.equal((await fetch(a.origin + '/workspace/root', { headers: { Authorization: `Bearer ${b.token}` } })).status, 401, 'Other window token must be rejected');
  assert.deepEqual(errors, []);
  await a.page.close();
  await b.page.close();

  // Two windows on the SAME project, with different entrypoints. Closing the
  // frontend pages leaves only the API calls below controlling the compilers.
  const shared = join(dir, 'shared');
  await mkdir(shared);
  await writeFile(join(shared, 'alpha.typ'), '= Alpha preview\n\n#import "alpha-data.typ": *\nAlpha.');
  await writeFile(join(shared, 'beta.typ'), '= Beta preview\n\n#import "beta-data.typ": *\nBeta.');
  await writeFile(join(shared, 'alpha-data.typ'), '#let one = 1');
  await writeFile(join(shared, 'beta-data.typ'), '#let two = 2');
  for (const instance of instances) {
    const response = await request(instance, '/workspace/root', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: shared }) });
    assert.ok(response.ok);
  }
  const pa = request(a, '/compile?main=alpha.typ', { method: 'POST' });
  const pb = request(b, '/compile?main=beta.typ', { method: 'POST' });
  const responseA = await pa;
  const responseB = await pb;
  assert.ok(responseA.ok, await responseA.clone().text());
  assert.ok(responseB.ok, await responseB.clone().text());
  const bytesA = Buffer.from(await responseA.arrayBuffer());
  const bytesB = Buffer.from(await responseB.arrayBuffer());
  assert.notDeepEqual(bytesA, bytesB);
  const lastA = await request(a, '/preview/last');
  const lastB = await request(b, '/preview/last');
  assert.deepEqual(Buffer.from(await lastA.arrayBuffer()), bytesA, 'B must not overwrite A preview');
  assert.deepEqual(Buffer.from(await lastB.arrayBuffer()), bytesB, 'A must not overwrite B preview');
  const before = await (await request(a, '/workspace/file/state?path=alpha.typ')).json();
  const edited = '= Saved by window A';
  const writeA = await request(a, '/workspace/file?path=alpha.typ', {
    method: 'POST', headers: { 'If-Match': before.hash }, body: edited,
  });
  assert.ok(writeA.ok);
  const writeB = await request(b, '/workspace/file?path=alpha.typ', {
    method: 'POST', headers: { 'If-Match': before.hash }, body: '= Stale window B text',
  });
  assert.equal(writeB.status, 409, 'A stale save in B must require conflict resolution');
  assert.equal(await readFile(join(shared, 'alpha.typ'), 'utf8'), edited);
  console.log('Same-file stale saves are rejected instead of overwriting the other window.');
  await stop(a.child);
  assert.ok((await request(b, '/compile?main=beta.typ', { method: 'POST' })).ok, 'Closing A must not stop B');
  console.log('Shared project: preview outputs stay separate; closing one backend leaves the other working.');
  console.log('Multi-window checks passed.');
} catch (error) {
  for (const instance of instances) {
    if (instance.page && !instance.page.isClosed()) console.error('Window state:', await sourceText(instance.page).catch(() => 'unavailable'));
    console.error(instance.logs.slice(-2000));
  }
  throw error;
} finally {
  await browser?.close();
  for (const instance of instances) await stop(instance.child);
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
}
