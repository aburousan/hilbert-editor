// Delete in the file tree must never destroy files (issue #42).
//
// The tree is the folder on disk. Someone who took it for a list of names
// selected 2000 files to "clear" it, confirmed "Delete 2000 items?", and lost
// the folder for good. Now:
//   - delete moves things to the Trash; this test sends them to the project's
//     .hilbert/trash instead (HILBERT_PROJECT_TRASH=1), so it can check they
//     arrived whole without filling the Trash of whoever runs it
//   - the question says the files leave the folder on disk, and Enter does not
//     answer it
//   - File → Close Folder empties the list and touches nothing on disk
//   - the browser-only "clear the workspace" also uses the Trash
//
//   node scripts/test-tree-delete.mjs
//
// Needs a built frontend and backend.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const binary = process.env.BIN || ['release', 'debug']
  .map(m => join(root, 'src-tauri/target', m, process.platform === 'win32' ? 'hilbert.exe' : 'hilbert')).find(existsSync);
assert.ok(binary, 'Build the backend with cargo build before running this test.');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), 'hilbert-tree-delete-'));
const ws = join(dir, 'Thesis');
const other = join(dir, 'Elsewhere');
await mkdir(join(ws, 'chapters'), { recursive: true });
await mkdir(join(ws, '.git'));
await mkdir(other);
await writeFile(join(ws, 'main.typ'), '= Thesis\n\n#include "chapters/one.typ"\n');
await writeFile(join(ws, 'chapters', 'one.typ'), 'Chapter one, written over many months.\n');
await writeFile(join(ws, 'chapters', 'two.typ'), 'Chapter two.\n');
await writeFile(join(ws, 'notes.typ'), 'Notes I must not lose.\n');
await writeFile(join(ws, 'draft.typ'), 'An old draft.\n');
await writeFile(join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n');
await writeFile(join(other, 'kept.typ'), 'Another project.\n');
await mkdir(join(ws, 'a')); await mkdir(join(ws, 'b'));
await writeFile(join(ws, 'a', 'same.typ'), 'the one in a\n');
await writeFile(join(ws, 'b', 'same.typ'), 'the one in b\n');
await writeFile(join(dir, 'session.json'), JSON.stringify({ workspacePath: ws, openPaths: ['main.typ', 'notes.typ'], activePath: 'notes.typ', mainFile: 'main.typ' }));
await writeFile(join(dir, 'settings.json'), JSON.stringify({ proofreading: false }));
const token = 'hilbert-tree-delete-token-0123456789ab';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(process.env.PORT || 3521), TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
    HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: join(dir, 'settings.json'),
    HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'), HILBERT_API_TOKEN: token,
    HILBERT_PROJECT_TRASH: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bound = null;
for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });

let browser, failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
// Everything in .hilbert/trash, as relative path → content.
const trashed = async () => {
  const out = {};
  const walk = async (d, rel) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p, r); else out[r.replace(/^\d+-\d+\//, '')] = await readFile(p, 'utf8');
    }
  };
  await walk(join(ws, '.hilbert', 'trash'), '');
  return out;
};
const dialogText = page => page.evaluate(() => [...document.querySelectorAll('.modal-content')].find(m => m.querySelector('h2')?.textContent === 'Confirm')?.innerText || '');
// A real mouse click, so a held Cmd or Ctrl key counts.
const select = async (page, name) => {
  const handle = await page.evaluateHandle(n => [...document.querySelectorAll('.tree-file, .tree-dir')].find(e => e.textContent.trim().startsWith(n)), name);
  await handle.asElement()?.click();
};

try {
  for (let i = 0; i < 300 && !bound; i++) await sleep(50);
  assert.ok(bound, 'the backend never said which port it bound');
  const origin = `http://127.0.0.1:${bound}`;
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  // Close Folder is a desktop-app command, so look like the app's window.
  await page.evaluateOnNewDocument(t => {
    document.cookie = `hilbert_session=${t}; path=/`;
    window.__TAURI_INTERNALS__ = { invoke: () => Promise.reject(new Error('no tauri in a test')), transformCallback: () => 0 };
  }, token);
  await page.goto(origin, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.tree-file', { timeout: 60000 });
  await sleep(1500);

  // 1. Delete key: the question, and Enter does not answer it.
  await select(page, 'draft.typ');
  await page.keyboard.press('Delete');
  await page.waitForSelector('.modal-content h2', { timeout: 5000 });
  const asked = await dialogText(page);
  check('the question says the files leave the folder on disk', /Trash/.test(asked) && /folder on your disk/.test(asked) && /Close Folder/.test(asked), asked.split('\n').filter(Boolean)[1]);
  // Focus starts on Cancel, so Enter cancels.
  await page.keyboard.press('Enter');
  await sleep(400);
  check('Enter does not delete', existsSync(join(ws, 'draft.typ')));
  await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent === 'Cancel')?.click());
  await sleep(300);
  check('Cancel keeps the file', existsSync(join(ws, 'draft.typ')));

  // 2. Confirmed: the file goes to the trash whole, not away.
  await select(page, 'draft.typ');
  await page.keyboard.press('Delete');
  await page.waitForSelector('.modal-content h2', { timeout: 5000 });
  await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent === 'Move to Trash')?.click());
  await sleep(1200);
  let bin = await trashed();
  check('a deleted file leaves the folder', !existsSync(join(ws, 'draft.typ')));
  check('and is in the trash, whole', bin['draft.typ'] === 'An old draft.\n', Object.keys(bin).join(', '));

  // 3. Several at once from the menu, a folder among them, one of them open.
  await select(page, 'chapters');
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
  await select(page, 'notes.typ');
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  await sleep(200);
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.tree-file')].find(e => e.textContent.trim().startsWith('notes.typ'));
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 200 }));
  });
  await sleep(300);
  const menuItem = await page.evaluate(() => [...document.querySelectorAll('.dropdown-item')].find(e => e.textContent.startsWith('Move to Trash'))?.textContent || '');
  check('the menu says Move to Trash', /^Move to Trash/.test(menuItem), menuItem);
  await page.evaluate(() => [...document.querySelectorAll('.dropdown-item')].find(e => e.textContent.startsWith('Move to Trash'))?.click());
  await page.waitForSelector('.modal-content h2', { timeout: 5000 });
  check('and asks about 2 items', /Move 2 items to the Trash/.test(await dialogText(page)));
  await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent === 'Move to Trash')?.click());
  await sleep(1500);
  bin = await trashed();
  check('a folder goes to the trash with everything in it', bin['chapters/one.typ'] === 'Chapter one, written over many months.\n' && bin['chapters/two.typ'] === 'Chapter two.\n', Object.keys(bin).join(', '));
  check('the open file goes too, whole', bin['notes.typ'] === 'Notes I must not lose.\n');
  check('and its tab closes', !(await page.evaluate(() => [...document.querySelectorAll('.tab')].some(t => t.textContent.includes('notes.typ')))));
  check('what was not chosen stays', existsSync(join(ws, 'main.typ')) && existsSync(join(ws, '.git', 'HEAD')));

  // 4. The tree's row button is a trash can that says what it does.
  const rowButton = await page.evaluate(() => document.querySelector('.tree-file .tree-del')?.getAttribute('title') || '');
  check('the button on a row says Move ... to the Trash', /to the Trash/.test(rowButton), rowButton);

  // 5. Close Folder empties the list and leaves the folder alone.
  const open = await fetch(`${origin}/workspace/root`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: other }) });
  const before = await (await fetch(`${origin}/workspace/root`, { headers: { Authorization: `Bearer ${token}` } })).json();
  check('another folder opens', open.ok && before.root === other, before.root);
  await page.evaluate(() => [...document.querySelectorAll('.menu-bar > div')].find(e => e.textContent.trim().startsWith('File'))?.click());
  await sleep(250);
  const closed = await page.evaluate(() => { const i = [...document.querySelectorAll('.dropdown-item')].find(e => e.textContent.startsWith('Close Folder')); i?.click(); return !!i; });
  check('File has Close Folder', closed);
  await sleep(2000);
  const now = await (await fetch(`${origin}/workspace/root`, { headers: { Authorization: `Bearer ${token}` } })).json();
  check('Close Folder goes back to Hilbert’s own folder', now.root === ws, now.root);
  check('and the closed folder is untouched', (await readFile(join(other, 'kept.typ'), 'utf8')) === 'Another project.\n');

  // 6. Two files with one name, deleted at the same moment, both kept whole.
  const both = await Promise.all(['a/same.typ', 'b/same.typ'].map(p =>
    fetch(`${origin}/workspace/file?path=${encodeURIComponent(p)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })));
  const sames = [];
  const walk = async d => { for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
    const p = join(d, e.name); if (e.isDirectory()) await walk(p); else if (e.name === 'same.typ') sames.push(await readFile(p, 'utf8')); } };
  await walk(join(ws, '.hilbert', 'trash'));
  check('two files with one name deleted at once are both kept', both.every(r => r.ok) && sames.includes('the one in a\n') && sames.includes('the one in b\n'), sames.map(t => t.trim()).join(' | '));

  // 7. Making something new never replaces what is there.
  const auth = { Authorization: `Bearer ${token}` };
  const newFile = await fetch(`${origin}/workspace/file?create=1&path=main.typ`, { method: 'POST', body: '', headers: auth });
  check('New File with an existing name is refused', newFile.status === 409, String(newFile.status));
  check('and the file keeps its text', (await readFile(join(ws, 'main.typ'), 'utf8')).startsWith('= Thesis'));
  const dropped = await (await fetch(`${origin}/workspace/upload?unique=1&path=main.typ`, { method: 'POST', body: 'dropped in', headers: auth })).json();
  check('a file dropped in keeps both copies', dropped.path && dropped.path !== 'main.typ' && (await readFile(join(ws, 'main.typ'), 'utf8')).startsWith('= Thesis'), dropped.path);
  await writeFile(join(ws, 'archive.zip'), 'my own zip');
  const zipped = await fetch(`${origin}/workspace/compress`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: ['main.typ'], archiveName: 'archive.zip' }) });
  check('Compress does not write over an existing archive', zipped.status === 409 && (await readFile(join(ws, 'archive.zip'), 'utf8')) === 'my own zip', String(zipped.status));

  // 8. The browser-only "clear the workspace" also uses the trash, keeps .git.
  const cleared = await fetch(`${origin}/workspace/clear`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  bin = await trashed();
  check('clearing the workspace moves it to the trash', cleared.ok && !existsSync(join(ws, 'main.typ')) && bin['main.typ']?.startsWith('= Thesis'), String(cleared.status));
  check('and keeps .git', existsSync(join(ws, '.git', 'HEAD')));
} catch (error) {
  failures++;
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGKILL');
  await sleep(300);
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\ntree delete: ${failures} check(s) failed` : '\ntree delete: nothing in the file tree is deleted for good');
process.exit(failures ? 1 : 0);
