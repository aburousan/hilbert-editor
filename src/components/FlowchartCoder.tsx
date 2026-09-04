import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { API } from '../api';
import { keys } from '../keys';

// Draw a flowchart (process boxes, decision diamonds, connectors, loop-backs)
// and turn it into real Typst scripting logic: sequences, if/else and while.
// Typst is a full language, so a structured flowchart maps 1:1 onto a `#{ … }`
// code block. Reconstruction targets *structured* flowcharts (the kind people
// draw for algorithms); unstructurable graphs get a clear comment instead.

type NodeType = 'start' | 'input' | 'process' | 'decision' | 'output' | 'end' | 'loop' | 'comment';
type FNode = { id: number, type: NodeType, label: string, x: number, y: number, scale?: number };
type FEdge = { id: number, from: number, to: number, branch?: 'true' | 'false', bend?: number };
type Diagram = { nodes: FNode[], edges: FEdge[], setup: string };

const W = 680, H = 470, GRID = 20;
const SIZE: Record<NodeType, { w: number, h: number }> = {
  start: { w: 108, h: 44 }, end: { w: 108, h: 44 }, input: { w: 150, h: 48 },
  process: { w: 150, h: 48 }, decision: { w: 150, h: 84 }, output: { w: 150, h: 48 },
  loop: { w: 158, h: 54 }, comment: { w: 160, h: 44 },
};
const DEFAULT_LABEL: Record<NodeType, string> = {
  start: 'Start', end: 'End', input: 'let s = 0', process: 's = s + 1', decision: 's < 10', output: 's',
  loop: 'i in range(1, n + 1)', comment: 'note',
};
const NODE_FILL: Record<NodeType, string> = {
  start: '#dcfce7', end: '#fee2e2', input: '#cffafe', process: '#e0e7ff',
  decision: '#fef9c3', output: '#ffedd5', loop: '#ddd6fe', comment: '#f1f5f9',
};
const BEND_LIMIT = 260;   // clamp curve control so extreme drags can't break rendering

// ---- code generation --------------------------------------------------------
function generate(nodes: FNode[], edges: FEdge[], setup: string, resultStyle = true): string {
  // Setup runs first inside the block: `let` declarations and function
  // definitions. This is where every variable "starts from".
  const setupLines = (setup || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => '  ' + l);
  const start = nodes.find(n => n.type === 'start');
  if (!start) return setupLines.length ? `#{\n${setupLines.join('\n')}\n}` : '// Add a Start node to begin.';
  const byId = new Map(nodes.map(n => [n.id, n]));
  const out = (id: number) => edges.filter(e => e.from === id);
  const succ = (id: number): number | null => { const e = out(id)[0]; return e ? e.to : null; };
  const branch = (id: number, b: 'true' | 'false'): number | null => {
    const es = out(id);
    const found = es.find(e => e.branch === b);
    if (found) return found.to;
    // fall back to positional order if branches weren't labelled
    return b === 'true' ? (es[0]?.to ?? null) : (es[1]?.to ?? null);
  };
  // Can we reach `target` from `a` without passing through any node in `blocked`?
  const reaches = (a: number | null, target: number, blocked: Set<number>): boolean => {
    if (a == null) return false;
    const seen = new Set<number>();
    const stack = [a];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === target) return true;
      if (seen.has(n) || blocked.has(n)) continue;
      seen.add(n);
      for (const e of out(n)) stack.push(e.to);
    }
    return false;
  };
  // Nearest node reachable from both a and b (the branch merge point). BFS so
  // "first common" is the closest reconvergence, and `boundary` (the enclosing
  // stop, e.g. a loop header) is never expanded past — otherwise a loop's
  // back-edge makes every node reachable from every other and the merge is bogus.
  const merge = (a: number | null, b: number | null, boundary: Set<number>): number | null => {
    if (a == null || b == null) return null;
    const reachSet = (s: number) => {
      const seen = new Set<number>(); const queue = [s]; const order: number[] = [];
      while (queue.length) {
        const n = queue.shift()!;
        if (seen.has(n)) continue;
        seen.add(n); order.push(n);
        if (boundary.has(n)) continue;         // reach it, but don't cross it
        for (const e of out(n)) queue.push(e.to);
      }
      return { seen, order };
    };
    const ra = reachSet(a), rb = reachSet(b);
    for (const n of ra.order) if (rb.seen.has(n)) return n; // nearest common (BFS order)
    return null;
  };

  const guard = { steps: 0 };
  const emit = (cur: number | null, stop: number | null, depth: number): string[] => {
    const lines: string[] = [];
    const pad = '  '.repeat(depth);
    while (cur != null && cur !== stop) {
      if (guard.steps++ > 400) { lines.push(`${pad}// … flowchart too complex / has an unstructured loop`); break; }
      const node = byId.get(cur);
      if (!node || node.type === 'end') break;
      if (node.type === 'start') { cur = succ(cur); continue; }
      if (node.type === 'process' || node.type === 'input') {
        // A statement / `let` declaration, emitted verbatim as a line.
        lines.push(`${pad}${(node.label || '// (empty step)').trim()}`);
        cur = succ(cur);
        continue;
      }
      if (node.type === 'output') {
        // The block returns this value. When `resultStyle` is on, wrap it in a
        // labelled box so the produced value clearly reads as the *output*.
        const v = (node.label || 'none').trim() || 'none';
        lines.push(resultStyle ? `${pad}[#fc-result(${v})]` : `${pad}${v}`);
        cur = succ(cur);
        continue;
      }
      if (node.type === 'comment') { lines.push(`${pad}// ${(node.label || '').trim()}`); cur = succ(cur); continue; }
      if (node.type === 'loop') {
        // `for` loop: one outgoing edge is the body (it loops back here); the
        // other is where the flow continues once the loop ends.
        const blocked = new Set(stop == null ? [] : [stop]);
        const es = out(cur);
        let bodyStart: number | null = null, exitTo: number | null = null;
        for (const e of es) {
          if (bodyStart == null && reaches(e.to, cur, blocked)) bodyStart = e.to;
          else exitTo = e.to;
        }
        if (bodyStart == null) { bodyStart = es[0]?.to ?? null; exitTo = es[1]?.to ?? null; }
        lines.push(`${pad}for ${(node.label || 'i in range(n)').trim()} {`);
        lines.push(...emit(bodyStart, cur, depth + 1));
        lines.push(`${pad}}`);
        cur = exitTo;
        continue;
      }
      // decision
      const t = branch(cur, 'true'), f = branch(cur, 'false');
      const cond = (node.label || 'condition').trim();
      const tLoops = reaches(t, cur, new Set(stop == null ? [] : [stop]));
      const fLoops = reaches(f, cur, new Set(stop == null ? [] : [stop]));
      if ((tLoops && !fLoops) || (fLoops && !tLoops)) {
        // A branch loops back → while. The looping branch is the body and the
        // condition means "keep looping" (so it works whichever branch you drew
        // the loop on — no true/false guesswork).
        const bodyStart = tLoops ? t : f, exitTo = tLoops ? f : t;
        lines.push(`${pad}while ${cond} {`);
        lines.push(...emit(bodyStart, cur, depth + 1));
        lines.push(`${pad}}`);
        cur = exitTo;
      } else {                                       // if / else
        const m = merge(t, f, new Set(stop == null ? [] : [stop]));
        const thenB = emit(t, m, depth + 1);
        const elseB = emit(f, m, depth + 1);
        lines.push(`${pad}if ${cond} {`);
        lines.push(...thenB);
        if (elseB.some(l => l.trim())) { lines.push(`${pad}} else {`); lines.push(...elseB); }
        lines.push(`${pad}}`);
        cur = m;
      }
    }
    return lines;
  };

  const body = emit(succ(start.id), null, 1);
  const all = [...setupLines, ...body];
  if (!all.length) return '// Declare variables/functions in Setup, then connect Start → steps → End.';
  return `#{\n${all.join('\n')}\n}`;
}

// ---- preloaded examples -----------------------------------------------------
// `defs`: [type, label, x, y]; `links`: [fromIndex, toIndex, branch?] (indices
// into defs; 'true'/'false' label a decision's arrows, anything else = plain).
const mk = (setup: string, defs: [NodeType, string, number, number][], links: [number, number, ('true' | 'false' | 'body')?][]): Diagram => ({
  setup,
  nodes: defs.map(([type, label, x, y], i) => ({ id: i + 1, type, label, x, y })),
  edges: links.map(([a, b, br], i) => ({ id: i + 1, from: a + 1, to: b + 1, branch: br === 'true' || br === 'false' ? br : undefined })),
});

const EXAMPLES: { name: string, build: () => Diagram }[] = [
  { name: 'Factorial — n!', build: () => mk('let n = 5\nlet f = 1\nlet i = 1',
    [['start', 'Start', 330, 40], ['decision', 'i <= n', 330, 140], ['process', 'f = f * i', 330, 250], ['process', 'i = i + 1', 330, 340], ['output', 'f', 540, 140], ['end', 'End', 540, 250]],
    [[0, 1], [1, 2, 'true'], [2, 3], [3, 1], [1, 4, 'false'], [4, 5]]) },
  { name: 'Sum 1…n', build: () => mk('let n = 10\nlet s = 0\nlet i = 1',
    [['start', 'Start', 330, 40], ['decision', 'i <= n', 330, 140], ['process', 's = s + i', 330, 250], ['process', 'i = i + 1', 330, 340], ['output', 's', 540, 140], ['end', 'End', 540, 250]],
    [[0, 1], [1, 2, 'true'], [2, 3], [3, 1], [1, 4, 'false'], [4, 5]]) },
  { name: 'Is n prime? (trial division)', build: () => mk('let n = 17\nlet is-prime = n > 1\nlet d = 2',
    [['start', 'Start', 330, 40], ['decision', 'd * d <= n', 330, 130], ['decision', 'calc.rem(n, d) == 0', 330, 230], ['process', 'is-prime = false', 140, 230], ['process', 'd = d + 1', 330, 340], ['output', 'is-prime', 550, 130], ['end', 'End', 550, 230]],
    [[0, 1], [1, 2, 'true'], [2, 3, 'true'], [3, 4], [2, 4, 'false'], [4, 1], [1, 5, 'false'], [5, 6]]) },
  { name: 'GCD (Euclid)', build: () => mk('let a = 48\nlet b = 18',
    [['start', 'Start', 330, 40], ['decision', 'b != 0', 330, 130], ['process', 'let r = calc.rem(a, b)', 330, 230], ['process', 'a = b', 330, 310], ['process', 'b = r', 330, 390], ['output', 'a', 540, 130], ['end', 'End', 540, 230]],
    [[0, 1], [1, 2, 'true'], [2, 3], [3, 4], [4, 1], [1, 5, 'false'], [5, 6]]) },
  { name: 'Fibonacci — nth', build: () => mk('let n = 10\nlet a = 0\nlet b = 1\nlet i = 0',
    [['start', 'Start', 330, 30], ['decision', 'i < n', 330, 120], ['process', 'let t = a + b', 330, 210], ['process', 'a = b', 330, 285], ['process', 'b = t', 330, 360], ['process', 'i = i + 1', 330, 430], ['output', 'a', 540, 120], ['end', 'End', 540, 220]],
    [[0, 1], [1, 2, 'true'], [2, 3], [3, 4], [4, 5], [5, 1], [1, 6, 'false'], [6, 7]]) },
  { name: 'Sum of squares (for-loop)', build: () => mk('let n = 6\nlet s = 0',
    [['start', 'Start', 340, 50], ['loop', 'i in range(1, n + 1)', 340, 150], ['process', 's = s + i * i', 340, 260], ['output', 's', 540, 150], ['end', 'End', 540, 250]],
    [[0, 1], [1, 2], [2, 1], [1, 3], [3, 4]]) },
  { name: 'Collatz steps', build: () => mk('let n = 27\nlet steps = 0',
    [['start', 'Start', 320, 30], ['decision', 'n > 1', 320, 120], ['decision', 'calc.even(n)', 320, 215], ['process', 'n = calc.quo(n, 2)', 140, 215], ['process', 'n = 3 * n + 1', 500, 215], ['process', 'steps = steps + 1', 320, 320], ['output', 'steps', 560, 120], ['end', 'End', 560, 215]],
    [[0, 1], [1, 2, 'true'], [2, 3, 'true'], [2, 4, 'false'], [3, 5], [4, 5], [5, 1], [1, 6, 'false'], [6, 7]]) },
];

// ---- geometry ---------------------------------------------------------------
type Pt = { x: number, y: number };
const center = (n: FNode) => ({ x: n.x, y: n.y });
const nscale = (n: FNode) => n.scale ?? 1;
const halfW = (n: FNode) => SIZE[n.type].w / 2 * nscale(n), halfH = (n: FNode) => SIZE[n.type].h / 2 * nscale(n);
// Point on n's actual outline along the line toward p — shape-aware, so arrows
// really touch diamonds and pills instead of stopping at their bounding box.
function border(n: FNode, p: Pt): Pt {
  const dx = p.x - n.x, dy = p.y - n.y;
  if (dx === 0 && dy === 0) return { x: n.x, y: n.y };
  const hw = halfW(n), hh = halfH(n);
  let s: number;
  if (n.type === 'decision') s = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);            // rhombus
  else if (n.type === 'start' || n.type === 'end') s = 1 / Math.hypot(dx / hw, dy / hh); // pill ≈ ellipse
  else s = Math.min(hw / (Math.abs(dx) || 1e-6), hh / (Math.abs(dy) || 1e-6));           // rectangle
  return { x: n.x + dx * s, y: n.y + dy * s };
}

// A curved connector between two nodes: a quadratic bézier whose control point
// sits `bend` px off the chord midpoint (perpendicular). Drag the handle to set
// `bend`; when it's undefined a sensible default bows loop-backs out of the way.
function chordGeom(a: FNode, b: FNode) {
  const p1 = border(a, center(b)), p2 = border(b, center(a));
  const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.hypot(dx, dy) || 1;
  return { p1, p2, mx: (p1.x + p2.x) / 2, my: (p1.y + p2.y) / 2, nx: -dy / len, ny: dx / len, len };
}
function defaultBend(a: FNode, b: FNode): number {
  const g = chordGeom(a, b);
  if (b.y <= a.y + 6) return (a.x + b.x) / 2 >= W / 2 ? 70 : -70; // loop-back → bow outward
  return (a.x <= b.x ? 1 : -1) * Math.min(24, g.len * 0.14);
}
function edgePath(a: FNode, b: FNode, bend?: number): { d: string, mid: Pt, handle: Pt, p1: Pt, p2: Pt, c: Pt } {
  const g = chordGeom(a, b);
  let amt = bend ?? defaultBend(a, b);
  if (!Number.isFinite(amt)) amt = 0;
  amt = Math.max(-BEND_LIMIT, Math.min(BEND_LIMIT, amt));
  const c = { x: g.mx + g.nx * amt, y: g.my + g.ny * amt };
  // Re-anchor the endpoints toward the control point: on a bent curve the arrow
  // leaves/enters along the curve's direction, so it sits flush on the outline.
  const p1 = border(a, c), p2 = border(b, c);
  const hx = 0.25 * p1.x + 0.5 * c.x + 0.25 * p2.x, hy = 0.25 * p1.y + 0.5 * c.y + 0.25 * p2.y; // t=0.5 on the curve
  return { d: `M ${p1.x} ${p1.y} Q ${c.x} ${c.y} ${p2.x} ${p2.y}`, mid: { x: hx, y: hy }, handle: { x: hx, y: hy }, p1, p2, c };
}
// Distance-to-curve test: is p within `tol` of the edge, anywhere along it?
function nearEdge(a: FNode, b: FNode, bend: number | undefined, p: Pt, tol = 9): boolean {
  const { p1, p2, c } = edgePath(a, b, bend);
  for (let i = 0; i <= 24; i++) {
    const t = i / 24, u = 1 - t;
    const x = u * u * p1.x + 2 * t * u * c.x + t * t * p2.x;
    const y = u * u * p1.y + 2 * t * u * c.y + t * t * p2.y;
    if (Math.hypot(x - p.x, y - p.y) < tol) return true;
  }
  return false;
}

export default function FlowchartCoder({ onClose, onInsert, onSaved }: {
  onClose: () => void, onInsert: (code: string) => void, onSaved?: (path: string) => void,
}) {
  // Restore the last diagram so closing/reopening (even after inserting) keeps
  // your work — you can come back and edit it.
  const SAVED = (() => { try { return JSON.parse(localStorage.getItem('fc-diagram-v2') || 'null'); } catch { return null; } })();
  const [nodes, setNodes] = useState<FNode[]>(SAVED?.nodes?.length ? SAVED.nodes : [
    { id: 1, type: 'start', label: 'Start', x: 340, y: 50 },
    { id: 2, type: 'end', label: 'End', x: 340, y: 420 },
  ]);
  const [edges, setEdges] = useState<FEdge[]>(SAVED?.edges ?? []);
  const [setup, setSetup] = useState<string>(SAVED?.setup ?? '');
  const [showResult, setShowResult] = useState<boolean>(SAVED?.showResult ?? true);
  const [tool, setTool] = useState<'select' | 'connect'>('select');
  const [sel, setSel] = useState<{ kind: 'node' | 'edge', id: number } | null>(null);
  const [linkFrom, setLinkFrom] = useState<number | null>(null);
  const [mouse, setMouse] = useState<{ x: number, y: number } | null>(null);
  // Pan / zoom: the SVG viewBox. Zooming out shows more room for big diagrams.
  const [view, setView] = useState({ x: 0, y: 0, w: W, h: H });
  const viewRef = useRef(view); viewRef.current = view;
  const svgRef = useRef<SVGSVGElement>(null);
  const idRef = useRef(SAVED?.nextId ?? 3);
  const drag = useRef<null | { id: number, dx: number, dy: number, moved: boolean }>(null);
  const edgeDrag = useRef<null | { id: number, mx: number, my: number, nx: number, ny: number }>(null);
  const pan = useRef<null | { sx: number, sy: number, vx: number, vy: number, moved: boolean }>(null);

  // Undo / redo history (snapshots of the whole diagram + setup).
  type Snap = { nodes: FNode[], edges: FEdge[], setup: string };
  const undoRef = useRef<Snap[]>([]);
  const redoRef = useRef<Snap[]>([]);
  const stateRef = useRef<Snap>({ nodes, edges, setup });
  stateRef.current = { nodes, edges, setup };
  const [, bump] = useState(0);
  const pushUndo = () => { undoRef.current.push({ ...stateRef.current }); if (undoRef.current.length > 100) undoRef.current.shift(); redoRef.current = []; bump(x => x + 1); };
  const applySnap = (s: Snap) => { setNodes(s.nodes); setEdges(s.edges); setSetup(s.setup); setSel(null); bump(x => x + 1); };
  const undo = () => { if (!undoRef.current.length) return; redoRef.current.push({ ...stateRef.current }); applySnap(undoRef.current.pop()!); };
  const redo = () => { if (!redoRef.current.length) return; undoRef.current.push({ ...stateRef.current }); applySnap(redoRef.current.pop()!); };
  // Latest closures for the (once-registered) keyboard handler.
  const actionsRef = useRef({ undo, redo, del: () => {} });
  // Persist the diagram so it survives close/reopen.
  useEffect(() => { try { localStorage.setItem('fc-diagram-v2', JSON.stringify({ nodes, edges, setup, showResult, nextId: idRef.current })); } catch { /* quota */ } }, [nodes, edges, setup, showResult]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      // Only THIS modal's own inputs count as text fields — the editor's hidden
      // textarea underneath stays focused, so don't let it swallow our keys.
      const inField = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !!el.closest?.('.modal-content');
      if ((e.key === 'Delete' || e.key === 'Backspace') && !inField) { e.preventDefault(); actionsRef.current.del(); return; }
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (inField) return;                                   // let text fields keep native undo
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); actionsRef.current.undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); e.stopImmediatePropagation(); actionsRef.current.redo(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const pt = (e: { clientX: number, clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: v.x + (e.clientX - r.left) * (v.w / r.width), y: v.y + (e.clientY - r.top) * (v.h / r.height) };
  };
  const snap = (v: number) => Math.round(v / GRID) * GRID;

  // ---- zoom / pan / fit ----
  const zoomAt = (factor: number, cx: number, cy: number) => setView(v => {
    const w = Math.max(W * 0.3, Math.min(W * 3, v.w / factor));
    const s = w / v.w;
    return { x: cx - (cx - v.x) * s, y: cy - (cy - v.y) * s, w, h: v.h * s };
  });
  const zoomCenter = (factor: number) => { const v = viewRef.current; zoomAt(factor, v.x + v.w / 2, v.y + v.h / 2); };
  const fitView = () => {
    if (!nodes.length) { setView({ x: 0, y: 0, w: W, h: H }); return; }
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const n of nodes) { minx = Math.min(minx, n.x - halfW(n)); maxx = Math.max(maxx, n.x + halfW(n)); miny = Math.min(miny, n.y - halfH(n)); maxy = Math.max(maxy, n.y + halfH(n)); }
    const padx = 40; minx -= padx; miny -= padx; maxx += padx; maxy += padx;
    let w = maxx - minx, h = maxy - miny; const ar = W / H;
    if (w / h > ar) h = w / ar; else w = h * ar;
    setView({ x: (minx + maxx) / 2 - w / 2, y: (miny + maxy) / 2 - h / 2, w, h });
  };
  // Wheel-to-zoom at the cursor (bound non-passively so we can preventDefault).
  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, pt(e as any).x, pt(e as any).y);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Shape-aware: a diamond's bounding box is much bigger than the diamond, and
  // it was swallowing clicks meant for nearby arrows.
  const insideNode = (n: FNode, p: Pt) => {
    const dx = Math.abs(p.x - n.x), dy = Math.abs(p.y - n.y), hw = halfW(n), hh = halfH(n);
    if (n.type === 'decision') return dx / hw + dy / hh <= 1;
    if (n.type === 'start' || n.type === 'end') return (dx / hw) ** 2 + (dy / hh) ** 2 <= 1;
    return dx <= hw && dy <= hh;
  };
  const hitNode = (p: Pt) => [...nodes].reverse().find(n => insideNode(n, p)) || null;

  const addNode = (type: NodeType) => {
    // Cascade new nodes down the middle so a top-to-bottom flowchart builds
    // itself; the user nudges them into place.
    pushUndo();
    const mids = nodes.filter(n => n.type !== 'start' && n.type !== 'end').length;
    const y = snap(Math.min(370, 110 + mids * 60));
    const x = snap(340 + (mids % 2 ? 60 : -20));
    const n: FNode = { id: idRef.current++, type, label: DEFAULT_LABEL[type], x, y };
    setNodes(v => [...v, n]); setSel({ kind: 'node', id: n.id }); setTool('select');
  };

  // Load a ready-made algorithm diagram (factorial, primality, GCD, …).
  const loadExample = (name: string) => {
    const ex = EXAMPLES.find(e => e.name === name); if (!ex) return;
    pushUndo();
    const d = ex.build();
    setNodes(d.nodes); setEdges(d.edges); setSetup(d.setup);
    idRef.current = Math.max(0, ...d.nodes.map(n => n.id)) + 1;
    setSel(null); setTool('select');
    setView({ x: 0, y: 0, w: W, h: H });
  };

  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();               // stop the browser text-selecting node labels on drag
    const p = pt(e); const n = hitNode(p);
    if (tool === 'connect') { if (n) setLinkFrom(n.id); return; }
    // Grab the bend handle of the currently-selected edge (to shape its curve).
    if (sel?.kind === 'edge') {
      const ed = edges.find(x => x.id === sel.id);
      const a = ed && nodes.find(x => x.id === ed.from), b = ed && nodes.find(x => x.id === ed.to);
      if (ed && a && b) {
        const { handle } = edgePath(a, b, ed.bend);
        if (Math.hypot(handle.x - p.x, handle.y - p.y) < 13) {
          pushUndo();
          const g = chordGeom(a, b);
          edgeDrag.current = { id: ed.id, mx: g.mx, my: g.my, nx: g.nx, ny: g.ny };
          return;
        }
      }
    }
    if (n) { setSel({ kind: 'node', id: n.id }); drag.current = { id: n.id, dx: p.x - n.x, dy: p.y - n.y, moved: false }; return; }
    // click on an edge — anywhere along its curve, not just the midpoint
    const edge = edges.find(ed => { const a = nodes.find(x => x.id === ed.from), b = nodes.find(x => x.id === ed.to); if (!a || !b) return false; return nearEdge(a, b, ed.bend, p); });
    if (edge) { setSel({ kind: 'edge', id: edge.id }); return; }
    // Empty space → start a pan (deselect only if it turns out to be a click).
    pan.current = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onMove = (e: React.MouseEvent) => {
    if (pan.current) {
      const r = svgRef.current!.getBoundingClientRect();
      const d = pan.current;
      const dx = (e.clientX - d.sx) * (view.w / r.width), dy = (e.clientY - d.sy) * (view.h / r.height);
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
      setView(v => ({ ...v, x: d.vx - dx, y: d.vy - dy }));
      return;
    }
    const p = pt(e);
    if (tool === 'connect' && linkFrom != null) { setMouse(p); return; }
    if (edgeDrag.current) {
      const d = edgeDrag.current;
      const raw = Math.round((p.x - d.mx) * d.nx + (p.y - d.my) * d.ny);
      const bend = Math.max(-BEND_LIMIT, Math.min(BEND_LIMIT, raw));
      setEdges(v => v.map(ed => ed.id === d.id ? { ...ed, bend } : ed));
      return;
    }
    if (drag.current) {
      const d = drag.current;
      if (!d.moved) { pushUndo(); d.moved = true; }   // snapshot once, on the first move
      setNodes(v => v.map(n => n.id === d.id ? { ...n, x: snap(p.x - d.dx), y: snap(p.y - d.dy) } : n));
    }
  };
  const onUp = (e: React.MouseEvent) => {
    edgeDrag.current = null;
    if (pan.current) { if (!pan.current.moved) setSel(null); pan.current = null; }   // click on empty space → deselect
    if (tool === 'connect' && linkFrom != null) {
      const n = hitNode(pt(e));
      if (n && n.id !== linkFrom) {
        pushUndo();
        const from = nodes.find(x => x.id === linkFrom)!;
        let branch: 'true' | 'false' | undefined;
        if (from.type === 'decision') branch = edges.filter(x => x.from === from.id && x.branch === 'true').length ? 'false' : 'true';
        setEdges(v => [...v, { id: idRef.current++, from: linkFrom, to: n.id, branch }]);
      }
      setLinkFrom(null); setMouse(null);
    }
    drag.current = null;
  };

  const updateSel = (patch: Partial<FNode>) => { if (sel?.kind === 'node') setNodes(v => v.map(n => n.id === sel.id ? { ...n, ...patch } : n)); };
  const deleteSel = () => {
    if (!sel) return;
    pushUndo();
    if (sel.kind === 'node') { setNodes(v => v.filter(n => n.id !== sel.id)); setEdges(v => v.filter(e => e.from !== sel.id && e.to !== sel.id)); }
    else setEdges(v => v.filter(e => e.id !== sel.id));
    setSel(null);
  };
  const flipBranch = () => { if (sel?.kind === 'edge') { pushUndo(); setEdges(v => v.map(e => e.id === sel.id ? { ...e, branch: e.branch === 'true' ? 'false' : 'true' } : e)); } };
  actionsRef.current = { undo, redo, del: deleteSel };   // keep the keyboard handler current

  // Rasterise the current canvas (minus the grid/handles) to a PNG, save it in
  // the workspace, and insert a figure — so the drawn flowchart itself can go
  // into the PDF, not only its code.
  const [busy, setBusy] = useState(false);
  const insertDiagram = (alsoCode = false) => {
    if (busy) return;
    flushSync(() => setSel(null));   // repaint without selection highlight before capturing
    const svg = svgRef.current; if (!svg) return;
    setBusy(true);
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('width', String(W)); clone.setAttribute('height', String(H)); clone.removeAttribute('style');
    clone.querySelectorAll('rect').forEach(r => { if (r.getAttribute('fill') === 'url(#fcgrid)') r.remove(); });
    clone.querySelectorAll('circle').forEach(c => c.remove());   // drag/select handles
    const svgStr = new XMLSerializer().serializeToString(clone);
    // Export resolution from App Settings (DPI). Base SVG is 96 dpi.
    const dpi = Math.max(96, Math.min(600, Number(localStorage.getItem('fc_export_dpi')) || 200));
    const scale = dpi / 96;
    const img = new Image();
    img.onload = async () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const png = canvas.toDataURL('image/png');
        const name = `images/flowchart-${Date.now().toString(36)}.png`;
        const res = await fetch(`${API}/workspace/save-image`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: name, dataUrl: png }) });
        if (res.ok) {
          onSaved?.(name);
          const fig = `\n#figure(\n  image("${name}", width: 70%),\n  caption: [Flowchart],\n)\n\n`;
          onInsert(alsoCode ? `${fig}${code}\n\n` : fig);
        }
      } finally { setBusy(false); }
    };
    img.onerror = () => setBusy(false);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
  };

  const code = useMemo(() => generate(nodes, edges, setup, showResult), [nodes, edges, setup, showResult]);
  const selNode = sel?.kind === 'node' ? nodes.find(n => n.id === sel.id) : null;
  const selEdge = sel?.kind === 'edge' ? edges.find(e => e.id === sel.id) : null;

  const renderNode = (n: FNode) => {
    const hw = halfW(n), hh = halfH(n); const on = sel?.kind === 'node' && sel.id === n.id;
    const stroke = on ? '#7c3aed' : '#334155', fill = NODE_FILL[n.type];
    const common = { stroke, strokeWidth: on ? 2.5 : 1.5, fill, filter: 'url(#fc-shadow)' };
    let shape;
    if (n.type === 'decision') {
      const pts = `${n.x},${n.y - hh} ${n.x + hw},${n.y} ${n.x},${n.y + hh} ${n.x - hw},${n.y}`;
      shape = <polygon points={pts} {...common} />;
    } else if (n.type === 'output' || n.type === 'input') {
      const k = 14 * nscale(n); // parallelogram skew (flowchart I/O shape)
      const pts = `${n.x - hw + k},${n.y - hh} ${n.x + hw},${n.y - hh} ${n.x + hw - k},${n.y + hh} ${n.x - hw},${n.y + hh}`;
      shape = <polygon points={pts} {...common} />;
    } else if (n.type === 'loop') {
      const k = 16 * nscale(n); // hexagon (loop / preparation shape)
      const pts = `${n.x - hw + k},${n.y - hh} ${n.x + hw - k},${n.y - hh} ${n.x + hw},${n.y} ${n.x + hw - k},${n.y + hh} ${n.x - hw + k},${n.y + hh} ${n.x - hw},${n.y}`;
      shape = <polygon points={pts} {...common} />;
    } else if (n.type === 'comment') {
      shape = <rect x={n.x - hw} y={n.y - hh} width={hw * 2} height={hh * 2} rx={3} {...common} strokeDasharray="4 3" />;
    } else {
      shape = <rect x={n.x - hw} y={n.y - hh} width={hw * 2} height={hh * 2} rx={n.type === 'process' ? 4 : hh} {...common} />;
    }
    const maxChars = Math.max(8, Math.round(20 * nscale(n)));
    return (
      <g key={n.id}>
        {shape}
        <text x={n.x} y={n.y} fontSize={12.5 * Math.min(1.25, Math.max(0.85, nscale(n)))} textAnchor="middle" dominantBaseline="central" fill="#0f172a" fontFamily="ui-monospace, Menlo, monospace" style={{ pointerEvents: 'none' }}>
          {(n.label || '').length > maxChars ? n.label.slice(0, maxChars - 1) + '…' : n.label}
        </text>
      </g>
    );
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '1120px', maxWidth: '97vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Flowchart → Typst logic</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'row', gap: '12px', alignItems: 'stretch', flex: '0 1 auto', minHeight: 0, overflowY: 'auto' }}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <div className="fc-toolbar" style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
              <div className="seg">
                <button className={tool === 'select' ? 'active' : ''} onClick={() => { setTool('select'); setSel(null); setLinkFrom(null); }}>Select / Move</button>
                <button className={tool === 'connect' ? 'active' : ''} onClick={() => { setTool('connect'); setSel(null); }}>Connect →</button>
              </div>
              <button className="btn-ghost" onClick={() => addNode('input')}>+ Input</button>
              <button className="btn-ghost" onClick={() => addNode('process')}>+ Process</button>
              <button className="btn-ghost" onClick={() => addNode('decision')}>+ Decision</button>
              <button className="btn-ghost" onClick={() => addNode('output')}>+ Output</button>
              <button className="btn-ghost" onClick={() => addNode('loop')} title="For-loop over a range/collection">+ For</button>
              <button className="btn-ghost" onClick={() => addNode('comment')} title="A // comment line">+ Note</button>
              <button className="btn-ghost" onClick={() => addNode('start')}>+ Start</button>
              <button className="btn-ghost" onClick={() => addNode('end')}>+ End</button>
              <div style={{ width: 1, height: 20, background: 'var(--border-color)', margin: '0 2px' }} />
              <select className="btn-ghost" defaultValue="" onChange={e => { if (e.target.value) { loadExample(e.target.value); e.target.value = ''; } }} title="Load a ready-made algorithm" style={{ maxWidth: 150 }}>
                <option value="" disabled>Examples ▾</option>
                {EXAMPLES.map(ex => <option key={ex.name} value={ex.name}>{ex.name}</option>)}
              </select>
              <button className="btn-ghost" onClick={undo} disabled={!undoRef.current.length} title={`Undo (${keys('⌘Z')})`}>↶ Undo</button>
              <button className="btn-ghost" onClick={redo} disabled={!redoRef.current.length} title={`Redo (${keys('⌘Y')})`}>↷ Redo</button>
              <button className="btn-ghost" onClick={() => { pushUndo(); setNodes([{ id: 1, type: 'start', label: 'Start', x: 340, y: 50 }, { id: 2, type: 'end', label: 'End', x: 340, y: 420 }]); setEdges([]); setSetup(''); setSel(null); idRef.current = 3; setView({ x: 0, y: 0, w: W, h: H }); }} title="Start a fresh diagram">Clear</button>
            </div>
            <div style={{ position: 'relative' }}>
            <svg ref={svgRef} viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
              style={{ width: '100%', background: '#fff', border: '1px solid #cbd5e1', borderRadius: 6, cursor: tool === 'connect' ? 'crosshair' : 'default', display: 'block', userSelect: 'none', WebkitUserSelect: 'none' }}>
              <defs>
                <pattern id="fcgrid" width={GRID} height={GRID} patternUnits="userSpaceOnUse"><path d={`M ${GRID} 0 L 0 0 0 ${GRID}`} fill="none" stroke="#eef1f6" strokeWidth="1" /></pattern>
                <marker id="fc-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#475569" /></marker>
                <marker id="fc-arrow-sel" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7c3aed" /></marker>
                <filter id="fc-shadow" x="-20%" y="-40%" width="140%" height="180%"><feDropShadow dx="0" dy="1.4" stdDeviation="1.6" floodColor="#0f172a" floodOpacity="0.18" /></filter>
              </defs>
              <rect x={view.x} y={view.y} width={view.w} height={view.h} fill="url(#fcgrid)" />
              {edges.map(ed => {
                const a = nodes.find(n => n.id === ed.from), b = nodes.find(n => n.id === ed.to);
                if (!a || !b) return null;
                const { d, mid } = edgePath(a, b, ed.bend);
                const on = sel?.kind === 'edge' && sel.id === ed.id;
                return (
                  <g key={ed.id}>
                    <path d={d} fill="none" stroke={on ? '#7c3aed' : '#475569'} strokeWidth={on ? 2.5 : 1.6} markerEnd={on ? 'url(#fc-arrow-sel)' : 'url(#fc-arrow)'} />
                    {ed.branch && <g><rect x={mid.x - 16} y={mid.y - 10} width={32} height={18} rx={4} fill={ed.branch === 'true' ? '#dcfce7' : '#fee2e2'} stroke="#94a3b8" strokeWidth="0.8" /><text x={mid.x} y={mid.y} fontSize="10.5" textAnchor="middle" dominantBaseline="central" fill="#0f172a">{ed.branch}</text></g>}
                  </g>
                );
              })}
              {nodes.map(renderNode)}
              {/* Drag handle to shape the selected edge's curve. */}
              {sel?.kind === 'edge' && (() => {
                const ed = edges.find(x => x.id === sel.id); if (!ed) return null;
                const a = nodes.find(n => n.id === ed.from), b = nodes.find(n => n.id === ed.to); if (!a || !b) return null;
                const { handle } = edgePath(a, b, ed.bend);
                return <circle cx={handle.x} cy={handle.y} r={6} fill="#fff" stroke="#7c3aed" strokeWidth={2} style={{ cursor: 'grab' }} />;
              })()}
              {tool === 'connect' && linkFrom != null && mouse && (() => { const a = nodes.find(n => n.id === linkFrom)!; const p1 = border(a, mouse); return <line x1={p1.x} y1={p1.y} x2={mouse.x} y2={mouse.y} stroke="#7c3aed" strokeWidth="1.6" strokeDasharray="4 4" markerEnd="url(#fc-arrow)" />; })()}
            </svg>
            {/* Zoom controls (drag the empty canvas to pan; scroll to zoom). */}
            <div style={{ position: 'absolute', right: 8, bottom: 8, display: 'flex', gap: 4, background: 'rgba(255,255,255,0.92)', border: '1px solid #cbd5e1', borderRadius: 6, padding: 3, boxShadow: '0 1px 4px rgba(0,0,0,0.12)' }}>
              <button className="btn-ghost" style={{ padding: '2px 8px', fontWeight: 700 }} onClick={() => zoomCenter(1 / 1.25)} title="Zoom out">−</button>
              <button className="btn-ghost" style={{ padding: '2px 8px' }} onClick={fitView} title="Fit diagram to view">Fit</button>
              <button className="btn-ghost" style={{ padding: '2px 8px', fontWeight: 700 }} onClick={() => zoomCenter(1.25)} title="Zoom in">+</button>
            </div>
            </div>
            <div className="form-hint" style={{ marginTop: 6 }}>
              <b>Connect →</b> drag from one node to another to add an arrow. From a <b>Decision</b>, the first arrow is
              <span style={{ color: '#16a34a' }}> true</span>, the second <span style={{ color: '#dc2626' }}>false</span> (click an arrow to flip it).
              A branch that loops back to its decision becomes a <code>while</code>; two branches that rejoin become <code>if / else</code>.
            </div>
          </div>

          <div style={{ flex: '0 0 264px', minWidth: 0, borderLeft: '1px solid #e2e8f0', paddingLeft: 12, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: 4 }}>Setup — variables &amp; functions</div>
            <textarea className="fc-setup" rows={3} value={setup} onChange={e => setSetup(e.target.value)} onFocus={pushUndo}
              placeholder={'let x = 0\nlet n = 10\nlet square(x) = x * x'} spellCheck={false} />
            <div className="form-hint" style={{ marginTop: 4 }}>
              Runs first — this is where each variable <b>starts</b>. Declare with <code>let</code>, and define your own
              functions (<code>let f(x) = …</code>). Any built-in Typst function works in any box too.
            </div>
            <div style={{ borderTop: '1px solid #e2e8f0', margin: '12px 0' }} />
            {selNode ? (
              <>
                <label className="form-field"><span>{selNode.type === 'decision' ? 'Condition (Typst)' : selNode.type === 'output' ? 'Value to show (Typst)' : selNode.type === 'input' ? 'Declaration (Typst)' : selNode.type === 'process' ? 'Statement (Typst)' : selNode.type === 'loop' ? 'For-loop header (Typst)' : selNode.type === 'comment' ? 'Comment text' : 'Label'}</span>
                  <input type="text" value={selNode.label} onChange={e => updateSel({ label: e.target.value })} onFocus={pushUndo}
                    placeholder={selNode.type === 'decision' ? 'e.g. i <= n' : selNode.type === 'output' ? 'e.g. total' : selNode.type === 'input' ? 'e.g. let s = 0' : selNode.type === 'loop' ? 'e.g. i in range(1, n + 1)' : selNode.type === 'comment' ? 'e.g. accumulate the sum' : 'e.g. s = s + i'} disabled={selNode.type === 'start' || selNode.type === 'end'} />
                </label>
                <div className="form-hint" style={{ marginTop: 6 }}>
                  {selNode.type === 'input' && 'A variable declaration: let s = 0, let n = 5. Put these first, after Start.'}
                  {selNode.type === 'process' && 'Any statement: s = s + i, or a function: let sq(x) = x * x.'}
                  {selNode.type === 'decision' && 'A boolean condition: i <= n, x > 0, calc.even(k) …'}
                  {selNode.type === 'output' && 'A bare value to display. Put this box right before End so the result prints.'}
                  {selNode.type === 'loop' && 'A for-loop header: i in range(1, n + 1), or item in list. Connect its body back to this box to close the loop, and a second arrow onward to exit.'}
                  {selNode.type === 'comment' && 'A // comment line in the generated code.'}
                  {(selNode.type === 'start' || selNode.type === 'end') && 'Entry / exit of the flow.'}
                </div>
                <label className="form-field" style={{ marginTop: 10 }}>
                  <span>Size — {Math.round((selNode.scale ?? 1) * 100)}%</span>
                  <input type="range" min={60} max={180} step={5} value={Math.round((selNode.scale ?? 1) * 100)}
                    onPointerDown={pushUndo} onChange={e => updateSel({ scale: Number(e.target.value) / 100 })} />
                </label>
                <button className="btn-ghost" style={{ marginTop: 10, width: '100%' }} onClick={deleteSel}>Delete node</button>
              </>
            ) : selEdge ? (
              <>
                <div className="form-hint">Arrow selected. Drag the <span style={{ color: '#7c3aed' }}>purple handle</span> on the curve to bend it.</div>
                {selEdge.branch && <button className="btn-ghost" style={{ marginTop: 10, width: '100%' }} onClick={flipBranch}>Flip to “{selEdge.branch === 'true' ? 'false' : 'true'}”</button>}
                <button className="btn-ghost" style={{ marginTop: 8, width: '100%' }} onClick={() => { pushUndo(); setEdges(v => v.map(e => e.id === selEdge.id ? { ...e, bend: undefined } : e)); }}>Reset curve</button>
                <button className="btn-ghost" style={{ marginTop: 8, width: '100%' }} onClick={deleteSel}>Delete arrow</button>
              </>
            ) : (
              <div className="form-hint">Add <b>Process</b> (a statement), <b>Decision</b> (a condition) and an <b>Output</b> (the value to show) node, then <b>Connect</b> them from Start to End. Select a node to edit its Typst.</div>
            )}
            <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)' }}>Generated Typst</span>
              <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer' }} title="Wrap the Output value in a labelled “Result:” box so it stands out in the document">
                <input type="checkbox" checked={showResult} onChange={e => setShowResult(e.target.checked)} /> Result box
              </label>
            </div>
            <pre className="fc-code" style={{ flex: '1 1 auto', minHeight: 90 }}>{code}</pre>
          </div>
        </div>
        <div className="modal-footer" style={{ flexShrink: 0 }}>
          <button className="btn-ghost" onClick={onClose}>Close</button>
          <button className="btn-ghost" onClick={() => insertDiagram(false)} disabled={busy} title="Add the drawn flowchart to the document as an image">{busy ? 'Saving…' : 'Insert diagram'}</button>
          <button className="btn-ghost" onClick={() => insertDiagram(true)} disabled={busy || code.startsWith('//')} title="Add both the image and the code">Insert both</button>
          <button className="btn-primary" onClick={() => onInsert(code)} disabled={code.startsWith('//')}>Insert code</button>
        </div>
      </div>
    </div>
  );
}
