import React, { useEffect, useRef, useState } from 'react';

// Visual Feynman-diagram builder: draw propagators (fermion / photon / gluon /
// scalar / ghost), loops (plain, wavy or coiled circles), hatched or shaded
// blobs, vertices and labels on a snapping canvas — then insert the diagram as
// editable cetz code. Everything maps 1:1 onto cetz primitives: wavy and coiled
// lines are `decorations.wave` / `decorations.coil`, hatching is explicit chord
// lines (so no deprecated `pattern`/`tiling` is needed).

type Pt = { x: number, y: number };
type EdgeKind = 'fermion' | 'antifermion' | 'photon' | 'gluon' | 'scalar' | 'ghost' | 'plain' | 'double' | 'cscalar' | 'majorana';
type LoopKind = 'plain' | 'photon' | 'gluon';
type LoopFill = 'none' | 'hatched' | 'shaded';

type Edge = { id: number, type: 'edge', kind: EdgeKind, from: Pt, to: Pt, bend: number, thickness: number, amplitude: number, endArrow: boolean, label: string, side: 1 | -1, color?: string };
type Loop = { id: number, type: 'loop', kind: LoopKind, fill: LoopFill, center: Pt, radius: number, thickness: number, amplitude: number, label: string, color?: string, arrow?: 0 | 1 | -1 };
type Vertex = { id: number, type: 'vertex', at: Pt, size: number, color?: string };
type TextEl = { id: number, type: 'text', at: Pt, text: string, color?: string };
type El = Edge | Loop | Vertex | TextEl;

const W = 680, H = 400, GRID = 20, UNIT = 40; // 40 px = 1 cetz unit
const DBL = 2.4; // px half-gap between the two rails of a double line

const EDGE_KINDS: { k: EdgeKind, name: string }[] = [
  { k: 'fermion', name: 'Fermion —▶—' },
  { k: 'antifermion', name: 'Anti-fermion —◀—' },
  { k: 'photon', name: 'Photon ∿∿∿' },
  { k: 'gluon', name: 'Gluon ⌀⌀⌀ (coil)' },
  { k: 'scalar', name: 'Scalar - - -' },
  { k: 'cscalar', name: 'Charged scalar - ▶ -' },
  { k: 'ghost', name: 'Ghost · · ·' },
  { k: 'majorana', name: 'Majorana —▶◀—' },
  { k: 'double', name: 'Double line ═══' },
  { k: 'plain', name: 'Plain line' },
];

// ---- geometry ---------------------------------------------------------------
const ctrlPt = (a: Pt, b: Pt, bend: number): Pt => {
  // control point of the quadratic bezier whose midpoint sits bend px off the chord
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  return { x: (a.x + b.x) / 2 + nx * 2 * bend, y: (a.y + b.y) / 2 + ny * 2 * bend };
};
const bezPt = (a: Pt, c: Pt, b: Pt, t: number): Pt => ({
  x: (1 - t) * (1 - t) * a.x + 2 * t * (1 - t) * c.x + t * t * b.x,
  y: (1 - t) * (1 - t) * a.y + 2 * t * (1 - t) * c.y + t * t * b.y,
});
const bezTan = (a: Pt, c: Pt, b: Pt, t: number): Pt => {
  const dx = 2 * (1 - t) * (c.x - a.x) + 2 * t * (b.x - c.x);
  const dy = 2 * (1 - t) * (c.y - a.y) + 2 * t * (b.y - c.y);
  const l = Math.hypot(dx, dy) || 1;
  return { x: dx / l, y: dy / l };
};
const pathLen = (a: Pt, c: Pt, b: Pt) => {
  let len = 0, p = a;
  for (let i = 1; i <= 16; i++) { const q = bezPt(a, c, b, i / 16); len += Math.hypot(q.x - p.x, q.y - p.y); p = q; }
  return len;
};

// SVG preview path for a wavy / coiled edge (approximates what cetz renders)
function decoPath(a: Pt, b: Pt, bend: number, kind: 'photon' | 'gluon', amp: number): string {
  const c = ctrlPt(a, b, bend);
  const len = pathLen(a, c, b);
  const cycles = Math.max(3, Math.round(len / (kind === 'photon' ? 13 : 12)));
  const N = cycles * 14;
  const pts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, u = 2 * Math.PI * cycles * t;
    const p = bezPt(a, c, b, t), d = bezTan(a, c, b, t);
    const nx = -d.y, ny = d.x;
    let x = p.x, y = p.y;
    if (kind === 'photon') { x += nx * amp * Math.sin(u); y += ny * amp * Math.sin(u); }
    else { // coil: loops sticking out to one side
      const r = amp * (1 - Math.cos(u)) * 0.85, s = amp * 0.9 * Math.sin(u);
      x += nx * r + d.x * s; y += ny * r + d.y * s;
    }
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return 'M' + pts.join(' L');
}

// SVG preview path for a wavy / coiled circle
function decoCirclePath(cen: Pt, r: number, kind: 'photon' | 'gluon', amp: number): string {
  const cycles = Math.max(6, Math.round(2 * Math.PI * r / (kind === 'photon' ? 13 : 12)));
  const N = cycles * 14;
  const pts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const th = 2 * Math.PI * i / N, u = cycles * th;
    let rr = r, s = 0;
    if (kind === 'photon') rr = r + amp * Math.sin(u);
    else { rr = r + amp * (1 - Math.cos(u)) * 0.85; s = amp * 0.9 * Math.sin(u); }
    const x = cen.x + rr * Math.cos(th) - s * Math.sin(th);
    const y = cen.y + rr * Math.sin(th) + s * Math.cos(th);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return 'M' + pts.join(' L') + 'Z';
}

const arrowPts = (p: Pt, d: Pt, size: number, back: boolean) => {
  const s = back ? -1 : 1;
  const tip = { x: p.x + s * d.x * size, y: p.y + s * d.y * size };
  const l = { x: p.x - s * d.x * size * 0.6 - d.y * size * 0.75, y: p.y - s * d.y * size * 0.6 + d.x * size * 0.75 };
  const r = { x: p.x - s * d.x * size * 0.6 + d.y * size * 0.75, y: p.y - s * d.y * size * 0.6 - d.x * size * 0.75 };
  return `${tip.x},${tip.y} ${l.x},${l.y} ${r.x},${r.y}`;
};

// ---- cetz code generation ---------------------------------------------------
const num = (v: number) => {
  const s = v.toFixed(2);
  return s.replace(/\.?0+$/, '') || '0';
};
const cx = (p: Pt) => `(${num(p.x / UNIT)}, ${num((H - p.y) / UNIT)})`;

// Colour handling: black is the default everywhere, so only emit rgb() when the
// element actually has a colour — keeps the generated code minimal.
const SWATCHES = ['#000000', '#dc2626', '#2563eb', '#16a34a', '#d97706', '#7c3aed'];
const tint = (c?: string) => c && c.toLowerCase() !== '#000000' ? `rgb("${c}")` : null;
const strokeOf = (th: number, c?: string) => tint(c) ? `${num(th)}pt + ${tint(c)}` : `${num(th)}pt`;
const dashStroke = (th: number, dash: string, c?: string) =>
  `(thickness: ${num(th)}pt, dash: "${dash}"${tint(c) ? `, paint: ${tint(c)}` : ''})`;
const paintOf = (c?: string) => tint(c) ?? 'black';
const previewCol = (c: string | undefined, isSel: boolean) => isSel ? '#7c3aed' : (c && c.toLowerCase() !== '#000000' ? c : '#111');

function edgeCode(e: Edge): string[] {
  const out: string[] = [];
  const c = ctrlPt(e.from, e.to, e.bend);
  const len = pathLen(e.from, e.to.x === e.from.x && e.to.y === e.from.y ? e.from : c, e.to);
  const mkBase = (a: Pt, b: Pt, cc: Pt) => e.bend === 0
    ? `line(${cx(a)}, ${cx(b)}`
    : `bezier(${cx(a)}, ${cx(b)}, ${cx(cc)}`;
  const base = mkBase(e.from, e.to, c);

  if (e.kind === 'photon' || e.kind === 'gluon') {
    const fn = e.kind === 'photon' ? 'wave' : 'coil';
    const segs = Math.max(3, Math.round(len / (e.kind === 'photon' ? 13 : 12)));
    out.push(`  decorations.${fn}(${base}), stroke: ${strokeOf(e.thickness, e.color)}, amplitude: ${num(e.amplitude / UNIT)}, segments: ${segs})`);
    return out;
  }

  // An arrowhead somewhere along the edge (dir +1 points forward, -1 backward).
  const midMark = (t: number, dir: number) => {
    const m = bezPt(e.from, c, e.to, t), d = bezTan(e.from, c, e.to, t), ex = 3.2;
    const p1 = { x: m.x - dir * d.x * ex, y: m.y - dir * d.y * ex };
    const p2 = { x: m.x + dir * d.x * ex, y: m.y + dir * d.y * ex };
    out.push(`  mark(${cx(p1)}, ${cx(p2)}, symbol: ">", fill: ${paintOf(e.color)}, stroke: ${paintOf(e.color)}, scale: ${num(Math.max(0.8, e.thickness * 0.8))})`);
  };

  // Double line: two parallel rails offset along the chord normal.
  if (e.kind === 'double') {
    const l0 = Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y) || 1;
    const nx = -(e.to.y - e.from.y) / l0, ny = (e.to.x - e.from.x) / l0;
    for (const s of [1, -1]) {
      const o = (p: Pt): Pt => ({ x: p.x + nx * DBL * s, y: p.y + ny * DBL * s });
      out.push(`  ${mkBase(o(e.from), o(e.to), o(c))}, stroke: ${strokeOf(e.thickness, e.color)})`);
    }
    if (e.endArrow) midMark(0.94, 1);
    return out;
  }

  const stroke = (e.kind === 'scalar' || e.kind === 'cscalar') ? dashStroke(e.thickness, 'dashed', e.color)
    : e.kind === 'ghost' ? dashStroke(e.thickness, 'dotted', e.color) : strokeOf(e.thickness, e.color);
  const mark = e.endArrow ? `, mark: (end: ">", fill: ${paintOf(e.color)})` : '';
  out.push(`  ${base}, stroke: ${stroke}${mark})`);
  // Directional arrows in the middle of the propagator.
  if (e.kind === 'fermion' || e.kind === 'cscalar' || e.kind === 'ghost') midMark(0.5, 1);
  else if (e.kind === 'antifermion') midMark(0.5, -1);
  else if (e.kind === 'majorana') { midMark(0.4, 1); midMark(0.6, -1); } // two clashing arrows
  return out;
}

function loopCode(l: Loop): string[] {
  const out: string[] = [];
  if (l.kind === 'plain') {
    const fill = l.fill === 'shaded' ? `, fill: ${tint(l.color) ? `${tint(l.color)}.lighten(70%)` : 'gray.lighten(50%)'}` : '';
    out.push(`  circle(${cx(l.center)}, radius: ${num(l.radius / UNIT)}, stroke: ${strokeOf(l.thickness, l.color)}${fill})`);
  } else {
    const fn = l.kind === 'photon' ? 'wave' : 'coil';
    const segs = Math.max(6, Math.round(2 * Math.PI * l.radius / (l.kind === 'photon' ? 13 : 12)));
    out.push(`  decorations.${fn}(circle(${cx(l.center)}, radius: ${num(l.radius / UNIT)}), stroke: ${strokeOf(l.thickness, l.color)}, amplitude: ${num(l.amplitude / UNIT)}, segments: ${segs})`);
  }
  if (l.fill === 'hatched') {
    // 45° chords across the circle — version-proof hatching without pattern fills
    const r = l.radius, spacing = Math.max(8, r / 3.2);
    const ux = Math.SQRT1_2, uy = -Math.SQRT1_2, nx = Math.SQRT1_2, ny = Math.SQRT1_2;
    for (let cD = -r + spacing; cD < r - 1; cD += spacing) {
      const h = Math.sqrt(r * r - cD * cD);
      const p1 = { x: l.center.x + nx * cD - ux * h, y: l.center.y + ny * cD - uy * h };
      const p2 = { x: l.center.x + nx * cD + ux * h, y: l.center.y + ny * cD + uy * h };
      out.push(`  line(${cx(p1)}, ${cx(p2)}, stroke: ${strokeOf(Math.max(0.4, l.thickness * 0.45), l.color)})`);
    }
  }
  // Fermion-flow arrows tangent to the circle, one at the top and one at the
  // bottom so the rotation reads at a glance. arrow: 1 = clockwise, -1 = ccw.
  if (l.arrow) {
    const ex = 3.2, sc = num(Math.max(0.8, l.thickness * 0.8));
    for (const [py, dir] of [[l.center.y - l.radius, l.arrow], [l.center.y + l.radius, -l.arrow]] as const) {
      const p1 = { x: l.center.x - dir * ex, y: py };
      const p2 = { x: l.center.x + dir * ex, y: py };
      out.push(`  mark(${cx(p1)}, ${cx(p2)}, symbol: ">", fill: ${paintOf(l.color)}, stroke: ${paintOf(l.color)}, scale: ${sc})`);
    }
  }
  return out;
}

const mathContent = (t: string, c?: string) => {
  const body = t.startsWith('$') ? `[${t}]` : `[$${t}$]`;
  return tint(c) ? `text(fill: ${tint(c)}, ${body})` : body;
};

// ---- templates --------------------------------------------------------------
let tid = 1000;
const T = (x: number, y: number): Pt => ({ x, y });
const TEMPLATES: { name: string, make: () => El[] }[] = [
  {
    name: 'Tadpole (loop on a line)',
    make: () => [
      { id: tid++, type: 'edge', kind: 'fermion', from: T(120, 300), to: T(420, 300), bend: 0, thickness: 1.2, amplitude: 6, endArrow: true, label: '', side: 1 },
      { id: tid++, type: 'edge', kind: 'photon', from: T(270, 300), to: T(270, 220), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: '', side: 1 },
      { id: tid++, type: 'loop', kind: 'plain', fill: 'none', center: T(270, 180), radius: 40, thickness: 1.2, amplitude: 5, label: '' },
      { id: tid++, type: 'vertex', at: T(270, 300), size: 3 },
    ],
  },
  {
    name: 'Self-energy (photon arch)',
    make: () => [
      { id: tid++, type: 'edge', kind: 'fermion', from: T(120, 280), to: T(480, 280), bend: 0, thickness: 1.2, amplitude: 6, endArrow: true, label: '', side: 1 },
      { id: tid++, type: 'edge', kind: 'photon', from: T(220, 280), to: T(380, 280), bend: -55, thickness: 1, amplitude: 5, endArrow: false, label: '', side: 1 },
      { id: tid++, type: 'vertex', at: T(220, 280), size: 3 },
      { id: tid++, type: 'vertex', at: T(380, 280), size: 3 },
      { id: tid++, type: 'text', at: T(190, 305), text: 'x_1' },
      { id: tid++, type: 'text', at: T(410, 305), text: 'x_2' },
    ],
  },
  {
    name: 'Vacuum polarisation (photon–loop–photon)',
    make: () => [
      { id: tid++, type: 'edge', kind: 'photon', from: T(100, 240), to: T(230, 240), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: 'gamma', side: 1 },
      { id: tid++, type: 'loop', kind: 'plain', fill: 'none', center: T(290, 240), radius: 60, thickness: 1.2, amplitude: 5, label: '', arrow: 1 },
      { id: tid++, type: 'edge', kind: 'photon', from: T(350, 240), to: T(480, 240), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: 'gamma', side: 1 },
      { id: tid++, type: 'vertex', at: T(230, 240), size: 3 },
      { id: tid++, type: 'vertex', at: T(350, 240), size: 3 },
    ],
  },
  {
    name: 'Effective vertex (hatched blob)',
    make: () => [
      { id: tid++, type: 'edge', kind: 'fermion', from: T(100, 320), to: T(250, 240), bend: 0, thickness: 1.2, amplitude: 6, endArrow: false, label: '', side: 1 },
      { id: tid++, type: 'edge', kind: 'fermion', from: T(250, 240), to: T(100, 160), bend: 0, thickness: 1.2, amplitude: 6, endArrow: false, label: '', side: 1 },
      { id: tid++, type: 'loop', kind: 'plain', fill: 'hatched', center: T(300, 240), radius: 50, thickness: 1.2, amplitude: 5, label: '' },
      { id: tid++, type: 'edge', kind: 'photon', from: T(350, 240), to: T(500, 240), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: '', side: 1 },
    ],
  },
];

// ---- component ---------------------------------------------------------------
export default function FeynmanBuilder({ onClose, onInsert }: { onClose: () => void, onInsert: (code: string) => void }) {
  const [els, setEls] = useState<El[]>([]);
  const [tool, setTool] = useState<'select' | 'edge' | 'loop' | 'vertex' | 'text'>('edge');
  const [edgeKind, setEdgeKind] = useState<EdgeKind>('fermion');
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ a: Pt, b: Pt } | null>(null);
  const [asFigure, setAsFigure] = useState(true);
  const [caption, setCaption] = useState('Feynman diagram');
  const [figLabel, setFigLabel] = useState('');
  const [showCode, setShowCode] = useState(false);

  const svgRef = useRef<SVGSVGElement>(null);
  const idRef = useRef(1);
  const undoRef = useRef<El[][]>([]);
  const dragRef = useRef<null | { mode: 'draw' | 'move' | 'from' | 'to' | 'bend' | 'radius', start: Pt, snapshot: El[] }>(null);

  const commit = (next: El[]) => { undoRef.current.push(els); setEls(next); };

  const sel = els.find(e => e.id === selected) ?? null;

  // Anchor points other elements can snap to (vertices, edge ends, loop compass points)
  const anchors = (): Pt[] => {
    const a: Pt[] = [];
    for (const e of els) {
      if (e.type === 'vertex') a.push(e.at);
      else if (e.type === 'edge') a.push(e.from, e.to);
      else if (e.type === 'loop') a.push(
        { x: e.center.x + e.radius, y: e.center.y }, { x: e.center.x - e.radius, y: e.center.y },
        { x: e.center.x, y: e.center.y + e.radius }, { x: e.center.x, y: e.center.y - e.radius });
    }
    return a;
  };
  const snap = (p: Pt, useAnchors = true): Pt => {
    if (useAnchors) for (const a of anchors()) if (Math.hypot(a.x - p.x, a.y - p.y) < 12) return { ...a };
    return { x: Math.round(p.x / (GRID / 2)) * (GRID / 2), y: Math.round(p.y / (GRID / 2)) * (GRID / 2) };
  };

  const mouse = (ev: React.MouseEvent): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (W / r.width), y: (ev.clientY - r.top) * (H / r.height) };
  };

  const hitTest = (p: Pt): number | null => {
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      if (e.type === 'vertex') { if (Math.hypot(e.at.x - p.x, e.at.y - p.y) < 9) return e.id; }
      else if (e.type === 'text') { if (Math.hypot(e.at.x - p.x, e.at.y - p.y) < 16) return e.id; }
      else if (e.type === 'loop') {
        const d = Math.hypot(e.center.x - p.x, e.center.y - p.y);
        if (Math.abs(d - e.radius) < 9 || (e.fill !== 'none' && d < e.radius)) return e.id;
      } else {
        const c = ctrlPt(e.from, e.to, e.bend);
        for (let t = 0; t <= 24; t++) {
          const q = bezPt(e.from, c, e.to, t / 24);
          if (Math.hypot(q.x - p.x, q.y - p.y) < 8 + e.amplitude) return e.id;
        }
      }
    }
    return null;
  };

  const onDown = (ev: React.MouseEvent) => {
    const p = mouse(ev);
    if (tool === 'edge' || tool === 'loop') {
      dragRef.current = { mode: 'draw', start: snap(p), snapshot: els };
      setDraft({ a: snap(p), b: snap(p) });
      return;
    }
    if (tool === 'vertex') { commit([...els, { id: idRef.current++, type: 'vertex', at: snap(p), size: 3 }]); return; }
    if (tool === 'text') {
      const id = idRef.current++;
      commit([...els, { id, type: 'text', at: snap(p, false), text: 'x' }]);
      setSelected(id); setTool('select');
      return;
    }
    // select tool: handles first (they sit on top), then element bodies
    if (sel) {
      const h = handlePoints(sel);
      for (const [mode, hp] of h) {
        if (Math.hypot(hp.x - p.x, hp.y - p.y) < 9) {
          dragRef.current = { mode, start: p, snapshot: els.map(e => ({ ...e })) };
          return;
        }
      }
    }
    const hit = hitTest(p);
    setSelected(hit);
    if (hit != null) dragRef.current = { mode: 'move', start: p, snapshot: els.map(e => ({ ...e, ...(e as any) })) };
  };

  const handlePoints = (e: El): ['from' | 'to' | 'bend' | 'radius', Pt][] => {
    if (e.type === 'edge') {
      const c = ctrlPt(e.from, e.to, e.bend);
      return [['from', e.from], ['to', e.to], ['bend', bezPt(e.from, c, e.to, 0.5)]];
    }
    if (e.type === 'loop') return [['radius', { x: e.center.x + e.radius, y: e.center.y }]];
    return [];
  };

  const onMove = (ev: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = mouse(ev);
    if (d.mode === 'draw') { setDraft(prev => prev ? { a: prev.a, b: snap(p) } : null); return; }
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    setEls(d.snapshot.map(e => {
      if (e.id !== selected) return e;
      if (d.mode === 'move') {
        if (e.type === 'edge') return { ...e, from: { x: e.from.x + dx, y: e.from.y + dy }, to: { x: e.to.x + dx, y: e.to.y + dy } };
        if (e.type === 'loop') return { ...e, center: { x: e.center.x + dx, y: e.center.y + dy } };
        return { ...e, at: { x: (e as Vertex | TextEl).at.x + dx, y: (e as Vertex | TextEl).at.y + dy } } as El;
      }
      if (e.type === 'edge' && d.mode === 'from') return { ...e, from: snap(p) };
      if (e.type === 'edge' && d.mode === 'to') return { ...e, to: snap(p) };
      if (e.type === 'edge' && d.mode === 'bend') {
        const len = Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y) || 1;
        const nx = -(e.to.y - e.from.y) / len, ny = (e.to.x - e.from.x) / len;
        const mx = (e.from.x + e.to.x) / 2, my = (e.from.y + e.to.y) / 2;
        return { ...e, bend: Math.round((p.x - mx) * nx + (p.y - my) * ny) };
      }
      if (e.type === 'loop' && d.mode === 'radius')
        return { ...e, radius: Math.max(12, Math.round(Math.hypot(p.x - e.center.x, p.y - e.center.y))) };
      return e;
    }));
  };

  const onUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.mode === 'draw' && draft) {
      const { a, b } = draft;
      setDraft(null);
      if (Math.hypot(b.x - a.x, b.y - a.y) < 10) return; // too small: ignore click-without-drag
      const id = idRef.current++;
      if (tool === 'edge') {
        const th = edgeKind === 'photon' || edgeKind === 'gluon' ? 1 : 1.2;
        const amp = edgeKind === 'gluon' ? 7 : 5;
        undoRef.current.push(d.snapshot);
        setEls([...d.snapshot, { id, type: 'edge', kind: edgeKind, from: a, to: b, bend: 0, thickness: th, amplitude: amp, endArrow: false, label: '', side: 1 }]);
      } else {
        undoRef.current.push(d.snapshot);
        setEls([...d.snapshot, { id, type: 'loop', kind: 'plain', fill: 'none', center: a, radius: Math.max(15, Math.round(Math.hypot(b.x - a.x, b.y - a.y))), thickness: 1.2, amplitude: 5, label: '' }]);
      }
      setSelected(id);
    } else {
      undoRef.current.push(d.snapshot); // moves/handle drags become one undo step
    }
  };

  const update = (patch: Partial<El>) => setEls(els.map(e => e.id === selected ? { ...e, ...patch } as El : e));
  const removeSel = () => { if (selected != null) { commit(els.filter(e => e.id !== selected)); setSelected(null); } };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected != null) { ev.preventDefault(); removeSel(); }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'z') {
        ev.preventDefault();
        const prev = undoRef.current.pop();
        if (prev) { setEls(prev); setSelected(null); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- code generation ----
  const genCode = () => {
    const lines: string[] = [];
    for (const e of els) if (e.type === 'loop') lines.push(...loopCode(e));
    for (const e of els) if (e.type === 'edge') {
      lines.push(...edgeCode(e));
      if (e.label.trim()) {
        const c = ctrlPt(e.from, e.to, e.bend);
        const m = bezPt(e.from, c, e.to, 0.5), d = bezTan(e.from, c, e.to, 0.5);
        const off = (14 + e.amplitude) * e.side;
        lines.push(`  content(${cx({ x: m.x - d.y * off, y: m.y + d.x * off })}, ${mathContent(e.label.trim(), e.color)})`);
      }
    }
    for (const e of els) if (e.type === 'loop' && e.label.trim())
      lines.push(`  content(${cx({ x: e.center.x, y: e.center.y - e.radius - 14 })}, ${mathContent(e.label.trim(), e.color)})`);
    for (const e of els) if (e.type === 'vertex')
      lines.push(`  circle(${cx(e.at)}, radius: ${num(e.size / UNIT)}, fill: ${paintOf(e.color)}, stroke: none)`);
    for (const e of els) if (e.type === 'text' && e.text.trim())
      lines.push(`  content(${cx(e.at)}, ${mathContent(e.text.trim(), e.color)})`);
    const imports = `#import "@preview/cetz:0.3.4": canvas, draw, decorations\n`;
    const canvas = `canvas({\n  import draw: *\n${lines.join('\n')}\n})`;
    return { imports, canvas };
  };

  const handleInsert = () => {
    const { imports, canvas } = genCode();
    let body;
    if (asFigure) {
      const tag = figLabel.trim() ? ` <fig:${figLabel.trim()}>` : '';
      body = `${imports}#figure(\n  ${canvas},\n  caption: [${caption}],\n)${tag}`;
    } else {
      body = `${imports}#align(center)[\n${canvas}\n]`;
    }
    onInsert('\n' + body + '\n\n');
  };

  // ---- SVG rendering ----
  const renderEdge = (e: Edge) => {
    const c = ctrlPt(e.from, e.to, e.bend);
    const col = previewCol(e.color, e.id === selected);
    const pathFor = (a: Pt, b: Pt, cc: Pt) => e.bend === 0
      ? `M${a.x},${a.y} L${b.x},${b.y}`
      : `M${a.x},${a.y} Q${cc.x},${cc.y} ${b.x},${b.y}`;
    const basePath = pathFor(e.from, e.to, c);
    const parts: React.ReactNode[] = [];
    const midArrow = (t: number, back: boolean) => {
      const m = bezPt(e.from, c, e.to, t), d = bezTan(e.from, c, e.to, t);
      parts.push(<polygon key={`a${t}-${back}`} points={arrowPts(m, d, 5 + e.thickness * 1.5, back)} fill={col} />);
    };
    if (e.kind === 'photon' || e.kind === 'gluon') {
      parts.push(<path key="p" d={decoPath(e.from, e.to, e.bend, e.kind, e.amplitude)} fill="none" stroke={col} strokeWidth={e.thickness} />);
    } else if (e.kind === 'double') {
      const l0 = Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y) || 1;
      const nx = -(e.to.y - e.from.y) / l0, ny = (e.to.x - e.from.x) / l0;
      for (const s of [1, -1]) {
        const o = (p: Pt): Pt => ({ x: p.x + nx * DBL * s, y: p.y + ny * DBL * s });
        parts.push(<path key={`d${s}`} d={pathFor(o(e.from), o(e.to), o(c))} fill="none" stroke={col} strokeWidth={e.thickness} />);
      }
      if (e.endArrow) midArrow(0.94, false);
    } else {
      const dash = (e.kind === 'scalar' || e.kind === 'cscalar') ? '8 5' : e.kind === 'ghost' ? '2 5' : undefined;
      parts.push(<path key="p" d={basePath} fill="none" stroke={col} strokeWidth={e.thickness} strokeDasharray={dash} />);
      if (e.kind === 'fermion' || e.kind === 'cscalar' || e.kind === 'ghost') midArrow(0.5, false);
      else if (e.kind === 'antifermion') midArrow(0.5, true);
      else if (e.kind === 'majorana') { midArrow(0.4, false); midArrow(0.6, true); }
    }
    if (e.endArrow && e.kind !== 'photon' && e.kind !== 'gluon' && e.kind !== 'double') {
      const d = bezTan(e.from, c, e.to, 1);
      parts.push(<polygon key="e" points={arrowPts(e.to, d, 5 + e.thickness * 1.5, false)} fill={col} />);
    }
    if (e.label.trim()) {
      const m = bezPt(e.from, c, e.to, 0.5), d = bezTan(e.from, c, e.to, 0.5);
      const off = (14 + e.amplitude) * e.side;
      parts.push(<text key="l" x={m.x - d.y * off} y={m.y + d.x * off} fontSize="13" fontStyle="italic" fontFamily="Georgia, serif" textAnchor="middle" dominantBaseline="middle" fill={col}>{e.label}</text>);
    }
    return <g key={e.id}>{parts}</g>;
  };

  const renderLoop = (l: Loop) => {
    const col = previewCol(l.color, l.id === selected);
    const parts: React.ReactNode[] = [];
    if (l.kind === 'plain') {
      parts.push(<circle key="c" cx={l.center.x} cy={l.center.y} r={l.radius} fill={l.fill === 'shaded' ? (tint(l.color) ? `${l.color}44` : '#d4d4d4') : 'none'} stroke={col} strokeWidth={l.thickness} />);
    } else {
      parts.push(<path key="c" d={decoCirclePath(l.center, l.radius, l.kind, l.amplitude)} fill="none" stroke={col} strokeWidth={l.thickness} />);
    }
    if (l.fill === 'hatched') {
      const r = l.radius, spacing = Math.max(8, r / 3.2);
      const hs: React.ReactNode[] = [];
      for (let cD = -r + spacing, i = 0; cD < r - 1; cD += spacing, i++) {
        const h = Math.sqrt(r * r - cD * cD);
        hs.push(<line key={i}
          x1={l.center.x + Math.SQRT1_2 * cD - Math.SQRT1_2 * h} y1={l.center.y + Math.SQRT1_2 * cD + Math.SQRT1_2 * h}
          x2={l.center.x + Math.SQRT1_2 * cD + Math.SQRT1_2 * h} y2={l.center.y + Math.SQRT1_2 * cD - Math.SQRT1_2 * h}
          stroke={col} strokeWidth={Math.max(0.4, l.thickness * 0.45)} />);
      }
      parts.push(<g key="h">{hs}</g>);
    }
    if (l.arrow) {
      const size = 4 + l.thickness * 2;
      parts.push(<polygon key="a1" points={arrowPts({ x: l.center.x, y: l.center.y - l.radius }, { x: l.arrow, y: 0 }, size, false)} fill={col} />);
      parts.push(<polygon key="a2" points={arrowPts({ x: l.center.x, y: l.center.y + l.radius }, { x: -l.arrow, y: 0 }, size, false)} fill={col} />);
    }
    if (l.label.trim())
      parts.push(<text key="l" x={l.center.x} y={l.center.y - l.radius - 14} fontSize="13" fontStyle="italic" fontFamily="Georgia, serif" textAnchor="middle" dominantBaseline="middle" fill={col}>{l.label}</text>);
    return <g key={l.id}>{parts}</g>;
  };

  const field = (label: string, el: React.ReactNode) => (
    <label className="form-field"><span>{label}</span>{el}</label>
  );

  const colorField = (cur: string | undefined) => field('Colour', (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
      {SWATCHES.map(c => (
        <button key={c} type="button" onClick={() => update({ color: c })} title={c}
          style={{ width: '20px', height: '20px', borderRadius: '50%', background: c, cursor: 'pointer', padding: 0,
                   border: (cur ?? '#000000').toLowerCase() === c ? '2px solid #7c3aed' : '2px solid rgba(148, 163, 184, 0.4)' }} />
      ))}
      <input type="color" value={cur ?? '#000000'} onChange={e => update({ color: e.target.value })}
        style={{ width: '28px', height: '24px', padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} title="Custom colour" />
    </div>
  ));

  const code = showCode ? genCode() : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '960px', maxWidth: '96vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Feynman Diagram (visual)</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: '12px' }}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
              <div className="seg">
                {([['select', 'Select'], ['edge', 'Line'], ['loop', 'Circle'], ['vertex', 'Vertex'], ['text', 'Label']] as const).map(([t, name]) => (
                  <button key={t} className={tool === t ? 'active' : ''} onClick={() => setTool(t)}>{name}</button>
                ))}
              </div>
              {tool === 'edge' && (
                <select value={edgeKind} onChange={e => setEdgeKind(e.target.value as EdgeKind)}>
                  {EDGE_KINDS.map(k => <option key={k.k} value={k.k}>{k.name}</option>)}
                </select>
              )}
              <select value="" onChange={e => { const t = TEMPLATES.find(x => x.name === e.target.value); if (t) { commit([...els, ...t.make()]); } }}>
                <option value="" disabled>Insert template…</option>
                {TEMPLATES.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
              <button className="btn-ghost" onClick={() => { const prev = undoRef.current.pop(); if (prev) { setEls(prev); setSelected(null); } }}>Undo</button>
              <button className="btn-ghost" onClick={() => { commit([]); setSelected(null); }}>Clear</button>
            </div>

            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', cursor: tool === 'select' ? 'default' : 'crosshair', touchAction: 'none', display: 'block' }}
              onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}>
              {/* Alignment grid: minor lines every GRID px, stronger lines every
                  UNIT px (= 1 cetz unit). Drawing aid only — never exported. */}
              <defs>
                <pattern id="fgrid-minor" width={GRID} height={GRID} patternUnits="userSpaceOnUse">
                  <path d={`M ${GRID} 0 L 0 0 0 ${GRID}`} fill="none" stroke="#e7ebf2" strokeWidth="1" />
                </pattern>
                <pattern id="fgrid" width={UNIT} height={UNIT} patternUnits="userSpaceOnUse">
                  <rect width={UNIT} height={UNIT} fill="url(#fgrid-minor)" />
                  <path d={`M ${UNIT} 0 L 0 0 0 ${UNIT}`} fill="none" stroke="#cfd8e6" strokeWidth="1" />
                </pattern>
              </defs>
              <rect width={W} height={H} fill="url(#fgrid)" />
              {els.map(e =>
                e.type === 'edge' ? renderEdge(e)
                : e.type === 'loop' ? renderLoop(e)
                : e.type === 'vertex' ? <circle key={e.id} cx={e.at.x} cy={e.at.y} r={e.size} fill={previewCol(e.color, e.id === selected)} />
                : <text key={e.id} x={e.at.x} y={e.at.y} fontSize="14" fontStyle="italic" fontFamily="Georgia, serif" textAnchor="middle" dominantBaseline="middle" fill={previewCol(e.color, e.id === selected)}>{e.text || '…'}</text>
              )}
              {draft && tool === 'edge' && <line x1={draft.a.x} y1={draft.a.y} x2={draft.b.x} y2={draft.b.y} stroke="#7c3aed" strokeWidth="1.5" strokeDasharray="4 4" />}
              {draft && tool === 'loop' && <circle cx={draft.a.x} cy={draft.a.y} r={Math.max(2, Math.hypot(draft.b.x - draft.a.x, draft.b.y - draft.a.y))} fill="none" stroke="#7c3aed" strokeWidth="1.5" strokeDasharray="4 4" />}
              {sel && tool === 'select' && handlePoints(sel).map(([mode, p], i) => (
                <circle key={i} cx={p.x} cy={p.y} r="6" fill="#fff" stroke="#7c3aed" strokeWidth="2" style={{ cursor: mode === 'bend' ? 'ns-resize' : 'move' }} />
              ))}
            </svg>
            <div className="form-hint" style={{ marginTop: '6px' }}>
              <b>Line / Circle</b>: click &amp; drag to draw. <b>Select</b>: click an element, then drag it or its handles
              (line endpoints snap to nearby vertices; the middle handle bends the line into an arc). <b>⌫</b> deletes, <b>⌘Z</b> undoes.
              The grid (bold lines = 1 unit) is a drawing guide only and is never added to the diagram.
            </div>
          </div>

          <div style={{ flex: '0 0 250px', borderLeft: '1px solid #e2e8f0', paddingLeft: '12px' }}>
            {!sel && <div className="form-hint">Nothing selected.<br /><br />Draw a line or circle, or add a template — then switch to <b>Select</b> to edit thickness, wiggle amplitude, bend, hatching and labels.</div>}

            {sel?.type === 'edge' && (
              <>
                {field('Line type', (
                  <select value={sel.kind} onChange={e => update({ kind: e.target.value as EdgeKind })}>
                    {EDGE_KINDS.map(k => <option key={k.k} value={k.k}>{k.name}</option>)}
                  </select>
                ))}
                {field(`Thickness — ${num(sel.thickness)}pt`, <input type="range" min="0.4" max="3" step="0.1" value={sel.thickness} onChange={e => update({ thickness: Number(e.target.value) })} />)}
                {colorField(sel.color)}
                {(sel.kind === 'photon' || sel.kind === 'gluon') &&
                  field(`Wiggle size — ${num(sel.amplitude / UNIT)}`, <input type="range" min="2" max="14" step="0.5" value={sel.amplitude} onChange={e => update({ amplitude: Number(e.target.value) })} />)}
                {field(`Bend — ${sel.bend}`, <input type="range" min="-100" max="100" step="5" value={sel.bend} onChange={e => update({ bend: Number(e.target.value) })} />)}
                {sel.kind !== 'photon' && sel.kind !== 'gluon' && (
                  <label className="form-check">
                    <input type="checkbox" checked={sel.endArrow} onChange={e => update({ endArrow: e.target.checked })} />
                    Arrowhead at the end
                  </label>
                )}
                {field('Label (Typst math)', <input type="text" value={sel.label} onChange={e => update({ label: e.target.value })} placeholder="e.g. gamma, p_1" />)}
                {sel.label.trim() !== '' && (
                  <label className="form-check">
                    <input type="checkbox" checked={sel.side === -1} onChange={e => update({ side: e.target.checked ? -1 : 1 })} />
                    Label on the other side
                  </label>
                )}
              </>
            )}

            {sel?.type === 'loop' && (
              <>
                {field('Circle type', (
                  <select value={sel.kind} onChange={e => update({ kind: e.target.value as LoopKind })}>
                    <option value="plain">Plain circle</option>
                    <option value="photon">Wavy (photon loop)</option>
                    <option value="gluon">Coiled (gluon loop)</option>
                  </select>
                ))}
                {sel.kind === 'plain' && field('Fill', (
                  <select value={sel.fill} onChange={e => update({ fill: e.target.value as LoopFill })}>
                    <option value="none">None (open loop)</option>
                    <option value="hatched">Hatched (blob)</option>
                    <option value="shaded">Shaded grey</option>
                  </select>
                ))}
                {field('Fermion flow (arrows)', (
                  <select value={sel.arrow ?? 0} onChange={e => update({ arrow: Number(e.target.value) as 0 | 1 | -1 })}>
                    <option value={0}>None</option>
                    <option value={1}>Clockwise ↻</option>
                    <option value={-1}>Counter-clockwise ↺</option>
                  </select>
                ))}
                {field(`Radius — ${num(sel.radius / UNIT)}`, <input type="range" min="12" max="120" step="2" value={sel.radius} onChange={e => update({ radius: Number(e.target.value) })} />)}
                {field(`Thickness — ${num(sel.thickness)}pt`, <input type="range" min="0.4" max="3" step="0.1" value={sel.thickness} onChange={e => update({ thickness: Number(e.target.value) })} />)}
                {colorField(sel.color)}
                {sel.kind !== 'plain' &&
                  field(`Wiggle size — ${num(sel.amplitude / UNIT)}`, <input type="range" min="2" max="14" step="0.5" value={sel.amplitude} onChange={e => update({ amplitude: Number(e.target.value) })} />)}
                {field('Label (above, Typst math)', <input type="text" value={sel.label} onChange={e => update({ label: e.target.value })} />)}
              </>
            )}

            {sel?.type === 'vertex' && (
              <>
                {field(`Dot size — ${num(sel.size / UNIT)}`, <input type="range" min="1.5" max="7" step="0.5" value={sel.size} onChange={e => update({ size: Number(e.target.value) })} />)}
                {colorField(sel.color)}
              </>
            )}

            {sel?.type === 'text' && (
              <>
                {field('Text (Typst math)', <input type="text" value={sel.text} onChange={e => update({ text: e.target.value })} autoFocus />)}
                {colorField(sel.color)}
              </>
            )}

            {sel && <button className="btn-ghost" style={{ marginTop: '10px', width: '100%' }} onClick={removeSel}>Delete element</button>}

            <div style={{ marginTop: '14px', borderTop: '1px solid #e2e8f0', paddingTop: '10px' }}>
              <label className="form-check">
                <input type="checkbox" checked={asFigure} onChange={e => setAsFigure(e.target.checked)} />
                Wrap in a numbered figure
              </label>
              {asFigure && (
                <>
                  {field('Caption', <input type="text" value={caption} onChange={e => setCaption(e.target.value)} />)}
                  {field('Label (optional)', <input type="text" value={figLabel} onChange={e => setFigLabel(e.target.value)} placeholder="feyn1 → @fig:feyn1" />)}
                </>
              )}
              <label className="form-check">
                <input type="checkbox" checked={showCode} onChange={e => setShowCode(e.target.checked)} />
                Show generated Typst code
              </label>
            </div>
          </div>
        </div>

        {showCode && code && (
          <pre style={{ margin: '0 16px', maxHeight: '160px', overflow: 'auto', fontSize: '11px', background: '#0f172a', color: '#e2e8f0', padding: '8px 10px', borderRadius: '6px' }}>
            {code.imports + code.canvas}
          </pre>
        )}

        <div className="modal-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleInsert} disabled={els.length === 0}>Insert</button>
        </div>
      </div>
    </div>
  );
}
