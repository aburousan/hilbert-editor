import { useState } from 'react';
import { API } from '../api';

type Fmt = 'pdf' | 'png' | 'svg' | 'html' | 'typ' | 'folder';

const FORMATS: { id: Fmt; label: string; tag?: string }[] = [
  { id: 'pdf', label: 'PDF' },
  { id: 'png', label: 'PNG' },
  { id: 'svg', label: 'SVG' },
  { id: 'html', label: 'HTML' },
  { id: 'typ', label: 'Typst' },
  { id: 'folder', label: 'Project' },
];

const PDF_STANDARDS: { v: string; label: string }[] = [
  { v: 'default', label: 'PDF 1.7 (default)' },
  { v: '1.4', label: 'PDF 1.4' },
  { v: '2.0', label: 'PDF 2.0' },
  { v: 'a-2b', label: 'PDF/A-2b (archival)' },
  { v: 'a-3b', label: 'PDF/A-3b (archival + attachments)' },
  { v: 'a-4', label: 'PDF/A-4' },
  { v: 'ua-1', label: 'PDF/UA-1 (accessible)' },
];

export default function SaveAsModal({ onClose, fileName, content, pdfUrl, projectName, mainFile }: {
  onClose: () => void;
  fileName: string;
  content: string;
  pdfUrl: string | null;
  projectName: string;
  mainFile: string;
}) {
  const [fmt, setFmt] = useState<Fmt>(() => (localStorage.getItem('export_fmt') as Fmt) || 'pdf');
  const [pages, setPages] = useState('');
  const [pdfStandard, setPdfStandard] = useState('default');
  const [tagged, setTagged] = useState(true);
  const [pretty, setPretty] = useState(false);
  const [ppi, setPpi] = useState(144);
  const [folder, setFolder] = useState(() => localStorage.getItem('export_folder') || '');
  const [openAfter, setOpenAfter] = useState(() => localStorage.getItem('export_open') !== '0');
  const [status, setStatus] = useState('');
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);

  const defaultName = (projectName || fileName.replace(/\.typ$/, '') || 'document').replace(/\s+/g, '_');
  const [nameInput, setNameInput] = useState(defaultName);
  const baseName = nameInput.trim().replace(/\s+/g, '_') || defaultName;
  const ext = fmt === 'typ' ? 'typ' : fmt === 'folder' ? '' : fmt;

  const pickFmt = (f: Fmt) => { setFmt(f); localStorage.setItem('export_fmt', f); };
  const toggleOpenAfter = (on: boolean) => { setOpenAfter(on); localStorage.setItem('export_open', on ? '1' : '0'); };

  const say = (m: string, isErr = false) => { setStatus(m); setErr(isErr); };

  const opts = () => ({
    format: fmt, name: baseName, main: mainFile, open: openAfter,
    pages: pages.trim() || undefined,
    ...(fmt === 'pdf' ? { pdfStandard, tagged } : {}),
    ...(fmt === 'png' ? { ppi } : {}),
    ...((fmt === 'pdf' || fmt === 'svg' || fmt === 'html') ? { pretty } : {}),
  });

  const download = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Browser fallback when there's no native dialog (dev in a plain browser).
  const browserFallback = async () => {
    if (fmt === 'typ') { download(new Blob([content], { type: 'text/plain' }), `${baseName}.typ`); say(`Downloaded ${baseName}.typ`); return; }
    if (fmt === 'pdf') {
      if (!pdfUrl) { say('No compiled PDF yet — recompile first.', true); return; }
      download(await (await fetch(pdfUrl)).blob(), `${baseName}.pdf`);
      say(`Downloaded ${baseName}.pdf (export options apply in the desktop app)`);
      return;
    }
    if (fmt === 'html') {
      const res = await fetch(`${API}/compile/html?main=${encodeURIComponent(mainFile)}`);
      if (!res.ok) { say('HTML export failed.', true); return; }
      download(await res.blob(), `${baseName}.html`); say(`Downloaded ${baseName}.html`); return;
    }
    say('PNG/SVG export needs the desktop app — or use “Save to folder” below.', true);
  };

  const doSave = async () => {
    setBusy(true); say('Choose where to save…');
    try {
      const res = await fetch(`${API}/export/native`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts()) });
      const d = await res.json().catch(() => ({}));
      if (d.noDialog) { await browserFallback(); return; }
      if (d.cancelled) { say(''); return; }
      if (res.ok && d.ok) say(`Saved ${d.count > 1 ? `${d.count} files → ` : '→ '}${d.target}`);
      else say(d.error || 'Export failed.', true);
    } catch { say('Could not reach the local server.', true); }
    finally { setBusy(false); }
  };

  const doSaveToFolder = async () => {
    if (!folder.trim()) { say('Enter a destination folder path.', true); return; }
    localStorage.setItem('export_folder', folder.trim());
    setBusy(true); say('Saving…');
    try {
      if (fmt === 'folder') {
        const res = await fetch(`${API}/drive/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) });
        const d = await res.json();
        say(res.ok ? `Copied ${d.count} file(s) → ${d.folder}` : (d.error || 'Failed.'), !res.ok);
      } else {
        const res = await fetch(`${API}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...opts(), folder }) });
        const d = await res.json();
        say(res.ok ? `Saved ${d.count > 1 ? `${d.count} files → ` : '→ '}${d.target}` : (d.error || 'Failed.'), !res.ok);
      }
    } catch { say('Could not reach the local server.', true); }
    finally { setBusy(false); }
  };

  const browse = async () => {
    try {
      const res = await fetch(`${API}/desktop/pick-folder`, { method: 'POST' });
      const d = await res.json();
      if (d.path) setFolder(d.path);
    } catch { /* browser: no native picker */ }
  };

  const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
  const labelTxt: React.CSSProperties = { fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '520px', maxWidth: '94vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Export</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Format picker */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
            {FORMATS.map(f => (
              <button key={f.id} onClick={() => { pickFmt(f.id); say(''); }}
                style={{
                  position: 'relative', padding: '8px 4px', borderRadius: 8, cursor: 'pointer',
                  fontSize: '0.8rem', fontWeight: 600,
                  border: `1px solid ${fmt === f.id ? 'var(--accent)' : 'var(--border-color)'}`,
                  background: fmt === f.id ? 'var(--accent-soft, rgba(139,124,246,0.15))' : 'transparent',
                  color: fmt === f.id ? 'var(--accent-hover)' : 'var(--text-color)',
                }}>
                {f.label}
                {f.tag && <span style={{ position: 'absolute', top: -6, right: -4, fontSize: '0.5rem', background: '#d97706', color: '#fff', padding: '1px 4px', borderRadius: 4 }}>{f.tag}</span>}
              </button>
            ))}
          </div>

          {/* Per-format options */}
          {fmt === 'folder' ? (
            <div className="form-hint">Copies every file in the project (the .typ source plus images, data, bibliography…) into a folder you choose below.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12, border: '1px solid var(--border-color)', borderRadius: 8 }}>
              <label style={field}>
                <span style={labelTxt}>File name</span>
                <input value={nameInput} onChange={e => setNameInput(e.target.value)} spellCheck={false} placeholder={defaultName} />
              </label>
              {fmt !== 'typ' && (
                <label style={field}>
                  <span style={labelTxt}>Pages</span>
                  <input value={pages} onChange={e => setPages(e.target.value)} placeholder="All — e.g. 1-3, 5, 8-" spellCheck={false} />
                </label>
              )}
              {fmt === 'pdf' && (
                <>
                  <label style={field}>
                    <span style={labelTxt}>PDF standard</span>
                    <select value={pdfStandard} onChange={e => setPdfStandard(e.target.value)}>
                      {PDF_STANDARDS.map(s => <option key={s.v} value={s.v}>{s.label}</option>)}
                    </select>
                  </label>
                  <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                    <label className="form-check"><input type="checkbox" checked={tagged} onChange={e => setTagged(e.target.checked)} /> Tagged (accessibility)</label>
                    <label className="form-check"><input type="checkbox" checked={pretty} onChange={e => setPretty(e.target.checked)} /> Pretty-print</label>
                  </div>
                </>
              )}
              {fmt === 'png' && (
                <label style={{ ...field, maxWidth: 200 }}>
                  <span style={labelTxt}>Resolution (PPI)</span>
                  <input type="number" min={16} max={2400} value={ppi} onChange={e => setPpi(Number(e.target.value) || 144)} />
                </label>
              )}
              {(fmt === 'svg' || fmt === 'html') && (
                <label className="form-check"><input type="checkbox" checked={pretty} onChange={e => setPretty(e.target.checked)} /> Pretty-print</label>
              )}
              {fmt === 'typ' && <div className="form-hint">Saves the source document as a plain .typ file.</div>}
            </div>
          )}

          {/* Primary: native save dialog */}
          {fmt !== 'folder' && (
            <div>
              <button className="btn-primary" disabled={busy} onClick={doSave} style={{ width: '100%' }}>Save {baseName}.{ext}…</button>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 }}>
                <span className="form-hint">Opens your system’s save dialog so you pick the exact location.</span>
                <label className="form-check" style={{ whiteSpace: 'nowrap' }}
                  title={fmt === 'svg'
                    ? 'Shows the file in Finder. SVGs open in whichever app claimed the type, which is often a source editor rather than a viewer.'
                    : 'Opens the exported file in your default app for that format.'}>
                  <input type="checkbox" checked={openAfter} onChange={e => toggleOpenAfter(e.target.checked)} />
                  {fmt === 'svg' ? ' Show in Finder when done' : ' Open when done'}
                </label>
              </div>
            </div>
          )}

          {/* Secondary: save straight to a folder path */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={labelTxt}>{fmt === 'folder' ? 'Destination folder' : 'Or save straight to a folder'}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input style={{ flex: 1 }} value={folder} onChange={e => setFolder(e.target.value)} placeholder="/Users/you/Documents/MyPaper" spellCheck={false} />
              <button className="btn-ghost" onClick={browse} title="Browse for a folder">Browse…</button>
            </div>
            <button className="btn-ghost" disabled={busy} onClick={doSaveToFolder} style={{ alignSelf: 'flex-start' }}>{fmt === 'folder' ? 'Copy project here' : 'Save to folder'}</button>
          </div>

          {status && <div className="form-hint" style={{ color: err ? '#f87171' : '#10b981' }}>{status}</div>}
        </div>
      </div>
    </div>
  );
}
