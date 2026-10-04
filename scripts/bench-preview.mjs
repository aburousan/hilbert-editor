// How long an edit takes to reach the preview, and where the time goes.
//
// Types into documents of three sizes and reports, per edit, the time from the
// keystroke to the page being redrawn, broken into: the auto-compile delay and
// typing, saving, the compile request, the preview's wait for a pause in the
// typing, pdf.js reading the PDF, and drawing. Medians over several edits.
//
//   node scripts/bench-preview.mjs                 (sizes 20, 400, 2000)
//   DELAY=100 SIZES=400 EDITS=12 node scripts/bench-preview.mjs
//
// Needs a built frontend and backend (a release build for real numbers).
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const binary = process.env.BIN || ['release', 'debug']
  .map(m => join(root, 'src-tauri/target', m, process.platform === 'win32' ? 'hilbert.exe' : 'hilbert')).find(existsSync);
const sizes = (process.env.SIZES || '20,400,2000').split(',').map(Number);
const edits = Number(process.env.EDITS || 12);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { const b = [...a].sort((x, y) => x - y); return b.length ? Math.round(b[b.length >> 1]) : NaN; };

for (const size of sizes) {
  const dir = await mkdtemp(join(tmpdir(), 'hilbert-bench-preview-'));
  const ws = join(dir, 'ws');
  await mkdir(ws);
  const body = Array.from({ length: size }, (_, i) =>
    `Paragraph ${i + 1} with $integral_0^oo e^(-${i % 9} x^2) dif x$ and #strong[bold] text.`).join('\n\n');
  await writeFile(join(ws, 'main.typ'), `= Bench\n\nStart here.\n\n${body}\n`);
  await writeFile(join(dir, 's.json'), JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
  await writeFile(join(dir, 'set.json'), JSON.stringify({ compileDelay: Number(process.env.DELAY || 100), proofreading: false }));
  const token = 'hilbert-bench-preview-token-0123456789';
  const server = spawn(binary, ['--headless'], {
    env: { ...process.env, PORT: String(process.env.PORT || 3601), TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
      HILBERT_API_TOKEN: token, HILBERT_SESSION_FILE: join(dir, 's.json'), HILBERT_SETTINGS_FILE: join(dir, 'set.json'),
      HILBERT_RECOVERY_DIR: join(dir, 'r'), HILBERT_HISTORY_DIR: join(dir, 'h') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bound = null;
  for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });
  for (let i = 0; i < 300 && !bound; i++) await sleep(50);
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1500, height: 950 });
    await page.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; }, token);
    await page.goto(`http://127.0.0.1:${bound}`, { waitUntil: 'networkidle2', timeout: 90000 });
    await page.waitForSelector('.pdf-page canvas', { timeout: 90000 });
    await sleep(3000);
    const at = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.view-line')].find(e => e.textContent.replace(/ /g, ' ').includes('Start here.'));
      const r = el.getBoundingClientRect();
      return { x: r.left + 20, y: r.top + r.height / 2 };
    });
    await page.mouse.click(at.x, at.y);
    await sleep(300);
    await page.keyboard.press('End');
    await sleep(300);
    const rows = [];
    for (let i = 0; i < edits; i++) {
      const before = await page.evaluate(() => {
        window.__benchKey = performance.now();
        return ((window).__hilbertPreviewTimings || []).length;
      });
      await page.keyboard.type(` e${i}`, { delay: 15 });
      let got = null;
      for (let k = 0; k < 600 && !got; k++) {
        got = await page.evaluate(n => {
          const p = ((window).__hilbertPreviewTimings || []);
          if (p.length <= n) return null;
          const preview = p.at(-1);
          const compile = ((window).__hilbertCompileTimings || []).filter(c => c.at > window.__benchKey).at(0);
          return { preview, compile, key: window.__benchKey };
        }, before);
        if (!got) await sleep(5);
      }
      if (got?.compile) {
        const { preview, compile, key } = got;
        const saveStart = compile.at - compile.compile - compile.save;
        rows.push({
          total: preview.at - key,
          delay: saveStart - key,
          save: compile.save,
          compile: compile.compile,
          wait: preview.wait,
          load: preview.load,
          draw: preview.draw,
        });
      }
      await sleep(1500);
    }
    const col = k => median(rows.map(r => r[k]));
    console.log(`${String(size).padStart(5)} paragraphs (${rows.length} edits): keystroke→drawn ${col('total')} ms = delay+typing ${col('delay')} · save ${col('save')} · compile ${col('compile')} · wait ${col('wait')} · load ${col('load')} · draw ${col('draw')}`);
  } finally {
    await browser.close().catch(() => {});
    server.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
}
