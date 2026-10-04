import { useEffect, useMemo, useState } from 'react';
import { API } from '../api';
import '../PackageInstaller.css';

// Help → Use in a Browser. The desktop app's own address only answers its own
// window, so opening it in a browser gives an editor that can neither load nor
// save (issue #40). The same program can serve a project to browsers properly,
// with a sign-in token, and this writes out the exact command for the project
// that is open, ready to paste into a terminal.

const PORT = 3101; // not 3001, which the desktop app itself is usually on

type Info = { exe: string; workspace: string; os: string };

const newToken = () => {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
};

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

export default function BrowserServeModal({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState('');
  const [network, setNetwork] = useState(false);
  const [copied, setCopied] = useState('');
  const token = useMemo(newToken, []);

  useEffect(() => {
    fetch(`${API}/app/serve-command`)
      .then(async response => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Not available here.');
        setInfo(await response.json());
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  const command = useMemo(() => {
    if (!info) return '';
    const bind = network ? ' --bind 0.0.0.0' : '';
    if (info.os === 'windows') {
      const env = `$env:HILBERT_SERVER_TOKEN = ${psQuote(token)}` + (network ? `; $env:ALLOW_CODE_EXECUTION = '0'` : '');
      return `${env}; & ${psQuote(info.exe)} --serve${bind} --port ${PORT} --workspace ${psQuote(info.workspace)}`;
    }
    const env = `HILBERT_SERVER_TOKEN=${shellQuote(token)}` + (network ? ' ALLOW_CODE_EXECUTION=0' : '');
    return `${env} ${shellQuote(info.exe)} --serve${bind} --port ${PORT} --workspace ${shellQuote(info.workspace)}`;
  }, [info, network, token]);

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(current => (current === label ? '' : current)), 1500);
    } catch {
      setCopied('');
    }
  };

  const code: React.CSSProperties = {
    display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'var(--font-mono, monospace)',
    fontSize: 12.5, background: 'var(--panel-lighter)', border: '1px solid var(--border-color)', borderRadius: 6, padding: '10px 12px',
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: 640, maxWidth: '94vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Use Hilbert in a browser</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13.5, lineHeight: 1.5 }}>
          {error ? <p>{error}</p> : !info ? <p>Reading the project…</p> : (
            <>
              <p style={{ margin: 0 }}>
                Hilbert can serve this project to a web browser: the same editor, preview and saving, behind a
                sign-in token. Run this in a terminal and keep the terminal open while you work. Closing it stops the server.
              </p>
              <code style={code}>{command}</code>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-primary" onClick={() => copy('command', command)}>{copied === 'command' ? 'Copied' : 'Copy command'}</button>
                <button className="btn-ghost" onClick={() => copy('token', token)}>{copied === 'token' ? 'Copied' : 'Copy token'}</button>
              </div>
              <p style={{ margin: 0 }}>
                Then open <b>http://127.0.0.1:{PORT}</b> and sign in with the token. The token is made fresh each time
                this window opens; whoever has it can edit the project, so share it only with people you work with.
              </p>
              <label className="form-check" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <input type="checkbox" checked={network} onChange={e => setNetwork(e.target.checked)} style={{ marginTop: 3 }} />
                <span>
                  Let other computers on this network connect. They open <b>http://&lt;this computer's address&gt;:{PORT}</b>.
                  Running code from the document is turned off for them. Live co-editing between browsers also needs
                  HTTPS or an SSH tunnel; see the collaboration guide.
                </span>
              </label>
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12.5 }}>
                The browser and this window work on the same files. Edit a file in one place at a time; if both change it,
                Hilbert asks which version to keep.{' '}
                <a href="https://github.com/aburousan/hilbert-editor/blob/main/docs/COLLABORATION.md#a-complete-browser-hosted-workspace" target="_blank" rel="noreferrer">Collaboration guide</a>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
