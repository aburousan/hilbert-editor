import { useState } from 'react';
import { API } from '../api';

type Fmt = 'pdf' | 'png' | 'svg' | 'html' | 'typ' | 'folder';

const FORMATS: { id: Fmt; label: string }[] = [
  { id: 'pdf', label: 'PDF' },
  { id: 'png', label: 'PNG' },
  { id: 'svg', label: 'SVG' },
  { id: 'html', label: 'HTML' },
  { id: 'typ', label: 'Typst' },
  { id: 'folder', label: 'Project' },
];

// A plain PDF version (the container format) is a separate axis from a
// conformance standard like PDF/A — the reviewer's point. Keep the two apart.
const PDF_VERSIONS: { v: string; label: string }[] = [
  { v: '1.4', label: '1.4' },
  { v: '1.5', label: '1.5' },
  { v: '1.6', label: '1.6' },
  { v: '1.7', label: '1.7 (default)' },
  { v: '2.0', label: '2.0' },
];

const CONFORMANCE: { v: string; label: string }[] = [
  { v: 'none', label: 'None' },
  { v: 'a-2b', label: 'PDF/A-2b — archival' },
  { v: 'a-3b', label: 'PDF/A-3b — archival + attachments' },
  { v: 'a-4', label: 'PDF/A-4' },
  { v: 'ua-1', label: 'PDF/UA-1 — accessible' },
];

// Name the reveal action after the host OS's file manager, not always "Finder".
const REVEAL = (() => {
  const p = ((navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform
    || navigator.platform || navigator.userAgent || '').toLowerCase();
  if (p.includes('win')) return 'Show in File Explorer';
  if (p.includes('mac')) return 'Show in Finder';
  return 'Show in file manager';
})();

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
  const [pdfVersion, setPdfVersion] = useState('1.7');
  const [conformance, setConformance] = useState('none');
  const [tagged, setTagged] = useState(true);
  const [pretty, setPretty] = useState(false);
  const [ppi, setPpi] = useState(144);
  const [openAfter, setOpenAfter] = useState(() => localStorage.getItem('export_open') !== '0');
  const [status, setStatus] = useState('');
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);

  const defaultName = (projectName || fileName.replace(/\.typ$/, '') || 'document').replace(/\s+/g, '_');
  const [nameInput, setNameInput] = useState(defaultName);
  const baseName = nameInput.trim().replace(/\s+/g, '_') || defaultName;
  const ext = fmt === 'typ' ? 'typ' : fmt === 'folder' ? 'zip' : fmt;

  const pickFmt = (f: Fmt) => { setFmt(f); localStorage.setItem('export_fmt', f); };
  const toggleOpenAfter = (on: boolean) => { setOpenAfter(on); localStorage.setItem('export_open', on ? '1' : '0'); };
  const say = (m: string, isErr = false) => { setStatus(m); setErr(isErr); };

  // A conformance standard implies its own PDF version, so send that alone and
  // leave the plain version out; otherwise send the chosen version (1.7 is the
  // Typst default, so it needs no flag).
  const pdfStandardValue = () =>
    conformance !== 'none' ? conformance
      : pdfVersion === '1.7' ? 'default'
        : pdfVersion;

  const opts = () => ({
    format: fmt, name: baseName, main: mainFile, open: openAfter,
    pages: pages.trim() || undefined,
    ...(fmt === 'pdf' ? { pdfStandard: pdfStandardValue(), tagged } : {}),
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
    say(`${fmt === 'folder' ? 'Project archiving' : 'PNG/SVG export'} needs the desktop app.`, true);
  };

  const doSave = async () => {
    setBusy(true); say('Choose where to save…');
    try {
      const endpoint = fmt === 'folder' ? `${API}/export/project/native` : `${API}/export/native`;
      const payload = fmt === 'folder' ? { name: baseName, open: openAfter } : opts();
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const d = await res.json().catch(() => ({}));
      if (d.noDialog) { await browserFallback(); return; }
      if (d.cancelled) { say(''); return; }
      if (res.ok && d.ok) {
        say(fmt === 'folder'
          ? `Archived ${d.count} file${d.count === 1 ? '' : 's'} → ${d.target}`
          : `Saved ${d.count > 1 ? `${d.count} files → ` : '→ '}${d.target}`);
      } else say(d.error || 'Export failed.', true);
    } catch { say('Could not reach the local server.', true); }
    finally { setBusy(false); }
  };

  const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
  const labelTxt: React.CSSProperties = { fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 };
  // Match the inputs used elsewhere in the app (settings) so they don't read as
  // unstyled browser widgets dropped into the modal.
  const inputStyle: React.CSSProperties = {
    padding: '9px 11px', background: 'var(--bg-color)', color: 'var(--text-main)',
    border: '1px solid var(--border-color)', borderRadius: 6, fontSize: '0.88rem',
    fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
  };

  const revealOrOpen = fmt === 'folder' || fmt === 'svg';

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
                  padding: '8px 4px', borderRadius: 8, cursor: 'pointer',
                  fontSize: '0.8rem', fontWeight: 600,
                  border: `1px solid ${fmt === f.id ? 'var(--accent)' : 'var(--border-color)'}`,
                  background: fmt === f.id ? 'var(--accent-soft, rgba(139,124,246,0.15))' : 'transparent',
                  color: fmt === f.id ? 'var(--accent-hover)' : 'var(--text-color)',
                }}>
                {f.label}
              </button>
            ))}
          </div>

          {/* Per-format options — a stable min height keeps the Save button from
              hopping as you switch between formats. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12, border: '1px solid var(--border-color)', borderRadius: 8, minHeight: 132 }}>
            <label style={field}>
              <span style={labelTxt}>File name</span>
              <input style={inputStyle} value={nameInput} onChange={e => setNameInput(e.target.value)} spellCheck={false} placeholder={defaultName} />
            </label>

            {fmt !== 'typ' && fmt !== 'folder' && (
              <label style={field}>
                <span style={labelTxt}>Pages</span>
                <input style={inputStyle} value={pages} onChange={e => setPages(e.target.value)} placeholder="All — e.g. 1-3, 5, 8-" spellCheck={false} />
              </label>
            )}

            {fmt === 'pdf' && (
              <>
                <div style={{ display: 'flex', gap: 12 }}>
                  <label style={{ ...field, flex: 1 }}>
                    <span style={labelTxt}>PDF version</span>
                    <select style={{ ...inputStyle, opacity: conformance === 'none' ? 1 : 0.5 }} value={pdfVersion}
                      disabled={conformance !== 'none'} onChange={e => setPdfVersion(e.target.value)}>
                      {PDF_VERSIONS.map(s => <option key={s.v} value={s.v}>{s.label}</option>)}
                    </select>
                  </label>
                  <label style={{ ...field, flex: 1 }}>
                    <span style={labelTxt}>Conformance</span>
                    <select style={inputStyle} value={conformance} onChange={e => setConformance(e.target.value)}>
                      {CONFORMANCE.map(s => <option key={s.v} value={s.v}>{s.label}</option>)}
                    </select>
                  </label>
                </div>
                {conformance !== 'none' && (
                  <span className="form-hint" style={{ marginTop: -4 }}>The conformance standard sets its own PDF version.</span>
                )}
                <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                  <label className="form-check"><input type="checkbox" checked={tagged} onChange={e => setTagged(e.target.checked)} /> Tagged (accessibility)</label>
                  <label className="form-check"><input type="checkbox" checked={pretty} onChange={e => setPretty(e.target.checked)} /> Pretty-print</label>
                </div>
              </>
            )}

            {fmt === 'png' && (
              <label style={{ ...field, maxWidth: 200 }}>
                <span style={labelTxt}>Resolution (PPI)</span>
                <input style={inputStyle} type="number" min={16} max={2400} value={ppi} onChange={e => setPpi(Number(e.target.value) || 144)} />
              </label>
            )}

            {(fmt === 'svg' || fmt === 'html') && (
              <label className="form-check"><input type="checkbox" checked={pretty} onChange={e => setPretty(e.target.checked)} /> Pretty-print</label>
            )}

            {fmt === 'typ' && <div className="form-hint">Saves the source document as a plain .typ file.</div>}
            {fmt === 'folder' && <div className="form-hint">Bundles the whole project — the .typ source plus images, data and bibliography — into a single .zip archive.</div>}
          </div>

          {/* Native save dialog — the one and only save path. */}
          <div>
            <button className="btn-primary" disabled={busy} onClick={doSave} style={{ width: '100%' }}>Save {baseName}.{ext}…</button>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="form-hint">Opens your system’s save dialog so you pick the exact location.</span>
              <label className="form-check"
                title={revealOrOpen
                  ? `Reveals the file in your file manager. ${fmt === 'svg' ? 'SVGs often open in a source editor rather than a viewer.' : ''}`.trim()
                  : 'Opens the exported file in your default app for that format.'}>
                <input type="checkbox" checked={openAfter} onChange={e => toggleOpenAfter(e.target.checked)} />
                {revealOrOpen ? `${REVEAL} when done` : 'Open when done'}
              </label>
            </div>
          </div>

          {status && <div className="form-hint" style={{ color: err ? '#f87171' : '#10b981' }}>{status}</div>}
        </div>
      </div>
    </div>
  );
}
