// Issue #52: folders before files in the file tree, on by default, switchable from View and from the
// tree's right-click menu, and remembered.
//
//   node scripts/test-tree-order.mjs     (needs npm run build and a backend: BIN=... or target/*/hilbert)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

// 1. The ordering itself.
const source = await readFile(join(root, 'src/treeOrder.ts'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
const module = { exports: {} };
Function('exports', 'module', 'require', output)(module.exports, module, () => { throw new Error('unexpected import'); });
const { orderTree } = module.exports;
const f = name => ({ type: 'file', name });
const d = (name, children) => ({ type: 'directory', name, children });
const tree = [f('a.typ'), d('content', [f('aa.typ'), d('ch-1', [f('x.typ')])]), f('data.typ'), d('images'), f('main.typ')];
const names = nodes => nodes.map(n => n.name);
check('folders come first, files keep their order', names(orderTree(tree, true)).join() === 'content,images,a.typ,data.typ,main.typ');
check('inside folders too', names(orderTree(tree, true)[0].children).join() === 'ch-1,aa.typ');
check('a folder not read yet stays as it is', orderTree(tree, true)[1].children === undefined);
check('off: the same list back', orderTree(tree, false) === tree);
check('the input is not changed', names(tree).join() === 'a.typ,content,data.typ,images,main.typ' && names(tree[1].children).join() === 'aa.typ,ch-1');

// 2. In the app.
const binary = process.env.BIN || ['release', 'debug'].map(m => join(root, 'src-tauri/target', m, 'hilbert')).find(existsSync);
assert.ok(binary, 'Build the backend first, or set BIN.');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = await mkdtemp(join(tmpdir(), 'hilbert-tree-'));
const ws = join(dir, 'ws');
for (const sub of ['Zeta', 'content/ch-1', 'images']) await mkdir(join(ws, sub), { recursive: true });
for (const file of ['main.typ', 'a.typ', 'data.typ', 'content/aa.typ', 'content/ch-1/x.typ', 'images/p.png', 'Zeta/z.typ']) await writeFile(join(ws, file), '= Test\n');
const token = 'hilbert-tree-test-token-0123456789abcd';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(process.env.PORT || 3756), TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
    HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: join(dir, 'settings.json'),
    HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'), HILBERT_API_TOKEN: token, HILBERT_COLLAB: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bound = null;
for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });
let browser;

try {
  for (let i = 0; i < 300 && !bound; i++) await sleep(100);
  assert.ok(bound, 'backend did not start');
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.setCookie({ name: 'hilbert_session', value: token, domain: '127.0.0.1', path: '/' });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const open = async () => {
    await page.goto(`http://127.0.0.1:${bound}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.file-tree [data-path="main.typ"]', { timeout: 60000 });
  };
  // The paths as drawn, one folder level: the root, or the children of `under`.
  const drawn = (under = '') => page.$$eval('.file-tree [data-path]', (els, under) => els.map(e => e.getAttribute('data-path'))
    .filter(p => under ? p.startsWith(under + '/') && !p.slice(under.length + 1).includes('/') : !p.includes('/')), under);
  const treeMenu = async label => {
    const box = await page.$eval('.file-tree', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom - 6 }; });
    await page.mouse.click(box.x, box.y, { button: 'right' });
    await page.waitForSelector('.context-menu', { timeout: 5000 });
    return page.evaluate(label => {
      const item = [...document.querySelectorAll('.context-menu .dropdown-item')].find(e => e.textContent.replace('✓', '').trim() === label);
      const checked = item?.textContent.includes('✓');
      item?.click();
      return { found: !!item, checked };
    }, label);
  };

  await open();
  check('by default the folders are on top', (await drawn()).join() === 'Zeta,content,images,a.typ,data.typ,main.typ', (await drawn()).join());
  check('and inside a folder', (await drawn('content')).join() === 'content/ch-1,content/aa.typ', (await drawn('content')).join());

  let item = await treeMenu('Folders First');
  check('the tree menu has Folders First, ticked', item.found && item.checked);
  await sleep(300);
  check('switched off: plain name order', (await drawn()).join() === 'Zeta,a.typ,content,data.typ,images,main.typ', (await drawn()).join());

  await open();
  check('off is remembered after a reload', (await drawn()).join() === 'Zeta,a.typ,content,data.typ,images,main.typ', (await drawn()).join());

  await page.evaluate(() => [...document.querySelectorAll('.menu-item')].find(m => m.firstChild?.textContent.trim() === 'View')?.click());
  const viewItem = await page.evaluate(() => {
    const item = [...document.querySelectorAll('.menu-item.open .dropdown-item')].find(e => e.textContent.includes('Folders First in File Tree'));
    const checked = item?.querySelector('.dropdown-check')?.textContent === '✓';
    item?.click();
    return { found: !!item, checked };
  });
  check('View has it too, unticked now', viewItem.found && !viewItem.checked);
  await sleep(300);
  check('switched on again from View', (await drawn()).join() === 'Zeta,content,images,a.typ,data.typ,main.typ', (await drawn()).join());
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser?.close();
  server.kill();
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\ntree order: all checks passed');
process.exit(failures ? 1 : 0);
