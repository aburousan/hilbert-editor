// Types a sentence into a real editor, fast, and checks every character landed
// where it was typed.
//
// This is here because the bug it guards against passed every unit test we had:
// the editor and the committed React state hold separate copies of the text,
// and while someone types quickly the committed copy runs a keystroke or two
// behind. Writing that stale copy back reorders what the person just typed.
// Nothing short of driving a browser at speed catches it, and it only shows up
// under load, so the fixture is a document big enough to make compiles slow.
//
//   node scripts/test-typing-regression.mjs
//
// Needs a built frontend (npm run build) and a built backend
// (cd src-tauri && cargo build). Everything it writes lives in a temp
// directory, including the settings and session files, so it cannot disturb
// the copy of Hilbert you use.

import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const TOKEN = 'typing-regression-token-0123456789abcdef';
const PORT = Number(process.env.PORT || 3099);
const DELAY = Number(process.env.KEY_DELAY || 30);
const TRIALS = Number(process.env.TRIALS || 3);
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

const dir = await mkdtemp(join(tmpdir(), 'hilbert-typing-'));
const home = join(dir, 'home');
const ws = join(dir, 'ws');
// macOS puts app data under Library/Application Support, Linux under .config;
// making both means one HOME override covers either.
for (const d of [join(home, 'Library/Application Support/hilbert'), join(home, '.config/hilbert'), ws]) {
  await mkdir(d, { recursive: true });
}

// A file long enough that tokenising and compiling it are not instant. The
// repeated paragraph is deliberate: the bug shows up as text moving between
// lines, which is easiest to see when the lines around it are identical.
// Big on purpose. The bug only appears when a compile takes long enough that
// the committed React state falls behind the buffer, so a fixture that compiles
// quickly proves nothing — this one has to be heavy enough to lag.
const PARAGRAPHS = Number(process.env.PARAGRAPHS || 3000);
const filler = Array.from({ length: PARAGRAPHS }, (_, i) =>
  `Paragraph ${i + 1}. This sentence exists to give the tokeniser and the compiler `
  + `something to chew on while the test types, with $x_${i % 9} + sqrt(${(i % 7) + 1})$ `
  + `and _emphasis_ and #strong[markup] so the highlighter has work to do.`
).join('\n\n');
const doc = `#set page(paper: "a4")\n\n= Typing regression fixture\n\n${filler}\n`;
await writeFile(join(ws, 'main.typ'), doc);

const session = JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' });
const sessionFile = join(home, 'Library/Application Support/hilbert/session.json');
await writeFile(sessionFile, session);
await writeFile(join(home, '.config/hilbert/session.json'), session);
// 100 ms is the setting the original report used; it recompiles almost every keystroke.
for (const s of ['Library/Application Support/hilbert', '.config/hilbert']) {
  await writeFile(join(home, s, 'settings.json'), JSON.stringify({ compileDelay: 100, proofreading: false }));
}

const server = spawn(binary, ['--headless'], {
  env: { ...process.env, HOME: home, TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
         HILBERT_SESSION_FILE: sessionFile, HILBERT_API_TOKEN: TOKEN, PORT: String(PORT) },
  stdio: 'ignore',
});

let browser;
const cleanup = async () => {
  try { await browser?.close(); } catch {}
  server.kill();
  await rm(dir, { recursive: true, force: true });
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
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('.view-line', { timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('.pdf-page').length > 0, { timeout: 180000, polling: 500 });
  await sleep(2500);

  let failures = 0;
  for (let trial = 1; trial <= TRIALS; trial++) {
    // Each trial types a sentence nothing else in the file contains, so the
    // trials do not need the fixture reset between them — rewriting it on disk
    // would make the editor reload and drop the caret.
    const sentence = ` Trial ${trial} at ${Date.now()} typed quickly.`;

    const spot = await page.evaluate(() => {
      const el = [...document.querySelectorAll('.view-line')].find(e => e.innerText.startsWith('Paragraph'));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + Math.min(r.width - 20, 200), y: r.top + r.height / 2 };
    });
    if (!spot) throw new Error('fixture text not visible in the editor');

    await page.mouse.click(spot.x, spot.y);
    await sleep(400);
    await page.keyboard.press('End');
    await sleep(400);
    const focused = await page.evaluate(() =>
      String(document.activeElement?.className).includes('native-edit-context'));
    if (!focused) throw new Error('the editor never took focus');

    // Watch for the other half of the same bug: a whole-document replace throws
    // away every token, so the viewport briefly renders in one flat colour.
    await page.evaluate(() => {
      window.__flat = 0;
      const tick = () => {
        const spans = document.querySelectorAll('.view-lines span[class*="mtk"]');
        if (spans.length > 40) {
          const seen = new Set();
          for (const s of spans) for (const c of s.classList) if (c.startsWith('mtk')) seen.add(c);
          if (seen.size <= 2) window.__flat++;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const before = await readFile(join(ws, 'main.typ'), 'utf8');
    await page.keyboard.type(sentence, { delay: DELAY });
    await sleep(2000);
    await page.keyboard.down('Meta'); await page.keyboard.press('KeyS'); await page.keyboard.up('Meta');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control');
    await sleep(3000);

    const after = await readFile(join(ws, 'main.typ'), 'utf8');
    const flat = await page.evaluate(() => window.__flat);
    const beforeLines = before.split('\n'), afterLines = after.split('\n');
    const changed = [];
    for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
      if (beforeLines[i] !== afterLines[i]) changed.push({ before: beforeLines[i], after: afterLines[i] });
    }

    // Taking the sentence back out has to give back exactly the line that was
    // there, which is false the moment one character lands out of order.
    const ok = changed.length === 1
      && after.split(sentence).length - 1 === 1
      && changed[0].after?.replace(sentence, '') === changed[0].before
      && flat === 0;

    if (ok) {
      console.log(`  ok    trial ${trial}: ${sentence.length} characters in order, no flat frames`);
    } else {
      failures++;
      console.log(`  FAIL  trial ${trial}: lines changed ${changed.length}, flat frames ${flat}`);
      console.log(`        typed:  ${JSON.stringify(sentence)}`);
      console.log(`        before: ${JSON.stringify(changed[0]?.before ?? null)}`);
      console.log(`        after:  ${JSON.stringify(changed[0]?.after ?? null)}`);
    }
  }

  await cleanup();
  if (failures) {
    console.error(`\ntyping regression: ${failures} of ${TRIALS} trials scrambled the text`);
    process.exit(1);
  }
  console.log(`\ntyping regression: ${TRIALS} trials clean at ${DELAY} ms per keystroke`);
} catch (error) {
  await cleanup();
  console.error('typing regression could not run:', error.message);
  process.exit(2);
}
