// The document's labels, and what refers to what.
//
// A paper's cross-references are a structure nobody gets to see: an equation is
// derived from two others, a section leans on a figure, and half a dozen labels
// are never referred to at all. Typst knows all of it and shows none of it.
//
// Reading left to right is document order — a label sits at the horizontal
// place its definition sits in the source — so an arrow pointing left is a
// reference backwards, which is what most of them are. Height is settled by the
// usual push-and-pull, which keeps related labels together without anyone
// having to lay them out.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API } from '../api';
import { HEIGHT, layout, settle, widthFor, type Placed } from '../labelLayout';
import type { Graph, Node as Label } from './labelGraphTypes';

// Two palettes: pale colours vanish on a white page, and dark ones vanish on a
// black one. Which is in use is read from the page rather than from a setting,
// so a theme Hilbert gains later is handled too.
type Palette = { kinds: Record<string, string>; other: string; section: string };
const DARK_PALETTE: Palette = {
  kinds: { eq: '#60a5fa', fig: '#34d399', tab: '#fbbf24', sec: '#c084fc', thm: '#f87171', lst: '#fb923c' },
  other: '#94a3b8',
  section: '#8b93a7',
};
const LIGHT_PALETTE: Palette = {
  kinds: { eq: '#1d4ed8', fig: '#047857', tab: '#b45309', sec: '#6d28d9', thm: '#b91c1c', lst: '#c2410c' },
  other: '#475569',
  section: '#334155',
};
const isDarkPage = () => {
  if (typeof window === 'undefined') return true;
  const background = getComputedStyle(document.documentElement).getPropertyValue('--bg-color').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(background);
  let rgb: [number, number, number] | null = null;
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map(c => c + c) : hex[1].match(/../g)!;
    rgb = digits.map(d => parseInt(d, 16)) as [number, number, number];
  } else {
    const parts = background.match(/[\d.]+/g);
    if (parts && parts.length >= 3) rgb = parts.slice(0, 3).map(Number) as [number, number, number];
  }
  if (!rgb) return true;
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) < 140;
};
const colourFor = (palette: Palette, kind: string) =>
  (kind === 'section' ? palette.section : palette.kinds[kind] || palette.other);
const nameOf = (node: { kind: string; title?: string; id: string }) =>
  node.kind === 'section' ? node.title || node.id : node.id;



export default function LabelGraph({ mainFile, onClose, onOpen }: {
  mainFile: string;
  onClose: () => void;
  onOpen: (file: string, line: number) => void;
}) {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState('');
  const [nodes, setNodes] = useState<Placed[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [palette, setPalette] = useState<Palette>(() => (isDarkPage() ? DARK_PALETTE : LIGHT_PALETTE));
  const width = useMemo(() => widthFor(nodes.length), [nodes.length]);
  const colourOf = useCallback((kind: string) => colourFor(palette, kind), [palette]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ id: string | null; x: number; y: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/workspace/labels?main=${encodeURIComponent(mainFile)}`)
      .then(r => r.json())
      .then((data: Graph) => {
        if (cancelled) return;
        setGraph(data);
        const placed = layout(data);
        settle(placed, data.edges);
        setNodes(placed);
      })
      .catch(e => !cancelled && setError(String(e)));
    return () => { cancelled = true; };
  }, [mainFile]);

  // The window can be open while the theme changes underneath it.
  useEffect(() => {
    const watch = new MutationObserver(() => setPalette(isDarkPage() ? DARK_PALETTE : LIGHT_PALETTE));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const at = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);
  const shown = hover ?? held;
  const detail = shown ? at.get(shown) : undefined;
  const hoverSection = detail?.section ?? null;

  // Labels arrive in document order, so a section is a contiguous run of them
  // and can be drawn as a band across the top. It is the difference between a
  // cloud of names and a map of the paper.
  const sections = useMemo(() => {
    const out: Array<{ name: string; from: number; to: number }> = [];
    for (const node of [...nodes].sort((a, b) => a.home - b.home)) {
      const last = out[out.length - 1];
      if (last && last.name === node.section) last.to = node.home;
      else out.push({ name: node.section, from: node.home, to: node.home });
    }
    return out.filter(band => band.name);
  }, [nodes]);
  const neighbours = useMemo(() => {
    if (!shown || !graph) return null;
    const near = new Set<string>([shown]);
    for (const e of graph.edges) {
      if (e.from === shown) near.add(e.to);
      if (e.to === shown) near.add(e.from);
    }
    return near;
  }, [shown, graph]);

  // Where every arrow runs. Only the labels' positions can change this, so
  // moving the pointer over the drawing does not rebuild any of it.
  const arcs = useMemo(() => {
    if (!graph) return [];
    const out: Array<{ key: string; d: string; width: number; from: string; to: string }> = [];
    graph.edges.forEach((edge, i) => {
      const a = at.get(edge.from);
      const b = at.get(edge.to);
      if (!a || !b) return;
      // A gentle arc, so two labels that refer to each other both ways do not
      // draw one line on top of the other.
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2 - Math.abs(a.x - b.x) * 0.12;
      out.push({
        key: `${edge.from}->${edge.to}-${i}`,
        d: `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`,
        width: Math.min(3, 0.8 + edge.uses * 0.5),
        from: edge.from,
        to: edge.to,
      });
    });
    return out;
  }, [graph, at]);

  const refersTo = graph && shown ? graph.edges.filter(e => e.from === shown).map(e => e.to) : [];
  const referredFrom = graph && shown ? graph.edges.filter(e => e.to === shown).map(e => e.from) : [];

  const query = search.trim().toLowerCase();
  const matches = useCallback((n: Label) =>
    !query || n.id.toLowerCase().includes(query) || n.section.toLowerCase().includes(query), [query]);

  // How far a pointer movement carries in the drawing's own units. Only the
  // size of the box matters, never where the view has been panned to: measuring
  // the movement against a view that the movement itself is changing makes the
  // pan chase its own tail, and the picture shakes instead of sliding.
  const perPixel = () => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return null;
    return { x: width / box.width, y: HEIGHT / box.height };
  };

  const onPointerDown = (e: React.PointerEvent, id: string | null) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    // Kept as the pointer's own coordinates, which nothing here can move.
    drag.current = { id, x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const held = drag.current;
    if (!held) return;
    const scale = perPixel();
    if (!scale) return;
    const dx = (e.clientX - held.x) * scale.x;
    const dy = (e.clientY - held.y) * scale.y;
    // Before the update, so the second handler this event reaches — it bubbles
    // from the label to the drawing — sees no movement left to apply.
    drag.current = { id: held.id, x: e.clientX, y: e.clientY };
    if (!dx && !dy) return;
    if (held.id) {
      // A label sits inside the zoom, so its own units are the panned ones
      // divided by it; the view's translation is outside and is not.
      setNodes(prev => prev.map(n => n.id === held.id
        ? { ...n, x: n.x + dx / view.k, y: n.y + dy / view.k, home: n.home + dx / view.k, pinned: true }
        : n));
    } else {
      setView(v => ({ ...v, x: v.x + dx, y: v.y + dy }));
    }
  };
  const onPointerUp = () => { drag.current = null; };

  const onWheel = (e: React.WheelEvent) => {
    const scale = perPixel();
    const box = svgRef.current?.getBoundingClientRect();
    if (!scale || !box) return;
    // Zoom about the pointer, so whatever you are looking at is what you get
    // more of. Scaling about the corner instead sends the label you were
    // reading off the side of the view.
    const at = { x: (e.clientX - box.left) * scale.x, y: (e.clientY - box.top) * scale.y };
    setView(v => {
      const k = Math.max(0.35, Math.min(3, v.k * (e.deltaY < 0 ? 1.12 : 0.89)));
      const held = k / v.k;
      return { k, x: at.x - (at.x - v.x) * held, y: at.y - (at.y - v.y) * held };
    });
  };

  // Sections are here to give the references somewhere to start from; they are
  // not labels, and "never referenced" is not a complaint about them.
  const unreferenced = graph?.nodes.filter(n => n.kind !== 'section' && n.referenced === 0) ?? [];
  const duplicated = graph?.nodes.filter(n => n.kind !== 'section' && n.defined > 1) ?? [];
  const labelCount = graph?.nodes.filter(n => n.kind !== 'section').length ?? 0;

  const chip: React.CSSProperties = {
    fontSize: '0.72rem', padding: '2px 8px', borderRadius: 10, cursor: 'pointer',
    border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-muted)',
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        style={{ width: '1180px', maxWidth: '96vw', height: '760px', maxHeight: '92vh', padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <strong style={{ fontSize: '0.95rem' }}>Label graph</strong>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            {graph
              ? `${labelCount} labels · ${graph.edges.length} references from ${graph.nodes.length - labelCount} sections · left to right is document order`
              : 'Reading the document…'}
          </span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Find a label or section…"
            style={{ marginLeft: 'auto', width: 230, padding: '5px 9px', fontSize: '0.8rem', borderRadius: 5, border: '1px solid var(--border-color)', background: 'var(--bg-color)', color: 'var(--text-main)' }}
          />
          <button onClick={() => setView({ x: 0, y: 0, k: 1 })} style={chip}>Reset view</button>
          <button onClick={onClose} style={{ ...chip, border: 'none', fontSize: '1.1rem', padding: '0 4px' }}>×</button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ flex: 1, minWidth: 0, position: 'relative', background: 'var(--bg-color)' }}>
            {error && <div style={{ padding: 20, color: '#f87171', fontSize: '0.85rem' }}>{error}</div>}
            <svg
              ref={svgRef}
              viewBox={`0 0 ${width} ${HEIGHT}`}
              style={{ width: '100%', height: '100%', cursor: drag.current?.id ? 'grabbing' : 'default', touchAction: 'none' }}
              onPointerDown={e => onPointerDown(e, null)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              onWheel={onWheel}
              onClick={e => { if (e.target === e.currentTarget) setHeld(null); }}
            >
              <defs>
                <marker id="lg-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-muted)" opacity="0.7" />
                </marker>
              </defs>
              <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
                {/* One line where each section begins. A paper has more of them
                    than there is room to name, so the name arrives on hover. */}
                {sections.map((band, i) => (
                  <line
                    key={`${band.name}-${i}`}
                    x1={band.from - 26} y1={12} x2={band.from - 26} y2={HEIGHT - 10}
                    stroke="var(--border-color)" strokeWidth={1} strokeDasharray="4 6"
                    opacity={hoverSection === band.name ? 0.9 : 0.4}
                  />
                ))}
                {arcs.map(arc => (
                  <path
                    key={arc.key}
                    d={arc.d}
                    fill="none"
                    stroke="var(--text-muted)"
                    strokeWidth={arc.width}
                    opacity={!neighbours || (neighbours.has(arc.from) && neighbours.has(arc.to)) ? 0.45 : 0.07}
                    markerEnd="url(#lg-arrow)"
                  />
                ))}
                {nodes.map(node => {
                  const lit = (!neighbours || neighbours.has(node.id)) && matches(node);
                  const isSection = node.kind === 'section';
                  const r = isSection ? 7 : 6 + Math.min(9, node.referenced * 1.6);
                  return (
                    <g
                      key={node.id}
                      transform={`translate(${node.x} ${node.y})`}
                      opacity={lit ? 1 : 0.12}
                      style={{ cursor: 'pointer' }}
                      onPointerDown={e => { e.stopPropagation(); onPointerDown(e, node.id); }}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerUp}
                      onMouseEnter={() => setHover(node.id)}
                      onMouseLeave={() => setHover(null)}
                      onClick={e => { e.stopPropagation(); setHeld(current => (current === node.id ? null : node.id)); }}
                      onDoubleClick={() => { onOpen(node.file, node.line); onClose(); }}
                    >
                      <title>{isSection
                        ? `${nameOf(node)}\n${node.file}:${node.line}\na section — references start here\ndouble-click to open`
                        : `${node.id}\n${node.section || node.file}\n${node.file}:${node.line}\nreferenced ${node.referenced} time${node.referenced === 1 ? '' : 's'}\ndouble-click to open`}</title>
                      {isSection ? (
                        <rect
                          x={-4} y={-11} width={8} height={22} rx={2}
                          fill={palette.section} fillOpacity={0.75} stroke={palette.section} strokeWidth={1}
                        />
                      ) : (
                        <circle
                          r={r}
                          fill={colourOf(node.kind)}
                          fillOpacity={node.referenced ? 0.9 : 0.25}
                          stroke={colourOf(node.kind)}
                          strokeWidth={node.defined > 1 ? 3 : 1.5}
                          strokeDasharray={node.referenced ? undefined : '3 2'}
                        />
                      )}
                      {(lit || !neighbours) && (
                      <text
                        x={node.x > width - 260 ? -(r + 6) : r + 6}
                        textAnchor={node.x > width - 260 ? 'end' : 'start'}
                        y={5}
                        fontSize={16}
                        fontWeight={500}
                        fill="var(--text-main, var(--text-color))"
                        stroke="var(--bg-color)"
                        strokeWidth={3.5}
                        paintOrder="stroke"
                        style={{ pointerEvents: 'none', userSelect: 'none' }}
                      >
                        {nameOf(node).length > 26 ? `${nameOf(node).slice(0, 25)}…` : nameOf(node)}
                      </text>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>

          <div style={{ width: 250, flex: '0 0 250px', borderLeft: '1px solid var(--border-color)', overflowY: 'auto', padding: '12px 14px', fontSize: '0.8rem' }}>
            {detail && (
              <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid var(--border-color)' }}>
                <div style={{ fontWeight: 600, color: colourOf(detail.kind), marginBottom: 3 }}>{nameOf(detail)}</div>
                {detail.kind !== 'section' && detail.section && (
                  <div style={{ color: 'var(--text-muted)', lineHeight: 1.45, marginBottom: 5 }}>{detail.section}</div>
                )}
                <div
                  onClick={() => { onOpen(detail.file, detail.line); onClose(); }}
                  style={{ color: 'var(--text-muted)', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
                >
                  {detail.file}:{detail.line}
                </div>
                {referredFrom.length > 0 && (
                  <div style={{ marginTop: 8, lineHeight: 1.5 }}>
                    <span style={{ color: 'var(--text-muted)' }}>referred to from </span>
                    {referredFrom.map(id => nameOf(at.get(id) ?? { kind: '', id })).join(' · ')}
                  </div>
                )}
                {refersTo.length > 0 && (
                  <div style={{ marginTop: 4, lineHeight: 1.5 }}>
                    <span style={{ color: 'var(--text-muted)' }}>refers to </span>
                    {refersTo.map(id => nameOf(at.get(id) ?? { kind: '', id })).join(' · ')}
                  </div>
                )}
                {detail.kind !== 'section' && referredFrom.length === 0 && (
                  <div style={{ marginTop: 8, color: 'var(--text-muted)' }}>Nothing refers to it.</div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
              {Object.entries(palette.kinds).filter(([k]) => graph?.nodes.some(n => n.kind === k)).map(([kind, colour]) => (
                <span key={kind} style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-muted)' }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: colour }} />{kind}
                </span>
              ))}
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-muted)' }}>
                <span style={{ width: 5, height: 12, borderRadius: 2, background: palette.section }} />section
              </span>
            </div>

            {graph && graph.missing.length > 0 && (
              <>
                <div style={{ fontWeight: 600, marginBottom: 6, color: '#f87171' }}>
                  Referenced but never defined
                </div>
                {graph.missing.map(m => (
                  <div key={m.id} onClick={() => { onOpen(m.file, m.line); onClose(); }}
                    style={{ padding: '3px 0', cursor: 'pointer', color: 'var(--text-color)' }}>
                    {m.id} <span style={{ color: 'var(--text-muted)' }}>· {m.file}:{m.line}</span>
                  </div>
                ))}
                <div style={{ height: 14 }} />
              </>
            )}

            {duplicated.length > 0 && (
              <>
                <div style={{ fontWeight: 600, marginBottom: 6, color: '#fbbf24' }}>Defined more than once</div>
                {duplicated.map(n => (
                  <div key={n.id} onClick={() => { onOpen(n.file, n.line); onClose(); }}
                    style={{ padding: '3px 0', cursor: 'pointer' }}>{n.id}</div>
                ))}
                <div style={{ height: 14 }} />
              </>
            )}

            <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-muted)' }}>
              Never referenced ({unreferenced.length})
            </div>
            {unreferenced.length === 0 && <div style={{ color: 'var(--text-muted)' }}>None — everything is used.</div>}
            {unreferenced.map(n => (
              <div key={n.id} onClick={() => { onOpen(n.file, n.line); onClose(); }}
                style={{ padding: '3px 0', cursor: 'pointer', color: 'var(--text-color)' }}
                title={`${n.file}:${n.line}`}>
                {n.id}
              </div>
            ))}

            <div style={{ marginTop: 16, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Hover a label to see where it sits and what it touches, click to keep
              it in view. Drag a label to move it, drag the background to pan,
              scroll to zoom in on whatever is under the pointer. Double-click a
              label to open it in the editor.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
