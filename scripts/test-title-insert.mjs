// Insert → Title Block must produce a document that has a title.
//
// It used to write the title out by hand as centred bold text. That looks like
// a title and is not one: the PDF carries no title in its metadata, so a reader
// shows the file name in its window, screen readers have nothing to announce,
// and exporting to PDF/UA fails, which requires one. Typst has `#set document`
// for the metadata and `#title()` to put that same title on the page.
//
// This drives the dialog in the running app, then compiles what it wrote and
// reads the title back out of the PDF.
//
//   node scripts/test-title-insert.mjs
//
// Needs a built frontend, a built backend, and typst on PATH.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
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

const dir = await mkdtemp(join(tmpdir(), 'hilbert-title-'));
const ws = join(dir, 'workspace');
await mkdir(ws);
await writeFile(join(ws, 'main.typ'), '');
await writeFile(join(dir, 'session.json'), JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
const token = 'hilbert-title-token-0123456789abcdefg';
const port = Number(process.env.PORT || 3088);
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(port), TYPST_WORKSPACE: ws, TYPST_DIST: join(root, 'dist'),
    HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: join(dir, 'settings.json'),
    HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'), HILBERT_API_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
// The backend takes another port when the one asked for is busy, so the port it
// reports is the one to talk to; guessing can reach a server left over from an
// earlier run, which is serving a different project.
let bound = null;
for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });
let browser;
let failures = 0;
try {
  for (let i = 0; i < 200 && !bound; i++) await sleep(100);
  assert.ok(bound, 'the backend never said which port it bound');
  var origin = `http://127.0.0.1:${bound}`;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${origin}/workspace/root`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(800) })).ok) break; } catch {}
    await sleep(100);
  }
  const serving = await (await fetch(`${origin}/workspace/root`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(serving.root, ws, 'the backend answering is not the one this test started');
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  await page.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; }, token);
  await page.goto(origin, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.view-line', { timeout: 60000 });
  await sleep(2500);

  // Insert → Title Block, filled in as a person would.
  await page.keyboard.down('Control'); await page.keyboard.press('KeyK'); await page.keyboard.up('Control');
  await page.waitForSelector('.palette-input');
  await page.type('.palette-input', 'Title Block');
  await sleep(500);
  await page.evaluate(() => [...document.querySelectorAll('.palette-item')].find(el => /title block/i.test(el.textContent))?.click());
  await page.waitForSelector('.modal-content input', { timeout: 15000 });
  const values = ['Interstellar Mail Delivery', 'Kazi Abu Rousan', 'kazi@example.org', 'Institute of Physics'];
  // Set through the native setter, the way React reads a controlled input.
  await page.evaluate((values) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    document.querySelectorAll('.modal-content input').forEach((input, i) => {
      if (i >= values.length) return;
      setter.call(input, values[i]);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }, values);
  await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => /insert|ok|add/i.test(b.textContent))?.click());
  await sleep(1500);

  const written = await page.evaluate(() => [...document.querySelectorAll('.view-lines .view-line')]
    .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
    .map(l => l.textContent.replace(/ /g, ' ')).join('\n'));
  console.log('written into the document:');
  console.log(written.split('\n').map(l => '  | ' + l).join('\n'));

  // What the editor shows is what is on disk; compile that.
  await sleep(1500);
  const source = await readFile(join(ws, 'main.typ'), 'utf8');
  if (!source.includes('Interstellar Mail Delivery')) {
    console.log('file on disk:\n' + source.split('\n').map(l => '  > ' + l).join('\n'));
    assert.fail('the title was not written to the file');
  }

  const check = (name, ok) => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`); };
  check('sets the document title', /#set document\(title: \[Interstellar Mail Delivery\]/.test(source));
  check('names the author in the metadata', /author:\s*\("Kazi Abu Rousan",?\)/.test(source));
  check('puts the title on the page with #title()', source.includes('#title()'));
  check('keeps the affiliation and the email', source.includes('Institute of Physics') && source.includes('mailto:kazi@example.org'));

  // The source saying `#title()` is not the same as a title on the page: the
  // preview has to show it.
  const onThePage = await page.evaluate(async () => {
    for (let i = 0; i < 120; i++) {
      const text = [...document.querySelectorAll('.pdf-page .textLayer span')].map(s => s.textContent).join(' ');
      if (text.includes('Interstellar Mail Delivery')) return true;
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  });
  check('the preview draws the title on the page', onThePage);

  execFileSync('typst', ['compile', '--diagnostic-format', 'short', join(ws, 'main.typ'), join(dir, 'out.pdf')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const pdf = await readFile(join(dir, 'out.pdf'));
  const info = /\/Title\s*\(([^)]*)\)/.exec(pdf.toString('latin1').split('/Creator(Typst').map((p, i, a) => i === a.length - 1 ? p : a[i] + '/Creator(Typst').join('')) ;
  const hasTitle = pdf.includes('dc:title') && pdf.toString('latin1').includes('Interstellar Mail Delivery');
  check('compiles, and the PDF carries the title', hasTitle && !!info);
} catch (error) {
  failures++;
  console.error(error.message);
} finally {
  await browser?.close().catch(() => {});
  server.kill(); await sleep(300); server.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\ntitle insert: ${failures} check(s) failed` : '\ntitle insert: the document says what it is called');
process.exit(failures ? 1 : 0);
