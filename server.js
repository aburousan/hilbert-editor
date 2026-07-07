import express from 'express';
import cors from 'cors';
import { spawn as _spawn, execFile as _execFile, execFileSync as _execFileSync } from 'child_process';
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, cpSync, renameSync, mkdtempSync } from 'fs';
import { join, relative, dirname, resolve, sep, delimiter } from 'path';
import { tmpdir, homedir } from 'os';

// On Windows, launching a console program (typst, git, python, julia, tinymist…)
// from a GUI app pops up a black cmd window for every call. `windowsHide: true`
// suppresses it. These thin wrappers inject the flag so every call site below
// gets it for free; no effect on macOS/Linux.
const IS_WIN = process.platform === 'win32';
function spawn(cmd, args, opts = {}) { return _spawn(cmd, args, { windowsHide: true, ...opts }); }
function execFile(cmd, args, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  return _execFile(cmd, args, { windowsHide: true, ...opts }, cb);
}
function execFileSync(cmd, args, opts = {}) { return _execFileSync(cmd, args, { windowsHide: true, ...opts }); }

// Safety net: never let a stray async error (e.g. an unhandled child-process
// spawn failure) take down the whole backend — that would leave the UI stuck on
// "No preview available" with a dead server. Log and keep running instead.
process.on('uncaughtException', (err) => { console.error('[typst-editor] uncaught:', err && err.message ? err.message : err); });
process.on('unhandledRejection', (err) => { console.error('[typst-editor] unhandled rejection:', err && err.message ? err.message : err); });

const app = express();
// Only allow the local dev UI to talk to this server.
app.use(cors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] }));
app.use(express.text({ limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));

// Workspace and built-UI locations are overridable so the packaged desktop app
// can point them at writable / bundled paths.
// Mutable so "Open Folder" can repoint the whole app at another folder on disk
// (VS Code style) without moving or deleting anything.
let WORKSPACE_DIR = process.env.TYPST_WORKSPACE || join(process.cwd(), 'workspace');
if (!existsSync(WORKSPACE_DIR)) {
  mkdirSync(WORKSPACE_DIR, { recursive: true });
}

// Resolve the tinymist LSP binary. The desktop shell sets TINYMIST_BIN to the
// copy it bundles; otherwise fall back to `tinymist` on PATH. Bundling means
// hover/completion work out of the box without the user installing tinymist.
const TINYMIST_BIN = (process.env.TINYMIST_BIN && existsSync(process.env.TINYMIST_BIN))
  ? process.env.TINYMIST_BIN
  : 'tinymist';
const DIST_DIR = process.env.TYPST_DIST || join(process.cwd(), 'dist');

// Derived scratch locations — computed from the *current* workspace each call so
// they follow WORKSPACE_DIR when it is switched at runtime.
const sandboxDir = () => join(WORKSPACE_DIR, 'sandbox');
const previewCacheDir = () => join(WORKSPACE_DIR, '.previews');

// Confine a user-supplied path to the workspace, blocking `../` traversal and
// absolute paths that would escape it. Returns null when the path is unsafe.
function safeWorkspacePath(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  const target = resolve(WORKSPACE_DIR, p);
  if (target !== WORKSPACE_DIR && !target.startsWith(WORKSPACE_DIR + sep)) return null;
  return target;
}

function getTree(dir) {
  const items = readdirSync(dir);
  const result = [];
  for (const item of items) {
    if (item.startsWith('.') || item === 'node_modules' || item === 'sandbox' || item.endsWith('.pdf')) continue;
    const fullPath = join(dir, item);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      result.push({ type: 'directory', name: item, path: relative(WORKSPACE_DIR, fullPath).replace(/\\/g, '/'), children: getTree(fullPath) });
    } else {
      result.push({ type: 'file', name: item, path: relative(WORKSPACE_DIR, fullPath).replace(/\\/g, '/'), size: stat.size, mtime: stat.mtimeMs });
    }
  }
  return result;
}

app.get('/workspace', (req, res) => {
  res.json(getTree(WORKSPACE_DIR));
});

// Report / switch the workspace root folder (VS Code "Open Folder"). Switching
// just repoints the app at an existing folder on disk — nothing is copied or
// deleted, and the old folder is left untouched.
app.get('/workspace/root', (req, res) => {
  res.json({ root: WORKSPACE_DIR });
});

// Empty the current workspace (used by the browser "Open Folder", which imports
// the chosen folder's files as the new project). Removes everything at the top
// level; the folder itself stays.
app.post('/workspace/clear', (req, res) => {
  try {
    for (const item of readdirSync(WORKSPACE_DIR)) {
      if (item === '.git') continue;
      rmSync(join(WORKSPACE_DIR, item), { recursive: true, force: true });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/workspace/root', (req, res) => {
  let { path } = req.body || {};
  if (typeof path !== 'string' || !path.trim()) return res.status(400).json({ error: 'Folder path required.' });
  path = path.trim().replace(/^~(?=$|\/)/, homedir());
  let resolved;
  try {
    resolved = resolve(path);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) return res.status(400).json({ error: `Not a folder: ${resolved}` });
  } catch { return res.status(400).json({ error: 'Cannot access that folder.' }); }
  WORKSPACE_DIR = resolved;
  res.json({ ok: true, root: WORKSPACE_DIR });
});

app.get('/workspace/file', (req, res) => {
  const full = safeWorkspacePath(req.query.path);
  if (!full) return res.status(400).send('Invalid path');
  try {
    res.send(readFileSync(full, 'utf-8'));
  } catch (e) { res.status(404).send('Not found'); }
});

app.get('/workspace/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  if (!q) return res.json([]);
  
  const results = [];
  const walk = (dir) => {
    for (const item of readdirSync(dir)) {
      if (item.startsWith('.') || item === 'node_modules' || item === 'sandbox' || item.endsWith('.pdf')) continue;
      const full = join(dir, item);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        const ext = (item.split('.').pop() || '').toLowerCase();
        if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'zip', 'tar', 'gz'].includes(ext)) continue;
        try {
          const content = readFileSync(full, 'utf-8');
          if (content.toLowerCase().includes(q)) {
            const lines = content.split('\n');
            const matches = [];
            lines.forEach((line, i) => {
              if (line.toLowerCase().includes(q)) {
                matches.push({ lineNum: i + 1, text: line.trim() });
              }
            });
            if (matches.length > 0) {
              results.push({
                path: relative(WORKSPACE_DIR, full).replace(/\\/g, '/'),
                matches
              });
            }
          }
        } catch(e) {}
      }
    }
  };
  try { walk(WORKSPACE_DIR); } catch(e) {}
  res.json(results);
});

app.get('/workspace/raw', (req, res) => {
  const full = safeWorkspacePath(req.query.path);
  if (!full) return res.status(400).send('Invalid path');
  res.sendFile(full);
});

app.post('/workspace/file', (req, res) => {
  const full = safeWorkspacePath(req.query.path);
  if (!full) return res.status(400).send('Invalid path');
  try {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof req.body === 'string' ? req.body : req.body.content || '');
    res.send('OK');
  } catch (e) { res.status(500).send('Error'); }
});

// Create an (empty) directory inside the workspace.
app.post('/workspace/mkdir', (req, res) => {
  const full = safeWorkspacePath(req.query.path);
  if (!full) return res.status(400).send('Invalid path');
  try { mkdirSync(full, { recursive: true }); res.send('OK'); }
  catch (e) { res.status(500).send('Error'); }
});

// Compress multiple files into a zip archive
app.post('/workspace/compress', (req, res) => {
  const { paths, archiveName } = req.body || {};
  if (!Array.isArray(paths) || paths.length === 0) return res.status(400).json({ error: 'Paths required' });
  const outPath = safeWorkspacePath(archiveName || 'archive.zip');
  if (!outPath) return res.status(400).json({ error: 'Invalid archive name' });
  
  const validPaths = paths.map(p => safeWorkspacePath(p)).filter(Boolean);
  if (validPaths.length === 0) return res.status(400).json({ error: 'No valid paths' });
  
  try {
    const relPaths = validPaths.map(p => relative(WORKSPACE_DIR, p));
    const child = spawn('zip', ['-r', outPath, ...relPaths], { cwd: WORKSPACE_DIR });
    let done = false;
    // If `zip` isn't installed (common on Windows), spawn emits 'error' — without
    // this handler the response would hang forever. Reply once, cleanly.
    child.on('error', e => {
      if (done) return; done = true;
      res.status(500).json({ error: e.code === 'ENOENT' ? 'The `zip` command was not found on this system.' : String(e.message || e) });
    });
    child.on('close', code => {
      if (done) return; done = true;
      if (code === 0) res.json({ ok: true });
      else res.status(500).json({ error: 'Compression failed with code ' + code });
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Upload a binary asset (e.g. an image) into the workspace.
app.post('/workspace/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  const full = safeWorkspacePath(req.query.path);
  if (!full) return res.status(400).send('Invalid path');
  try {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, req.body);
    res.send('OK');
  } catch (e) { res.status(500).send('Error'); }
});

// Save a base64 data-URL image into the workspace (used by the 3D Plot Studio to
// store exactly what's shown on screen). Goes into images/ by default.
app.post('/workspace/save-image', (req, res) => {
  const { path, dataUrl } = req.body || {};
  const full = safeWorkspacePath(path);
  if (!full) return res.status(400).json({ error: 'Invalid path' });
  const m = /^data:image\/\w+;base64,(.+)$/s.exec(dataUrl || '');
  if (!m) return res.status(400).json({ error: 'Invalid image data.' });
  try {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, Buffer.from(m[1], 'base64'));
    res.json({ ok: true, path });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Copy a file within the workspace (e.g. promote a sandbox plot into images/).
app.post('/workspace/copy', (req, res) => {
  const { from, to } = req.body || {};
  const src = safeWorkspacePath(from), dst = safeWorkspacePath(to);
  if (!src || !dst) return res.status(400).json({ error: 'Invalid path' });
  try {
    if (!existsSync(src)) return res.status(404).json({ error: 'Source not found.' });
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true });
    res.json({ ok: true, path: to });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Rename a file or folder within the workspace.
app.post('/workspace/rename', (req, res) => {
  const { from, to } = req.body || {};
  const src = safeWorkspacePath(from), dst = safeWorkspacePath(to);
  if (!src || !dst) return res.status(400).json({ error: 'Invalid path' });
  try {
    if (!existsSync(src)) return res.status(404).json({ error: 'Source not found.' });
    if (existsSync(dst)) return res.status(409).json({ error: 'Destination already exists.' });
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
    res.json({ ok: true, path: to });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Reveal a file or folder in the native OS file manager.
app.post('/workspace/reveal', (req, res) => {
  const path = req.body?.path ? safeWorkspacePath(req.body.path) : WORKSPACE;
  if (!path || !existsSync(path)) return res.status(404).json({ error: 'Path not found' });
  try {
    if (IS_WIN) {
      execFile('explorer', [statSync(path).isDirectory() ? path : `/select,"${path}"`]);
    } else if (process.platform === 'darwin') {
      execFile('open', ['-R', path]);
    } else {
      execFile('xdg-open', [statSync(path).isDirectory() ? path : dirname(path)]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.delete('/workspace/file', (req, res) => {
  const full = safeWorkspacePath(req.query.path);
  if (!full || full === WORKSPACE_DIR) return res.status(400).send('Invalid path');
  try {
    if (existsSync(full) && statSync(full).isDirectory()) rmSync(full, { recursive: true, force: true });
    else unlinkSync(full);
    res.send('OK');
  } catch (e) { res.status(500).send('Error'); }
});

app.post('/compile', (req, res) => {
  const mainPath = safeWorkspacePath(req.query.main || 'main.typ');
  if (!mainPath) return res.status(400).json({ error: 'Invalid main path' });
  const outputPath = join(WORKSPACE_DIR, 'out.pdf');
  
  if (req.body && typeof req.body === 'string' && req.body.trim().length > 0) {
    try { writeFileSync(mainPath, req.body); } catch(e) {}
  }
  
  // Make any fonts the user imported into <workspace>/fonts discoverable by the
  // compiler so `#set text(font: "…")` works with custom .ttf/.otf files.
  const fontArgs = existsSync(join(WORKSPACE_DIR, 'fonts')) ? ['--font-path', 'fonts'] : [];
  const typstProcess = spawn('typst', ['compile', '--root', '.', ...fontArgs, mainPath, outputPath], { cwd: WORKSPACE_DIR });
  let stderr = '';
  let responded = false;
  typstProcess.stderr.on('data', data => { stderr += data.toString(); });

  // If `typst` isn't installed / not on PATH, spawn emits 'error' (ENOENT) — not
  // 'close'. Without this handler the unhandled error would crash the backend,
  // leaving the user with a silent "No preview available".
  typstProcess.on('error', err => {
    if (responded) return; responded = true;
    res.status(500).json({ error: err.code === 'ENOENT'
      ? 'Typst compiler not found. Install the Typst CLI (macOS: `brew install typst`; Linux: a release binary from github.com/typst/typst or `cargo install typst-cli`) so that `typst --version` works, then restart the editor.'
      : `Could not run typst: ${err.message}` });
  });

  typstProcess.on('close', code => {
    if (responded) return; responded = true;
    if (code !== 0) {
      res.status(400).json({ error: stderr || `typst exited with code ${code}` });
    } else {
      res.sendFile(outputPath);
    }
  });
});

app.post('/init-template', (req, res) => {
  const { template } = req.body;
  if (!template) return res.status(400).json({ error: 'Template name required' });

  rmSync(WORKSPACE_DIR, { recursive: true, force: true });
  const initProcess = spawn('typst', ['init', template, WORKSPACE_DIR]);

  let stderr = '', stdout = '';
  initProcess.stdout.on('data', data => { stdout += data.toString(); });
  initProcess.stderr.on('data', data => { stderr += data.toString(); });
  initProcess.on('error', e => { if (!res.headersSent) res.status(500).json({ error: e.code === 'ENOENT' ? 'Typst CLI not found — install it so `typst --version` works.' : String(e.message) }); });

  initProcess.on('close', code => {
    if (code !== 0) return res.status(400).json({ error: stderr || 'typst init failed' });

    try {
      const files = readdirSync(WORKSPACE_DIR);
      // `typst init` prints the real entrypoint, e.g. `> typst watch main.typ`.
      // Trust that over "first .typ alphabetically" so multi-file templates open
      // the correct entry (a chapter file could otherwise sort ahead of it).
      const m = (stdout + '\n' + stderr).match(/(?:watch|compile)\s+"?([^\s"]+\.typ)/);
      let entry = m && m[1];
      if (!entry || !existsSync(join(WORKSPACE_DIR, entry))) {
        entry = files.includes('main.typ') ? 'main.typ' : (files.find(f => f.endsWith('.typ')) || 'main.typ');
      }
      const content = existsSync(join(WORKSPACE_DIR, entry)) ? readFileSync(join(WORKSPACE_DIR, entry), 'utf-8') : '';
      res.json({ code: content, entrypoint: entry });
    } catch (e) {
      res.status(500).json({ error: 'Failed to read template files' });
    }
  });
});

// Typst Universe package search — self-contained (no external scripts/data).
// Fetches the official index once, caches it on disk, and matches locally so it
// works on any machine.
const UNIVERSE_INDEX_URL = 'https://packages.typst.org/preview/index.json';
const UNIVERSE_CACHE = join(tmpdir(), 'typst-editor-universe-index.json');
const UNIVERSE_TTL_MS = 24 * 3600 * 1000;
let universeCache = null;       // deduped-to-latest array
let universeCacheAt = 0;

const cmpVersion = (a, b) => {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

async function getUniverseIndex() {
  const now = Date.now();
  if (universeCache && now - universeCacheAt < UNIVERSE_TTL_MS) return universeCache;
  let raw = null;
  try {
    const r = await (typeof fetchWithTimeout === 'function' ? fetchWithTimeout(UNIVERSE_INDEX_URL, {}, 15000) : fetch(UNIVERSE_INDEX_URL));
    if (r.ok) { raw = await r.text(); try { writeFileSync(UNIVERSE_CACHE, raw); } catch {} }
  } catch { /* offline — fall through to cache */ }
  if (!raw && existsSync(UNIVERSE_CACHE)) { try { raw = readFileSync(UNIVERSE_CACHE, 'utf-8'); } catch {} }
  if (!raw) return universeCache; // may be null on a first-ever offline run
  let all;
  try { all = JSON.parse(raw); } catch { return universeCache; }
  // Keep only the latest version of each package.
  const byName = new Map();
  for (const p of all) {
    if (!p || !p.name) continue;
    const cur = byName.get(p.name);
    if (!cur || cmpVersion(p.version, cur.version) > 0) byName.set(p.name, p);
  }
  universeCache = [...byName.values()];
  universeCacheAt = now;
  return universeCache;
}

app.get('/packages', async (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  const idx = await getUniverseIndex();
  if (!idx) return res.json([]); // no network and no cache yet
  const tokens = q.split(/[^a-z0-9]+/).filter(t => t.length > 1);
  const scored = [];
  for (const p of idx) {
    const name = String(p.name || '').toLowerCase();
    const hay = `${name} ${(p.description || '')} ${(p.keywords || []).join(' ')} ${(p.categories || []).join(' ')}`.toLowerCase();
    let score = 0;
    if (!tokens.length) score = 1;
    else for (const t of tokens) { if (name.includes(t)) score += 3; else if (hay.includes(t)) score += 1; }
    if (score > 0) scored.push([score, p]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  res.json(scored.slice(0, 15).map(([, p]) => ({
    name: p.name,
    version: p.version,
    description: p.description || '',
    authors: (p.authors || []).map(a => String(a).replace(/\s*<[^>]*>/g, '').trim()).filter(Boolean),
  })));
});

// ---------------------------------------------------------------------------
// Git integration (real, via the local `git` CLI inside the workspace folder)
// ---------------------------------------------------------------------------
function git(args, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: WORKSPACE_DIR, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

const isRepo = () => existsSync(join(WORKSPACE_DIR, '.git'));

app.get('/git/status', async (req, res) => {
  if (!isRepo()) return res.json({ initialized: false });
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = await git(['status', '--porcelain']);
  const remote = await git(['remote', 'get-url', 'origin']);
  const files = status.stdout.split('\n').filter(Boolean);
  res.json({
    initialized: true,
    branch: branch.ok ? branch.stdout.trim() : 'main',
    remote: remote.ok ? remote.stdout.trim() : null,
    changes: files,
    clean: files.length === 0
  });
});

app.post('/git/init', async (req, res) => {
  if (isRepo()) return res.json({ ok: true, message: 'Repository already initialized.' });
  const init = await git(['init', '-b', 'main']);
  if (!init.ok) return res.status(500).json({ error: init.stderr || 'git init failed' });
  // Sensible defaults so commits don't fail on a fresh machine.
  await git(['config', 'user.name', 'Typst Editor']);
  await git(['config', 'user.email', 'typst-editor@localhost']);
  writeFileSync(join(WORKSPACE_DIR, '.gitignore'), '*.pdf\nout.pdf\n.DS_Store\n');
  res.json({ ok: true, message: 'Initialized empty Git repository.' });
});

app.post('/git/remote', async (req, res) => {
  if (!isRepo()) return res.status(400).json({ error: 'Repository not initialized.' });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Repository URL required.' });
  const has = await git(['remote', 'get-url', 'origin']);
  const r = has.ok ? await git(['remote', 'set-url', 'origin', url]) : await git(['remote', 'add', 'origin', url]);
  if (!r.ok) return res.status(500).json({ error: r.stderr || 'Failed to set remote.' });
  res.json({ ok: true });
});

app.post('/git/commit', async (req, res) => {
  if (!isRepo()) {
    const init = await git(['init', '-b', 'main']);
    if (!init.ok) return res.status(500).json({ error: init.stderr });
    await git(['config', 'user.name', 'Typst Editor']);
    await git(['config', 'user.email', 'typst-editor@localhost']);
  }
  const message = (req.body && req.body.message) || 'Update from Typst Editor';
  await git(['add', '-A']);
  const commit = await git(['commit', '-m', message]);
  if (!commit.ok) {
    const msg = (commit.stdout + commit.stderr).toLowerCase();
    if (msg.includes('nothing to commit')) return res.json({ ok: true, message: 'Nothing to commit — working tree clean.' });
    return res.status(500).json({ error: commit.stderr || commit.stdout || 'Commit failed.' });
  }
  res.json({ ok: true, message: commit.stdout.trim() });
});

app.post('/git/push', async (req, res) => {
  if (!isRepo()) return res.status(400).json({ error: 'Repository not initialized.' });
  const { url, token, branch } = req.body || {};
  const br = branch || 'main';
  let pushUrl = url;
  // Inject a GitHub token into the HTTPS URL so the push is non-interactive.
  if (token && url && url.startsWith('https://')) {
    pushUrl = url.replace('https://', `https://${token}@`);
  }
  if (pushUrl) {
    const setRemote = (await git(['remote', 'get-url', 'origin'])).ok
      ? await git(['remote', 'set-url', 'origin', pushUrl])
      : await git(['remote', 'add', 'origin', pushUrl]);
    if (!setRemote.ok) return res.status(500).json({ error: setRemote.stderr });
  }
  const push = await git(['push', '-u', 'origin', br]);
  // Scrub the token from any echoed output before returning it.
  const scrub = (s) => token ? s.split(token).join('***') : s;
  if (!push.ok) return res.status(500).json({ error: scrub(push.stderr || 'Push failed.') });
  res.json({ ok: true, message: scrub(push.stderr || push.stdout || 'Pushed.') });
});

app.get('/git/log', async (req, res) => {
  if (!isRepo()) return res.json({ commits: [] });
  const log = await git(['log', '--pretty=format:%h%an%ar%s', '-n', '20']);
  const commits = log.ok ? log.stdout.split('\n').filter(Boolean).map(l => {
    const [hash, author, date, subject] = l.split('');
    return { hash, author, date, subject };
  }) : [];
  res.json({ commits });
});

// ---------------------------------------------------------------------------
// Local-folder sync (works with the Google Drive Desktop synced folder)
// ---------------------------------------------------------------------------
app.post('/drive/sync', (req, res) => {
  const { folder } = req.body || {};
  if (!folder) return res.status(400).json({ error: 'Target folder path required.' });
  try {
    mkdirSync(folder, { recursive: true });
    let count = 0;
    const copyAll = (dir) => {
      for (const item of readdirSync(dir)) {
        if (item === '.DS_Store' || item === '.git' || item.endsWith('.pdf')) continue;
        const src = join(dir, item);
        const rel = relative(WORKSPACE_DIR, src);
        const dest = join(folder, rel);
        if (statSync(src).isDirectory()) { mkdirSync(dest, { recursive: true }); copyAll(src); }
        else { mkdirSync(dirname(dest), { recursive: true }); cpSync(src, dest); count++; }
      }
    };
    copyAll(WORKSPACE_DIR);
    res.json({ ok: true, count, folder });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Export a single file (compiled PDF or Typst source) into a target folder.
// ---------------------------------------------------------------------------
app.post('/export', (req, res) => {
  const { format, folder, name, main } = req.body || {};
  if (!folder) return res.status(400).json({ error: 'Destination folder required.' });
  const mainFile = main || 'main.typ';
  try {
    mkdirSync(folder, { recursive: true });
    if (format === 'typ') {
      const target = join(folder, `${name || 'document'}.typ`);
      cpSync(join(WORKSPACE_DIR, mainFile), target);
      return res.json({ ok: true, target });
    }
    if (format === 'pdf' || format === 'html') {
      const ext = format === 'html' ? 'html' : 'pdf';
      const target = join(folder, `${name || 'document'}.${ext}`);
      const args = ['compile', '--root', '.', '--format', ext, ...(format === 'html' ? ['--features', 'html'] : []), join(WORKSPACE_DIR, mainFile), target];
      const proc = spawn('typst', args, { cwd: WORKSPACE_DIR });
      let err = '';
      proc.stderr.on('data', d => { err += d.toString(); });
      proc.on('error', e => { if (!res.headersSent) res.status(500).json({ error: e.code === 'ENOENT' ? 'Typst compiler not found — install the Typst CLI so `typst --version` works.' : String(e.message) }); });
      proc.on('close', code => { if (res.headersSent) return; code === 0 ? res.json({ ok: true, target }) : res.status(400).json({ error: err || 'Compilation failed.' }); });
      return;
    }
    res.status(400).json({ error: 'Unknown format.' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Compile to HTML and return it (for in-browser download).
app.get('/compile/html', (req, res) => {
  const mainPath = safeWorkspacePath(req.query.main || 'main.typ');
  if (!mainPath) return res.status(400).json({ error: 'Invalid main path' });
  const out = join(WORKSPACE_DIR, '.out.html');
  const proc = spawn('typst', ['compile', '--root', '.', '--format', 'html', '--features', 'html', mainPath, out], { cwd: WORKSPACE_DIR });
  let err = '';
  proc.stderr.on('data', d => { err += d.toString(); });
  proc.on('error', e => { if (!res.headersSent) res.status(500).json({ error: e.code === 'ENOENT' ? 'Typst compiler not found — install the Typst CLI so `typst --version` works.' : String(e.message) }); });
  proc.on('close', code => { if (res.headersSent) return; code === 0 ? res.sendFile(out, { dotfiles: 'allow' }) : res.status(400).json({ error: err || 'HTML export failed.' }); });
});

// ---------------------------------------------------------------------------
// WebDAV sync (Nextcloud, ownCloud, any WebDAV server).
// ---------------------------------------------------------------------------
function collectWorkspace(dir = WORKSPACE_DIR, prefix = '') {
  const out = [];
  for (const item of readdirSync(dir)) {
    if (item.startsWith('.') || item === 'node_modules' || item === 'sandbox' || item.endsWith('.pdf')) continue;
    const full = join(dir, item);
    const rel = prefix ? `${prefix}/${item}` : item;
    if (statSync(full).isDirectory()) out.push(...collectWorkspace(full, rel));
    else out.push({ rel, full });
  }
  return out;
}

function compileToPdf(mainPath, outPath) {
  return new Promise((resolve) => {
    const proc = spawn('typst', ['compile', '--root', '.', mainPath, outPath], { cwd: WORKSPACE_DIR });
    const timer = setTimeout(() => proc.kill('SIGKILL'), 30000);
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
    proc.on('close', code => { clearTimeout(timer); resolve(code === 0 && existsSync(outPath)); });
  });
}

app.post('/webdav/sync', async (req, res) => {
  const { url, username, password, projectName } = req.body || {};
  if (!url) return res.status(400).json({ error: 'WebDAV URL required.' });
  const auth = 'Basic ' + Buffer.from(`${username || ''}:${password || ''}`).toString('base64');
  const root = url.endsWith('/') ? url : url + '/';
  // Everything goes inside a folder named after the project.
  const proj = String(projectName || 'Typst Project').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Typst Project';
  const base = root + encodeURIComponent(proj) + '/';

  const put = async (relPath, body) => {
    const r = await fetch(base + relPath.split('/').map(encodeURIComponent).join('/'), { method: 'PUT', headers: { Authorization: auth }, body });
    if (!r.ok && ![200, 201, 204].includes(r.status)) {
      if (r.status === 401) throw new Error('Authentication failed (check username / app password).');
      throw new Error(`Upload of ${relPath} failed (HTTP ${r.status}).`);
    }
  };

  try {
    // Create the project folder (and it also verifies auth early).
    const mk = await fetch(base, { method: 'MKCOL', headers: { Authorization: auth } });
    if (mk.status === 401) throw new Error('Authentication failed (check username / app password).');

    const files = collectWorkspace();
    const madeDirs = new Set();
    let count = 0;
    const tmp = mkdtempSync(join(tmpdir(), 'typst-dav-'));

    for (const f of files) {
      // Ensure parent collections exist inside the project folder.
      const parts = f.rel.split('/');
      let acc = '';
      for (let i = 0; i < parts.length - 1; i++) {
        acc += (acc ? '/' : '') + parts[i];
        if (!madeDirs.has(acc)) { madeDirs.add(acc); await fetch(base + acc.split('/').map(encodeURIComponent).join('/'), { method: 'MKCOL', headers: { Authorization: auth } }).catch(() => {}); }
      }
      await put(f.rel, readFileSync(f.full));
      count++;

      // Compile .typ files to PDF and upload alongside (skip ones that don't compile standalone).
      if (f.rel.endsWith('.typ')) {
        const outPdf = join(tmp, 'out.pdf');
        if (await compileToPdf(f.full, outPdf)) {
          await put(f.rel.replace(/\.typ$/, '.pdf'), readFileSync(outPdf));
          count++;
          try { unlinkSync(outPdf); } catch {}
        }
      }
    }
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    res.json({ ok: true, count, folder: proj });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Live code execution (Python / Julia / Wolfram).
//
// SANDBOX: scripts and their outputs live in workspace/sandbox so generated
// files never clobber the document source. Execution is gated by the
// ALLOW_CODE_EXECUTION env var (default ON for local use). Set it to "0" before
// exposing this server to anyone else — running arbitrary code is unsafe.
// ---------------------------------------------------------------------------
const ALLOW_EXEC = process.env.ALLOW_CODE_EXECUTION !== '0';
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.svg', '.gif'];
const EXEC_TIMEOUT_MS = Number(process.env.EXEC_TIMEOUT_MS || 45000);

// Cross-platform `which`: walk PATH ourselves rather than shelling out to the
// `which`/`where` binary (which doesn't exist / differs across OSes). On Windows
// we try each PATHEXT extension so `which('python')` matches `python.exe`.
function which(name) {
  const exts = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try { if (existsSync(p)) return p; } catch { /* unreadable dir */ }
    }
  }
  return null;
}

// A conda/venv env stores its interpreter at bin/python (Unix) or python.exe
// (Windows). Return whichever exists under `dir`, else null.
function pyIn(dir) {
  const p = IS_WIN ? join(dir, 'python.exe') : join(dir, 'bin', 'python');
  return existsSync(p) ? p : null;
}

// Discover every interpreter we can offer, so the UI can let users pick an
// environment (e.g. a specific conda env) without editing config files.
function detectInterpreters() {
  const home = homedir();
  const out = { python: [], julia: [], wolfram: [] };

  // Windows Python is usually `python.exe` (never python3) and often only
  // reachable via the `py` launcher; Unix prefers python3. Try PATH first, then
  // common install locations for each platform.
  const winFallback = IS_WIN ? [
    join(home, 'AppData', 'Local', 'Programs', 'Python'),
    'C:\\Python313', 'C:\\Python312', 'C:\\Python311', 'C:\\Python310',
  ] : [];
  const unixFallback = IS_WIN ? [] : [`${home}/miniconda3/bin/python3`, '/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'];
  const basePy = which('python3') || which('python') || (IS_WIN ? which('py') : null)
    || unixFallback.find(existsSync)
    // Windows: scan the per-user Python install dir for pythonXY\python.exe.
    || winFallback.map(d => { try { return existsSync(d) && !d.endsWith('.exe') ? readdirSync(d).map(v => join(d, v, 'python.exe')).find(existsSync) : (existsSync(join(d, 'python.exe')) ? join(d, 'python.exe') : null); } catch { return null; } }).find(Boolean)
    || null;
  if (basePy) out.python.push({ label: 'Default (python)', path: basePy });

  // conda / mamba environments — roots differ by platform.
  const condaRoots = IS_WIN
    ? ['miniconda3', 'anaconda3', 'mambaforge', 'miniforge3'].flatMap(r => [join(home, r), join('C:\\', r), join('C:\\ProgramData', r)])
    : ['miniconda3', 'anaconda3', 'mambaforge', 'miniforge3'].map(r => join(home, r));
  for (const root of condaRoots) {
    const envsDir = join(root, 'envs');
    if (existsSync(envsDir)) {
      for (const env of readdirSync(envsDir)) {
        const p = pyIn(join(envsDir, env));
        if (p) out.python.push({ label: `conda: ${env}`, path: p });
      }
    }
  }
  // pyenv / virtualenvwrapper envs (mostly Unix).
  const venvDir = join(home, '.virtualenvs');
  if (existsSync(venvDir)) for (const env of readdirSync(venvDir)) {
    const p = pyIn(join(venvDir, env));
    if (p) out.python.push({ label: `venv: ${env}`, path: p });
  }

  const jl = which('julia')
    || (IS_WIN ? [join(home, '.juliaup', 'bin', 'julia.exe'), join(home, 'AppData', 'Local', 'Programs', 'Julia', 'bin', 'julia.exe')]
                : [`${home}/.juliaup/bin/julia`, '/opt/homebrew/bin/julia', '/usr/local/bin/julia']).find(existsSync);
  if (jl) out.julia.push({ label: 'Default (julia)', path: jl });

  const wl = which('wolframscript')
    || (IS_WIN ? ['C:\\Program Files\\Wolfram Research\\WolframScript\\wolframscript.exe']
                : ['/usr/local/bin/wolframscript', '/opt/homebrew/bin/wolframscript']).find(existsSync);
  if (wl) out.wolfram.push({ label: 'WolframScript', path: wl });

  return out;
}
const INTERPRETERS = detectInterpreters();

app.get('/tools', (req, res) => {
  res.json({
    execEnabled: ALLOW_EXEC,
    interpreters: INTERPRETERS,
    available: {
      python: INTERPRETERS.python.length > 0,
      julia: INTERPRETERS.julia.length > 0,
      wolfram: INTERPRETERS.wolfram.length > 0,
    }
  });
});

const EXT = { python: 'py', julia: 'jl', wolfram: 'wls' };

// Auto-convert a result to LaTeX so users write plain maths (e.g. `D[Sin[x^2], x]`)
// and still get a typeset equation — without writing TeXForm / latex() themselves.
function wrapForEquation(lang, code) {
  const lines = code.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('//'));
  if (lines.length === 0) return code;
  if (lang === 'wolfram') {
    return `Print[ToString[TeXForm[(\n${lines.join(';\n')}\n)]]]`;
  }
  if (lang === 'python') {
    const last = lines[lines.length - 1];
    const setup = lines.slice(0, -1).join('\n');
    return `from sympy import *\nx, y, z, t, n, k, a, b, c = symbols('x y z t n k a b c')\n${setup}\nprint(latex(${last}))`;
  }
  if (lang === 'julia') {
    const last = lines[lines.length - 1];
    const setup = lines.slice(0, -1).join('\n');
    return `using Latexify\n${setup}\nprint(latexify(${last}))`;
  }
  return code;
}

// Extra safety layer: refuse code that does process spawning, networking, shell
// access or destructive file ops. Heuristic, NOT a real sandbox — see README.
const DENY = {
  common: [/\bsubprocess\b/, /\bsocket\b/, /\bos\.system\b/, /\bos\.popen\b/, /\bpopen\b/i, /\beval\s*\(/, /\bexec\s*\(/, /\b__import__\b/, /\brequests\b/, /\burllib\b/, /\bshutil\b/, /\bos\.remove\b/, /\bos\.unlink\b/, /\brmtree\b/, /\bpickle\b/, /\bctypes\b/, /\bos\.environ\b/],
  julia: [/\brun\s*\(/, /\bdownload\s*\(/, /\bSys\.\w/, /\bccall\b/, /\bpipeline\s*\(/, /\bopen\s*\(`/, /\brm\s*\(/, /\bmv\s*\(/],
  wolfram: [/\bRun\s*\[/, /\bRunProcess\s*\[/, /\bStartProcess\s*\[/, /\bDeleteFile\s*\[/, /\bDeleteDirectory\s*\[/, /\bURL(Fetch|Read|Submit|Save)\s*\[/, /\bSystemOpen\s*\[/, /\bCreateFile\s*\[/, /\bImport\s*\[\s*"https?:/i],
};
function screenCode(lang, code) {
  const patterns = [...DENY.common, ...(DENY[lang] || [])];
  for (const re of patterns) {
    const m = code.match(re);
    if (m) return m[0];
  }
  return null;
}

app.post('/run', (req, res) => {
  if (!ALLOW_EXEC) return res.status(403).json({ error: 'Code execution is disabled on this server (ALLOW_CODE_EXECUTION=0).' });
  let { lang, code, bin, outputMode } = req.body || {};
  if (!code || !lang || !EXT[lang]) return res.status(400).json({ error: 'Valid lang and code are required.' });

  const blocked = screenCode(lang, code);
  if (blocked) return res.status(400).json({ error: `Blocked for safety: code uses "${blocked}" (process/network/filesystem access is not allowed). Disable this check only if you trust the code.` });

  if (outputMode === 'equation') code = wrapForEquation(lang, code);

  // Pick the interpreter: an explicit path if it is one we detected, else the default.
  const options = INTERPRETERS[lang] || [];
  const chosen = options.find(o => o.path === bin) || options[0];
  if (!chosen) return res.status(400).json({ error: `${lang} is not available on this system.` });

  const SANDBOX_DIR = sandboxDir();
  mkdirSync(SANDBOX_DIR, { recursive: true });
  const scriptName = `_run.${EXT[lang]}`;
  const scriptPath = join(SANDBOX_DIR, scriptName);

  // Track mtimes, not just names: re-running a script that overwrites the same
  // plot (savefig("plot.png") twice) must still report it as fresh output.
  const imageStats = () => {
    const m = new Map();
    for (const f of readdirSync(SANDBOX_DIR).filter(f => IMAGE_EXT.some(e => f.toLowerCase().endsWith(e)))) {
      try { m.set(f, statSync(join(SANDBOX_DIR, f)).mtimeMs); } catch { /* raced away */ }
    }
    return m;
  };
  const before = imageStats();

  try { writeFileSync(scriptPath, code); } catch { return res.status(500).json({ error: 'Could not write script.' }); }

  // Julia: skip the user's startup.jl (often loads Revise/OhMyREPL and adds
  // seconds of latency to every run) and stay quiet — noticeably snappier.
  const args = lang === 'wolfram' ? ['-file', scriptName]
    : lang === 'julia' ? ['--startup-file=no', '-q', scriptName]
    : [scriptName];
  const child = spawn(chosen.path, args, { cwd: SANDBOX_DIR });
  let stdout = '', stderr = '', killed = false;
  const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, EXEC_TIMEOUT_MS);

  child.stdout.on('data', d => { stdout += d.toString(); });
  child.stderr.on('data', d => { stderr += d.toString(); });
  child.on('error', err => {
    clearTimeout(timer);
    res.status(500).json({ error: `Failed to start ${lang}: ${err.message}` });
  });
  child.on('close', (codeNum) => {
    clearTimeout(timer);
    // Report new OR rewritten images, referenced relative to the workspace.
    const images = [...imageStats().entries()]
      .filter(([f, t]) => !before.has(f) || before.get(f) !== t)
      .map(([f]) => `sandbox/${f}`);
    res.json({
      ok: codeNum === 0 && !killed,
      exitCode: codeNum,
      timedOut: killed,
      interpreter: chosen.label,
      stdout,
      stderr: stderr.replace(/Connecting….*?\n/g, ''), // strip WolframScript kernel noise
      images
    });
  });
});

// ---------------------------------------------------------------------------
// Render a one-page preview of a Typst Universe template (cached on disk).
// ---------------------------------------------------------------------------
app.get('/template/preview', (req, res) => {
  const name = String(req.query.name || '');
  const version = String(req.query.version || '');
  if (!/^[\w-]+$/.test(name)) return res.status(400).json({ error: 'Invalid template name.' });
  const PREVIEW_CACHE = previewCacheDir();
  mkdirSync(PREVIEW_CACHE, { recursive: true });
  const cached = join(PREVIEW_CACHE, `${name}-${version || 'latest'}.png`);
  if (existsSync(cached)) return res.sendFile(cached, { dotfiles: 'allow' });

  const dir = mkdtempSync(join(tmpdir(), 'typst-tpl-'));
  const target = join(dir, 't');
  const spec = version ? `@preview/${name}:${version}` : `@preview/${name}`;
  const done = (status, payload) => { try { rmSync(dir, { recursive: true, force: true }); } catch {} res.status(status).json(payload); };

  const init = spawn('typst', ['init', spec, target]);
  const initTimer = setTimeout(() => init.kill('SIGKILL'), 45000);
  init.on('error', () => { clearTimeout(initTimer); done(500, { error: 'typst not found' }); });
  init.on('close', code => {
    clearTimeout(initTimer);
    if (code !== 0) return done(400, { error: 'Could not scaffold template.' });
    let files;
    try { files = readdirSync(target); } catch { return done(500, { error: 'No template files.' }); }
    const main = files.find(f => /^main\.typ$/i.test(f)) || files.find(f => f.endsWith('.typ'));
    if (!main) return done(400, { error: 'No .typ entry point.' });
    const out = join(target, 'preview.png');
    const comp = spawn('typst', ['compile', '--format', 'png', '--pages', '1', join(target, main), out], { cwd: target });
    const compTimer = setTimeout(() => comp.kill('SIGKILL'), 45000);
    comp.on('close', c2 => {
      clearTimeout(compTimer);
      if (c2 !== 0 || !existsSync(out)) return done(400, { error: 'Could not render preview.' });
      try { cpSync(out, cached); } catch {}
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      res.sendFile(cached, { dotfiles: 'allow' });
    });
  });
});

// ---------------------------------------------------------------------------
// Typst package cache — list what's installed locally, and download new ones.
// ---------------------------------------------------------------------------
function typstCacheDir() {
  // In the desktop app, packages live in the app-managed cache (seeded from the
  // bundled packages) — keep the Packages UI and the compiler pointed at the
  // same place.
  if (process.env.TYPST_PACKAGE_CACHE_PATH) {
    const dir = join(process.env.TYPST_PACKAGE_CACHE_PATH, 'preview');
    try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
  }
  const home = process.env.HOME || homedir();
  return [
    join(home, 'Library', 'Caches', 'typst', 'packages', 'preview'),
    join(home, '.cache', 'typst', 'packages', 'preview'),
  ].find(existsSync) || null;
}

app.get('/packages/installed', (req, res) => {
  const dir = typstCacheDir();
  if (!dir) return res.json([]);
  const out = [];
  for (const name of readdirSync(dir)) {
    const nd = join(dir, name);
    try { if (!statSync(nd).isDirectory()) continue; } catch { continue; }
    for (const version of readdirSync(nd)) {
      let description = '', authors = [];
      try {
        const toml = readFileSync(join(nd, version, 'typst.toml'), 'utf-8');
        const dm = toml.match(/description\s*=\s*"([^"]*)"/); if (dm) description = dm[1];
        const am = toml.match(/authors\s*=\s*\[([^\]]*)\]/); if (am) authors = am[1].split(',').map(s => s.replace(/["\s]/g, '')).filter(Boolean);
      } catch {}
      out.push({ name, version, description, authors });
    }
  }
  out.sort((a, b) => a.name === b.name ? b.version.localeCompare(a.version) : a.name.localeCompare(b.name));
  res.json(out);
});

app.post('/packages/download', (req, res) => {
  const { name, version } = req.body || {};
  if (!/^[\w-]+$/.test(name || '') || !/^[\w.]+$/.test(version || '')) return res.status(400).json({ error: 'Invalid package name/version.' });
  const dir = mkdtempSync(join(tmpdir(), 'typst-pkg-'));
  const file = join(dir, 't.typ');
  writeFileSync(file, `#import "@preview/${name}:${version}"\n`);
  const proc = spawn('typst', ['compile', file, join(dir, 'o.pdf')]);
  let err = '';
  proc.stderr.on('data', d => { err += d.toString(); });
  proc.on('close', () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    // Typst fetches the package before evaluating, so it's cached even if the
    // bare import errors — verify by looking in the cache.
    const cache = typstCacheDir();
    const installed = cache && existsSync(join(cache, name, version));
    installed ? res.json({ ok: true }) : res.status(400).json({ error: err.split('\n')[0] || 'Could not download package.' });
  });
});

// ---------------------------------------------------------------------------
// Bibliography lookup — turn a DOI or arXiv id into a BibTeX entry so citations
// can be managed from inside the editor (writes go to the workspace refs.bib).
// ---------------------------------------------------------------------------
function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' }).finally(() => clearTimeout(timer));
}

const unesc = (s) => (s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const citeKey = (author, year) => {
  const last = (author || 'ref').split(/\s+and\s+/)[0].split(',')[0].trim().split(/\s+/).pop() || 'ref';
  return (last.replace(/[^a-zA-Z]/g, '') || 'ref').toLowerCase() + (year || '');
};

function arxivToBibtex(xml, id) {
  const entry = (xml.match(/<entry>([\s\S]*?)<\/entry>/) || [, ''])[1];
  if (!entry) return null;
  const title = unesc((entry.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1]);
  const authors = [...entry.matchAll(/<name>([\s\S]*?)<\/name>/g)].map(m => unesc(m[1]));
  const year = ((entry.match(/<published>(\d{4})/) || [, ''])[1]) || '';
  const doi = unesc((entry.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/) || [, ''])[1]);
  const cleanId = id.replace(/v\d+$/, '');
  const key = citeKey(authors[0] || '', year);
  const fields = [
    `  title = {${title}}`,
    `  author = {${authors.join(' and ')}}`,
    `  year = {${year}}`,
    `  eprint = {${id}}`,
    `  archivePrefix = {arXiv}`,
    doi ? `  doi = {${doi}}` : '',
    `  url = {https://arxiv.org/abs/${cleanId}}`,
  ].filter(Boolean);
  return { key, bibtex: `@article{${key},\n${fields.join(',\n')},\n}\n` };
}

app.post('/bib/fetch', async (req, res) => {
  const raw = String((req.body && req.body.id) || '').trim();
  if (!raw) return res.status(400).json({ error: 'Enter a DOI or arXiv id.' });
  try {
    // arXiv? (2101.12345, arXiv:2101.12345v2, or an arxiv.org URL)
    const arxivMatch = raw.match(/arxiv[:/ ]?\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)/i) || raw.match(/^([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)$/);
    if (arxivMatch) {
      const id = arxivMatch[1];
      const r = await fetchWithTimeout(`http://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`);
      const xml = await r.text();
      const out = arxivToBibtex(xml, id);
      if (!out) return res.status(404).json({ error: 'arXiv paper not found.' });
      return res.json(out);
    }
    // DOI? (bare 10.xxxx/… or a doi.org URL)
    const doiMatch = raw.match(/(10\.\d{4,9}\/[^\s"'<>]+)/);
    if (doiMatch) {
      const doi = doiMatch[1].replace(/[.,;]+$/, '');
      const r = await fetchWithTimeout(`https://doi.org/${doi}`, { headers: { Accept: 'application/x-bibtex; charset=utf-8' } });
      if (!r.ok) return res.status(404).json({ error: `DOI lookup failed (HTTP ${r.status}).` });
      let bibtex = (await r.text()).trim();
      if (!bibtex.startsWith('@')) return res.status(404).json({ error: 'No BibTeX returned for that DOI.' });
      const key = (bibtex.match(/@\w+\{\s*([^,\s]+)/) || [, citeKey('', '')])[1];
      return res.json({ key, bibtex: bibtex + '\n' });
    }
    res.status(400).json({ error: 'Could not recognise a DOI or arXiv id in that input.' });
  } catch (e) {
    res.status(500).json({ error: e.name === 'AbortError' ? 'Lookup timed out.' : String(e.message || e) });
  }
});

// Serve the built front-end (desktop / single-origin mode). Registered LAST so
// all API routes above take precedence; anything else falls back to the SPA.
if (existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.includes('.')) res.sendFile(join(DIST_DIR, 'index.html'));
    else next();
  });
}

// Remove a locally-cached Typst package version.
app.post('/packages/remove', (req, res) => {
  const { name, version } = req.body || {};
  if (!/^[\w-]+$/.test(name || '') || !/^[\w.]+$/.test(version || '')) return res.status(400).json({ error: 'Invalid package name/version.' });
  const dir = typstCacheDir();
  if (!dir) return res.status(400).json({ error: 'No package cache found.' });
  const target = resolve(dir, name, version);
  // Stay strictly inside the cache directory.
  if (!target.startsWith(dir + sep)) return res.status(400).json({ error: 'Invalid path.' });
  try {
    if (!existsSync(target)) return res.status(404).json({ error: 'Not installed.' });
    rmSync(target, { recursive: true, force: true });
    // Remove the now-empty name folder too.
    const nameDir = resolve(dir, name);
    try { if (readdirSync(nameDir).length === 0) rmSync(nameDir, { recursive: true, force: true }); } catch {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ─── Tinymist LSP proxy for hover/docs ─────────────────────────────────────
// Instead of piping the full LSP protocol to the browser (which requires
// monaco-languageclient, WebSockets, and careful version alignment), we keep
// a single long-lived tinymist process on the backend and expose a trivial
// REST endpoint that the frontend's Monaco hover provider can call.

let lspProcess = null;
let lspBuffer = Buffer.alloc(0);
let lspReqId = 0;
let lspPendingCallbacks = {};   // id → { resolve, timer }
let lspOpenedFiles = {};        // uri → version
let lspFileHashes = {};         // uri → hash of last-synced content
let lspInitialized = false;

// Cheap string hash (FNV-1a) so repeated hovers on an unchanged document don't
// re-send the whole text and force tinymist to re-parse it every time.
function lspHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16) + ':' + s.length;
}
let lspInitPromise = null;

function ensureLsp() {
  if (lspProcess && !lspProcess.killed) return lspInitPromise;
  lspInitialized = false;
  lspOpenedFiles = {};
  lspFileHashes = {};
  lspBuffer = Buffer.alloc(0);

  lspProcess = spawn(TINYMIST_BIN, ['lsp'], { cwd: WORKSPACE_DIR });
  lspProcess.stderr.on('data', (d) => { /* tinymist logs — silent */ });
  lspProcess.on('error', (err) => console.error('[tinymist] spawn error:', err.message));
  lspProcess.on('close', () => { lspProcess = null; lspInitialized = false; lspInitPromise = null; });

  // Parse LSP stdout (Content-Length framed JSON-RPC)
  lspProcess.stdout.on('data', (chunk) => {
    lspBuffer = Buffer.concat([lspBuffer, chunk]);
    while (true) {
      const headerEnd = lspBuffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = lspBuffer.slice(0, headerEnd).toString('utf8');
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) { lspBuffer = lspBuffer.slice(headerEnd + 4); continue; }
      const len = parseInt(match[1], 10);
      const totalLen = headerEnd + 4 + len;
      if (lspBuffer.length < totalLen) break;
      const body = lspBuffer.slice(headerEnd + 4, totalLen).toString('utf8');
      lspBuffer = lspBuffer.slice(totalLen);
      try {
        const msg = JSON.parse(body);
        if (msg.id !== undefined && lspPendingCallbacks[msg.id]) {
          const cb = lspPendingCallbacks[msg.id];
          delete lspPendingCallbacks[msg.id];
          clearTimeout(cb.timer);
          cb.resolve(msg);
        }
      } catch {}
    }
  });

  lspInitPromise = new Promise((resolve) => {
    const id = ++lspReqId;
    lspSendRaw({ jsonrpc: '2.0', id, method: 'initialize', params: {
      processId: process.pid,
      capabilities: {},
      rootUri: 'file://' + WORKSPACE_DIR,
      workspaceFolders: [{ uri: 'file://' + WORKSPACE_DIR, name: 'workspace' }],
    }});
    lspPendingCallbacks[id] = {
      resolve: (msg) => {
        // Send initialized notification
        lspSendRaw({ jsonrpc: '2.0', method: 'initialized', params: {} });
        lspInitialized = true;
        resolve();
      },
      timer: setTimeout(() => { delete lspPendingCallbacks[id]; resolve(); }, 5000),
    };
  });
  return lspInitPromise;
}

function lspSendRaw(obj) {
  if (!lspProcess || lspProcess.killed) return;
  const json = JSON.stringify(obj);
  const header = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n`;
  lspProcess.stdin.write(header + json);
}

function lspRequest(method, params, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const id = ++lspReqId;
    lspSendRaw({ jsonrpc: '2.0', id, method, params });
    const timer = setTimeout(() => { delete lspPendingCallbacks[id]; resolve(null); }, timeoutMs);
    lspPendingCallbacks[id] = { resolve: (msg) => resolve(msg.result), timer };
  });
}

function lspSyncFile(filePath, content) {
  const uri = 'file://' + filePath;
  const hash = lspHash(content);
  if (!lspOpenedFiles[uri]) {
    lspOpenedFiles[uri] = 1;
    lspFileHashes[uri] = hash;
    lspSendRaw({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
      textDocument: { uri, languageId: 'typst', version: 1, text: content },
    }});
  } else if (lspFileHashes[uri] !== hash) {
    // Only push a didChange when the text actually differs from last time.
    lspOpenedFiles[uri]++;
    lspFileHashes[uri] = hash;
    lspSendRaw({ jsonrpc: '2.0', method: 'textDocument/didChange', params: {
      textDocument: { uri, version: lspOpenedFiles[uri] },
      contentChanges: [{ text: content }],
    }});
  }
}

// POST /lsp/hover  { file: "main.typ", line: 0, character: 5, content: "..." }
// Returns { contents: "markdown string" } or { contents: null }
app.post('/lsp/hover', async (req, res) => {
  try {
    const { file, line, character, content } = req.body;
    if (typeof file !== 'string' || typeof line !== 'number' || typeof character !== 'number') {
      return res.json({ contents: null });
    }
    await ensureLsp();
    const absPath = resolve(WORKSPACE_DIR, file);
    // Sync file content so tinymist has the latest text
    lspSyncFile(absPath, content || '');
    const result = await lspRequest('textDocument/hover', {
      textDocument: { uri: 'file://' + absPath },
      position: { line, character },
    });
    if (!result || !result.contents) return res.json({ contents: null });
    // Normalise: tinymist may return a string or { kind, value }
    let md = typeof result.contents === 'string'
      ? result.contents
      : (result.contents.value || String(result.contents));
    // Strip out VSCode-specific command links (like [Open in Tab](command:tinymist...))
    md = md.replace(/\[.*?\]\(command:[^)]+\)(?:\s*\|\s*)?/g, '').trim();
    md = md.replace(/\n+---\n*$/, '').trim();
    return res.json({ contents: md, range: result.range || null });
  } catch (e) {
    return res.json({ contents: null });
  }
});

// POST /lsp/completion { file: "main.typ", line: 0, character: 5, content: "..." }
// Returns { items: [...] }
app.post('/lsp/completion', async (req, res) => {
  try {
    const { file, line, character, content } = req.body;
    if (typeof file !== 'string' || typeof line !== 'number' || typeof character !== 'number') {
      return res.json({ items: [] });
    }
    await ensureLsp();
    const absPath = resolve(WORKSPACE_DIR, file);
    lspSyncFile(absPath, content || '');
    
    // Add a tiny bit of context so completion knows we're triggering it explicitly if needed
    const result = await lspRequest('textDocument/completion', {
      textDocument: { uri: 'file://' + absPath },
      position: { line, character },
      context: { triggerKind: 1 } // Invoked
    });
    
    if (!result) return res.json({ items: [] });
    // tinymist can return an array or { isIncomplete: boolean, items: [...] }
    const items = Array.isArray(result) ? result : (result.items || []);
    return res.json({ items });
  } catch (e) {
    return res.json({ items: [] });
  }
});

// The desktop app passes PORT so it can pick a free one when 3001 is taken
// (by the dev server, another instance, or an unrelated program).
const PORT = Number(process.env.PORT) || 3001;
// Bind to loopback by default so the server is never reachable from the network.
// In Docker set HOST=0.0.0.0 and publish the port to 127.0.0.1 on the host.
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`Typst compiler server running on http://${HOST}:${PORT}`);
  console.log(`  code execution: ${ALLOW_EXEC ? 'ENABLED (sandbox/)' : 'disabled'}`);
  for (const [lang, list] of Object.entries(INTERPRETERS)) {
    if (list.length) console.log(`  ${lang}: ${list.map(o => o.label).join(', ')}`);
  }
});
