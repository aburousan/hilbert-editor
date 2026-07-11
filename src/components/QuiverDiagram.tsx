import { useEffect, useRef } from 'react';
import { notify } from '../notify';

// Draw a commutative diagram with quiver (bundled, offline) and drop the
// generated fletcher/Typst code straight into the document. quiver is embedded
// in an iframe from /quiver/; a tiny bridge we patched in answers our export
// request with the diagram as fletcher code (see public/quiver/ui.mjs).
export default function QuiverDiagram({ onClose, onInsert }: { onClose: () => void; onInsert: (code: string) => void }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data && typeof e.data.quiverExport === 'string') {
        onInsert(e.data.quiverExport);
      } else if (e.data && e.data.quiverExportError) {
        notify('Could not export the diagram: ' + e.data.quiverExportError);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onInsert]);

  const insert = () => iframeRef.current?.contentWindow?.postMessage({ quiverRequestExport: true }, '*');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '94vw', height: '90vh', maxWidth: 1500, display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Commutative Diagram (quiver)</h2>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button className="btn-primary" onClick={insert}>Insert Diagram</button>
            <button className="close-btn" onClick={onClose}>×</button>
          </div>
        </div>
        <div className="form-hint" style={{ padding: '0 20px 8px' }}>
          Draw objects and arrows, then click <b>Insert Diagram</b> — it drops in as a <code>fletcher</code> diagram (the import is added for you). Runs fully offline.
        </div>
        <iframe ref={iframeRef} src="/quiver/index.html" title="quiver" style={{ flex: 1, border: 'none', borderRadius: 8, background: '#fff', margin: '0 12px 12px' }} />
      </div>
    </div>
  );
}
