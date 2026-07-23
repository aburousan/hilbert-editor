import React, { useState, useEffect } from 'react';

import { API } from '../api';

type GitStatus = {
  initialized: boolean;
  branch?: string;
  remote?: string | null;
  changes?: string[];
  clean?: boolean;
};

type Interp = { label: string; path: string; custom?: boolean };
type Tools = { execEnabled: boolean; interpreters: Record<string, Interp[]> };
type TinymistStatus = {
  available: boolean;
  running: boolean;
  path?: string;
  source?: 'bundled' | 'managed' | 'environment' | 'path';
  version?: string;
  workspace?: string;
  managedPath?: string;
};
type ToolchainStatus = {
  typst: { available: boolean; version?: string; label?: string; path?: string };
  features: { html: boolean; bundle: boolean; multiplePdfStandards: boolean; variableFonts?: boolean };
};

// An example that matches the machine the user is actually on, so the field
// shows the shape of a real answer rather than a Unix path on Windows.
function interpPlaceholder(lang: string): string {
  const windows = navigator.userAgent.includes('Windows');
  if (lang === 'julia') return windows ? String.raw`C:\Users\you\.julia\juliaup\bin\julia.exe` : '/usr/local/bin/julia';
  if (lang === 'wolfram') return windows ? String.raw`C:\Program Files\Wolfram Research\WolframScript\wolframscript.exe` : '/usr/local/bin/wolframscript';
  return windows ? String.raw`C:\path\to\project\.venv\Scripts\python.exe` : '/path/to/project/.venv/bin/python';
}

type SettingsProps = {
  onClose: () => void,
  theme: 'typst-dark' | 'typst-light', onTheme: (t: 'typst-dark' | 'typst-light') => void,
  fontSize: number, onFontSize: (n: number) => void,
  compileDelay: number, onCompileDelay: (n: number) => void,
};

export default function AppSettingsModal({ onClose, theme, onTheme, fontSize, onFontSize, compileDelay, onCompileDelay }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<'general' | 'interpreters' | 'git' | 'cloud'>('general');
  const [tools, setTools] = useState<Tools | null>(null);
  const [tinymist, setTinymist] = useState<TinymistStatus | null>(null);
  const [toolchain, setToolchain] = useState<ToolchainStatus | null>(null);
  const [tinymistBusy, setTinymistBusy] = useState(false);
  const [tinymistLog, setTinymistLog] = useState('');
  const [picked, setPicked] = useState<Record<string, string>>({});
  // Export resolution for inserted diagrams (flowchart etc.), in DPI.
  const [exportDpi, setExportDpi] = useState<number>(() => Number(localStorage.getItem('fc_export_dpi')) || 200);

  // Path the user is typing/browsing for, and the last message, per language.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [interpMsg, setInterpMsg] = useState<Record<string, string>>({});
  const [interpBusy, setInterpBusy] = useState('');

  const loadTools = async () => {
    try {
      const t: Tools = await (await fetch(`${API}/tools`)).json();
      setTools(t);
      setPicked(prev => {
        const next = { ...prev };
        for (const lang of Object.keys(t.interpreters)) {
          const list = t.interpreters[lang];
          const saved = next[lang] || localStorage.getItem(`interp_${lang}`) || '';
          // Fall back to the first entry if the remembered one has gone away
          // (environment deleted, project closed).
          next[lang] = list.some(o => o.path === saved) ? saved : (list[0]?.path || '');
        }
        return next;
      });
      return t;
    } catch { return null; }
  };

  useEffect(() => {
    if (activeTab !== 'interpreters' || tools) return;
    loadTools();
  }, [activeTab]);

  const chooseInterp = (lang: string, path: string) => {
    setPicked(p => ({ ...p, [lang]: path }));
    localStorage.setItem(`interp_${lang}`, path);
  };

  const addInterp = async (lang: string, path: string) => {
    if (!path.trim()) { setInterpMsg(m => ({ ...m, [lang]: 'Enter or browse to the interpreter first.' })); return; }
    setInterpBusy(lang);
    setInterpMsg(m => ({ ...m, [lang]: 'Checking…' }));
    try {
      const res = await fetch(`${API}/tools/interpreter`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang, path: path.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) { setInterpMsg(m => ({ ...m, [lang]: data.error || 'Could not add that interpreter.' })); return; }
      await loadTools();
      chooseInterp(lang, data.interpreter.path);
      setDraft(d => ({ ...d, [lang]: '' }));
      setInterpMsg(m => ({ ...m, [lang]: `Added ${data.interpreter.label} — now selected.` }));
    } catch {
      setInterpMsg(m => ({ ...m, [lang]: 'Could not reach the local server.' }));
    } finally { setInterpBusy(''); }
  };

  const browseInterp = async (lang: string) => {
    try {
      const res = await fetch(`${API}/tools/interpreter/pick`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.noDialog) { setInterpMsg(m => ({ ...m, [lang]: 'File picker needs the desktop app — type the path instead.' })); return; }
      if (data.path) await addInterp(lang, data.path);
    } catch {
      setInterpMsg(m => ({ ...m, [lang]: 'Could not open the file picker.' }));
    }
  };

  const removeInterp = async (lang: string, path: string) => {
    setInterpBusy(lang);
    try {
      await fetch(`${API}/tools/interpreter/remove`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang, path }),
      });
      const t = await loadTools();
      if (picked[lang] === path) chooseInterp(lang, t?.interpreters[lang]?.[0]?.path || '');
      setInterpMsg(m => ({ ...m, [lang]: 'Removed.' }));
    } catch {
      setInterpMsg(m => ({ ...m, [lang]: 'Could not reach the local server.' }));
    } finally { setInterpBusy(''); }
  };

  const refreshTinymist = async () => {
    try {
      const response = await fetch(`${API}/lsp/status`);
      setTinymist(response.ok ? await response.json() : null);
    } catch { setTinymist(null); }
  };

  const refreshToolchain = async () => {
    try {
      const response = await fetch(`${API}/toolchain/status`);
      setToolchain(response.ok ? await response.json() : null);
    } catch { setToolchain(null); }
  };

  useEffect(() => {
    if (activeTab !== 'general') return;
    refreshTinymist();
    refreshToolchain();
  }, [activeTab]);

  const restartTinymist = async () => {
    setTinymistBusy(true);
    try {
      const response = await fetch(`${API}/lsp/restart`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) setTinymistLog(data.message || 'Tinymist could not be started.');
      else {
        setTinymistLog('Tinymist restarted.');
        window.dispatchEvent(new Event('hilbert:tinymist-restarted'));
      }
      await refreshTinymist();
    } catch {
      setTinymistLog('Error: could not reach the local Tinymist manager.');
    } finally {
      setTinymistBusy(false);
    }
  };
  const [githubUrl, setGithubUrl] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [driveFolder, setDriveFolder] = useState('');

  const [git, setGit] = useState<GitStatus | null>(null);
  const [commitMsg, setCommitMsg] = useState('Update from Hilbert');
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

  const inputStyle: React.CSSProperties = { padding: '9px 11px', background: 'var(--bg-color)', color: 'var(--text-main)', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '0.9rem', fontFamily: 'inherit' };
  const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.02em' };
  const btn = (bg: string): React.CSSProperties => ({ background: bg, color: 'white', border: 'none', padding: '8px 14px', borderRadius: '4px', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1 });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '640px', maxWidth: '94vw', display: 'flex', flexDirection: 'row', height: '480px', maxHeight: '86vh', padding: 0, overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
        <div style={{ width: '180px', flex: '0 0 180px', background: 'var(--panel-bg)', borderRight: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column' }}>
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

        <div style={{ flex: 1, minWidth: 0, padding: '20px', overflowY: 'auto', overflowX: 'hidden' }}>
          <button style={{ float: 'right', background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '20px', cursor: 'pointer' }} onClick={onClose}>×</button>

          {activeTab === 'general' && (
            <div>
              <h2 style={{ marginTop: 0 }}>General Settings</h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginTop: '20px' }}>
                <label style={labelStyle}>
                  Editor theme
                  <select style={inputStyle} value={theme} onChange={e => onTheme(e.target.value as 'typst-dark' | 'typst-light')}>
                    <option value="typst-dark">Dark Mode</option>
                    <option value="typst-light">Light Mode</option>
                  </select>
                </label>
                <label style={labelStyle}>
                  Editor font size
                  <input type="number" min={10} max={24} value={fontSize} onChange={e => onFontSize(Math.min(24, Math.max(10, Number(e.target.value) || 14)))} style={inputStyle} />
                </label>
                <label style={labelStyle}>
                  Auto-compile after typing stops
                  <select style={inputStyle} value={compileDelay} onChange={e => onCompileDelay(Number(e.target.value))}>
                    <option value={100}>0.1 s — near-instant</option>
                    <option value={250}>0.25 s — fast</option>
                    <option value={500}>0.5 s — quick feedback</option>
                    <option value={1000}>1 s — balanced</option>
                    <option value={2000}>2 s — big documents</option>
                    <option value={4000}>4 s — huge documents / slow machines</option>
                  </select>
                </label>
                <label style={labelStyle}>
                  Inserted diagram quality — <b style={{ color: 'var(--text-main)' }}>{exportDpi} DPI</b>
                  <input type="range" min={96} max={500} step={8} value={exportDpi}
                    onChange={e => { const v = Number(e.target.value); setExportDpi(v); localStorage.setItem('fc_export_dpi', String(v)); }} />
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Resolution of flowchart / diagram images added to the PDF. Higher = sharper but larger files (96 draft → 500 print).</span>
                </label>
                <div style={{ padding: '12px', border: '1px solid var(--border-color)', borderRadius: 7, background: 'var(--bg-color)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: toolchain?.typst.available ? '#10b981' : '#ef4444' }} />
                    Typst compiler
                  </div>
                  <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 }}>
                    {toolchain === null ? 'Checking compiler…' : toolchain.typst.available ? (
                      <>
                        {toolchain.typst.label || `Typst ${toolchain.typst.version || ''}`}
                        {toolchain.typst.path && <div style={{ marginTop: 4, overflowWrap: 'anywhere', fontFamily: 'monospace' }}>{toolchain.typst.path}</div>}
                        <div style={{ marginTop: 7, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <span>{toolchain.features.html ? '✓' : '—'} HTML</span>
                          <span>{toolchain.features.bundle ? '✓' : '—'} Bundle</span>
                          <span>{toolchain.features.multiplePdfStandards ? '✓' : '—'} Multi-standard PDF</span>
                          <span>{toolchain.features.variableFonts ? '✓' : '—'} Variable fonts</span>
                        </div>
                        {!toolchain.features.bundle && (
                          <div style={{ marginTop: 6, color: '#f59e0b' }}>Typst 0.15 or newer is required for bundle export and combined PDF standards.</div>
                        )}
                      </>
                    ) : 'Typst was not found on PATH. Preview and export are unavailable until it is installed.'}
                  </div>
                </div>
                <div style={{ padding: '12px', border: '1px solid var(--border-color)', borderRadius: 7, background: 'var(--bg-color)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: tinymist?.running ? '#10b981' : tinymist?.available ? '#f59e0b' : '#64748b' }} />
                      Tinymist diagnostics
                    </div>
                    {tinymist?.available && (
                      <button type="button" onClick={restartTinymist} disabled={tinymistBusy}
                        style={{ ...btn('var(--accent)'), padding: '6px 10px', opacity: tinymistBusy ? 0.6 : 1 }}>
                        {tinymistBusy ? 'Restarting…' : 'Restart'}
                      </button>
                    )}
                  </div>
                  <div style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.45 }}>
                    {tinymist === null ? 'Checking availability…' : tinymist.available ? (
                      <>
                        {tinymist.version || 'Tinymist detected'} · {tinymist.source || 'system'}{tinymist.running ? ' · running' : ' · starts when a Typst file is checked'}
                        {tinymist.path && <div style={{ marginTop: 4, overflowWrap: 'anywhere', fontFamily: 'monospace' }}>{tinymist.path}</div>}
                      </>
                    ) : (
                      <>
                        Not installed. Install Tinymist on PATH, set <code>TINYMIST_BIN</code>, or place the executable at:
                        {tinymist.managedPath && <div style={{ marginTop: 4, overflowWrap: 'anywhere', fontFamily: 'monospace' }}>{tinymist.managedPath}</div>}
                      </>
                    )}
                  </div>
                </div>
                {tinymistLog && <div style={{ padding: '9px 10px', background: 'var(--bg-color)', borderRadius: 4, fontSize: 12, color: 'var(--text-muted)' }}>{tinymistLog}</div>}
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
                  All settings apply immediately and are remembered on this machine. ⌘S always compiles right away.
                </p>
              </div>
            </div>
          )}

          {activeTab === 'interpreters' && (
            <div>
              <h2 style={{ marginTop: 0 }}>Code Interpreters</h2>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                Choose which environment runs each language in <b>Insert → Compute</b>. Conda, uv, pyenv, virtualenv
                and a <code>.venv</code> in the open project are found automatically; anything else you can point at
                yourself, and it is remembered.
              </p>
              {tools && tools.execEnabled === false && (
                <p style={{ fontSize: '13px', color: '#fca5a5' }}>Code execution is disabled on this server (ALLOW_CODE_EXECUTION=0).</p>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', marginTop: '20px' }}>
                {tools && Object.entries(tools.interpreters).map(([lang, list]) => (
                  <div key={lang} style={{ ...labelStyle, gap: 7, minWidth: 0 }}>
                    {lang === 'wolfram' ? 'Wolfram' : lang[0].toUpperCase() + lang.slice(1)}
                    {list.length ? (
                      // Paths get long; without the explicit width the widest option
                      // stretches the select and the whole panel scrolls sideways.
                      <select value={picked[lang] || ''} onChange={e => chooseInterp(lang, e.target.value)}
                        style={{ ...inputStyle, width: '100%', maxWidth: '100%', boxSizing: 'border-box' }}>
                        {list.map(o => <option key={o.path} value={o.path}>{o.label} — {o.path}</option>)}
                      </select>
                    ) : (
                      <span style={{ fontSize: '13px', color: 'var(--text-muted)', fontWeight: 400 }}>
                        Not found automatically — add one below.
                      </span>
                    )}
                    <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
                      <input
                        type="text"
                        placeholder={interpPlaceholder(lang)}
                        value={draft[lang] || ''}
                        onChange={e => setDraft(d => ({ ...d, [lang]: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') addInterp(lang, draft[lang] || ''); }}
                        style={{ ...inputStyle, flex: 1, minWidth: 0, fontWeight: 400 }}
                      />
                      <button type="button" onClick={() => browseInterp(lang)} disabled={interpBusy === lang}
                        style={{ ...btn('var(--panel-lighter)'), padding: '8px 10px', whiteSpace: 'nowrap' }}>Browse…</button>
                      <button type="button" onClick={() => addInterp(lang, draft[lang] || '')} disabled={interpBusy === lang}
                        style={{ ...btn('var(--accent)'), padding: '8px 12px' }}>Add</button>
                    </div>
                    {list.filter(o => o.custom).length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {list.filter(o => o.custom).map(o => (
                          <div key={o.path} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>
                            <span style={{ flex: 1, overflowWrap: 'anywhere', fontFamily: 'monospace' }}>{o.path}</span>
                            <button type="button" title="Forget this interpreter" onClick={() => removeInterp(lang, o.path)}
                              style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>×</button>
                          </div>
                        ))}
                      </div>
                    )}
                    {interpMsg[lang] && (
                      <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>{interpMsg[lang]}</span>
                    )}
                  </div>
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
                  <label style={labelStyle}>
                    Commit message
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input type="text" value={commitMsg} onChange={e => setCommitMsg(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                      <button style={btn('#10b981')} disabled={busy} onClick={() => call('/git/commit', { message: commitMsg })}>Commit</button>
                    </div>
                  </label>

                  <label style={labelStyle}>
                    Repository URL (HTTPS)
                    <input type="text" placeholder="https://github.com/user/repo.git" value={githubUrl} onChange={e => setGithubUrl(e.target.value)} style={inputStyle} />
                  </label>
                  <label style={labelStyle}>
                    Personal access token (only used to push, never stored)
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
              <label style={labelStyle}>
                WebDAV URL
                <input type="text" placeholder="https://cloud.example.com/remote.php/dav/files/you/Typst" defaultValue={localStorage.getItem('webdav_url') || ''}
                  onChange={e => localStorage.setItem('webdav_url', e.target.value.trim())} style={inputStyle} />
              </label>
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                <label style={{ ...labelStyle, flex: 1 }}>
                  Username
                  <input type="text" defaultValue={localStorage.getItem('webdav_user') || ''}
                    onChange={e => localStorage.setItem('webdav_user', e.target.value)} style={inputStyle} />
                </label>
                <label style={{ ...labelStyle, flex: 1 }}>
                  App password
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
              <label style={{ ...labelStyle, marginBottom: 18 }}>
                Google OAuth Client ID
                <input type="text" placeholder="xxxxxxxx.apps.googleusercontent.com" defaultValue={localStorage.getItem('google_client_id') || ''}
                  onChange={e => localStorage.setItem('google_client_id', e.target.value.trim())} style={inputStyle} />
              </label>
              <h2 style={{ fontSize: '1rem' }}>Local / Folder Sync</h2>
              <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                Alternatively, point this at your <b>Google Drive Desktop</b> folder (or any synced folder) — fully offline-friendly.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', marginTop: '12px' }}>
                <label style={labelStyle}>
                  Sync folder (absolute path)
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
