import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const exe = process.platform === 'win32' ? 'typst-editor.exe' : 'typst-editor';
const binary = process.env.BIN || ['debug', 'release']
  .map(mode => join(root, 'src-tauri/target', mode, exe)).find(existsSync);
assert.ok(binary, 'Build the backend with cargo build before running this test.');
const dir = await mkdtemp(join(tmpdir(), 'hilbert-smoke-'));
const ws = join(dir, 'workspace');
const artifacts = process.env.ARTIFACTS || await mkdtemp(join(tmpdir(), 'hilbert-smoke-results-'));
await mkdir(ws);
await mkdir(artifacts, { recursive: true });
const session = join(dir, 'session.json');
const settings = join(dir, 'settings.json');
const interpreters = join(dir, 'interpreters.json');
await writeFile(interpreters, JSON.stringify({ python: process.env.TEST_PYTHON ? [{ label: 'Smoke test Python', path: process.env.TEST_PYTHON }] : [] }));
const source = Array.from({ length: 36 }, (_, i) =>
  `= Page ${i + 1}\n\nPreview memory fixture with $x_${i}^2 + y^2$.\n${i < 35 ? '#pagebreak()' : ''}`
).join('\n\n');
await writeFile(join(ws, 'main.typ'), source);
await copyFile(join(root, 'src-tauri/icons/128x128.png'), join(ws, 'sample.png'));
await writeFile(join(ws, 'drawing.excalidraw'), JSON.stringify({ elements: [], appState: {} }));
await writeFile(session, JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
await writeFile(settings, JSON.stringify({ proofreading: false }));
const token = 'hilbert-smoke-token-0123456789abcdef';
const port = Number(process.env.PORT || 3096);
const origin = `http://127.0.0.1:${port}`;
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(port), TYPST_WORKSPACE: ws, TYPST_DIST: join(root, 'dist'),
    HILBERT_SESSION_FILE: session, HILBERT_SETTINGS_FILE: settings, HILBERT_INTERPRETERS_FILE: interpreters, HILBERT_API_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { logs = (logs + data).slice(-12000); });
let spawnError;
server.on('error', error => { spawnError = error; });
let browser;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError;
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Backend exited:\n${logs}`);
    try {
      const response = await fetch(`${origin}/workspace/root`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* Startup may still be binding the port. */ }
    await pause(100);
  }
  assert.ok(ready, `Backend did not start:\n${logs}`);
  if (process.env.TEST_PYTHON) {
    const symbolicCases = [
      ['diff(sin(x**2), x)', /2 x/],
      ['A = Matrix([\n  [1, 2],\n  [3, 4],\n])\nA.inv()', /matrix/],
      ['answer = integrate(x**2, x) # keep the assignment', /frac/],
      ['x = symbols("x", positive=True)\nsimplify(sqrt(x**2))', /^x\s*$/],
      ['print("diagnostic")\nsolve([Eq(x+y,3), Eq(x-y,1)], [x,y])', /x.*2.*y.*1/],
    ];
    for (const [code, expected] of symbolicCases) {
      const response = await fetch(`${origin}/run`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang: 'python', code, bin: process.env.TEST_PYTHON, outputMode: 'equation' }), signal: AbortSignal.timeout(45000) });
      const result = await response.json();
      assert.ok(response.ok && result.ok, JSON.stringify(result));
      assert.match(result.stdout, expected);
      assert.ok(!result.stdout.includes('diagnostic'), 'Printed diagnostics must not pollute the equation.');
      await writeFile(join(ws, 'symbolic.typ'), '#import "@preview/mitex:0.2.7": mitex\n#mitex(' + JSON.stringify(result.stdout.trim()) + ')');
      execFileSync(process.env.TYPST_BIN || 'typst', ['compile', '--package-path', join(root, 'src-tauri/resources/typst-packages'), join(ws, 'symbolic.typ'), join(ws, 'symbolic.svg'), '--format', 'svg'], { timeout: 30000 });
    }
    console.log(`Symbolic: ${symbolicCases.length} real API runs and Typst equations passed.`);
  } else console.log('Symbolic API checks skipped: set TEST_PYTHON to an interpreter with SymPy.');
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 920, deviceScaleFactor: 2 });
  await browser.setCookie({ name: 'hilbert_session', value: token, domain: '127.0.0.1', path: '/' });
  const errors = [];
  const externalRequests = new Set();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) externalRequests.add(request.url());
  });
  await page.goto(origin, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.view-line');
  await page.waitForFunction(() => document.querySelectorAll('.pdf-page').length === 36, { timeout: 60000 });
  await page.waitForSelector('.pdf-page canvas');
  await pause(4500);
  const warmLayers = await page.$$eval('.pdf-page .textLayer', layers => layers.filter(layer => layer.childElementCount > 0).length);
  assert.ok(warmLayers <= 12, `Idle text preparation must be bounded, not cover all 36 pages (got ${warmLayers}).`);
  console.log('PDF text layers after idle:', warmLayers);
  await page.screenshot({ path: join(artifacts, 'desktop.png') });

  const sizes = [];
  for (let i = 0; i < 36; i += 3) {
    await page.evaluate(index => {
      const scroller = document.querySelector('.pdf-scroll');
      const target = document.querySelectorAll('.pdf-page')[index];
      scroller.scrollTop = target.offsetTop;
    }, i);
    await page.waitForFunction(index => !!document.querySelectorAll('.pdf-page')[index]?.querySelector('canvas'), { timeout: 15000 }, i);
    await pause(120);
    sizes.push(await page.evaluate(() => {
      const canvases = [...document.querySelectorAll('.pdf-page canvas')];
      return { canvases: canvases.length, mb: canvases.reduce((n, canvas) => n + canvas.width * canvas.height * 4, 0) / 1024 / 1024 };
    }));
  }
  console.log('PDF retained bitmaps:', JSON.stringify(sizes));
  await writeFile(join(artifacts, 'memory.json'), JSON.stringify(sizes, null, 2));
  assert.ok(sizes.at(-1).canvases <= 6, 'Scrolling the document must release distant page bitmaps.');

  await page.evaluate(() => { document.querySelector('.pdf-scroll').scrollTop = 0; });
  await page.waitForFunction(() => !!document.querySelector('.pdf-page canvas'));
  const pixels = await page.evaluate(() => {
    const canvas = document.querySelector('.pdf-page canvas');
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] && data[i] < 180 && data[i + 1] < 180 && data[i + 2] < 180) ink++;
    return ink;
  });
  assert.ok(pixels > 100, 'A revisited page must render its text again.');
  for (const [width, height] of [[900, 600], [1440, 920]]) {
    await page.setViewport({ width, height });
    await pause(350);
    await page.screenshot({ path: join(artifacts, `${width}x${height}.png`) });
    const overflow = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll('body *')].filter(el => el.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 12).map(el => ({ class: String(el.className), right: el.getBoundingClientRect().right })),
    }));
    assert.ok(overflow.width <= width, `The app must fit ${width}px: ${JSON.stringify(overflow)}. Screenshots: ${artifacts}`);
  }
  assert.equal(await readFile(join(ws, 'main.typ'), 'utf8'), source, 'Preview navigation must not modify the document.');
  const command = async query => {
    await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.keyboard.press('k');
    await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
    await page.waitForSelector('.palette-input');
    await page.type('.palette-input', query);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.modal-content');
  };
  const button = async text => {
    const found = await page.evaluate(text => {
      const el = [...document.querySelectorAll('.modal-content button')].find(el => el.textContent.trim() === text);
      el?.click();
      return !!el;
    }, text);
    assert.ok(found, `Button not found: ${text}`);
    await pause(100);
  };
  await command('Feynman Diagram');
  assert.equal(await page.$eval('.modal-overlay', el => getComputedStyle(el).position), 'fixed');
  await page.evaluate(() => [...document.querySelectorAll('.form-check')].find(el => el.textContent.includes('Show')).querySelector('input').click());
  const templates = await page.evaluate(() => [...document.querySelectorAll('.modal-content select')].find(el => el.options[0].text.includes('Insert template')).outerHTML);
  assert.ok(templates.includes('QCD'), 'Feynman templates must load.');
  const templateNames = await page.evaluate(() => [...[...document.querySelectorAll('.modal-content select')].find(el => el.options[0].text.includes('Insert template')).options].slice(1).map(el => el.value));
  for (const name of templateNames) {
    await page.evaluate(name => {
      const el = [...document.querySelectorAll('.modal-content select')].find(el => el.options[0].text.includes('Insert template'));
      el.value = name; el.dispatchEvent(new Event('change', { bubbles: true }));
    }, name);
    await pause(80);
    const code = await page.$eval('.modal-content pre', el => el.textContent);
    await writeFile(join(ws, 'diagram.typ'), code);
    execFileSync(process.env.TYPST_BIN || 'typst', ['compile', '--package-path', join(root, 'src-tauri/resources/typst-packages'), join(ws, 'diagram.typ'), join(ws, 'diagram.svg'), '--format', 'svg'], { timeout: 30000 });
    await page.click('[aria-label="Undo"]');
    await page.click('[aria-label="Redo"]');
    assert.equal(await page.$eval('.modal-content pre', el => el.textContent), code, `Redo restores ${name}`);
    await button('Clear');
  }
  console.log(`Feynman: ${templateNames.length} templates compile; undo/redo passed.`);
  await page.evaluate(name => {
    const el = [...document.querySelectorAll('.modal-content select')].find(el => el.options[0].text.includes('Insert template'));
    el.value = name; el.dispatchEvent(new Event('change', { bubbles: true }));
    [...document.querySelectorAll('.form-check')].find(el => el.textContent.includes('numbered figure')).querySelector('input').click();
  }, templateNames[0]);
  await page.screenshot({ path: join(artifacts, 'feynman.png') });
  await button('Insert');
  await page.waitForFunction(async () => (await (await fetch('/workspace/file?path=main.typ')).text()).includes('#align(center, canvas('), { timeout: 15000 });
  execFileSync(process.env.TYPST_BIN || 'typst', ['compile', '--package-path', join(root, 'src-tauri/resources/typst-packages'), join(ws, 'main.typ'), join(ws, 'inserted.pdf')], { timeout: 30000 });

  await command('Draw a Symbol');
  await page.waitForFunction(() => !document.querySelector('.modal-content').textContent.includes('Preparing recognizer'), { timeout: 30000 });
  const rect = await (await page.$('.modal-content canvas')).boundingBox();
  for (let i = 0; i < 72; i++) {
    const t = 2 * Math.PI * i / 71;
    const d = 1 + Math.sin(t) ** 2;
    await page.mouse.move(rect.x + 140 + 100 * Math.cos(t) / d, rect.y + 140 + 72 * Math.sin(t) * Math.cos(t) / d);
    if (i === 0) await page.mouse.down();
  }
  await page.mouse.up();
  await page.waitForSelector('.modal-content button[title="Insert  infinity"]');
  await page.screenshot({ path: join(artifacts, 'symbol.png') });
  await button('Undo stroke');
  assert.equal(await page.$$eval('.modal-content button[title^="Insert  "]', els => els.length), 0);
  await page.click('.modal-content .close-btn');
  console.log('Symbol drawing: pointer strokes recognize infinity; undo clears candidates.');

  if (process.env.TEST_PYTHON) {
    await command('Run Python');
    await page.waitForFunction(() => document.querySelectorAll('.modal-content select')[1]?.options.length > 1);
    const selects = await page.$$('.modal-content select');
    await selects[1].select(process.env.TEST_PYTHON);
    await selects[2].select('equation');
    await button('\u25b6 Run');
    await page.waitForFunction(() => [...document.querySelectorAll('.modal-content button')].some(el => el.textContent === 'Insert code + equation'), { timeout: 45000 });
    await page.type('.modal-content textarea', '\n+1');
    assert.ok(await page.evaluate(() => ![...document.querySelectorAll('.modal-content button')].some(el => el.textContent === 'Insert code + equation')), 'Editing code must hide stale equation results.');
    await page.click('.modal-content .close-btn');
    console.log('Code runner: equation run succeeds and editing invalidates stale output.');
  }

  await page.evaluate(() => [...document.querySelectorAll('.tree-file')].find(el => el.textContent.includes('drawing.excalidraw')).click());
  await page.waitForSelector('.sci-palette button[title="Insert Circle"]', { timeout: 60000 });
  await page.click('.sci-palette button[title="Insert Circle"]');
  await page.waitForFunction(() => document.querySelector('.sci-palette [role="status"]').textContent === 'Unsaved');
  await page.click('.sci-palette .btn-primary');
  await page.waitForFunction(() => document.querySelector('.sci-palette [role="status"]').textContent === 'Saved');
  const drawing = JSON.parse(await readFile(join(ws, 'drawing.excalidraw'), 'utf8'));
  assert.ok(drawing.elements.some(el => el.type === 'ellipse'), 'A scientific shape must persist in the drawing.');
  assert.ok(existsSync(join(ws, 'drawing.svg')), 'Saving must export SVG.');
  const sourceBeforeHistory = await readFile(join(ws, 'main.typ'), 'utf8');
  await page.click('.sci-palette button[title="Insert Triangle"]');
  await page.waitForFunction(() => document.querySelector('.sci-palette [role="status"]').textContent === 'Unsaved');
  await page.click('.tool-btn[title="Undo"]');
  await page.click('.tool-btn[title^="Save ("]');
  await page.waitForFunction(() => document.querySelector('.sci-palette [role="status"]').textContent === 'Saved');
  assert.equal(JSON.parse(await readFile(join(ws, 'drawing.excalidraw'), 'utf8')).elements.length, drawing.elements.length);
  await page.click('.tool-btn[title="Redo"]');
  await page.waitForFunction(() => document.querySelector('.sci-palette [role="status"]').textContent === 'Unsaved');
  await page.click('.tool-btn[title^="Save ("]');
  await page.waitForFunction(() => document.querySelector('.sci-palette [role="status"]').textContent === 'Saved');
  assert.ok(JSON.parse(await readFile(join(ws, 'drawing.excalidraw'), 'utf8')).elements.length > drawing.elements.length);
  assert.equal(await readFile(join(ws, 'main.typ'), 'utf8'), sourceBeforeHistory, 'Whiteboard history must not modify the hidden source editor.');
  await page.type('[aria-label="Search scientific shapes"]', 'pendulum');
  assert.equal(await page.$$eval('.sci-palette button[title^="Insert "]', els => els.length), 1);
  await page.screenshot({ path: join(artifacts, 'whiteboard.png') });
  await page.click('[title="Hide palette"]');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Hidden palette must not create horizontal overflow.');
  console.log('Whiteboard: shape insertion, toolbar undo/redo/save, source isolation, search and JSON/SVG save passed.');
  assert.deepEqual(errors, [], 'No uncaught browser errors.');
  console.log('External requests:', [...externalRequests]);
  console.log(`App smoke checks passed. Screenshots: ${artifacts}`);
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null && !spawnError) {
    const stopped = once(server, 'exit');
    server.kill();
    await stopped;
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
