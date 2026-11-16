import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '../api';
import type { Stroke } from '../ink/features';
import { InkReader, inkStatus, installInk, type InkStatus } from '../ink/reader';
import { toLatex, tokensToTypst } from '../ink/ink2typst';
import { fileToStrokes } from '../ink/photo';

// Insert → Write Maths by Hand. Strokes are read by the ink2latex model in the
// page itself (nothing leaves the computer), turned into Typst, checked by
// compiling a preview, and inserted. When the Typst does not compile, the LaTeX
// goes in through mitex instead, which reads any LaTeX the model can write.
// A picture (a photo, screenshot or scan; chosen, pasted or dropped) is first
// traced back into strokes, which the r3-photo model was trained to read.

export type Handwritten = { typst: string } | { latex: string };

type Result = { typst: string | null; latex: string; lines: number };

const CREDIT = 'ink2latex by Kazi Abu Rousan. Model weights CC BY-NC-SA 4.0, trained on MathWriting (Gervais et al., 2024, Google Research).';

export default function HandwritingModal({ onClose, onInsert }: { onClose: () => void; onInsert: (value: Handwritten) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const drawingRef = useRef<number | null>(null);
  const readerRef = useRef<InkReader | null>(null);
  const revisionRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const [status, setStatus] = useState<InkStatus | null>(null);
  const [phase, setPhase] = useState<'checking' | 'offer' | 'downloading' | 'loading' | 'ready' | 'error'>('checking');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [code, setCode] = useState('');
  const [useLatex, setUseLatex] = useState(false);
  const [preview, setPreview] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });
  const [reading, setReading] = useState(false);
  const [pictureNote, setPictureNote] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const openRef = useRef(true);

  const openReader = useCallback(async () => {
    setPhase('loading');
    try {
      const reader = await InkReader.open();
      // Closed while the model was starting: let it go at once.
      if (!openRef.current) { void reader.close(); return; }
      readerRef.current = reader;
      setPhase('ready');
    } catch (error) {
      if (!openRef.current) return;
      setPhase('error');
      setMessage(error instanceof Error ? error.message : 'Could not start the handwriting model.');
    }
  }, []);

  useEffect(() => {
    let active = true;
    openRef.current = true;
    void inkStatus().then(s => {
      if (!active) return;
      setStatus(s);
      if (s?.installed) void openReader();
      else setPhase('offer');
    });
    return () => {
      active = false;
      openRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      void readerRef.current?.close();
      readerRef.current = null;
    };
  }, [openReader]);

  const download = async () => {
    setPhase('downloading');
    try {
      await installInk();
      if (openRef.current) await openReader();
    } catch (error) {
      setPhase('error');
      setMessage(error instanceof Error ? error.message : 'Could not download the handwriting model.');
    }
  };

  const redraw = () => {
    const canvas = canvasRef.current, ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = getComputedStyle(canvas).color || '#222';
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const stroke of strokesRef.current) {
      ctx.beginPath();
      stroke.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (stroke.length === 1) ctx.lineTo(stroke[0][0] + 0.1, stroke[0][1]);
      ctx.stroke();
    }
  };

  const read = async () => {
    const reader = readerRef.current;
    if (!reader) return;
    const revision = revisionRef.current;
    if (!strokesRef.current.length) { setResult(null); setCode(''); return; }
    setReading(true);
    try {
      const lines = await reader.read(strokesRef.current, () => revision !== revisionRef.current);
      if (!lines || revision !== revisionRef.current) return;
      const typstLines = lines.map(tokensToTypst);
      const typst = typstLines.some(t => t === null) ? null : typstLines.join(lines.length > 1 ? ' \\\n' : '');
      const latex = lines.length > 1 ? `\\begin{gathered}${lines.map(toLatex).join('\\\\')}\\end{gathered}` : toLatex(lines[0] || []);
      setResult({ typst, latex, lines: lines.length });
      setUseLatex(typst === null);
      setCode(typst ?? latex);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not read the handwriting.');
    } finally {
      setReading(false);
    }
  };

  const schedule = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { void read(); }, 500);
  };

  // A preview of what will be inserted, compiled by the installed Typst. A
  // converted formula that does not compile switches to mitex by itself.
  useEffect(() => {
    if (!code.trim()) { setPreview({ url: null, error: null }); return; }
    let cancelled = false, made: string | null = null;
    const timer = window.setTimeout(async () => {
      const body = useLatex
        ? `#import "@preview/mitex:0.2.7": mitex\n#set page(width: auto, height: auto, margin: 6pt)\n#set text(size: 16pt)\n#mitex(${JSON.stringify(code)})`
        : `#set page(width: auto, height: auto, margin: 6pt)\n#set text(size: 16pt)\n$ ${code} $`;
      try {
        const response = await fetch(`${API}/render/snippet`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
        if (cancelled) return;
        if (response.ok) {
          made = URL.createObjectURL(await response.blob());
          setPreview({ url: made, error: null });
        } else {
          const error = (await response.json().catch(() => ({}))).error || 'Does not compile.';
          if (!useLatex && result && code === result.typst) { setUseLatex(true); setCode(result.latex); return; }
          setPreview({ url: null, error: String(error).split('\n').find(l => /error/i.test(l)) || String(error).slice(0, 200) });
        }
      } catch { if (!cancelled) setPreview({ url: null, error: 'Could not reach the previewer.' }); }
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); if (made) URL.revokeObjectURL(made); };
  }, [code, useLatex, result]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>): [number, number, number] => {
    const canvas = canvasRef.current!, rect = canvas.getBoundingClientRect();
    return [(e.clientX - rect.left) * canvas.width / rect.width, (e.clientY - rect.top) * canvas.height / rect.height, e.timeStamp];
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawingRef.current !== null || phase !== 'ready') return;
    e.preventDefault();
    drawingRef.current = e.pointerId;
    try { canvasRef.current?.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    revisionRef.current++;
    if (timerRef.current) clearTimeout(timerRef.current);
    strokesRef.current.push([point(e)]);
    redraw();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawingRef.current !== e.pointerId) return;
    strokesRef.current[strokesRef.current.length - 1].push(point(e));
    redraw();
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawingRef.current !== e.pointerId) return;
    drawingRef.current = null;
    if (canvasRef.current?.hasPointerCapture(e.pointerId)) canvasRef.current.releasePointerCapture(e.pointerId);
    schedule();
  };
  const changeInk = (next: Stroke[]) => {
    strokesRef.current = next;
    revisionRef.current++;
    redraw();
    if (next.length) schedule(); else { setResult(null); setCode(''); setPictureNote(''); }
  };

  // A picture replaces the ink with its traced strokes, fitted into the pad,
  // so they can be seen, undone or added to before it is read.
  const usePicture = async (file: Blob) => {
    const revision = ++revisionRef.current;
    setPictureNote('Tracing the picture…');
    try {
      const traced = await fileToStrokes(file);
      if (revision !== revisionRef.current || !openRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (!traced.length) { setPictureNote('No writing found in this picture. Try a closer, clearer one.'); return; }
      const pts = traced.flat();
      const [x0, y0] = [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1]))];
      const [w, h] = [Math.max(...pts.map(p => p[0])) - x0, Math.max(...pts.map(p => p[1])) - y0];
      const scale = Math.min((canvas.width - 80) / Math.max(1, w), (canvas.height - 80) / Math.max(1, h));
      const dx = (canvas.width - w * scale) / 2, dy = (canvas.height - h * scale) / 2;
      changeInk(traced.map(stroke => stroke.map(([x, y, t]) => [(x - x0) * scale + dx, (y - y0) * scale + dy, t] as [number, number, number])));
      setPictureNote('Read from a picture. Undo or draw to correct it.');
    } catch (error) {
      if (revision === revisionRef.current) setPictureNote(`Could not read this picture: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // A picture on the clipboard (a screenshot, say) is read; text pastes as usual.
  useEffect(() => {
    if (phase !== 'ready') return;
    const onPaste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
      if (!file) return;
      e.preventDefault(); e.stopPropagation();
      void usePicture(file);
    };
    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
  });

  const insert = () => {
    if (!code.trim()) return;
    onInsert(useLatex ? { latex: code } : { typst: code });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); insert(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
  const muted: React.CSSProperties = { fontSize: 12, color: 'var(--text-muted)' };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: 760, maxWidth: '96vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Write Maths by Hand (experimental)</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {phase === 'checking' && <div className="form-hint">Looking for the handwriting model…</div>}
          {phase === 'offer' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, lineHeight: 1.5 }}>
              <p style={{ margin: 0 }}>
                Hilbert reads handwritten maths with the ink2latex model, on this computer: your writing never leaves it.
                The model is not part of Hilbert itself. It is downloaded once, about {mb(status?.downloadBytes || 48e6)}, into Hilbert’s data folder.
              </p>
              <p style={{ margin: 0, ...muted }}>{CREDIT} Noncommercial use only, with credit.</p>
              {status?.canInstall === false
                ? <p style={{ margin: 0 }}>On a server shared through a browser, the model is installed by whoever runs the server, from the desktop app.</p>
                : <div><button className="btn-primary" onClick={download}>Download the model ({mb(status?.downloadBytes || 48e6)})</button></div>}
            </div>
          )}
          {phase === 'downloading' && <div className="form-hint">Downloading the handwriting model. This happens once…</div>}
          {phase === 'loading' && <div className="form-hint">Starting the handwriting model…</div>}
          {phase === 'error' && (
            <div>
              <p style={{ margin: '0 0 8px' }}>{message}</p>
              <button className="btn-ghost" onClick={() => { void inkStatus().then(s => { setStatus(s); if (s?.installed) void openReader(); else setPhase('offer'); }); }}>Try again</button>
            </div>
          )}
          {phase === 'ready' && (
            <>
              <div className="form-hint" style={{ margin: 0 }}>
                Write one formula, or several lines, with a pen, finger or mouse. It is read when you pause.
                You can also use a picture of maths: choose one, paste it (Ctrl+V, ⌘V on a Mac) or drop it on the pad.
              </div>
              <canvas
                ref={canvasRef}
                width={1400}
                height={420}
                style={{ width: '100%', height: 210, background: 'var(--bg-color)', border: '1px solid var(--border-color)', borderRadius: 8, touchAction: 'none', cursor: 'crosshair', color: 'var(--text-main)' }}
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerCancel={up}
                onDragOver={e => { if ([...e.dataTransfer.items].some(i => i.type.startsWith('image/'))) e.preventDefault(); }}
                onDrop={e => {
                  const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
                  if (file) { e.preventDefault(); e.stopPropagation(); void usePicture(file); }
                }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn-ghost" onClick={() => changeInk(strokesRef.current.slice(0, -1))}>Undo stroke</button>
                <button className="btn-ghost" onClick={() => changeInk([])}>Clear</button>
                <button className="btn-ghost" onClick={() => fileRef.current?.click()}>From a picture…</button>
                <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                  onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void usePicture(file); }} />
                {reading ? <span style={muted}>Reading…</span> : pictureNote && <span style={muted}>{pictureNote}</span>}
              </div>
              <label className="form-field" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span>{useLatex ? 'LaTeX (inserted through mitex)' : 'Typst'}</span>
                <textarea
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  spellCheck={false}
                  rows={2}
                  style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 14, padding: 8, background: 'var(--bg-color)', color: 'var(--text-main)', border: '1px solid var(--border-color)', borderRadius: 6 }}
                />
              </label>
              {result && result.typst !== null && useLatex && (
                <div style={muted}>The Typst version did not compile, so the LaTeX is used instead. You can edit either.</div>
              )}
              <div style={{ minHeight: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed var(--border-color)', borderRadius: 8, padding: 8 }}>
                {preview.url ? <img src={preview.url} alt="Preview" style={{ maxWidth: '100%', maxHeight: 160 }} />
                  : preview.error ? <span style={{ ...muted, color: 'var(--danger, #ef4444)' }}>{preview.error}</span>
                  : <span style={muted}>The preview appears here.</span>}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <span style={{ ...muted, flex: 1 }}>{CREDIT}</span>
                <button className="btn-primary" disabled={!code.trim()} onClick={insert}>Insert</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
