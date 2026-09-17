// Double-clicking the preview must land on the word that was clicked.
//
// The jump used to be worked out by matching words, and prose reuses its words.
// On the three-file project below it landed on the right word 29% of the time
// and never once for a word written in an included chapter: the same word sat
// in the open file, and the match went there. Typst now answers instead, from
// the span each glyph carries, and this checks the answer where it counts.
//
// The right answer for each click comes from counting, not from the app: in a
// single-column document the k-th "field" on the page is the k-th "field" in the
// source, read in include order. The test first confirms that the text layer
// really does give the words back in that order, and says so rather than
// blaming the app if it does not.
//
// Then the things that are not plain prose — references, footnotes, captions,
// equation numbers, tables, code, small capitals, page headers — and a page in
// several scripts, because the check that a click was made on the current
// preview compares the page's text, and a PDF cannot give every script back
// intact.
//
//   node scripts/test-pdf-jump.mjs          (STEP=1 clicks every word)
//
// Needs a built frontend (npm run build) and backend (cd src-tauri && cargo build).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
// `cargo build` writes typst-editor; a bundled build writes hilbert.
const names = process.platform === 'win32' ? ['typst-editor.exe', 'hilbert.exe'] : ['typst-editor', 'hilbert'];
const binary = process.env.BIN || ['debug', 'release']
  .flatMap(m => names.map(name => join(root, 'src-tauri/target', m, name))).find(existsSync);
assert.ok(binary, 'Build the backend with cargo build before running this test.');
const STEP = Math.max(1, Number(process.env.STEP || 4));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The app, on a throwaway project.
// ---------------------------------------------------------------------------

async function startApp(files, port) {
  const dir = await mkdtemp(join(tmpdir(), 'hilbert-jump-'));
  const ws = join(dir, 'workspace');
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(ws, path, '..'), { recursive: true });
    await writeFile(join(ws, path), text);
  }
  await writeFile(join(dir, 'session.json'), JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ proofreading: false }));
  const token = 'hilbert-jump-test-token-0123456789abcd';
  const server = spawn(binary, ['--headless'], {
    env: { ...process.env, PORT: String(port), TYPST_WORKSPACE: ws, TYPST_DIST: join(root, 'dist'),
      HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: join(dir, 'settings.json'), HILBERT_API_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const jumps = [];
  // The backend takes another port when the one asked for is busy, so the port
  // it reports is the one to talk to. Guessing can reach a server left over
  // from an earlier run, which answers about a different project entirely.
  let bound = null;
  for (const s of [server.stdout, server.stderr]) s.on('data', d => {
    const text = String(d);
    for (const l of text.split('\n')) if (l.includes('jump:')) jumps.push(l);
    bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(text)?.[1]) || null;
  });
  for (let i = 0; i < 200 && !bound; i++) await sleep(100);
  assert.ok(bound, 'the backend never said which port it bound');
  const origin = `http://127.0.0.1:${bound}`;
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(`${origin}/workspace/root`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(800) })).ok) break; } catch {}
    await sleep(100);
  }
  const serving = await (await fetch(`${origin}/workspace/root`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(serving.root, ws, 'the backend answering is not the one this test started');
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  await page.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; }, token);
  const stop = async () => { await browser.close().catch(() => {}); server.kill(); await sleep(300); server.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); };
  try {
    await page.goto(origin, { waitUntil: 'networkidle2', timeout: 90000 });
    await page.waitForSelector('.view-line', { timeout: 60000 });
    await page.waitForSelector('.pdf-page canvas', { timeout: 90000 });
    // Wait for the preview to stop changing shape.
    let last = '';
    for (let i = 0; i < 40; i++) {
      const now = await page.evaluate(() => `${document.querySelectorAll('.pdf-page').length}:${document.querySelector('.pdf-scroll')?.scrollHeight}`);
      if (now === last) break;
      last = now; await sleep(700);
    }
  } catch (error) { await stop(); throw error; }
  const refused = () => jumps.filter(l => l.includes('not using the layout'));
  return { page, stop, refused, lookups: () => jumps.filter(l => l.includes('resolved')).length };
}

// Where the last jump put the editor: the tab, the model line under the cursor,
// and the column of the flash within that line, wrapped or not.
const landing = page => page.evaluate(() => {
  const flash = document.querySelector('.sync-flash');
  const lineEl = document.querySelector('.active-line-number');
  if (!flash || !lineEl) return null;
  const tab = (document.querySelector('.tab.active')?.textContent || '').replace(/\s*×\s*$/, '').trim();
  const current = document.querySelector('.view-overlays .current-line');
  const view = flash.closest('.view-line');
  let col = 1;
  if (current && view) {
    const top = parseFloat(current.parentElement.style.top || current.style.top);
    const rows = [...document.querySelectorAll('.view-lines .view-line')]
      .filter(v => parseFloat(v.style.top) >= top - 1 && parseFloat(v.style.top) < parseFloat(view.style.top) + 1)
      .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top));
    const before = rows.filter(v => v !== view).reduce((n, v) => n + v.textContent.length, 0);
    const r = document.createRange(); r.setStart(view, 0); r.setEndBefore(flash);
    col = before + r.toString().length + 1;
  }
  return { tab, line: Number(lineEl.textContent), col, text: flash.textContent };
});

async function doubleClick(page, x, y) {
  for (let i = 0; i < 40 && await page.evaluate(() => !!document.querySelector('.sync-flash')); i++) await sleep(50);
  await page.mouse.click(x, y, { count: 2 });
  let got = null;
  for (let i = 0; i < 80 && !got; i++) { await sleep(50); got = await landing(page); }
  return got;
}

// Scroll a page into view and return its words with their boxes on screen.
const pageWords = (page, index) => page.evaluate(async (index) => {
  const el = document.querySelectorAll('.pdf-page')[index]; if (!el) return null;
  const scroller = document.querySelector('.pdf-scroll');
  scroller.style.scrollBehavior = 'auto';
  scroller.scrollTo({ top: el.offsetTop - 20, behavior: 'instant' });
  let prev = -1;
  for (let i = 0; i < 60 && scroller.scrollTop !== prev; i++) { prev = scroller.scrollTop; await new Promise(r => setTimeout(r, 80)); }
  for (let i = 0; i < 80; i++) { if (el.querySelectorAll('.textLayer span').length > 3) break; await new Promise(r => setTimeout(r, 100)); }
  await new Promise(r => setTimeout(r, 300));
  const out = [];
  for (const span of el.querySelectorAll('.textLayer span')) {
    const node = span.firstChild; if (!node || node.nodeType !== 3) continue;
    for (const m of node.textContent.matchAll(/\p{L}{3,}/gu)) {
      const r = document.createRange(); r.setStart(node, m.index); r.setEnd(node, m.index + m[0].length);
      const b = r.getBoundingClientRect();
      out.push({ word: m[0].toLowerCase(), x: b.left + b.width / 2, y: b.top + b.height / 2 });
    }
  }
  return out;
}, index);

// The word a double-click at this point would select.
const wordAt = (page, x, y) => page.evaluate((x, y) => {
  const r = document.caretRangeFromPoint?.(x, y);
  if (!r || r.startContainer.nodeType !== 3) return null;
  const t = r.startContainer.textContent; let a = r.startOffset, b = r.startOffset;
  while (a > 0 && /\p{L}/u.test(t[a - 1])) a--;
  while (b < t.length && /\p{L}/u.test(t[b])) b++;
  return t.slice(a, b).toLowerCase();
}, x, y);

// Find rendered text on the page, scroll it to the middle, and return a point
// inside it. `last` takes the final occurrence rather than the first.
const findText = (page, texts, last = false) => page.evaluate(async (texts, last) => {
  const scroller = document.querySelector('.pdf-scroll');
  scroller.style.scrollBehavior = 'auto';
  const all = [...document.querySelectorAll('.pdf-page .textLayer span')];
  for (const span of (last ? all.reverse() : all)) {
    const node = span.firstChild; if (!node || node.nodeType !== 3) continue;
    const text = texts.find(t => node.textContent.includes(t)); if (!text) continue;
    const at = node.textContent.indexOf(text);
    const range = () => { const r = document.createRange(); r.setStart(node, at); r.setEnd(node, at + text.length); return r.getBoundingClientRect(); };
    scroller.scrollTo({ top: scroller.scrollTop + range().top - scroller.getBoundingClientRect().top - scroller.clientHeight / 2, behavior: 'instant' });
    await new Promise(r => setTimeout(r, 250));
    const b = range();
    return { x: b.left + Math.min(b.width / 2, 6), y: b.top + b.height / 2 };
  }
  return null;
}, texts, last);

let failures = 0;

// ---------------------------------------------------------------------------
// 1. Prose that reuses its words, over three files.
// ---------------------------------------------------------------------------

function proseProject() {
  const vocab = ['field', 'energy', 'mass', 'state', 'wave', 'charge', 'space', 'time', 'scalar', 'vacuum',
    'particle', 'coupling', 'symmetry', 'gauge', 'theory', 'action', 'operator', 'spin', 'photon', 'momentum'];
  const glue = ['the', 'of', 'and', 'with', 'for', 'is', 'in', 'a', 'that', 'this'];
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rand() * a.length)];
  const sentence = () => {
    const w = Array.from({ length: 9 + Math.floor(rand() * 8) }, () => rand() < 0.45 ? pick(vocab) : pick(glue));
    w[0] = w[0][0].toUpperCase() + w[0].slice(1);
    let s = w.join(' ');
    if (rand() < 0.35) s = s.replace(/ (\w+) (\w+) /, ' *$1* _$2_ ');
    if (rand() < 0.4) s += ' where $x^2 + alpha_n$ holds';
    return s + '.';
  };
  const para = () => Array.from({ length: 3 + Math.floor(rand() * 3) }, sentence).join(' ');
  const intro = ['= Introduction', '', para(), '', para(), '', '- ' + sentence(), '- ' + sentence(), '', para(), ''];
  const fields = ['= Fields', '', para(), '', '$ phi(x) = integral d^4 k thin a_k e^(-i k x) $ <eq:phi>', '', para(), '',
    '== Gauge fields', '', para(), '', '$ F_(mu nu) = partial_mu A_nu - partial_nu A_mu $', '', para(), ''];
  const main = ['#set page(width: 16cm, height: 22cm, margin: 2cm, numbering: "1")', '#set heading(numbering: "1.1")',
    '#set math.equation(numbering: "(1)")', '#set text(size: 11pt)', '', para(), '', '#include "chapters/intro.typ"', '',
    para(), '', '#include "chapters/fields.typ"', '', '= Closing', '', para(), '', para(), ''];
  return { 'main.typ': main.join('\n'), 'chapters/intro.typ': intro.join('\n'), 'chapters/fields.typ': fields.join('\n') };
}

// Every word of three or more letters in reading order, with where it was
// written. Math, markup and directive lines are blanked out, keeping columns.
function sourceWords(files) {
  const out = [];
  const walk = path => files[path].split('\n').forEach((line, i) => {
    const inc = /^#include "(.+)"/.exec(line);
    if (inc) return walk(inc[1]);
    if (line.startsWith('#') || line.startsWith('$ ')) return;
    const clean = line.replace(/\$[^$]*\$/g, m => ' '.repeat(m.length)).replace(/<[^>]*>/g, m => ' '.repeat(m.length))
      .replace(/^(=+|-) /, m => ' '.repeat(m.length)).replace(/[*_]/g, ' ');
    for (const m of clean.matchAll(/\p{L}{3,}/gu)) out.push({ word: m[0].toLowerCase(), path, line: i + 1, col: m.index + 1 });
  });
  walk('main.typ');
  return out;
}

{
  console.log(`prose over three files, every ${STEP === 1 ? '' : `${STEP}th `}word:`);
  const files = proseProject();
  const expected = sourceWords(files);
  const app = await startApp(files, Number(process.env.PORT || 3089));
  try {
    const pages = await app.page.evaluate(() => document.querySelectorAll('.pdf-page').length);
    let rendered = [];
    for (let p = 0; p < pages; p++) rendered = rendered.concat((await pageWords(app.page, p)).map(w => ({ ...w, pageIndex: p })));
    const oracle = rendered.length === expected.length && rendered.every((w, i) => w.word === expected[i].word);
    assert.ok(oracle, `the text layer does not give the words back in source order (${rendered.length} vs ${expected.length}); this test's answers would be wrong, not the app`);

    const tally = {}, byFile = {};
    for (let k = 0; k < expected.length; k += STEP) {
      const want = expected[k];
      const fresh = await pageWords(app.page, rendered[k].pageIndex);
      const indexOnPage = rendered.slice(0, k).filter(w => w.pageIndex === rendered[k].pageIndex).length;
      const w = fresh[indexOnPage];
      if (!w || w.word !== want.word || await wordAt(app.page, w.x, w.y) !== want.word) { tally.skipped = (tally.skipped || 0) + 1; continue; }
      const got = await doubleClick(app.page, w.x, w.y);
      const outcome = !got ? 'no jump'
        : got.tab !== want.path && got.tab !== want.path.split('/').pop() ? 'wrong file'
        : got.line !== want.line ? 'wrong line'
        : got.col === want.col ? 'exact' : 'right line, wrong word';
      tally[outcome] = (tally[outcome] || 0) + 1;
      (byFile[want.path] ??= [0, 0])[1]++;
      if (outcome === 'exact') byFile[want.path][0]++;
      else if (tally[outcome] <= 3) console.log(`  miss: ${want.word} written ${want.path}:${want.line}:${want.col}, got ${got ? `${got.tab}:${got.line}:${got.col}` : 'nothing'}`);
    }
    const clicked = Object.entries(tally).filter(([k]) => k !== 'skipped').reduce((n, [, v]) => n + v, 0);
    const intended = Math.ceil(expected.length / STEP);
    // Without this the run could skip every word and report nothing wrong.
    if (clicked < intended * 0.9) { failures++; console.log(`  FAIL only ${clicked} of ${intended} words were clicked at all`); }
    // Every click should reach the lookup; one that does not has failed before
    // it got there and quietly fallen back to matching words.
    if (app.lookups() < clicked) { failures++; console.log(`  FAIL ${clicked - app.lookups()} clicks never reached the lookup`); }
    for (const [f, [e, n]] of Object.entries(byFile)) console.log(`  ${f.padEnd(22)} ${e}/${n} exact`);
    if (tally.skipped) console.log(`  (${tally.skipped} not clicked: the preview moved under the pointer)`);
    const refused = app.refused();
    console.log(`  ${app.lookups()} lookups, ${refused.length} refused`);
    if ((tally.exact || 0) !== clicked) { failures++; console.log(`  FAIL ${clicked - (tally.exact || 0)} of ${clicked} landed somewhere else`); }
    if (refused.length) { failures++; console.log(`  FAIL the backend refused its own layout: ${refused[0]}`); }
  } finally { await app.stop(); }
}

// ---------------------------------------------------------------------------
// 2. Everything that is not plain prose.
// ---------------------------------------------------------------------------

{
  console.log('\nreferences, notes, captions and the rest:');
  const main = [
    '#set page(width: 16cm, height: 22cm, margin: 2cm, numbering: "1", header: [Draft notes])',
    '#set heading(numbering: "1.1")',
    '#set math.equation(numbering: "(1)")',
    '',
    '= Scalar fields',
    '',
    'The Klein #strong[Gordon] equation @eq:kg follows from #emph[varying] the action.#footnote[Footnote words here.]',
    '',
    '$ (partial^2 + m^2) phi = 0 $ <eq:kg>',
    '',
    '- first bullet item',
    '+ numbered entry',
    '',
    '#figure(table(columns: 2, [alpha cell], [beta cell]), caption: [Table caption text]) <tab:x>',
    '',
    '```python',
    'print("raw code")',
    '```',
    '',
    '#smallcaps[Small Capitals] and #upper[shouting] words.',
    '',
    'As shown in @tab:x and $E = m c^2$ inline.',
    '',
  ].join('\n');
  const col = (line, needle) => main.split('\n')[line - 1].indexOf(needle) + 1;
  const targets = [
    ['a strong word', 'Gordon', 7, col(7, 'Gordon')],
    ['an emphasised word', 'varying', 7, col(7, 'varying')],
    ['a reference to an equation, at the reference', 'Equation', 7, col(7, '@eq:kg')],
    ['footnote text', 'Footnote', 7, col(7, 'Footnote')],
    ['a Greek letter in a block equation', ['𝜑', '𝜙', 'φ', 'ϕ'], 9, col(9, 'phi')],
    ['an equation number, at its equation', '(1)', 9, null],
    ['a bullet list item', 'bullet', 11, col(11, 'bullet')],
    ['a numbered list item', 'entry', 12, col(12, 'entry')],
    ['a table cell', 'alpha', 14, col(14, 'alpha')],
    ['a caption word', 'caption', 14, col(14, 'caption text')],
    ['a caption label, at the caption', 'Table 1', 14, col(14, 'Table caption')],
    ['a raw code block', 'raw', 17, col(17, 'raw')],
    ['small capitals', 'Capitals', 20, col(20, 'Capitals')],
    ['an upper-cased word', 'SHOUTING', 20, col(20, 'shouting')],
    ['a reference to a table, at the reference', 'Table 1', 22, col(22, '@tab:x'), true],
    ['an inline math letter', ['𝐸', 'E ='], 22, col(22, 'E =')],
    ['the page header', 'Draft', 1, col(1, 'Draft')],
    ['a heading word', 'Scalar', 5, col(5, 'Scalar')],
  ];
  const app = await startApp({ 'main.typ': main }, Number(process.env.PORT || 3089) + 1);
  try {
    for (const [name, rendered, line, column, last] of targets) {
      const at = await findText(app.page, Array.isArray(rendered) ? rendered : [rendered], !!last);
      if (!at) { failures++; console.log(`  FAIL ${name}: nothing like ${JSON.stringify(rendered)} on the page`); continue; }
      const got = await doubleClick(app.page, at.x, at.y);
      const ok = got && got.line === line && (column === null || got.col === column);
      if (!ok) failures++;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(46)} ${got ? `${got.line}:${got.col}` : 'nothing'}${ok ? '' : ` (wanted ${line}:${column ?? 'any'})`}`);
    }
    if (app.refused().length) { failures++; console.log(`  FAIL refused: ${app.refused()[0]}`); }
  } finally { await app.stop(); }
}

// ---------------------------------------------------------------------------
// 3. Mathematics, where a glyph and the source that made it seldom look alike.
// ---------------------------------------------------------------------------

{
  console.log('\nmathematics:');
  const main = [
    '#set page(width: 16cm, height: 24cm, margin: 2cm)',                                   // 1
    '#set math.equation(numbering: "(1)")',                                                // 2
    '',                                                                                     // 3
    'The energy $E = m c^2$ and the field $phi(t)$ appear inline.',                          // 4
    '',                                                                                     // 5
    '$ integral_0^infinity e^(-alpha x^2) dif x = 1/2 sqrt(pi/alpha) $ <gauss>',             // 6
    '',                                                                                     // 7
    '$ mat(p, q; r, s) vec(u, v) = vec(kappa, lambda) $',                                    // 8
    '',                                                                                     // 9
    '$ cal(L) = -1/4 F_(mu nu) F^(mu nu) + macron(psi) (i gamma^mu D_mu - m) psi $ <qed>',   // 10
    '',                                                                                     // 11
    '$ f(x) = cases(x^2 "if" x > 0\, -x "otherwise") $',                                     // 12
    '',                                                                                     // 13
    '$ lr(( sum_(n=1)^N a_n / b_n )) = omega $',                                             // 14
    '',                                                                                     // 15
    'From @gauss and @qed the answer follows.',                                              // 16
    '',
  ].join('\n');
  const col = (line, needle) => main.split('\n')[line - 1].indexOf(needle) + 1;
  const targets = [
    ['an inline letter', ['𝐸', 'E'], 4, col(4, 'E =')],
    ['an inline Greek letter', ['𝜑', '𝜙', 'φ', 'ϕ'], 4, col(4, 'phi(t)')],
    ['an integral sign', '∫', 6, col(6, 'integral')],
    ['a Greek letter in an exponent', ['𝛼', 'α'], 6, col(6, 'alpha x^2')],
    ['a square root', '√', 6, col(6, 'sqrt')],
    // The rendered glyphs, not the letters they are written with: the text
    // layer holds 𝑞, and plain "q" would match the word "Equation" in a
    // reference further down the page.
    ['a matrix entry', '𝑞', 8, col(8, 'q')],
    ['a vector entry', '𝑢', 8, col(8, 'u,')],
    // A named symbol inside vec/mat carries no span of its own, so the answer
    // is the equation it is in — the right formula, not the exact letter.
    ['a Greek vector entry, at its equation', ['𝜅', 'κ'], 8, 1],
    ['a script letter', ['ℒ', 'L'], 10, col(10, 'cal(L)') + 4],
    // Likewise the letter under an accent.
    ['an accented letter, at its equation', ['𝜓', 'ψ'], 10, 1],
    ['a word inside cases', 'otherwise', 12, col(12, 'otherwise')],
    ['a summation sign', '∑', 14, col(14, 'sum')],
    ['a tall bracket built from pieces', '(', 14, null, true],
    ['a reference to a numbered equation', 'Equation 1', 16, col(16, '@gauss')],
    ['an equation number in the margin', '(3)', 10, 1],
  ];
  const app = await startApp({ 'main.typ': main }, Number(process.env.PORT || 3089) + 3);
  try {
    for (const [name, rendered, line, column, last] of targets) {
      const at = await findText(app.page, Array.isArray(rendered) ? rendered : [rendered], !!last);
      if (!at) { failures++; console.log(`  FAIL ${name}: nothing like ${JSON.stringify(rendered)} on the page`); continue; }
      const got = await doubleClick(app.page, at.x, at.y);
      const ok = got && got.line === line && (column === null || got.col === column);
      if (!ok) failures++;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(36)} ${got ? `${got.line}:${got.col} ${JSON.stringify(got.text)}` : 'nothing'}${ok ? '' : ` (wanted ${line}:${column ?? 'any'})`}`);
    }
    if (app.refused().length) { failures++; console.log(`  FAIL refused: ${app.refused()[0]}`); }
  } finally { await app.stop(); }
}

// ---------------------------------------------------------------------------
// 4. A page in several scripts. A script with no font on this machine is left
//    out, since then there is nothing on the page to click.
// ---------------------------------------------------------------------------

{
  console.log('\nseveral scripts on one page:');
  const main = [
    '#set page(width: 16cm, height: 14cm, margin: 2cm)',
    '#set text(font: ("Libertinus Serif", "Geeza Pro", "Noto Sans Arabic", "Arial Hebrew", "Noto Sans Hebrew", "Bangla MN", "Noto Sans Bengali", "PingFang SC", "Noto Sans CJK SC"))',
    '',
    'English words before the other scripts.',
    '',
    '#text(lang: "ar", dir: rtl)[مرحبا بالعالم هذا نص عربي للتجربة]',
    '',
    '#text(lang: "he", dir: rtl)[שלום עולם זה טקסט בעברית]',
    '',
    '#text(lang: "bn")[আমার সোনার বাংলা আমি তোমায় ভালোবাসি]',
    '',
    '#text(lang: "zh")[这是一个关于物理学的中文句子]',
    '',
    'Το πεδίο και η ενέργεια.',
    '',
    'Closing English words after them.',
    '',
  ].join('\n');
  const targets = [['English', 'before', 4], ['Arabic', 'بالعالم', 6], ['Hebrew', 'עולם', 8], ['Bengali', 'সো', 10],
    ['Chinese', '物理', 12], ['Greek', 'πεδίο', 14], ['English again', 'Closing', 16]];
  const app = await startApp({ 'main.typ': main }, Number(process.env.PORT || 3089) + 2);
  try {
    let found = 0;
    for (const [name, rendered, line] of targets) {
      const at = await findText(app.page, [rendered]);
      if (!at) { console.log(`  --   ${name}: no font for it here, left out`); continue; }
      found++;
      const got = await doubleClick(app.page, at.x, at.y);
      // The line alone would pass for any word on it, so the highlighted word
      // has to be the one that was clicked.
      const ok = got && got.line === line && got.text.includes(rendered);
      if (!ok) failures++;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} ${got ? `${got.line}:${got.col} ${JSON.stringify(got.text)}` : 'nothing'}`);
    }
    if (found < 4) { failures++; console.log(`  FAIL only ${found} scripts had fonts here; this machine cannot show the page`); }
    const refused = app.refused();
    console.log(`  ${app.lookups()} lookups, ${refused.length} refused`);
    if (refused.length) { failures++; console.log(`  FAIL refused: ${refused[0]}`); }
  } finally { await app.stop(); }
}

console.log(failures ? `\npdf jump: ${failures} check(s) failed` : '\npdf jump: every double-click landed where it was written');
process.exit(failures ? 1 : 0);
