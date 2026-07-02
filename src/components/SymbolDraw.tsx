import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Draw a maths/physics symbol with the mouse/trackpad and get the Typst code.
//
// Fully offline, no trained model: every symbol's Unicode glyph is rendered to
// an off-screen canvas; both the glyph and the drawn strokes are reduced to a
// centred, aspect-preserved, Gaussian-blurred 32×32 "ink map" and compared by
// cosine similarity. Blurring bridges the gap between a thin hand-drawn stroke
// and a solid glyph, so distinctive shapes (∫ ∑ √ α π → …) match well.
// ---------------------------------------------------------------------------

type Pt = { x: number; y: number };

const SYMBOLS: { name: string; ch: string }[] = [
  // Greek (lower)
  { name: 'alpha', ch: 'α' }, { name: 'beta', ch: 'β' }, { name: 'gamma', ch: 'γ' },
  { name: 'delta', ch: 'δ' }, { name: 'epsilon', ch: 'ε' }, { name: 'zeta', ch: 'ζ' },
  { name: 'eta', ch: 'η' }, { name: 'theta', ch: 'θ' }, { name: 'kappa', ch: 'κ' },
  { name: 'lambda', ch: 'λ' }, { name: 'mu', ch: 'μ' }, { name: 'nu', ch: 'ν' },
  { name: 'xi', ch: 'ξ' }, { name: 'pi', ch: 'π' }, { name: 'rho', ch: 'ρ' },
  { name: 'sigma', ch: 'σ' }, { name: 'tau', ch: 'τ' }, { name: 'phi', ch: 'φ' },
  { name: 'chi', ch: 'χ' }, { name: 'psi', ch: 'ψ' }, { name: 'omega', ch: 'ω' },
  // Greek (upper)
  { name: 'Gamma', ch: 'Γ' }, { name: 'Delta', ch: 'Δ' }, { name: 'Theta', ch: 'Θ' },
  { name: 'Lambda', ch: 'Λ' }, { name: 'Xi', ch: 'Ξ' }, { name: 'Pi', ch: 'Π' },
  { name: 'Sigma', ch: 'Σ' }, { name: 'Phi', ch: 'Φ' }, { name: 'Psi', ch: 'Ψ' },
  { name: 'Omega', ch: 'Ω' },
  // Operators / calculus
  { name: 'integral', ch: '∫' }, { name: 'integral.double', ch: '∬' },
  { name: 'integral.cont', ch: '∮' }, { name: 'sum', ch: '∑' }, { name: 'product', ch: '∏' },
  { name: 'partial', ch: '∂' }, { name: 'nabla', ch: '∇' }, { name: 'sqrt(x)', ch: '√' },
  { name: 'infinity', ch: '∞' }, { name: 'plus.minus', ch: '±' }, { name: 'minus.plus', ch: '∓' },
  { name: 'times', ch: '×' }, { name: 'div', ch: '÷' }, { name: 'dot', ch: '⋅' },
  { name: 'plus.circle', ch: '⊕' }, { name: 'times.circle', ch: '⊗' },
  // Relations
  { name: 'lt.eq', ch: '≤' }, { name: 'gt.eq', ch: '≥' }, { name: 'eq.not', ch: '≠' },
  { name: 'approx', ch: '≈' }, { name: 'equiv', ch: '≡' }, { name: 'prop', ch: '∝' },
  { name: 'tilde.op', ch: '∼' },
  // Arrows
  { name: 'arrow.r', ch: '→' }, { name: 'arrow.l', ch: '←' }, { name: 'arrow.t', ch: '↑' },
  { name: 'arrow.b', ch: '↓' }, { name: 'arrow.l.r', ch: '↔' }, { name: 'arrow.r.double', ch: '⇒' },
  { name: 'arrow.l.double', ch: '⇐' }, { name: 'arrow.r.bar', ch: '↦' },
  // Sets / logic
  { name: 'in', ch: '∈' }, { name: 'in.not', ch: '∉' }, { name: 'subset', ch: '⊂' },
  { name: 'subset.eq', ch: '⊆' }, { name: 'union', ch: '∪' }, { name: 'sect', ch: '∩' },
  { name: 'emptyset', ch: '∅' }, { name: 'forall', ch: '∀' }, { name: 'exists', ch: '∃' },
  { name: 'therefore', ch: '∴' }, { name: 'angle', ch: '∠' }, { name: 'degree', ch: '°' },
  // Blackboard
  { name: 'RR', ch: 'ℝ' }, { name: 'CC', ch: 'ℂ' }, { name: 'ZZ', ch: 'ℤ' },
  { name: 'NN', ch: 'ℕ' }, { name: 'QQ', ch: 'ℚ' },
  // Misc
  { name: 'dagger', ch: '†' }, { name: 'hbar', ch: 'ℏ' }, { name: 'star', ch: '⋆' },
];

const GRID = 32;

// One 3×3 Gaussian pass over a GRID×GRID map.
function blur(v: Float32Array): Float32Array {
  const out = new Float32Array(v.length);
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
    let s = 0, w = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
      const k = (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
      s += v[ny * GRID + nx] * k; w += k;
    }
    out[y * GRID + x] = s / w;
  }
  return out;
}

// Crop a canvas to its ink, centre it (aspect-preserved) in a GRID×GRID box,
// blur, and L2-normalize into a feature vector.
function toVector(src: HTMLCanvasElement): Float32Array {
  const sctx = src.getContext('2d', { willReadFrequently: true })!;
  const W = src.width, H = src.height;
  const d = sctx.getImageData(0, 0, W, H).data;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (d[(y * W + x) * 4 + 3] > 40) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  const g = document.createElement('canvas'); g.width = GRID; g.height = GRID;
  const gctx = g.getContext('2d', { willReadFrequently: true })!;
  if (maxX >= minX) {
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const s = (GRID - 6) / Math.max(bw, bh);
    const dw = bw * s, dh = bh * s;
    gctx.imageSmoothingEnabled = true;
    gctx.drawImage(src, minX, minY, bw, bh, (GRID - dw) / 2, (GRID - dh) / 2, dw, dh);
  }
  const gd = gctx.getImageData(0, 0, GRID, GRID).data;
  let v: Float32Array = new Float32Array(GRID * GRID);
  for (let i = 0; i < GRID * GRID; i++) v[i] = gd[i * 4 + 3] / 255;
  v = blur(blur(v));
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

const cosine = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

type Template = { name: string; ch: string; vec: Float32Array };

function buildTemplates(): Template[] {
  const S = 128;
  const cv = document.createElement('canvas'); cv.width = S; cv.height = S;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const out: Template[] = [];
  for (const sym of SYMBOLS) {
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `96px "STIX Two Math", "Cambria Math", "STIXGeneral", "Apple Symbols", "Segoe UI Symbol", serif`;
    ctx.fillText(sym.ch, S / 2, S / 2);
    const d = ctx.getImageData(0, 0, S, S).data;
    let ink = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) ink++;
    if (ink < 20) continue; // glyph unsupported by available fonts
    out.push({ name: sym.name, ch: sym.ch, vec: toVector(cv) });
  }
  return out;
}

// Rasterize the drawn strokes (thin lines) into their own tight canvas.
function gestureCanvas(strokes: Pt[][]): HTMLCanvasElement | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;
  for (const s of strokes) for (const p of s) { count++; minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  if (count < 3) return null;
  const pad = 14;
  const W = Math.max(8, Math.ceil(maxX - minX + pad * 2)), H = Math.max(8, Math.ceil(maxY - minY + pad * 2));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.strokeStyle = '#000'; ctx.fillStyle = '#000';
  ctx.lineWidth = Math.max(3, Math.min(W, H) * 0.05);
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const s of strokes) {
    if (s.length < 2) { ctx.beginPath(); ctx.arc(s[0].x - minX + pad, s[0].y - minY + pad, ctx.lineWidth / 2, 0, 7); ctx.fill(); continue; }
    ctx.beginPath(); ctx.moveTo(s[0].x - minX + pad, s[0].y - minY + pad);
    for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x - minX + pad, s[i].y - minY + pad);
    ctx.stroke();
  }
  return cv;
}

export default function SymbolDraw({ onClose, onInsert }: { onClose: () => void; onInsert: (name: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const templatesRef = useRef<Template[] | null>(null);
  const strokesRef = useRef<Pt[][]>([]);
  const drawingRef = useRef(false);
  const [results, setResults] = useState<{ name: string; ch: string; score: number }[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => { templatesRef.current = buildTemplates(); setReady(true); }, 0);
    return () => clearTimeout(t);
  }, []);

  const ctx = () => canvasRef.current?.getContext('2d') || null;

  const redraw = () => {
    const c = canvasRef.current, g = ctx();
    if (!c || !g) return;
    g.clearRect(0, 0, c.width, c.height);
    g.strokeStyle = '#a78bfa'; g.lineWidth = 3; g.lineJoin = 'round'; g.lineCap = 'round';
    for (const s of strokesRef.current) {
      if (s.length < 2) continue;
      g.beginPath(); g.moveTo(s[0].x, s[0].y);
      for (let i = 1; i < s.length; i++) g.lineTo(s[i].x, s[i].y);
      g.stroke();
    }
  };

  const pos = (e: React.PointerEvent): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    drawingRef.current = true;
    strokesRef.current.push([pos(e)]);
    try { canvasRef.current?.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const move = (e: React.PointerEvent) => {
    if (!drawingRef.current) return;
    strokesRef.current[strokesRef.current.length - 1].push(pos(e));
    redraw();
  };
  const up = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    recognize();
  };

  const recognize = () => {
    const templates = templatesRef.current;
    if (!templates) return;
    const gc = gestureCanvas(strokesRef.current);
    if (!gc) { setResults([]); return; }
    const v = toVector(gc);
    const scored = templates.map(t => ({ name: t.name, ch: t.ch, score: cosine(v, t.vec) }));
    scored.sort((a, b) => b.score - a.score);
    setResults(scored.slice(0, 10));
  };

  const clear = () => { strokesRef.current = []; setResults([]); redraw(); };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '640px' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Draw a Symbol → Typst</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="form-hint">Draw a maths/physics symbol below — matches appear on the right. Click one to insert its Typst code. Multi-stroke symbols are fine.</div>
          <div style={{ display: 'flex', gap: 14 }}>
            <div style={{ flex: '0 0 auto' }}>
              <canvas
                ref={canvasRef}
                width={280}
                height={280}
                style={{ background: '#0f172a', border: '1px solid var(--border-color)', borderRadius: 8, touchAction: 'none', cursor: 'crosshair' }}
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={up}
                onPointerLeave={up}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn-ghost" onClick={clear}>Clear</button>
                {!ready && <span className="form-hint" style={{ margin: 0 }}>Preparing recognizer…</span>}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span className="form-field" style={{ marginBottom: 6 }}><span>Best matches</span></span>
              {results.length === 0 ? (
                <div className="form-hint" style={{ marginTop: 4 }}>No guesses yet — draw something.</div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {results.map((r, i) => (
                    <button
                      key={r.name}
                      className={i === 0 ? 'btn-primary' : 'btn-ghost'}
                      onClick={() => onInsert(r.name)}
                      title={`Insert  ${r.name}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px' }}
                    >
                      <span style={{ fontSize: 22, lineHeight: 1 }}>{r.ch}</span>
                      <code style={{ fontSize: 12 }}>{r.name}</code>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
