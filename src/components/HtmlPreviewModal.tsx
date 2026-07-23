import { useCallback, useEffect, useState } from 'react';
import { API } from '../api';

export default function HtmlPreviewModal({ mainFile, onClose }: {
  mainFile: string;
  onClose: () => void;
}) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${API}/compile/html?main=${encodeURIComponent(mainFile)}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'HTML compilation failed.');
      }
      setHtml(await response.text());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'HTML compilation failed.');
    } finally {
      setBusy(false);
    }
  }, [mainFile]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '92vw', height: '88vh', maxWidth: 1200, display: 'flex', flexDirection: 'column', padding: 0 }} onClick={event => event.stopPropagation()}>
        <div className="modal-header" style={{ padding: '12px 16px' }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            HTML Preview
            <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: '#d97706' }}>experimental</span>
          </h2>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn-ghost" disabled={busy} onClick={refresh}>{busy ? 'Compiling…' : 'Refresh'}</button>
            <button className="close-btn" onClick={onClose}>×</button>
          </div>
        </div>
        {error ? (
          <div style={{ padding: 18, color: '#f87171', whiteSpace: 'pre-wrap', overflow: 'auto' }}>{error}</div>
        ) : html ? (
          <iframe
            title="Experimental Typst HTML preview"
            srcDoc={html}
            sandbox=""
            style={{ flex: 1, width: '100%', border: 0, background: 'white' }}
          />
        ) : (
          <div className="empty-preview">{busy ? 'Generating HTML…' : 'Nothing to preview.'}</div>
        )}
      </div>
    </div>
  );
}
