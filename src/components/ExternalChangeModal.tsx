import type React from 'react';

export type ExternalConflict = {
  path: string;
  local: string;
  disk: string;
  diskHash: string;
};

export default function ExternalChangeModal({ conflict, onReload, onKeep }: {
  conflict: ExternalConflict;
  onReload: () => void;
  onKeep: () => void;
}) {
  const pane: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    minHeight: 220,
    maxHeight: '52vh',
    overflow: 'auto',
    whiteSpace: 'pre',
    font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: 12,
    border: '1px solid var(--border-color)',
    borderRadius: 6,
    background: 'var(--bg-color)',
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ width: 920, maxWidth: '96vw' }}>
        <div className="modal-header">
          <h2>File changed outside Hilbert</h2>
        </div>
        <div className="modal-body">
          <p style={{ marginTop: 0 }}>
            <code>{conflict.path}</code> changed on disk while you had unsaved edits. Compare both versions before choosing.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 360px', minWidth: 0 }}>
              <div className="form-hint" style={{ marginBottom: 5 }}>Your unsaved version</div>
              <div style={pane}>{conflict.local}</div>
            </div>
            <div style={{ flex: '1 1 360px', minWidth: 0 }}>
              <div className="form-hint" style={{ marginBottom: 5 }}>Version currently on disk</div>
              <div style={pane}>{conflict.disk}</div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-ghost" onClick={onReload}>Reload disk version</button>
          <button className="btn-primary" onClick={onKeep}>Keep mine and overwrite</button>
        </div>
      </div>
    </div>
  );
}
