import { useState, useEffect, useRef } from 'react';
import { Excalidraw, exportToSvg, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { notify } from './notify';

interface ExcalidrawEditorProps {
  path: string;
  initialContent: string;
  onSave: (content: string, svgBlob: Blob) => Promise<void>;
}

type Skel = any; // Excalidraw element skeleton

// ---------------------------------------------------------------------------
// Scientific-diagram shape library.
// Each generator returns an array of Excalidraw element *skeletons* laid out
// around a centre point (cx, cy). `s` is the stroke colour and `sw` the stroke
// width picked up from the user's current Excalidraw settings, so inserted
// shapes match whatever they're already drawing with.
// ---------------------------------------------------------------------------
type MakeOpts = { s: string; sw: number; bg: string; fill: string };
const arrow = (x: number, y: number, points: number[][], o: MakeOpts, extra: any = {}): Skel =>
  ({ type: 'arrow', x, y, points, strokeColor: o.s, strokeWidth: o.sw, endArrowhead: 'arrow', ...extra });
const line = (x: number, y: number, points: number[][], o: MakeOpts, extra: any = {}): Skel =>
  ({ type: 'line', x, y, points, strokeColor: o.s, strokeWidth: o.sw, ...extra });
const text = (x: number, y: number, t: string, o: MakeOpts, size = 20): Skel =>
  ({ type: 'text', x, y, text: t, strokeColor: o.s, fontSize: size, fontFamily: 2 });
const shape = (type: 'ellipse' | 'rectangle' | 'diamond', x: number, y: number, w: number, h: number, o: MakeOpts, extra: any = {}): Skel =>
  ({ type, x, y, width: w, height: h, strokeColor: o.s, strokeWidth: o.sw, backgroundColor: o.bg, fillStyle: o.fill, ...extra });

// --- Experimental generators ------------------------------------------------
// Plot y = f(x) from a typed expression. Evaluated locally via Function with a
// fixed math scope (the user types their own formulas in their own editor).
function plotFn(cx: number, cy: number, o: MakeOpts): Skel[] {
  const expr = typeof window !== 'undefined'
    ? window.prompt('Plot  y = f(x)   —  use x, sin, cos, tan, exp, log, sqrt, abs, pi, e  (^ for powers)', 'sin(x)')
    : null;
  if (!expr) return [];
  let fn: (x: number) => number;
  try {
    const js = expr.replace(/\^/g, '**');
    // eslint-disable-next-line no-new-func
    const f = new Function('x', 'sin', 'cos', 'tan', 'exp', 'log', 'ln', 'sqrt', 'abs', 'pow', 'pi', 'e', `return (${js});`);
    fn = (x) => f(x, Math.sin, Math.cos, Math.tan, Math.exp, Math.log, Math.log, Math.sqrt, Math.abs, Math.pow, Math.PI, Math.E);
  } catch { if (typeof window !== 'undefined') notify('Could not parse that expression.'); return []; }
  const xMin = -6, xMax = 6, px = 18;
  const samples: { x: number; y: number }[] = [];
  let ymax = 1e-6;
  for (let i = 0; i <= 160; i++) {
    const x = xMin + (xMax - xMin) * (i / 160);
    let y: number; try { y = fn(x); } catch { continue; }
    if (!isFinite(y)) continue;
    samples.push({ x, y }); ymax = Math.max(ymax, Math.abs(y));
  }
  if (samples.length < 2) { if (typeof window !== 'undefined') notify('That expression produced no plottable values.'); return []; }
  const yscale = Math.min(70 / ymax, 60);
  const pts: number[][] = samples.map(s => [s.x * px, -Math.max(Math.min(s.y, ymax), -ymax) * yscale]);
  const halfW = ((xMax - xMin) / 2) * px;
  return [
    arrow(cx - halfW - 12, cy, [[0, 0], [2 * halfW + 24, 0]], o),
    arrow(cx, cy + 90, [[0, 0], [0, -180]], o),
    line(cx, cy, pts, { ...o, sw: Math.max(o.sw, 1.5) }, { strokeColor: '#4dabf7' }),
    text(cx + halfW + 6, cy - 14, 'x', o, 14),
    text(cx - halfW - 12, cy - 100, `y = ${expr}`, o, 13),
  ];
}

// A 5×5 grid of little arrows tracing a rotational vector field (v = (-y, x)).
function vectorField(cx: number, cy: number, o: MakeOpts): Skel[] {
  const els: Skel[] = []; const n = 5, step = 42, off = ((n - 1) / 2) * step, L = 16;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = cx - off + i * step, y = cy - off + j * step;
    const dx = -(y - cy), dy = (x - cx), m = Math.hypot(dx, dy) || 1;
    els.push(arrow(x - (dx / m) * L / 2, y - (dy / m) * L / 2, [[0, 0], [(dx / m) * L, (dy / m) * L]], { ...o, sw: 1 }));
  }
  return els;
}

// Bohr-model atom: filled nucleus, two orbit ellipses, electrons on them.
function bohrAtom(cx: number, cy: number, o: MakeOpts): Skel[] {
  return [
    shape('ellipse', cx - 55, cy - 34, 110, 68, o),
    shape('ellipse', cx - 80, cy - 52, 160, 104, o),
    shape('ellipse', cx - 11, cy - 11, 22, 22, { ...o, bg: o.s, fill: 'solid' }),
    shape('ellipse', cx + 55 - 6, cy - 6, 12, 12, { ...o, bg: '#4dabf7', fill: 'solid' }),
    shape('ellipse', cx - 80 - 6, cy - 6, 12, 12, { ...o, bg: '#4dabf7', fill: 'solid' }),
  ];
}

// Free-body diagram: a block with weight / normal / applied / friction arrows.
function freeBody(cx: number, cy: number, o: MakeOpts): Skel[] {
  return [
    shape('rectangle', cx - 30, cy - 30, 60, 60, { ...o, bg: '#ffec99', fill: 'hachure' }),
    arrow(cx, cy, [[0, 0], [0, 95]], { ...o, sw: 2 }), text(cx + 8, cy + 72, 'W', o, 14),
    arrow(cx, cy, [[0, 0], [0, -95]], { ...o, sw: 2 }), text(cx + 8, cy - 100, 'N', o, 14),
    arrow(cx, cy, [[0, 0], [95, 0]], { ...o, sw: 2 }), text(cx + 74, cy - 20, 'F', o, 14),
    arrow(cx, cy, [[0, 0], [-75, 0]], { ...o, sw: 2 }), text(cx - 96, cy - 20, 'f', o, 14),
  ];
}

const SHAPES: { group: string; items: { label: string; icon: string; make: (cx: number, cy: number, o: MakeOpts) => Skel[] }[] }[] = [
  {
    group: 'Axes & vectors',
    items: [
      { label: '2D axes', icon: '⊹', make: (cx, cy, o) => [
        arrow(cx - 90, cy, [[0, 0], [200, 0]], o), arrow(cx, cy + 90, [[0, 0], [0, -200]], o),
        text(cx + 108, cy - 12, 'x', o, 18), text(cx + 6, cy - 118, 'y', o, 18), text(cx - 18, cy + 4, 'O', o, 16),
      ] },
      { label: '3D axes', icon: '⬡', make: (cx, cy, o) => [
        arrow(cx, cy, [[0, 0], [130, 0]], o), arrow(cx, cy, [[0, 0], [0, -130]], o), arrow(cx, cy, [[0, 0], [-80, 70]], o),
        text(cx + 134, cy - 10, 'x', o, 18), text(cx - 6, cy - 152, 'y', o, 18), text(cx - 104, cy + 74, 'z', o, 18),
      ] },
      { label: 'Vector', icon: '↗', make: (cx, cy, o) => [
        arrow(cx - 70, cy + 45, [[0, 0], [150, -90]], { ...o, sw: Math.max(o.sw, 2) }), text(cx + 84, cy - 62, 'v', o, 20),
      ] },
      { label: 'Force pair', icon: '⇄', make: (cx, cy, o) => [
        arrow(cx, cy, [[0, 0], [110, 0]], { ...o, sw: 2 }), arrow(cx, cy, [[0, 0], [-110, 0]], { ...o, sw: 2 }),
        text(cx + 116, cy - 10, 'F', o, 18), text(cx - 140, cy - 10, 'F', o, 18),
      ] },
      { label: 'Dashed line', icon: '┈', make: (cx, cy, o) => [ line(cx - 90, cy, [[0, 0], [180, 0]], o, { strokeStyle: 'dashed' }) ] },
    ],
  },
  {
    group: 'Geometry',
    items: [
      { label: 'Angle θ', icon: '∠', make: (cx, cy, o) => {
        const vx = cx - 70, vy = cy + 55; const r = 42; const seg: number[][] = [];
        for (let i = 0; i <= 16; i++) { const a = -(Math.PI / 4) * (i / 16); seg.push([r * Math.cos(a), r * Math.sin(a)]); }
        return [ line(vx, vy, [[0, 0], [150, 0]], o), line(vx, vy, [[0, 0], [110, -110]], o), line(vx, vy, seg, o), text(vx + 54, vy - 26, 'θ', o, 16) ];
      } },
      { label: 'Right angle', icon: '⦜', make: (cx, cy, o) => [
        line(cx, cy - 70, [[0, 0], [0, 70], [90, 70]], o), line(cx, cy, [[0, 0], [18, 0], [18, -18], [0, -18], [0, 0]], o),
      ] },
      { label: 'Circle', icon: '◯', make: (cx, cy, o) => [ shape('ellipse', cx - 55, cy - 55, 110, 110, o) ] },
      { label: 'Triangle', icon: '△', make: (cx, cy, o) => [ line(cx, cy - 65, [[0, 0], [75, 125], [-75, 125], [0, 0]], o) ] },
      { label: 'Grid', icon: '▦', make: (cx, cy, o) => {
        const els: Skel[] = []; const n = 4, step = 34, sz = n * step; const x0 = cx - sz / 2, y0 = cy - sz / 2;
        const g = { ...o, s: o.s, sw: 0.7 };
        for (let i = 0; i <= n; i++) { els.push(line(x0, y0 + i * step, [[0, 0], [sz, 0]], g, { strokeStyle: 'dotted' })); els.push(line(x0 + i * step, y0, [[0, 0], [0, sz]], g, { strokeStyle: 'dotted' })); }
        return els;
      } },
    ],
  },
  {
    group: 'Mechanics',
    items: [
      { label: 'Point mass', icon: '●', make: (cx, cy, o) => [ shape('ellipse', cx - 13, cy - 13, 26, 26, { ...o, bg: o.s, fill: 'solid' }), text(cx + 18, cy - 12, 'm', o, 16) ] },
      { label: 'Spring', icon: '⌇', make: (cx, cy, o) => {
        const p: number[][] = [[0, 0], [14, 0]]; let x = 14;
        for (let i = 0; i < 6; i++) { x += 8; p.push([x, -13]); x += 8; p.push([x, 13]); }
        x += 8; p.push([x, 0]); p.push([x + 14, 0]);
        return [ line(cx - (x + 14) / 2, cy, p, o) ];
      } },
      { label: 'Pendulum', icon: '⊙', make: (cx, cy, o) => [
        line(cx - 40, cy - 70, [[0, 0], [80, 0]], o), line(cx, cy - 70, [[0, 0], [55, 95]], o, { strokeStyle: 'solid' }),
        shape('ellipse', cx + 42, cy + 12, 26, 26, { ...o, bg: o.s, fill: 'solid' }),
      ] },
      { label: 'Incline', icon: '◺', make: (cx, cy, o) => [ line(cx - 90, cy + 45, [[0, 0], [180, 0], [180, -100], [0, 0]], o) ] },
    ],
  },
  {
    group: 'Circuits',
    items: [
      { label: 'Resistor', icon: '⎓', make: (cx, cy, o) => {
        const p: number[][] = [[0, 0], [22, 0]]; let x = 22; const zig = [[8, -12], [16, 12], [24, -12], [32, 12], [40, -12], [48, 12], [56, 0]];
        for (const [dx, dy] of zig) { p.push([22 + dx, dy]); } x = 22 + 56; p.push([x + 22, 0]);
        return [ line(cx - (x + 22) / 2, cy, p, o) ];
      } },
      { label: 'Capacitor', icon: '⊣⊢', make: (cx, cy, o) => {
        const b = cx - 55;
        return [ line(b, cy, [[0, 0], [50, 0]], o), line(b + 50, cy - 20, [[0, 0], [0, 40]], o), line(b + 65, cy - 20, [[0, 0], [0, 40]], o), line(b + 65, cy, [[0, 0], [50, 0]], o) ];
      } },
      { label: 'Battery', icon: '⊪', make: (cx, cy, o) => {
        const b = cx - 50;
        return [ line(b, cy, [[0, 0], [45, 0]], o), line(b + 45, cy - 20, [[0, 0], [0, 40]], o), line(b + 60, cy - 11, [[0, 0], [0, 22]], { ...o, sw: Math.max(o.sw, 3) }), line(b + 60, cy, [[0, 0], [45, 0]], o) ];
      } },
      { label: 'Ground', icon: '⏚', make: (cx, cy, o) => [
        line(cx, cy - 30, [[0, 0], [0, 30]], o), line(cx - 20, cy, [[0, 0], [40, 0]], o), line(cx - 12, cy + 8, [[0, 0], [24, 0]], o), line(cx - 5, cy + 16, [[0, 0], [10, 0]], o),
      ] },
    ],
  },
  {
    group: 'Optics & waves',
    items: [
      { label: 'Convex lens', icon: '⬮', make: (cx, cy, o) => [
        shape('ellipse', cx - 16, cy - 60, 32, 120, o), line(cx - 110, cy, [[0, 0], [220, 0]], o, { strokeStyle: 'dashed' }),
        shape('ellipse', cx + 70 - 4, cy - 4, 8, 8, { ...o, bg: o.s, fill: 'solid' }), shape('ellipse', cx - 70 - 4, cy - 4, 8, 8, { ...o, bg: o.s, fill: 'solid' }),
        text(cx + 62, cy + 10, 'F', o, 14), text(cx - 78, cy + 10, 'F', o, 14),
      ] },
      { label: 'Mirror', icon: '▮', make: (cx, cy, o) => {
        const els: Skel[] = [ line(cx, cy - 60, [[0, 0], [0, 120]], { ...o, sw: Math.max(o.sw, 2) }) ];
        for (let i = 0; i <= 10; i++) { els.push(line(cx, cy - 55 + i * 11, [[0, 0], [12, 12]], { ...o, sw: 0.8 })); }
        return els;
      } },
      { label: 'Light ray', icon: '➔', make: (cx, cy, o) => [ arrow(cx - 90, cy, [[0, 0], [180, 0]], o) ] },
      { label: 'Sine wave', icon: '∿', make: (cx, cy, o) => {
        const p: number[][] = []; for (let i = 0; i <= 60; i++) { const t = i / 60; p.push([t * 200 - 100, -Math.sin(t * Math.PI * 4) * 32]); }
        return [ line(cx, cy, p, o) ];
      } },
    ],
  },
  {
    group: 'Experimental ⚗',
    items: [
      { label: 'Plot f(x)', icon: '📈', make: plotFn },
      { label: 'Vector field', icon: '🌀', make: vectorField },
      { label: 'Bohr atom', icon: '⚛', make: bohrAtom },
      { label: 'Free body', icon: '🧱', make: freeBody },
    ],
  },
];

// Fill styles and a small scientific colour palette for the shading controls.
const FILL_STYLES: { key: string; label: string }[] = [
  { key: 'transparent', label: 'None' }, { key: 'hachure', label: 'Hachure' }, { key: 'cross-hatch', label: 'Cross' }, { key: 'solid', label: 'Solid' },
];
const FILL_COLORS = ['transparent', '#a5d8ff', '#b2f2bb', '#ffc9c9', '#ffec99', '#eebefa', '#ced4da', '#1e1e1e'];
const STROKE_COLORS = ['#1e1e1e', '#e03131', '#1971c2', '#2f9e44', '#f08c00', '#9c36b5', '#ffffff'];

export default function ExcalidrawEditor({ initialContent, onSave }: ExcalidrawEditorProps) {
  const [initialData, setInitialData] = useState<any>(null);
  const [excalidrawAPI, setExcalidrawAPI] = useState<any>(null);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      setInitialData(initialContent ? JSON.parse(initialContent) : { elements: [], appState: {} });
    } catch (e) {
      setInitialData({ elements: [], appState: {} });
    }
  }, [initialContent]);

  // Viewport centre in scene coordinates, so inserted shapes land where the
  // user is looking rather than at the origin.
  const sceneCentre = () => {
    const st = excalidrawAPI.getAppState();
    const zoom = st.zoom?.value || 1;
    return { cx: st.width / 2 / zoom - st.scrollX, cy: st.height / 2 / zoom - st.scrollY };
  };

  const insertShape = (make: (cx: number, cy: number, o: MakeOpts) => Skel[]) => {
    if (!excalidrawAPI) return;
    const st = excalidrawAPI.getAppState();
    const o: MakeOpts = {
      s: st.currentItemStrokeColor || '#1e1e1e',
      sw: st.currentItemStrokeWidth || 1.5,
      bg: st.currentItemBackgroundColor || 'transparent',
      fill: st.currentItemFillStyle || 'hachure',
    };
    const { cx, cy } = sceneCentre();
    const skeleton = make(cx, cy, o);
    if (!skeleton || skeleton.length === 0) return; // e.g. a cancelled prompt
    const newEls = convertToExcalidrawElements(skeleton);
    const scene = excalidrawAPI.getSceneElements();
    const selectedElementIds: Record<string, true> = {};
    for (const el of newEls) selectedElementIds[el.id] = true;
    excalidrawAPI.updateScene({ elements: [...scene, ...newEls], appState: { selectedElementIds } });
  };

  // Apply a fill style / colour: to the current selection if there is one,
  // otherwise set it as the default for the next shape drawn.
  const applyShading = (patch: { backgroundColor?: string; fillStyle?: string; strokeColor?: string }) => {
    if (!excalidrawAPI) return;
    const st = excalidrawAPI.getAppState();
    const sel = st.selectedElementIds || {};
    const ids = Object.keys(sel).filter(id => sel[id]);
    if (ids.length > 0) {
      const els = excalidrawAPI.getSceneElements().map((el: any) =>
        sel[el.id] ? { ...el, ...patch, versionNonce: Math.floor(Math.random() * 1e9) } : el);
      excalidrawAPI.updateScene({ elements: els });
    } else {
      const appState: any = {};
      if (patch.backgroundColor !== undefined) appState.currentItemBackgroundColor = patch.backgroundColor;
      if (patch.fillStyle !== undefined) appState.currentItemFillStyle = patch.fillStyle;
      if (patch.strokeColor !== undefined) appState.currentItemStrokeColor = patch.strokeColor;
      excalidrawAPI.updateScene({ appState });
    }
  };

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        if (!excalidrawAPI) return;
        e.preventDefault();
        e.stopPropagation();

        const elements = excalidrawAPI.getSceneElements();
        const appState = excalidrawAPI.getAppState();
        const files = excalidrawAPI.getFiles();

        const jsonContent = JSON.stringify({
          type: 'excalidraw', version: 2, source: 'hilbert-editor',
          elements, appState: { viewBackgroundColor: appState.viewBackgroundColor }, files,
        });

        const svgElement = await exportToSvg({
          elements, appState: { ...appState, exportWithDarkMode: false }, files, exportPadding: 20,
        });
        const svgBlob = new Blob([svgElement.outerHTML], { type: 'image/svg+xml' });
        await onSave(jsonContent, svgBlob);
      }
    };
    const el = wrapperRef.current;
    if (el) {
      el.addEventListener('keydown', handleKeyDown, true);
      return () => el.removeEventListener('keydown', handleKeyDown, true);
    }
  }, [excalidrawAPI, onSave]);

  if (!initialData) return <div>Loading Whiteboard...</div>;

  return (
    <div ref={wrapperRef} style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column' }} tabIndex={-1}>
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={(api) => setExcalidrawAPI(api)}
        theme="dark"
      />

      {/* Scientific shape + shading palette (right edge, collapsible) */}
      <div className="sci-palette" style={{
        position: 'absolute', top: '64px', right: paletteOpen ? '12px' : '-260px', bottom: '64px',
        width: '240px', zIndex: 20, transition: 'right 0.18s ease',
        display: 'flex', flexDirection: 'column',
        background: 'var(--panel-bg, #23232a)', border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '10px', boxShadow: '0 8px 30px rgba(0,0,0,0.45)', overflow: 'hidden',
      }}>
        <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-color, #eee)' }}>Scientific shapes</span>
          <button onClick={() => setPaletteOpen(false)} title="Hide palette"
            style={{ background: 'none', border: 'none', color: 'var(--text-muted, #999)', cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}>›</button>
        </div>

        <div style={{ overflowY: 'auto', padding: '8px 10px', flex: 1 }}>
          {SHAPES.map(cat => (
            <div key={cat.group} style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted, #8a8a94)', margin: '2px 2px 6px' }}>{cat.group}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                {cat.items.map(it => (
                  <button key={it.label} title={`Insert ${it.label}`} onClick={() => insertShape(it.make)}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 8px', fontSize: '11.5px',
                      background: 'rgba(255,255,255,0.05)', color: 'var(--text-color, #e6e6e6)', border: '1px solid rgba(255,255,255,0.08)',
                      borderRadius: '6px', cursor: 'pointer', textAlign: 'left', whiteSpace: 'nowrap', overflow: 'hidden' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(139,92,246,0.25)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}>
                    <span style={{ fontSize: '15px', width: '16px', textAlign: 'center' }}>{it.icon}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}

          {/* Shading */}
          <div style={{ marginTop: '4px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '10px' }}>
            <div style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted, #8a8a94)', margin: '0 2px 6px' }}>Shading — fill</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: '8px' }}>
              {FILL_STYLES.map(f => (
                <button key={f.key} title={`Fill: ${f.label}`}
                  onClick={() => applyShading(f.key === 'transparent' ? { backgroundColor: 'transparent' } : { fillStyle: f.key })}
                  style={{ padding: '6px', fontSize: '11px', background: 'rgba(255,255,255,0.05)', color: 'var(--text-color,#e6e6e6)',
                    border: '1px solid rgba(255,255,255,0.08)', borderRadius: '6px', cursor: 'pointer' }}>{f.label}</button>
              ))}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted,#8a8a94)', margin: '0 2px 5px' }}>Fill colour</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '10px' }}>
              {FILL_COLORS.map(c => (
                <button key={c} title={c === 'transparent' ? 'No fill' : c} onClick={() => applyShading({ backgroundColor: c })}
                  style={{ width: '22px', height: '22px', borderRadius: '5px', cursor: 'pointer',
                    border: '1px solid rgba(255,255,255,0.25)',
                    background: c === 'transparent' ? 'repeating-conic-gradient(#888 0% 25%, #ccc 0% 50%) 50%/8px 8px' : c }} />
              ))}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted,#8a8a94)', margin: '0 2px 5px' }}>Stroke colour</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
              {STROKE_COLORS.map(c => (
                <button key={c} title={c} onClick={() => applyShading({ strokeColor: c })}
                  style={{ width: '22px', height: '22px', borderRadius: '5px', cursor: 'pointer', border: '1px solid rgba(255,255,255,0.25)', background: c }} />
              ))}
            </div>
          </div>
        </div>

        <div style={{ padding: '8px 12px', borderTop: '1px solid rgba(255,255,255,0.1)', fontSize: '11px', color: 'var(--text-muted,#8a8a94)' }}>
          Press <b style={{ color: 'var(--text-color,#ddd)' }}>Cmd/Ctrl+S</b> to save &amp; export SVG
        </div>
      </div>

      {/* Re-open tab when the palette is hidden */}
      {!paletteOpen && (
        <button onClick={() => setPaletteOpen(true)} title="Scientific shapes"
          style={{ position: 'absolute', top: '64px', right: '12px', zIndex: 20, padding: '8px 12px',
            background: 'var(--accent, #8b5cf6)', color: '#fff', border: 'none', borderRadius: '8px',
            cursor: 'pointer', fontSize: '12px', fontWeight: 600, boxShadow: '0 4px 14px rgba(0,0,0,0.4)' }}>
          🧪 Shapes
        </button>
      )}
    </div>
  );
}
