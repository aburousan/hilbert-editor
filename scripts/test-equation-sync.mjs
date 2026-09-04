// Double-clicking a numbered equation in the PDF must land on the equation the
// PDF numbered.
//
// The obvious way to resolve "(2)" is to jump to the second `$ … $` in the
// file. That assumes every block equation is numbered, and papers are full of
// ones that are not — a derivation step, an aside, anything under
// `#set math.equation(numbering: none)`. The count then runs ahead of the
// numbering and the jump lands several equations early, which is subtle enough
// to look like the feature simply being unreliable.
//
// The fixture has two unnumbered block equations before the numbered one, so
// the equation printed as (2) is the fourth `$ … $` in the file, three hundred
// lines below the second. Counting dollars lands on the wrong one; asking
// Typst what it printed lands on the right one.
//
//   node scripts/test-equation-sync.mjs
//
// Needs a built frontend (npm run build) and backend (cd src-tauri && cargo build).
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const TOKEN = 'equation-sync-token-0123456789abcdef';
const PORT = Number(process.env.PORT || 3098);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const binary = ['target/release/typst-editor', 'target/debug/typst-editor']
  .map(p => join(root, 'src-tauri', p)).find(existsSync);
if (!binary) {
  console.error('No backend binary. Run: cd src-tauri && cargo build');
  process.exit(2);
}
if (!existsSync(join(root, 'dist/index.html'))) {
  console.error('No built frontend. Run: npm run build');
  process.exit(2);
}

const dir = await mkdtemp(join(tmpdir(), 'hilbert-eqsync-'));
const home = join(dir, 'home');
const ws = join(dir, 'ws');
for (const d of [join(home, 'Library/Application Support/hilbert'), join(home, '.config/hilbert'), ws]) {
  await mkdir(d, { recursive: true });
}

// A document shaped like a paper: numbered equations spread through it, two
// early ones the document does not number, and every formula built from the
// same handful of symbols. Both parts matter. The unnumbered pair puts the
// printed number and the count of `$ … $` out of step, and the shared symbols
// stop the surrounding words from resolving the click on their own, so the
// printed number is the only thing that can.
const EQUATIONS = 8;
const unnumbered = body => `#[\n  #set math.equation(numbering: none)\n  $ ${body} $\n]\n`;
const filler = n => Array.from({ length: 14 }, (_, i) =>
  `Paragraph ${n}.${i}, discussing zeta and xi and pi at length so that no two\nequations are ever on screen together.`).join('\n\n');

let doc = `#set math.equation(numbering: "(1)")\n\n= Equations, some of them numbered\n\n`;
doc += unnumbered('zeta = xi + 1') + '\n' + unnumbered('zeta = xi + 2') + '\n';
for (let n = 1; n <= EQUATIONS; n++) {
  doc += `${filler(n)}\n\n$ zeta_${n} = xi^2/(3 pi^2) + ${n} $ <eq:e${n}>\n\n`;
}
await writeFile(join(ws, 'main.typ'), doc);
const lines = doc.split('\n');
// Which source line each numbered equation is on, and what it is numbered.
const targets = [];
for (let n = 1; n <= EQUATIONS; n++) {
  targets.push({ number: n, line: lines.findIndex(l => l.includes(`zeta_${n} =`)) + 1 });
}
const decoyLine = lines.findIndex(l => l.includes('zeta = xi + 2')) + 1;

const session = JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' });
const sessionFile = join(home, 'Library/Application Support/hilbert/session.json');
await writeFile(sessionFile, session);
await writeFile(join(home, '.config/hilbert/session.json'), session);

const server = spawn(binary, ['--headless'], {
  env: { ...process.env, HOME: home, TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
         HILBERT_SESSION_FILE: sessionFile, HILBERT_API_TOKEN: TOKEN, PORT: String(PORT) },
  stdio: 'ignore',
});

let browser;
const cleanup = async () => {
  try { await browser?.close(); } catch {}
  server.kill();
  try { await once(server, 'exit'); } catch {}
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(dir, { recursive: true, force: true }); return; } catch { await sleep(250); }
  }
};

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch {}
    await sleep(500);
  }

  browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--window-size=1600,1000'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.setCookie({ name: 'hilbert_session', value: TOKEN, domain: '127.0.0.1', path: '/' });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(16000);

  const activeLine = () => page.evaluate(() => {
    const el = document.querySelector('.margin-view-overlays .active-line-number');
    return el ? Number(el.textContent) : null;
  });

  let landed = 0;
  let raised = 0;
  for (const target of targets) {
    // Scroll the preview until this equation's number is rendered.
    const found = await page.evaluate(async (want) => {
      const scroller = document.querySelector('.pdf-scroll');
      if (!scroller) return false;
      const find = () => Array.from(document.querySelectorAll('.textLayer span'))
        .find(s => (s.textContent || '').trim() === `(${want})`);
      if (find()) return true;
      scroller.scrollTop = 0;
      await new Promise(r => setTimeout(r, 400));
      for (let i = 0; i < 320; i++) {
        if (find()) return true;
        scroller.scrollTop += 240;
        await new Promise(r => setTimeout(r, 55));
      }
      return false;
    }, target.number);
    if (!found) throw new Error(`the PDF never showed an equation numbered (${target.number})`);
    await sleep(1200);

    // The superscript in the numerator of the fraction, deliberately: a small
    // box well above the baseline the number is printed on. Anything that
    // decides what is "on the same line" from the clicked glyph's own height
    // loses the number out at the margin and falls back to guessing.
    const clicked = await page.evaluate((want) => {
      const number = Array.from(document.querySelectorAll('.textLayer span'))
        .find(s => (s.textContent || '').trim() === `(${want})`);
      const rect = number.getBoundingClientRect();
      const middle = b => b.top + b.height / 2;
      const onLine = Array.from(number.closest('.textLayer').querySelectorAll('span'))
        .map(s => ({ s, b: s.getBoundingClientRect() }))
        .filter(({ s, b }) => b.left < rect.left - 10 && (s.textContent || '').trim().length > 0
          && Math.abs(middle(b) - middle(rect)) <= rect.height * 2);
      const pick = onLine.sort((a, b) => middle(a.b) - middle(b.b))[0];
      if (!pick) return null;
      const x = pick.b.left + pick.b.width / 2;
      const y = pick.b.top + pick.b.height / 2;
      for (const t of ['mousedown', 'mouseup', 'click', 'dblclick'])
        pick.s.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 2 }));
      return { text: pick.s.textContent, raisedBy: Math.round(middle(rect) - middle(pick.b)) };
    }, target.number);
    if (!clicked) throw new Error(`no glyph to click inside equation (${target.number})`);
    raised = Math.max(raised, clicked.raisedBy);
    await sleep(3200);

    const went = await activeLine();
    const ok = went === target.line;
    if (ok) landed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  (${target.number}) clicked ${JSON.stringify(clicked.text)} `
      + `${clicked.raisedBy}px above the number's line -> line ${went}, written on ${target.line}`);
  }

  await cleanup();
  if (landed !== targets.length) {
    console.error(`\nequation sync: ${targets.length - landed} of ${targets.length} numbered equations resolved to the wrong line`);
    process.exit(1);
  }
  console.log(`\nequation sync: all ${targets.length} numbered equations resolved through their printed number`
    + ` (the decoy pair sits at line ${decoyLine})`);
} catch (error) {
  await cleanup();
  console.error('equation sync could not run:', error.message);
  process.exit(2);
}
