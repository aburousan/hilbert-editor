// Shown when the desktop app's own address is opened in an ordinary browser.
// That address answers only the app's window, which carries a token the browser
// does not have, so the editor used to appear and then fail to load or save
// anything (issue #40). This says what happened and what to do instead.
export default function OutsideApp() {
  const page: React.CSSProperties = {
    minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, boxSizing: 'border-box',
    background: 'var(--bg-color, #14161c)', color: 'var(--text-main, #e6e8ef)',
    fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
  };
  const card: React.CSSProperties = {
    maxWidth: 620, background: 'var(--panel-bg, #1b1e26)', border: '1px solid var(--border-color, #2c3140)',
    borderRadius: 12, padding: '28px 30px', lineHeight: 1.6, fontSize: 15,
  };
  const code: React.CSSProperties = {
    display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'ui-monospace, Menlo, monospace',
    fontSize: 13, background: 'rgba(127,127,127,0.12)', borderRadius: 6, padding: '10px 12px', margin: '10px 0',
  };
  return (
    <div style={page}>
      <div style={card}>
        <h1 style={{ marginTop: 0, fontSize: 22 }}>This is the Hilbert app's private address</h1>
        <p>
          The Hilbert app on this computer uses this address for its own window only, so a browser tab here can show
          the editor but cannot open, preview or save anything.
        </p>
        <p style={{ marginBottom: 0 }}>To use Hilbert in a browser, serve a project to browsers instead:</p>
        <ul style={{ marginTop: 6 }}>
          <li>In the app, choose <b>Help → Use in a Browser…</b>. It writes the command for the project you have open.</li>
          <li>Or run it yourself, with a secret of at least 32 characters:</li>
        </ul>
        <code style={code}>HILBERT_SERVER_TOKEN=your-long-secret hilbert --serve --port 3101 --workspace /path/to/project</code>
        <p>
          Then open <b>http://127.0.0.1:3101</b> and sign in with that secret.{' '}
          <a href="https://github.com/aburousan/hilbert-editor/blob/main/docs/COLLABORATION.md#a-complete-browser-hosted-workspace" style={{ color: 'inherit' }}>
            How it works, and how to let other computers in
          </a>
        </p>
      </div>
    </div>
  );
}
