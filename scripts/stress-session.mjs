// Stress test: a long, busy editing session against the release backend.
//
// Phase "desktop": one window, a large three-file project compiling every
// 100 ms. Random fast typing at the end of random lines in all three files,
// typing-then-backspacing, file switching, preview scrolling, a file the
// document #reads changing on disk every few seconds, and exports. Every typed
// phrase is unique, so at the end each file on disk must equal its original
// with exactly those phrases appended to exactly those lines. Memory, worker
// count and preview timings are sampled throughout.
//
// Phase "hosted": hilbert --serve with several signed-in browsers typing at
// once, each in its own file and all of them in one shared file.
//
//   MINUTES=20 node scripts/stress-session.mjs desktop
//   MINUTES=8 BROWSERS=4 node scripts/stress-session.mjs hosted
//
// Needs a built frontend and a release backend.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const phase = process.argv[2] || 'desktop';
const BIN = process.env.BIN || ['release', 'debug']
  .map(m => join(root, 'src-tauri/target', m, process.platform === 'win32' ? 'hilbert.exe' : 'hilbert')).find(existsSync);
const DIST = process.env.TYPST_DIST || join(root, 'dist');
const MINUTES = Number(process.env.MINUTES || 20);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = n => Math.floor(Math.random() * n);
const pick = a => a[rand(a.length)];
const words = 'alpha beta gamma delta photon lepton quark gluon metric tensor scalar spinor field wave flux energy'.split(' ');
let serial = 0;
const phrase = tag => ` ${tag}${++serial}q ${Array.from({ length: 2 + rand(4) }, () => pick(words)).join(' ')}`;
const failures = [];
const missedInput = [];
const fail = (what, detail = '') => { failures.push(`${what} ${detail}`); console.log(`  FAIL ${what} ${detail}`); };
const rssMb = pid => {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh']).toString();
      return Number((/"([\d,.]+) K"/.exec(out)?.[1] || '').replace(/[,.]/g, '')) / 1024 || NaN;
    }
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024;
  } catch { return NaN; }
};
const childrenRss = pid => {
  if (process.platform === 'win32') return NaN;
  try {
    const kids = execFileSync('pgrep', ['-P', String(pid)]).toString().trim().split('\n').filter(Boolean);
    return kids.reduce((n, k) => n + (rssMb(k) || 0) + childrenRss(k), 0);
  } catch { return 0; }
};
const median = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? Math.round(b[b.length >> 1]) : NaN; };

const FILES = {
  'main.typ': { prefix: 'Paragraph', count: 1200 },
  'alpha.typ': { prefix: 'Alpha', count: 300 },
  'beta.typ': { prefix: 'Beta', count: 300 },
};
const body = (prefix, count) => Array.from({ length: count }, (_, i) =>
  `${prefix} ${i + 1}. Text with $x_${i % 9} + sqrt(${(i % 7) + 1})$ and _emphasis_ and #strong[markup] to keep the compiler busy.`).join('\n\n');
const original = {
  'main.typ': `#set page(paper: "a4")\n\n= Stress\n\nData: #read("data.txt")\n\n${body('Paragraph', 1200)}\n\n#include "alpha.typ"\n\n#include "beta.typ"\n`,
  'alpha.typ': `== Alpha\n\n${body('Alpha', 300)}\n`,
  'beta.typ': `== Beta\n\n${body('Beta', 300)}\n`,
};

// What each file must hold at the end: its original, with each typed phrase
// appended, in order, to the line it was typed on.
const appended = { 'main.typ': new Map(), 'alpha.typ': new Map(), 'beta.typ': new Map() };
const expected = file => original[file].split('\n').map(line => {
  const m = /^(\w+) (\d+)\. /.exec(line);
  const key = m && `${m[1]} ${m[2]}`;
  return key && appended[file].has(key) ? line + appended[file].get(key).join('') : line;
}).join('\n');

async function startBackend(ws, dir, extra = [], env = {}) {
  const port = 3700 + rand(200);
  const token = 'stress-token-0123456789abcdef0123456789';
  const child = spawn(BIN, extra.length ? extra : ['--headless'], {
    env: { ...process.env, PORT: String(port), TYPST_WORKSPACE: ws, TYPST_DIST: DIST, HILBERT_API_TOKEN: token,
      HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: join(dir, 'settings.json'),
      HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '', bound = null;
  for (const s of [child.stdout, child.stderr]) s.on('data', d => {
    log = (log + d).slice(-20000);
    bound ??= Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null;
  });
  for (let i = 0; i < 300 && !bound; i++) await sleep(50);
  if (!bound) throw new Error(`backend did not start:\n${log}`);
  return { child, origin: `http://127.0.0.1:${bound}`, token, log: () => log };
}

const conflictShown = page => page.evaluate(() => /File changed outside Hilbert/.test(document.body.innerText));
// A tree entry can carry a MAIN badge and a close button after the name.
const openFile = (page, name) => page.evaluate(n => [...document.querySelectorAll('.tree-file')].find(e => e.textContent.trim().startsWith(n))?.click(), name);

// Click a visible line of the given kind, go to its end, type a phrase fast.
async function typeOnALine(page, file, tag, backspace) {
  const { prefix } = FILES[file];
  // Move the editor somewhere new first.
  const keys = rand(3);
  for (let i = 0; i < keys; i++) await page.keyboard.press(pick(['PageDown', 'PageUp']));
  await sleep(120);
  const target = await page.evaluate(p => {
    const lines = [...document.querySelectorAll('.view-line')]
      .map(e => ({ e, t: e.innerText.replace(/ /g, ' ') }))
      .filter(x => new RegExp(`^${p} \\d+\\. `).test(x.t));
    if (!lines.length) return null;
    const x = lines[Math.floor(Math.random() * lines.length)];
    const r = x.e.getBoundingClientRect();
    return { key: /^(\w+ \d+)\./.exec(x.t)[1], x: r.left + Math.min(r.width - 10, 150), y: r.top + r.height / 2 };
  }, prefix);
  if (!target) return false;
  await page.mouse.click(target.x, target.y);
  await sleep(60);
  // Lines wrap in the editor; a second End goes from the end of the screen row
  // to the end of the line itself.
  await page.keyboard.press('End');
  await page.keyboard.press('End');
  const text = phrase(tag);
  await page.keyboard.type(text, { delay: 12 + rand(30) });
  if (backspace) {
    await page.keyboard.type('zzzz', { delay: 15 });
    for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
  }
  // Did the phrase reach the editor? If not, the keystrokes went astray in the
  // test, not in Hilbert, and it is not counted.
  const marker = text.trim().split(' ')[0];
  // Long lines wrap, so the phrase can sit on the line's second screen row:
  // look in the whole editor. The comparison at the end checks the exact line.
  const landed = await page.evaluate(m => (document.querySelector('.view-lines')?.innerText || '').includes(m), marker);
  if (!landed) { missedInput.push(`${marker} on ${target.key}`); return false; }
  if (!appended[file].has(target.key)) appended[file].set(target.key, []);
  appended[file].get(target.key).push(text);
  return true;
}

async function desktop() {
  const dir = await mkdtemp(join(tmpdir(), 'hilbert-stress-'));
  const ws = join(dir, 'ws');
  await mkdir(ws);
  for (const [f, t] of Object.entries(original)) await writeFile(join(ws, f), t);
  await writeFile(join(ws, 'data.txt'), 'version 0');
  await writeFile(join(dir, 'session.json'), JSON.stringify({ workspacePath: ws, openPaths: Object.keys(FILES), activePath: 'main.typ', mainFile: 'main.typ' }));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ compileDelay: 100, proofreading: false }));
  const be = await startBackend(ws, dir);
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--js-flags=--expose-gc'] });
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 200)));
    await page.setViewport({ width: 1500, height: 950 });
    await page.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; localStorage.setItem('export_fmt', 'typ'); }, be.token);
    await page.goto(be.origin, { waitUntil: 'networkidle2', timeout: 120000 });
    await page.waitForSelector('.view-line', { timeout: 90000 });
    await page.waitForSelector('.pdf-page canvas', { timeout: 120000 });
    await sleep(3000);
    await page.evaluate(() => {
      window.__downloads = [];
      const original = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.download) window.__downloads.push([this.download, this.href]); else original.call(this); };
      const revoke = URL.revokeObjectURL; URL.revokeObjectURL = u => setTimeout(() => revoke(u), 30000);
    });

    const end = Date.now() + MINUTES * 60000;
    let active = 'main.typ', nextSample = 0, nextData = Date.now() + 5000, nextExport = Date.now() + 90000, dataVersion = 0;
    const samples = [], counts = { typed: 0, switches: 0, exports: 0, external: 0, scrolls: 0 };
    while (Date.now() < end) {
      if (Date.now() >= nextSample) {
        await page.evaluate(() => window.gc?.());
        const m = await page.metrics();
        const workers = page.workers().length;
        const timings = await page.evaluate(() => (window.__hilbertPreviewTimings || []).slice(-30));
        const s = {
          min: ((Date.now() - (end - MINUTES * 60000)) / 60000).toFixed(1),
          backendMb: Math.round(rssMb(be.child.pid)), childrenMb: Math.round(childrenRss(be.child.pid)),
          heapMb: Math.round(m.JSHeapUsedSize / 1048576), nodes: m.Nodes, workers,
          load: median(timings.map(t => t.load)), draw: median(timings.map(t => t.draw)), redraws: timings.length,
        };
        samples.push(s);
        console.log(`  t=${s.min}m backend ${s.backendMb} MB, typst+tinymist ${s.childrenMb} MB, heap ${s.heapMb} MB, DOM ${s.nodes}, workers ${s.workers}, load ${s.load} ms, draw ${s.draw} ms (${s.redraws} redraws), typed ${counts.typed}`);
        nextSample = Date.now() + 30000;
      }
      if (Date.now() >= nextData) {
        await writeFile(join(ws, 'data.txt'), `version ${++dataVersion}`);
        counts.external++;
        nextData = Date.now() + 4000 + rand(4000);
      }
      if (Date.now() >= nextExport) {
        await sleep(400);
        await page.evaluate(() => [...document.querySelectorAll('.menu-bar > div')].find(e => e.textContent.trim().startsWith('File'))?.click());
        await sleep(200);
        await page.evaluate(() => [...document.querySelectorAll('.dropdown-item')].find(e => e.textContent.includes('Save As / Export'))?.click());
        await page.waitForSelector('.modal-content input', { timeout: 10000 }).catch(() => {});
        const before = await page.evaluate(() => window.__downloads.length);
        await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent.trim() === 'Typst')?.click());
        await sleep(100);
        await page.evaluate(() => [...document.querySelectorAll('.modal-content button')].find(b => b.textContent.startsWith('Save '))?.click());
        let got = null;
        for (let i = 0; i < 60 && got === null; i++) {
          await sleep(100);
          got = await page.evaluate(async n => { const d = window.__downloads[n]; return d ? await (await fetch(d[1])).text() : null; }, before);
        }
        const disk = await readFile(join(ws, 'main.typ'), 'utf8');
        if (got === null) fail('export produced nothing');
        else if (got !== disk) fail('export differs from the saved main file');
        else if (got !== expected('main.typ')) fail('export misses typed text', `(${got.length} vs ${expected('main.typ').length} chars)`);
        counts.exports++;
        await page.evaluate(() => [...document.querySelectorAll('.modal-content')].find(m => m.querySelector('h2')?.textContent === 'Export')?.querySelector('.close-btn')?.click());
        await sleep(200);
        nextExport = Date.now() + 90000 + rand(60000);
      }
      const roll = rand(100);
      if (roll < 70) {
        if (await typeOnALine(page, active, active[0].toUpperCase(), rand(4) === 0)) counts.typed++;
        await sleep(rand(3) === 0 ? 50 : 300 + rand(900));
      } else if (roll < 85) {
        active = pick(Object.keys(FILES).filter(f => f !== active));
        await openFile(page, active);
        await sleep(300);
        counts.switches++;
      } else {
        await page.evaluate(() => { const s = document.querySelector('.pdf-scroll'); if (s) s.scrollTop = Math.random() * s.scrollHeight; });
        await sleep(200);
        counts.scrolls++;
      }
      if (await conflictShown(page)) { fail('a "changed outside Hilbert" prompt appeared during the session'); break; }
    }

    // Let the last saves land, then compare every file with what was typed.
    await sleep(4000);
    for (const f of Object.keys(FILES)) {
      const disk = await readFile(join(ws, f), 'utf8');
      const want = expected(f);
      if (disk !== want) {
        const a = disk.split('\n'), b = want.split('\n');
        const i = a.findIndex((l, n) => l !== b[n]);
        fail(`${f} on disk differs from what was typed`, `first difference at line ${i + 1}:\n    disk: ${JSON.stringify(a[i])}\n    want: ${JSON.stringify(b[i])}`);
        // Where did the missing phrases go?
        const all = Object.fromEntries(await Promise.all(Object.keys(FILES).map(async g => [g, await readFile(join(ws, g), 'utf8')])));
        for (const phrases of appended[f].values()) for (const p of phrases) {
          const m = p.trim().split(' ')[0];
          if (!disk.includes(m)) console.log(`    ${m} (typed in ${f}) is ${Object.entries(all).filter(([, t]) => t.includes(m)).map(([g]) => `in ${g}`).join(', ') || 'in no file'}`);
        }
      }
    }
    const first = samples[1] || samples[0], last = samples[samples.length - 1];
    if (missedInput.length) console.log(`  ${missedInput.length} phrase(s) did not show in the editor after typing (test input, not counted): ${missedInput.slice(0, 5).join(', ')}`);
    console.log(`\n  ${counts.typed} phrases typed, ${counts.switches} file switches, ${counts.scrolls} preview scrolls, ${counts.exports} exports, ${counts.external} outside changes to data.txt`);
    console.log(`  memory from t=${first.min}m to t=${last.min}m: backend ${first.backendMb} -> ${last.backendMb} MB, typst+tinymist ${first.childrenMb} -> ${last.childrenMb} MB, heap ${first.heapMb} -> ${last.heapMb} MB, DOM ${first.nodes} -> ${last.nodes}`);
    console.log(`  workers: ${[...new Set(samples.map(s => s.workers))].join(', ')}; preview load median ${median(samples.map(s => s.load))} ms, draw ${median(samples.map(s => s.draw))} ms`);
    if (new Set(samples.slice(1).map(s => s.workers)).size > 1) fail('the number of workers changed during the session', samples.map(s => s.workers).join(','));
    if (last.heapMb > first.heapMb * 2 + 50) fail('page heap kept growing', `${first.heapMb} -> ${last.heapMb} MB`);
    if (last.backendMb > first.backendMb * 2 + 100) fail('backend memory kept growing', `${first.backendMb} -> ${last.backendMb} MB`);
    if (errors.length) fail(`${errors.length} page error(s)`, [...new Set(errors)].slice(0, 5).join(' | '));
  } finally {
    await browser.close().catch(() => {});
    be.child.kill('SIGKILL');
    await sleep(300);
    if (!failures.length) await rm(dir, { recursive: true, force: true });
    else console.log(`  kept ${dir} for a look`);
  }
}

async function hosted() {
  const BROWSERS = Number(process.env.BROWSERS || 3);
  const dir = await mkdtemp(join(tmpdir(), 'hilbert-stress-hosted-'));
  const ws = join(dir, 'ws');
  await mkdir(ws);
  const own = Array.from({ length: BROWSERS }, (_, i) => `own${i + 1}.typ`);
  const ownText = name => `= ${name}\n\n${Array.from({ length: 60 }, (_, i) => `Line ${i + 1}. Some text here.`).join('\n\n')}\n`;
  for (const f of own) await writeFile(join(ws, f), ownText(f));
  const sharedOriginal = `= Shared\n\n${Array.from({ length: 80 }, (_, i) => `Shared ${i + 1}. Everyone types here.`).join('\n\n')}\n`;
  await writeFile(join(ws, 'shared.typ'), sharedOriginal);
  await writeFile(join(ws, 'main.typ'), `= Hosted\n\n${own.map(f => `#include "${f}"`).join('\n\n')}\n\n#include "shared.typ"\n`);
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ compileDelay: 100, proofreading: false }));
  const secret = 'stress-hosted-secret-0123456789abcdef0123456789ab';
  const be = await startBackend(ws, dir, ['--serve', '--port', String(3900 + rand(90)), '--workspace', ws], { HILBERT_SERVER_TOKEN: secret, ALLOW_CODE_EXECUTION: '0' });
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const typedOwn = Object.fromEntries(own.map(f => [f, []])), typedShared = [];
  const errors = [];
  try {
    const pages = [];
    for (let i = 0; i < BROWSERS; i++) {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      page.on('pageerror', e => errors.push(String(e.message || e).slice(0, 200)));
      await page.setViewport({ width: 1400, height: 900 });
      await page.goto(be.origin, { waitUntil: 'networkidle2' });
      await page.type('#token', secret);
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}), page.click('button[type="submit"]')]);
      await page.waitForSelector('.view-line', { timeout: 60000 });
      pages.push(page);
    }
    await sleep(3000);
    const end = Date.now() + MINUTES * 60000;
    const counts = { own: 0, shared: 0 };
    // Each browser takes turns: a while in its own file, a while in the shared one.
    await Promise.all(pages.map(async (page, i) => {
      let where = own[i];
      await openFile(page, where);
      await sleep(800);
      while (Date.now() < end) {
        if (rand(6) === 0) { where = where === 'shared.typ' ? own[i] : 'shared.typ'; await openFile(page, where); await sleep(800); }
        const prefix = where === 'shared.typ' ? 'Shared' : 'Line';
        const target = await page.evaluate(p => {
          const lines = [...document.querySelectorAll('.view-line')].map(e => ({ e, t: e.innerText.replace(/ /g, ' ') })).filter(x => new RegExp(`^${p} \\d+\\. `).test(x.t));
          if (!lines.length) return null;
          const x = lines[Math.floor(Math.random() * lines.length)]; const r = x.e.getBoundingClientRect();
          return { x: r.left + Math.min(r.width - 10, 120), y: r.top + r.height / 2 };
        }, prefix);
        if (!target) { await sleep(300); continue; }
        await page.mouse.click(target.x, target.y);
        await page.keyboard.press('End');
        await page.keyboard.press('End');
        const text = phrase(`B${i + 1}${where === 'shared.typ' ? 's' : 'o'}`);
        await page.keyboard.type(text, { delay: 20 + rand(30) });
        const marker = text.trim().split(' ')[0];
        await sleep(150);
        const landed = await page.evaluate(m => (document.querySelector('.view-lines')?.innerText || '').includes(m), marker);
        if (!landed) { missedInput.push(`${marker} in ${where}`); continue; }
        (where === 'shared.typ' ? typedShared : typedOwn[where]).push(marker);
        counts[where === 'shared.typ' ? 'shared' : 'own']++;
        if (await conflictShown(page)) { fail(`browser ${i + 1}: a "changed outside Hilbert" prompt appeared`); return; }
        await sleep(400 + rand(1200));
      }
    }));
    await sleep(6000);
    const check = (text, tokens, name) => {
      const missing = tokens.filter(t => text.split(t).length - 1 !== 1);
      if (missing.length) fail(`${name}: ${missing.length} of ${tokens.length} typed phrases missing or doubled`, missing.slice(0, 5).join(' '));
    };
    for (const f of own) check(await readFile(join(ws, f), 'utf8'), typedOwn[f], f);
    const shared = await readFile(join(ws, 'shared.typ'), 'utf8');
    check(shared, typedShared, 'shared.typ');
    const lost = sharedOriginal.split('\n').filter(l => l && !shared.split('\n').some(s => s.startsWith(l.replace(/ Everyone types here\.$/, ''))));
    if (lost.length) fail('shared.typ lost original lines', lost.slice(0, 3).join(' | '));
    if (missedInput.length) console.log(`  ${missedInput.length} phrase(s) did not show in the editor after typing (test input, not counted): ${missedInput.slice(0, 5).join(', ')}`);
    console.log(`\n  ${BROWSERS} browsers: ${counts.own} phrases in their own files, ${counts.shared} in the shared file`);
    console.log(`  backend ${Math.round(rssMb(be.child.pid))} MB at the end`);
    if (errors.length) fail(`${errors.length} page error(s)`, [...new Set(errors)].slice(0, 5).join(' | '));
  } finally {
    await browser.close().catch(() => {});
    be.child.kill('SIGKILL');
    await sleep(300);
    if (!failures.length) await rm(dir, { recursive: true, force: true });
    else console.log(`  kept ${dir} for a look`);
  }
}

try {
  await (phase === 'hosted' ? hosted() : desktop());
} catch (error) {
  fail('crashed', String(error?.stack || error).slice(0, 800));
}
console.log(failures.length ? `\nstress ${phase}: ${failures.length} problem(s)` : `\nstress ${phase}: no problems`);
process.exit(failures.length ? 1 : 0);
