// Write Maths by Hand: the handwriting model, its dialog and single symbols.
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
// read, previewed by compiling, and inserted; single handwritten symbols are read.
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

  if (!installedAtStart) {
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
    // The model runs in a worker (issue #45); where a worker cannot start it
    // runs on the page instead, and must read the same there.
    const readAll = (where, inks) => page.evaluate(async (where, inks) => {
      const reader = await window.__ink.InkReader.open(where);
      const out = [];
      for (const strokes of inks) out.push((await reader.read(strokes)).flat());
      await reader.close();
      return { out, where: reader.where };
    }, where, inks);
    const { out: ours, where } = await readAll('worker', ref.map(r => r.strokes));
    check('the model runs in a worker', where === 'worker', where);
    const same = ref.filter((r, i) => JSON.stringify(ours[i]) === JSON.stringify(r.python)).length;
    check('the app reads exactly what Python onnxruntime reads', same === ref.length, `${same}/${ref.length} the same`);
    ref.forEach((r, i) => { if (JSON.stringify(ours[i]) !== JSON.stringify(r.python)) console.log(`     #${r.index}: python ${r.python.join(' ')} | app ${ours[i].join(' ')}`); });
    const onPage = await readAll('page', ref.slice(0, 10).map(r => r.strokes));
    const samePage = ref.slice(0, 10).filter((r, i) => JSON.stringify(onPage.out[i]) === JSON.stringify(r.python)).length;
    check('on the page (no worker) it reads the same', onPage.where === 'page' && samePage === 10, `${samePage}/10, ${onPage.where}`);

    // While the longest ink is read, the page itself stays free for the pen:
    // its longest task, with the model in a worker and on the page.
    const longest = [...ref].sort((a, b) => b.strokes.flat().length - a.strokes.flat().length)[0];
    const busy = where => page.evaluate(async (where, strokes) => {
      const reader = await window.__ink.InkReader.open(where);
      const tasks = [];
      const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(e => e.duration)));
      observer.observe({ type: 'longtask' });
      const start = performance.now();
      await reader.read(strokes);
      const took = performance.now() - start;
      await new Promise(r => setTimeout(r, 50));
      observer.disconnect(); await reader.close();
      return { took, longest: Math.max(0, ...tasks), count: tasks.length };
    }, where, longest.strokes);
    const [inWorker, inPage] = [await busy('worker'), await busy('page')];
    console.log(`     longest ink (${longest.strokes.flat().length} points): worker read ${Math.round(inWorker.took)} ms, longest page task ${Math.round(inWorker.longest)} ms; ` +
      `on the page read ${Math.round(inPage.took)} ms, longest task ${Math.round(inPage.longest)} ms (${inPage.count} over 50 ms)`);
    check('reading a long formula never holds the page up (pen input stays smooth)', inWorker.longest < 50, `longest task ${Math.round(inWorker.longest)} ms`);

    // 2. Drawn on the pad with the mouse: read, previewed, inserted.
    let readSame = 0, previewed = 0;
    const tried = ref.slice(0, 8);
    // Where the pad is: it must not move as results and previews come and go (issue #45).
    const padAt = () => page.evaluate(() => { const r = document.querySelector('.modal-content canvas').getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`; });
    const padPlaces = new Set([await padAt()]);
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
      padPlaces.add(await padAt());
    }
    check('the pad stays where it is while readings and previews change', padPlaces.size === 1, [...padPlaces].join(' | '));
    // Mouse positions are whole pixels, so a close call can go the other way.
    check('ink drawn on the pad is read as the reference reads it', readSame >= tried.length - 2, `${readSame}/${tried.length}`);
    check('every reading is previewed by compiling it', previewed === tried.length, `${previewed}/${tried.length}`);

    // 2b. Pictures: handwriting drawn as a picture (black pen on white, like a
    // photo of a page) through the picture button, a typeset formula pasted,
    // and one picture dropped on the pad. Each is traced, read and previewed.
    const picture = (strokes, pen = 3) => page.evaluate((strokes, pen) => {
      const pts = strokes.flat(), pad = 30;
      const [x0, y0] = [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1]))];
      const [w, h] = [Math.max(...pts.map(p => p[0])) - x0, Math.max(...pts.map(p => p[1])) - y0];
      const k = 160 / Math.max(1, h), c = document.createElement('canvas');
      c.width = Math.round(w * k) + 2 * pad; c.height = Math.round(h * k) + 2 * pad;
      const g = c.getContext('2d'); g.fillStyle = 'white'; g.fillRect(0, 0, c.width, c.height);
      g.strokeStyle = 'black'; g.lineWidth = pen; g.lineCap = g.lineJoin = 'round';
      for (const s of strokes) { g.beginPath(); s.forEach(([x, y], i) => (i ? g.lineTo : g.moveTo).call(g, (x - x0) * k + pad, (y - y0) * k + pad)); if (s.length === 1) g.lineTo((s[0][0] - x0) * k + pad + .5, (s[0][1] - y0) * k + pad); g.stroke(); }
      return c.toDataURL('image/png');
    }, strokes, pen);
    const readNow = async () => {
      await page.waitForFunction(() => /Read from a picture|No writing found|Could not read/.test(document.querySelector('.modal-content').innerText), { timeout: 30000 });
      await page.waitForFunction(() => !/Reading…/.test(document.querySelector('.modal-content').innerText) && document.querySelector('.modal-content textarea')?.value.trim(), { timeout: 60000 }).catch(() => {});
      await page.waitForFunction(() => !/Reading…/.test(document.querySelector('.modal-content').innerText), { timeout: 60000 });
      return page.evaluate(() => ({ code: document.querySelector('.modal-content textarea').value, note: document.querySelector('.modal-content').innerText.match(/Read from a picture[^\n]*|No writing found[^\n]*|Could not read[^\n]*/)?.[0] || '' }));
    };
    const deliver = (how, dataUrl) => page.evaluate(async (how, dataUrl) => {
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], 'maths.png', { type: 'image/png' }), dt = new DataTransfer();
      dt.items.add(file);
      [...document.querySelectorAll('.modal-content button')].find(b => b.textContent === 'Clear').click();
      if (how === 'button') { const input = document.querySelector('.modal-content input[type=file]'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); }
      if (how === 'paste') document.querySelector('.modal-content textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      if (how === 'drop') { const c = document.querySelector('.modal-content canvas'); c.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); c.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }
    }, how, dataUrl);
    let pictureSame = 0, pictureRead = 0;
    const pics = ref.slice(10, 16);
    for (const r of pics) {
      await deliver('button', await picture(r.strokes));
      const got = await readNow();
      if (got.code.trim()) pictureRead++;
      const expected = (await page.evaluate(t => window.__ink.tokensToTypst(t), r.python)) ?? '';
      if (got.code === expected) pictureSame++;
      console.log(`     picture #${r.index}: ${got.code === expected ? 'same ' : 'other'} ${got.code.slice(0, 60)}`);
    }
    check('a picture of handwriting is traced and read', pictureRead === pics.length, `${pictureRead}/${pics.length} read, ${pictureSame} the same as the pen strokes`);
    // A typeset formula, rendered by Typst, pasted from the clipboard.
    const typeset = await page.evaluate(async () => {
      const r = await fetch('/render/snippet', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '#set page(width: auto, height: auto, margin: 12pt, fill: white)\n#set text(size: 28pt)\n$ x^2 + y^2 = 1 $' });
      const b = await r.blob(); return await new Promise(res => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsDataURL(b); });
    });
    await deliver('paste', typeset);
    const pasted = await readNow();
    console.log(`     pasted typeset x^2 + y^2 = 1 → ${pasted.code}`);
    check('a pasted picture is read (typeset x² + y² = 1)', /x\^2\s*\+\s*y\^2\s*=\s*1/.test(pasted.code.replace(/\s+/g, ' ')), pasted.code);
    await deliver('drop', await picture(ref[16].strokes));
    const dropped = await readNow();
    check('a dropped picture is read', !!dropped.code.trim() && /Read from a picture/.test(dropped.note), dropped.code.slice(0, 60));
    // A blank picture says so instead of reading nothing.
    await deliver('button', await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 300; c.height = 100; const g = c.getContext('2d'); g.fillStyle = 'white'; g.fillRect(0, 0, 300, 100); return c.toDataURL('image/png'); }));
    await page.waitForFunction(() => /No writing found/.test(document.querySelector('.modal-content').innerText), { timeout: 20000 }).then(() => check('a blank picture says no writing was found', true)).catch(() => check('a blank picture says no writing was found', false));
    // Back to a drawn formula for the insert below.
    await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent === 'Clear').click());
    await draw('.modal-content canvas', tried[tried.length - 1].strokes);
    await page.waitForFunction(() => document.querySelector('.modal-content textarea')?.value.trim(), { timeout: 60000 });
    await page.waitForFunction(() => !/Reading…/.test(document.querySelector('.modal-content').innerText), { timeout: 60000 });
    const code = await page.evaluate(() => document.querySelector('.modal-content textarea').value);
    await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent === 'Insert').click());
    // Autosave writes it; read what reached the file.
    const wanted = `$ ${code} $`;
    const saved = await page.waitForFunction(async w => (await (await fetch('/workspace/file?path=main.typ')).text()).includes(w), { timeout: 20000 }, wanted).then(() => true).catch(() => false);
    const text = await page.evaluate(async () => (await fetch('/workspace/file?path=main.typ')).text());
    check('Insert puts it in the document as an equation, after the heading', saved && text.startsWith('= Handwriting'), JSON.stringify(text.slice(0, 160)));

    // 3. One symbol on its own (what Draw a Symbol used to do): real
    // handwritten ∫, ≤, θ, ∇ and others, read on the same pad.
    const decode = s => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    const inks = readdirSync(join(samples, 'symbols-raw')).filter(f => f.endsWith('.inkml')).map(f => {
      const xml = readFileSync(join(samples, 'symbols-raw', f), 'utf8');
      return { label: decode(/<annotation type="label">([^<]*)</.exec(xml)[1]),
        strokes: [...xml.matchAll(/<trace[^>]*>([^<]*)<\/trace>/g)].map(m => m[1].trim().split(',').map(p => p.trim().split(/\s+/).map(Number))) };
    });
    await openInsertItem('Write Maths by Hand');
    await page.waitForSelector('.modal-content canvas', { timeout: 60000 });
    const symbolInks = inks.filter(i => /^\\[A-Za-z]+$/.test(i.label)).slice(0, 12);
    let symbolsRead = 0, symbolsOffered = 0;
    for (const ink of symbolInks) {
      await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent.trim() === 'Clear').click());
      await draw('.modal-content canvas', ink.strokes, 0.7);
      await page.waitForFunction(() => document.querySelector('.modal-content textarea')?.value.trim(), { timeout: 60000 }).catch(() => {});
      await page.waitForFunction(() => !/Reading…/.test(document.querySelector('.modal-content').innerText), { timeout: 60000 });
      await sleep(300);
      const got = await page.evaluate(() => document.querySelector('.modal-content textarea').value.trim());
      const offered = await page.evaluate(() => [...document.querySelectorAll('.modal-content button[title^="Insert  "]')].map(b => b.title.slice(8)));
      const expected = await page.evaluate(t => window.__ink.tokensToTypst([t]), ink.label);
      if (got === expected) symbolsRead++;
      if (got === expected || offered.includes(expected)) symbolsOffered++;
      console.log(`     ${ink.label.padEnd(10)} → ${got}${offered.length ? `   choices: ${offered.join(' ')}` : ''}${got === expected || offered.includes(expected) ? '' : `   (expected ${expected})`}`);
    }
    check('a single handwritten symbol is read, or offered among the choices', symbolInks.length > 0 && symbolsOffered >= symbolInks.length - 2, `${symbolsOffered}/${symbolInks.length} (read first time: ${symbolsRead})`);
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
