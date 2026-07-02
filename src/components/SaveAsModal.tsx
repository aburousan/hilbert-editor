import { useState } from 'react';

import { API } from '../api';

type Fmt = 'pdf' | 'html' | 'typ' | 'folder';

export default function SaveAsModal({ onClose, fileName, content, pdfUrl, projectName, mainFile }: {
  onClose: () => void;
  fileName: string;
  content: string;
  pdfUrl: string | null;
  projectName: string;
  mainFile: string;
}) {
  const [fmt, setFmt] = useState<Fmt>('pdf');
  const [folder, setFolder] = useState('');
  const [status, setStatus] = useState('');
  const baseName = (projectName || fileName.replace(/\.typ$/, '') || 'document').replace(/\s+/g, '_');

  const download = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const doDownload = async () => {
    if (fmt === 'typ') {
      download(new Blob([content], { type: 'text/plain' }), `${baseName}.typ`);
      setStatus(`Downloaded ${baseName}.typ`);
    } else if (fmt === 'pdf') {
      if (!pdfUrl) { setStatus('No compiled PDF yet — recompile first.'); return; }
      const blob = await (await fetch(pdfUrl)).blob();
      download(blob, `${baseName}.pdf`);
      setStatus(`Downloaded ${baseName}.pdf`);
    } else if (fmt === 'html') {
      setStatus('Compiling HTML…');
      const res = await fetch(`${API}/compile/html?main=${encodeURIComponent(mainFile)}`);
      if (!res.ok) { const d = await res.json().catch(() => ({})); setStatus(d.error || 'HTML export failed.'); return; }
      download(await res.blob(), `${baseName}.html`);
      setStatus(`Downloaded ${baseName}.html`);
    }
  };

  const doSaveToFolder = async () => {
    if (!folder.trim()) { setStatus('Enter a destination folder path.'); return; }
    setStatus('Saving…');
    try {
      if (fmt === 'folder') {
        const res = await fetch(`${API}/drive/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) });
        const d = await res.json();
        setStatus(res.ok ? `Saved ${d.count} file(s) to ${d.folder}` : (d.error || 'Failed.'));
      } else {
        const res = await fetch(`${API}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: fmt, folder, name: baseName, main: mainFile }) });
        const d = await res.json();
        setStatus(res.ok ? `Saved ${d.target}` : (d.error || 'Failed.'));
      }
    } catch { setStatus('Could not reach the local server.'); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '480px' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Save As / Export</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <label className="form-field">
            <span>Format</span>
            <div className="seg" style={{ flexWrap: 'wrap' }}>
              <button className={fmt === 'pdf' ? 'active' : ''} onClick={() => setFmt('pdf')}>PDF</button>
              <button className={fmt === 'html' ? 'active' : ''} onClick={() => setFmt('html')}>HTML</button>
              <button className={fmt === 'typ' ? 'active' : ''} onClick={() => setFmt('typ')}>Typst (.typ)</button>
              <button className={fmt === 'folder' ? 'active' : ''} onClick={() => setFmt('folder')}>Project folder</button>
            </div>
          </label>

          {fmt !== 'folder' && (
            <div>
              <button className="btn-primary" onClick={doDownload}>⬇ Download {baseName}.{fmt}</button>
              <div className="form-hint" style={{ marginTop: 6 }}>{fmt === 'html' ? 'Typst HTML export is experimental — layout-heavy docs may differ.' : "Uses your browser's save dialog — choose any location."}</div>
            </div>
          )}

          <label className="form-field">
            <span>{fmt === 'folder' ? 'Copy all project files into folder' : 'Or save directly into a folder (absolute path)'}</span>
            <input type="text" value={folder} onChange={e => setFolder(e.target.value)} placeholder="/Users/you/Documents/MyPaper" />
          </label>
          <button className="btn-ghost" onClick={doSaveToFolder} style={{ alignSelf: 'flex-start' }}>Save to folder</button>

          {status && <div className="form-hint" style={{ color: status.startsWith('Saved') || status.startsWith('Downloaded') ? '#10b981' : 'var(--text-muted)' }}>{status}</div>}
        </div>
      </div>
    </div>
  );
}
