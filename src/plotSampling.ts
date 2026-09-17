// The maths behind the graph: where to sample a curve, where to break it, and
// how to cut it at the edges of the view. Kept apart from the drawing so it can
// be checked on its own.

export type View = { xMin: number; xMax: number; yMin: number; yMax: number };
export type Dash = 'solid' | 'dashed' | 'dotted';
export type FillKind = 'none' | 'solid' | 'hatch' | 'cross';
export type Curve = {
  id: number;
  fn: ((x: number) => number) | null;
  colour: string;
  visible: boolean;
  dash?: Dash;
  // Which side of the plot this curve is measured against.
  axis?: 'left' | 'right';
  derivative?: boolean;
  fill?: FillKind;
  fillFrom?: number;
  fillTo?: number;
};

/** f′(x) by central difference, at the scale of the view rather than a fixed
 *  step: a step that suits a plot ten wide is far too coarse for one 0.001 wide. */
export const derivativeOf = (fn: (x: number) => number, view: View) => {
  const h = Math.max(1e-12, (view.xMax - view.xMin) * 1e-4);
  return (x: number) => (fn(x + h) - fn(x - h)) / (2 * h);
};

export type Sample = { x: number; y: number }[];

// A run of finite points. A break starts a new run.
export const sampleCurve = (fn: (x: number) => number, view: View, widthPx: number): Sample[] => {
  const columns = Math.max(80, Math.min(1400, Math.round(widthPx)));
  const step = (view.xMax - view.xMin) / columns;
  // A step of more than two screen heights is worth looking into: either the
  // curve is very steep, or there is a pole between the two points.
  const tall = (view.yMax - view.yMin) * 2;
  const runs: Sample[] = [];
  let run: Sample = [];
  const at = (x: number) => {
    let y: number;
    try { y = fn(x); } catch { return null; }
    return Number.isFinite(y) ? y : null;
  };
  const push = (x: number, y: number) => run.push({ x, y });
  const end = () => { if (run.length > 1) runs.push(run); run = []; };

  let previous: { x: number; y: number } | null = null;
  for (let i = 0; i <= columns; i++) {
    const x = view.xMin + i * step;
    const y = at(x);
    if (y === null) { end(); previous = null; continue; }
    if (previous) {
      const midX = (previous.x + x) / 2;
      const midY = at(midX);
      // Nothing between the two points: whatever is there, the curve does not
      // run from one to the other, so the line stops.
      if (midY === null) {
        end();
        previous = { x, y };
        push(x, y);
        continue;
      }
      const jump = Math.abs(y - previous.y);
      // A steep climb passes between its two ends; a pole runs away from them.
      // A sign change on its own proves nothing: a steep straight line does
      // that too, and breaking it would lose the line altogether.
      if (jump > tall && Math.abs(midY) > Math.max(Math.abs(previous.y), Math.abs(y))) {
        end();
        previous = { x, y };
        push(x, y);
        continue;
      }
      // Where the curve bends within one column, a midpoint keeps it smooth.
      if (Math.abs(midY - (previous.y + y) / 2) > (view.yMax - view.yMin) / 200) push(midX, midY);
    }
    push(x, y);
    previous = { x, y };
  }
  end();
  return runs;
};

/** The parts of a run inside the view, cut at the edges rather than flattened
 *  onto them. Used for the points written into the document. */
export const clipRun = (run: Sample, view: View): Sample[] => {
  const inside = (p: { y: number }) => p.y >= view.yMin && p.y <= view.yMax;
  // Where the segment a→b meets one edge of the band.
  const cross = (a: Sample[number], b: Sample[number], edge: number) => {
    const t = (edge - a.y) / (b.y - a.y);
    return { x: a.x + (b.x - a.x) * t, y: edge };
  };
  const out: Sample[] = [];
  let piece: Sample = [];
  const finish = () => { if (piece.length > 1) out.push(piece); piece = []; };
  for (let i = 0; i < run.length - 1; i++) {
    const a = run[i], b = run[i + 1];
    const aIn = inside(a), bIn = inside(b);
    if (aIn && bIn) {
      if (!piece.length) piece.push(a);
      piece.push(b);
      continue;
    }
    if (aIn && !bIn) {
      if (!piece.length) piece.push(a);
      piece.push(cross(a, b, b.y > view.yMax ? view.yMax : view.yMin));
      finish();
      continue;
    }
    if (!aIn && bIn) {
      finish();
      piece.push(cross(a, b, a.y > view.yMax ? view.yMax : view.yMin), b);
      continue;
    }
    // Both ends outside: the segment still counts if it passes through.
    if ((a.y < view.yMin && b.y > view.yMax) || (a.y > view.yMax && b.y < view.yMin)) {
      finish();
      const first = a.y < view.yMin ? view.yMin : view.yMax;
      piece.push(cross(a, b, first), cross(a, b, first === view.yMin ? view.yMax : view.yMin));
      finish();
    }
  }
  if (run.length === 1 && inside(run[0])) piece.push(run[0]);
  finish();
  return out;
};

/** The y range that shows the visible curves over the current x range. */
export const fitY = (curves: Curve[], view: View, widthPx = 600): View => {
  let lo = Infinity, hi = -Infinity;
  for (const c of curves) {
    if (!c.visible || !c.fn) continue;
    for (const run of sampleCurve(c.fn, { ...view, yMin: -1e9, yMax: 1e9 }, widthPx)) {
      for (const p of run) { if (p.y < lo) lo = p.y; if (p.y > hi) hi = p.y; }
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return view;
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const margin = (hi - lo) * 0.08;
  return { ...view, yMin: lo - margin, yMax: hi + margin };
};
