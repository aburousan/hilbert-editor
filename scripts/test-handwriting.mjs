// Write Maths by Hand, and the handwriting model inside Draw a Symbol.
//
//   INK_DIR=~/somewhere INK_SAMPLES=~/somewhere node scripts/test-handwriting.mjs
//
// INK_DIR keeps the downloaded model between runs (it is downloaded into it on
// the first run, through the app's own Download button). INK_SAMPLES is a
// folder with ref40.json (40 MathWriting test inks with what Python
// onnxruntime reads for each) and symbols-raw/*.inkml; MathWriting is CC
// BY-NC-SA, so the samples are not kept in this repository. Without them the
// reading checks are skipped and only the rest runs.
//
// Checks: nothing about the model is fetched until asked for; the page never
// talks to any other host; the backend serves only its fixed files, signed in;
// the app reads exactly what Python onnxruntime reads; ink drawn on the pad is
// read, previewed by compiling, and inserted; Draw a Symbol uses the model.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const binary = process.env.BIN || ['release', 'debug']
  .map(m => join(root, 'src-tauri/target', m, process.platform === 'win32' ? 'hilbert.exe' : 'hilbert')).find(existsSync);
assert.ok(binary, 'Build the backend with cargo build before running this test.');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const samples = process.env.INK_SAMPLES;
const haveSamples = samples && existsSync(join(samples, 'ref40.json'));

const dir = await mkdtemp(join(tmpdir(), 'hilbert-handwriting-'));
const ws = join(dir, 'ws');
await mkdir(ws);
await writeFile(join(ws, 'main.typ'), '= Handwriting\n\n');
const inkDir = process.env.INK_DIR || join(dir, 'ink');
const token = 'hilbert-handwriting-token-0123456789ab';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(process.env.PORT || 3543), TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
    HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: join(dir, 'settings.json'), HILBERT_INK_DIR: inkDir,
    HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'), HILBERT_API_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bound = null;
for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });

let browser, failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

// The reader and converter on their own, for comparing with Python exactly.
const entry = join(dir, 'ink-entry.ts');
await writeFile(entry, `import { InkReader } from ${JSON.stringify(join(root, 'src/ink/reader.ts'))};
import { tokensToTypst } from ${JSON.stringify(join(root, 'src/ink/ink2typst.ts'))};
(window as any).__ink = { InkReader, tokensToTypst };`);
const { build } = await import('rolldown');
const bundle = (await build({ input: entry, write: false, output: { format: 'iife' }, logLevel: 'silent' })).output[0].code;

try {
  for (let i = 0; i < 300 && !bound; i++) await sleep(100);
  assert.ok(bound, 'backend did not start');
  const base = `http://127.0.0.1:${bound}`;

  // The backend side.
  const status = await fetch(`${base}/ink/status`).then(r => r.status);
  check('the model endpoints need signing in', status === 401, `status ${status}`);
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  for (const name of ['..%2Fsettings.json', 'settings.json', 'encoder.onnx.bak', '%2Fetc%2Fpasswd']) {
    const code = await fetch(`${base}/ink/file/${name}`, auth).then(r => r.status);
    check(`only the model's own files are served (${decodeURIComponent(name)})`, code === 404, `status ${code}`);
  }

  browser = await puppeteer.launch({ args: ['--no-sandbox'], protocolTimeout: 600000 });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setCookie({ name: 'hilbert_session', value: token, domain: '127.0.0.1', path: '/' });
  const external = [], modelFetches = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) && !['data:', 'blob:'].includes(url.protocol)) external.push(url.href);
    if (url.pathname.startsWith('/ink/file/')) modelFetches.push(url.pathname);
  });
  page.on('pageerror', e => console.log('  page error:', e.message));
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.view-line', { timeout: 60000 });
  // The cursor at the end of the document, where the formula will go.
  await page.click('.view-lines');
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(mod); await page.keyboard.press(process.platform === 'darwin' ? 'ArrowDown' : 'End'); await page.keyboard.up(mod);
  const installedAtStart = (await page.evaluate(async () => (await fetch('/ink/status')).json())).installed;

  const openInsertItem = async text => {
    await page.evaluate(() => [...document.querySelectorAll('.menu-item, .menu-title, [class*="menu"]')].find(e => e.textContent.trim() === 'Insert')?.click());
    await sleep(200);
    const clicked = await page.evaluate(t => { const item = [...document.querySelectorAll('.dropdown-item')].find(e => e.textContent.startsWith(t)); item?.click(); return !!item; }, text);
    assert.ok(clicked, `Insert menu item "${text}" not found`);
  };
  const closeModal = async () => { await page.keyboard.press('Escape'); await sleep(300); };

  // Draw a Symbol before anything is installed: the matcher alone, nothing fetched.
  if (!installedAtStart) {
    await openInsertItem('Draw a Symbol');
    await page.waitForSelector('.modal-content canvas');
    await sleep(1500);
    check('Draw a Symbol without the model fetches nothing of it', modelFetches.length === 0, modelFetches.join(' '));
    await closeModal();
    await openInsertItem('Write Maths by Hand');
    await page.waitForFunction(() => /Download the model/.test(document.querySelector('.modal-content')?.innerText || ''), { timeout: 20000 });
    const offer = await page.evaluate(() => document.querySelector('.modal-content').innerText);
    check('the pad offers the download with its size and licence', /about \d+ MB/.test(offer) && /CC BY-NC-SA/.test(offer) && /Noncommercial/.test(offer));
    check('nothing is fetched before the person asks', modelFetches.length === 0, modelFetches.join(' '));
    await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent.startsWith('Download the model')).click());
  } else {
    console.log('  (model already in INK_DIR: the before-download checks are skipped)');
    await openInsertItem('Write Maths by Hand');
  }
  await page.waitForSelector('.modal-content canvas', { timeout: 600000 });
  check('the model downloads, checks out and starts', true);
  const files = readdirSync(inkDir).sort().join(' ');
  check('exactly the six expected files are kept', files === 'decoder.onnx encoder.onnx ort-wasm-simd-threaded.mjs ort-wasm-simd-threaded.wasm ort.wasm.min.js vocab.json', files);

  // Draws strokes on a canvas, fitted into its middle, keeping their shape.
  const draw = async (selector, strokes, fill = 0.8) => {
    const box = await (await page.$(selector)).boundingBox();
    const pts = strokes.flat();
    const [minX, maxX] = [Math.min(...pts.map(p => p[0])), Math.max(...pts.map(p => p[0]))];
    const [minY, maxY] = [Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[1]))];
    const scale = fill * Math.min(box.width / Math.max(maxX - minX, 1), box.height / Math.max(maxY - minY, 1));
    const ox = box.x + (box.width - (maxX - minX) * scale) / 2, oy = box.y + (box.height - (maxY - minY) * scale) / 2;
    for (const s of strokes) {
      const at = p => [ox + (p[0] - minX) * scale, oy + (p[1] - minY) * scale];
      await page.mouse.move(...at(s[0])); await page.mouse.down();
      for (const p of s.slice(1)) await page.mouse.move(...at(p));
      await page.mouse.up();
    }
  };

  if (haveSamples) {
    const ref = JSON.parse(readFileSync(join(samples, 'ref40.json'), 'utf8'));
    // 1. The same strokes through the app's reader and through Python onnxruntime.
    await page.addScriptTag({ content: bundle });
    const ours = await page.evaluate(async inks => {
      const reader = await window.__ink.InkReader.open();
      const out = [];
      for (const strokes of inks) out.push((await reader.read(strokes)).flat());
      await reader.close();
      return out;
    }, ref.map(r => r.strokes));
    const same = ref.filter((r, i) => JSON.stringify(ours[i]) === JSON.stringify(r.python)).length;
    check('the app reads exactly what Python onnxruntime reads', same === ref.length, `${same}/${ref.length} the same`);
    ref.forEach((r, i) => { if (JSON.stringify(ours[i]) !== JSON.stringify(r.python)) console.log(`     #${r.index}: python ${r.python.join(' ')} | app ${ours[i].join(' ')}`); });

    // 2. Drawn on the pad with the mouse: read, previewed, inserted.
    let readSame = 0, previewed = 0;
    const tried = ref.slice(0, 8);
    for (const r of tried) {
      await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent === 'Clear').click());
      await draw('.modal-content canvas', r.strokes);
      await page.waitForFunction(() => document.querySelector('.modal-content textarea')?.value.trim(), { timeout: 60000 }).catch(() => {});
      await page.waitForFunction(() => !/Reading…/.test(document.querySelector('.modal-content').innerText), { timeout: 60000 });
      const expected = (await page.evaluate(t => window.__ink.tokensToTypst(t), r.python)) ?? '';
      const code = await page.evaluate(() => document.querySelector('.modal-content textarea').value);
      if (code === expected) readSame++;
      const shown = await page.waitForFunction(() => document.querySelector('.modal-content img[alt="Preview"]') || /error|compile/i.test(document.querySelector('.modal-content').innerText), { timeout: 30000 }).then(() => true).catch(() => false);
      if (shown && await page.$('.modal-content img[alt="Preview"]')) previewed++;
    }
    // Mouse positions are whole pixels, so a close call can go the other way.
    check('ink drawn on the pad is read as the reference reads it', readSame >= tried.length - 2, `${readSame}/${tried.length}`);
    check('every reading is previewed by compiling it', previewed === tried.length, `${previewed}/${tried.length}`);
    const code = await page.evaluate(() => document.querySelector('.modal-content textarea').value);
    await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent === 'Insert').click());
    // Autosave writes it; read what reached the file.
    const wanted = `$ ${code} $`;
    const saved = await page.waitForFunction(async w => (await (await fetch('/workspace/file?path=main.typ')).text()).includes(w), { timeout: 20000 }, wanted).then(() => true).catch(() => false);
    const text = await page.evaluate(async () => (await fetch('/workspace/file?path=main.typ')).text());
    check('Insert puts it in the document as an equation, after the heading', saved && text.startsWith('= Handwriting'), JSON.stringify(text.slice(0, 160)));

    // 3. Draw a Symbol with the model on: real handwritten ∫, ≤ and θ.
    const decode = s => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    const inks = readdirSync(join(samples, 'symbols-raw')).filter(f => f.endsWith('.inkml')).map(f => {
      const xml = readFileSync(join(samples, 'symbols-raw', f), 'utf8');
      return { label: decode(/<annotation type="label">([^<]*)</.exec(xml)[1]),
        strokes: [...xml.matchAll(/<trace[^>]*>([^<]*)<\/trace>/g)].map(m => m[1].trim().split(',').map(p => p.trim().split(/\s+/).map(Number))) };
    });
    await openInsertItem('Draw a Symbol');
    await page.waitForFunction(() => /Handwriting model on/.test(document.querySelector('.modal-content')?.innerText || ''), { timeout: 60000 });
    check('Draw a Symbol starts the model when it is installed', true);
    const want = { '\\int': 'integral', '\\le': '<=', '\\leq': '<=', '\\ge': '>=', '\\theta': 'theta', '\\sum': 'sum', '\\alpha': 'alpha',
      '\\infty': 'infinity', '\\partial': 'partial', '\\pi': 'pi', '\\lambda': 'lambda', '\\mu': 'mu', '\\sigma': 'sigma', '\\Delta': 'Delta',
      '\\nabla': 'nabla', '\\pm': '±', '\\times': '×', '\\in': '∈', '\\forall': '∀', '\\exists': '∃', '\\rightarrow': '->', '\\neq': '!=' };
    let top = 0, offered = 0, tried2 = 0;
    for (const ink of inks.filter(i => want[i.label]).slice(0, 10)) {
      tried2++;
      await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent.trim() === 'Clear').click());
      await draw('.modal-content canvas', ink.strokes, 0.7);
      await sleep(1500);
      const names = await page.evaluate(() => [...document.querySelectorAll('.modal-content button[title^="Insert"]')].map(b => b.title.replace(/^Insert\s+/, '')));
      if (names[0] === want[ink.label]) top++;
      if (names.slice(0, 5).includes(want[ink.label])) offered++;
      console.log(`     ${ink.label.padEnd(9)} → ${names.slice(0, 4).join(', ')}`);
    }
    check('Draw a Symbol with the model: right symbol among the first five', offered >= tried2 - 2, `${offered}/${tried2} (first: ${top}/${tried2})`);
    await closeModal();

    // 4. Memory: the model is let go each time the pad closes. WebAssembly
    // memory is not in the JS heap, so the browser's whole process tree is
    // measured. Closing while the model is still starting must not keep it.
    const cdp = await page.createCDPSession();
    const rss = () => {
      const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
      const tree = new Set([browser.process().pid]);
      for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true; } }
      return rows.filter(([pid]) => tree.has(pid)).reduce((a, r) => a + r[2], 0) / 1024;
    };
    const rounds = [];
    for (let round = 0; round < 6; round++) {
      await openInsertItem('Write Maths by Hand');
      await page.waitForSelector('.modal-content canvas', { timeout: 60000 });
      await draw('.modal-content canvas', ref[round].strokes);
      await page.waitForFunction(() => document.querySelector('.modal-content textarea')?.value.trim(), { timeout: 60000 }).catch(() => {});
      await closeModal();
      if (round >= 2) for (let quick = 0; quick < 2; quick++) { await openInsertItem('Write Maths by Hand'); await sleep(150); await closeModal(); }
      await sleep(1500);
      await cdp.send('HeapProfiler.collectGarbage');
      await sleep(500);
      rounds.push(Math.round(rss()));
    }
    // The first rounds grow the WebAssembly memory once; after that it is reused.
    const growth = rounds[rounds.length - 1] - rounds[1];
    check('opening and closing the pad does not keep growing memory', growth < 120, `MB after each round: ${rounds.join(', ')}`);
  } else {
    console.log('  (no INK_SAMPLES: the reading checks are skipped)');
    await closeModal();
  }

  check('the page never talked to another host', external.length === 0, external.slice(0, 3).join(' '));
} finally {
  await browser?.close();
  server.kill();
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nhandwriting: all checks passed');
process.exit(failures ? 1 : 0);
