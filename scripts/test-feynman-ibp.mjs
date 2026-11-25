// Feynman studio tools for loop-integral (IBP) notes: circular arcs, momentum arrows, end labels, dots
// for raised powers, faded cut lines, splitting a circle into arcs and numbering lines.
//
//   node scripts/test-feynman-ibp.mjs     (needs npm run build and a backend: BIN=... or target/*/hilbert)
//   FEYN_OUT=<folder> also saves the generated code (snippets.json) and pictures of the canvas.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const binary = process.env.BIN || ['release', 'debug'].map(m => join(root, 'src-tauri/target', m, 'hilbert')).find(existsSync);
assert.ok(binary, 'Build the backend first, or set BIN.');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = await mkdtemp(join(tmpdir(), 'hilbert-feyn-'));
const ws = join(dir, 'ws');
await mkdir(ws);
await writeFile(join(ws, 'main.typ'), '= Notes\n');
const token = 'hilbert-feyn-test-token-0123456789abcd';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(process.env.PORT || 3757), TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
    HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: join(dir, 'settings.json'),
    HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'), HILBERT_API_TOKEN: token, HILBERT_COLLAB: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bound = null;
for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });
let browser, failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

try {
  for (let i = 0; i < 300 && !bound; i++) await sleep(100);
  assert.ok(bound, 'backend did not start');
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setCookie({ name: 'hilbert_session', value: token, domain: '127.0.0.1', path: '/' });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${bound}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.view-line', { timeout: 60000 });

  const out = process.env.FEYN_OUT;   // optional: a folder for the generated code and canvas pictures
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.click('.view-lines');
  await page.keyboard.down(mod); await page.keyboard.down('Shift'); await page.keyboard.press('f'); await page.keyboard.up('Shift'); await page.keyboard.up(mod);
  await page.waitForFunction(() => [...document.querySelectorAll('.modal-header h2')].some(h => h.textContent.includes('Feynman')), { timeout: 10000 });
  const clickText = (sel, text) => page.evaluate((sel, text) => { const el = [...document.querySelectorAll(sel)].find(e => e.textContent.trim() === text); el?.click(); return !!el; }, sel, text);
  await page.evaluate(() => { const box = [...document.querySelectorAll('label.form-check')].find(l => l.textContent.includes('Show generated Typst code'))?.querySelector('input'); if (box && !box.checked) box.click(); });
  const code = () => page.$eval('.modal-content pre', p => p.textContent);
  const canvas = async name => { if (out) await (await page.$('.modal-body svg[viewBox="0 0 680 400"]')).screenshot({ path: join(out, `${name}.png`) }); };
  const snippets = {};
  for (const name of ['One-loop bubble', 'Bubble with a dot', 'One-loop box', 'Two-loop graph, lines numbered', 'Two-loop graph, lines 1 and 3 cut']) {
    await clickText('button', 'Examples…');
    await sleep(200);
    const opened = await page.evaluate(name => {
      const card = [...document.querySelectorAll('.modal-body div')].find(d => d.firstElementChild?.tagName === 'DIV' && d.textContent.startsWith('') && d.querySelector(':scope > div:nth-child(2) > div')?.textContent === name);
      card?.firstElementChild?.click();
      return !!card;
    }, name);
    await sleep(250);
    const c = await code();
    snippets[name] = c;
    check(`example "${name}" opens`, opened && c.includes('canvas('));
    await canvas(name.replace(/[^a-z0-9]+/gi, '-'));
  }
  const bub = snippets['One-loop bubble'];
  check('bubble: two circular arcs', (bub.match(/arc-through\(/g) || []).length >= 3, 'two arcs + the momentum arrow');
  check('bubble: labels p_1 … p_4, ell and ell - p', ['$p_1$', '$p_4$', '$ell$', '$ell - p$'].every(t => bub.includes(t)));
  check('bubble: a momentum arrow with an arrowhead', /arc-through\([^\n]*mark: \(end: ">"/.test(bub));
  check('dot: a filled dot on the line', /circle\([^\n]*radius: 0\.08, fill: black, stroke: none\)/.test(snippets['Bubble with a dot']));
  const cut = snippets['Two-loop graph, lines 1 and 3 cut'];
  check('cut lines are faded (two dotted grey arcs)', (cut.match(/luma\(62%\), dash: "densely-dotted"/g) || []).length === 2);
  check('numbered lines carry 1 … 5', ['$1$', '$2$', '$3$', '$4$', '$5$'].every(t => snippets['Two-loop graph, lines numbered'].includes(t)));

  // Draw a circle with two vertices on it, split it, number the lines.
  await clickText('button', 'Clear');
  const svg = await page.$('.modal-body svg[viewBox="0 0 680 400"]');
  const box = await svg.boundingBox();
  const at = (x, y) => ({ x: box.x + x * box.width / 680, y: box.y + y * box.height / 400 });
  await clickText('.seg button', 'Circle');
  let p = at(340, 200), q = at(420, 200);
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 6 }); await page.mouse.up();
  await clickText('.seg button', 'Vertex');
  for (const [x, y] of [[260, 200], [420, 200]]) { const v = at(x, y); await page.mouse.click(v.x, v.y); }
  await clickText('.seg button', 'Select');
  p = at(340, 120); await page.mouse.click(p.x, p.y);
  const split = await clickText('button', 'Split into arcs at the vertices');
  await sleep(200);
  let drawn = await code();
  check('split: the circle becomes two arcs', split && (drawn.match(/arc-through\(/g) || []).length === 2 && !/circle\([^\n]*radius: 2,/.test(drawn), (drawn.match(/arc-through\(/g) || []).length + ' arcs');
  await clickText('button', 'Number lines');
  await sleep(150);
  drawn = await code();
  check('number lines: the two arcs are 1 and 2', drawn.includes('[$1$]') && drawn.includes('[$2$]'));
  await canvas('split-and-numbered');
  snippets['split'] = drawn;
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  if (out) await writeFile(join(out, 'snippets.json'), JSON.stringify(snippets, null, 1));
} finally {
  await browser?.close();
  server.kill();
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nfeynman IBP tools: all checks passed');
process.exit(failures ? 1 : 0);
