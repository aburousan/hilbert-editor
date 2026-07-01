import { useState } from 'react';

const API = 'http://localhost:3001';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

declare global { interface Window { google?: any } }

function loadGsi(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Google sign-in (no internet?).'));
    document.head.appendChild(s);
  });
}

function flattenFiles(nodes: any[]): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  for (const n of nodes) {
    if (n.type === 'directory') out.push(...flattenFiles(n.children || []));
    else if (!n.path.endsWith('.pdf')) out.push({ name: n.name, path: n.path });
  }
  return out;
}

async function ensureFolder(token: string, name: string): Promise<string> {
  const q = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json();
  if (d.files?.length) return d.files[0].id;
  const cr = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
  });
  return (await cr.json()).id;
}

async function uploadFile(token: string, folderId: string, name: string, content: string) {
  const boundary = '----typst' + Math.random().toString(36).slice(2);
  const meta = { name, parents: [folderId] };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--`;
  await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
}

export default function DriveSyncModal({ onClose, projectName = 'Typst Project' }: { onClose: () => void, projectName?: string }) {
  const [mode, setMode] = useState<'google' | 'webdav' | 'local'>('google');
  const [folder, setFolder] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [dav, setDav] = useState({
    url: localStorage.getItem('webdav_url') || '',
    username: localStorage.getItem('webdav_user') || '',
    password: '',
  });

  const syncWebdav = async () => {
    if (!dav.url.trim()) { setStatus('Enter your WebDAV URL.'); return; }
    localStorage.setItem('webdav_url', dav.url);
    localStorage.setItem('webdav_user', dav.username);
    setBusy(true); setStatus('Uploading over WebDAV…');
    try {
      const res = await fetch(`${API}/webdav/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...dav, projectName }) });
      const d = await res.json();
      setStatus(res.ok ? `✓ Uploaded ${d.count} item(s) to ${d.folder}/ over WebDAV` : `✗ ${d.error || 'Failed.'}`);
    } catch { setStatus('✗ Could not reach the local server.'); } finally { setBusy(false); }
  };

  const inputStyle: React.CSSProperties = { padding: '8px', background: 'var(--bg-color)', color: 'var(--text-main)', border: '1px solid var(--border-color)', borderRadius: '4px', width: '100%' };

  const signInAndUpload = async () => {
    const clientId = localStorage.getItem('google_client_id');
    if (!clientId) { setStatus('Set your Google OAuth Client ID in App Settings → Cloud Accounts first.'); return; }
    setBusy(true); setStatus('Opening Google sign-in…');
    try {
      await loadGsi();
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        callback: async (resp: any) => {
          if (resp.error) { setStatus('Sign-in failed: ' + resp.error); setBusy(false); return; }
          try {
            setStatus('Signed in. Fetching project files…');
            const tree = await (await fetch(`${API}/workspace`)).json();
            const files = flattenFiles(tree);
            const folderId = await ensureFolder(resp.access_token, projectName);
            let n = 0;
            for (const f of files) {
              const content = await (await fetch(`${API}/workspace/file?path=${encodeURIComponent(f.path)}`)).text();
              await uploadFile(resp.access_token, folderId, f.name, content);
              setStatus(`Uploading… ${++n}/${files.length}`);
            }
            setStatus(`✓ Uploaded ${n} file(s) to Google Drive › ${projectName}`);
          } catch (e: any) {
            setStatus('Upload error: ' + (e?.message || e));
          } finally { setBusy(false); }
        },
      });
      tokenClient.requestAccessToken();
    } catch (e: any) {
      setStatus(e?.message || 'Sign-in error'); setBusy(false);
    }
  };

  const syncLocal = async () => {
    if (!folder.trim()) { setStatus('Enter a destination folder path.'); return; }
    setBusy(true); setStatus('Copying…');
    try {
      const res = await fetch(`${API}/drive/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) });
      const d = await res.json();
      setStatus(res.ok ? `✓ Synced ${d.count} file(s) to ${d.folder}` : `✗ ${d.error || 'Failed.'}`);
    } catch { setStatus('✗ Could not reach the local server.'); } finally { setBusy(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '460px' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Sync Project</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="seg">
            <button className={mode === 'google' ? 'active' : ''} onClick={() => { setMode('google'); setStatus(''); }}>Google Drive</button>
            <button className={mode === 'webdav' ? 'active' : ''} onClick={() => { setMode('webdav'); setStatus(''); }}>WebDAV</button>
            <button className={mode === 'local' ? 'active' : ''} onClick={() => { setMode('local'); setStatus(''); }}>Local folder</button>
          </div>

          {mode === 'webdav' && (
            <>
              <p className="form-hint">Upload to any WebDAV server (Nextcloud, ownCloud, …). A subfolder named <b>{projectName}</b> is created inside the URL below, holding your source files and their compiled PDFs. Use an app password, not your main password.</p>
              <label className="form-field"><span>WebDAV URL</span>
                <input type="text" value={dav.url} onChange={e => setDav({ ...dav, url: e.target.value })} placeholder="https://cloud.example.com/remote.php/dav/files/you/Typst" style={inputStyle} />
              </label>
              <div className="form-row">
                <label className="form-field"><span>Username</span>
                  <input type="text" value={dav.username} onChange={e => setDav({ ...dav, username: e.target.value })} style={inputStyle} />
                </label>
                <label className="form-field"><span>App password</span>
                  <input type="password" value={dav.password} onChange={e => setDav({ ...dav, password: e.target.value })} style={inputStyle} />
                </label>
              </div>
              <button className="btn-primary" onClick={syncWebdav} disabled={busy} style={{ alignSelf: 'flex-start' }}>{busy ? 'Uploading…' : 'Sync over WebDAV'}</button>
            </>
          )}

          {mode === 'google' && (
            <>
              <p className="form-hint">Sign in with Google to upload this project to Drive (folder: <b>{projectName}</b>). Requires a one-time Google OAuth Client ID in App Settings → Cloud Accounts.</p>
              <button className="btn-primary" onClick={signInAndUpload} disabled={busy} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff', color: '#3c4043', border: '1px solid #dadce0', alignSelf: 'flex-start' }}>
                <svg width="16" height="16" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>
                Sign in with Google
              </button>
            </>
          )}

          {mode === 'local' && (
            <>
              <p className="form-hint">Copy the project into a local folder (e.g. your Google Drive Desktop folder, which then syncs to the cloud).</p>
              <label className="form-field"><span>Target folder (absolute path)</span>
                <input type="text" value={folder} onChange={e => setFolder(e.target.value)} placeholder="/Users/you/Google Drive/My Drive/Typst" style={inputStyle} />
              </label>
              <button className="btn-primary" onClick={syncLocal} disabled={busy} style={{ alignSelf: 'flex-start' }}>{busy ? 'Syncing…' : 'Sync to folder'}</button>
            </>
          )}

          {status && <div className="form-hint" style={{ color: status.startsWith('✓') ? '#10b981' : status.startsWith('✗') ? '#fca5a5' : 'var(--text-muted)', wordBreak: 'break-word' }}>{status}</div>}
        </div>
      </div>
    </div>
  );
}
