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

function startServer() {
  serverProc = utilityProcess.fork(path.join(ROOT, 'server.js'), [], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      PATH: augmentedPath(),
      TYPST_WORKSPACE: WORKSPACE,
      TYPST_DIST: path.join(ROOT, 'dist'),
    },
  });
  // Surface a crashed backend instead of leaving a blank window.
  serverProc.on('exit', (code) => {
    if (code !== 0) console.error(`[typst-editor] backend exited with code ${code}`);
  });
}

function waitForServer(cb, tries = 0) {
  http.get('http://127.0.0.1:3001/tools', () => cb())
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
       <p>The built-in server didn't respond on port 3001 — another app may be using
       that port. Quit anything on port 3001 and reopen. If it persists, please
       report it at <a style="color:#a78bfa" href="https://github.com/aburousan/typsteditor/issues">github.com/aburousan/typsteditor/issues</a>.</p>
       </body>`));
    return;
  }
  win.loadURL('http://127.0.0.1:3001');
  // Open external links (mailto:, https:) in the real browser, not the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// Native folder picker for "Open Folder" (renderer calls window.desktop.pickFolder()).
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Open Folder as Workspace' });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

app.whenReady().then(() => { startServer(); waitForServer(createWindow); });

app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (serverProc) serverProc.kill(); if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (serverProc) serverProc.kill(); });
