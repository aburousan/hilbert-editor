// Does a long editing session grow without bound?
//
// The preview holds page bitmaps, the editor holds a Monaco model per open
// file, and the proofreader holds its findings. Each of those is meant to be
// let go of again, and a leak in any of them shows up not as a crash but as a
// machine that gets slower the longer it is used — the hardest kind of report
// to act on later.
//
// So a session is run here in miniature: a long document scrolled end to end
// several times, files opened and closed, dialogs opened and closed, with the
// heap read after a forced collection each round and the backend's own resident
// memory read from the OS. What matters is not the number but the slope.
//
//   node scripts/test-memory-soak.mjs
//
// Needs a built frontend (npm run build) and backend (cd src-tauri && cargo build).
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const exe = process.platform === 'win32' ? 'typst-editor.exe' : 'typst-editor';
const binary = process.env.BIN || ['debug', 'release']
  .map(mode => join(root, 'src-tauri/target', mode, exe)).find(existsSync);
assert.ok(binary, 'Build the backend with cargo build before running this test.');

const PAGES = 40;
const ROUNDS = 6;
const dir = await mkdtemp(join(tmpdir(), 'hilbert-soak-'));
const ws = join(dir, 'workspace');
await mkdir(ws);
const session = join(dir, 'session.json');
const settings = join(dir, 'settings.json');

const body = i => `= Chapter ${i + 1}\n\nSome prose about $integral_0^infinity e^(-x^2) dif x = sqrt(pi)/2$ and a\nfew more sentances to give the proofreader something to chew on.\n\n$ cal(L) = -1/4 F_(mu nu) F^(mu nu) + macron(psi)(i gamma^mu D_mu - m)psi $\n`;
await writeFile(join(ws, 'main.typ'), Array.from({ length: PAGES },
  (_, i) => `${body(i)}${i < PAGES - 1 ? '#pagebreak()' : ''}`).join('\n'));
for (const name of ['one', 'two', 'three'])
  await writeFile(join(ws, `${name}.typ`), Array.from({ length: 8 }, (_, i) => body(i)).join('\n'));
await writeFile(session, JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
// Proofreading on: it is one of the things that holds state across a session.
await writeFile(settings, JSON.stringify({ proofreading: true }));

const token = 'hilbert-soak-token-0123456789abcdef';
const port = Number(process.env.PORT || 3098);
const origin = `http://127.0.0.1:${port}`;
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(port), TYPST_WORKSPACE: ws, TYPST_DIST: join(root, 'dist'),
    HILBERT_SESSION_FILE: session, HILBERT_SETTINGS_FILE: settings, HILBERT_API_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
for (const stream of [server.stdout, server.stderr]) stream.on('data', d => { logs = (logs + d).slice(-8000); });
const pause = ms => new Promise(r => setTimeout(r, ms));
const rssMb = pid => {
  try { return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024; }
  catch { return NaN; }
};

let browser;
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw new Error(`Backend exited:\n${logs}`);
    try {
      const r = await fetch(`${origin}/workspace/root`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
      if (r.ok) { ready = true; break; }
    } catch { /* still binding */ }
    await pause(100);
  }
  assert.ok(ready, `Backend did not start:\n${logs}`);

  browser = await puppeteer.launch({ args: ['--no-sandbox', '--js-flags=--expose-gc'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; }, token);
  await page.goto(origin, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.view-line');
  await page.waitForFunction(n => document.querySelectorAll('.pdf-page').length === n, { timeout: 90000 }, PAGES);
  await page.waitForSelector('.pdf-page canvas');
  await pause(4000);

  const settle = async () => {
    await page.evaluate(() => window.gc?.());
    await pause(400);
    await page.evaluate(() => window.gc?.());
    await pause(200);
  };

  const sample = async () => {
    await settle();
    const m = await page.metrics();
    const dom = await page.evaluate(() => ({
      canvases: document.querySelectorAll('.pdf-page canvas').length,
      bitmapMb: [...document.querySelectorAll('.pdf-page canvas')].reduce((n, c) => n + c.width * c.height * 4, 0) / 1048576,
      textLayers: [...document.querySelectorAll('.pdf-page .textLayer')].filter(l => l.childElementCount > 0).length,
    }));
    return { heapMb: m.JSHeapUsedSize / 1048576, nodes: m.Nodes, listeners: m.JSEventListeners, ...dom, backendMb: rssMb(server.pid) };
  };

  const rounds = [];
  for (let round = 0; round < ROUNDS; round++) {
    // Scroll the whole document, both ways.
    for (const indices of [[...Array(PAGES).keys()], [...Array(PAGES).keys()].reverse()])
      for (const i of indices.filter((_, n) => n % 4 === 0)) {
        await page.evaluate(index => {
          const scroller = document.querySelector('.pdf-scroll');
          scroller.scrollTop = document.querySelectorAll('.pdf-page')[index].offsetTop;
        }, i);
        await pause(60);
      }
    // Open the other files and come back, so models are created and discarded.
    for (const name of ['one.typ', 'two.typ', 'three.typ', 'main.typ']) {
      await page.evaluate(n => {
        const file = [...document.querySelectorAll('.tree-file')].find(el => el.textContent.includes(n));
        file?.click();
      }, name);
      await pause(500);
    }
    // Type a little, so the editor and the proofreader both do work.
    await page.click('.view-line');
    await page.keyboard.type('A sentance with a delibrate misteak. ', { delay: 8 });
    await pause(900);
    rounds.push(await sample());
    console.log(`  round ${round + 1}: heap ${rounds.at(-1).heapMb.toFixed(1)} MB, ` +
      `bitmaps ${rounds.at(-1).canvases} (${rounds.at(-1).bitmapMb.toFixed(1)} MB), ` +
      `DOM nodes ${rounds.at(-1).nodes}, listeners ${rounds.at(-1).listeners}, backend ${rounds.at(-1).backendMb.toFixed(0)} MB`);
  }

  // The first rounds warm caches up; the slope after that is what a long
  // session actually costs.
  const base = rounds[1], last = rounds.at(-1);
  const grew = (a, b) => ((b - a) / Math.max(a, 1)) * 100;
  console.log(`\nfrom round 2 to round ${ROUNDS}:`);
  console.log(`  JS heap    ${base.heapMb.toFixed(1)} -> ${last.heapMb.toFixed(1)} MB  (${grew(base.heapMb, last.heapMb).toFixed(0)}%)`);
  console.log(`  DOM nodes  ${base.nodes} -> ${last.nodes}  (${grew(base.nodes, last.nodes).toFixed(0)}%)`);
  console.log(`  listeners  ${base.listeners} -> ${last.listeners}  (${grew(base.listeners, last.listeners).toFixed(0)}%)`);
  console.log(`  backend    ${base.backendMb.toFixed(0)} -> ${last.backendMb.toFixed(0)} MB  (${grew(base.backendMb, last.backendMb).toFixed(0)}%)`);

  assert.ok(last.canvases <= 8, `Distant page bitmaps must be released (${last.canvases} still held).`);
  assert.ok(last.bitmapMb < 120, `Retained bitmaps must stay bounded (${last.bitmapMb.toFixed(0)} MB).`);
  assert.ok(grew(base.heapMb, last.heapMb) < 60, `JS heap grew ${grew(base.heapMb, last.heapMb).toFixed(0)}% over ${ROUNDS - 1} rounds.`);
  assert.ok(grew(base.nodes, last.nodes) < 50, `DOM nodes grew ${grew(base.nodes, last.nodes).toFixed(0)}%.`);
  assert.ok(grew(base.listeners, last.listeners) < 50, `Event listeners grew ${grew(base.listeners, last.listeners).toFixed(0)}%.`);
  assert.ok(grew(base.backendMb, last.backendMb) < 50, `Backend memory grew ${grew(base.backendMb, last.backendMb).toFixed(0)}%.`);
  console.log('\nno unbounded growth over the session');
} finally {
  await browser?.close();
  if (server.exitCode === null) server.kill();
  await pause(400);
  if (server.exitCode === null) server.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
}
