// A symbolic result from a notebook cell is typeset, not printed as a line of
// code — and running the notebook must never swallow what someone typed while
// it was running.
//
//   TEST_PYTHON=/path/to/python-with-sympy node scripts/test-notebook-math.mjs
//
// Without a Python that has SymPy the symbolic checks are skipped; the
// edit-safety check still runs. Needs a built frontend and backend, and typst.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer';

const root = resolve(import.meta.dirname, '..');
const names = process.platform === 'win32' ? ['hilbert.exe'] : ['hilbert'];
const binary = process.env.BIN || ['debug', 'release']
  .flatMap(m => names.map(name => join(root, 'src-tauri/target', m, name))).find(existsSync);
assert.ok(binary, 'Build the backend with cargo build before running this test.');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A Python that can import sympy, either named or found among the usual ones.
const withSympy = () => {
  const tried = [process.env.TEST_PYTHON, 'python3', 'python'].filter(Boolean);
  for (const candidate of tried) {
    try {
      const path = execFileSync(candidate, ['-c', 'import sympy, sys; print(sys.executable)'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (path) return path;
    } catch {}
  }
  return null;
};
const python = withSympy();

const dir = await mkdtemp(join(tmpdir(), 'hilbert-nbmath-'));
const ws = join(dir, 'workspace');
await mkdir(ws);
const source = '= Notebook\n\n```python\nfrom sympy import *\nx = symbols("x")\nprint("the derivative is")\ndiff(sin(x)*exp(x), x)\n```\n\n';
await writeFile(join(ws, 'main.typ'), source);
const other = '= Another file\n\nNothing to do with the notebook.\n';
await writeFile(join(ws, 'other.typ'), other);
await writeFile(join(dir, 'session.json'), JSON.stringify({ workspacePath: ws, openPaths: ['main.typ'], activePath: 'main.typ', mainFile: 'main.typ' }));
await writeFile(join(dir, 'interpreters.json'), JSON.stringify({ python: python ? [{ label: 'Test Python', path: python }] : [] }));
// The notebook runs with the interpreter chosen in settings. This test has
// settings of its own, so it makes that choice itself rather than borrowing
// whatever the person running it happens to have picked.
await writeFile(join(dir, 'settings.json'), JSON.stringify(python ? { interpreters: { python } } : {}));
const token = 'hilbert-nbmath-token-0123456789abcd';
const server = spawn(binary, ['--headless'], {
  env: { ...process.env, PORT: String(Number(process.env.PORT || 3087)), TYPST_WORKSPACE: ws, TYPST_DIST: join(root, 'dist'),
    HILBERT_SESSION_FILE: join(dir, 'session.json'), HILBERT_SETTINGS_FILE: join(dir, 'settings.json'),
    HILBERT_RECOVERY_DIR: join(dir, 'recovery'), HILBERT_HISTORY_DIR: join(dir, 'history'), HILBERT_INTERPRETERS_FILE: join(dir, 'interpreters.json'), HILBERT_API_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bound = null;
for (const s of [server.stdout, server.stderr]) s.on('data', d => { bound ??= Number(/running on http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d))?.[1]) || null; });

let browser, failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
try {
  for (let i = 0; i < 200 && !bound; i++) await sleep(100);
  assert.ok(bound, 'the backend never said which port it bound');
  if (!python) console.log('  --   no Python with SymPy here; the symbolic checks are left out');
  const origin = `http://127.0.0.1:${bound}`;
  browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.setViewport({ width: 1500, height: 950 });
  await page.evaluateOnNewDocument(t => { document.cookie = `hilbert_session=${t}; path=/`; }, token);
  await page.goto(origin, { waitUntil: 'networkidle2', timeout: 90000 });
  await page.waitForSelector('.view-line', { timeout: 60000 });
  await sleep(3000);

  // The check that the maths will typeset is held up deliberately, so the
  // typing below lands in the window where the run is between its result and
  // the document.
  let preflighting = false;
  const waitForPreflight = () => { preflighting = false; };
  await page.setRequestInterception(true);
  page.on('request', async request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/template/render-preview') {
      preflighting = true;
      await sleep(5000);
    }
    try { await request.continue(); } catch {}
  });

  const run = async () => {
    const started = await page.evaluate(() => {
      const button = [...document.querySelectorAll('button')].find(b => /run notebook/i.test(b.textContent));
      button?.click();
      return !!button;
    });
    check('the Run Notebook button is there', started);
  };
  const disk = () => readFile(join(ws, 'main.typ'), 'utf8');

  await run();
  // Typed while the run is in flight — the run must splice its output into the
  // document as it is now, not as it was when the run started.
  for (let i = 0; i < 120 && !preflighting; i++) await sleep(250);
  await sleep(300);
  await page.click('.view-lines');
  await page.keyboard.down(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.keyboard.press('End');
  await page.keyboard.up(process.platform === 'darwin' ? 'Meta' : 'Control');
  await page.keyboard.type('\nTyped while the notebook was running.\n');
  let after = '';
  for (let i = 0; i < 60; i++) {
    after = await disk();
    if (after.includes('nb-output')) break;
    await sleep(500);
  }
  check('the run wrote its output', after.includes('nb-output'));
  check('and kept what was typed while it ran', after.includes('Typed while the notebook was running.'),
    'the sentence typed mid-run is gone');

  if (python) {
    check('the symbolic result is typeset, not printed', /mitex\("/.test(after) && !/exp\(x\)\*sin\(x\)/.test(after), (after.match(/mitex\("[^"]{0,60}/) || ['none'])[0]);
    check('and the printed line beside it is kept', /the derivative is/.test(after));
    check('the typesetter is imported once', (after.match(/@preview\/mitex/g) || []).length === 1);
    let compiled = '';
    try {
      execFileSync('typst', ['compile', '--root', ws, join(ws, 'main.typ'), join(dir, 'out.pdf')], { stdio: ['ignore', 'pipe', 'pipe'] });
      compiled = 'ok';
    } catch (error) { compiled = (String(error.stderr || '') + String(error.stdout || '')).trim().split('\n')[0]; }
    check('and the document compiles', compiled === 'ok', compiled);

    // Running again replaces the old output rather than stacking another copy.
    await run();
    for (let i = 0; i < 60; i++) {
      const again = await disk();
      if ((again.match(/nb-output/g) || []).length >= 2 && again !== after) { after = again; break; }
      await sleep(500);
    }
    check('running again leaves one output block', (after.match(/>>> nb-output/g) || []).length === 1,
      `${(after.match(/>>> nb-output/g) || []).length} blocks`);
  }
  if (python) {
    // Running the notebook and then looking at another file: the output has to
    // land in the notebook, and the other file must be left alone.
    await page.evaluate(() => {
      const file = [...document.querySelectorAll('.tree-file')].find(el => el.textContent.trim().startsWith('other.typ'));
      file?.click();
    });
    await sleep(1500);
    // Back to the notebook, run it, and switch away while it is checking.
    await page.evaluate(() => {
      const file = [...document.querySelectorAll('.tree-file')].find(el => el.textContent.trim().startsWith('main.typ'));
      file?.click();
    });
    await sleep(1500);
    waitForPreflight();
    await run();
    for (let i = 0; i < 120 && !preflighting; i++) await sleep(250);
    await page.evaluate(() => {
      const file = [...document.querySelectorAll('.tree-file')].find(el => el.textContent.trim().startsWith('other.typ'));
      file?.click();
    });
    await sleep(12000);
    const untouched = await readFile(join(ws, 'other.typ'), 'utf8');
    check('a file opened during the run is left alone', untouched.trim() === other.trim(),
      JSON.stringify(untouched.slice(0, 60)));
    const notebook = await disk();
    check('and the output still went to the notebook', notebook.includes('nb-output') && notebook.includes('mitex('));
  }
  check('no errors were thrown in the page', errors.length === 0, errors[0]?.slice(0, 140) || '');
} catch (error) {
  failures++;
  console.error(error);
} finally {
  await browser?.close().catch(() => {});
  server.kill(); await sleep(300); server.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `\nnotebook maths: ${failures} check(s) failed` : '\nnotebook maths: symbolic results are typeset and edits survive the run');
process.exit(failures ? 1 : 0);
