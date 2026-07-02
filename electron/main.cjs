// Electron shell: runs the local backend (which also serves the built UI) and
// opens it in a native window. Build the UI first with `npm run build`.
const { app, BrowserWindow, shell, utilityProcess, ipcMain, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');

// A GUI-launched app inherits a bare PATH (roughly /usr/bin:/bin), so it can't
// find typst/python/julia installed via Homebrew, cargo, etc. Prepend the usual
// install locations so the bundled server can spawn them.
function augmentedPath() {
  const home = os.homedir();
  const extra = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin',
    path.join(home, '.cargo', 'bin'), path.join(home, '.juliaup', 'bin'),
    path.join(home, '.local', 'bin'), '/opt/local/bin',
  ].filter(p => { try { return fs.existsSync(p); } catch { return false; } });
  return [...extra, process.env.PATH || ''].join(path.delimiter);
}
// Keep user documents in a writable location outside the app bundle.
const WORKSPACE = path.join(app.getPath('documents'), 'TypstEditor');
fs.mkdirSync(WORKSPACE, { recursive: true });

let serverProc = null;
let PKG_CACHE = null;
let PORT = 3001;

// Prefer the standard port, but fall back to an ephemeral one when it's taken —
// otherwise the window would silently attach to whatever is squatting on 3001
// (a dev server, a second instance, an unrelated app) instead of our backend.
function findFreePort(preferred) {
  const net = require('net');
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => {
      const any = net.createServer();
      any.listen(0, '127.0.0.1', () => {
        const port = any.address().port;
        any.close(() => resolve(port));
      });
    });
    probe.listen(preferred, '127.0.0.1', () => probe.close(() => resolve(preferred)));
  });
}

// Copy the Typst packages bundled with the app into a writable cache dir and
// return that dir (which contains preview/<name>/<version>). Pointing typst at
// it means documents compile on any machine with no network / no downloads.
// Newly downloaded packages also land here, so the two stay consistent.
function seedPackages() {
  const cacheRoot = path.join(app.getPath('userData'), 'typst-cache');
  const bundled = path.join(__dirname, 'typst-packages', 'preview');
  try {
    if (!fs.existsSync(bundled)) return cacheRoot;
    for (const name of fs.readdirSync(bundled)) {
      const nameDir = path.join(bundled, name);
      if (!fs.statSync(nameDir).isDirectory()) continue;
      for (const ver of fs.readdirSync(nameDir)) {
        const dst = path.join(cacheRoot, 'preview', name, ver);
        if (!fs.existsSync(dst)) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.cpSync(path.join(nameDir, ver), dst, { recursive: true });
        }
      }
    }
  } catch (e) { console.error('[typst-editor] package seed failed:', e.message); }
  return cacheRoot;
}

function startServer() {
  // NB: do NOT pass `cwd` here. Inside an AppImage the app lives on a FUSE mount,
  // and Electron's utility process aborts with "Check failed: chdir(...) == 0"
  // when told to chdir into it — the backend then never starts (blank window on
  // Linux). server.js relies only on the env vars below, not the working dir.
  serverProc = utilityProcess.fork(path.join(ROOT, 'server.js'), [], {
    stdio: 'inherit',
    env: {
      ...process.env,
      PATH: augmentedPath(),
      PORT: String(PORT),
      TYPST_WORKSPACE: WORKSPACE,
      TYPST_DIST: path.join(ROOT, 'dist'),
      ...(PKG_CACHE ? { TYPST_PACKAGE_CACHE_PATH: PKG_CACHE } : {}),
    },
  });
  // Surface a crashed backend instead of leaving a blank window.
  serverProc.on('exit', (code) => {
    if (code !== 0) console.error(`[typst-editor] backend exited with code ${code}`);
  });
}

function waitForServer(cb, tries = 0) {
  http.get(`http://127.0.0.1:${PORT}/tools`, () => cb())
    .on('error', () => (tries < 100 ? setTimeout(() => waitForServer(cb, tries + 1), 200) : cb(new Error('backend-timeout'))));
}

function createWindow(err) {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 600,
    title: 'Typst Editor',
    backgroundColor: '#0f172a',
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  if (err) {
    // Backend never came up — show a readable message rather than a blank window.
    win.loadURL('data:text/html,' + encodeURIComponent(
      `<body style="font:16px system-ui;background:#0f172a;color:#e2e8f0;padding:3rem;line-height:1.6">
       <h2>Typst Editor couldn't start its local engine.</h2>
       <p>The built-in server didn't respond. Reopen the app; if it persists, please
       report it at <a style="color:#a78bfa" href="https://github.com/aburousan/typsteditor/issues">github.com/aburousan/typsteditor/issues</a>.</p>
       </body>`));
    return;
  }
  const APP_URL = `http://127.0.0.1:${PORT}`;
  win.loadURL(APP_URL);
  // If the page fails to load or the renderer dies (a transient race while the
  // backend is warming up, etc.), retry rather than leaving a blank window.
  let reloads = 0;
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3 && reloads++ < 10) setTimeout(() => { if (!win.isDestroyed()) win.loadURL(APP_URL); }, 700);
  });
  win.webContents.on('render-process-gone', () => { if (!win.isDestroyed()) win.loadURL(APP_URL); });
  // Open external links (mailto:, https:) in the real browser, not the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// Native folder picker for "Open Folder" (renderer calls window.desktop.pickFolder()).
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Open Folder as Workspace' });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

// Is the backend currently responding?
function serverAlive(cb) {
  const req = http.get(`http://127.0.0.1:${PORT}/tools`, () => { req.destroy(); cb(true); });
  req.on('error', () => cb(false));
  req.setTimeout(1000, () => { req.destroy(); cb(false); });
}

// Make sure the backend is up (restart it if it died), then run cb.
function ensureServerThen(cb) {
  serverAlive((alive) => {
    if (alive) return cb();
    try { if (serverProc) serverProc.kill(); } catch { /* ignore */ }
    startServer();
    waitForServer(cb);
  });
}

app.whenReady().then(async () => {
  PORT = await findFreePort(3001);
  PKG_CACHE = seedPackages();
  startServer();
  waitForServer(createWindow);
});

// Reopening from the dock: the server may have been left running (good) or died —
// ensure it's up before loading the window, so we never land on a blank page.
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) ensureServerThen(createWindow); });

// On macOS keep the app AND its backend alive when the window closes, so
// reopening is instant. On Windows/Linux, quitting stops the backend.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') { if (serverProc) serverProc.kill(); app.quit(); } });
app.on('before-quit', () => { if (serverProc) serverProc.kill(); });
