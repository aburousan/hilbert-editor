// Bugs reported on GitHub and fixed, checked so they stay fixed.
//
//   #9   Ctrl+Z straight after a restart brought back the starter document.
//   #24  The PDF preview lost its place when the window was resized.
//   #26  The editor font size was forgotten between launches.
//   #27  The file tree forgot how far it was scrolled.
//   #30  "File changed outside Hilbert" came up while typing, about Hilbert's
//        own saves.
//
//   node scripts/test-old-issues.mjs
//
// Needs a built frontend (npm run build) and backend (cargo build), and typst.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const names = process.platform === 'win32' ? ['hilbert.exe'] : ['hilbert'];
const binary = process.env.BIN || ['debug', 'release']
  .flatMap(m => names.map(name => join(root, 'src-tauri/target', m, name))).find(existsSync);
assert.ok(binary, 'Build the backend with cargo build before running this test.');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), 'hilbert-old-issues-'));
const ws = join(dir, 'workspace');
await mkdir(ws);
// Long enough to scroll the preview through, with a heading per page to know
// where it is.
const sections = Array.from({ length: 14 }, (_, i) =>
  `= Section ${i + 1}\n\n${`Section ${i + 1} prose, long enough to fill a page with words. `.repeat(60)}\n#pagebreak()\n`).join('\n');
await writeFile(join(ws, 'main.typ'), sections);
// Enough files that the tree has somewhere to scroll to.
await mkdir(join(ws, 'chapters'));
for (let i = 0; i < 60; i++) await writeFile(join(ws, `chapters/part-${String(i).padStart(2, '0')}.typ`), `= Part ${i}\n`);
const session = join(dir, 'session.json');
const settings = join(dir, 'settings.json');
await writeFile(session, JSON.stringify({
  workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ',
  expandedDirs: ['chapters'], treeScrollTop: 400,
}));
await writeFile(settings, JSON.stringify({ compileDelay: 100, fontSize: 19 }));
const token = 'hilbert-old-issues-token-0123456789ab';

let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const start = async port => {
  const server = spawn(binary, ['--headless'], {
    env: {
      ...process.env, PORT: String(port), TYPST_WORKSPACE: ws, TYPST_DIST: join(root, 'dist'),
      HILBERT_SESSION_FILE: session, HILBERT_SETTINGS_FILE: settings, HILBERT_API_TOKEN: token,
      HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bound = null;
  for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });
  for (let i = 0; i < 300 && !bound; i++) await sleep(50);
  assert.ok(bound, 'the backend never said which port it bound');
  return { server, origin: `http://127.0.0.1:${bound}` };
};
const openPage = async (browser, origin, width = 1500) => {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 950 });
  await page.evaluateOnNewDocument(t => {
    document.cookie = `hilbert_session=${t}; path=/`;
    // Any moment the conflict dialog is on screen, noted as it happens.
    window.__conflicts = 0;
    new MutationObserver(() => {
      if ([...document.querySelectorAll('.modal-header h2')].some(h => /changed outside Hilbert/.test(h.textContent))) window.__conflicts++;
    }).observe(document, { subtree: true, childList: true });
  }, token);
  await page.goto(origin, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.view-line', { timeout: 60000 });
  await page.waitForSelector('.pdf-page canvas', { timeout: 60000 });
  await sleep(2500);
  return page;
};
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const editorText = page => page.evaluate(() => [...document.querySelectorAll('.view-lines .view-line')]
  .map(l => l.textContent).join(' ').replace(/ /g, ' ').replace(/\s+/g, ' '));

let browser;
const servers = [];
try {
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const first = await start(Number(process.env.PORT || 3421));
  servers.push(first.server);
  const page = await openPage(browser, first.origin);

  // #26: the size chosen last time is the size the editor opens at.
  const size = await page.evaluate(() => getComputedStyle(document.querySelector('.view-line')).fontSize);
  check('#26 the editor opens at the font size that was set', size === '19px', size);

  // #27: the tree opens where it was left.
  let treeTop = 0;
  for (let i = 0; i < 40 && Math.abs(treeTop - 400) > 30; i++) {
    treeTop = await page.evaluate(() => document.querySelector('.file-tree')?.scrollTop ?? -1);
    await sleep(100);
  }
  check('#27 the file tree opens scrolled to where it was', Math.abs(treeTop - 400) <= 30, `scrollTop ${treeTop}`);

  // #30: a stretch of ordinary work — typing with a short compile delay, a
  // Ctrl+S, switching away — and the dialog must never appear, since nothing
  // outside Hilbert touched the file.
  await page.click('.view-lines');
  await page.keyboard.down(mod); await page.keyboard.press('Home'); await page.keyboard.up(mod);
  await page.keyboard.press('End');
  for (let round = 0; round < 4; round++) {
    await page.keyboard.type(` and a few words more ${round}`, { delay: 60 });
    await sleep(300);
  }
  await page.keyboard.down(mod); await page.keyboard.press('s'); await page.keyboard.up(mod);
  await page.keyboard.type(' typed straight after saving', { delay: 40 });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.keyboard.type(' and after coming back', { delay: 40 });
  await sleep(3000);
  // The throttled tree reload has happened by now; the tree must still be put.
  const treeAfter = await page.evaluate(() => document.querySelector('.file-tree')?.scrollTop ?? -1);
  check('#27 and stays there once typing has reloaded it', Math.abs(treeAfter - 400) <= 30, `scrollTop ${treeAfter}`);
  const conflicts = await page.evaluate(() => window.__conflicts);
  check('#30 no "changed outside Hilbert" while only Hilbert saved', conflicts === 0, `${conflicts} time(s)`);
  const onDisk = await readFile(join(ws, 'main.typ'), 'utf8');
  check('#30 and what was typed is what is on disk', onDisk.includes('a few words more 3 typed straight after saving and after coming back'));

  // Two windows saving one file at the same moment, both from the same
  // starting point: one wins and the rest are told the file moved on. Before,
  // the check and the write were apart and several could win, the later ones
  // silently overwriting the earlier.
  const auth = { Authorization: `Bearer ${token}` };
  await writeFile(join(ws, 'race.typ'), 'the starting text\n');
  const { hash: base } = await (await fetch(`${first.origin}/workspace/file/state?path=race.typ`, { headers: auth })).json();
  const statuses = await Promise.all(Array.from({ length: 12 }, (_, i) => fetch(`${first.origin}/workspace/file?path=race.typ`, {
    method: 'POST', headers: { ...auth, 'If-Match': base, 'Content-Type': 'text/plain' }, body: `window ${i} wrote this\n`,
  }).then(r => r.status)));
  const won = statuses.filter(s => s === 200).length;
  check('#30 of twelve saves from one starting point, exactly one wins', won === 1 && statuses.filter(s => s === 409).length === 11,
    `${won} saved, ${statuses.filter(s => s === 409).length} refused`);

  // Recovery copies arriving out of order: the older must not replace the newer.
  const draft = (savedAt, content) => fetch(`${first.origin}/recovery/drafts`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'k', workspace: ws, path: 'late.typ', content, savedAt }),
  });
  await draft(2000, 'the newer text');
  await draft(1000, 'the older text');
  const drafts = await (await fetch(`${first.origin}/recovery/drafts?workspace=${encodeURIComponent(ws)}`, { headers: auth })).json();
  const late = drafts.find(d => d.path === 'late.typ');
  check('a late, older recovery copy does not replace the newer one', late?.content === 'the newer text', late?.content);
  // A copy dated in the future means the clock was set back since it was
  // written; it must not block what is typed now. Nor may a copy with no date.
  await draft(Date.now() + 3_600_000, 'written before the clock went back');
  await draft(Date.now(), 'typed after the clock went back');
  const afterClock = (await (await fetch(`${first.origin}/recovery/drafts?workspace=${encodeURIComponent(ws)}`, { headers: auth })).json())
    .find(d => d.path === 'late.typ');
  check('a copy dated in the future does not block a newer one', afterClock?.content === 'typed after the clock went back', afterClock?.content);
  await draft(undefined, 'sent with no date');
  const undated = (await (await fetch(`${first.origin}/recovery/drafts?workspace=${encodeURIComponent(ws)}`, { headers: auth })).json())
    .find(d => d.path === 'late.typ');
  check('and a copy with no date counts as now', undated?.content === 'sent with no date', undated?.content);
  await fetch(`${first.origin}/recovery/remove`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: ws, path: 'late.typ' }),
  });

  // #24: scrolled halfway through the preview, the window is made narrower and
  // wider again; the same page stays in view.
  const visiblePage = () => page.evaluate(() => {
    const scroll = document.querySelector('.pdf-scroll').getBoundingClientRect();
    const pages = [...document.querySelectorAll('.pdf-page')];
    return pages.findIndex(p => { const r = p.getBoundingClientRect(); return r.bottom > scroll.top + scroll.height / 2 && r.top < scroll.top + scroll.height / 2; });
  });
  await page.evaluate(() => [...document.querySelectorAll('.pdf-page')][7].scrollIntoView({ block: 'center' }));
  await sleep(1200);
  const before = await visiblePage();
  for (const width of [1100, 1300, 1500]) {
    await page.setViewport({ width, height: 950 });
    await sleep(900);
  }
  await sleep(1200);
  const after = await visiblePage();
  check('#24 the preview keeps its place through a resize', before === 7 && after === before, `page ${before + 1} → page ${after + 1}`);

  // #9: after a restart, Ctrl+Z has nothing to undo — it must not bring back
  // some other document.
  await page.close();
  first.server.kill('SIGKILL');
  await sleep(500);
  const second = await start(Number(process.env.PORT || 3421) + 5);
  servers.push(second.server);
  const again = await openPage(browser, second.origin);
  const opened = await editorText(again);
  await again.click('.view-lines');
  for (let i = 0; i < 5; i++) { await again.keyboard.down(mod); await again.keyboard.press('z'); await again.keyboard.up(mod); await sleep(150); }
  await sleep(500);
  const undone = await editorText(again);
  check('#9 Ctrl+Z after a restart leaves the document as it opened', undone === opened && !/Typst with Physics/.test(undone),
    undone === opened ? '' : JSON.stringify(undone.slice(0, 80)));
  // What is on screen after the restart is text from the saved file (which
  // lines show depends on where the view was left), and the file holds what
  // was typed before it.
  const saved = (await readFile(join(ws, 'main.typ'), 'utf8')).replace(/\s+/g, ' ');
  check('#9 and it opened with what was saved', saved.includes(opened.trim().slice(0, 80)) && saved.includes('and after coming back'),
    JSON.stringify(opened.slice(0, 60)));
  const sizeAgain = await again.evaluate(() => getComputedStyle(document.querySelector('.view-line')).fontSize);
  const kept = JSON.parse(await readFile(settings, 'utf8'));
  check('#26 still 19 after a restart, and still in the settings file', sizeAgain === '19px' && kept.fontSize === 19, `${sizeAgain}, file says ${kept.fontSize}`);
} catch (error) {
  failures++;
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  for (const server of servers) server.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\nold issues: ${failures} check(s) failed` : '\nold issues: none of them are back');
process.exit(failures ? 1 : 0);
