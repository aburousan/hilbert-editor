// Issue #51: with several cursors, Ctrl/Cmd+/ comments every line a cursor is on, not only one.
//
//   node scripts/test-multicursor-comment.mjs     (needs npm run build and a backend: BIN=... or target/*/hilbert)
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
const dir = await mkdtemp(join(tmpdir(), 'hilbert-mc-'));
const ws = join(dir, 'ws');
await mkdir(ws);
await writeFile(join(ws, 'main.typ'), 'alpha\nbeta\ngamma\ndelta\n');
const token = 'hilbert-mc-test-token-0123456789abcd';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(process.env.PORT || 3753), TYPST_WORKSPACE: ws, TYPST_DIST: process.env.TYPST_DIST || join(root, 'dist'),
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

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const lines = () => page.$$eval('.view-line', els => els.map(e => e.textContent.replace(/\u00a0/g, ' ')).slice(0, 4));
  const press = async (...keys) => { for (const k of keys) await page.keyboard.down(k); for (const k of [...keys].reverse()) await page.keyboard.up(k); await sleep(120); };
  // Three cursors from the bottom up, as in the report: caret on line 3, then add cursors above twice.
  const line3 = (await page.$$('.view-line'))[2];
  await line3.click();
  await press(mod, 'ArrowLeft');            // Home on macOS; on others Ctrl+Left moves a word, harmless
  await press(mod, 'Alt', 'ArrowUp');
  await press(mod, 'Alt', 'ArrowUp');
  const cursors = await page.$$eval('.cursors-layer .cursor', els => els.filter(e => e.style.display !== 'none').length);
  check('three cursors made with the keyboard', cursors === 3, `${cursors}`);
  await press(mod, '/');
  const commented = await lines();
  check('Cmd/Ctrl+/ comments all three lines', JSON.stringify(commented) === JSON.stringify(['// alpha', '// beta', '// gamma', 'delta']), JSON.stringify(commented));
  await press(mod, '/');
  const back = await lines();
  check('pressed again, it uncomments all three', JSON.stringify(back) === JSON.stringify(['alpha', 'beta', 'gamma', 'delta']), JSON.stringify(back));
  await press(mod, 'z');
  const undone = await lines();
  check('one undo step per toggle', JSON.stringify(undone) === JSON.stringify(['// alpha', '// beta', '// gamma', 'delta']), JSON.stringify(undone));
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser?.close();
  server.kill();
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nmulti-cursor comment: all checks passed');
process.exit(failures ? 1 : 0);
