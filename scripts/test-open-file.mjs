// Opening a file must open the file that was asked for.
//
// Opening reads the file first and makes it the active tab afterwards, so two
// clicks in quick succession finish in whichever order the two reads happen to
// take. Click a large file and then a small one and the large one lands last,
// putting the editor on the file that was not asked for — the "it opened the
// old one again" that gets reported.
//
// A file left over from a project that has since been closed must not turn up
// in the new one either.
//
//   node scripts/test-open-file.mjs
//
// Needs a built frontend (npm run build) and backend (cd src-tauri && cargo build).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const names = process.platform === 'win32' ? ['hilbert.exe'] : ['hilbert'];
const binary = process.env.BIN || ['debug', 'release']
  .flatMap(m => names.map(name => join(root, 'src-tauri/target', m, name))).find(existsSync);
assert.ok(binary, 'Build the backend with cargo build before running this test.');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), 'hilbert-open-'));
const ws = join(dir, 'workspace');
const other = join(dir, 'elsewhere');
await mkdir(ws); await mkdir(other);
// Big enough that reading it takes visibly longer than reading the small one.
await writeFile(join(ws, 'main.typ'), '= Main\n\nThe first file.\n');
await writeFile(join(ws, 'big.typ'), `= Big\n\n${'Weighty prose that takes a while to read. '.repeat(120000)}\n`);
await writeFile(join(ws, 'small.typ'), '= Small\n\nThe file that was asked for.\n');
// Fresh ones for each race, so every case really waits on a read rather than
// switching to a tab that is already open.
for (const name of ['slow-b', 'quick-b', 'slow-c']) {
  await writeFile(join(ws, `${name}.typ`), `= ${name}\n\nA file of its own.\n`);
}
await writeFile(join(other, 'main.typ'), '= Elsewhere\n\nAnother project.\n');
await writeFile(join(dir, 'session.json'), JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
const token = 'hilbert-open-token-0123456789abcdefgh';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(Number(process.env.PORT || 3083)), TYPST_WORKSPACE: ws, TYPST_DIST: join(root, 'dist'),
    HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: join(dir, 'settings.json'),
    HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'), HILBERT_API_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bound = null;
for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });
let browser, failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
try {
  for (let i = 0; i < 200 && !bound; i++) await sleep(100);
  assert.ok(bound, 'the backend never said which port it bound');
  const origin = `http://127.0.0.1:${bound}`;
  const serving = await (await fetch(`${origin}/workspace/root`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(serving.root, ws, 'the backend answering is not the one this test started');

  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  await page.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; }, token);
  await page.goto(origin, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.view-line', { timeout: 60000 });
  await sleep(3000);

  const activeTab = () => page.evaluate(() => (document.querySelector('.tab.active')?.textContent || '').replace(/\s*×\s*$/, '').trim());
  const clickFile = name => page.evaluate(n => {
    const file = [...document.querySelectorAll('.tree-file')].find(el => el.textContent.trim().startsWith(n));
    if (!file) throw new Error(`no ${n} in the file tree`);
    file.click();
  }, name);

  // Reading `big.typ` is held up deliberately, so the two reads finish in the
  // wrong order every time rather than once in a while.
  await page.setRequestInterception(true);
  let held = 0;
  page.on('request', async request => {
    if (/\/workspace\/file(\/state)?\?path=(big|slow-b|slow-c)\.typ/.test(request.url())) { held++; await sleep(2500); }
    try { await request.continue(); } catch {}
  });

  await clickFile('big.typ');
  await sleep(200);
  await clickFile('small.typ');
  await sleep(5000);
  check('the file clicked last is the one open', await activeTab() === 'small.typ', `showing ${await activeTab()}`);
  check('the slow read did happen', held > 0, `${held} held back`);

  // The other way round, with files not opened before: the slow one is the one
  // asked for last, and it still wins once its read comes back.
  const before = held;
  await clickFile('quick-b.typ');
  await sleep(100);
  await clickFile('slow-b.typ');
  await sleep(5000);
  check('and when the slow one is asked for last', await activeTab() === 'slow-b.typ', `showing ${await activeTab()}`);
  check('that case really waited on a read', held > before, `${held - before} held back`);

  // "Open with" in Finder or Explorer: the system hands the file to the app,
  // which queues it for whichever window collects it next.
  await page.setRequestInterception(false);
  const queue = path => fetch(`${origin}/app/pending-open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ path }),
  });
  const comeToTheFront = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await clickFile('main.typ');
  await sleep(1500);
  await queue(join(ws, 'small.typ'));
  await comeToTheFront();
  await sleep(3000);
  check('a file handed over by the system opens', await activeTab() === 'small.typ', `showing ${await activeTab()}`);

  // One from another folder brings its own project with it — and a read the
  // old project started before the switch must not open a tab in the new one.
  await page.setRequestInterception(true);
  await clickFile('slow-c.typ');
  await sleep(150);
  await queue(join(other, 'main.typ'));
  await page.evaluate(() => window.__hilbertCollectFiles && window.__hilbertCollectFiles());
  await sleep(6000);
  const tabsAfterSwitch = await page.evaluate(() => [...document.querySelectorAll('.tab')].map(t => t.textContent.replace(/\s*×\s*$/, '').trim()));
  check('a read from the project left behind opens no tab in the new one', !tabsAfterSwitch.includes('slow-c.typ'), `tabs: ${tabsAfterSwitch.join(', ')}`);
  await page.setRequestInterception(false);
  const showing = await page.evaluate(() => [...document.querySelectorAll('.view-lines .view-line')].map(l => l.textContent).join(' ').replace(/\u00a0/g, ' '));
  check('a file from elsewhere opens its own project', showing.includes('Another project'), `editor shows ${JSON.stringify(showing.slice(0, 60))}`);

  // A cold start where putting the last session back hangs. Files handed over
  // meanwhile must still open, all of them and the last one in front, and the
  // restore arriving afterwards must not put the old project back over them.
  await page.close();
  const late = await browser.newPage();
  await late.setViewport({ width: 1500, height: 950 });
  await late.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; }, token);
  await late.setRequestInterception(true);
  let answeredLate = false;
  late.on('request', async request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/session') {
      // The backend does answer at once; the answer is what is held back.
      const response = await fetch(request.url(), { headers: { Authorization: `Bearer ${token}` } });
      const body = await response.text();
      await sleep(22000);
      answeredLate = true;
      try { await request.respond({ status: response.status, contentType: 'application/json', body }); } catch {}
      return;
    }
    try { await request.continue(); } catch {}
  });
  for (const name of ['quick-b', 'slow-b', 'small']) await queue(join(ws, `${name}.typ`));
  await late.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const lateTab = () => late.evaluate(() => (document.querySelector('.tab.active')?.textContent || '').replace(/\s*×\s*$/, '').trim());
  const lateTabs = () => late.evaluate(() => [...document.querySelectorAll('.tab')].map(t => t.textContent.replace(/\s*×\s*$/, '').trim()));
  let opened = '';
  for (let i = 0; i < 40 && opened !== 'small.typ'; i++) { await sleep(500); opened = await lateTab(); }
  check('files handed over open while the restore hangs', opened === 'small.typ' && !answeredLate, `showing ${opened || 'nothing'}${answeredLate ? ', but only after the restore' : ''}`);
  const all = await lateTabs();
  check('every queued file opened, not just the first', ['quick-b.typ', 'slow-b.typ', 'small.typ'].every(n => all.includes(n)), `tabs: ${all.join(', ')}`);
  const api = path => fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
  // Startup counts as over once the files are open: the session is being
  // saved again, and it names the project the files are in.
  let saved = {};
  for (let i = 0; i < 10 && saved.activePath !== 'small.typ'; i++) { await sleep(500); saved = await api('/session'); }
  check('startup finishes without the restore: the session is saved for those files', saved.activePath === 'small.typ' && !answeredLate, `session says ${saved.activePath}${answeredLate ? ', but only after the restore' : ''}`);
  for (let i = 0; i < 60 && !answeredLate; i++) await sleep(500);
  await sleep(3000);
  check('the late restore leaves them in front', answeredLate && await lateTab() === 'small.typ', `showing ${await lateTab()}`);
  await late.close();

  // This time the restore gets as far as asking to change project, and that
  // request is what hangs — held before the backend sees it, for longer than
  // any grace period. The file opens meanwhile, and when the request finally
  // arrives the backend must refuse it rather than move the project back.
  // A closing window saves its session on the way out, so wait for that to
  // settle before planting the one this case restores.
  await sleep(1500);
  await fetch(`${origin}/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ workspacePath: other, openPaths: ['main.typ'], activePath: 'main.typ' }),
  });
  assert.equal((await api('/session')).workspacePath, other, 'the session to restore did not stick');
  const stuck = await browser.newPage();
  await stuck.setViewport({ width: 1500, height: 950 });
  await stuck.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; }, token);
  await stuck.setRequestInterception(true);
  let switchedLate = false;
  stuck.on('request', async request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/workspace/root' && !switchedLate) {
      await sleep(30000);
      const response = await fetch(request.url(), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: request.postData() });
      const body = await response.text();
      switchedLate = true;
      try { await request.respond({ status: response.status, contentType: 'application/json', body }); } catch {}
      return;
    }
    try { await request.continue(); } catch {}
  });
  await queue(join(ws, 'quick-b.typ'));
  await stuck.goto(origin, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const stuckTab = () => stuck.evaluate(() => (document.querySelector('.tab.active')?.textContent || '').replace(/\s*×\s*$/, '').trim());
  let front = '';
  for (let i = 0; i < 50 && front !== 'quick-b.typ'; i++) { await sleep(500); front = await stuckTab(); }
  check('a file opens while the project change hangs', front === 'quick-b.typ' && !switchedLate, `showing ${front || 'nothing'}`);
  for (let i = 0; i < 60 && !switchedLate; i++) await sleep(500);
  await sleep(3000);
  check('and is still in front once the change arrives', switchedLate && await stuckTab() === 'quick-b.typ', `showing ${await stuckTab()}`);
  const rootNow = (await api('/workspace/root')).root;
  const same = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
  check('in its own project, not the one the restore asked for', same(rootNow, ws), rootNow);
  let resaved = {};
  for (let i = 0; i < 20 && !same(resaved.workspacePath || '', ws); i++) { await sleep(500); resaved = await api('/session'); }
  check('and the saved session names that project too', same(resaved.workspacePath || '', ws) && resaved.activePath === 'quick-b.typ', `${resaved.workspacePath} / ${resaved.activePath}`);
} catch (error) {
  failures++;
  console.error(error.message);
} finally {
  await browser?.close().catch(() => {});
  server.kill(); await sleep(300); server.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\nopen file: ${failures} check(s) failed` : '\nopen file: the file asked for is the file that opens');
process.exit(failures ? 1 : 0);
