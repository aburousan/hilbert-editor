// A fixed error must leave the Problems list on its own (issue #38).
//
// tinymist can take longer to re-check a long document than the backend waits
// for it, and the answer the editor got then was the old error list. Nothing
// asked again until the next keystroke, so the red stayed after the mistake was
// fixed. This makes a mistake in a long document, fixes it, touches nothing
// more, and times how long "No problems" takes to come back.
//
//   node scripts/test-problems-clear.mjs
//
// Needs a built frontend and backend, typst and tinymist.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const binary = process.env.BIN || ['debug', 'release']
  .map(m => join(root, 'src-tauri/target', m, process.platform === 'win32' ? 'hilbert.exe' : 'hilbert')).find(existsSync);
assert.ok(binary, 'Build the backend with cargo build before running this test.');
try { execFileSync('tinymist', ['--version'], { stdio: 'ignore' }); } catch {
  console.log('problems clear: tinymist is not installed here, nothing to check');
  process.exit(0);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

const dir = await mkdtemp(join(tmpdir(), 'hilbert-problems-'));
const ws = join(dir, 'workspace');
await mkdir(ws);
// Long and full of maths, so a re-check takes tinymist a while.
const body = Array.from({ length: Number(process.env.PARAGRAPHS || 2500) }, (_, i) =>
  `Paragraph ${i + 1} with $integral_0^oo e^(-${i % 9} x^2) dif x = sqrt(pi) / 2$ and #strong[bold] text.`).join('\n\n');
await writeFile(join(ws, 'main.typ'), `#set page(paper: "a4")\n\n= Problems\n\nThe last line.\n\n${body}\n`);
await writeFile(join(dir, 'session.json'), JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
await writeFile(join(dir, 'settings.json'), JSON.stringify({ compileDelay: Number(process.env.DELAY || 4000), proofreading: false }));
const token = 'hilbert-problems-token-0123456789abcd';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(process.env.PORT || 3441), TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
    HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: join(dir, 'settings.json'),
    HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'), HILBERT_API_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bound = null;
for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });

let browser, failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const panel = page => page.evaluate(() => (document.querySelector('.problems-list')?.textContent || '').replace(/\u00a0/g, ' '));
try {
  for (let i = 0; i < 300 && !bound; i++) await sleep(50);
  assert.ok(bound, 'the backend never said which port it bound');
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  await page.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; }, token);
  await page.goto(`http://127.0.0.1:${bound}`, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.view-line', { timeout: 60000 });
  for (let i = 0; i < 300 && !/No problems/.test(await panel(page)); i++) await sleep(100);
  check('a clean document starts with no problems', /No problems/.test(await panel(page)));

  const rounds = Number(process.env.ROUNDS || 3);
  const times = [];
  for (let round = 0; round < rounds; round++) {
    // A mistake on the line "The last line.": an unknown function. Back to the
    // top first, in case the session opened the file further down.
    await page.click('.view-lines');
    await page.keyboard.down(mod); await page.keyboard.press('Home'); await page.keyboard.up(mod);
    await sleep(300);
    const line = await page.evaluate(() => {
      // Monaco draws spaces as non-breaking ones.
      const el = [...document.querySelectorAll('.view-line')].find(e => e.textContent.replace(/\u00a0/g, ' ').includes('The last line.'));
      const r = el.getBoundingClientRect();
      return { x: r.left + 4, y: r.top + r.height / 2 };
    });
    await page.mouse.click(line.x, line.y);
    await page.keyboard.press('Home');
    const typo = `#nosuchfunction${round}() `;
    await page.keyboard.type(typo, { delay: 25 });
    let red = false;
    for (let i = 0; i < 200 && !red; i++) { red = /nosuchfunction|unknown variable/i.test(await panel(page)); if (!red) await sleep(100); }
    if (!red) { check(`round ${round + 1}: the mistake is reported`, false); continue; }
    // Let the compile run on the broken text too, so the error on screen is
    // the compiler's and not only tinymist's.
    let compiled = false;
    for (let i = 0; i < 200 && !compiled; i++) { compiled = /Typst compiler/.test(await panel(page)); if (!compiled) await sleep(100); }
    if (!compiled) { check(`round ${round + 1}: the compiler reports the mistake`, false); continue; }
    await sleep(500);
    // The fix, then hands off.
    await page.keyboard.press('Home');
    for (let i = 0; i < typo.length; i++) await page.keyboard.press('Delete');
    const fixed = Date.now();
    let green = false;
    for (let i = 0; i < 200 && !green; i++) { green = /No problems/.test(await panel(page)); if (!green) await sleep(50); }
    times.push(green ? Date.now() - fixed : Infinity);
    await sleep(1000);
  }
  const worst = Math.max(...times);
  // The compile delay is 4 s here: clearing well inside it means tinymist's
  // check of the fixed text did it, not the next compile.
  check('a fixed mistake clears without waiting for the next compile', times.length === rounds && worst < 2500,
    times.map(t => (Number.isFinite(t) ? `${t} ms` : 'never (10 s)')).join(', ') + ' (compile delay 4000 ms)');

  // tinymist slower than the backend waits for it: the first answer after the
  // fix is the old error list, marked as not belonging to the new text. The
  // editor must go on and fetch the set that does.
  let fakeNext = false, faked = 0;
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (fakeNext && request.method() === 'POST' && new URL(request.url()).pathname === '/lsp/diagnostics'
      && !JSON.parse(request.postData() || '{}').after) {
      fakeNext = false; faked++;
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
        available: true, fresh: false, revision: 0, pending: false,
        diagnostics: [{ range: { start: { line: 4, character: 0 }, end: { line: 4, character: 10 } }, severity: 1, message: 'unknown variable: nosuchfunction (stale)' }],
      }) });
    }
    request.continue().catch(() => {});
  });
  const line = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.view-line')].find(e => e.textContent.replace(/\u00a0/g, ' ').includes('The last line.'));
    const r = el.getBoundingClientRect(); return { x: r.left + 4, y: r.top + r.height / 2 };
  });
  await page.mouse.click(line.x, line.y);
  await page.keyboard.press('Home');
  await page.keyboard.type('#nosuchfunction9() ', { delay: 25 });
  for (let i = 0; i < 200 && !/nosuchfunction/i.test(await panel(page)); i++) await sleep(100);
  await sleep(1500);
  fakeNext = true;
  await page.keyboard.press('Home');
  for (let i = 0; i < '#nosuchfunction9() '.length; i++) await page.keyboard.press('Delete');
  const t0 = Date.now();
  let cleared = false;
  // Well inside the 4 s compile delay, so only the follow-up can clear it.
  for (let i = 0; i < 60 && !cleared; i++) { cleared = /No problems/.test(await panel(page)); if (!cleared) await sleep(50); }
  check('an answer older than the text is followed up, not left on screen', faked === 1 && cleared,
    `${faked} stale answer given, ${cleared ? `cleared after ${Date.now() - t0} ms` : 'still red after 3 s'}`);
} catch (error) {
  failures++;
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\nproblems clear: ${failures} check(s) failed` : '\nproblems clear: fixed mistakes clear on their own');
process.exit(failures ? 1 : 0);
