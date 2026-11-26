import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { prettyLabel } from '../feynmanLabels';
import { keys } from '../keys';
import { createHistory } from '../editHistory';

// Visual Feynman-diagram builder: draw propagators (fermion / photon / gluon /
// scalar / ghost), loops (plain, wavy or coiled circles), hatched or shaded
// blobs, vertices and labels on a snapping canvas — then insert the diagram as
// editable cetz code. Everything maps 1:1 onto cetz primitives: wavy and coiled
// lines are `decorations.wave` / `decorations.coil`, hatching is explicit chord
// lines (so no deprecated `pattern`/`tiling` is needed).

type Pt = { x: number, y: number };
type EdgeKind = 'fermion' | 'antifermion' | 'photon' | 'gluon' | 'scalar' | 'ghost' | 'plain' | 'double' | 'cscalar' | 'majorana' | 'wilson';
type LoopKind = 'plain' | 'scalar' | 'photon' | 'gluon';
type LoopFill = 'none' | 'hatched' | 'shaded' | 'gradient';

// For loop-integral notes (IBP): a line can be faded (dotted grey, a line taken out, as in a spanning
// tree) or hidden (keeps its place for snapping, draws nothing); dots on a line mark a raised power of
// that propagator; a momentum arrow runs beside a line or loop, on its label's side.
type LineStyle = 'normal' | 'faded' | 'hidden';
type Edge = {
  id: number, type: 'edge', kind: EdgeKind, from: Pt, to: Pt, bend: number, thickness: number, amplitude: number,
  endArrow: boolean, label: string, side: 1 | -1, color?: string,
  arc?: boolean,                         // bent as a true circular arc rather than a quadratic curve
  ellipse?: boolean,                     // bent as half an ellipse (the usual hadron-correlator outline)
  sub?: Sub,                             // a piece of a line that was split: part t0..t1 of that line's shape
  dots?: number, style?: LineStyle, mom?: 0 | 1 | -1,
  labelAt?: 'mid' | 'start' | 'end',     // an external leg's p_1 sits past its outer end
};
type Loop = {
  id: number, type: 'loop', kind: LoopKind, fill: LoopFill, center: Pt, radius: number, thickness: number, amplitude: number,
  label: string, color?: string, arrow?: 0 | 1 | -1, half?: Half,
  labelBelow?: string, style?: LineStyle, mom?: 0 | 1 | -1,
};
// A split line remembers the shape it was cut from (its ends and bend) and which part of it it is, so a
// piece follows exactly the curve the whole line had.
type Sub = { from: Pt, to: Pt, bend: number, t0: number, t1: number };
type VertexShape = 'dot' | 'cross' | 'open' | 'hidden';
type Vertex = { id: number, type: 'vertex', at: Pt, size: number, color?: string, shape?: VertexShape };
type TextEl = { id: number, type: 'text', at: Pt, text: string, color?: string };
// An oval: the interpolating-operator blobs of a hadron correlator, or a shaded region behind lines. Its
// fill can cover one half only; it is always drawn behind the lines.
type OvalFill = 'none' | 'shaded' | 'gradient' | 'hatched';
type Half = 'whole' | 'left' | 'right' | 'top' | 'bottom';
type Oval = {
  id: number, type: 'oval', center: Pt, rx: number, ry: number, fill: OvalFill, half?: Half,
  outline: boolean, thickness: number, color?: string,
  kind?: LoopKind, arrow?: 0 | 1 | -1, amplitude?: number,   // the outline drawn like a circle's: dashed, wavy, coiled, with arrows
};
type El = Edge | Loop | Vertex | TextEl | Oval;

const W = 680, H = 400, GRID = 20, UNIT = 40; // 40 px = 1 cetz unit
const gridLines = (step: number) => {
  let d = '';
  for (let x = 0; x <= W; x += step) d += `M ${x} 0 V ${H} `;
  for (let y = 0; y <= H; y += step) d += `M 0 ${y} H ${W} `;
  return d;
};
const GRID_MINOR = gridLines(GRID), GRID_MAJOR = gridLines(UNIT);
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
  { k: 'wilson', name: 'Wilson line ⋀⋁⋀ (gauge link)' },
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

// A line's shape, whatever it is: straight, a quadratic curve, or a circular arc whose middle sits `bend`
// px off the chord (the same meaning of bend in both, so the bend handle works the same).
type Curve = { pt: (t: number) => Pt, tan: (t: number) => Pt, len: number, arc: null | { c: Pt, r: number, a0: number, sweep: number } };
type Shape = { from: Pt, to: Pt, bend: number, arc?: boolean, ellipse?: boolean, sub?: Sub };
type BaseShape = { from: Pt, to: Pt, bend: number, arc?: boolean, ellipse?: boolean };

const sampledLen = (pt: (t: number) => Pt, n = 48) => {
  let len = 0, p = pt(0);
  for (let i = 1; i <= n; i++) { const q = pt(i / n); len += Math.hypot(q.x - p.x, q.y - p.y); p = q; }
  return len;
};

// Half an ellipse over the chord: the chord is its long axis and `bend` the other half-axis, so the line
// leaves both ends square to the chord. Point at angle φ = πt: M − U·h·cos φ + N·bend·sin φ.
function ellipseFrame(s: BaseShape) {
  const len = Math.hypot(s.to.x - s.from.x, s.to.y - s.from.y) || 1;
  const U = { x: (s.to.x - s.from.x) / len, y: (s.to.y - s.from.y) / len }, N = { x: -U.y, y: U.x };
  const M = { x: (s.from.x + s.to.x) / 2, y: (s.from.y + s.to.y) / 2 }, h = len / 2, b = s.bend;
  const at = (f: number): Pt => ({ x: M.x - U.x * h * Math.cos(f) + N.x * b * Math.sin(f), y: M.y - U.y * h * Math.cos(f) + N.y * b * Math.sin(f) });
  const d = (f: number): Pt => ({ x: U.x * h * Math.sin(f) + N.x * b * Math.cos(f), y: U.y * h * Math.sin(f) + N.y * b * Math.cos(f) });
  return { at, d };
}

function arcOf(a: Pt, b: Pt, bend: number) {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!bend || len < 1) return null;
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  const h = len / 2, s = Math.abs(bend);
  const r = (h * h + s * s) / (2 * s);
  const m = { x: (a.x + b.x) / 2 + nx * bend, y: (a.y + b.y) / 2 + ny * bend };   // the arc's middle
  const sg = Math.sign(bend);
  const c = { x: m.x - nx * sg * r, y: m.y - ny * sg * r };
  const a0 = Math.atan2(a.y - c.y, a.x - c.x), am = Math.atan2(m.y - c.y, m.x - c.x);
  const span = s <= h ? 2 * Math.asin(Math.min(1, h / r)) : 2 * Math.PI - 2 * Math.asin(Math.min(1, h / r));
  // Go whichever way round passes through the middle.
  const wrap = (v: number) => Math.atan2(Math.sin(v), Math.cos(v));
  const sweep = Math.abs(wrap(a0 + span / 2 - am)) < Math.abs(wrap(a0 - span / 2 - am)) ? span : -span;
  return { c, r, a0, sweep };
}

function curveOf(e: Shape): Curve {
  if (e.sub) {
    // A piece: the same curve as the line it came from, between t0 and t1.
    const base = curveOf({ from: e.sub.from, to: e.sub.to, bend: e.sub.bend, arc: e.arc, ellipse: e.ellipse });
    const { t0, t1 } = e.sub, k = t1 - t0;
    const pt = (t: number) => base.pt(t0 + k * t);
    return { pt, tan: t => { const d = base.tan(t0 + k * t); return k >= 0 ? d : { x: -d.x, y: -d.y }; }, len: sampledLen(pt), arc: null };
  }
  if (e.ellipse && e.bend) {
    const { at, d } = ellipseFrame(e);
    const pt = (t: number) => at(Math.PI * t);
    return {
      pt, tan: t => { const v = d(Math.PI * t), l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; },
      len: sampledLen(pt), arc: null,
    };
  }
  const arc = e.arc ? arcOf(e.from, e.to, e.bend) : null;
  if (arc) {
    const { c, r, a0, sweep } = arc;
    return {
      pt: t => ({ x: c.x + r * Math.cos(a0 + sweep * t), y: c.y + r * Math.sin(a0 + sweep * t) }),
      tan: t => { const g = a0 + sweep * t, s = Math.sign(sweep); return { x: -Math.sin(g) * s, y: Math.cos(g) * s }; },
      len: r * Math.abs(sweep),
      arc,
    };
  }
  const c = ctrlPt(e.from, e.to, e.bend);
  return { pt: t => bezPt(e.from, c, e.to, t), tan: t => bezTan(e.from, c, e.to, t), len: pathLen(e.from, c, e.to), arc: null };
}

// SVG path of a line's own shape.
function shapePath(e: Shape): string {
  const cv = curveOf(e);
  if (e.sub || (e.ellipse && e.bend)) {
    const pts: string[] = [];
    for (let i = 0; i <= 48; i++) { const p = cv.pt(i / 48); pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`); }
    return 'M' + pts.join(' L');
  }
  if (cv.arc) {
    const { r, sweep } = cv.arc;
    return `M${e.from.x},${e.from.y} A${r},${r} 0 ${Math.abs(sweep) > Math.PI ? 1 : 0} ${sweep > 0 ? 1 : 0} ${e.to.x},${e.to.y}`;
  }
  if (!e.bend) return `M${e.from.x},${e.from.y} L${e.to.x},${e.to.y}`;
  const c = ctrlPt(e.from, e.to, e.bend);
  return `M${e.from.x},${e.from.y} Q${c.x},${c.y} ${e.to.x},${e.to.y}`;
}

// A line shifted sideways by `off` px, as a polyline (the rails of a double line).
function offsetPath(cv: Curve, off: number): string {
  const pts: string[] = [];
  for (let i = 0; i <= 32; i++) {
    const p = cv.pt(i / 32), d = cv.tan(i / 32);
    pts.push(`${(p.x - d.y * off).toFixed(1)},${(p.y + d.x * off).toFixed(1)}`);
  }
  return 'M' + pts.join(' L');
}

// SVG preview path for a Wilson line: a sawtooth along the path, the usual way
// a gauge link is drawn so it cannot be mistaken for a propagator.
function zigzagPath(cv: Curve, amp: number): string {
  const len = cv.len;
  const teeth = Math.max(3, Math.round(len / 14));
  const N = teeth * 8;
  const pts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, u = 2 * Math.PI * teeth * t;
    const p = cv.pt(t), d = cv.tan(t);
    // A triangle wave, rather than the sine the photon uses.
    const wave = (2 / Math.PI) * Math.asin(Math.sin(u));
    pts.push(`${(p.x - d.y * amp * wave).toFixed(1)},${(p.y + d.x * amp * wave).toFixed(1)}`);
  }
  return 'M' + pts.join(' L');
}

// SVG preview path for a wavy / coiled edge (approximates what cetz renders)
function decoPath(cv: Curve, kind: 'photon' | 'gluon', amp: number): string {
  const len = cv.len;
  const cycles = Math.max(3, Math.round(len / (kind === 'photon' ? 13 : 12)));
  const N = cycles * 14;
  const pts: string[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, u = 2 * Math.PI * cycles * t;
    const p = cv.pt(t), d = cv.tan(t);
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

// Where a line's label goes: beside its middle, or past an end for an external leg's momentum. With a
// momentum arrow on that side, the label moves out past the arrow.
function edgeLabelPos(e: Edge): Pt {
  const cv = curveOf(e);
  if (e.labelAt === 'start' || e.labelAt === 'end') {
    const t = e.labelAt === 'start' ? 0 : 1, p = cv.pt(t), d = cv.tan(t), k = e.labelAt === 'start' ? -16 : 16;
    return { x: p.x + d.x * k, y: p.y + d.y * k };
  }
  const m = cv.pt(0.5), d = cv.tan(0.5);
  const off = (14 + e.amplitude + (e.mom ? 11 : 0)) * e.side;
  return { x: m.x - d.y * off, y: m.y + d.x * off };
}

// The momentum arrow beside a line: the middle part of the line, moved to the label's side.
const MOM_GAP = 10;
function edgeMomentum(e: Edge): { a: Pt, m: Pt, b: Pt, straight: boolean } | null {
  if (!e.mom) return null;
  const cv = curveOf(e);
  const off = (MOM_GAP + (e.kind === 'photon' || e.kind === 'gluon' || e.kind === 'wilson' ? e.amplitude : 0)) * e.side;
  const at = (t: number) => { const p = cv.pt(t), d = cv.tan(t); return { x: p.x - d.y * off, y: p.y + d.x * off }; };
  const [t0, t1] = e.mom === 1 ? [0.3, 0.7] : [0.7, 0.3];
  return { a: at(t0), m: at(0.5), b: at(t1), straight: !e.bend };
}

// The cetz call that draws a line's own shape, left open for its style (`…, stroke: …)`). A piece of a
// split line is drawn as exactly that part: a sub-arc through three of its points, the quadratic's own
// sub-curve, or the ellipse as cubic quarters (exact up to drawing precision).
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
function shapeCall(e: Shape): string {
  const s: BaseShape = e.sub ? { from: e.sub.from, to: e.sub.to, bend: e.sub.bend, arc: e.arc, ellipse: e.ellipse } : e;
  const [t0, t1] = e.sub ? [e.sub.t0, e.sub.t1] : [0, 1];
  const base = curveOf(s);
  if (!s.bend) return `line(${cx(base.pt(t0))}, ${cx(base.pt(t1))}`;
  if (s.ellipse) {
    const { at, d } = ellipseFrame(s);
    const f0 = Math.PI * t0, f1 = Math.PI * t1, n = Math.max(1, Math.ceil(Math.abs(f1 - f0) / (Math.PI / 2) - 1e-9));
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      const a = f0 + (f1 - f0) * i / n, b = f0 + (f1 - f0) * (i + 1) / n, k = 4 / 3 * Math.tan((b - a) / 4);
      const pa = at(a), pb = at(b), da = d(a), db = d(b);
      parts.push(`bezier(${cx(pa)}, ${cx(pb)}, ${cx({ x: pa.x + k * da.x, y: pa.y + k * da.y })}, ${cx({ x: pb.x - k * db.x, y: pb.y - k * db.y })})`);
    }
    return `merge-path({ ${parts.join('; ')} }`;
  }
  if (base.arc) return `arc-through(${cx(base.pt(t0))}, ${cx(base.pt((t0 + t1) / 2))}, ${cx(base.pt(t1))}`;
  // The control point of the quadratic's part between t0 and t1 (its blossom at t0, t1).
  const c = ctrlPt(s.from, s.to, s.bend);
  const cc = lerp(lerp(s.from, c, t0), lerp(c, s.to, t0), t1);
  return `bezier(${cx(base.pt(t0))}, ${cx(base.pt(t1))}, ${cx(cc)}`;
}

const fadedStroke = (th: number) => `(thickness: ${num(th)}pt, paint: luma(62%), dash: "densely-dotted")`;

function edgeCode(e: Edge): string[] {
  const out: string[] = [];
  if (e.style === 'hidden') return out;
  const faded = e.style === 'faded';
  const cv = curveOf(e);
  const len = cv.len;
  const shapeCode = (a: Pt, b: Pt, m: Pt, cc: Pt) => cv.arc
    ? `arc-through(${cx(a)}, ${cx(m)}, ${cx(b)}`
    : e.bend === 0 ? `line(${cx(a)}, ${cx(b)}` : `bezier(${cx(a)}, ${cx(b)}, ${cx(cc)}`;
  const c = ctrlPt(e.from, e.to, e.bend);
  const base = shapeCall(e);
  // merge-path draws no marks of its own, so an end arrow there is a separate mark.
  const ownMarks = !base.startsWith('merge-path');
  const plainStroke = faded ? fadedStroke(e.thickness) : strokeOf(e.thickness, e.color);

  // An arrowhead somewhere along the edge (dir +1 points forward, -1 backward).
  const midMark = (t: number, dir: number) => {
    if (faded) return;
    const m = cv.pt(t), d = cv.tan(t), ex = 3.2;
    const p1 = { x: m.x - dir * d.x * ex, y: m.y - dir * d.y * ex };
    const p2 = { x: m.x + dir * d.x * ex, y: m.y + dir * d.y * ex };
    out.push(`  mark(${cx(p1)}, ${cx(p2)}, symbol: ">", fill: ${paintOf(e.color)}, stroke: ${paintOf(e.color)}, scale: ${num(Math.max(0.8, e.thickness * 0.8))})`);
  };

  if (e.kind === 'wilson') {
    const teeth = Math.max(3, Math.round(len / 14));
    out.push(`  decorations.zigzag(${base}), stroke: ${plainStroke}, amplitude: ${num(e.amplitude / UNIT)}, segments: ${teeth})`);
    midMark(0.5, 1);
  } else if (e.kind === 'photon' || e.kind === 'gluon') {
    const fn = e.kind === 'photon' ? 'wave' : 'coil';
    const segs = Math.max(3, Math.round(len / (e.kind === 'photon' ? 13 : 12)));
    out.push(`  decorations.${fn}(${base}), stroke: ${plainStroke}, amplitude: ${num(e.amplitude / UNIT)}, segments: ${segs})`);
  } else if (e.kind === 'double') {
    // Two rails, each the line moved sideways (an arc's rails are arcs with the same centre).
    for (const sg of [1, -1]) {
      const o = (t: number): Pt => { const p = cv.pt(t), d = cv.tan(t); return { x: p.x - d.y * DBL * sg, y: p.y + d.x * DBL * sg }; };
      if (e.sub || e.ellipse) {
        out.push(`  line(${Array.from({ length: 33 }, (_, i) => cx(o(i / 32))).join(', ')}, stroke: ${plainStroke})`);
        continue;
      }
      const l0 = Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y) || 1;
      const nx = -(e.to.y - e.from.y) / l0, ny = (e.to.x - e.from.x) / l0;
      const oc = { x: c.x + nx * DBL * sg, y: c.y + ny * DBL * sg };
      out.push(`  ${shapeCode(o(0), o(1), o(0.5), oc)}, stroke: ${plainStroke})`);
    }
    if (e.endArrow) midMark(0.94, 1);
  } else {
    const stroke = faded ? fadedStroke(e.thickness)
      : (e.kind === 'scalar' || e.kind === 'cscalar') ? dashStroke(e.thickness, 'dashed', e.color)
      : e.kind === 'ghost' ? dashStroke(e.thickness, 'dotted', e.color) : strokeOf(e.thickness, e.color);
    const mark = e.endArrow && !faded && ownMarks ? `, mark: (end: ">", fill: ${paintOf(e.color)})` : '';
    out.push(`  ${base}, stroke: ${stroke}${mark})`);
    if (e.endArrow && !faded && !ownMarks) {
      const back = cv.pt(Math.max(0, 1 - 6 / (cv.len || 1)));
      out.push(`  mark(${cx(back)}, ${cx(e.to)}, symbol: ">", fill: ${paintOf(e.color)}, stroke: ${paintOf(e.color)}, scale: ${num(Math.max(0.8, e.thickness * 0.8))})`);
    }
    // Directional arrows in the middle of the propagator.
    if (e.kind === 'fermion' || e.kind === 'cscalar' || e.kind === 'ghost') midMark(0.5, 1);
    else if (e.kind === 'antifermion') midMark(0.5, -1);
    else if (e.kind === 'majorana') { midMark(0.4, 1); midMark(0.6, -1); } // two clashing arrows
  }

  // Dots: the propagator raised to a higher power, one dot per extra power.
  const dots = Math.max(0, Math.min(4, e.dots ?? 0));
  for (let i = 1; i <= dots; i++)
    out.push(`  circle(${cx(cv.pt(i / (dots + 1)))}, radius: ${num(DOT_R / UNIT)}, fill: ${faded ? 'luma(62%)' : paintOf(e.color)}, stroke: none)`);

  const mom = faded ? null : edgeMomentum(e);
  if (mom) {
    const paint = paintOf(e.color);
    out.push(mom.straight
      ? `  line(${cx(mom.a)}, ${cx(mom.b)}, stroke: 0.7pt + ${paint}, mark: (end: ">", fill: ${paint}))`
      : `  arc-through(${cx(mom.a)}, ${cx(mom.m)}, ${cx(mom.b)}, stroke: 0.7pt + ${paint}, mark: (end: ">", fill: ${paint}))`);
  }
  if (e.label.trim()) out.push(`  content(${cx(edgeLabelPos(e))}, ${mathContent(e.label.trim(), faded ? '#9e9e9e' : e.color)})`);
  return out;
}

const DOT_R = 3.2;
// Canvas labels: a font with the combining marks Typst math uses (the arrow of arrow(p), a bar), listed
// first since a missing mark does not fall back to the next font.
const LABEL_FONT = "'STIX Two Text', 'Times New Roman', Georgia, serif";

// ---- ovals and vertex shapes ----
const HALF_START: Record<Exclude<Half, 'whole'>, number> = { right: -90, left: 90, top: 0, bottom: 180 };   // cetz angles, y up

// The hatching chords of an oval (45°, as for a hatched circle), cut to the filled half.
function ovalHatch(o: Oval): [Pt, Pt][] {
  const out: [Pt, Pt][] = [];
  const sp = Math.max(7, (o.rx + o.ry) / 2 / 3.2);
  const u = { x: Math.SQRT1_2, y: -Math.SQRT1_2 }, n = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
  const R = Math.sqrt((o.rx * o.rx + o.ry * o.ry) / 2);
  const half = o.half ?? 'whole';
  for (let cD = -R + sp; cD < R - 1; cD += sp) {
    const A = (u.x / o.rx) ** 2 + (u.y / o.ry) ** 2;
    const B = 2 * (n.x * cD * u.x / o.rx ** 2 + n.y * cD * u.y / o.ry ** 2);
    const C = (n.x * cD / o.rx) ** 2 + (n.y * cD / o.ry) ** 2 - 1;
    const disc = B * B - 4 * A * C;
    if (disc <= 0) continue;
    let s1 = (-B - Math.sqrt(disc)) / (2 * A), s2 = (-B + Math.sqrt(disc)) / (2 * A);
    if (half !== 'whole') {
      // Keep the part where a0 + a1·s ≥ 0.
      const [a0, a1] = half === 'right' ? [n.x * cD, u.x] : half === 'left' ? [-n.x * cD, -u.x]
        : half === 'top' ? [-n.y * cD, -u.y] : [n.y * cD, u.y];
      const lim = -a0 / a1;
      if (a1 > 0) s1 = Math.max(s1, lim); else s2 = Math.min(s2, lim);
    }
    if (s2 - s1 < 1) continue;
    const p = (s: number): Pt => ({ x: o.center.x + n.x * cD + u.x * s, y: o.center.y + n.y * cD + u.y * s });
    out.push([p(s1), p(s2)]);
  }
  return out;
}

function ovalFillCode(o: { fill: string, color?: string }): string | null {
  if (o.fill === 'shaded') return tint(o.color) ? `${tint(o.color)}.lighten(70%)` : 'gray.lighten(50%)';
  if (o.fill === 'gradient') {
    const c = tint(o.color) ?? 'luma(60%)';
    return `gradient.radial(${c}.lighten(55%), ${c}, ${c}.darken(35%), center: (35%, 30%), radius: 80%)`;
  }
  return null;
}

// An oval's perimeter (Ramanujan), for spacing the wiggles of a wavy or coiled outline.
const ovalPerimeter = (o: Oval) => Math.PI * (3 * (o.rx + o.ry) - Math.sqrt((3 * o.rx + o.ry) * (o.rx + 3 * o.ry)));

function ovalCode(o: Oval): string[] {
  const out: string[] = [];
  const r = `(${num(o.rx / UNIT)}, ${num(o.ry / UNIT)})`;
  const kind = o.kind ?? 'plain', wiggly = kind === 'photon' || kind === 'gluon';
  const stroke = !o.outline ? 'none' : kind === 'scalar' ? dashStroke(o.thickness, 'dashed', o.color) : strokeOf(o.thickness, o.color);
  const fill = ovalFillCode(o), half = o.half ?? 'whole';
  if (fill && half !== 'whole') {
    out.push(`  arc(${cx(o.center)}, start: ${HALF_START[half]}deg, delta: 180deg, radius: ${r}, anchor: "origin", mode: "CLOSE", fill: ${fill}, stroke: none)`);
    if (o.outline && !wiggly) out.push(`  circle(${cx(o.center)}, radius: ${r}, stroke: ${stroke})`);
  } else if (fill || (o.outline && !wiggly)) {
    out.push(`  circle(${cx(o.center)}, radius: ${r}, ${fill ? `fill: ${fill}, ` : ''}stroke: ${wiggly ? 'none' : stroke})`);
  }
  if (o.outline && wiggly) {
    const segs = Math.max(6, Math.round(ovalPerimeter(o) / (kind === 'photon' ? 13 : 12)));
    out.push(`  decorations.${kind === 'photon' ? 'wave' : 'coil'}(circle(${cx(o.center)}, radius: ${r}), stroke: ${strokeOf(o.thickness, o.color)}, amplitude: ${num((o.amplitude ?? 5) / UNIT)}, segments: ${segs})`);
  }
  // Flow arrows at the top and bottom, as on a circle (1 = clockwise on the page).
  if (o.outline && o.arrow) {
    const ex = 3.2, sc = num(Math.max(0.8, o.thickness * 0.8));
    for (const [py, dir] of [[o.center.y - o.ry, o.arrow], [o.center.y + o.ry, -o.arrow]] as const)
      out.push(`  mark(${cx({ x: o.center.x - dir * ex, y: py })}, ${cx({ x: o.center.x + dir * ex, y: py })}, symbol: ">", fill: ${paintOf(o.color)}, stroke: ${paintOf(o.color)}, scale: ${sc})`);
  }
  if (o.fill === 'hatched')
    for (const [a, b] of ovalHatch(o)) out.push(`  line(${cx(a)}, ${cx(b)}, stroke: ${strokeOf(Math.max(0.4, o.thickness * 0.45), o.color)})`);
  return out;
}

const CROSS = 1.3;   // a cross's arm, in dot radii
function vertexCode(v: Vertex): string[] {
  const shape = v.shape ?? 'dot';
  if (shape === 'hidden') return [];
  if (shape === 'cross') {
    const a = v.size * CROSS, st = `1.2pt + ${paintOf(v.color)}`;
    return [
      `  line(${cx({ x: v.at.x - a, y: v.at.y - a })}, ${cx({ x: v.at.x + a, y: v.at.y + a })}, stroke: ${st})`,
      `  line(${cx({ x: v.at.x - a, y: v.at.y + a })}, ${cx({ x: v.at.x + a, y: v.at.y - a })}, stroke: ${st})`,
    ];
  }
  if (shape === 'open') return [`  circle(${cx(v.at)}, radius: ${num(v.size / UNIT)}, fill: white, stroke: 1pt + ${paintOf(v.color)})`];
  return [`  circle(${cx(v.at)}, radius: ${num(v.size / UNIT)}, fill: ${paintOf(v.color)}, stroke: none)`];
}

// Cut a line in two at t (0 < t < 1). Both pieces keep the line's exact curve: a straight line gives two
// straight lines, a circular arc two arcs of the same circle, and a curve or half ellipse two pieces that
// remember it. Label, dots and momentum arrow stay with the longer piece (an end label with its end).
function splitEdge(e: Edge, t: number, nextId: () => number): [Edge, Edge] {
  const cv = curveOf(e);
  const raw = cv.pt(t), P = { x: Math.round(raw.x * 10) / 10, y: Math.round(raw.y * 10) / 10 };
  const s: Sub = e.sub ?? { from: e.from, to: e.to, bend: e.bend, t0: 0, t1: 1 };
  const tm = s.t0 + (s.t1 - s.t0) * t;
  let a: Edge, b: Edge;
  if (!s.bend) {
    a = { ...e, sub: undefined, to: P, bend: 0 };
    b = { ...e, sub: undefined, from: P, bend: 0 };
  } else if (e.arc && !e.ellipse) {
    a = { ...e, sub: undefined, to: P, bend: bendThrough(e.from, P, cv.pt(t / 2)) };
    b = { ...e, sub: undefined, from: P, bend: bendThrough(P, e.to, cv.pt((1 + t) / 2)) };
  } else {
    a = { ...e, to: P, sub: { ...s, t1: tm } };
    b = { ...e, from: P, sub: { ...s, t0: tm } };
  }
  a = { ...a, id: nextId(), endArrow: false };
  b = { ...b, id: nextId() };
  const firstKeeps = e.labelAt === 'start' || (e.labelAt !== 'end' && t >= 0.5);
  const bare = { label: '', dots: 0, mom: 0 as const, labelAt: undefined };
  return firstKeeps ? [a, { ...b, ...bare }] : [{ ...a, ...bare }, b];
}

// The t on a line nearest to p, and how far p is from it.
function nearestOnCurve(e: Edge, p: Pt): { t: number, dist: number } {
  const cv = curveOf(e);
  let best = { t: 0, dist: Infinity };
  for (let i = 0; i <= 400; i++) {
    const q = cv.pt(i / 400), dist = Math.hypot(q.x - p.x, q.y - p.y);
    if (dist < best.dist) best = { t: i / 400, dist };
  }
  // Then narrow it down between the neighbouring samples.
  let lo = Math.max(0, best.t - 1 / 400), hi = Math.min(1, best.t + 1 / 400);
  const d = (t: number) => { const q = cv.pt(t); return Math.hypot(q.x - p.x, q.y - p.y); };
  for (let i = 0; i < 40; i++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (d(m1) < d(m2)) hi = m2; else lo = m1;
  }
  const t = (lo + hi) / 2;
  return d(t) < best.dist ? { t, dist: d(t) } : best;
}

// A piece of a split line, made an ordinary line again (when its ends or bend are edited): a curve with
// the same middle, or a circular arc through the same middle for a piece of a half ellipse.
function detachPiece(e: Edge): Edge {
  if (!e.sub) return e;
  const mid = curveOf(e).pt(0.5);
  const { sub: _sub, ...rest } = e;
  return { ...rest, arc: e.arc || e.ellipse, ellipse: false, bend: bendThrough(e.from, e.to, mid) };
}

// A loop's momentum arrow: an arc just outside the top of the circle, clockwise for 1.
function loopMomentum(l: Loop): { a: Pt, m: Pt, b: Pt } | null {
  if (!l.mom) return null;
  const R = l.radius + MOM_GAP + (l.kind === 'photon' || l.kind === 'gluon' ? l.amplitude : 0);
  const at = (deg: number) => ({ x: l.center.x + R * Math.cos(deg * Math.PI / 180), y: l.center.y + R * Math.sin(deg * Math.PI / 180) });
  // SVG angles grow clockwise on screen; -90 is the top.
  const [d0, d1] = l.mom === 1 ? [-125, -55] : [-55, -125];
  return { a: at(d0), m: at(-90), b: at(d1) };
}

const loopLabelAbove = (l: Loop): Pt => ({ x: l.center.x, y: l.center.y - l.radius - 14 - (l.mom ? 12 : 0) - (l.kind === 'photon' || l.kind === 'gluon' ? l.amplitude : 0) });
const loopLabelBelow = (l: Loop): Pt => ({ x: l.center.x, y: l.center.y + l.radius + 14 + (l.kind === 'photon' || l.kind === 'gluon' ? l.amplitude : 0) });

function loopCode(l: Loop): string[] {
  const out: string[] = [];
  if (l.style === 'hidden') return out;
  if (l.style === 'faded') {
    out.push(`  circle(${cx(l.center)}, radius: ${num(l.radius / UNIT)}, stroke: ${fadedStroke(l.thickness)})`);
  } else if (l.kind === 'plain' || l.kind === 'scalar') {
    const fillExpr = ovalFillCode(l), half = l.half ?? 'whole';
    // A scalar runs dashed, loop or line.
    const stroke = l.kind === 'scalar' ? dashStroke(l.thickness, 'dashed', l.color) : strokeOf(l.thickness, l.color);
    if (fillExpr && half !== 'whole') {
      // Only one half filled: that half as a closed half-disc, then the whole circle's outline.
      out.push(`  arc(${cx(l.center)}, start: ${HALF_START[half]}deg, delta: 180deg, radius: ${num(l.radius / UNIT)}, anchor: "origin", mode: "CLOSE", fill: ${fillExpr}, stroke: none)`);
      out.push(`  circle(${cx(l.center)}, radius: ${num(l.radius / UNIT)}, stroke: ${stroke})`);
    } else out.push(`  circle(${cx(l.center)}, radius: ${num(l.radius / UNIT)}, stroke: ${stroke}${fillExpr ? `, fill: ${fillExpr}` : ''})`);
  } else {
    const fn = l.kind === 'photon' ? 'wave' : 'coil';
    const segs = Math.max(6, Math.round(2 * Math.PI * l.radius / (l.kind === 'photon' ? 13 : 12)));
    out.push(`  decorations.${fn}(circle(${cx(l.center)}, radius: ${num(l.radius / UNIT)}), stroke: ${strokeOf(l.thickness, l.color)}, amplitude: ${num(l.amplitude / UNIT)}, segments: ${segs})`);
  }
  if (l.fill === 'hatched' && l.style !== 'faded' && (l.half ?? 'whole') !== 'whole') {
    for (const [a, b] of ovalHatch(circleAsOval(l))) out.push(`  line(${cx(a)}, ${cx(b)}, stroke: ${strokeOf(Math.max(0.4, l.thickness * 0.45), l.color)})`);
  } else if (l.fill === 'hatched' && l.style !== 'faded') {
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
  if (l.arrow && l.style !== 'faded') {
    const ex = 3.2, sc = num(Math.max(0.8, l.thickness * 0.8));
    for (const [py, dir] of [[l.center.y - l.radius, l.arrow], [l.center.y + l.radius, -l.arrow]] as const) {
      const p1 = { x: l.center.x - dir * ex, y: py };
      const p2 = { x: l.center.x + dir * ex, y: py };
      out.push(`  mark(${cx(p1)}, ${cx(p2)}, symbol: ">", fill: ${paintOf(l.color)}, stroke: ${paintOf(l.color)}, scale: ${sc})`);
    }
  }
  const mom = l.style === 'faded' ? null : loopMomentum(l);
  if (mom) {
    const paint = paintOf(l.color);
    out.push(`  arc-through(${cx(mom.a)}, ${cx(mom.m)}, ${cx(mom.b)}, stroke: 0.7pt + ${paint}, mark: (end: ">", fill: ${paint}))`);
  }
  const ink = l.style === 'faded' ? '#9e9e9e' : l.color;
  if (l.label.trim()) out.push(`  content(${cx(loopLabelAbove(l))}, ${mathContent(l.label.trim(), ink)})`);
  if (l.labelBelow?.trim()) out.push(`  content(${cx(loopLabelBelow(l))}, ${mathContent(l.labelBelow.trim(), ink)})`);
  return out;
}

const mathContent = (t: string, c?: string) => {
  const body = t.startsWith('$') ? `[${t}]` : `[$${t}$]`;
  return tint(c) ? `text(fill: ${tint(c)}, ${body})` : body;
};

// ---- templates --------------------------------------------------------------
let tid = 1000;
const T = (x: number, y: number): Pt => ({ x, y });
// ---- SVG rendering ----
// Pure, so the examples browser can draw a thumbnail with the very same lines
// the canvas uses.
function drawEdge(e: Edge, selected: number | null) {
  const isSel = e.id === selected;
  const cv = curveOf(e);
  const faded = e.style === 'faded', hidden = e.style === 'hidden';
  // Faded draws grey and dotted, as it prints; hidden prints nothing but stays faintly visible here so it
  // can still be picked.
  const col = isSel ? '#7c3aed' : hidden ? '#cbd5e1' : faded ? '#9e9e9e' : previewCol(e.color, false);
  const basePath = shapePath(e);
  const parts: React.ReactNode[] = [];
  const midArrow = (t: number, back: boolean) => {
    if (faded || hidden) return;
    const m = cv.pt(t), d = cv.tan(t);
    parts.push(<polygon key={`a${t}-${back}`} points={arrowPts(m, d, 5 + e.thickness * 1.5, back)} fill={col} />);
  };
  const lineDash = hidden ? '3 6' : faded ? '1.5 3' : undefined;
  if (e.kind === 'photon' || e.kind === 'gluon') {
    parts.push(<path key="p" d={decoPath(cv, e.kind, e.amplitude)} fill="none" stroke={col} strokeWidth={e.thickness} strokeDasharray={lineDash} />);
  } else if (e.kind === 'wilson') {
    parts.push(<path key="p" d={zigzagPath(cv, e.amplitude)} fill="none" stroke={col} strokeWidth={e.thickness} strokeDasharray={lineDash} />);
    midArrow(0.5, false); // a gauge link runs one way; show which
  } else if (e.kind === 'double') {
    for (const sg of [1, -1]) parts.push(<path key={`d${sg}`} d={offsetPath(cv, DBL * sg)} fill="none" stroke={col} strokeWidth={e.thickness} strokeDasharray={lineDash} />);
    if (e.endArrow) midArrow(0.94, false);
  } else {
    const dash = lineDash ?? ((e.kind === 'scalar' || e.kind === 'cscalar') ? '8 5' : e.kind === 'ghost' ? '2 5' : undefined);
    parts.push(<path key="p" d={basePath} fill="none" stroke={col} strokeWidth={e.thickness} strokeDasharray={dash} />);
    if (e.kind === 'fermion' || e.kind === 'cscalar' || e.kind === 'ghost') midArrow(0.5, false);
    else if (e.kind === 'antifermion') midArrow(0.5, true);
    else if (e.kind === 'majorana') { midArrow(0.4, false); midArrow(0.6, true); }
  }
  if (e.endArrow && !faded && !hidden && e.kind !== 'photon' && e.kind !== 'gluon' && e.kind !== 'double' && e.kind !== 'wilson') {
    const d = cv.tan(1);
    parts.push(<polygon key="e" points={arrowPts(e.to, d, 5 + e.thickness * 1.5, false)} fill={col} />);
  }
  if (!hidden) {
    const dots = Math.max(0, Math.min(4, e.dots ?? 0));
    for (let i = 1; i <= dots; i++) {
      const p = cv.pt(i / (dots + 1));
      parts.push(<circle key={`dot${i}`} cx={p.x} cy={p.y} r={DOT_R} fill={col} />);
    }
    const mom = faded ? null : edgeMomentum(e);
    if (mom) {
      const c = { x: 2 * mom.m.x - (mom.a.x + mom.b.x) / 2, y: 2 * mom.m.y - (mom.a.y + mom.b.y) / 2 };
      const d0 = { x: mom.b.x - c.x, y: mom.b.y - c.y }, l0 = Math.hypot(d0.x, d0.y) || 1;
      parts.push(<path key="mom" d={mom.straight ? `M${mom.a.x},${mom.a.y} L${mom.b.x},${mom.b.y}` : `M${mom.a.x},${mom.a.y} Q${c.x},${c.y} ${mom.b.x},${mom.b.y}`} fill="none" stroke={col} strokeWidth={0.9} />);
      const dir = mom.straight ? (() => { const v = { x: mom.b.x - mom.a.x, y: mom.b.y - mom.a.y }, l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; })() : { x: d0.x / l0, y: d0.y / l0 };
      parts.push(<polygon key="moma" points={arrowPts(mom.b, dir, 4.5, false)} fill={col} />);
    }
    if (e.label.trim()) {
      const at = edgeLabelPos(e);
      parts.push(<text key="l" x={at.x} y={at.y} fontSize="13" fontStyle="italic" fontFamily={LABEL_FONT} textAnchor="middle" dominantBaseline="middle" fill={col}>{prettyLabel(e.label)}</text>);
    }
  }
  return <g key={e.id}>{parts}</g>;
}

function drawLoop(l: Loop, selected: number | null) {
  const isSel = l.id === selected;
  const faded = l.style === 'faded', hidden = l.style === 'hidden';
  const col = isSel ? '#7c3aed' : hidden ? '#cbd5e1' : faded ? '#9e9e9e' : previewCol(l.color, false);
  const parts: React.ReactNode[] = [];
  if (faded || hidden) {
    parts.push(<circle key="c" cx={l.center.x} cy={l.center.y} r={l.radius} fill="none" stroke={col} strokeWidth={l.thickness} strokeDasharray={hidden ? '3 6' : '1.5 3'} />);
    if (hidden) return <g key={l.id}>{parts}</g>;
  } else if (l.kind === 'plain' || l.kind === 'scalar') {
    parts.push(...drawFill({ center: l.center, rx: l.radius, ry: l.radius, fill: l.fill, color: l.color, half: l.half }, `loopg-${l.id}`));
    parts.push(<circle key="c" cx={l.center.x} cy={l.center.y} r={l.radius} fill="none" stroke={col} strokeWidth={l.thickness} strokeDasharray={l.kind === 'scalar' ? '8 5' : undefined} />);
  } else {
    parts.push(<path key="c" d={decoCirclePath(l.center, l.radius, l.kind, l.amplitude)} fill="none" stroke={col} strokeWidth={l.thickness} />);
  }
  if (l.fill === 'hatched' && !faded && (l.half ?? 'whole') !== 'whole') {
    parts.push(<g key="h">{ovalHatch(circleAsOval(l)).map(([p, q], i) => <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={col} strokeWidth={Math.max(0.4, l.thickness * 0.45)} />)}</g>);
  } else if (l.fill === 'hatched' && !faded) {
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
  if (l.arrow && !faded) {
    const size = 4 + l.thickness * 2;
    parts.push(<polygon key="a1" points={arrowPts({ x: l.center.x, y: l.center.y - l.radius }, { x: l.arrow, y: 0 }, size, false)} fill={col} />);
    parts.push(<polygon key="a2" points={arrowPts({ x: l.center.x, y: l.center.y + l.radius }, { x: -l.arrow, y: 0 }, size, false)} fill={col} />);
  }
  const mom = faded ? null : loopMomentum(l);
  if (mom) {
    const R = Math.hypot(mom.m.x - l.center.x, mom.m.y - l.center.y);
    parts.push(<path key="mom" d={`M${mom.a.x},${mom.a.y} A${R},${R} 0 0 ${l.mom === 1 ? 1 : 0} ${mom.b.x},${mom.b.y}`} fill="none" stroke={col} strokeWidth={0.9} />);
    const g = (l.mom === 1 ? -55 : -125) * Math.PI / 180, sg = l.mom === 1 ? 1 : -1;
    parts.push(<polygon key="moma" points={arrowPts(mom.b, { x: -Math.sin(g) * sg, y: Math.cos(g) * sg }, 4.5, false)} fill={col} />);
  }
  const label = (key: string, text: string, at: Pt) =>
    <text key={key} x={at.x} y={at.y} fontSize="13" fontStyle="italic" fontFamily={LABEL_FONT} textAnchor="middle" dominantBaseline="middle" fill={col}>{prettyLabel(text)}</text>;
  if (l.label.trim()) parts.push(label('l', l.label, loopLabelAbove(l)));
  if (l.labelBelow?.trim()) parts.push(label('lb', l.labelBelow, loopLabelBelow(l)));
  return <g key={l.id}>{parts}</g>;
}

// Mix a #rrggbb colour with white (amount > 0) or black (amount < 0), for the preview of a shading.
function mixHex(c: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  if (!m) return c;
  const v = parseInt(m[1], 16), ch = [v >> 16, (v >> 8) & 255, v & 255];
  const to = amount > 0 ? 255 : 0, k = Math.abs(amount);
  return '#' + ch.map(x => Math.round(x + (to - x) * k).toString(16).padStart(2, '0')).join('');
}

const circleAsOval = (l: Loop): Oval =>
  ({ id: l.id, type: 'oval', center: l.center, rx: l.radius, ry: l.radius, fill: l.fill === 'hatched' ? 'hatched' : 'none', half: l.half, outline: false, thickness: l.thickness, color: l.color });

// The fill of an oval or circle on the canvas: flat or a radial shading, whole or one half.
function drawFill(o: { center: Pt, rx: number, ry: number, fill: string, color?: string, half?: Half }, gid: string): React.ReactNode[] {
  const base = tint(o.color) ? o.color! : '#9e9e9e';
  const { x, y } = o.center, { rx, ry } = o;
  const half = o.half ?? 'whole';
  const parts: React.ReactNode[] = [];
  const fill = o.fill === 'shaded' ? (tint(o.color) ? mixHex(o.color!, 0.7) : '#d4d4d4') : o.fill === 'gradient' ? `url(#${gid})` : null;
  if (!fill) return parts;
  if (o.fill === 'gradient') parts.push(
    <defs key="d"><radialGradient id={gid} cx="35%" cy="30%" r="80%">
      <stop offset="0" stopColor={mixHex(base, 0.55)} /><stop offset="0.5" stopColor={base} /><stop offset="1" stopColor={mixHex(base, -0.35)} />
    </radialGradient></defs>);
  if (half === 'whole') parts.push(<ellipse key="f" cx={x} cy={y} rx={rx} ry={ry} fill={fill} stroke="none" />);
  else {
    const [a, b] = half === 'right' ? [[x, y - ry], [x, y + ry]] : half === 'left' ? [[x, y + ry], [x, y - ry]]
      : half === 'top' ? [[x - rx, y], [x + rx, y]] : [[x + rx, y], [x - rx, y]];
    parts.push(<path key="f" d={`M${a[0]},${a[1]} A${rx},${ry} 0 0 1 ${b[0]},${b[1]} Z`} fill={fill} stroke="none" />);
  }
  return parts;
}

// An oval's outline as a closed curve at even spacing along its length, for drawing wiggles around it.
function ovalCurve(o: Oval): Curve {
  // Anticlockwise on the page, so the wiggles' side (left of travel) is the outside, as cetz draws them.
  const raw = (u: number): Pt => ({ x: o.center.x + o.rx * Math.cos(2 * Math.PI * u), y: o.center.y - o.ry * Math.sin(2 * Math.PI * u) });
  const N = 240, cum = [0];
  for (let i = 1; i <= N; i++) { const a = raw((i - 1) / N), b = raw(i / N); cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.y - a.y)); }
  const len = cum[N];
  const param = (t: number) => {
    const target = t * len;
    let lo = 0, hi = N;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] < target) lo = m; else hi = m; }
    return (lo + (target - cum[lo]) / ((cum[hi] - cum[lo]) || 1)) / N;
  };
  const pt = (t: number) => raw(param(t));
  const tan = (t: number) => {
    const u = 2 * Math.PI * param(t), v = { x: -o.rx * Math.sin(u), y: -o.ry * Math.cos(u) }, l = Math.hypot(v.x, v.y) || 1;
    return { x: v.x / l, y: v.y / l };
  };
  return { pt, tan, len, arc: null };
}

function drawOval(o: Oval, selected: number | null, idPrefix = 'c') {
  const isSel = o.id === selected;
  const col = isSel ? '#7c3aed' : previewCol(o.color, false);
  const { x, y } = o.center, { rx, ry } = o;
  const parts: React.ReactNode[] = drawFill(o, `ovalg-${idPrefix}-${o.id}`);
  if (o.fill === 'hatched')
    parts.push(<g key="h">{ovalHatch(o).map(([p, q], i) => <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke={col} strokeWidth={Math.max(0.4, o.thickness * 0.45)} />)}</g>);
  const kind = o.kind ?? 'plain';
  if (o.outline && (kind === 'photon' || kind === 'gluon')) {
    parts.push(<path key="o" d={decoPath(ovalCurve(o), kind, o.amplitude ?? 5)} fill="none" stroke={col} strokeWidth={o.thickness} />);
  } else {
    // Without an outline it still shows faintly here, so it can be found and picked; it prints none.
    parts.push(<ellipse key="o" cx={x} cy={y} rx={rx} ry={ry} fill="none"
      stroke={o.outline ? col : (isSel ? '#7c3aed' : '#cbd5e1')} strokeWidth={o.outline ? o.thickness : 1}
      strokeDasharray={!o.outline ? '3 5' : kind === 'scalar' ? '8 5' : undefined} />);
  }
  if (o.outline && o.arrow) {
    const size = 4 + o.thickness * 2;
    parts.push(<polygon key="a1" points={arrowPts({ x, y: y - ry }, { x: o.arrow, y: 0 }, size, false)} fill={col} />);
    parts.push(<polygon key="a2" points={arrowPts({ x, y: y + ry }, { x: -o.arrow, y: 0 }, size, false)} fill={col} />);
  }
  return <g key={o.id}>{parts}</g>;
}

function drawVertex(v: Vertex, selected: number | null) {
  const col = previewCol(v.color, v.id === selected);
  const shape = v.shape ?? 'dot';
  if (shape === 'cross') {
    const a = v.size * CROSS;
    return <g key={v.id}>
      <line x1={v.at.x - a} y1={v.at.y - a} x2={v.at.x + a} y2={v.at.y + a} stroke={col} strokeWidth={1.6} />
      <line x1={v.at.x - a} y1={v.at.y + a} x2={v.at.x + a} y2={v.at.y - a} stroke={col} strokeWidth={1.6} />
    </g>;
  }
  if (shape === 'open') return <circle key={v.id} cx={v.at.x} cy={v.at.y} r={v.size} fill="#fff" stroke={col} strokeWidth={1.3} />;
  if (shape === 'hidden') return <circle key={v.id} cx={v.at.x} cy={v.at.y} r={Math.max(3, v.size)} fill="none" stroke={v.id === selected ? '#7c3aed' : '#cbd5e1'} strokeDasharray="2 2" />;
  return <circle key={v.id} cx={v.at.x} cy={v.at.y} r={v.size} fill={col} />;
}

// An element moved by (dx, dy), a split piece together with the line it was cut from.
function shiftEl(e: El, dx: number, dy: number): El {
  const sh = (q: Pt) => ({ x: q.x + dx, y: q.y + dy });
  if (e.type === 'edge') return { ...e, from: sh(e.from), to: sh(e.to), ...(e.sub ? { sub: { ...e.sub, from: sh(e.sub.from), to: sh(e.sub.to) } } : {}) };
  if (e.type === 'loop' || e.type === 'oval') return { ...e, center: sh(e.center) };
  return { ...e, at: sh(e.at) };
}

// Ovals first: they sit behind every line, on the canvas as in the document.
const behindFirst = (els: El[]) => [...els.filter(e => e.type === 'oval'), ...els.filter(e => e.type !== 'oval')];

type Example = { name: string; group: string; note?: string; make: () => El[] };

// The bend that makes a circular arc from p to q follow the circle (centre c) the short way round
// (for the examples' quarter circles).
function bendOnCircle(c: Pt, p: Pt, q: Pt): number {
  const r = Math.hypot(p.x - c.x, p.y - c.y);
  const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const nx = -(q.y - p.y) / len, ny = (q.x - p.x) / len;
  let ux = mid.x - c.x, uy = mid.y - c.y;
  const ul = Math.hypot(ux, uy);
  if (ul < 1e-6) { ux = nx; uy = ny; } else { ux /= ul; uy /= ul; }   // a diameter: bulge to the normal side
  const m = { x: c.x + r * ux, y: c.y + r * uy };
  return Math.round(((m.x - mid.x) * nx + (m.y - mid.y) * ny) * 10) / 10;
}

// The bend that makes a circular arc from p to q pass through m.
function bendThrough(p: Pt, q: Pt, m: Pt): number {
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const nx = -(q.y - p.y) / len, ny = (q.x - p.x) / len;
  return Math.round(((m.x - (p.x + q.x) / 2) * nx + (m.y - (p.y + q.y) / 2) * ny) * 10) / 10;
}

const LOOP_TO_EDGE: Record<LoopKind, EdgeKind> = { plain: 'plain', scalar: 'scalar', photon: 'photon', gluon: 'gluon' };

// A circle cut into arcs at the points on it (vertices and line ends), so each piece can be labelled,
// dotted or faded on its own: the shape of a loop-integral graph. With fewer than two points on it, it is
// cut at its left and right.
function splitLoop(l: Loop, els: El[], nextId: () => number): Edge[] {
  const on: Pt[] = [];
  const consider = (p: Pt) => {
    if (Math.abs(Math.hypot(p.x - l.center.x, p.y - l.center.y) - l.radius) > 6) return;
    if (!on.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 4)) on.push(p);
  };
  for (const e of els) {
    if (e.id === l.id) continue;
    if (e.type === 'vertex') consider(e.at);
    else if (e.type === 'edge') { consider(e.from); consider(e.to); }
  }
  if (on.length < 2) on.splice(0, on.length, { x: l.center.x - l.radius, y: l.center.y }, { x: l.center.x + l.radius, y: l.center.y });
  // Put the points exactly on the circle and go round clockwise on screen.
  const angle = (p: Pt) => Math.atan2(p.y - l.center.y, p.x - l.center.x);
  const pts = on.map(p => { const a = angle(p); return { a, p: { x: l.center.x + l.radius * Math.cos(a), y: l.center.y + l.radius * Math.sin(a) } }; })
    .sort((u, v) => u.a - v.a);
  const kind: EdgeKind = l.arrow ? (l.arrow === 1 ? 'fermion' : 'antifermion') : LOOP_TO_EDGE[l.kind];
  const arcs = pts.map((u, i) => {
    const v = pts[(i + 1) % pts.length];
    let span = v.a - u.a;
    if (span <= 0) span += 2 * Math.PI;
    // Through the circle's point halfway round, so a half circle bulges the way the arc actually goes.
    const mid = u.a + span / 2;
    const bend = bendThrough(u.p, v.p, { x: l.center.x + l.radius * Math.cos(mid), y: l.center.y + l.radius * Math.sin(mid) });
    return {
      id: nextId(), type: 'edge', kind, from: u.p, to: v.p, bend, arc: true,
      thickness: l.thickness, amplitude: l.amplitude, endArrow: false, label: '', side: bend >= 0 ? 1 : -1, color: l.color,
      style: l.style,
    } as Edge;
  });
  // The circle's labels go to the arcs at its top and bottom.
  const midY = (e: Edge) => curveOf(e).pt(0.5).y;
  if (l.label.trim() && arcs.length) arcs.reduce((a, b) => midY(b) < midY(a) ? b : a).label = l.label;
  if (l.labelBelow?.trim() && arcs.length) arcs.reduce((a, b) => midY(b) > midY(a) ? b : a).label = l.labelBelow;
  if (l.mom && arcs.length) {
    const top = arcs.reduce((a, b) => midY(b) < midY(a) ? b : a);
    top.mom = l.mom;           // arcs run clockwise, the same sense as mom 1
  }
  return arcs;
}

// Numbers the internal lines 1, 2, 3 … in the order they were drawn, the way loop-integral notes label
// propagators. A line is internal when both ends touch something else; external legs, hidden lines and
// lines with a label of their own (other than a number) are left alone.
function numberLines(els: El[]): El[] {
  const touches = (p: Pt, self: number) => els.some(o => {
    if (o.id === self) return false;
    if (o.type === 'vertex') return Math.hypot(o.at.x - p.x, o.at.y - p.y) < 6;
    if (o.type === 'edge') return Math.hypot(o.from.x - p.x, o.from.y - p.y) < 4 || Math.hypot(o.to.x - p.x, o.to.y - p.y) < 4;
    if (o.type === 'loop') return Math.abs(Math.hypot(p.x - o.center.x, p.y - o.center.y) - o.radius) < 6;
    return false;
  });
  let n = 0;
  return els.map(e => {
    if (e.type !== 'edge' || e.style === 'hidden') return e;
    if (e.label.trim() && !/^\d+$/.test(e.label.trim())) return e;
    if (!touches(e.from, e.id) || !touches(e.to, e.id)) return e;
    return { ...e, label: String(++n) };
  });
}

// Shorthands for the examples below. A diagram is mostly the same four lines
// with different particles on them, and spelling every field out each time
// hides the physics in punctuation.
const fer = (from: Pt, to: Pt, label = '', side: 1 | -1 = 1, bend = 0): El =>
  ({ id: tid++, type: 'edge', kind: 'fermion', from, to, bend, thickness: 1.2, amplitude: 6, endArrow: false, label, side });
const pho = (from: Pt, to: Pt, label = '', side: 1 | -1 = 1, bend = 0): El =>
  ({ id: tid++, type: 'edge', kind: 'photon', from, to, bend, thickness: 1, amplitude: 5, endArrow: false, label, side });
const glu = (from: Pt, to: Pt, label = '', side: 1 | -1 = 1, bend = 0): El =>
  ({ id: tid++, type: 'edge', kind: 'gluon', from, to, bend, thickness: 1, amplitude: 5, endArrow: false, label, side });
const sca = (from: Pt, to: Pt, label = '', side: 1 | -1 = 1, bend = 0): El =>
  ({ id: tid++, type: 'edge', kind: 'scalar', from, to, bend, thickness: 1.1, amplitude: 5, endArrow: false, label, side });
const dot = (at: Pt): El => ({ id: tid++, type: 'vertex', at, size: 3.2 });
const note = (at: Pt, text: string): El => ({ id: tid++, type: 'text', at, text });
const loop = (center: Pt, radius: number, extra: Partial<Loop> = {}): El =>
  ({ id: tid++, type: 'loop', kind: 'plain', fill: 'none', center, radius, thickness: 1.2, amplitude: 5, label: '', ...extra } as Loop);

// The diagrams a course actually draws, in the order a course draws them.
// Each one is laid out by hand: legs at the same angle, vertices on the grid,
// labels on the side the line leaves room for.
const EXAMPLES: Example[] = [
  {
    name: 'e⁻e⁺ → μ⁻μ⁺', group: 'QED', note: 'tree level, s-channel',
    make: () => [
      fer(T(120, 120), T(260, 200), 'e^-', 1),
      fer(T(260, 200), T(120, 280), 'e^+', -1),
      pho(T(260, 200), T(420, 200), 'gamma', 1),
      fer(T(420, 200), T(560, 120), 'mu^-', -1),
      fer(T(560, 280), T(420, 200), 'mu^+', 1),
      dot(T(260, 200)), dot(T(420, 200)),
    ],
  },
  {
    name: 'e⁻μ⁻ → e⁻μ⁻', group: 'QED', note: 'tree level, t-channel',
    make: () => [
      fer(T(140, 120), T(320, 120), 'e^-', -1),
      fer(T(320, 120), T(520, 120), 'e^-', -1),
      fer(T(140, 300), T(320, 300), 'mu^-', 1),
      fer(T(320, 300), T(520, 300), 'mu^-', 1),
      pho(T(320, 120), T(320, 300), 'gamma', 1),
      dot(T(320, 120)), dot(T(320, 300)),
    ],
  },
  {
    name: 'Compton — s-channel', group: 'QED', note: 'eγ → eγ, one of two orderings',
    make: () => [
      fer(T(120, 300), T(260, 220), 'e^-', 1),
      pho(T(120, 140), T(260, 220), 'gamma', -1),
      fer(T(260, 220), T(420, 220), 'p + k', -1),
      fer(T(420, 220), T(560, 300), 'e^-', -1),
      pho(T(420, 220), T(560, 140), 'gamma', 1),
      dot(T(260, 220)), dot(T(420, 220)),
    ],
  },
  {
    name: 'Compton — u-channel', group: 'QED', note: 'the same process, photons the other way round',
    make: () => [
      fer(T(120, 330), T(260, 250), 'e^-', 1),
      fer(T(260, 250), T(420, 250), "p - k'", 1),
      fer(T(420, 250), T(560, 330), 'e^-', -1),
      // The two photons cross: that is what makes it the u-channel. Their
      // labels sit out near the ends so the crossing stays readable.
      pho(T(120, 90), T(420, 250), 'gamma', -1),
      pho(T(260, 250), T(560, 90), 'gamma', 1),
      dot(T(260, 250)), dot(T(420, 250)),
    ],
  },
  {
    name: 'Electron self-energy', group: 'QED', note: 'one loop',
    make: () => [
      fer(T(110, 240), T(250, 240), 'p', 1),
      fer(T(250, 240), T(430, 240), 'p - k', 1),
      fer(T(430, 240), T(570, 240), 'p', 1),
      pho(T(250, 240), T(430, 240), 'k', -1, -70),
      dot(T(250, 240)), dot(T(430, 240)),
    ],
  },
  {
    name: 'Vacuum polarisation', group: 'QED', note: 'photon self-energy, fermion loop',
    make: () => [
      pho(T(110, 220), T(278, 220), 'q', 1),
      loop(T(340, 220), 62, { arrow: 1, label: 'k' }),
      pho(T(402, 220), T(570, 220), 'q', 1),
      dot(T(278, 220)), dot(T(402, 220)),
    ],
  },
  {
    name: 'Vertex correction', group: 'QED', note: 'the loop behind g − 2',
    make: () => [
      fer(T(110, 320), T(260, 250), 'p', 1),
      fer(T(260, 250), T(340, 180), '', 1),
      fer(T(340, 180), T(420, 250), '', 1),
      fer(T(420, 250), T(570, 320), "p'", -1),
      pho(T(340, 180), T(340, 90), 'gamma', 1),
      pho(T(260, 250), T(420, 250), 'k', -1),
      dot(T(260, 250)), dot(T(340, 180)), dot(T(420, 250)),
    ],
  },
  {
    name: 'Muon decay', group: 'Electroweak', note: 'μ⁻ → ν_μ e⁻ ν̄_e through a W',
    make: () => [
      fer(T(110, 150), T(280, 150), 'mu^-', -1),
      fer(T(280, 150), T(450, 90), 'nu_mu', -1),
      pho(T(280, 150), T(360, 270), 'W^-', -1),
      fer(T(360, 270), T(520, 230), 'e^-', -1),
      fer(T(520, 330), T(360, 270), 'macron(nu)_e', 1),
      dot(T(280, 150)), dot(T(360, 270)),
    ],
  },
  {
    name: 'Quark–gluon vertex', group: 'QCD', note: 'q q̄ g',
    make: () => [
      fer(T(130, 120), T(300, 220), 'q', 1),
      fer(T(300, 220), T(130, 320), 'macron(q)', -1),
      glu(T(300, 220), T(540, 220), 'g, a mu', 1),
      dot(T(300, 220)),
    ],
  },
  {
    name: 'φ⁴ contact', group: 'Scalar', note: 'four legs, one vertex',
    make: () => [
      sca(T(150, 120), T(340, 220), 'phi', 1),
      sca(T(150, 320), T(340, 220), 'phi', -1),
      sca(T(340, 220), T(530, 120), 'phi', -1),
      sca(T(340, 220), T(530, 320), 'phi', 1),
      dot(T(340, 220)),
    ],
  },
  {
    name: 'φ⁴ tadpole', group: 'Scalar', note: 'the loop that renormalises the mass',
    make: () => [
      sca(T(140, 300), T(340, 300), 'phi', 1),
      sca(T(340, 300), T(540, 300), 'phi', 1),
      // The loop sits on the vertex, and it is the same scalar as the legs, so
      // it is drawn the same way.
      loop(T(340, 242), 58, { kind: 'scalar' }),
      dot(T(340, 300)),
    ],
  },
  {
    name: 'Effective vertex', group: 'Scalar', note: 'a blob, not a particular graph',
    make: () => [
      fer(T(120, 130), T(280, 220), '', 1),
      fer(T(120, 310), T(280, 220), '', -1),
      loop(T(340, 220), 58, { fill: 'hatched' }),
      fer(T(400, 220), T(560, 130), '', -1),
      fer(T(400, 220), T(560, 310), '', 1),
      note(T(340, 300), 'italic("effective")'),
    ],
  },
];

// The box a diagram actually occupies, so a thumbnail shows the drawing rather
// than the empty canvas around it.
const boundsOf = (els: El[]) => {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const see = (p: Pt, pad = 0) => {
    x1 = Math.min(x1, p.x - pad); y1 = Math.min(y1, p.y - pad);
    x2 = Math.max(x2, p.x + pad); y2 = Math.max(y2, p.y + pad);
  };
  for (const e of els) {
    if (e.type === 'edge') { see(e.from, 14); see(e.to, 14); see(curveOf(e).pt(0.5), 14); if (e.label.trim()) see(edgeLabelPos(e), 12); }
    else if (e.type === 'loop') see(e.center, e.radius + 18 + (e.mom ? 12 : 0));
    else if (e.type === 'oval') { see({ x: e.center.x - e.rx, y: e.center.y - e.ry }, 4); see({ x: e.center.x + e.rx, y: e.center.y + e.ry }, 4); }
    else see(e.at, 16);
  }
  if (!Number.isFinite(x1)) return { x: 0, y: 0, w: W, h: H };
  return { x: x1, y: y1, w: Math.max(40, x2 - x1), h: Math.max(40, y2 - y1) };
};

function ExampleThumb({ els, height = 96 }: { els: El[]; height?: number }) {
  const b = boundsOf(els);
  return (
    <svg viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`} style={{ width: '100%', height, display: 'block' }} aria-hidden>
      {behindFirst(els).map(e => (e.type === 'edge' ? drawEdge(e, null)
        : e.type === 'loop' ? drawLoop(e, null)
        : e.type === 'oval' ? drawOval(e, null, 't')
        : e.type === 'vertex' ? drawVertex(e, null)
        : <text key={e.id} x={e.at.x} y={e.at.y} fontSize="13" fontStyle="italic" fontFamily={LABEL_FONT} textAnchor="middle" dominantBaseline="middle" fill="#111">{prettyLabel(e.text)}</text>))}
    </svg>
  );
}

const exampleGroups = () => {
  const all = [...EXAMPLES, ...ADVANCED, ...IBP, ...HADRON];
  const order = ['QED', 'Electroweak', 'QCD', 'Scalar', 'Advanced QCD', 'Hadron correlators', 'IBP / loop integrals'];
  return order
    .map(group => ({ group, items: all.filter(e => e.group === group) }))
    .filter(g => g.items.length);
};

// Graphs for loop-integral notes (IBP, spanning trees, Symanzik polynomials): plain lines, circular arcs
// cut at the vertices, numbered propagators, dots for raised powers, faded lines for cut ones.
const ln = (from: Pt, to: Pt, extra: Partial<Edge> = {}): Edge =>
  ({ id: tid++, type: 'edge', kind: 'plain', from, to, bend: 0, thickness: 1.2, amplitude: 5, endArrow: false, label: '', side: 1, ...extra });
const arcE = (c: Pt, from: Pt, to: Pt, extra: Partial<Edge> = {}): Edge => {
  const bend = bendOnCircle(c, from, to);
  return ln(from, to, { arc: true, bend, side: bend >= 0 ? 1 : -1, ...extra });
};

// The one-loop bubble with four legs: p1, p2 in on the left, p3, p4 out on the right, loop momentum
// ell on top (with its arrow) and ell - p below.
const bubble = (extraBottom: Partial<Edge> = {}, legs = true): El[] => {
  const L = T(270, 200), R = T(410, 200);
  return [
    ...(legs ? [
      ln(T(160, 110), L, { label: 'p_1', labelAt: 'start' }),
      ln(T(160, 290), L, { label: 'p_2', labelAt: 'start' }),
      ln(R, T(520, 110), { label: 'p_3', labelAt: 'end' }),
      ln(R, T(520, 290), { label: 'p_4', labelAt: 'end' }),
    ] : [ln(T(160, 200), L, { label: 'p', labelAt: 'start' }), ln(R, T(520, 200), { label: 'p', labelAt: 'end' })]),
    ln(L, R, { arc: true, bend: -70, label: 'ell', side: -1, mom: 1 }),
    ln(L, R, { arc: true, bend: 70, label: 'ell - p', side: 1, ...extraBottom }),
  ];
};

// The two-loop graph: a circle with a chord, legs left and right; lines 1, 2 on the left (bottom, top),
// 3, 4 on the right (bottom, top), 5 the chord.
const twoLoop = (cut: number[] = []): El[] => {
  const C = T(340, 200), Lp = T(260, 200), Rp = T(420, 200), Tp = T(340, 120), Bp = T(340, 280);
  const style = (n: number): Partial<Edge> => cut.includes(n) ? { style: 'faded' } : {};
  return [
    ln(T(180, 200), Lp), ln(Rp, T(500, 200)),
    arcE(C, Bp, Lp, { label: '1', ...style(1) }),
    arcE(C, Lp, Tp, { label: '2', ...style(2) }),
    arcE(C, Rp, Bp, { label: '3', ...style(3) }),
    arcE(C, Tp, Rp, { label: '4', ...style(4) }),
    ln(Tp, Bp, { label: '5', side: -1, ...style(5) }),
  ];
};

const IBP: Example[] = [
  { name: 'One-loop bubble', group: 'IBP / loop integrals', note: 'p₁ … p₄, loop momentum ℓ and ℓ − p', make: () => bubble() },
  { name: 'Bubble with a dot', group: 'IBP / loop integrals', note: 'a dot raises that propagator’s power by one', make: () => bubble({ dots: 1 }, false) },
  {
    name: 'One-loop box', group: 'IBP / loop integrals', note: 'four numbered propagators',
    make: () => {
      const a = T(280, 140), b = T(400, 140), c = T(400, 260), d = T(280, 260);
      return [
        ln(T(200, 80), a, { label: 'p_1', labelAt: 'start' }), ln(T(480, 80), b, { label: 'p_2', labelAt: 'start' }),
        ln(c, T(480, 320), { label: 'p_3', labelAt: 'end' }), ln(d, T(200, 320), { label: 'p_4', labelAt: 'end' }),
        ln(a, b, { label: '1', side: -1, mom: 1 }), ln(b, c, { label: '2', side: -1 }),
        ln(c, d, { label: '3', side: -1 }), ln(d, a, { label: '4', side: -1 }),
      ];
    },
  },
  { name: 'Two-loop graph, lines numbered', group: 'IBP / loop integrals', note: 'five propagators', make: () => twoLoop() },
  { name: 'Two-loop graph, lines 1 and 3 cut', group: 'IBP / loop integrals', note: 'a spanning tree: cut lines faded', make: () => twoLoop([1, 3]) },
];

// Hadron correlators as lattice notes draw them: quark lines between a source and a sink, a current
// inserted on one of them, interpolating operators as ovals.
const HC = 'Hadron correlators';
const quark = (from: Pt, to: Pt, extra: Partial<Edge> = {}): Edge =>
  ({ id: tid++, type: 'edge', kind: 'fermion', from, to, bend: 0, thickness: 1.2, amplitude: 5, endArrow: false, label: '', side: 1, ...extra });
const mark = (at: Pt, shape: VertexShape, size = 3.2, color?: string): Vertex => ({ id: tid++, type: 'vertex', at, size, shape, color });
const oval = (center: Pt, rx: number, ry: number, extra: Partial<Oval> = {}): Oval =>
  ({ id: tid++, type: 'oval', center, rx, ry, fill: 'shaded', half: 'whole', outline: true, thickness: 1, ...extra });

// A baryon two-point panel: operator ovals at both ends, three quark lines (u, u, d), and the sign and
// the term's name. `lines` gives each line's left and right heights, so exchanged lines cross.
const baryonPanel = (sign: string, name: string, lines: [number, number][] = [[160, 160], [200, 200], [240, 240]]): El[] => {
  const xl = 181, xr = 499, flav = ['u', 'u', 'd'];
  return [
    oval(T(170, 200), 11, 56), oval(T(510, 200), 11, 56),
    ...lines.map(([yl, yr]) => ln(T(xl, yl), T(xr, yr), { thickness: 1 })),
    ...[160, 200, 240].flatMap((y, i) => [
      note(T(205, y - 11), flav[i]), note(T(475, y - 11), flav[i]),
      note(T(150, y), ['a', 'b', 'c'][i]), note(T(532, y), ["a'", "b'", "c'"][i]),
    ]),
    note(T(118, 200), sign), note(T(340, 300), name),
  ];
};

const HADRON: Example[] = [
  {
    name: 'Proton three-point function', group: HC, note: 'a current on one valence line; part of it coloured',
    make: () => {
      const L = T(160, 210), R = T(520, 210);
      // Lines run sink to source (right to left), the top one cut where the current attaches.
      const [toInsertion, fromInsertion] = splitEdge(quark(R, L, { ellipse: true, bend: 75 }), 0.5, () => tid++);
      return [
        toInsertion, { ...fromInsertion, color: '#c0504d' },
        quark(R, L), quark(R, L, { ellipse: true, bend: -75 }),
        { id: tid++, type: 'edge', kind: 'photon', from: T(340, 135), to: T(340, 88), bend: 0, thickness: 1, amplitude: 4, endArrow: false, label: '', side: 1 },
        mark(T(340, 135), 'cross', 3), mark(L, 'dot', 3.5), mark(R, 'dot', 3.5),
        note(T(404, 96), 'J(arrow(x)_1, t_1)'),
        note(T(122, 258), "chi_(H')(arrow(x), t)"), note(T(562, 258), 'macron(chi)_H (arrow(0), 0)'),
      ];
    },
  },
  {
    name: 'Fixed-sink sequential source', group: HC, note: 'half the hadron shaded; the current carries q',
    make: () => {
      const L = T(170, 210), R = T(510, 210), blue = '#1f3fd1';
      return [
        oval(T(340, 210), 170, 70, { fill: 'gradient', half: 'right', outline: false, color: '#b0702f' }),
        quark(L, R, { ellipse: true, bend: -70, color: blue, thickness: 1.6 }),
        quark(L, R, { color: blue, thickness: 1.6 }),
        quark(L, R, { ellipse: true, bend: 70, color: blue, thickness: 1.6 }),
        { id: tid++, type: 'edge', kind: 'photon', from: T(340, 140), to: T(340, 66), bend: 0, thickness: 1.2, amplitude: 5, endArrow: false, label: 'arrow(q)', side: 1, color: '#dc2626' },
        mark(T(340, 140), 'cross', 4),
        note(T(138, 214), 'arrow(p)_i'), note(T(544, 214), 'arrow(p)_f'),
      ];
    },
  },
  {
    name: 'Baryon contraction: current on a line', group: HC, note: 'operator ovals, direct pairing',
    make: () => [...baryonPanel('+', '1_u "(Term 1)"'), mark(T(340, 160), 'dot', 3)],
  },
  {
    name: 'Baryon contraction: exchanged', group: HC, note: 'the two u lines swap ends',
    make: () => [...baryonPanel('-', '2_u "(Term 2)"', [[160, 200], [200, 160], [240, 240]]), mark(T(276.4, 172), 'dot', 3)],
  },
  {
    name: 'Baryon contraction: disconnected loop', group: HC, note: 'the current on a closed quark loop',
    make: () => [
      ...baryonPanel('+', 'B_"direct" L_u'),
      loop(T(340, 78), 20),
      mark(T(340, 58), 'dot', 3), note(T(340, 78), 'u'),
      glu(T(326, 92), T(215, 160)), glu(T(354, 92), T(465, 160)),
    ],
  },
];

// The older diagrams, kept: the loops and gauge links a research student needs.
const ADVANCED: Example[] = [
  {
    name: 'three-gluon vertex', group: 'QCD',
    make: () => [
      { id: tid++, type: 'edge', kind: 'gluon', from: T(120, 140), to: T(300, 240), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: 'a, mu', side: 1 },
      { id: tid++, type: 'edge', kind: 'gluon', from: T(120, 340), to: T(300, 240), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: 'b, nu', side: -1 },
      { id: tid++, type: 'edge', kind: 'gluon', from: T(300, 240), to: T(500, 240), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: 'c, rho', side: 1 },
      { id: tid++, type: 'vertex', at: T(300, 240), size: 3.5 },
    ],
  },
  {
    name: 'four-gluon vertex', group: 'QCD',
    make: () => [
      { id: tid++, type: 'edge', kind: 'gluon', from: T(140, 120), to: T(300, 240), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: 'a, mu', side: 1 },
      { id: tid++, type: 'edge', kind: 'gluon', from: T(460, 120), to: T(300, 240), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: 'b, nu', side: -1 },
      { id: tid++, type: 'edge', kind: 'gluon', from: T(140, 360), to: T(300, 240), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: 'c, rho', side: -1 },
      { id: tid++, type: 'edge', kind: 'gluon', from: T(460, 360), to: T(300, 240), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: 'd, sigma', side: 1 },
      { id: tid++, type: 'vertex', at: T(300, 240), size: 3.5 },
    ],
  },
  {
    name: 'quark self-energy (gluon arch)', group: 'QCD',
    make: () => [
      { id: tid++, type: 'edge', kind: 'fermion', from: T(100, 280), to: T(500, 280), bend: 0, thickness: 1.2, amplitude: 6, endArrow: true, label: 'q', side: 1 },
      { id: tid++, type: 'edge', kind: 'gluon', from: T(210, 280), to: T(390, 280), bend: -60, thickness: 1, amplitude: 5, endArrow: false, label: 'g', side: 1 },
      { id: tid++, type: 'vertex', at: T(210, 280), size: 3 },
      { id: tid++, type: 'vertex', at: T(390, 280), size: 3 },
    ],
  },
  {
    name: 'gluon self-energy (quark loop)', group: 'QCD',
    make: () => [
      { id: tid++, type: 'edge', kind: 'gluon', from: T(90, 240), to: T(230, 240), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: 'g', side: 1 },
      { id: tid++, type: 'loop', kind: 'plain', fill: 'none', center: T(290, 240), radius: 60, thickness: 1.2, amplitude: 5, label: 'q', arrow: 1 },
      { id: tid++, type: 'edge', kind: 'gluon', from: T(350, 240), to: T(490, 240), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: 'g', side: 1 },
      { id: tid++, type: 'vertex', at: T(230, 240), size: 3 },
      { id: tid++, type: 'vertex', at: T(350, 240), size: 3 },
    ],
  },
  {
    name: 'gluon self-energy (ghost loop)', group: 'QCD',
    make: () => [
      { id: tid++, type: 'edge', kind: 'gluon', from: T(90, 240), to: T(230, 240), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: 'g', side: 1 },
      { id: tid++, type: 'edge', kind: 'ghost', from: T(230, 240), to: T(350, 240), bend: 60, thickness: 1.1, amplitude: 5, endArrow: false, label: 'c', side: 1 },
      { id: tid++, type: 'edge', kind: 'ghost', from: T(350, 240), to: T(230, 240), bend: 60, thickness: 1.1, amplitude: 5, endArrow: false, label: 'macron(c)', side: 1 },
      { id: tid++, type: 'edge', kind: 'gluon', from: T(350, 240), to: T(490, 240), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: 'g', side: 1 },
      { id: tid++, type: 'vertex', at: T(230, 240), size: 3 },
      { id: tid++, type: 'vertex', at: T(350, 240), size: 3 },
    ],
  },
  {
    name: 'gluon emission off a Wilson line (eikonal)', group: 'Advanced QCD',
    make: () => [
      { id: tid++, type: 'edge', kind: 'wilson', from: T(100, 300), to: T(520, 300), bend: 0, thickness: 1.3, amplitude: 5, endArrow: false, label: 'n dot A', side: 1 },
      { id: tid++, type: 'edge', kind: 'gluon', from: T(280, 300), to: T(400, 180), bend: 0, thickness: 1, amplitude: 5, endArrow: false, label: 'g', side: 1 },
      { id: tid++, type: 'vertex', at: T(280, 300), size: 3 },
    ],
  },
  {
    name: 'Wilson loop (rectangle)', group: 'Advanced QCD',
    make: () => [
      { id: tid++, type: 'edge', kind: 'wilson', from: T(160, 320), to: T(460, 320), bend: 0, thickness: 1.3, amplitude: 5, endArrow: false, label: 'R', side: 1 },
      { id: tid++, type: 'edge', kind: 'wilson', from: T(460, 320), to: T(460, 140), bend: 0, thickness: 1.3, amplitude: 5, endArrow: false, label: 'T', side: 1 },
      { id: tid++, type: 'edge', kind: 'wilson', from: T(460, 140), to: T(160, 140), bend: 0, thickness: 1.3, amplitude: 5, endArrow: false, label: '', side: 1 },
      { id: tid++, type: 'edge', kind: 'wilson', from: T(160, 140), to: T(160, 320), bend: 0, thickness: 1.3, amplitude: 5, endArrow: false, label: '', side: 1 },
    ],
  },
  {
    name: 'gauge-link staple (TMD)', group: 'Advanced QCD',
    make: () => [
      { id: tid++, type: 'edge', kind: 'fermion', from: T(120, 340), to: T(240, 340), bend: 0, thickness: 1.2, amplitude: 6, endArrow: true, label: 'q', side: 1 },
      { id: tid++, type: 'edge', kind: 'wilson', from: T(240, 340), to: T(240, 140), bend: 0, thickness: 1.3, amplitude: 5, endArrow: false, label: '', side: 1 },
      { id: tid++, type: 'edge', kind: 'wilson', from: T(240, 140), to: T(440, 140), bend: 0, thickness: 1.3, amplitude: 5, endArrow: false, label: 'infinity', side: 1 },
      { id: tid++, type: 'edge', kind: 'wilson', from: T(440, 140), to: T(440, 340), bend: 0, thickness: 1.3, amplitude: 5, endArrow: false, label: '', side: 1 },
      { id: tid++, type: 'edge', kind: 'antifermion', from: T(440, 340), to: T(560, 340), bend: 0, thickness: 1.2, amplitude: 6, endArrow: false, label: 'macron(q)', side: 1 },
      { id: tid++, type: 'vertex', at: T(240, 340), size: 3 },
      { id: tid++, type: 'vertex', at: T(440, 340), size: 3 },
    ],
  },
];

// ---- component ---------------------------------------------------------------
export default function FeynmanBuilder({ onClose, onInsert }: { onClose: () => void, onInsert: (code: string, imports?: string) => void }) {
  const [els, setEls] = useState<El[]>([]);
  const [tool, setTool] = useState<'select' | 'edge' | 'loop' | 'oval' | 'vertex' | 'text'>('edge');
  // Waiting for a click on the selected line, to cut it there.
  const [splitting, setSplitting] = useState(false);
  const [edgeKind, setEdgeKind] = useState<EdgeKind>('fermion');
  // The selection: `selected` is the element whose properties the panel shows; `extra` holds the others when
  // several are selected (shift/⌘-click, a box dragged on empty canvas, ⌘A).
  const [selected, setSelectedOne] = useState<number | null>(null);
  const [extra, setExtra] = useState<number[]>([]);
  const setSelected = (id: number | null) => { setSelectedOne(id); setExtra([]); };
  const setSelection = (ids: number[]) => { setSelectedOne(ids[0] ?? null); setExtra(ids.slice(1)); };
  const selIds = selected != null ? [selected, ...extra] : [];
  const selSet = new Set(selIds);
  const multi = extra.length > 0;
  const selKey = selIds.join(',');
  const [box, setBox] = useState<{ a: Pt, b: Pt } | null>(null);
  const [draft, setDraft] = useState<{ a: Pt, b: Pt } | null>(null);
  const [asFigure, setAsFigure] = useState(true);
  const [caption, setCaption] = useState('Feynman diagram');
  const [figLabel, setFigLabel] = useState('');
  const [showCode, setShowCode] = useState(false);

  const svgRef = useRef<SVGSVGElement>(null);
  const idRef = useRef(1);
  const historyRef = useRef(createHistory<El[]>());
  const draftRef = useRef<{ a: Pt, b: Pt } | null>(null);
  const elsRef = useRef(els);
  elsRef.current = els;
  const dragRef = useRef<null | { mode: 'draw' | 'move' | 'from' | 'to' | 'bend' | 'radius' | 'rx' | 'ry' | 'box', start: Pt, snapshot: El[], ids?: Set<number>, additive?: boolean }>(null);

  const commit = (next: El[], key?: string) => {
    historyRef.current.record(elsRef.current, key);
    elsRef.current = next;
    setEls(next);
  };
  const checkpoint = (previous: El[]) => historyRef.current.record(previous);
  const undo = () => {
    const previous = historyRef.current.undo(elsRef.current);
    if (!previous) return;
    elsRef.current = previous;
    setEls(previous); setSelected(null);
  };
  const redo = () => {
    const next = historyRef.current.redo(elsRef.current);
    if (!next) return;
    elsRef.current = next;
    setEls(next); setSelected(null);
  };

  // One element selected: its own panel and handles. Several: the shared panel, no handles.
  const sel = multi ? null : els.find(e => e.id === selected) ?? null;

  // Anchor points other elements can snap to (vertices, edge ends, loop compass points)
  const anchors = (): Pt[] => {
    const a: Pt[] = [];
    for (const e of els) {
      if (e.type === 'vertex') a.push(e.at);
      else if (e.type === 'edge') a.push(e.from, e.to);
      else if (e.type === 'loop') a.push(
        { x: e.center.x + e.radius, y: e.center.y }, { x: e.center.x - e.radius, y: e.center.y },
        { x: e.center.x, y: e.center.y + e.radius }, { x: e.center.x, y: e.center.y - e.radius });
      else if (e.type === 'oval') a.push(
        { x: e.center.x + e.rx, y: e.center.y }, { x: e.center.x - e.rx, y: e.center.y },
        { x: e.center.x, y: e.center.y + e.ry }, { x: e.center.x, y: e.center.y - e.ry });
    }
    return a;
  };
  const snap = (p: Pt, useAnchors = true): Pt => {
    if (useAnchors) for (const a of anchors()) if (Math.hypot(a.x - p.x, a.y - p.y) < 12) return { ...a };
    return { x: Math.round(p.x / (GRID / 2)) * (GRID / 2), y: Math.round(p.y / (GRID / 2)) * (GRID / 2) };
  };

  // Where the canvas was on screen when the current press began. A drag is measured against that, so if
  // the dialog moves while the button is down (selecting an element changes the side panel), a click still
  // moves nothing.
  const pressRectRef = useRef<DOMRect | null>(null);
  const mouse = (ev: React.MouseEvent): Pt => {
    const r = (dragRef.current && pressRectRef.current) || svgRef.current!.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (W / r.width), y: (ev.clientY - r.top) * (H / r.height) };
  };

  const hitTest = (p: Pt): number | null => {
    // Lines and the rest first: an oval lies behind them.
    const order = [...els.filter(e => e.type === 'oval'), ...els.filter(e => e.type !== 'oval')];
    for (let i = order.length - 1; i >= 0; i--) {
      const e = order[i];
      if (e.type === 'oval') {
        const rho = Math.hypot((p.x - e.center.x) / e.rx, (p.y - e.center.y) / e.ry);
        if (Math.abs(rho - 1) * Math.min(e.rx, e.ry) < 8 || (e.fill !== 'none' && rho < 1)) return e.id;
      } else if (e.type === 'vertex') { if (Math.hypot(e.at.x - p.x, e.at.y - p.y) < 9) return e.id; }
      else if (e.type === 'text') { if (Math.hypot(e.at.x - p.x, e.at.y - p.y) < 16) return e.id; }
      else if (e.type === 'loop') {
        const d = Math.hypot(e.center.x - p.x, e.center.y - p.y);
        if (Math.abs(d - e.radius) < 9 || (e.fill !== 'none' && d < e.radius)) return e.id;
      } else {
        const cv = curveOf(e);
        for (let t = 0; t <= 24; t++) {
          const q = cv.pt(t / 24);
          if (Math.hypot(q.x - p.x, q.y - p.y) < 8 + e.amplitude) return e.id;
        }
      }
    }
    return null;
  };

  const onDown = (ev: React.PointerEvent) => {
    if (!ev.isPrimary || ev.button !== 0) return;
    ev.preventDefault();
    ev.currentTarget.setPointerCapture(ev.pointerId);
    pressRectRef.current = svgRef.current!.getBoundingClientRect();
    const p = mouse(ev);
    if (splitting) {
      setSplitting(false);
      if (sel?.type === 'edge') {
        // On a vertex or line end that sits on the line, cut exactly there.
        let at = p;
        for (const q of anchors()) if (Math.hypot(q.x - p.x, q.y - p.y) < 12 && nearestOnCurve(sel, q).dist < 4) { at = q; break; }
        const { t, dist } = nearestOnCurve(sel, at);
        if (dist < 14 && t > 0.03 && t < 0.97) {
          const pieces = splitEdge(sel, t, () => idRef.current++);
          commit(els.flatMap(e => e.id === sel.id ? pieces : [e]));
          setSelected(pieces[0].id);
        }
        return;
      }
    }
    if (tool === 'edge' || tool === 'loop' || tool === 'oval') {
      dragRef.current = { mode: 'draw', start: snap(p), snapshot: els };
      draftRef.current = { a: snap(p), b: snap(p) };
      setDraft(draftRef.current);
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
          dragRef.current = { mode, start: p, snapshot: els };
          return;
        }
      }
    }
    const hit = hitTest(p);
    if (ev.shiftKey || ev.metaKey || ev.ctrlKey) {
      // Add to or take out of the selection; on empty canvas, a box that adds what it covers.
      if (hit != null) setSelection(selSet.has(hit) ? selIds.filter(id => id !== hit) : [...selIds, hit]);
      else { dragRef.current = { mode: 'box', start: p, snapshot: els, additive: true }; setBox({ a: p, b: p }); }
      return;
    }
    if (hit == null) {
      setSelected(null);
      dragRef.current = { mode: 'box', start: p, snapshot: els };
      setBox({ a: p, b: p });
      return;
    }
    // Dragging one of several selected elements moves them all.
    if (!(multi && selSet.has(hit))) setSelected(hit);
    dragRef.current = { mode: 'move', start: p, snapshot: els, ids: multi && selSet.has(hit) ? new Set(selIds) : new Set([hit]) };
  };

  // The points that must lie inside a dragged box for an element to be picked by it.
  const keyPoints = (e: El): Pt[] => {
    if (e.type === 'edge') return [e.from, e.to, curveOf(e).pt(0.5)];
    if (e.type === 'loop') return [{ x: e.center.x - e.radius, y: e.center.y - e.radius }, { x: e.center.x + e.radius, y: e.center.y + e.radius }];
    if (e.type === 'oval') return [{ x: e.center.x - e.rx, y: e.center.y - e.ry }, { x: e.center.x + e.rx, y: e.center.y + e.ry }];
    return [e.at];
  };

  const handlePoints = (e: El): ['from' | 'to' | 'bend' | 'radius' | 'rx' | 'ry', Pt][] => {
    if (e.type === 'edge') return [['from', e.from], ['to', e.to], ['bend', curveOf(e).pt(0.5)]];
    if (e.type === 'loop') return [['radius', { x: e.center.x + e.radius, y: e.center.y }]];
    if (e.type === 'oval') return [['rx', { x: e.center.x + e.rx, y: e.center.y }], ['ry', { x: e.center.x, y: e.center.y - e.ry }]];
    return [];
  };

  const onMove = (ev: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const p = mouse(ev);
    if (d.mode === 'box') { setBox({ a: d.start, b: p }); return; }
    if (d.mode === 'draw') {
      const next = { a: d.start, b: snap(p) };
      if (draftRef.current?.b.x !== next.b.x || draftRef.current?.b.y !== next.b.y) {
        draftRef.current = next;
        setDraft(next);
      }
      return;
    }
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    const next = d.snapshot.map(e => {
      if (!(d.ids ?? new Set([selected])).has(e.id)) return e;
      if (d.mode === 'move') return shiftEl(e, dx, dy);
      // Reshaping a piece of a split line makes it a line of its own.
      if (e.type === 'edge' && d.mode === 'from') return { ...detachPiece(e), from: snap(p) };
      if (e.type === 'edge' && d.mode === 'to') return { ...detachPiece(e), to: snap(p) };
      if (e.type === 'oval' && d.mode === 'rx') return { ...e, rx: Math.max(6, Math.round(Math.abs(p.x - e.center.x))) };
      if (e.type === 'oval' && d.mode === 'ry') return { ...e, ry: Math.max(6, Math.round(Math.abs(p.y - e.center.y))) };
      if (e.type === 'edge' && d.mode === 'bend') {
        e = detachPiece(e);
        const len = Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y) || 1;
        const nx = -(e.to.y - e.from.y) / len, ny = (e.to.x - e.from.x) / len;
        const mx = (e.from.x + e.to.x) / 2, my = (e.from.y + e.to.y) / 2;
        return { ...e, bend: Math.round((p.x - mx) * nx + (p.y - my) * ny) };
      }
      if (e.type === 'loop' && d.mode === 'radius')
        return { ...e, radius: Math.max(12, Math.round(Math.hypot(p.x - e.center.x, p.y - e.center.y))) };
      return e;
    });
    elsRef.current = next;
    setEls(next);
  };

  const onUp = (ev: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    onMove(ev);
    dragRef.current = null;
    if (d.mode === 'box') {
      const p = mouse(ev);
      setBox(null);
      const x1 = Math.min(d.start.x, p.x), x2 = Math.max(d.start.x, p.x), y1 = Math.min(d.start.y, p.y), y2 = Math.max(d.start.y, p.y);
      if (x2 - x1 < 4 && y2 - y1 < 4) return;   // a click, not a box
      const inBox = els.filter(e => keyPoints(e).every(q => q.x >= x1 && q.x <= x2 && q.y >= y1 && q.y <= y2)).map(e => e.id);
      setSelection(d.additive ? [...selIds, ...inBox.filter(id => !selSet.has(id))] : inBox);
      return;
    }
    if (d.mode === 'draw' && draftRef.current) {
      const { a, b } = draftRef.current;
      draftRef.current = null;
      setDraft(null);
      if (Math.hypot(b.x - a.x, b.y - a.y) < 10) return; // too small: ignore click-without-drag
      const id = idRef.current++;
      if (tool === 'edge') {
        const th = edgeKind === 'photon' || edgeKind === 'gluon' ? 1 : 1.2;
        const amp = edgeKind === 'gluon' ? 7 : 5;
        checkpoint(d.snapshot);
        setEls([...d.snapshot, { id, type: 'edge', kind: edgeKind, from: a, to: b, bend: 0, thickness: th, amplitude: amp, endArrow: false, label: '', side: 1 }]);
      } else if (tool === 'oval') {
        checkpoint(d.snapshot);
        setEls([...d.snapshot, { id, type: 'oval', center: a, rx: Math.max(10, Math.round(Math.abs(b.x - a.x))), ry: Math.max(10, Math.round(Math.abs(b.y - a.y))), fill: 'shaded', half: 'whole', outline: true, thickness: 1 }]);
      } else {
        checkpoint(d.snapshot);
        setEls([...d.snapshot, { id, type: 'loop', kind: 'plain', fill: 'none', center: a, radius: Math.max(15, Math.round(Math.hypot(b.x - a.x, b.y - a.y))), thickness: 1.2, amplitude: 5, label: '' }]);
      }
      setSelected(id);
    } else {
      const p = mouse(ev);
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > 0.5) checkpoint(d.snapshot);
    }
  };

  const cancelDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    draftRef.current = null;
    setDraft(null);
    setBox(null);
    if (drag && drag.mode !== 'box') { elsRef.current = drag.snapshot; setEls(drag.snapshot); }
  };

  // Change the selected elements (all of them, or only those of the given types when several are selected).
  const update = (patch: Partial<El>, types?: El['type'][]) => {
    const fields = Object.keys(patch);
    const key = fields.length === 1 ? `${selKey}:${fields[0]}` : undefined;
    // Changing the bend or the shape of a piece of a split line makes it a line of its own.
    const reshapes = 'bend' in patch || 'arc' in patch || 'ellipse' in patch;
    commit(els.map(e => selSet.has(e.id) && (!types || types.includes(e.type))
      ? { ...(e.type === 'edge' && reshapes ? detachPiece(e) : e), ...patch } as El : e), key);
  };
  const removeSel = () => { if (selIds.length) { commit(els.filter(e => !selSet.has(e.id))); setSelected(null); } };
  // A copy of the selection, a little down and to the right, selected in its place.
  const duplicateSel = () => {
    if (!selIds.length) return;
    const copies = els.filter(e => selSet.has(e.id)).map(e => ({ ...shiftEl(e, 20, 20), id: idRef.current++ } as El));
    commit([...els, ...copies]);
    setSelection(copies.map(e => e.id));
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (ev.key === 'Escape' && splitting) { ev.preventDefault(); ev.stopPropagation(); setSplitting(false); return; }
      if (ev.key === 'Escape' && selIds.length) { ev.preventDefault(); ev.stopPropagation(); setSelected(null); return; }
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && selIds.length) { ev.preventDefault(); removeSel(); }
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'a' && els.length) { ev.preventDefault(); ev.stopPropagation(); setTool('select'); setSelection(els.map(e => e.id)); }
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'd' && selIds.length) { ev.preventDefault(); ev.stopPropagation(); duplicateSel(); }
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.shiftKey) redo(); else undo();
      }
    };
    // In the capture phase: the code editor underneath takes ⌘A and ⌘D for itself further down.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // ---- code generation ----
  const genCode = useCallback(() => {
    const lines: string[] = [];
    for (const e of els) if (e.type === 'oval') lines.push(...ovalCode(e));
    for (const e of els) if (e.type === 'loop') lines.push(...loopCode(e));
    for (const e of els) if (e.type === 'edge') lines.push(...edgeCode(e));
    for (const e of els) if (e.type === 'vertex') lines.push(...vertexCode(e));
    for (const e of els) if (e.type === 'text' && e.text.trim())
      lines.push(`  content(${cx(e.at)}, ${mathContent(e.text.trim(), e.color)})`);
    const imports = `#import "@preview/cetz:0.3.4": canvas, draw, decorations\n`;
    const canvas = `canvas({\n  import draw: *\n${lines.join('\n')}\n})`;
    return { imports, canvas };
  }, [els]);

  const handleInsert = () => {
    // The import is handed over separately so it can go to the top of the
    // document once, rather than into the middle of the sentence the cursor
    // happens to be in, again for every diagram after the first.
    const { imports, canvas } = genCode();
    let body;
    if (asFigure) {
      const tag = figLabel.trim() ? ` <fig:${figLabel.trim()}>` : '';
      body = `#figure(\n  ${canvas},\n  caption: [${caption}],\n)${tag}`;
    } else {
      body = `#align(center, ${canvas})`;
    }
    onInsert('\n' + body + '\n\n', imports.trim());
  };

  const renderEdge = useCallback((e: Edge) => drawEdge(e, selSet.has(e.id) ? e.id : null), [selKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  const renderLoop = useCallback((l: Loop) => drawLoop(l, selSet.has(l.id) ? l.id : null), [selKey]);   // eslint-disable-line react-hooks/exhaustive-deps

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

  const [showExamples, setShowExamples] = useState(false);
  const code = useMemo(() => showCode ? genCode() : null, [showCode, genCode]);
  const diagram = useMemo(() => behindFirst(els).map(e =>
    e.type === 'edge' ? renderEdge(e)
    : e.type === 'loop' ? renderLoop(e)
    : e.type === 'oval' ? drawOval(e, selSet.has(e.id) ? e.id : null)
    : e.type === 'vertex' ? drawVertex(e, selSet.has(e.id) ? e.id : null)
    : <text key={e.id} x={e.at.x} y={e.at.y} fontSize="14" fontStyle="italic" fontFamily={LABEL_FONT} textAnchor="middle" dominantBaseline="middle" fill={previewCol(e.color, selSet.has(e.id))}>{prettyLabel(e.text) || '…'}</text>
  ), [els, selKey, renderEdge, renderLoop]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '1180px', maxWidth: '96vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Feynman Diagram (visual)</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        {showExamples && (
          <div style={{ position: 'absolute', inset: 0, background: 'var(--bg-main, #111)', zIndex: 5, display: 'flex', flexDirection: 'column', borderRadius: 8 }}>
            <div className="modal-header">
              <h2>Start from a diagram</h2>
              <button className="close-btn" onClick={() => setShowExamples(false)}>×</button>
            </div>
            <div className="modal-body" style={{ overflowY: 'auto' }}>
              {exampleGroups().map(({ group, items }) => (
                <div key={group} style={{ marginBottom: 20 }}>
                  <div className="dropdown-header" style={{ padding: 0, marginBottom: 8 }}>{group}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>
                    {items.map(example => (
                      <div key={example.name}
                        style={{ border: '1px solid var(--border-color)', borderRadius: 8, overflow: 'hidden', cursor: 'pointer', background: 'var(--panel-lighter, rgba(127,127,127,0.06))' }}>
                        <div style={{ background: '#fff', padding: 6 }}
                          title={els.length ? 'Open this diagram (replaces what is on the canvas)' : 'Open this diagram'}
                          onClick={() => { commit(example.make()); setSelected(null); setShowExamples(false); }}>
                          <ExampleThumb els={example.make()} />
                        </div>
                        <div style={{ padding: '7px 9px 9px' }}>
                          <div style={{ fontSize: '0.86rem', fontWeight: 600 }}>{example.name}</div>
                          {example.note && <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 2 }}>{example.note}</div>}
                          <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: '0.74rem', marginTop: 6 }}
                            title="Add it beside what is already on the canvas"
                            onClick={() => { commit([...els, ...example.make()]); setShowExamples(false); }}>Add to canvas</button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: '12px' }}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
              <div className="seg">
                {([['select', 'Select'], ['edge', 'Line'], ['loop', 'Circle'], ['oval', 'Oval'], ['vertex', 'Vertex'], ['text', 'Label']] as const).map(([t, name]) => (
                  <button key={t} className={tool === t ? 'active' : ''} onClick={() => { setTool(t); setSplitting(false); }}>{name}</button>
                ))}
              </div>
              {tool === 'edge' && (
                <select value={edgeKind} onChange={e => setEdgeKind(e.target.value as EdgeKind)}>
                  {EDGE_KINDS.map(k => <option key={k.k} value={k.k}>{k.name}</option>)}
                </select>
              )}
              <button className="btn-ghost" onClick={() => setShowExamples(true)}>Examples…</button>
              <button className="btn-ghost" onClick={undo} disabled={!historyRef.current.canUndo()} title={keys('Undo (⌘Z)')} aria-label="Undo">↶</button>
              <button className="btn-ghost" onClick={redo} disabled={!historyRef.current.canRedo()} title={keys('Redo (⌘⇧Z)')} aria-label="Redo">↷</button>
              <button className="btn-ghost" disabled={!els.some(e => e.type === 'edge')} onClick={() => commit(numberLines(els))}
                title="Label the internal lines 1, 2, 3 … in the order they were drawn (external legs and named lines are left alone)">Number lines</button>
              <button className="btn-ghost" disabled={!els.length} onClick={() => { commit([]); setSelected(null); }}>Clear</button>
            </div>

            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '6px', cursor: tool === 'select' ? 'default' : 'crosshair', touchAction: 'none', display: 'block' }}
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}>
              {/* Alignment grid: minor lines every GRID px, stronger lines every
                  UNIT px (= 1 cetz unit). Drawing aid only — never exported.
                  Plain lines, not an SVG pattern: a pattern filled with another
                  pattern crashed the whole page in WebKitGTK when it drew
                  without a GPU (a virtual machine, a remote desktop). */}
              <path d={GRID_MINOR} fill="none" stroke="#e7ebf2" strokeWidth="1" />
              <path d={GRID_MAJOR} fill="none" stroke="#cfd8e6" strokeWidth="1" />
              {diagram}
              {draft && tool === 'edge' && <line x1={draft.a.x} y1={draft.a.y} x2={draft.b.x} y2={draft.b.y} stroke="#7c3aed" strokeWidth="1.5" strokeDasharray="4 4" />}
              {draft && tool === 'oval' && <ellipse cx={draft.a.x} cy={draft.a.y} rx={Math.max(2, Math.abs(draft.b.x - draft.a.x))} ry={Math.max(2, Math.abs(draft.b.y - draft.a.y))} fill="none" stroke="#7c3aed" strokeWidth="1.5" strokeDasharray="4 4" />}
              {draft && tool === 'loop' && <circle cx={draft.a.x} cy={draft.a.y} r={Math.max(2, Math.hypot(draft.b.x - draft.a.x, draft.b.y - draft.a.y))} fill="none" stroke="#7c3aed" strokeWidth="1.5" strokeDasharray="4 4" />}
              {box && <rect x={Math.min(box.a.x, box.b.x)} y={Math.min(box.a.y, box.b.y)} width={Math.abs(box.b.x - box.a.x)} height={Math.abs(box.b.y - box.a.y)}
                fill="rgba(124, 58, 237, 0.06)" stroke="#7c3aed" strokeWidth="1" strokeDasharray="4 3" />}
              {sel && tool === 'select' && handlePoints(sel).map(([mode, p], i) => (
                <circle key={i} cx={p.x} cy={p.y} r="6" fill="#fff" stroke="#7c3aed" strokeWidth="2" style={{ cursor: mode === 'bend' ? 'ns-resize' : 'move' }} />
              ))}
            </svg>
            {splitting && <div className="form-hint" style={{ marginTop: '6px', color: '#7c3aed', fontWeight: 600 }}>Click the point on the selected line where it should be cut (Esc cancels).</div>}
            <div className="form-hint" style={{ marginTop: '6px' }}>
              <b>Line / Circle / Oval</b>: click &amp; drag to draw (an oval from its centre). <b>Select</b>: click an element, then drag it or its handles
              (line endpoints snap to nearby vertices; the middle handle bends the line into an arc). Several at once: <b>⇧</b>-click, drag a box on empty canvas, or <b>{keys('⌘A')}</b>; then drag any of them to move them together, <b>{keys('⌘D')}</b> duplicates. <b>⌫</b> deletes, <b>{keys('⌘Z')}</b> undoes.
              The grid (bold lines = 1 unit) is a drawing guide only and is never added to the diagram.
            </div>
          </div>

          {/* Scrolls within its own height, so selecting another kind of element does not resize the dialog. */}
          <div style={{ flex: '0 0 250px', borderLeft: '1px solid #e2e8f0', paddingLeft: '12px', paddingRight: '4px', maxHeight: '62vh', overflowY: 'auto' }}>
            {multi && (() => {
              const chosen = els.filter(e => selSet.has(e.id));
              const strokes = chosen.filter((e): e is Edge | Loop | Oval => e.type === 'edge' || e.type === 'loop' || e.type === 'oval');
              const styled = chosen.filter((e): e is Edge | Loop => e.type === 'edge' || e.type === 'loop');
              return (
                <>
                  <div className="form-hint" style={{ marginBottom: 8 }}><b>{chosen.length} selected.</b> Drag any of them to move them all; changes below apply to each.</div>
                  {colorField(chosen.find(e => e.color)?.color)}
                  {strokes.length > 0 && field(`Thickness — ${num(strokes[0].thickness)}pt`, <input type="range" min="0.4" max="3" step="0.1" value={strokes[0].thickness} onChange={e => update({ thickness: Number(e.target.value) }, ['edge', 'loop', 'oval'])} />)}
                  {styled.length > 0 && field('Style', (
                    <select value={styled[0].style ?? 'normal'} onChange={e => update({ style: e.target.value as LineStyle }, ['edge', 'loop'])}>
                      <option value="normal">Normal</option>
                      <option value="faded">Faded (a cut / removed line)</option>
                      <option value="hidden">Hidden (keeps its place, not drawn)</option>
                    </select>
                  ))}
                  <button className="btn-ghost" style={{ marginTop: '6px', width: '100%' }} onClick={duplicateSel} title={keys('Duplicate (⌘D)')}>Duplicate</button>
                  <button className="btn-ghost" style={{ marginTop: '6px', width: '100%' }} onClick={removeSel}>Delete {chosen.length} elements</button>
                </>
              );
            })()}
            {!sel && !multi && <div className="form-hint">Nothing selected.<br /><br />Draw a line or circle, or add a template — then switch to <b>Select</b> to edit thickness, wiggle amplitude, bend, hatching and labels.</div>}

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
                {field(`Bend — ${sel.bend}`, <input type="range" min="-150" max="150" step="5" value={sel.bend} onChange={e => update({ bend: Number(e.target.value) })} />)}
                {field('Bend shape', (
                  <select value={sel.ellipse ? 'ellipse' : sel.arc ? 'arc' : 'curve'} onChange={e => update({ arc: e.target.value === 'arc', ellipse: e.target.value === 'ellipse' })}>
                    <option value="curve">Curve</option>
                    <option value="arc">Circular arc</option>
                    <option value="ellipse">Half ellipse (leaves the ends square)</option>
                  </select>
                ))}
                <button className="btn-ghost" style={{ width: '100%', marginBottom: '6px' }} disabled={sel.style === 'hidden'}
                  title="Cut this line in two at a point you click, keeping its exact curve, so one part can have another colour, style or label"
                  onClick={() => { setTool('select'); setSplitting(v => !v); }}>{splitting ? 'Cancel splitting' : 'Split line at a point…'}</button>
                {field('Style', (
                  <select value={sel.style ?? 'normal'} onChange={e => update({ style: e.target.value as LineStyle })}>
                    <option value="normal">Normal</option>
                    <option value="faded">Faded (a cut / removed line)</option>
                    <option value="hidden">Hidden (keeps its place, not drawn)</option>
                  </select>
                ))}
                {field(`Dots — ${sel.dots ?? 0}`, <input type="range" min="0" max="4" step="1" value={sel.dots ?? 0} title="Each dot raises this propagator's power by one" onChange={e => update({ dots: Number(e.target.value) })} />)}
                {field('Momentum arrow', (
                  <select value={sel.mom ?? 0} onChange={e => update({ mom: Number(e.target.value) as 0 | 1 | -1 })}>
                    <option value={0}>None</option>
                    <option value={1}>Along the line →</option>
                    <option value={-1}>Against the line ←</option>
                  </select>
                ))}
                {sel.kind !== 'photon' && sel.kind !== 'gluon' && (
                  <label className="form-check">
                    <input type="checkbox" checked={sel.endArrow} onChange={e => update({ endArrow: e.target.checked })} />
                    Arrowhead at the end
                  </label>
                )}
                {field('Label (Typst math)', <input type="text" value={sel.label} onChange={e => update({ label: e.target.value })} placeholder="e.g. gamma, p_1" />)}
                {sel.label.trim() !== '' && field('Label position', (
                  <select value={sel.labelAt ?? 'mid'} onChange={e => update({ labelAt: e.target.value as Edge['labelAt'] })}>
                    <option value="mid">Beside the middle</option>
                    <option value="start">Past the start (an incoming leg)</option>
                    <option value="end">Past the end (an outgoing leg)</option>
                  </select>
                ))}
                {(sel.label.trim() !== '' || sel.mom) && (sel.labelAt ?? 'mid') === 'mid' && (
                  <label className="form-check">
                    <input type="checkbox" checked={sel.side === -1} onChange={e => update({ side: e.target.checked ? -1 : 1 })} />
                    Label and arrow on the other side
                  </label>
                )}
              </>
            )}

            {sel?.type === 'loop' && (
              <>
                {field('Circle type', (
                  <select value={sel.kind} onChange={e => update({ kind: e.target.value as LoopKind })}>
                    <option value="plain">Plain circle</option>
                    <option value="scalar">Dashed (scalar loop)</option>
                    <option value="photon">Wavy (photon loop)</option>
                    <option value="gluon">Coiled (gluon loop)</option>
                  </select>
                ))}
                {(sel.kind === 'plain' || sel.kind === 'scalar') && field('Fill', (
                  <select value={sel.fill} onChange={e => update({ fill: e.target.value as LoopFill })}>
                    <option value="none">None (open loop)</option>
                    <option value="hatched">Hatched (blob)</option>
                    <option value="shaded">Shaded (flat)</option>
                    <option value="gradient">Shading (3-D, from the colour)</option>
                  </select>
                ))}
                {(sel.kind === 'plain' || sel.kind === 'scalar') && sel.fill !== 'none' && field('Fill only', (
                  <select value={sel.half ?? 'whole'} onChange={e => update({ half: e.target.value as Half })}>
                    <option value="whole">The whole circle</option>
                    <option value="left">The left half</option>
                    <option value="right">The right half</option>
                    <option value="top">The top half</option>
                    <option value="bottom">The bottom half</option>
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
                {field('Style', (
                  <select value={sel.style ?? 'normal'} onChange={e => update({ style: e.target.value as LineStyle })}>
                    <option value="normal">Normal</option>
                    <option value="faded">Faded (a cut / removed line)</option>
                    <option value="hidden">Hidden (keeps its place, not drawn)</option>
                  </select>
                ))}
                {field('Momentum arrow', (
                  <select value={sel.mom ?? 0} onChange={e => update({ mom: Number(e.target.value) as 0 | 1 | -1 })}>
                    <option value={0}>None</option>
                    <option value={1}>Clockwise, over the top ↻</option>
                    <option value={-1}>Counter-clockwise, over the top ↺</option>
                  </select>
                ))}
                {field('Label (above, Typst math)', <input type="text" value={sel.label} onChange={e => update({ label: e.target.value })} />)}
                {field('Label (below, Typst math)', <input type="text" value={sel.labelBelow ?? ''} onChange={e => update({ labelBelow: e.target.value })} placeholder="e.g. ell - p" />)}
                <button className="btn-ghost" style={{ marginTop: '6px', width: '100%' }} disabled={sel.fill !== 'none'}
                  title={sel.fill !== 'none' ? 'Only an open circle can be cut into arcs' : 'Cut the circle into arcs at the vertices and line ends on it, so each piece can be numbered, dotted or faded'}
                  onClick={() => {
                    const loopEl = sel;
                    const arcs = splitLoop(loopEl, els, () => idRef.current++);
                    commit(els.flatMap(e => e.id === loopEl.id ? arcs : [e]));
                    setSelected(null);
                  }}>Split into arcs at the vertices</button>
              </>
            )}

            {sel?.type === 'oval' && (
              <>
                {field('Fill', (
                  <select value={sel.fill} onChange={e => update({ fill: e.target.value as OvalFill })}>
                    <option value="none">None</option>
                    <option value="shaded">Shaded (flat)</option>
                    <option value="gradient">Shading (3-D, from the colour)</option>
                    <option value="hatched">Hatched</option>
                  </select>
                ))}
                {sel.fill !== 'none' && field('Fill only', (
                  <select value={sel.half ?? 'whole'} onChange={e => update({ half: e.target.value as Half })}>
                    <option value="whole">The whole oval</option>
                    <option value="left">The left half</option>
                    <option value="right">The right half</option>
                    <option value="top">The top half</option>
                    <option value="bottom">The bottom half</option>
                  </select>
                ))}
                <label className="form-check">
                  <input type="checkbox" checked={sel.outline} onChange={e => update({ outline: e.target.checked })} />
                  Outline
                </label>
                {sel.outline && field('Line type', (
                  <select value={sel.kind ?? 'plain'} onChange={e => update({ kind: e.target.value as LoopKind })}>
                    <option value="plain">Plain</option>
                    <option value="scalar">Dashed (scalar)</option>
                    <option value="photon">Wavy (photon)</option>
                    <option value="gluon">Coiled (gluon)</option>
                  </select>
                ))}
                {sel.outline && (sel.kind === 'photon' || sel.kind === 'gluon') &&
                  field(`Wiggle size — ${num((sel.amplitude ?? 5) / UNIT)}`, <input type="range" min="2" max="14" step="0.5" value={sel.amplitude ?? 5} onChange={e => update({ amplitude: Number(e.target.value) })} />)}
                {sel.outline && field('Fermion flow (arrows)', (
                  <select value={sel.arrow ?? 0} onChange={e => update({ arrow: Number(e.target.value) as 0 | 1 | -1 })}>
                    <option value={0}>None</option>
                    <option value={1}>Clockwise ↻</option>
                    <option value={-1}>Counter-clockwise ↺</option>
                  </select>
                ))}
                {field(`Width — ${num(2 * sel.rx / UNIT)}`, <input type="range" min="6" max="320" step="2" value={sel.rx} onChange={e => update({ rx: Number(e.target.value) })} />)}
                {field(`Height — ${num(2 * sel.ry / UNIT)}`, <input type="range" min="6" max="190" step="2" value={sel.ry} onChange={e => update({ ry: Number(e.target.value) })} />)}
                {sel.outline && field(`Thickness — ${num(sel.thickness)}pt`, <input type="range" min="0.4" max="3" step="0.1" value={sel.thickness} onChange={e => update({ thickness: Number(e.target.value) })} />)}
                {colorField(sel.color)}
              </>
            )}

            {sel?.type === 'vertex' && (
              <>
                {field('Shape', (
                  <select value={sel.shape ?? 'dot'} onChange={e => update({ shape: e.target.value as VertexShape })}>
                    <option value="dot">Dot ●</option>
                    <option value="cross">Cross × (an insertion)</option>
                    <option value="open">Open circle ○</option>
                    <option value="hidden">Hidden (a snap point only)</option>
                  </select>
                ))}
                {field(`Size — ${num(sel.size / UNIT)}`, <input type="range" min="1.5" max="7" step="0.5" value={sel.size} onChange={e => update({ size: Number(e.target.value) })} />)}
                {colorField(sel.color)}
              </>
            )}

            {sel?.type === 'text' && (
              <>
                {field('Text (Typst math)', <input type="text" value={sel.text} onChange={e => update({ text: e.target.value })} autoFocus />)}
                {colorField(sel.color)}
              </>
            )}

            {sel && <div style={{ display: 'flex', gap: 6, marginTop: '10px' }}>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={duplicateSel} title={keys('Duplicate (⌘D)')}>Duplicate</button>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={removeSel}>Delete element</button>
            </div>}

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
            {code.imports + '#' + code.canvas}
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
