// Save As / Export suggests the document's own name, not the folder's (issue #41).
//
// Opening the folder MyWorkspace and the file myfile.typ used to suggest
// MyWorkspace.pdf. Every format but Project exports the main file, so the name
// now comes from that file; Project zips the folder and keeps the folder's name.
//
//   node scripts/test-export-name.mjs
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
const binary = process.env.BIN || ['debug', 'release']
  .map(m => join(root, 'src-tauri/target', m, process.platform === 'win32' ? 'hilbert.exe' : 'hilbert')).find(existsSync);
assert.ok(binary, 'Build the backend with cargo build before running this test.');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const token = 'hilbert-export-name-token-0123456789ab';

let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

// One workspace, one backend, one page. `files` is written into a folder named
// `folder`; `session` says which file is open and which is main.
async function scenario(folder, files, session, run, storage = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hilbert-export-name-'));
  const ws = join(dir, folder);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(ws, path, '..'), { recursive: true });
    await writeFile(join(ws, path), text);
  }
  await writeFile(join(dir, 'session.json'), JSON.stringify({ workspacePath: ws, ...session }));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ proofreading: false }));
  const server = spawn(binary, ['--headless'], {
    env: { ...process.env, PORT: String(process.env.PORT || 3481), TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
      HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: join(dir, 'settings.json'),
      HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'), HILBERT_API_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bound = null;
  for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });
  let browser;
  try {
    for (let i = 0; i < 300 && !bound; i++) await sleep(50);
    assert.ok(bound, 'the backend never said which port it bound');
    browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.evaluateOnNewDocument((t, extra) => {
      document.cookie = `hilbert_session=${t}; path=/`;
      localStorage.setItem('export_fmt', 'pdf');
      for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
    }, token, storage);
    await page.goto(`http://127.0.0.1:${bound}`, { waitUntil: 'networkidle2', timeout: 90000 });
    await page.waitForSelector('.view-line', { timeout: 60000 });
    await page.waitForSelector('.pdf-page', { timeout: 60000 }).catch(() => {});
    await sleep(600);
    await run(page, ws);
  } catch (error) {
    failures++;
    console.error(error);
  } finally {
    await browser?.close().catch(() => {});
    server.kill('SIGKILL');
    await sleep(200);
    await rm(dir, { recursive: true, force: true });
  }
}

async function openExport(page) {
  await page.evaluate(() => [...document.querySelectorAll('.menu-bar > div')].find(e => e.textContent.trim().startsWith('File'))?.click());
  await sleep(250);
  await page.evaluate(() => [...document.querySelectorAll('.dropdown-item')].find(e => e.textContent.includes('Save As / Export'))?.click());
  await page.waitForSelector('.modal-content input', { timeout: 10000 });
}
const nameShown = page => page.$eval('.modal-content input', el => el.value);
const pickFormat = (page, label) => page.evaluate(l => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent.trim() === l)?.click(), label);
const closeExport = page => page.evaluate(() => document.querySelector('.modal-content .close-btn')?.click());

// The reporter's case: a folder with one file in it, opened and exported.
await scenario('MyWorkspace', { 'myfile.typ': '= Mine\n\nHello.\n' }, { openPaths: ['myfile.typ'], activePath: 'myfile.typ' }, async page => {
  await openExport(page);
  check('PDF export suggests the file name, not the folder', await nameShown(page) === 'myfile', await nameShown(page));
  await pickFormat(page, 'Project');
  await sleep(100);
  check('Project export (a zip of the folder) keeps the folder name', await nameShown(page) === 'MyWorkspace', await nameShown(page));
  await pickFormat(page, 'PNG');
  await sleep(100);
  check('and the next format goes back to the file name', await nameShown(page) === 'myfile', await nameShown(page));
  await page.$eval('.modal-content input', el => { el.focus(); el.select(); });
  await page.keyboard.type('final version');
  await pickFormat(page, 'PDF');
  await sleep(100);
  check('a name the person typed stays when the format changes', await nameShown(page) === 'final version', await nameShown(page));
  await closeExport(page);
  const download = await page.evaluate(() => {
    const seen = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) seen.push(this.download); else original.call(this); };
    window.__downloads = seen;
    return true;
  });
  const button = await page.$('[title*="ownload"]');
  if (download && button) {
    await button.click();
    await sleep(500);
    const names = await page.evaluate(() => window.__downloads);
    check("the preview's download button uses the file name too", names.includes('myfile.pdf'), names.join(', ') || 'nothing downloaded');
  } else check("the preview's download button uses the file name too", false, 'no download button found');
});

// A main file in a subfolder with a space in its name, while another file is open.
await scenario('Thesis Folder', {
  'chapters/My Thesis.typ': '= Thesis\n\n#include "intro.typ"\n',
  'chapters/intro.typ': 'Intro text.\n',
}, { openPaths: ['chapters/intro.typ', 'chapters/My Thesis.typ'], activePath: 'chapters/intro.typ', mainFile: 'chapters/My Thesis.typ' }, async page => {
  await openExport(page);
  check('the main file names the export, without its folder', await nameShown(page) === 'My_Thesis', await nameShown(page));
});

// Export reads the file from disk, so an edit not saved yet (a long compile
// delay here) is saved first and is in what comes out.
await scenario('Drafts', { 'notes.typ': '= Notes\n\nSaved text.\n' }, { openPaths: ['notes.typ'], activePath: 'notes.typ' }, async page => {
  await page.click('.view-lines');
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control'); await page.keyboard.press('End'); await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.keyboard.type(' notsavedyet', { delay: 10 });
  await page.evaluate(() => {
    window.__blobs = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.__blobs.push([this.download, this.href]); else original.call(this); };
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = u => setTimeout(() => revoke(u), 10000);
  });
  await openExport(page);
  await pickFormat(page, 'Typst');
  await sleep(100);
  await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent.startsWith('Save '))?.click());
  let got = null;
  for (let i = 0; i < 50 && !got; i++) { await sleep(100); got = await page.evaluate(async () => { const b = window.__blobs[0]; return b ? [b[0], await (await fetch(b[1])).text()] : null; }); }
  check('the exported .typ is named after the file', got?.[0] === 'notes.typ', got?.[0] || 'nothing exported');
  check('and holds the edit that was not saved yet', !!got?.[1]?.includes('notsavedyet'), JSON.stringify(got?.[1] || ''));
}, { compile_delay: '5000', compile_delay_version: '3' });

// The same file changed outside Hilbert while an edit here was not saved yet.
// Saving would mean choosing between the two, so export stops and says why,
// and the outside version stays on disk until the person decides.
await scenario('Clash', { 'paper.typ': '= Paper\n\nFirst text.\n' }, { openPaths: ['paper.typ'], activePath: 'paper.typ' }, async (page, ws) => {
  await page.click('.view-lines');
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control'); await page.keyboard.press('End'); await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.keyboard.type(' typedhere', { delay: 10 });
  await writeFile(join(ws, 'paper.typ'), '= Paper\n\nChanged outside.\n');
  await sleep(300);
  await page.evaluate(() => {
    window.__blobs = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) window.__blobs.push(this.download); else original.call(this); };
  });
  // The question about the changed file is a window of its own on top, so read
  // the export window's text, not the first window's.
  const status = () => page.evaluate(() => [...document.querySelectorAll('.modal-content')]
    .find(m => m.querySelector('h2')?.textContent === 'Export')?.innerText || '');
  for (const attempt of [1, 2]) {
    if (!await page.$('.modal-content input')) await openExport(page);
    await pickFormat(page, 'Typst');
    await sleep(100);
    await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent.startsWith('Save '))?.click());
    let text = '';
    for (let i = 0; i < 50 && !/Nothing was exported|Downloaded/.test(text); i++) { await sleep(100); text = await status(); }
    check(`attempt ${attempt}: export stops and says why`, /Nothing was exported/.test(text), text.split('\n').find(l => /Nothing was exported/.test(l)) || 'no message');
  }
  check('the question about the changed file is shown', await page.evaluate(() => /File changed outside Hilbert/.test(document.body.innerText)));
  check('nothing was downloaded', (await page.evaluate(() => window.__blobs.length)) === 0);
  check('and the outside change is still on disk', (await readFile(join(ws, 'paper.typ'), 'utf8')).includes('Changed outside'));
}, { compile_delay: '5000', compile_delay_version: '3' });

console.log(failures ? `\nexport name: ${failures} check(s) failed` : '\nexport name: exports are named after the document');
process.exit(failures ? 1 : 0);
