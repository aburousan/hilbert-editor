import React, { useState, useEffect } from 'react';

const API = 'http://localhost:3001';

type GitStatus = {
  initialized: boolean;
  branch?: string;
  remote?: string | null;
  changes?: string[];
  clean?: boolean;
};

type Interp = { label: string; path: string };
type Tools = { execEnabled: boolean; interpreters: Record<string, Interp[]> };

export default function AppSettingsModal({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<'general' | 'interpreters' | 'git' | 'cloud'>('general');
  const [tools, setTools] = useState<Tools | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});

  useEffect(() => {
    if (activeTab !== 'interpreters' || tools) return;
    fetch(`${API}/tools`).then(r => r.json()).then((t: Tools) => {
      setTools(t);
      const init: Record<string, string> = {};
      for (const lang of Object.keys(t.interpreters)) {
        init[lang] = localStorage.getItem(`interp_${lang}`) || t.interpreters[lang][0]?.path || '';
      }
      setPicked(init);
    }).catch(() => {});
  }, [activeTab]);
  const [githubUrl, setGithubUrl] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [driveFolder, setDriveFolder] = useState('');

  const [git, setGit] = useState<GitStatus | null>(null);
  const [commitMsg, setCommitMsg] = useState('Update from Typst Editor');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string>('');

  const refreshGit = async () => {
    try {
      const res = await fetch(`${API}/git/status`);
      const data = await res.json();
      setGit(data);
      if (data.remote) setGithubUrl((u) => u || data.remote);
    } catch { setGit(null); }
  };

  useEffect(() => { if (activeTab === 'git') refreshGit(); }, [activeTab]);

  const call = async (path: string, body?: object) => {
    setBusy(true);
    setLog('Working...');
    try {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json().catch(() => ({}));
      setLog(res.ok ? (data.message || 'Done.') : (data.error || 'Failed.'));
      await refreshGit();
    } catch (e) {
      setLog('Error: could not reach local server (is it running?).');
    } finally {
      setBusy(false);
    }
  };

  const inputStyle: React.CSSProperties = { padding: '8px', background: 'var(--bg-color)', color: 'var(--text-main)', border: '1px solid var(--border-color)', borderRadius: '4px' };
  const btn = (bg: string): React.CSSProperties => ({ background: bg, color: 'white', border: 'none', padding: '8px 14px', borderRadius: '4px', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1 });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '620px', display: 'flex', height: '460px', padding: 0, overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ width: '180px', background: 'var(--panel-bg)', borderRight: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '15px', fontWeight: 'bold', borderBottom: '1px solid var(--border-color)' }}>App Settings</div>
          {(['general', 'interpreters', 'git', 'cloud'] as const).map(t => (
            <div key={t}
              style={{ padding: '10px 15px', cursor: 'pointer', background: activeTab === t ? 'var(--accent)' : 'transparent', color: activeTab === t ? 'white' : 'var(--text-main)' }}
              onClick={() => setActiveTab(t)}
            >
              {t === 'general' ? 'General' : t === 'interpreters' ? 'Interpreters' : t === 'git' ? 'Git & GitHub' : 'Cloud Accounts'}
            </div>
          ))}
        </div>

        <div style={{ flex: 1, padding: '20px', overflowY: 'auto' }}>
          <button style={{ float: 'right', background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '20px', cursor: 'pointer' }} onClick={onClose}>×</button>

          {activeTab === 'general' && (
            <div>
              <h2 style={{ marginTop: 0 }}>General Settings</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginTop: '20px' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  Default Theme:
                  <select style={inputStyle}>
                    <option>Dark Mode</option>
                    <option>Light Mode</option>
                    <option>System Default</option>
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  Editor Font Size:
                  <input type="number" defaultValue={14} style={inputStyle} />
                </label>
              </div>
            </div>
          )}

          {activeTab === 'interpreters' && (
            <div>
              <h2 style={{ marginTop: 0 }}>Code Interpreters</h2>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                Choose which environment runs each language in <b>Insert → Compute</b>. Detected from your system.
              </p>
              {tools && tools.execEnabled === false && (
                <p style={{ fontSize: '13px', color: '#fca5a5' }}>Code execution is disabled on this server (ALLOW_CODE_EXECUTION=0).</p>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginTop: '20px' }}>
                {tools && Object.entries(tools.interpreters).map(([lang, list]) => (
                  <label key={lang} style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    {lang === 'wolfram' ? 'Wolfram' : lang[0].toUpperCase() + lang.slice(1)}:
                    {list.length ? (
                      <select
                        value={picked[lang] || ''}
                        onChange={e => { setPicked(p => ({ ...p, [lang]: e.target.value })); localStorage.setItem(`interp_${lang}`, e.target.value); }}
                        style={inputStyle}
                      >
                        {list.map(o => <option key={o.path} value={o.path}>{o.label} — {o.path}</option>)}
                      </select>
                    ) : (
                      <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Not found on this system.</span>
                    )}
                  </label>
                ))}
                {!tools && <span style={{ color: 'var(--text-muted)' }}>Loading…</span>}
              </div>
            </div>
          )}

          {activeTab === 'git' && (
            <div>
              <h2 style={{ marginTop: 0 }}>Git &amp; GitHub</h2>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                Version-control your workspace locally and optionally push to GitHub.
              </p>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '12px 0', fontSize: '13px' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: git?.initialized ? (git?.clean ? '#10b981' : '#f59e0b') : '#64748b', display: 'inline-block' }} />
                {git?.initialized
                  ? <span>On branch <b>{git.branch}</b> — {git.clean ? 'clean' : `${git.changes?.length} change(s)`}{git.remote ? <> · remote set</> : null}</span>
                  : <span>No repository yet.</span>}
              </div>

              {!git?.initialized ? (
                <button style={btn('var(--accent)')} disabled={busy} onClick={() => call('/git/init')}>Initialize Repository</button>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '8px' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    Commit message:
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input type="text" value={commitMsg} onChange={e => setCommitMsg(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                      <button style={btn('#10b981')} disabled={busy} onClick={() => call('/git/commit', { message: commitMsg })}>Commit</button>
                    </div>
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    Repository URL (HTTPS):
                    <input type="text" placeholder="https://github.com/user/repo.git" value={githubUrl} onChange={e => setGithubUrl(e.target.value)} style={inputStyle} />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                    Personal Access Token (only used to push, never stored):
                    <input type="password" placeholder="ghp_..." value={githubToken} onChange={e => setGithubToken(e.target.value)} style={inputStyle} />
                  </label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button style={btn('var(--panel-lighter)')} disabled={busy || !githubUrl} onClick={() => call('/git/remote', { url: githubUrl })}>Save Remote</button>
                    <button style={btn('#6366f1')} disabled={busy || !githubUrl} onClick={() => call('/git/push', { url: githubUrl, token: githubToken, branch: git.branch })}>Commit &amp; Push</button>
                  </div>
                </div>
              )}

              {log && <div style={{ marginTop: '14px', padding: '10px', background: 'var(--bg-color)', borderRadius: '4px', fontSize: '12px', fontFamily: 'monospace', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', maxHeight: 80, overflowY: 'auto' }}>{log}</div>}
            </div>
          )}

          {activeTab === 'cloud' && (
            <div>
              <h2 style={{ marginTop: 0 }}>WebDAV (Nextcloud / ownCloud)</h2>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                Uploads to a <b>subfolder named after your project</b> (source + compiled PDFs). Credentials are stored only
                in this browser (never in the repo or the app bundle).
              </p>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                WebDAV URL:
                <input type="text" placeholder="https://cloud.example.com/remote.php/dav/files/you/Typst" defaultValue={localStorage.getItem('webdav_url') || ''}
                  onChange={e => localStorage.setItem('webdav_url', e.target.value.trim())} style={inputStyle} />
              </label>
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1 }}>
                  Username:
                  <input type="text" defaultValue={localStorage.getItem('webdav_user') || ''}
                    onChange={e => localStorage.setItem('webdav_user', e.target.value)} style={inputStyle} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', flex: 1 }}>
                  App password:
                  <input type="password" defaultValue={localStorage.getItem('webdav_pass') || ''}
                    onChange={e => localStorage.setItem('webdav_pass', e.target.value)} style={inputStyle} />
                </label>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox" defaultChecked={localStorage.getItem('webdav_autosync') === 'true'}
                  onChange={e => localStorage.setItem('webdav_autosync', e.target.checked ? 'true' : 'false')} />
                Auto-sync to WebDAV on every save (⌘S)
              </label>

              <h2 style={{ fontSize: '1rem', marginTop: 22 }}>Google Drive</h2>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                Optional. Needs a one-time OAuth <b>Client ID</b> (Google Cloud Console → Credentials → OAuth client,
                <i> Web application</i>, origin <code>http://localhost:5173</code>).
              </p>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: 18 }}>
                Google OAuth Client ID:
                <input type="text" placeholder="xxxxxxxx.apps.googleusercontent.com" defaultValue={localStorage.getItem('google_client_id') || ''}
                  onChange={e => localStorage.setItem('google_client_id', e.target.value.trim())} style={inputStyle} />
              </label>
              <h2 style={{ fontSize: '1rem' }}>Local / Folder Sync</h2>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                Alternatively, point this at your <b>Google Drive Desktop</b> folder (or any synced folder) — fully offline-friendly.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginTop: '12px' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  Sync folder (absolute path):
                  <input type="text" placeholder="/Users/you/Google Drive/My Drive/Typst" value={driveFolder} onChange={e => setDriveFolder(e.target.value)} style={inputStyle} />
                </label>
                <button style={{ ...btn('#ea4335'), alignSelf: 'flex-start' }} disabled={busy || !driveFolder} onClick={async () => {
                  setBusy(true); setLog('Syncing...');
                  try {
                    const res = await fetch(`${API}/drive/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: driveFolder }) });
                    const data = await res.json();
                    setLog(res.ok ? `Synced ${data.count} file(s) to ${data.folder}` : (data.error || 'Sync failed.'));
                  } catch { setLog('Error: could not reach local server.'); } finally { setBusy(false); }
                }}>Sync Now</button>
                {log && <div style={{ padding: '10px', background: 'var(--bg-color)', borderRadius: '4px', fontSize: '12px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{log}</div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
