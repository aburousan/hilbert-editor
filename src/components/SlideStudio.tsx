import React, { useEffect, useRef, useState } from 'react';
import { API } from '../api';

// Everything is measured in Typst page points: presentation-16-9 is
// 841.89pt × 473.56pt, and the canvas/thumbnails just scale that for display.
// The generated code positions elements with pinit's absolute-place, so what
// you drag here lands at the same coordinates on the compiled slide.
const PW = 841.89, PH = 473.56;
const TS = 0.135;    // thumbnail scale
const GRID = 4;      // snap grid, pt

type Pt = { x: number, y: number };
type Align = 'left' | 'center' | 'right';
// `font` is the Typst family name, blank meaning the deck default. Decks saved
// before this existed have no field at all, and keep the default.
type TextEl = { id: number, type: 'text', x: number, y: number, w: number, size: number, color: string, align: Align, text: string, font?: string };
type MathEl = { id: number, type: 'math', x: number, y: number, size: number, color: string, tex: string, font?: string };
type ImgEl = { id: number, type: 'image', x: number, y: number, w: number, path: string };
type TypstEl = { id: number, type: 'typst', x: number, y: number, w: number, code: string };
type HlEl = { id: number, type: 'hl', x: number, y: number, w: number, h: number, color: string };
type ShapeEl = { id: number, type: 'rect' | 'ellipse', x: number, y: number, w: number, h: number, fill: string, stroke: string, sw: number, radius: number };
type ConnEl = { id: number, type: 'conn', kind: 'arrow' | 'double' | 'line', x1: number, y1: number, x2: number, y2: number, color: string, th: number };
type CurveArrow = 'none' | 'start' | 'end' | 'both';
type CurveEl = { id: number, type: 'curve', pts: Pt[], color: string, th: number, closed: boolean, fill: string, arrows?: CurveArrow };
type El = TextEl | MathEl | ImgEl | TypstEl | HlEl | ShapeEl | ConnEl | CurveEl;
type Slide = { id: number, fill: string, els: El[] };
type Tool = 'select' | 'text' | 'math' | 'image' | 'rect' | 'ellipse' | 'hl' | 'arrow' | 'double' | 'line' | 'curve';

// Measured aspect (height/width) of each typst block's rendered preview, so
// hit-testing follows what's actually drawn on the canvas.
const typstAspect = new Map<number, number>();
// Measured size (pt) of each math element's rendered preview — maths has no
// user-set width, it is as wide as the typeset formula.
const mathDim = new Map<number, { w: number, h: number }>();

export type SlideCapture = { insert: (code: string) => void, ensure: (marker: string, rule: string) => void };

let idSeq = 1;
const nid = () => idSeq++;
const snap = (v: number) => Math.round(v / GRID) * GRID;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
// A tenth of a point is well under a screen pixel at slide scale, and trimming
// the tail keeps the generated deck readable where every element is a coordinate.
const pt = (v: number) => `${Math.round(v * 10) / 10}pt`;
const rgb = (c: string) => `rgb("${c}")`;

const packState = (slides: Slide[], imports: string[]) =>
  btoa(unescape(encodeURIComponent(JSON.stringify({ v: 1, slides, imports }))));
const unpackState = (tok: string): { slides: Slide[], imports: string[] } | null => {
  try {
    const d = JSON.parse(decodeURIComponent(escape(atob(tok))));
    if (d && Array.isArray(d.slides) && d.slides.length) return { slides: d.slides, imports: Array.isArray(d.imports) ? d.imports : [] };
  } catch { /* bad or hand-edited token — start fresh */ }
  return null;
};

// Rough box heights for hit-testing and handles. The PDF is the real layout;
// these only need to be close enough to grab things on the canvas.
const textH = (e: TextEl) => Math.max(1, e.text.split('\n').length) * e.size * 1.35;
const mathW = (e: MathEl) => mathDim.get(e.id)?.w ?? Math.max(60, e.tex.length * e.size * 0.52);
const mathH = (e: MathEl) => mathDim.get(e.id)?.h ?? e.size * 1.7;
const imgH = (e: ImgEl) => e.w * 0.68;
const typstH = (e: TypstEl) => Math.max(24, e.w * (typstAspect.get(e.id) ?? 0.4));

const bounds = (e: El): { x: number, y: number, w: number, h: number } => {
  if (e.type === 'conn') return { x: Math.min(e.x1, e.x2), y: Math.min(e.y1, e.y2), w: Math.abs(e.x2 - e.x1), h: Math.abs(e.y2 - e.y1) };
  if (e.type === 'curve') {
    const xs = e.pts.map(p => p.x), ys = e.pts.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  if (e.type === 'text') return { x: e.x, y: e.y, w: e.w, h: textH(e) };
  if (e.type === 'math') return { x: e.x, y: e.y, w: mathW(e), h: mathH(e) };
  if (e.type === 'image') return { x: e.x, y: e.y, w: e.w, h: imgH(e) };
  if (e.type === 'typst') return { x: e.x, y: e.y, w: e.w, h: typstH(e) };
  return { x: e.x, y: e.y, w: e.w, h: e.h };
};

const translateEl = (e: El, dx: number, dy: number): El => {
  if (e.type === 'conn') return { ...e, x1: e.x1 + dx, y1: e.y1 + dy, x2: e.x2 + dx, y2: e.y2 + dy };
  if (e.type === 'curve') return { ...e, pts: e.pts.map(p => ({ x: p.x + dx, y: p.y + dy })) };
  return { ...e, x: e.x + dx, y: e.y + dy };
};

// Catmull-Rom spline through the clicked points, expressed as cubic Bézier
// segments — the same maths drives the SVG preview and the Typst curve() code,
// so what you draw is what compiles. Cached per points-array: rendering,
// hit-testing and codegen all reuse one computation until the points change
// (every edit builds a fresh array, which invalidates the entry naturally).
type CubicSeg = { c1: Pt, c2: Pt, to: Pt };
const cubicsCache = new WeakMap<Pt[], { closed: boolean, segs: CubicSeg[] }>();
const SAMPLES_PER_SEG = 5;

const curveCubics = (pts: Pt[], closed: boolean): CubicSeg[] => {
  const hitc = cubicsCache.get(pts);
  if (hitc && hitc.closed === closed) return hitc.segs;
  const segs = computeCubics(pts, closed);
  cubicsCache.set(pts, { closed, segs });
  return segs;
};

const computeCubics = (pts: Pt[], closed: boolean): CubicSeg[] => {
  const n = pts.length;
  if (n < 2) return [];
  const at = (i: number) => closed ? pts[((i % n) + n) % n] : pts[clamp(i, 0, n - 1)];
  const segs: { c1: Pt, c2: Pt, to: Pt }[] = [];
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    segs.push({
      c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
      c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
      to: p2,
    });
  }
  return segs;
};

const curvePathD = (pts: Pt[], closed: boolean, k: number) => {
  if (pts.length < 2) return '';
  const segs = curveCubics(pts, closed);
  return `M ${pts[0].x * k} ${pts[0].y * k} ` +
    segs.map(s => `C ${s.c1.x * k} ${s.c1.y * k}, ${s.c2.x * k} ${s.c2.y * k}, ${s.to.x * k} ${s.to.y * k}`).join(' ') +
    (closed ? ' Z' : '');
};

// Flatten the spline for hit-testing.
const curveSamples = (pts: Pt[], closed: boolean): Pt[] => {
  const segs = curveCubics(pts, closed);
  if (!segs.length) return pts;
  const out: Pt[] = [pts[0]];
  let from = pts[0];
  for (const s of segs) {
    for (let j = 1; j <= SAMPLES_PER_SEG; j++) {
      const t = j / SAMPLES_PER_SEG, u = 1 - t;
      out.push({
        x: u * u * u * from.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.to.x,
        y: u * u * u * from.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.to.y,
      });
    }
    from = s.to;
  }
  return out;
};

const distToSeg = (p: Pt, a: Pt, b: Pt) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

const blank = (): Slide => ({ id: nid(), fill: '#ffffff', els: [] });

const TEMPLATES: { name: string, make: () => Slide }[] = [
  {
    name: 'Title slide', make: () => ({
      id: nid(), fill: '#ffffff', els: [
        { id: nid(), type: 'text', x: 80, y: 168, w: 680, size: 44, color: '#111827', align: 'center', text: 'Talk title' },
        { id: nid(), type: 'rect', x: 320, y: 244, w: 200, h: 3, fill: '#7c3aed', stroke: '#7c3aed', sw: 0, radius: 1.5 },
        { id: nid(), type: 'text', x: 80, y: 268, w: 680, size: 22, color: '#6b7280', align: 'center', text: 'Author — Institute — Date' },
      ],
    }),
  },
  {
    name: 'Heading + bullets', make: () => ({
      id: nid(), fill: '#ffffff', els: [
        { id: nid(), type: 'text', x: 52, y: 36, w: 740, size: 32, color: '#111827', align: 'left', text: '= Section heading' },
        { id: nid(), type: 'rect', x: 52, y: 88, w: 740, h: 2, fill: '#e5e7eb', stroke: '#e5e7eb', sw: 0, radius: 1 },
        { id: nid(), type: 'text', x: 64, y: 116, w: 716, size: 22, color: '#1f2937', align: 'left', text: '- First point\n- Second point\n- Third point' },
      ],
    }),
  },
  {
    name: 'Two columns', make: () => ({
      id: nid(), fill: '#ffffff', els: [
        { id: nid(), type: 'text', x: 52, y: 36, w: 740, size: 32, color: '#111827', align: 'left', text: '= Comparison' },
        { id: nid(), type: 'text', x: 52, y: 116, w: 356, size: 20, color: '#1f2937', align: 'left', text: '*Left column*\n\n- Point one\n- Point two' },
        { id: nid(), type: 'text', x: 436, y: 116, w: 356, size: 20, color: '#1f2937', align: 'left', text: '*Right column*\n\n- Point one\n- Point two' },
      ],
    }),
  },
  {
    name: 'Section divider (dark)', make: () => ({
      id: nid(), fill: '#1e293b', els: [
        { id: nid(), type: 'text', x: 80, y: 200, w: 680, size: 40, color: '#f8fafc', align: 'center', text: 'Part II — Results' },
      ],
    }),
  },
  {
    name: 'Big equation', make: () => ({
      id: nid(), fill: '#ffffff', els: [
        { id: nid(), type: 'text', x: 52, y: 36, w: 740, size: 32, color: '#111827', align: 'left', text: '= The key result' },
        { id: nid(), type: 'math', x: 260, y: 200, size: 36, color: '#111827', tex: 'integral_0^oo e^(-x^2) dif x = sqrt(pi)/2' },
      ],
    }),
  },
  {
    name: 'Agenda', make: () => ({
      id: nid(), fill: '#f8fafc', els: [
        { id: nid(), type: 'text', x: 56, y: 40, w: 730, size: 34, color: '#0f172a', align: 'left', text: '= Today’s roadmap' },
        { id: nid(), type: 'rect', x: 58, y: 116, w: 222, h: 230, fill: '#ede9fe', stroke: '#c4b5fd', sw: 1.2, radius: 12 },
        { id: nid(), type: 'rect', x: 310, y: 116, w: 222, h: 230, fill: '#dbeafe', stroke: '#93c5fd', sw: 1.2, radius: 12 },
        { id: nid(), type: 'rect', x: 562, y: 116, w: 222, h: 230, fill: '#dcfce7', stroke: '#86efac', sw: 1.2, radius: 12 },
        { id: nid(), type: 'text', x: 78, y: 142, w: 182, size: 22, color: '#6d28d9', align: 'left', text: '*01*\n\nMotivation\n\nWhy this problem matters' },
        { id: nid(), type: 'text', x: 330, y: 142, w: 182, size: 22, color: '#1d4ed8', align: 'left', text: '*02*\n\nMethod\n\nHow we approached it' },
        { id: nid(), type: 'text', x: 582, y: 142, w: 182, size: 22, color: '#047857', align: 'left', text: '*03*\n\nResults\n\nWhat we learned' },
      ],
    }),
  },
  {
    name: 'Image + caption', make: () => ({
      id: nid(), fill: '#ffffff', els: [
        { id: nid(), type: 'text', x: 52, y: 34, w: 740, size: 32, color: '#111827', align: 'left', text: '= Visual evidence' },
        { id: nid(), type: 'rect', x: 52, y: 104, w: 500, h: 280, fill: '#f8fafc', stroke: '#94a3b8', sw: 1.5, radius: 8 },
        { id: nid(), type: 'text', x: 122, y: 224, w: 360, size: 18, color: '#64748b', align: 'center', text: 'Add an image with the Image tool' },
        { id: nid(), type: 'rect', x: 582, y: 104, w: 210, h: 270, fill: '#f1f5f9', stroke: '#cbd5e1', sw: 1, radius: 10 },
        { id: nid(), type: 'text', x: 606, y: 132, w: 162, size: 19, color: '#334155', align: 'left', text: '*What to notice*\n\n- First observation\n- Second observation\n- Main takeaway' },
      ],
    }),
  },
  {
    name: 'Quote / key message', make: () => ({
      id: nid(), fill: '#0f172a', els: [
        { id: nid(), type: 'rect', x: 72, y: 92, w: 7, h: 276, fill: '#38bdf8', stroke: '#38bdf8', sw: 0, radius: 3 },
        { id: nid(), type: 'text', x: 112, y: 112, w: 640, size: 34, color: '#f8fafc', align: 'left', text: '“One clear sentence that your audience should remember.”' },
        { id: nid(), type: 'text', x: 112, y: 324, w: 640, size: 18, color: '#94a3b8', align: 'left', text: '— Speaker or source' },
      ],
    }),
  },
  {
    name: 'Three key results', make: () => ({
      id: nid(), fill: '#ffffff', els: [
        { id: nid(), type: 'text', x: 52, y: 34, w: 740, size: 32, color: '#111827', align: 'left', text: '= Results at a glance' },
        { id: nid(), type: 'rect', x: 52, y: 116, w: 226, h: 244, fill: '#eff6ff', stroke: '#bfdbfe', sw: 1.2, radius: 12 },
        { id: nid(), type: 'rect', x: 308, y: 116, w: 226, h: 244, fill: '#f5f3ff', stroke: '#ddd6fe', sw: 1.2, radius: 12 },
        { id: nid(), type: 'rect', x: 564, y: 116, w: 226, h: 244, fill: '#ecfdf5', stroke: '#a7f3d0', sw: 1.2, radius: 12 },
        { id: nid(), type: 'text', x: 76, y: 142, w: 178, size: 42, color: '#2563eb', align: 'center', text: '*42%*' },
        { id: nid(), type: 'text', x: 76, y: 224, w: 178, size: 18, color: '#334155', align: 'center', text: 'First result\nwith a short explanation' },
        { id: nid(), type: 'text', x: 332, y: 142, w: 178, size: 42, color: '#7c3aed', align: 'center', text: '*3.2×*' },
        { id: nid(), type: 'text', x: 332, y: 224, w: 178, size: 18, color: '#334155', align: 'center', text: 'Second result\nwith useful context' },
        { id: nid(), type: 'text', x: 588, y: 142, w: 178, size: 42, color: '#059669', align: 'center', text: '*98%*' },
        { id: nid(), type: 'text', x: 588, y: 224, w: 178, size: 18, color: '#334155', align: 'center', text: 'Third result\nand the takeaway' },
      ],
    }),
  },
];

const TOOL_LAUNCHERS: [string, string][] = [
  ['equation', 'Equation Gallery'],
  ['physics', 'Physics Gallery'],
  ['matrix', 'Matrix Studio'],
  ['feynman', 'Feynman Diagram'],
  ['cetz', 'cetz Canvas'],
  ['quiver', 'Commutative Diagram'],
  ['plot', 'Plot Studio'],
  ['flowchart', 'Flowchart'],
];

// A numbered equation stretches to full width and re-centers, which drags a
// placed element off its coordinates. deckCode turns numbering off once at the
// top instead of repeating the rules inside every element — the deck already
// sets the page and text size, so it owns the document either way.

const arrowTriangle = (from: Pt, to: Pt, thickness: number): [Pt, Pt, Pt] => {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = Math.max(5, thickness * 4);
  const base = { x: to.x - Math.cos(angle) * size, y: to.y - Math.sin(angle) * size };
  const nx = -Math.sin(angle) * size * 0.5;
  const ny = Math.cos(angle) * size * 0.5;
  return [to, { x: base.x + nx, y: base.y + ny }, { x: base.x - nx, y: base.y - ny }];
};

const curveArrowTriangles = (e: CurveEl): [Pt, Pt, Pt][] => {
  if (e.closed || e.pts.length < 2) return [];
  const arrows = e.arrows ?? 'none';
  const segs = curveCubics(e.pts, false);
  if (!segs.length) return [];
  const triangles: [Pt, Pt, Pt][] = [];
  if (arrows === 'start' || arrows === 'both') triangles.push(arrowTriangle(segs[0].c1, e.pts[0], e.th));
  if (arrows === 'end' || arrows === 'both') {
    const last = segs[segs.length - 1];
    triangles.push(arrowTriangle(last.c2, last.to, e.th));
  }
  return triangles;
};

// A chosen font becomes an extra argument on the element's own text() call, so
// it applies to that element alone and leaves the rest of the deck untouched.
const fontArg = (font?: string) => font?.trim() ? `font: "${font.trim().replace(/"/g, '')}", ` : '';

function elCode(e: El): string {
  if (e.type === 'text') {
    const inner = `text(${fontArg(e.font)}size: ${pt(e.size)}, fill: ${rgb(e.color)})[${e.text}]`;
    const aligned = e.align === 'left' ? inner : `align(${e.align}, ${inner})`;
    return `#absolute-place(dx: ${pt(e.x)}, dy: ${pt(e.y)}, box(width: ${pt(e.w)}, ${aligned}))`;
  }
  if (e.type === 'math') return `#absolute-place(dx: ${pt(e.x)}, dy: ${pt(e.y)}, box(text(${fontArg(e.font)}size: ${pt(e.size)}, fill: ${rgb(e.color)})[$ ${e.tex} $]))`;
  if (e.type === 'image') return `#absolute-place(dx: ${pt(e.x)}, dy: ${pt(e.y)}, image("${e.path}", width: ${pt(e.w)}))`;
  if (e.type === 'typst') return `#absolute-place(dx: ${pt(e.x)}, dy: ${pt(e.y)}, box(width: ${pt(e.w)})[\n${e.code}\n])`;
  // 8-digit hex = translucent marker stroke over whatever sits underneath
  if (e.type === 'hl') return `#absolute-place(dx: ${pt(e.x)}, dy: ${pt(e.y)}, rect(width: ${pt(e.w)}, height: ${pt(e.h)}, fill: rgb("${e.color}73"), radius: 3pt))`;
  if (e.type === 'conn') {
    const dx = e.x2 - e.x1, dy = e.y2 - e.y1;
    if (e.kind === 'line') return `#absolute-place(dx: ${pt(e.x1)}, dy: ${pt(e.y1)}, line(end: (${pt(dx)}, ${pt(dy)}), stroke: ${e.th}pt + ${rgb(e.color)}))`;
    const fn = e.kind === 'double' ? 'double-arrow' : 'simple-arrow';
    return `#absolute-place(dx: ${pt(e.x1)}, dy: ${pt(e.y1)}, ${fn}(start: (0pt, 0pt), end: (${pt(dx)}, ${pt(dy)}), fill: ${rgb(e.color)}, stroke: 0pt, thickness: ${e.th}pt))`;
  }
  if (e.type === 'curve') {
    const segs = curveCubics(e.pts, e.closed);
    const parts = [
      `curve.move((${pt(e.pts[0].x)}, ${pt(e.pts[0].y)}))`,
      ...segs.map(s => `curve.cubic((${pt(s.c1.x)}, ${pt(s.c1.y)}), (${pt(s.c2.x)}, ${pt(s.c2.y)}), (${pt(s.to.x)}, ${pt(s.to.y)}))`),
    ];
    if (e.closed) parts.push('curve.close()');
    const fill = e.closed && e.fill !== 'none' ? `fill: ${rgb(e.fill)}, ` : '';
    // Each piece needs its own absolute-place: inside one block they would lay
    // out in sequence, putting the arrowheads after the curve instead of on it.
    const curve = `#absolute-place(dx: 0pt, dy: 0pt, curve(${fill}stroke: ${e.th}pt + ${rgb(e.color)},\n  ${parts.join(',\n  ')}))`;
    const heads = curveArrowTriangles(e).map(points =>
      `#absolute-place(dx: 0pt, dy: 0pt, polygon(fill: ${rgb(e.color)}, stroke: none, ${points.map(p => `(${pt(p.x)}, ${pt(p.y)})`).join(', ')}))`,
    );
    return [curve, ...heads].join('\n');
  }
  const fill = e.fill === 'none' ? 'none' : rgb(e.fill);
  const stroke = e.sw > 0 ? `${e.sw}pt + ${rgb(e.stroke)}` : 'none';
  return e.type === 'rect'
    ? `#absolute-place(dx: ${pt(e.x)}, dy: ${pt(e.y)}, rect(width: ${pt(e.w)}, height: ${pt(e.h)}, fill: ${fill}, stroke: ${stroke}, radius: ${pt(e.radius)}))`
    : `#absolute-place(dx: ${pt(e.x)}, dy: ${pt(e.y)}, ellipse(width: ${pt(e.w)}, height: ${pt(e.h)}, fill: ${fill}, stroke: ${stroke}))`;
}

function deckCode(slides: Slide[], imports: string[]): string {
  const lines: string[] = [];
  lines.push(`// >>> hilbert-slides ${packState(slides, imports)}`);
  lines.push('// Deck built with Slides → Slide Studio. The token above holds the layout —');
  lines.push('// reopen the studio to move things around instead of editing coordinates by hand.');
  // Only the two arrow helpers are used, so name them rather than dumping every
  // pinit export into the document's scope.
  lines.push('#import "@preview/pinit:0.2.2": absolute-place, simple-arrow, double-arrow');
  for (const imp of imports) if (!imp.includes('@preview/pinit')) lines.push(imp);
  lines.push('#set page(paper: "presentation-16-9", margin: 0pt)');
  lines.push('#set text(size: 20pt)');
  // Once for the whole deck; every placed element would otherwise carry its own
  // copy of these two rules (see UNNUMBER).
  lines.push('#set math.equation(numbering: none)');
  lines.push('#set heading(numbering: none)');
  slides.forEach((s, i) => {
    lines.push('');
    if (i > 0) lines.push('#pagebreak()');
    lines.push(`// ---- slide ${i + 1} of ${slides.length} ----`);
    if (s.fill.toLowerCase() !== '#ffffff') lines.push(`#place(rect(width: 100%, height: 100%, fill: ${rgb(s.fill)}))`);
    for (const e of s.els) lines.push(elCode(e));
  });
  lines.push('// <<< hilbert-slides');
  return lines.join('\n') + '\n';
}

// Arrowhead polygon for the canvas preview, mirroring simple-arrow's shape.
const headPts = (from: Pt, to: Pt, th: number, sc: number) => {
  return arrowTriangle(from, to, th).map(point => `${point.x * sc},${point.y * sc}`).join(' ');
};

export default function SlideStudio({ onClose, onInsert, workspaceImages = [], workspaceFonts = [], existing, registerCapture, onOpenTool }: {
  onClose: () => void,
  onInsert: (code: string) => void,
  workspaceImages?: string[],
  workspaceFonts?: string[],
  existing?: string | null,
  // While the studio is open, App routes the other insert tools' output here
  // so galleries/builders drop their code onto the slide instead of the document.
  registerCapture?: (c: SlideCapture | null) => void,
  onOpenTool?: (key: string) => void,
}) {
  const loaded = existing ? unpackState(existing) : null;
  const [slides, setSlides] = useState<Slide[]>(() => {
    if (loaded) {
      idSeq = Math.max(idSeq, ...loaded.slides.map(s => s.id), ...loaded.slides.flatMap(s => s.els.map(e => e.id))) + 1;
      return loaded.slides;
    }
    return [TEMPLATES[0].make()];
  });
  const [imports, setImports] = useState<string[]>(loaded ? loaded.imports : []);
  const [cur, setCur] = useState(0);
  const [tool, setTool] = useState<Tool>('select');
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ a: Pt, b: Pt } | null>(null);
  const [curvePts, setCurvePts] = useState<Pt[] | null>(null);  // in-progress curve
  const [curveHover, setCurveHover] = useState<Pt | null>(null);  // rubber-band preview while drawing
  const [showCode, setShowCode] = useState(false);
  const [showGrid, setShowGrid] = useState(() => localStorage.getItem('hilbert-slide-grid') !== '0');
  const [snapEnabled, setSnapEnabled] = useState(() => localStorage.getItem('hilbert-slide-snap') !== '0');
  const [sc, setSc] = useState(0.86);
  // WebKit's native CSS `resize` snaps back after a React render, so the
  // studio drags its own corner grip and keeps the size in state. Pointer
  // capture matters here: releasing the button outside the app window would
  // otherwise never deliver the mouseup, leaving the drag armed so the modal
  // "follows the mouse back" — exactly the snap-back people see on macOS.
  const [dim, setDim] = useState(() => {
    let saved: { w?: number, h?: number } | null = null;
    try { saved = JSON.parse(localStorage.getItem('hilbert-slide-studio-size') || 'null'); } catch { /* fresh */ }
    return {
      w: clamp(saved?.w ?? 1200, 900, Math.round(window.innerWidth * 0.97)),
      h: clamp(saved?.h ?? 780, 560, Math.round(window.innerHeight * 0.95)),
    };
  });
  useEffect(() => {
    const t = setTimeout(() => { try { localStorage.setItem('hilbert-slide-studio-size', JSON.stringify(dim)); } catch { /* private mode */ } }, 300);
    return () => clearTimeout(t);
  }, [dim]);
  useEffect(() => {
    try {
      localStorage.setItem('hilbert-slide-grid', showGrid ? '1' : '0');
      localStorage.setItem('hilbert-slide-snap', snapEnabled ? '1' : '0');
    } catch { /* private mode */ }
  }, [showGrid, snapEnabled]);
  const startResize = (ev: React.PointerEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    const grip = ev.currentTarget as HTMLElement;
    const sx = ev.clientX, sy = ev.clientY, sw = dim.w, sh = dim.h;
    const apply = (m: PointerEvent) => setDim({
      w: clamp(sw + m.clientX - sx, 900, Math.round(window.innerWidth * 0.97)),
      h: clamp(sh + m.clientY - sy, 560, Math.round(window.innerHeight * 0.95)),
    });
    const stop = (m: PointerEvent) => {
      try { grip.releasePointerCapture(m.pointerId); } catch { /* already gone */ }
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', stop);
      grip.removeEventListener('pointercancel', stop);
    };
    const move = (m: PointerEvent) => {
      if (m.buttons === 0) { stop(m); return; }  // missed release — disarm
      apply(m);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
    try { grip.setPointerCapture(ev.pointerId); } catch { /* capture unsupported */ }
  };
  const undoRef = useRef<Slide[][]>([]);
  const redoRef = useRef<Slide[][]>([]);
  const clipboardRef = useRef<El | null>(null);
  const draggedSlideRef = useRef<number | null>(null);
  const dragRef = useRef<{ mode: 'move' | 'resize' | 'p1' | 'p2' | 'pt', id: number, grab: Pt, orig: El, idx?: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // Close on a genuine backdrop click only — a drag that merely *ends* over the
  // backdrop synthesizes a click there too, and must not nuke the deck.
  const overlayDown = useRef(false);

  const slide = slides[cur];
  const sel = selected != null ? slide.els.find(e => e.id === selected) ?? null : null;

  // Live refs so the capture callbacks handed to App never go stale.
  const slidesRef = useRef(slides); slidesRef.current = slides;
  const curRef = useRef(cur); curRef.current = cur;

  const snapshot = () => {
    undoRef.current.push(JSON.parse(JSON.stringify(slidesRef.current)));
    if (undoRef.current.length > 60) undoRef.current.shift();
    redoRef.current = [];
  };
  const setEls = (els: El[]) => setSlides(ss => ss.map((s, i) => i === cur ? { ...s, els } : s));
  const updateEl = (id: number, patch: Partial<El>) =>
    setEls(slide.els.map(e => e.id === id ? { ...e, ...patch } as El : e));
  const patchSel = (patch: any) => { if (selected != null) { snapshot(); updateEl(selected, patch); } };
  const snapValue = (value: number) => snapEnabled ? snap(value) : Math.round(value * 10) / 10;

  const restoreHistory = (from: React.MutableRefObject<Slide[][]>, to: React.MutableRefObject<Slide[][]>) => {
    const previous = from.current.pop();
    if (!previous) return;
    to.current.push(JSON.parse(JSON.stringify(slidesRef.current)));
    if (to.current.length > 60) to.current.shift();
    setSlides(previous);
    setSelected(null);
    setEditing(null);
    setCur(index => Math.min(index, previous.length - 1));
  };
  const undo = () => restoreHistory(undoRef, redoRef);
  const redo = () => restoreHistory(redoRef, undoRef);

  const copySelected = () => {
    if (sel) clipboardRef.current = JSON.parse(JSON.stringify(sel));
  };
  const pasteCopied = () => {
    if (!clipboardRef.current) return;
    snapshot();
    let copy: El = JSON.parse(JSON.stringify(clipboardRef.current));
    copy.id = nid();
    const b = bounds(copy);
    const dx = b.x + b.w + 16 <= PW ? 16 : Math.max(-b.x, -16);
    const dy = b.y + b.h + 16 <= PH ? 16 : Math.max(-b.y, -16);
    copy = translateEl(copy, dx, dy);
    setEls([...slide.els, copy]);
    setSelected(copy.id);
    setTool('select');
  };
  const duplicateSelected = () => {
    if (!sel) return;
    clipboardRef.current = JSON.parse(JSON.stringify(sel));
    pasteCopied();
  };

  const positionSelected = (axis: 'x' | 'y', placement: 'start' | 'center' | 'end') => {
    if (!sel) return;
    const b = bounds(sel);
    const extent = axis === 'x' ? PW : PH;
    const size = axis === 'x' ? b.w : b.h;
    const current = axis === 'x' ? b.x : b.y;
    const safe = 32;
    const target = placement === 'start' ? safe : placement === 'end' ? extent - safe - size : (extent - size) / 2;
    snapshot();
    const moved = translateEl(sel, axis === 'x' ? target - current : 0, axis === 'y' ? target - current : 0);
    setEls(slide.els.map(element => element.id === sel.id ? moved : element));
  };

  // Fit the canvas to whatever size the (resizable) modal currently has.
  useEffect(() => {
    const el = fitRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      setSc(clamp(Math.min((r.width - 14) / PW, (r.height - 14) / PH), 0.35, 1.6));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!registerCapture) return;
    const insert = (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) return;
      snapshot();
      const idx = curRef.current;
      const n = slidesRef.current[idx].els.filter(e => e.type === 'typst').length;
      const el: TypstEl = { id: nid(), type: 'typst', x: 120 + (n % 5) * 16, y: 110 + (n % 5) * 16, w: 380, code: trimmed };
      setSlides(ss => ss.map((s, i) => i === idx ? { ...s, els: [...s.els, el] } : s));
      setSelected(el.id);
      setTool('select');
    };
    const ensure = (marker: string, rule: string) => {
      setImports(prev => prev.some(l => l.includes(marker)) ? prev : [...prev, rule.trim()]);
    };
    registerCapture({ insert, ensure });
    return () => registerCapture(null);
  }, [registerCapture]);

  // Render typst blocks server-side (transparent PNG at the block's width) so
  // the canvas shows the actual diagram/equation, not the code behind it.
  const [previews, setPreviews] = useState<Record<number, string>>({});
  const [, bump] = useState(0);  // re-render once a preview reports its real size
  const prevKeys = useRef<Record<number, string>>({});
  const prevUrls = useRef<Record<number, string>>({});
  useEffect(() => {
    const timer = setTimeout(() => {
      const els = slides.flatMap(s => s.els).filter((e): e is TypstEl | MathEl => e.type === 'typst' || e.type === 'math');
      for (const el of els) {
        const key = el.type === 'typst'
          ? `${Math.round(el.w)}|${imports.join(';')}|${el.code}`
          : `${el.size}|${el.color}|${el.font ?? ''}|${imports.join(';')}|${el.tex}`;
        if (prevKeys.current[el.id] === key) continue;
        prevKeys.current[el.id] = key;
        const doc = [
          el.type === 'typst'
            ? `#set page(width: ${pt(el.w)}, height: auto, margin: 0pt, fill: none)`
            : '#set page(width: auto, height: auto, margin: 0pt, fill: none)',
          '#set text(size: 20pt)',
          '#import "@preview/pinit:0.2.2": *',
          ...imports.filter(i => !i.includes('@preview/pinit')),
          '#set math.equation(numbering: none)',
          '#set heading(numbering: none)',
          el.type === 'typst'
            ? el.code
            : `#text(${fontArg(el.font)}size: ${pt(el.size)}, fill: ${rgb(el.color)})[$ ${el.tex} $]`,
        ].join('\n');
        fetch(`${API}/render/snippet`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: doc })
          .then(async r => {
            if (prevKeys.current[el.id] !== key) return;
            if (!r.ok) { setPreviews(p => ({ ...p, [el.id]: 'error' })); return; }
            const url = URL.createObjectURL(await r.blob());
            if (prevUrls.current[el.id]) URL.revokeObjectURL(prevUrls.current[el.id]);
            prevUrls.current[el.id] = url;
            setPreviews(p => ({ ...p, [el.id]: url }));
          })
          .catch(() => {});
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [slides, imports]);
  useEffect(() => () => { Object.values(prevUrls.current).forEach(u => URL.revokeObjectURL(u)); }, []);

  const toPt = (ev: React.MouseEvent): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: clamp((ev.clientX - r.left) / sc, 0, PW), y: clamp((ev.clientY - r.top) / sc, 0, PH) };
  };

  // Finish (or discard) an in-progress curve; called on double-click, Enter,
  // or when the user switches tools mid-draw.
  const finishCurve = (pts?: Pt[] | null) => {
    const raw = pts ?? curvePts;
    setCurvePts(null);
    setCurveHover(null);
    if (!raw) return;
    const clean = raw.filter((q, i) => i === 0 || Math.hypot(q.x - raw[i - 1].x, q.y - raw[i - 1].y) > 2);
    if (clean.length >= 2) addEl({ id: nid(), type: 'curve', pts: clean, color: '#111827', th: 2, closed: false, fill: 'none', arrows: 'none' });
  };

  const chooseTool = (t: Tool) => {
    if (curvePts) finishCurve();
    setTool(t);
  };

  const hit = (p: Pt): El | null => {
    for (let i = slide.els.length - 1; i >= 0; i--) {
      const e = slide.els[i];
      if (e.type === 'conn') {
        if (distToSeg(p, { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }) < 7) return e;
      } else if (e.type === 'curve') {
        const s = curveSamples(e.pts, e.closed);
        for (let j = 0; j < s.length - 1; j++) if (distToSeg(p, s[j], s[j + 1]) < 7) return e;
      } else {
        const b = bounds(e);
        if (p.x >= b.x - 3 && p.x <= b.x + b.w + 3 && p.y >= b.y - 3 && p.y <= b.y + b.h + 3) return e;
      }
    }
    return null;
  };

  const addEl = (el: El, edit = false) => {
    snapshot();
    setEls([...slide.els, el]);
    setSelected(el.id);
    setTool('select');
    if (edit) setEditing(el.id);
  };

  const onDown = (ev: React.MouseEvent) => {
    if (editing != null) return;
    wrapRef.current?.focus();
    const p = toPt(ev);
    if (tool === 'text') return addEl({ id: nid(), type: 'text', x: snapValue(p.x), y: snapValue(p.y), w: 240, size: 22, color: '#111827', align: 'left', text: 'New text' }, true);
    if (tool === 'math') return addEl({ id: nid(), type: 'math', x: snapValue(p.x), y: snapValue(p.y), size: 26, color: '#111827', tex: 'e^(i pi) + 1 = 0' }, true);
    if (tool === 'image') return addEl({ id: nid(), type: 'image', x: snapValue(p.x), y: snapValue(p.y), w: 220, path: workspaceImages[0] || 'images/figure.png' });
    if (tool === 'curve') { setCurvePts(prev => [...(prev || []), { x: snapValue(p.x), y: snapValue(p.y) }]); return; }
    if (tool !== 'select') { setDraft({ a: { x: snapValue(p.x), y: snapValue(p.y) }, b: { x: snapValue(p.x), y: snapValue(p.y) } }); return; }

    if (sel) {  // grab a handle of the current selection first
      if (sel.type === 'conn') {
        if (Math.hypot(p.x - sel.x1, p.y - sel.y1) < 9) { snapshot(); dragRef.current = { mode: 'p1', id: sel.id, grab: p, orig: sel }; return; }
        if (Math.hypot(p.x - sel.x2, p.y - sel.y2) < 9) { snapshot(); dragRef.current = { mode: 'p2', id: sel.id, grab: p, orig: sel }; return; }
      } else if (sel.type === 'curve') {
        const pi = sel.pts.findIndex(q => Math.hypot(p.x - q.x, p.y - q.y) < 9);
        if (pi >= 0) { snapshot(); dragRef.current = { mode: 'pt', id: sel.id, grab: p, orig: sel, idx: pi }; return; }
        if (ev.shiftKey) {
          // shift-click on the curve inserts a control point into the nearest segment
          const s = curveSamples(sel.pts, sel.closed);
          let best = -1, bd = 8;
          for (let j = 0; j < s.length - 1; j++) {
            const d = distToSeg(p, s[j], s[j + 1]);
            if (d < bd) { bd = d; best = j; }
          }
          if (best >= 0) {
            const segIdx = Math.min(sel.pts.length - 2, Math.floor(best / SAMPLES_PER_SEG));
            snapshot();
            const pts = [...sel.pts];
            pts.splice(segIdx + 1, 0, { x: snapValue(p.x), y: snapValue(p.y) });
            updateEl(sel.id, { pts });
            return;
          }
        }
      } else {
        const b = bounds(sel);
        if (Math.hypot(p.x - (b.x + b.w), p.y - (b.y + b.h)) < 9) { snapshot(); dragRef.current = { mode: 'resize', id: sel.id, grab: p, orig: sel }; return; }
      }
    }
    const h = hit(p);
    if (h) {
      setSelected(h.id);
      snapshot();
      dragRef.current = { mode: 'move', id: h.id, grab: p, orig: h };
    } else setSelected(null);
  };

  const onMove = (ev: React.MouseEvent) => {
    const p = toPt(ev);
    if (draft) { setDraft({ a: draft.a, b: { x: snapValue(p.x), y: snapValue(p.y) } }); return; }
    if (tool === 'curve' && curvePts) { setCurveHover({ x: snapValue(p.x), y: snapValue(p.y) }); return; }
    const d = dragRef.current;
    if (!d) return;
    const o = d.orig, dx = p.x - d.grab.x, dy = p.y - d.grab.y;
    if (d.mode === 'move') {
      if (o.type === 'conn') updateEl(d.id, { x1: snapValue(o.x1 + dx), y1: snapValue(o.y1 + dy), x2: snapValue(o.x2 + dx), y2: snapValue(o.y2 + dy) });
      else if (o.type === 'curve') updateEl(d.id, { pts: o.pts.map(q => ({ x: snapValue(q.x + dx), y: snapValue(q.y + dy) })) });
      else updateEl(d.id, { x: snapValue((o as any).x + dx), y: snapValue((o as any).y + dy) });
    } else if (d.mode === 'pt' && o.type === 'curve' && d.idx != null) {
      const pts = [...o.pts];
      pts[d.idx] = { x: snapValue(p.x), y: snapValue(p.y) };
      updateEl(d.id, { pts });
    } else if (d.mode === 'p1' && o.type === 'conn') updateEl(d.id, { x1: snapValue(p.x), y1: snapValue(p.y) });
    else if (d.mode === 'p2' && o.type === 'conn') updateEl(d.id, { x2: snapValue(p.x), y2: snapValue(p.y) });
    else if (d.mode === 'resize') {
      if (o.type === 'rect' || o.type === 'ellipse' || o.type === 'hl') updateEl(d.id, { w: Math.max(12, snapValue(o.w + dx)), h: Math.max(8, snapValue(o.h + dy)) });
      else if (o.type === 'text' || o.type === 'image' || o.type === 'typst') updateEl(d.id, { w: Math.max(40, snapValue(o.w + dx)) });
      else if (o.type === 'math') updateEl(d.id, { size: clamp(Math.round(o.size + dy / 2), 10, 96) });
    }
  };

  const onUp = () => {
    if (draft) {
      const { a, b } = draft;
      setDraft(null);
      if (Math.hypot(b.x - a.x, b.y - a.y) >= 6) {
        if (tool === 'hl') {
          addEl({
            id: nid(), type: 'hl', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
            w: Math.max(16, Math.abs(b.x - a.x)), h: Math.max(10, Math.abs(b.y - a.y)), color: '#fde047',
          });
        } else if (tool === 'rect' || tool === 'ellipse') {
          addEl({
            id: nid(), type: tool, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
            w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y),
            fill: tool === 'rect' ? '#ede9fe' : '#dbeafe', stroke: '#7c3aed', sw: 1.5, radius: tool === 'rect' ? 4 : 0,
          });
        } else if (tool === 'arrow' || tool === 'double' || tool === 'line') {
          addEl({ id: nid(), type: 'conn', kind: tool, x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: '#111827', th: 1.6 });
        }
      }
    }
    dragRef.current = null;
  };

  const onDbl = (ev: React.MouseEvent) => {
    const p = toPt(ev);
    if (curvePts) { finishCurve(); return; }
    // double-click a control point of the selected curve → remove it
    if (sel?.type === 'curve') {
      const pi = sel.pts.findIndex(q => Math.hypot(p.x - q.x, p.y - q.y) < 9);
      if (pi >= 0 && sel.pts.length > 2) {
        snapshot();
        updateEl(sel.id, { pts: sel.pts.filter((_, i) => i !== pi) });
        return;
      }
    }
    const h = hit(p);
    if (h && (h.type === 'text' || h.type === 'math' || h.type === 'typst')) { setSelected(h.id); setEditing(h.id); }
  };

  const removeSel = () => { if (selected != null) { snapshot(); setEls(slide.els.filter(e => e.id !== selected)); setSelected(null); } };

  const onKey = (ev: React.KeyboardEvent) => {
    if (editing != null) { if (ev.key === 'Escape') setEditing(null); return; }
    if (curvePts) {  // drawing a curve: Enter finishes, ⌫ removes the last point, Esc cancels
      if (ev.key === 'Enter') finishCurve();
      else if (ev.key === 'Backspace' || ev.key === 'Delete') setCurvePts(pts => pts && pts.length > 1 ? pts.slice(0, -1) : null);
      else if (ev.key === 'Escape') setCurvePts(null);
      ev.preventDefault();
      return;
    }
    if (ev.key === 'Backspace' || ev.key === 'Delete') { removeSel(); ev.preventDefault(); }
    else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'z') {
      if (ev.shiftKey) redo(); else undo();
      ev.preventDefault(); ev.stopPropagation();
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'y') {
      redo();
      ev.preventDefault(); ev.stopPropagation();
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'c' && sel) {
      copySelected();
      ev.preventDefault(); ev.stopPropagation();
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'v' && clipboardRef.current) {
      pasteCopied();
      ev.preventDefault(); ev.stopPropagation();
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'd') {
      duplicateSelected();
      ev.preventDefault();
    } else if (ev.key.startsWith('Arrow') && sel) {
      const step = ev.shiftKey ? 8 : 2;
      const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
      const dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
      snapshot();
      if (sel.type === 'conn') updateEl(sel.id, { x1: sel.x1 + dx, y1: sel.y1 + dy, x2: sel.x2 + dx, y2: sel.y2 + dy });
      else if (sel.type === 'curve') updateEl(sel.id, { pts: sel.pts.map(q => ({ x: q.x + dx, y: q.y + dy })) });
      else updateEl(sel.id, { x: (sel as any).x + dx, y: (sel as any).y + dy });
      ev.preventDefault();
    } else if (ev.key === 'Escape') {
      if (selected != null) setSelected(null); else onClose();
    } else if (!sel && (ev.key === 'PageUp' || ev.key === 'PageDown')) {
      setCur(index => clamp(index + (ev.key === 'PageUp' ? -1 : 1), 0, slides.length - 1));
      ev.preventDefault();
    }
  };

  const zOrder = (dir: 1 | -1) => {
    if (selected == null) return;
    const i = slide.els.findIndex(e => e.id === selected);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= slide.els.length) return;
    snapshot();
    const els = [...slide.els];
    [els[i], els[j]] = [els[j], els[i]];
    setEls(els);
  };

  // --- slide rail operations ---
  const addSlide = (make?: () => Slide) => {
    snapshot();
    const s = make ? make() : blank();
    setSlides(ss => [...ss.slice(0, cur + 1), s, ...ss.slice(cur + 1)]);
    setCur(cur + 1);
    setSelected(null);
  };
  const dupSlide = () => {
    snapshot();
    const copy: Slide = JSON.parse(JSON.stringify(slide));
    copy.id = nid();
    copy.els.forEach(e => { e.id = nid(); });
    setSlides(ss => [...ss.slice(0, cur + 1), copy, ...ss.slice(cur + 1)]);
    setCur(cur + 1);
  };
  const delSlide = () => {
    if (slides.length <= 1) return;
    snapshot();
    setSlides(ss => ss.filter((_, i) => i !== cur));
    setCur(c => Math.max(0, c - 1));
    setSelected(null);
  };
  const moveSlide = (dir: 1 | -1) => {
    const j = cur + dir;
    if (j < 0 || j >= slides.length) return;
    snapshot();
    setSlides(ss => { const a = [...ss]; [a[cur], a[j]] = [a[j], a[cur]]; return a; });
    setCur(j);
  };
  const reorderSlide = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= slides.length || to >= slides.length) return;
    snapshot();
    const currentId = slide.id;
    const reordered = [...slides];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved);
    setSlides(reordered);
    setCur(Math.max(0, reordered.findIndex(item => item.id === currentId)));
    setSelected(null);
  };
  const slideTitle = (item: Slide, index: number) => {
    const text = item.els.find((element): element is TextEl => element.type === 'text')?.text;
    const title = text?.split('\n').map(line => line.replace(/^[=* _-]+|[*_]$/g, '').trim()).find(Boolean);
    return title || `Slide ${index + 1}`;
  };

  // --- rendering ---
  const renderEl = (e: El, k: number, live: boolean) => {
    const isSel = live && e.id === selected;
    const outline = isSel ? '1.5px solid #7c3aed' : '1.5px solid transparent';
    if (e.type === 'text') {
      return (
        <div key={e.id} style={{
          position: 'absolute', left: e.x * k, top: e.y * k, width: e.w * k,
          fontSize: Math.max(1, e.size * k), color: e.color, textAlign: e.align,
          // A chosen family renders here only if the browser can resolve it; the
          // compiled PDF is what actually applies the Typst font either way.
          fontFamily: e.font ? `"${e.font}", Georgia, serif` : 'Georgia, "Times New Roman", serif', lineHeight: 1.3,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: outline, userSelect: 'none',
          cursor: live ? 'move' : undefined,
        }}>{e.text}</div>
      );
    }
    if (e.type === 'math') {
      const pv = previews[e.id];
      if (pv && pv !== 'error') {
        const dimd = mathDim.get(e.id);
        return (
          <div key={e.id} style={{
            position: 'absolute', left: e.x * k, top: e.y * k,
            border: outline, borderRadius: 2, userSelect: 'none', cursor: live ? 'move' : undefined,
          }}>
            <img src={pv} draggable={false} alt=""
              onLoad={ev => {
                const im = ev.currentTarget;
                // 144 ppi render → 1pt = 2px
                if (im.naturalWidth > 0) { mathDim.set(e.id, { w: im.naturalWidth / 2, h: im.naturalHeight / 2 }); bump(v => v + 1); }
              }}
              style={{ display: 'block', pointerEvents: 'none', width: dimd ? dimd.w * k : undefined, visibility: dimd ? 'visible' : 'hidden' }} />
          </div>
        );
      }
      return (
        <div key={e.id} style={{
          position: 'absolute', left: e.x * k, top: e.y * k,
          fontSize: Math.max(1, e.size * k), color: pv === 'error' ? '#b91c1c' : e.color, fontStyle: 'italic',
          fontFamily: 'Georgia, "Times New Roman", serif', whiteSpace: 'nowrap',
          border: pv === 'error' ? '1.5px dashed #dc2626' : outline, userSelect: 'none', cursor: live ? 'move' : undefined,
        }}>{e.tex}</div>
      );
    }
    if (e.type === 'image') {
      return (
        <div key={e.id} style={{
          position: 'absolute', left: e.x * k, top: e.y * k, width: e.w * k, height: imgH(e) * k,
          border: isSel ? '1.5px solid #7c3aed' : '1.5px dashed #94a3b8', borderRadius: 4,
          background: 'repeating-linear-gradient(45deg, #f8fafc, #f8fafc 8px, #f1f5f9 8px, #f1f5f9 16px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: live ? 11 : 5, color: '#64748b', overflow: 'hidden',
          userSelect: 'none', cursor: live ? 'move' : undefined,
        }}>{live ? (e.path.split('/').pop() || 'image') : ''}</div>
      );
    }
    if (e.type === 'typst') {
      const pv = previews[e.id];
      if (pv && pv !== 'error') {
        return (
          <div key={e.id} style={{
            position: 'absolute', left: e.x * k, top: e.y * k, width: e.w * k,
            border: outline, borderRadius: 2, userSelect: 'none', cursor: live ? 'move' : undefined,
          }}>
            <img src={pv} draggable={false} alt=""
              onLoad={ev => { const im = ev.currentTarget; if (im.naturalWidth > 0) { typstAspect.set(e.id, im.naturalHeight / im.naturalWidth); bump(v => v + 1); } }}
              style={{ width: '100%', display: 'block', pointerEvents: 'none' }} />
          </div>
        );
      }
      return (
        <div key={e.id} style={{
          position: 'absolute', left: e.x * k, top: e.y * k, width: e.w * k, height: typstH(e) * k,
          border: isSel ? '1.5px solid #7c3aed' : `1.5px dashed ${pv === 'error' ? '#dc2626' : '#7c3aed88'}`, borderRadius: 4,
          background: pv === 'error' ? 'rgba(220, 38, 38, 0.05)' : 'rgba(124, 58, 237, 0.05)', overflow: 'hidden',
          padding: live ? 4 : 1, boxSizing: 'border-box',
          fontSize: live ? 10 : 4, color: pv === 'error' ? '#b91c1c' : '#6d28d9', fontFamily: 'ui-monospace, monospace',
          whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          userSelect: 'none', cursor: live ? 'move' : undefined,
        }}>{(pv === 'error' && live ? '⚠ does not compile alone — check the code\n' : '') + e.code.slice(0, live ? 220 : 60)}</div>
      );
    }
    if (e.type === 'hl') {
      return (
        <div key={e.id} style={{
          position: 'absolute', left: e.x * k, top: e.y * k, width: e.w * k, height: e.h * k,
          background: e.color + '73', mixBlendMode: 'multiply', borderRadius: 3 * k,
          outline: isSel ? '1.5px solid #7c3aed' : 'none', outlineOffset: 1,
          userSelect: 'none', cursor: live ? 'move' : undefined,
        }} />
      );
    }
    if (e.type === 'rect' || e.type === 'ellipse') {
      return (
        <div key={e.id} style={{
          position: 'absolute', left: e.x * k, top: e.y * k, width: e.w * k, height: e.h * k,
          background: e.fill === 'none' ? 'transparent' : e.fill,
          border: e.sw > 0 ? `${Math.max(1, e.sw * k)}px solid ${e.stroke}` : (isSel ? '1.5px solid #7c3aed' : 'none'),
          outline: isSel && e.sw > 0 ? '1.5px solid #7c3aed' : 'none', outlineOffset: 2,
          borderRadius: e.type === 'ellipse' ? '50%' : e.radius * k,
          userSelect: 'none', cursor: live ? 'move' : undefined, boxSizing: 'border-box',
        }} />
      );
    }
    if (e.type === 'conn' || e.type === 'curve') return renderConn(e, k, live);
    return null;
  };

  // Connectors and curves need an SVG to draw into, but one shared overlay would
  // always paint them above every box and label — Forward/Backward would reorder
  // the array and change nothing on screen. Each one gets its own transparent,
  // full-slide SVG rendered in element order instead, so stacking just works.
  const renderConn = (e: El, k: number, live: boolean) => (
    <svg key={e.id} width={PW * k} height={PH * k} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
      {connShape(e, k, live)}
    </svg>
  );

  const connShape = (e: El, k: number, live: boolean) => {
    const isSel = live && e.id === selected;
    if (e.type === 'curve') {
      const d = curvePathD(e.pts, e.closed, k);
      return (
        <g>
          {isSel && <path d={d} fill="none" stroke="#7c3aed" strokeOpacity="0.25" strokeWidth={(e.th * k) + 6} />}
          <path d={d} fill={e.closed && e.fill !== 'none' ? e.fill : 'none'} stroke={e.color} strokeWidth={Math.max(0.5, e.th * k)} />
          {curveArrowTriangles(e).map((triangle, index) => (
            <polygon key={index} points={triangle.map(point => `${point.x * k},${point.y * k}`).join(' ')} fill={e.color} />
          ))}
        </g>
      );
    }
    if (e.type !== 'conn') return null;
    const a = { x: e.x1, y: e.y1 }, b = { x: e.x2, y: e.y2 };
    return (
      <g>
        {isSel && <line x1={a.x * k} y1={a.y * k} x2={b.x * k} y2={b.y * k} stroke="#7c3aed" strokeOpacity="0.25" strokeWidth={(e.th * k) + 6} />}
        <line x1={a.x * k} y1={a.y * k} x2={b.x * k} y2={b.y * k} stroke={e.color} strokeWidth={Math.max(0.5, e.th * k)} />
        {e.kind !== 'line' && <polygon points={headPts(a, b, e.th, k)} fill={e.color} />}
        {e.kind === 'double' && <polygon points={headPts(b, a, e.th, k)} fill={e.color} />}
      </g>
    );
  };

  const handleDots = () => {
    if (!sel || tool !== 'select') return null;
    const dot = (x: number, y: number, cursor: string) => (
      <div style={{
        position: 'absolute', left: x * sc - 5, top: y * sc - 5, width: 10, height: 10,
        background: '#fff', border: '2px solid #7c3aed', borderRadius: '50%', cursor, zIndex: 5,
      }} />
    );
    if (sel.type === 'conn') return <>{dot(sel.x1, sel.y1, 'move')}{dot(sel.x2, sel.y2, 'move')}</>;
    if (sel.type === 'curve') return <>{sel.pts.map((q, i) => <React.Fragment key={i}>{dot(q.x, q.y, 'move')}</React.Fragment>)}</>;
    const b = bounds(sel);
    return dot(b.x + b.w, b.y + b.h, 'nwse-resize');
  };

  const editOverlay = () => {
    if (editing == null) return null;
    const e = slide.els.find(x => x.id === editing);
    if (!e || (e.type !== 'text' && e.type !== 'math' && e.type !== 'typst')) return null;
    const value = e.type === 'text' ? e.text : e.type === 'math' ? e.tex : e.code;
    const patch = (v: string) => updateEl(e.id, e.type === 'text' ? { text: v } : e.type === 'math' ? { tex: v } : { code: v });
    const isText = e.type === 'text';
    return (
      <textarea
        autoFocus
        value={value}
        onChange={ev => patch(ev.target.value)}
        onBlur={() => setEditing(null)}
        onKeyDown={ev => { ev.stopPropagation(); if (ev.key === 'Escape') setEditing(null); }}
        onMouseDown={ev => ev.stopPropagation()}
        style={{
          position: 'absolute', left: e.x * sc, top: e.y * sc, zIndex: 6,
          width: isText ? Math.max(160, e.w * sc) : Math.max(300, e.type === 'typst' ? e.w * sc : 300),
          minHeight: e.type === 'typst' ? 110 : 54,
          fontSize: isText ? Math.max(11, e.size * sc) : 13,
          fontFamily: isText ? 'Georgia, serif' : 'ui-monospace, monospace',
          border: '1.5px solid #7c3aed', borderRadius: 4, padding: 4,
          background: '#fff', color: '#111827', resize: 'both',
        }}
      />
    );
  };

  const field = (label: string, node: React.ReactNode) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: '0.72rem', opacity: 0.65, marginBottom: 3 }}>{label}</div>
      {node}
    </div>
  );
  const colorRow = (value: string, onPick: (c: string) => void) => (
    <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
      {['#111827', '#7c3aed', '#2563eb', '#dc2626', '#059669', '#d97706', '#6b7280', '#f8fafc'].map(c => (
        <button key={c} onClick={() => onPick(c)} style={{
          width: 18, height: 18, borderRadius: '50%', background: c, cursor: 'pointer', padding: 0,
          border: value.toLowerCase() === c ? '2px solid #7c3aed' : '2px solid rgba(148,163,184,0.4)',
        }} />
      ))}
      <input type="color" value={value === 'none' ? '#ffffff' : value} onChange={e => onPick(e.target.value)}
        style={{ width: 26, height: 22, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} title="Custom colour" />
    </div>
  );

  // Free text with suggestions rather than a fixed list: Typst matches on the
  // font's internal family name, which the file name only approximates, so the
  // user has to be able to correct it.
  const fontField = (value: string | undefined, onPick: (f: string) => void) => field('Font', (
    <>
      <input list="slide-fonts" value={value ?? ''} onChange={e => onPick(e.target.value)}
        placeholder="Deck default" style={{ width: '100%' }} spellCheck={false} />
      <datalist id="slide-fonts">
        {workspaceFonts.map(f => <option key={f} value={f} />)}
      </datalist>
      <div className="form-hint">Blank uses the deck font. Drop a .ttf/.otf into the project's <code>fonts/</code> folder to use your own.</div>
    </>
  ));

  const inspector = () => {
    if (!sel) {
      return (
        <>
          {field('Slide background', colorRow(slide.fill, c => { snapshot(); setSlides(ss => ss.map((s, i) => i === cur ? { ...s, fill: c } : s)); }))}
          <div className="form-hint">
            Click a tool, then click (or drag) on the slide. Double-click text or maths to edit it.
            <b> Insert from app tools…</b> opens the equation galleries, Feynman builder and friends —
            whatever they insert lands on this slide as a movable block.
            <br /><br />
            <b>Curve</b>: click to drop control points — the dashed preview follows your cursor.
            Double-click, Enter or right-click finishes; ⌫ removes the last point while drawing.
            <br /><br />
            Drag the modal's bottom-right corner to resize the whole studio.
            <br /><br />
            <b>⌫</b> delete · <b>⌘C / ⌘V</b> copy/paste · <b>⌘D</b> duplicate · arrows nudge · <b>⌘Z / ⌘⇧Z</b> undo/redo
          </div>
        </>
      );
    }
    return (
      <>
        {field('Position on slide', (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div className="seg">
              <button onClick={() => positionSelected('x', 'start')} title="Align to the left safe margin">Left</button>
              <button onClick={() => positionSelected('x', 'center')} title="Center horizontally">Center</button>
              <button onClick={() => positionSelected('x', 'end')} title="Align to the right safe margin">Right</button>
            </div>
            <div className="seg">
              <button onClick={() => positionSelected('y', 'start')} title="Align to the top safe margin">Top</button>
              <button onClick={() => positionSelected('y', 'center')} title="Center vertically">Middle</button>
              <button onClick={() => positionSelected('y', 'end')} title="Align to the bottom safe margin">Bottom</button>
            </div>
          </div>
        ))}
        {sel.type === 'text' && (
          <>
            {field(`Font size — ${sel.size}pt`, <input type="range" min="10" max="72" step="1" value={sel.size} onChange={e => patchSel({ size: Number(e.target.value) })} />)}
            {field(`Box width — ${Math.round(sel.w)}pt`, <input type="range" min="60" max="800" step="4" value={sel.w} onChange={e => patchSel({ w: Number(e.target.value) })} />)}
            {field('Align', (
              <div className="seg">
                {(['left', 'center', 'right'] as const).map(a => (
                  <button key={a} className={sel.align === a ? 'active' : ''} onClick={() => patchSel({ align: a })}>{a}</button>
                ))}
              </div>
            ))}
            {field('Colour', colorRow(sel.color, c => patchSel({ color: c })))}
            {fontField(sel.font, f => patchSel({ font: f }))}
            <div className="form-hint">Text is Typst markup: <code>*bold*</code>, <code>_italic_</code>, <code>- bullet</code> lines, <code>= heading</code>.</div>
          </>
        )}
        {sel.type === 'math' && (
          <>
            {field(`Size — ${sel.size}pt`, <input type="range" min="10" max="96" step="1" value={sel.size} onChange={e => patchSel({ size: Number(e.target.value) })} />)}
            {field('Colour', colorRow(sel.color, c => patchSel({ color: c })))}
            {fontField(sel.font, f => patchSel({ font: f }))}
            <div className="form-hint">Typst math, e.g. <code>sum_(n=1)^oo 1/n^2 = pi^2/6</code>. Double-click the element to edit.</div>
          </>
        )}
        {sel.type === 'image' && (
          <>
            {field(`Width — ${Math.round(sel.w)}pt`, <input type="range" min="40" max="800" step="4" value={sel.w} onChange={e => patchSel({ w: Number(e.target.value) })} />)}
            {field('File', (
              <>
                {workspaceImages.length > 0 && (
                  <select value={workspaceImages.includes(sel.path) ? sel.path : ''} onChange={e => { if (e.target.value) patchSel({ path: e.target.value }); }} style={{ width: '100%', marginBottom: 4 }}>
                    <option value="" disabled>Pick from workspace…</option>
                    {workspaceImages.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                )}
                <input type="text" value={sel.path} onChange={e => patchSel({ path: e.target.value })} style={{ width: '100%' }} />
              </>
            ))}
          </>
        )}
        {sel.type === 'typst' && (
          <>
            {field(`Block width — ${Math.round(sel.w)}pt`, <input type="range" min="80" max="800" step="4" value={sel.w} onChange={e => patchSel({ w: Number(e.target.value) })} />)}
            {field('Typst code', (
              <textarea value={sel.code} onChange={e => patchSel({ code: e.target.value })} rows={7}
                style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 11 }} />
            ))}
            <div className="form-hint">Raw Typst content from one of the app's tools (or your own). It compiles inside a box at this position — the dashed outline is only a placeholder.</div>
          </>
        )}
        {sel.type === 'hl' && (
          <>
            {field('Marker colour', (
              <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                {['#fde047', '#86efac', '#93c5fd', '#f9a8d4', '#fdba74', '#c4b5fd'].map(c => (
                  <button key={c} onClick={() => patchSel({ color: c })} style={{
                    width: 18, height: 18, borderRadius: '50%', background: c, cursor: 'pointer', padding: 0,
                    border: sel.color.toLowerCase() === c ? '2px solid #7c3aed' : '2px solid rgba(148,163,184,0.4)',
                  }} />
                ))}
                <input type="color" value={sel.color} onChange={e => patchSel({ color: e.target.value })}
                  style={{ width: 26, height: 22, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} title="Custom colour" />
              </div>
            ))}
            <div className="form-hint">A translucent marker stroke — drag it over text or a formula like a real highlighter. Corner handle resizes it.</div>
          </>
        )}
        {(sel.type === 'rect' || sel.type === 'ellipse') && (
          <>
            {field('Fill', (
              <>
                {colorRow(sel.fill === 'none' ? '#ffffff' : sel.fill, c => patchSel({ fill: c }))}
                <label className="form-check" style={{ marginTop: 4 }}>
                  <input type="checkbox" checked={sel.fill === 'none'} onChange={e => patchSel({ fill: e.target.checked ? 'none' : '#ede9fe' })} />
                  No fill (outline only)
                </label>
              </>
            ))}
            {field(`Border — ${sel.sw}pt`, <input type="range" min="0" max="8" step="0.5" value={sel.sw} onChange={e => patchSel({ sw: Number(e.target.value) })} />)}
            {sel.sw > 0 && field('Border colour', colorRow(sel.stroke, c => patchSel({ stroke: c })))}
            {sel.type === 'rect' && field(`Corner radius — ${sel.radius}pt`, <input type="range" min="0" max="30" step="1" value={sel.radius} onChange={e => patchSel({ radius: Number(e.target.value) })} />)}
          </>
        )}
        {sel.type === 'curve' && (
          <>
            {field(`Thickness — ${sel.th}pt`, <input type="range" min="0.6" max="8" step="0.2" value={sel.th} onChange={e => patchSel({ th: Number(e.target.value) })} />)}
            {field('Colour', colorRow(sel.color, c => patchSel({ color: c })))}
            {!sel.closed && field('Arrowheads', (
              <div className="seg">
                {([['none', 'None'], ['start', 'Start'], ['end', 'End'], ['both', 'Both']] as const).map(([value, label]) => (
                  <button key={value} className={(sel.arrows ?? 'none') === value ? 'active' : ''} onClick={() => patchSel({ arrows: value })}>{label}</button>
                ))}
              </div>
            ))}
            <label className="form-check">
              <input type="checkbox" checked={sel.closed} onChange={e => patchSel({ closed: e.target.checked })} />
              Close the curve
            </label>
            {sel.closed && field('Fill', (
              <>
                {colorRow(sel.fill === 'none' ? '#ffffff' : sel.fill, c => patchSel({ fill: c }))}
                <label className="form-check" style={{ marginTop: 4 }}>
                  <input type="checkbox" checked={sel.fill === 'none'} onChange={e => patchSel({ fill: e.target.checked ? 'none' : '#ede9fe' })} />
                  No fill
                </label>
              </>
            ))}
            <div className="form-hint">
              {sel.pts.length} control points. Drag a point to reshape, <b>double-click a point</b> to
              remove it, <b>shift-click the curve</b> to add one where you clicked.
              {sel.closed && (sel.arrows ?? 'none') !== 'none' && <> Reopen the curve to show its arrowheads.</>}
            </div>
          </>
        )}
        {sel.type === 'conn' && (
          <>
            {field('Style', (
              <div className="seg">
                {([['arrow', '→'], ['double', '↔'], ['line', '—']] as const).map(([k, label]) => (
                  <button key={k} className={sel.kind === k ? 'active' : ''} onClick={() => patchSel({ kind: k })}>{label}</button>
                ))}
              </div>
            ))}
            {field(`Thickness — ${sel.th}pt`, <input type="range" min="0.6" max="6" step="0.2" value={sel.th} onChange={e => patchSel({ th: Number(e.target.value) })} />)}
            {field('Colour', colorRow(sel.color, c => patchSel({ color: c })))}
          </>
        )}
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button className="btn-ghost" onClick={copySelected} title="Copy element (⌘C)">Copy</button>
          <button className="btn-ghost" onClick={duplicateSelected} title="Duplicate element (⌘D)">Duplicate</button>
          <button className="btn-ghost" onClick={pasteCopied} title="Paste copied element (⌘V)">Paste</button>
          <button className="btn-ghost" onClick={() => zOrder(1)} title="Bring forward">Forward</button>
          <button className="btn-ghost" onClick={() => zOrder(-1)} title="Send backward">Backward</button>
          <button className="btn-ghost" onClick={removeSel}>Delete</button>
        </div>
      </>
    );
  };

  const code = showCode ? deckCode(slides, imports) : null;

  return (
    <div className="modal-overlay"
      onMouseDown={e => { overlayDown.current = e.target === e.currentTarget; }}
      onClick={e => { if (overlayDown.current && e.target === e.currentTarget) onClose(); overlayDown.current = false; }}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{
        width: dim.w, height: dim.h, minWidth: 900, minHeight: 560,
        maxWidth: '97vw', maxHeight: '95vh', overflow: 'hidden', position: 'relative',
      }}>
        <div className="modal-header">
          <h2>Slide Studio</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'row', alignItems: 'stretch', gap: 12, flex: 1, minHeight: 0, outline: 'none' }}
          ref={wrapRef} tabIndex={-1} onKeyDown={onKey} onMouseUp={onUp}>

          {/* slide rail */}
          <div style={{ flex: '0 0 132px', display: 'flex', flexDirection: 'column', gap: 6, overflowY: 'auto', paddingRight: 2 }}>
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
              <button className="btn-ghost" title="New slide after this one" onClick={() => addSlide()}>＋</button>
              <button className="btn-ghost" title="Duplicate slide" onClick={dupSlide}>⧉</button>
              <button className="btn-ghost" title="Move up" onClick={() => moveSlide(-1)}>↑</button>
              <button className="btn-ghost" title="Move down" onClick={() => moveSlide(1)}>↓</button>
              <button className="btn-ghost" title="Delete slide" onClick={delSlide} disabled={slides.length <= 1}>✕</button>
            </div>
            {slides.map((s, i) => (
              <div key={s.id} draggable
                onDragStart={event => { draggedSlideRef.current = i; event.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
                onDrop={event => { event.preventDefault(); if (draggedSlideRef.current != null) reorderSlide(draggedSlideRef.current, i); draggedSlideRef.current = null; }}
                onDragEnd={() => { draggedSlideRef.current = null; }}
                onClick={() => { setCur(i); setSelected(null); setEditing(null); }}
                title="Drag to reorder"
                style={{ cursor: 'grab', flex: 'none' }}>
                <div style={{
                  position: 'relative', width: PW * TS, height: PH * TS, background: s.fill,
                  border: i === cur ? '2px solid #7c3aed' : '1px solid #cbd5e1', borderRadius: 3, overflow: 'hidden',
                }}>
                  {s.els.map(e => renderEl(e, TS, false))}
                </div>
                <div style={{ fontSize: '0.68rem', opacity: 0.7, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '1px 3px' }}>
                  {i + 1}. {slideTitle(s, i)}
                </div>
              </div>
            ))}
          </div>

          {/* canvas column */}
          <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8, flex: 'none' }}>
              <div className="seg">
                {([['select', 'Select'], ['text', 'Text'], ['math', 'Math'], ['image', 'Image'], ['rect', 'Box'], ['ellipse', 'Ellipse'], ['hl', 'Highlight'], ['arrow', 'Arrow'], ['double', '↔'], ['line', 'Line'], ['curve', 'Curve']] as const).map(([t, name]) => (
                  <button key={t} className={tool === t ? 'active' : ''} onClick={() => chooseTool(t)}>{name}</button>
                ))}
              </div>
              <select value="" onChange={e => { const t = TEMPLATES.find(x => x.name === e.target.value); if (t) addSlide(t.make); e.target.value = ''; }}>
                <option value="" disabled>Add slide from template…</option>
                {TEMPLATES.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
              {onOpenTool && (
                <select value="" onChange={e => { if (e.target.value) onOpenTool(e.target.value); e.target.value = ''; }}>
                  <option value="" disabled>Insert from app tools…</option>
                  {TOOL_LAUNCHERS.map(([k, name]) => <option key={k} value={k}>{name}</option>)}
                </select>
              )}
              <button className="btn-ghost" onClick={undo} title="Undo (⌘Z)">Undo</button>
              <button className="btn-ghost" onClick={redo} title="Redo (⌘⇧Z)">Redo</button>
              <button className="btn-ghost" onClick={() => setShowGrid(value => !value)} title="Show or hide the alignment grid">{showGrid ? 'Grid on' : 'Grid off'}</button>
              <button className="btn-ghost" onClick={() => setSnapEnabled(value => !value)} title="Snap moved and resized elements to the 4pt grid">{snapEnabled ? 'Snap on' : 'Snap off'}</button>
            </div>

            <div ref={fitRef} style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
              <div
                ref={canvasRef}
                onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onDoubleClick={onDbl}
                onContextMenu={ev => { if (curvePts) { ev.preventDefault(); finishCurve(); } }}
                onMouseLeave={() => setCurveHover(null)}
                style={{
                  position: 'relative', width: PW * sc, height: PH * sc, flex: 'none',
                  background: slide.fill, border: '1px solid #cbd5e1', borderRadius: 4,
                  boxShadow: '0 2px 10px rgba(0,0,0,0.10)', overflow: 'hidden',
                  cursor: tool === 'select' ? 'default' : 'crosshair',
                  backgroundImage: showGrid ? 'radial-gradient(circle, rgba(100,116,139,0.18) 1px, transparent 1px)' : 'none',
                  backgroundSize: `${20 * sc}px ${20 * sc}px`, backgroundColor: slide.fill,
                }}
              >
                {slide.els.map(e => renderEl(e, sc, true))}
                {draft && (tool === 'rect' || tool === 'ellipse' || tool === 'hl') && (
                  <div style={{
                    position: 'absolute', left: Math.min(draft.a.x, draft.b.x) * sc, top: Math.min(draft.a.y, draft.b.y) * sc,
                    width: Math.abs(draft.b.x - draft.a.x) * sc, height: Math.abs(draft.b.y - draft.a.y) * sc,
                    border: tool === 'hl' ? 'none' : '1.5px dashed #7c3aed', borderRadius: tool === 'ellipse' ? '50%' : 3,
                    background: tool === 'hl' ? '#fde04773' : 'transparent', pointerEvents: 'none',
                  }} />
                )}
                {draft && (tool === 'arrow' || tool === 'double' || tool === 'line') && (
                  <svg width={PW * sc} height={PH * sc} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
                    <line x1={draft.a.x * sc} y1={draft.a.y * sc} x2={draft.b.x * sc} y2={draft.b.y * sc} stroke="#7c3aed" strokeWidth="1.5" strokeDasharray="5 4" />
                  </svg>
                )}
                {curvePts && (
                  <svg width={PW * sc} height={PH * sc} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
                    {(() => {
                      // prospective spline through the cursor, so the shape is visible before the click
                      const preview = curveHover ? [...curvePts, curveHover] : curvePts;
                      return preview.length >= 2 && <path d={curvePathD(preview, false, sc)} fill="none" stroke="#7c3aed" strokeWidth="1.5" strokeDasharray="5 4" />;
                    })()}
                    {curvePts.map((q, i) => <circle key={i} cx={q.x * sc} cy={q.y * sc} r="4" fill="#fff" stroke="#7c3aed" strokeWidth="2" />)}
                    {curveHover && <circle cx={curveHover.x * sc} cy={curveHover.y * sc} r="3.5" fill="#7c3aed" fillOpacity="0.5" stroke="none" />}
                  </svg>
                )}
                {handleDots()}
                {editOverlay()}
              </div>
            </div>
            <div className="form-hint" style={{ marginTop: 6, flex: 'none' }}>
              Slide {cur + 1} of {slides.length} · 16:9 ({Math.round(PW)}×{Math.round(PH)}pt) · {snapEnabled ? `grid snap ${GRID}pt` : 'free positioning'} · zoom {Math.round(sc * 100)}%.
              Blocks from the app tools render as compiled previews; plain text and maths show their markup here and typeset in the PDF.
            </div>
          </div>

          {/* inspector */}
          <div style={{ flex: '0 0 236px', borderLeft: '1px solid #e2e8f0', paddingLeft: 12, overflowY: 'auto' }}>
            {inspector()}
            <label className="form-check" style={{ marginTop: 12 }}>
              <input type="checkbox" checked={showCode} onChange={e => setShowCode(e.target.checked)} />
              Show generated Typst code
            </label>
          </div>
        </div>

        {showCode && code && (
          <pre style={{ margin: '0 16px 8px', maxHeight: '150px', overflow: 'auto', fontSize: '11px', background: '#0f172a', color: '#e2e8f0', padding: '8px 10px', borderRadius: '6px', flex: 'none' }}>
            {code}
          </pre>
        )}

        <div className="modal-footer" style={{ flex: 'none' }}>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={() => onInsert(deckCode(slides, imports))}>
            {existing ? 'Update deck in document' : 'Insert deck'}
          </button>
        </div>

        <div onPointerDown={startResize} title="Drag to resize" style={{
          position: 'absolute', right: 0, bottom: 0, width: 18, height: 18,
          cursor: 'nwse-resize', zIndex: 7, touchAction: 'none',
          background: 'linear-gradient(135deg, transparent 0 50%, rgba(148,163,184,0.65) 50% 58%, transparent 58% 68%, rgba(148,163,184,0.65) 68% 76%, transparent 76% 86%, rgba(148,163,184,0.65) 86% 94%, transparent 94%)',
          borderBottomRightRadius: 8,
        }} />
      </div>
    </div>
  );
}
