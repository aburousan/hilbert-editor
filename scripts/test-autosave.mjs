// Work that was typed must survive the app being killed.
//
// What prompted this: a Windows update restarted someone's laptop and hours of
// work could not be got back. Two things were behind it. The copy Hilbert kept
// of unsaved text lived in the page's own storage, which is keyed to the port —
// and the port is only 3001 if nothing else has it, and never for a second
// window — so after a restart the copy could be there and not be found. And
// versions kept with Ctrl+S lived only in memory.
//
// This types something that is not yet saved, kills the backend and the page
// outright, starts again on a different port, and checks the text comes back.
// Then it checks that Ctrl+S versions outlive a restart, that the timed-version
// setting keeps and persists, and that leaving the window saves at once.
//
//   node scripts/test-autosave.mjs
//
// Needs a built frontend (npm run build) and backend (cargo build).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
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

const dir = await mkdtemp(join(tmpdir(), 'hilbert-autosave-'));
const ws = join(dir, 'workspace');
await mkdir(ws);
const original = '= Thesis\n\nThe first chapter, as it was.\n';
await writeFile(join(ws, 'main.typ'), original);
const session = join(dir, 'session.json');
const settings = join(dir, 'settings.json');
// A second file that stays open and is never touched: the timer keeps nothing of it.
await writeFile(join(ws, 'notes.typ'), '= Notes\n\nLeft alone.\n');
await writeFile(session, JSON.stringify({ workspacePath: ws, openPaths: ['notes.typ', 'main.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
await writeFile(settings, JSON.stringify({ compileDelay: 4000 }));
const recovery = join(dir, 'recovery');
const history = join(dir, 'history');
const token = 'hilbert-autosave-token-0123456789abcd';

let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

const start = async port => {
  const server = spawn(binary, ['--headless'], {
    env: {
      ...process.env, PORT: String(port), TYPST_WORKSPACE: ws, TYPST_DIST: join(root, 'dist'),
      HILBERT_SESSION_FILE: session, HILBERT_SETTINGS_FILE: settings, HILBERT_API_TOKEN: token,
      HILBERT_RECOVERY_DIR: recovery, HILBERT_HISTORY_DIR: history,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bound = null;
  for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });
  for (let i = 0; i < 300 && !bound; i++) await sleep(50);
  assert.ok(bound, 'the backend never said which port it bound');
  return { server, origin: `http://127.0.0.1:${bound}`, port: bound };
};
const openPage = async (browser, origin, { blockSaves = false } = {}) => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  await page.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; }, token);
  if (blockSaves) {
    // The machine is about to go down before the file itself is written: every
    // write of the document is held back, so only the recovery copy can save it.
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname === '/workspace/file') return request.abort();
      request.continue().catch(() => {});
    });
  }
  await page.goto(origin, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.view-line', { timeout: 60000 });
  await sleep(2500);
  return page;
};
const typeAtEnd = async (page, text) => {
  await page.click('.view-lines');
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(mod); await page.keyboard.press('End'); await page.keyboard.up(mod);
  await page.keyboard.type(text);
};
const editorText = page => page.evaluate(() => [...document.querySelectorAll('.view-lines .view-line')]
  .map(l => l.textContent).join(' ').replace(/\u00a0/g, ' ').replace(/\s+/g, ' '));

let browser;
const servers = [];
try {
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });

  // 1. Unsaved text, then the machine goes down.
  const first = await start(Number(process.env.PORT || 3401));
  servers.push(first.server);
  const page = await openPage(browser, first.origin, { blockSaves: true });
  const typed = 'A paragraph written just before the update restarted the machine.';
  await typeAtEnd(page, `\n${typed}`);
  await sleep(1500);
  check('the file itself was not written', (await readFile(join(ws, 'main.typ'), 'utf8')) === original);
  const kept = existsSync(recovery) ? (await readdir(recovery, { recursive: true })).filter(f => String(f).endsWith('.json')) : [];
  check('a copy of the unsaved text is on disk', kept.length === 1, `${kept.length} copies`);
  // Killed, not closed: no chance to save anything on the way out. Its typst
  // watch lives on, as it would after a real crash.
  const orphan = Number(await readFile(join(ws, '.hilbert/watch.pid'), 'utf8').catch(() => '0'));
  first.server.kill('SIGKILL');
  await page.close();
  await sleep(500);

  // 2. Back up on another port, as after a restart where 3001 was taken.
  const second = await start(first.port + 7);
  servers.push(second.server);
  check('the new start is on a different port', second.port !== first.port, `${first.port} → ${second.port}`);
  const back = await openPage(browser, second.origin);
  await sleep(1500);
  check('the unsaved paragraph comes back', (await editorText(back)).includes(typed));
  let disk = '';
  for (let i = 0; i < 30; i++) {
    disk = await readFile(join(ws, 'main.typ'), 'utf8');
    if (disk.includes(typed)) break;
    await sleep(500);
  }
  check('and reaches the file once the app is running again', disk.includes(typed));
  // The next start stops the watcher the crashed one left behind, rather than
  // running a second one beside it on the same project.
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  if (process.platform !== 'win32') {
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { gone = !orphan || !alive(orphan); if (!gone) await sleep(100); }
    check('the typst watch left by the crash is stopped', orphan > 0 && gone, `pid ${orphan}`);
  }

  // 3. A Ctrl+S version outlives a restart.
  await typeAtEnd(back, '\nA sentence worth keeping a version of.');
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await back.keyboard.down(mod); await back.keyboard.press('s'); await back.keyboard.up(mod);
  await sleep(2000);
  const listed = await (await fetch(`${second.origin}/history/versions?workspace=${encodeURIComponent(ws)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json().catch(() => []);
  const saved = Array.isArray(listed) ? listed.filter(v => v.kind === 'save' && v.content.includes('worth keeping')) : [];
  check('Ctrl+S keeps a version on disk', saved.length === 1,
    `${Array.isArray(listed) ? listed.map(v => `${v.kind}:${JSON.stringify(v.content.slice(-45))}`).join(' | ') : 'no list'}`);
  second.server.kill('SIGKILL');
  await back.close();
  await sleep(400);

  const third = await start(first.port + 13);
  servers.push(third.server);
  const again = await openPage(browser, third.origin);
  await again.evaluate(() => [...document.querySelectorAll('button')].find(b => b.title === 'Version history')?.click());
  await sleep(800);
  const panel = await again.evaluate(() => document.querySelector('.history-list')?.textContent || '');
  check('the version is still in History after a restart', /saved with/.test(panel), panel.slice(0, 80));

  // Choosing a version shows what it holds against the file now, and restoring
  // it keeps what was there first, so the restore can itself be undone.
  await again.keyboard.press('Escape');
  await sleep(300);
  await typeAtEnd(again, '\nAn edit made after the save.');
  await sleep(400);
  await again.evaluate(() => [...document.querySelectorAll('button')].find(b => b.title === 'Version history')?.click());
  await sleep(800);
  await again.evaluate(() => [...document.querySelectorAll('.history-item')][0]?.click());
  let diffShown = false;
  for (let i = 0; i < 40 && !diffShown; i++) {
    diffShown = await again.evaluate(() => !!document.querySelector('.history-panel .monaco-diff-editor .view-line'));
    if (!diffShown) await sleep(100);
  }
  check('a version is shown against the file before restoring', diffShown);
  const counted = await again.evaluate(() => document.querySelector('.history-panel')?.textContent || '');
  check('and says how much differs', /added|identical/.test(counted), (/Left:.*?since then\.|identical\./.exec(counted) || [''])[0]);
  const oldest = await again.evaluate(() => [...document.querySelectorAll('.history-item')].length);
  await again.evaluate(() => [...document.querySelectorAll('.history-panel button')].find(b => /Restore this version/.test(b.textContent))?.click());
  await sleep(1200);
  const afterRestore = await (await fetch(`${third.origin}/history/versions?workspace=${encodeURIComponent(ws)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json().catch(() => []);
  const before = Array.isArray(afterRestore) ? afterRestore.filter(v => v.kind === 'before-restore') : [];
  check('restoring keeps the text it replaced as a version', before.length === 1 && before[0].content.includes('An edit made after the save'),
    `${before.length} kept, list had ${oldest}`);
  const restored = await editorText(again);
  check('and the restored text is in the editor', restored.includes('worth keeping') && !restored.includes('An edit made after the save'));

  // 3b. Typing on while Ctrl+S is still writing. The save captures the text
  //     when the key is pressed; if it later wrote that capture back into the
  //     editor, the characters typed during the write would vanish or jump —
  //     the shape of issues #12 and #31. The write is held for 800 ms here so
  //     the typing lands inside it.
  await again.close();
  const racer = await openPage(browser, third.origin);
  await racer.setRequestInterception(true);
  racer.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/workspace/file') {
      setTimeout(() => request.continue().catch(() => {}), 800);
      return;
    }
    request.continue().catch(() => {});
  });
  await typeAtEnd(racer, '\nSaved: ');
  await racer.keyboard.down(mod); await racer.keyboard.press('s'); await racer.keyboard.up(mod);
  const during = 'typed while the save was on its way';
  await racer.keyboard.type(during, { delay: 25 });
  await sleep(2500);
  const afterRace = await editorText(racer);
  check('typing during Ctrl+S keeps every character in place', afterRace.includes('Saved: ' + during),
    JSON.stringify(afterRace.slice(afterRace.indexOf('Saved:'), afterRace.indexOf('Saved:') + 60)));
  // Let that text reach the file before the page goes, or closing leaves a
  // recovery copy behind for the steps below to trip over.
  for (let i = 0; i < 100 && !(await readFile(join(ws, 'main.typ'), 'utf8')).includes(during); i++) await sleep(100);
  await racer.close();

  // 4. Leaving the window saves straight away, not after the usual pause —
  //    the delay is 4 s here, so a save inside that is the leaving doing it.
  //    A page of its own, so nothing left over from the History panel is in
  //    the way of the typing.
  const fresh = await openPage(browser, third.origin);
  await typeAtEnd(fresh, '\nWritten, then the window left behind.');
  // Once the words are in the editor — and before the usual pause is up.
  for (let i = 0; i < 40 && !(await editorText(fresh)).includes('window left behind'); i++) await sleep(50);
  const left = Date.now();
  await fresh.evaluate(() => window.dispatchEvent(new Event('blur')));
  let onDisk = false;
  for (let i = 0; i < 100 && !onDisk; i++) {
    onDisk = (await readFile(join(ws, 'main.typ'), 'utf8')).includes('window left behind');
    if (!onDisk) await sleep(50);
  }
  const took = Date.now() - left;
  check('leaving the window saves at once', onDisk && took < 2500, `${took} ms (the pause is 4000 ms)`);

  // 4b. Leaving the window while a compile is still running. The save used to
  //     go by way of a compile, and so waited for the one in flight; the file
  //     stayed behind for as long as that compile took. Compiles are held for
  //     five seconds here.
  const held = await openPage(browser, third.origin);
  await held.setRequestInterception(true);
  held.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/compile') {
      setTimeout(() => request.continue().catch(() => {}), 5000);
      return;
    }
    request.continue().catch(() => {});
  });
  await typeAtEnd(held, '\nFirst words.');
  await held.evaluate(() => window.dispatchEvent(new Event('blur')));
  await sleep(600);
  await typeAtEnd(held, ' More words while that compile runs.');
  for (let i = 0; i < 40 && !(await editorText(held)).includes('while that compile runs'); i++) await sleep(50);
  const left2 = Date.now();
  await held.evaluate(() => window.dispatchEvent(new Event('blur')));
  let saved2 = false;
  for (let i = 0; i < 80 && !saved2; i++) {
    saved2 = (await readFile(join(ws, 'main.typ'), 'utf8')).includes('while that compile runs');
    if (!saved2) await sleep(50);
  }
  check('leaving the window saves even while a compile is running', saved2 && Date.now() - left2 < 2000,
    `${Date.now() - left2} ms (the compile is held for 5000 ms)`);
  await sleep(5500);
  await held.close();

  // 5. The timed setting is offered, remembered, and keeps a version on time.
  const stored = JSON.parse(await readFile(settings, 'utf8'));
  stored.historyInterval = 1;
  await writeFile(settings, JSON.stringify(stored));
  await fresh.reload({ waitUntil: 'networkidle2' });
  await fresh.waitForSelector('.view-line', { timeout: 60000 });
  await sleep(2500);
  await typeAtEnd(fresh, '\nA change the timer should keep.');
  if (process.env.QUICK) {
    console.log('  --   QUICK set: not waiting a minute for the timed version');
  } else {
    await sleep(64000);
    const timed = await (await fetch(`${third.origin}/history/versions?workspace=${encodeURIComponent(ws)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json().catch(() => []);
    const auto = Array.isArray(timed) ? timed.filter(v => v.kind === 'auto' && v.content.includes('timer should keep')) : [];
    check('a timed version is kept after a minute', auto.length >= 1, `${auto.length} kept automatically`);
    const untouched = Array.isArray(timed) ? timed.filter(v => v.path === 'notes.typ') : [];
    check('and none of a file left alone', untouched.length === 0, `${untouched.length} kept of notes.typ`);
  }

  // 6. A long document keeps every Ctrl+S version. Sending the whole list each
  //    time used to cross the backend's 2 MB limit by the third save of a
  //    document this size, after which nothing more was kept, silently.
  // The page before has an edit still waiting on its pause; let it land, and
  // close that page, so it cannot write over the file this step puts down.
  for (let i = 0; i < 100 && !(await readFile(join(ws, 'main.typ'), 'utf8')).includes('timer should keep'); i++) await sleep(100);
  await fresh.close();
  const long = `= Long\n\n${'A line of a long thesis, repeated to make the file big. '.repeat(12000)}\n`;
  await writeFile(join(ws, 'main.typ'), long);
  const big = await openPage(browser, third.origin);
  for (let i = 1; i <= 4; i++) {
    await typeAtEnd(big, `\nRevision ${i} of the long file.`);
    await big.keyboard.down(mod); await big.keyboard.press('s'); await big.keyboard.up(mod);
    await sleep(1500);
  }
  await sleep(1000);
  const bigList = await (await fetch(`${third.origin}/history/versions?workspace=${encodeURIComponent(ws)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json().catch(() => []);
  const revisions = Array.isArray(bigList) ? bigList.filter(v => v.kind === 'save' && /Revision \d of the long file/.test(v.content)) : [];
  check('every save of a 700 KB document keeps its version', revisions.length === 4,
    `${revisions.length} of 4 kept, file is ${Math.round(long.length / 1024)} KB`);
} catch (error) {
  failures++;
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  // The backends are killed outright, so their typst watch would outlive the
  // test; stop the one still recorded for this project.
  const last = Number(await readFile(join(ws, '.hilbert/watch.pid'), 'utf8').catch(() => '0'));
  for (const server of servers) server.kill('SIGKILL');
  if (last > 1) { try { process.kill(last); } catch { /* already gone */ } }
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\nautosave: ${failures} check(s) failed` : '\nautosave: typed work survives the app being killed');
process.exit(failures ? 1 : 0);
