import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// Draw a maths/physics symbol with the mouse/trackpad and get the Typst code.
//
// Recognition is fully offline and needs no trained model: for every symbol we
// render its Unicode glyph to an offscreen canvas, take the glyph outline as a
// point cloud, and match the drawn strokes against those clouds with the $P
// point-cloud recognizer (Vatavu, Anthony & Wobbrock 2012) — which is rotation-
// free but order- and direction-invariant, so it copes with natural handwriting.
// ---------------------------------------------------------------------------

type Pt = { x: number; y: number; id: number };

// Typst symbol name (what gets inserted) + the Unicode glyph used to build the
// template. Kept to glyphs that common math fonts render, so templates are clean.
const SYMBOLS: { name: string; ch: string; tip?: string }[] = [
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
  { name: 'integral', ch: '∫', tip: '∫' }, { name: 'integral.double', ch: '∬' },
  { name: 'integral.cont', ch: '∮' }, { name: 'sum', ch: '∑' }, { name: 'product', ch: '∏' },
  { name: 'partial', ch: '∂' }, { name: 'nabla', ch: '∇' }, { name: 'sqrt(x)', ch: '√', tip: 'sqrt' },
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

const N = 48; // points per cloud

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

// Path-length resample of an (ordered) multi-stroke gesture to exactly n points.
function resample(points: Pt[], n: number): Pt[] {
  const pts = points.slice();
  let path = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].id === pts[i - 1].id) path += dist(pts[i - 1], pts[i]);
  const I = path / (n - 1) || 1;
  let D = 0;
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].id !== pts[i - 1].id) continue;
    const d = dist(pts[i - 1], pts[i]);
    if (D + d >= I) {
      const t = (I - D) / d;
      const np = { x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x), y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y), id: pts[i].id };
      out.push(np);
      pts.splice(i, 0, np);
      D = 0;
    } else D += d;
  }
  while (out.length < n) out.push({ ...pts[pts.length - 1] });
  return out.slice(0, n);
}

// Farthest-point sampling of an (unordered) point set to exactly n points — used
// for the glyph-outline templates, which have no meaningful stroke order.
function farthest(pts: Pt[], n: number): Pt[] {
  if (pts.length <= n) { const o = pts.slice(); while (o.length < n) o.push({ ...pts[pts.length - 1] }); return o; }
  const chosen = [pts[0]];
  const d = pts.map(p => dist(p, pts[0]));
  while (chosen.length < n) {
    let idx = 0, best = -1;
    for (let i = 0; i < pts.length; i++) if (d[i] > best) { best = d[i]; idx = i; }
    chosen.push(pts[idx]);
    for (let i = 0; i < pts.length; i++) { const dd = dist(pts[i], pts[idx]); if (dd < d[i]) d[i] = dd; }
  }
  return chosen;
}

// Uniform-scale to a unit box, then centre on the centroid.
function normalize(pts: Pt[]): Pt[] {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const s = Math.max(maxX - minX, maxY - minY) || 1;
  let cx = 0, cy = 0;
  const scaled = pts.map(p => { const q = { x: (p.x - minX) / s, y: (p.y - minY) / s, id: p.id }; cx += q.x; cy += q.y; return q; });
  cx /= scaled.length; cy /= scaled.length;
  return scaled.map(p => ({ x: p.x - cx, y: p.y - cy, id: p.id }));
}

function cloudDistance(pts: Pt[], tmpl: Pt[], start: number): number {
  const n = pts.length;
  const matched = new Array(n).fill(false);
  let sum = 0, i = start;
  do {
    let min = Infinity, index = -1;
    for (let j = 0; j < n; j++) if (!matched[j]) { const d = dist(pts[i], tmpl[j]); if (d < min) { min = d; index = j; } }
    if (index >= 0) matched[index] = true;
    const weight = 1 - ((i - start + n) % n) / n;
    sum += weight * min;
    i = (i + 1) % n;
  } while (i !== start);
  return sum;
}

function greedyMatch(pts: Pt[], tmpl: Pt[]): number {
  const n = pts.length;
  const step = Math.max(1, Math.floor(Math.pow(n, 0.5)));
  let min = Infinity;
  for (let i = 0; i < n; i += step) min = Math.min(min, cloudDistance(pts, tmpl, i), cloudDistance(tmpl, pts, i));
  return min;
}

type Template = { name: string; ch: string; tip?: string; cloud: Pt[] };

// Render each glyph and keep its outline (opaque pixels bordering a transparent
// one) as a normalized point cloud template. Runs once, off-screen.
function buildTemplates(): Template[] {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const out: Template[] = [];
  for (const sym of SYMBOLS) {
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#000';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `92px "STIX Two Math", "Cambria Math", "Latin Modern Math", "Segoe UI Symbol", serif`;
    ctx.fillText(sym.ch, S / 2, S / 2);
    const data = ctx.getImageData(0, 0, S, S).data;
    const A = (x: number, y: number) => (x < 0 || y < 0 || x >= S || y >= S) ? 0 : data[(y * S + x) * 4 + 3];
    const edge: Pt[] = [];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      if (A(x, y) > 80 && (A(x - 1, y) <= 80 || A(x + 1, y) <= 80 || A(x, y - 1) <= 80 || A(x, y + 1) <= 80)) edge.push({ x, y, id: 0 });
    }
    if (edge.length < 24) continue; // glyph not supported by the available fonts
    out.push({ name: sym.name, ch: sym.ch, tip: sym.tip, cloud: normalize(farthest(edge, N)) });
  }
  return out;
}

export default function SymbolDraw({ onClose, onInsert }: { onClose: () => void; onInsert: (name: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const templatesRef = useRef<Template[] | null>(null);
  const strokesRef = useRef<Pt[][]>([]);
  const drawingRef = useRef(false);
  const [results, setResults] = useState<{ name: string; ch: string; tip?: string; score: number }[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Build templates after paint so the modal appears instantly.
    const t = setTimeout(() => { templatesRef.current = buildTemplates(); setReady(true); }, 0);
    return () => clearTimeout(t);
  }, []);

  const ctx = () => canvasRef.current?.getContext('2d') || null;

  const redraw = () => {
    const c = canvasRef.current, g = ctx();
    if (!c || !g) return;
    g.clearRect(0, 0, c.width, c.height);
    g.strokeStyle = '#a78bfa';
    g.lineWidth = 3;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    for (const s of strokesRef.current) {
      if (s.length < 2) continue;
      g.beginPath();
      g.moveTo(s[0].x, s[0].y);
      for (let i = 1; i < s.length; i++) g.lineTo(s[i].x, s[i].y);
      g.stroke();
    }
  };

  const pos = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, id: strokesRef.current.length };
  };

  const down = (e: React.PointerEvent) => {
    e.preventDefault();
    drawingRef.current = true;
    strokesRef.current.push([pos(e)]);
    canvasRef.current?.setPointerCapture(e.pointerId);
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
    const all: Pt[] = strokesRef.current.flat();
    if (!templates || all.length < 4) { setResults([]); return; }
    const g = normalize(resample(all, N));
    const scored = templates.map(t => ({ name: t.name, ch: t.ch, tip: t.tip, score: greedyMatch(g, t.cloud) }));
    scored.sort((a, b) => a.score - b.score);
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
