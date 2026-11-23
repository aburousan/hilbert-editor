import { useCallback, useEffect, useRef, useState } from 'react';
import { API } from '../api';
import type { Stroke } from '../ink/features';
import { InkReader, inkStatus, installInk, type InkStatus } from '../ink/reader';
import { symbolGlyph, symbolToTypst, toLatex, tokensToTypst } from '../ink/ink2typst';
import { fileToStrokes } from '../ink/photo';

// Insert → Write Maths by Hand, laid out like the ink2latex demo: tools over
// the pad, then reading, then the result. Strokes are read by the ink2latex
// model in a worker (nothing leaves the computer), turned into Typst, checked by
// compiling a preview, and inserted. When the Typst does not compile, the LaTeX
// goes in through mitex instead, which reads any LaTeX the model can write.
// A picture (a photo, screenshot or scan; chosen, pasted or dropped) is first
// traced back into strokes, which the r3-photo model was trained to read.

export type Handwritten = { typst: string } | { latex: string };

type Result = { typst: string | null; latex: string; lines: number };
// Undo history: a written stroke, or the strokes one eraser sweep took (with their places).
type Action = 'add' | { erased: [number, Stroke][] };

const AUTO_KEY = 'hilbert.handwriting.readAutomatically';
const ERASE_RADIUS = 12;

// A stroke goes when the eraser passes within ERASE_RADIUS of any of its pieces.
function near(stroke: Stroke, x: number, y: number): boolean {
  for (let i = 0; i < stroke.length; i++) {
    const [ax, ay] = stroke[i], [bx, by] = stroke[Math.min(i + 1, stroke.length - 1)];
    const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
    if (Math.hypot(ax + t * dx - x, ay + t * dy - y) <= ERASE_RADIUS) return true;
  }
  return false;
}

const CREDIT = 'ink2latex by Kazi Abu Rousan. Model weights CC BY-NC-SA 4.0, trained on MathWriting (Gervais et al., 2024, Google Research).';

export default function HandwritingModal({ onClose, onInsert }: { onClose: () => void; onInsert: (value: Handwritten) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const actionsRef = useRef<Action[]>([]);
  const drawingRef = useRef<number | null>(null);
  const erasedRef = useRef<[number, Stroke][] | null>(null);
  const rectRef = useRef<DOMRect | null>(null);
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
  const [took, setTook] = useState<number | null>(null);
  // One symbol on its own: the model's other likely readings, to pick from.
  const [choices, setChoices] = useState<{ typst: string; glyph: string; token: string }[]>([]);
  const [pictureNote, setPictureNote] = useState('');
  const [erasing, setErasing] = useState(false);
  const [empty, setEmpty] = useState(true);
  const [auto, setAutoState] = useState(() => { try { return localStorage.getItem(AUTO_KEY) !== 'off'; } catch { return true; } });
  const fileRef = useRef<HTMLInputElement | null>(null);
  const openRef = useRef(true);

  const setAuto = (on: boolean) => {
    setAutoState(on);
    try { localStorage.setItem(AUTO_KEY, on ? 'on' : 'off'); } catch { /* only a convenience */ }
    if (on && strokesRef.current.length) schedule();
  };

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

  // The whole pad, at the screen's own resolution; points are kept in CSS
  // pixels, so the ink keeps its shape whatever the window's size.
  const redraw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width * ratio)), h = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.strokeStyle = ctx.fillStyle = getComputedStyle(canvas).color || '#222';
    ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const stroke of strokesRef.current) {
      ctx.beginPath();
      if (stroke.length === 1) { ctx.arc(stroke[0][0], stroke[0][1], 1.3, 0, 2 * Math.PI); ctx.fill(); continue; }
      stroke.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
  };

  useEffect(() => {
    if (phase !== 'ready' || !canvasRef.current) return;
    const observer = new ResizeObserver(() => redraw());
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [phase]);

  const read = async () => {
    const reader = readerRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!reader || drawingRef.current !== null) return;
    const revision = revisionRef.current;
    if (!strokesRef.current.length) { setResult(null); setCode(''); return; }
    setReading(true);
    const start = performance.now();
    try {
      const lines = await reader.read(strokesRef.current, () => revision !== revisionRef.current);
      if (!lines || revision !== revisionRef.current) return;
      const typstLines = lines.map(tokensToTypst);
      const typst = typstLines.some(t => t === null) ? null : typstLines.join(lines.length > 1 ? ' \\\n' : '');
      const latex = lines.length > 1 ? `\\begin{gathered}${lines.map(toLatex).join('\\\\')}\\end{gathered}` : toLatex(lines[0] || []);
      setResult({ typst, latex, lines: lines.length });
      setUseLatex(typst === null);
      setCode(typst ?? latex);
      setTook(Math.round(performance.now() - start));
      // A single symbol is easy to misread (a ∫ as S): offer the near misses
      // too, as Draw a Symbol did.
      let near: { typst: string; glyph: string; token: string }[] = [];
      if (lines.length === 1 && lines[0].length === 1) {
        const guesses = await reader.guesses(strokesRef.current, 10);
        if (revision !== revisionRef.current) return;
        for (const g of guesses) {
          const t = symbolToTypst(g.token);
          if (t && !near.some(n => n.typst === t)) near.push({ typst: t, glyph: symbolGlyph(g.token), token: g.token });
        }
        near = near.slice(0, 6);
      }
      setChoices(near.length > 1 ? near : []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not read the handwriting.');
    } finally {
      if (revision === revisionRef.current) setReading(false);
    }
  };

  const schedule = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { void read(); }, 500);
  };

  // After any change to the ink: drawn again, and read again when reading by itself.
  const inkChanged = () => {
    revisionRef.current++;
    setReading(false);
    redraw();
    setEmpty(!strokesRef.current.length);
    if (!strokesRef.current.length) {
      if (timerRef.current) clearTimeout(timerRef.current);
      setResult(null); setCode(''); setTook(null);
    } else if (auto) schedule();
    setChoices([]);
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

  const point = (e: { clientX: number; clientY: number; timeStamp: number }): [number, number, number] => {
    const rect = rectRef.current!;
    return [e.clientX - rect.left, e.clientY - rect.top, e.timeStamp];
  };
  // The eraser button, or a stylus's eraser end (button 5, or the eraser bit in buttons).
  const erases = (e: React.PointerEvent) => erasing || e.button === 5 || (e.pointerType === 'pen' && (e.buttons & 32) !== 0);
  const eraseAt = ([x, y]: [number, number, number]) => {
    const strokes = strokesRef.current;
    let any = false;
    for (let i = strokes.length - 1; i >= 0; i--) if (near(strokes[i], x, y)) { erasedRef.current!.push([i, strokes.splice(i, 1)[0]]); any = true; }
    if (any) redraw();
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawingRef.current !== null || phase !== 'ready' || (e.button !== 0 && e.button !== 5)) return;
    e.preventDefault();
    drawingRef.current = e.pointerId;
    rectRef.current = e.currentTarget.getBoundingClientRect();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    // Whatever was being read is out of date now.
    revisionRef.current++;
    if (timerRef.current) clearTimeout(timerRef.current);
    const p = point(e);
    if (erases(e)) { erasedRef.current = []; eraseAt(p); return; }
    strokesRef.current.push([p]);
    setEmpty(false);
    const ctx = e.currentTarget.getContext('2d');
    if (ctx) { ctx.beginPath(); ctx.arc(p[0], p[1], 1.3, 0, 2 * Math.PI); ctx.fill(); }
  };
  // Only the new piece of the stroke is drawn: drawing all the ink at each
  // move made a long formula slower to write the longer it got.
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawingRef.current !== e.pointerId) return;
    const samples = e.nativeEvent.getCoalescedEvents?.();
    const points = (samples?.length ? samples : [e]).map(point);
    if (erasedRef.current) { points.forEach(eraseAt); return; }
    const stroke = strokesRef.current[strokesRef.current.length - 1];
    const ctx = e.currentTarget.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.moveTo(stroke[stroke.length - 1][0], stroke[stroke.length - 1][1]);
      for (const p of points) ctx.lineTo(p[0], p[1]);
      ctx.stroke();
    }
    stroke.push(...points);
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawingRef.current !== e.pointerId) return;
    drawingRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    const erased = erasedRef.current;
    erasedRef.current = null;
    if (erased) { if (erased.length) actionsRef.current.push({ erased }); }
    else actionsRef.current.push('add');
    inkChanged();
  };
  const undo = () => {
    const action = actionsRef.current.pop();
    if (action === undefined) return;
    // An eraser sweep comes back where its strokes were (in reverse, so each place is right again).
    if (action === 'add') strokesRef.current.pop();
    else for (const [i, stroke] of [...action.erased].reverse()) strokesRef.current.splice(i, 0, stroke);
    inkChanged();
  };
  const clear = () => {
    strokesRef.current = []; actionsRef.current = [];
    setPictureNote('');
    inkChanged();
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
      const rect = canvas.getBoundingClientRect();
      const pts = traced.flat();
      const [x0, y0] = [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1]))];
      const [w, h] = [Math.max(...pts.map(p => p[0])) - x0, Math.max(...pts.map(p => p[1])) - y0];
      const scale = Math.min(Math.max(1, rect.width - 40) / Math.max(1, w), Math.max(1, rect.height - 40) / Math.max(1, h));
      const dx = (rect.width - w * scale) / 2, dy = (rect.height - h * scale) / 2;
      strokesRef.current = traced.map(stroke => stroke.map(([x, y, t]) => [(x - x0) * scale + dx, (y - y0) * scale + dy, t] as [number, number, number]));
      actionsRef.current = strokesRef.current.map(() => 'add' as const);
      inkChanged();
      // (Read at once even when not reading by itself: a picture is a request to read it.)
      if (!auto) void read();
      setPictureNote('Read from a picture. Undo, erase or draw to correct it.');
    } catch (error) {
      if (revision === revisionRef.current) setPictureNote(`Could not read this picture: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // The Paste button: a picture on the clipboard, where the system lets the page see it.
  const pasteButton = async () => {
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find(t => t.startsWith('image/'));
        if (type) { void usePicture(await item.getType(type)); return; }
      }
      setPictureNote('No picture on the clipboard. Copy one or take a screenshot first.');
    } catch {
      setPictureNote('Press Ctrl+V (⌘V on a Mac) to paste a picture.');
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
  const heading: React.CSSProperties = { fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-muted)' };
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
  const latexNote = result && result.typst !== null && useLatex ? 'The Typst version did not compile, so the LaTeX is used instead. You can edit either.' : '';

  return (
    // Held near the top, not centred: a centred window moved with every change
    // in its height (a preview coming in), and the pad slid under the pen (issue #45).
    <div className="modal-overlay" style={{ alignItems: 'flex-start', paddingTop: '4vh', overflowY: 'auto' }} onClick={onClose}>
      <div className="modal-content" style={{ width: 780, maxWidth: '96vw', maxHeight: 'none' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Write Maths by Hand (experimental)</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
              <div style={{ ...row, justifyContent: 'space-between' }}>
                <span style={heading}>Your ink</span>
                <div style={row}>
                  <button className="btn-ghost" onClick={undo}>Undo</button>
                  <div className="seg">
                    <button className={erasing ? '' : 'active'} aria-pressed={!erasing} onClick={() => setErasing(false)}>Pen</button>
                    <button className={erasing ? 'active' : ''} aria-pressed={erasing} title="Touch a stroke to remove it (a pen's eraser end works too)" onClick={() => setErasing(true)}>Eraser</button>
                  </div>
                  <button className="btn-ghost" onClick={clear}>Clear</button>
                  <button className="btn-ghost" onClick={() => fileRef.current?.click()}>Picture…</button>
                  <button className="btn-ghost" title="A picture from the clipboard (or press Ctrl+V, ⌘V on a Mac)" onClick={() => { void pasteButton(); }}>Paste</button>
                  <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                    onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void usePicture(file); }} />
                </div>
              </div>
              <div style={{ position: 'relative' }}>
                <canvas
                  ref={canvasRef}
                  style={{ display: 'block', width: '100%', height: 'min(300px, 38vh)', background: 'var(--bg-color)', border: '1px solid var(--border-color)', borderRadius: 8, touchAction: 'none', cursor: erasing ? 'cell' : 'crosshair', color: 'var(--text-main)' }}
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
                {empty && (
                  <span style={{ ...muted, position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 16, pointerEvents: 'none' }}>
                    Write one formula or several lines here, with a pen, finger or mouse. Or use a picture of maths: choose one, paste it or drop it here.
                  </span>
                )}
              </div>
              <div style={{ ...row, minHeight: 32 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />
                  Read when I pause
                </label>
                <span style={{ ...muted, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {reading ? 'Reading…' : pictureNote || (took !== null ? `Read in ${took} ms` : '')}
                </span>
                <button className="btn-ghost" disabled={empty || reading} onClick={() => { void read(); }}>Read now</button>
              </div>
              {/* One row, always there, so a symbol's choices never move what is below. */}
              <div style={{ ...row, minHeight: 30, flexWrap: 'nowrap', overflow: 'hidden' }}>
                <span style={heading}>Your maths</span>
                {choices.length > 0 && <>
                  <span style={{ ...muted, marginLeft: 8 }}>One symbol? Pick:</span>
                  {choices.map(c => (
                    <button key={c.typst} className={code === c.typst ? 'btn-primary' : 'btn-ghost'} title={`Insert  ${c.typst}`}
                      style={{ padding: '2px 10px', minWidth: 34, fontSize: 16 }}
                      onClick={() => { setResult({ typst: c.typst, latex: c.token, lines: 1 }); setUseLatex(false); setCode(c.typst); }}>{c.glyph}</button>
                  ))}
                </>}
              </div>
              <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px dashed var(--border-color)', borderRadius: 8, padding: 8, overflow: 'hidden' }}>
                {preview.url ? <img src={preview.url} alt="Preview" style={{ maxWidth: '100%', maxHeight: 104, objectFit: 'contain' }} />
                  : preview.error ? <span style={{ ...muted, color: 'var(--danger, #ef4444)' }}>{preview.error}</span>
                  : <span style={muted}>The preview appears here.</span>}
              </div>
              <label className="form-field" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span>{useLatex ? 'LaTeX (inserted through mitex)' : 'Typst'}</span>
                <textarea
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  spellCheck={false}
                  rows={2}
                  style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 14, padding: 8, background: 'var(--bg-color)', color: 'var(--text-main)', border: '1px solid var(--border-color)', borderRadius: 6, resize: 'vertical' }}
                />
              </label>
              <div style={{ ...muted, minHeight: 16 }}>{latexNote}</div>
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
