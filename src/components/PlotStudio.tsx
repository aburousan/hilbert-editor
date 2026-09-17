import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { API } from '../api';
import { compileExpr } from '../plotExpr';
import PlotCanvas, { clipRun, fitY, sampleCurve, type Curve as DrawnCurve, type View } from './PlotCanvas';
import { derivativeOf } from '../plotSampling';

// One unified plot engine — replaces the four separate plot menu items with a
// single tool. Built-in modes generate cetz / cetz-plot code (2D functions, 2D
// data, 3D surface); the two heavy interactive tools (rotatable 3D studio,
// rotatable 3D view) is launched from here so everything lives under one roof.
// Plotting through Python or Julia is not one of these: a notebook cell already
// runs the code and drops the figure in, and a second way in led to two places
// to look for the same thing.
type Mode = 'fn' | 'data' | 'surf' | 'interactive';
type FnKind = 'explicit' | 'implicit' | 'parametric';
type DataKind = 'line' | 'scatter' | 'bar';

const MODES: { key: Mode; label: string }[] = [
  { key: 'fn', label: '2D Function' },
  { key: 'data', label: '2D Data' },
  { key: 'surf', label: '3D Surface' },
  { key: 'interactive', label: '3D Interactive' },
];

const CETZ = '#import "@preview/cetz:0.3.4"';
const PLOT = '#import "@preview/cetz-plot:0.1.1": plot';

// Enough of them that six curves on one pair of axes stay apart, and dark
// enough to print.
const CURVE_COLOURS = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2', '#be123c', '#4d7c0f'];

type ExprCurve = {
  id: number;
  expr: string;
  colour: string;
  visible: boolean;
  dash: 'solid' | 'dashed' | 'dotted';
  axis: 'left' | 'right';
  derivative: boolean;
  fill: 'none' | 'solid' | 'hatch' | 'cross';
  fillFrom: string;
  fillTo: string;
};
const newCurve = (id: number, colour: string, expr = ''): ExprCurve =>
  ({ id, expr, colour, visible: true, dash: 'solid', axis: 'left', derivative: false, fill: 'none', fillFrom: '', fillTo: '' });
let nextCurveId = 1;

export default function PlotStudio({ onClose, onInsert, onEnsureSetup, onOpenInteractive }: {
  onClose: () => void;
  onInsert: (code: string) => void;
  // When provided, imports are hoisted to the top of the document (added once)
  // instead of being pasted inline at the cursor.
  onEnsureSetup?: (marker: string, block: string) => void;
  onOpenInteractive: () => void;
}) {
  const [mode, setMode] = useState<Mode>('fn');
  // 2D function
  const [fnKind, setFnKind] = useState<FnKind>('explicit');
  // One row of the expression list = one curve on the axes.
  const [curves, setCurves] = useState<ExprCurve[]>([newCurve(0, CURVE_COLOURS[0], 'sin(x)')]);
  // The right-hand axis has its own range, for a curve on a different scale.
  const [rightView, setRightView] = useState<{ yMin: number; yMax: number }>({ yMin: -2.2, yMax: 2.2 });
  const [rightLabel, setRightLabel] = useState('');
  // Which curve's own settings are open.
  const [openCurve, setOpenCurve] = useState<number | null>(null);
  // What the canvas is showing; the axes in the document use the same numbers.
  const [view, setView] = useState<View>({ xMin: -6.3, xMax: 6.3, yMin: -2.2, yMax: 2.2 });
  // Whether the document gets the formula or the points the canvas drew.
  const [emit, setEmit] = useState<'formula' | 'points'>('formula');
  const [implicitExpr, setImplicitExpr] = useState('x*x + y*y - 1');
  const [paramX, setParamX] = useState('calc.cos(t) * t');
  const [paramY, setParamY] = useState('calc.sin(t) * t');
  const [domain, setDomain] = useState('-5, 5');
  // 2D data
  const [dataKind, setDataKind] = useState<DataKind>('line');
  const [dataPoints, setDataPoints] = useState('0, 0\n1, 1\n2, 4\n3, 9\n4, 16');
  // 3D surface
  const [surfExpr, setSurfExpr] = useState('calc.sin(calc.sqrt(x*x + y*y))');
  const [surfRange, setSurfRange] = useState('4');
  // common
  const [xlabel, setXlabel] = useState('x');
  const [ylabel, setYlabel] = useState('y');
  // Axis ranges — blank means let cetz-plot auto-fit that bound (the old behaviour).
  const [xMin, setXMin] = useState('');
  const [xMax, setXMax] = useState('');
  const [yMin, setYMin] = useState('');
  const [yMax, setYMax] = useState('');
  // Axis appearance.
  const [width, setWidth] = useState('8');
  const [height, setHeight] = useState('6');
  const [xTick, setXTick] = useState('');   // gap between x tick marks (blank = auto)
  const [yTick, setYTick] = useState('');
  const [decimals, setDecimals] = useState('');  // decimal places on tick labels
  const [asFigure, setAsFigure] = useState(true);
  const [caption, setCaption] = useState('Plot');
  const [label, setLabel] = useState('');

  const field = (lab: string, el: React.ReactNode) => (
    <label className="form-field"><span>{lab}</span>{el}</label>
  );

  // The shortest text that reads back as the same number, so two bounds a hair
  // apart stay apart however large they are. Typst reads the same forms as
  // JavaScript writes, exponents included.
  const round = (n: number) => String(n);

  // Each row read once: the Typst it becomes, the function that draws it, or
  // why it could not be read.
  const compiled = useMemo(() => curves.map(c => {
    const trimmed = c.expr.trim();
    if (!trimmed) return { ...c, typst: '', fn: null as ((x: number) => number) | null, error: '' };
    const built = compileExpr(trimmed, ['x']);
    return built.ok
      ? { ...c, typst: built.typst, fn: built.fn as (x: number) => number, error: '' }
      : { ...c, typst: '', fn: null as ((x: number) => number) | null, error: built.error };
  }), [curves]);

  const number = (text: string, fallback: number) => { const n = Number(text); return text.trim() && Number.isFinite(n) ? n : fallback; };
  const drawnCurves: DrawnCurve[] = compiled.map(c => ({
    id: c.id, fn: c.fn, colour: c.colour, visible: c.visible,
    dash: c.dash, axis: c.axis, derivative: c.derivative,
    fill: c.fill, fillFrom: number(c.fillFrom, view.xMin), fillTo: number(c.fillTo, view.xMax),
  }));
  const anyRight = compiled.some(c => c.visible && c.axis === 'right' && c.typst);

  const patchCurve = (id: number, patch: Partial<ExprCurve>) =>
    setCurves(list => list.map(c => (c.id === id ? { ...c, ...patch } : c)));
  const addCurve = () => setCurves(list => [...list, newCurve(nextCurveId++, CURVE_COLOURS[list.length % CURVE_COLOURS.length])]);
  // Half-typed bounds, kept as text until they are a number again.
  const [typing, setTyping] = useState<Partial<Record<keyof View, string>>>({});
  const onView = useCallback((v: View) => { setTyping({}); setView(v); }, []);

  // Build the plot.plot(...) options, emitting only the ones the user set so an
  // unset value keeps cetz-plot's automatic behaviour.
  const plotCanvas = (preamble: string, body: string) => {
    const opts = [`size: (${width.trim() || '8'}, ${height.trim() || '6'})`];
    const bound = (key: string, v: string) => { const t = v.trim(); if (t) opts.push(`${key}: ${t}`); };
    if (mode === 'fn' && fnKind === 'explicit') {
      // The axes hold what the canvas is showing, so the figure is the picture
      // that was dragged into place.
      opts.push(`x-min: ${round(view.xMin)}`, `x-max: ${round(view.xMax)}`, `y-min: ${round(view.yMin)}`, `y-max: ${round(view.yMax)}`);
      if (anyRight) {
        // A second scale on the right: cetz-plot draws all four sides for it.
        opts.push('axis-style: "scientific"', `y2-min: ${round(rightView.yMin)}`, `y2-max: ${round(rightView.yMax)}`);
        if (rightLabel.trim()) opts.push(`y2-label: [${rightLabel.trim()}]`);
      }
    } else {
      bound('x-min', xMin); bound('x-max', xMax); bound('y-min', yMin); bound('y-max', yMax);
    }
    bound('x-tick-step', xTick); bound('y-tick-step', yTick);
    bound('x-decimals', decimals); bound('y-decimals', decimals);
    opts.push(`x-label: [${xlabel}]`, `y-label: [${ylabel}]`);
    return `cetz.canvas({\n${preamble}  plot.plot(${opts.join(', ')},\n    {\n${body}    })\n})`;
  };

  // Turn the current form into { imports, canvas }. Shared by Insert and the
  // live preview so they can never drift apart.
  const build = (): { importLines: string[]; canvas: string } | null => {
    if (mode === 'fn') {
      let preamble = '';
      let body = '';
      if (fnKind === 'explicit') {
        const drawn = compiled.filter(c => c.visible && c.typst);
        if (!drawn.length) return null;
        const span = `(${round(view.xMin)}, ${round(view.xMax)})`;
        const DASHES: Record<string, string> = { solid: '', dashed: ', dash: "dashed"', dotted: ', dash: "dotted"' };
        const stroke = (c: typeof drawn[number], dash = DASHES[c.dash]) =>
          `stroke: (paint: rgb("${c.colour}"), thickness: 1.2pt${dash})`;
        const onAxis = (c: typeof drawn[number]) => (c.axis === 'right' ? ', axes: ("x", "y2")' : '');
        drawn.forEach((c, i) => {
          preamble += `  let f${i}(x) = ${c.typst}\n`;
          if (c.derivative) preamble += `  let d${i}(x) = (f${i}(x + 1e-4) - f${i}(x - 1e-4)) / 2e-4\n`;

          // The formula is the nicer thing to keep in a document, but it only
          // works when the function is defined and unbroken across the whole
          // width: `sqrt(x)` through zero, or a pole, would stop the compile or
          // draw a line where the canvas shows a gap. Those curves are written
          // as the points the canvas drew instead.
          const scale = c.axis === 'right' ? { ...view, yMin: rightView.yMin, yMax: rightView.yMax } : view;
          const asPoints = (fn: (x: number) => number, colour: string, dash: string, axis: string) => {
            for (const run of sampleCurve(fn, scale, 420)) {
              for (const piece of clipRun(run, scale)) {
                const pts = piece.map(p => `(${round(p.x)}, ${round(p.y)})`);
                if (pts.length > 1) body += `      plot.add((${pts.join(', ')}), style: (${colour}${dash})${axis})\n`;
              }
            }
          };
          const unbroken = (fn: ((x: number) => number) | null) => {
            if (!fn) return false;
            const runs = sampleCurve(fn, scale, 420);
            return runs.length === 1 && runs[0][0].x <= view.xMin + 1e-9;
          };

          if (emit === 'points' || !unbroken(c.fn)) {
            asPoints(c.fn!, `paint: rgb("${c.colour}"), thickness: 1.2pt`, DASHES[c.dash], onAxis(c));
          } else {
            body += `      plot.add(domain: ${span}, samples: 400, style: (${stroke(c)})${onAxis(c)}, x => f${i}(x))\n`;
          }
          if (c.derivative && c.fn) {
            const slope = derivativeOf(c.fn, view);
            if (emit === 'points' || !unbroken(slope)) {
              asPoints(slope, `paint: rgb("${c.colour}"), thickness: 1pt`, ', dash: "dashed"', onAxis(c));
            } else {
              body += `      plot.add(domain: ${span}, samples: 400, style: (stroke: (paint: rgb("${c.colour}"), thickness: 1pt, dash: "dashed"))${onAxis(c)}, x => d${i}(x))\n`;
            }
          }
          if (c.fill !== 'none') {
            const from = round(Math.max(view.xMin, number(c.fillFrom, view.xMin)));
            const to = round(Math.min(view.xMax, number(c.fillTo, view.xMax)));
            // A wash of colour, or ruled lines for print and for anyone who
            // cannot tell the colours apart.
            const paint = c.fill === 'solid'
              ? `rgb("${c.colour}").transparentize(78%)`
              : `tiling(size: (6pt, 6pt))[#place(line(start: (0%, 100%), end: (100%, 0%), stroke: 0.5pt + rgb("${c.colour}")))${c.fill === 'cross' ? `#place(line(start: (0%, 0%), end: (100%, 100%), stroke: 0.5pt + rgb("${c.colour}")))` : ''}]`;
            body += `      plot.add(domain: (${from}, ${to}), samples: 200, fill: true, style: (fill: ${paint}, stroke: none)${onAxis(c)}, x => f${i}(x))\n`;
          }
        });
      } else if (fnKind === 'implicit') {
        const [a, b] = domain.split(',').map(s => s.trim());
        body = `      plot.add-contour(\n        x-domain: (${a}, ${b}), y-domain: (${a}, ${b}),\n        z: (0,), op: "<",\n        (x, y) => ${implicitExpr})\n`;
      } else {
        body = `      plot.add(domain: (${domain}), t => (${paramX}, ${paramY}))\n`;
      }
      return { importLines: [CETZ, PLOT], canvas: plotCanvas(preamble, body) };
    }
    if (mode === 'data') {
      const pts = dataPoints.split('\n').map(l => l.trim()).filter(Boolean).map(l => `(${l})`).join(', ');
      if (!pts) return null;
      const data = `(${pts})`;
      let add: string;
      if (dataKind === 'scatter') add = `      plot.add(${data}, mark: "o", mark-size: .18, style: (stroke: none))\n`;
      else if (dataKind === 'bar') add = `      plot.add-bar(${data}, bar-width: .6)\n`;
      else add = `      plot.add(${data})\n`;
      return { importLines: [CETZ, PLOT], canvas: plotCanvas('', add) };
    }
    if (mode === 'surf') {
      const R = Math.abs(parseFloat(surfRange)) || 4;
      const s = (2 * R / 16).toFixed(3);
      const canvas = `cetz.canvas({
    import cetz.draw: *
    rotate(x: 70deg, z: 30deg)
    let f(x, y) = ${surfExpr}
    let n = 16
    let s = ${s}
    for i in range(n) {
      for j in range(n) {
        let x = (i - n/2)*s
        let y = (j - n/2)*s
        let x2 = (i + 1 - n/2)*s
        let y2 = (j + 1 - n/2)*s
        if i < n - 1 { line((x, y, f(x, y)), (x2, y, f(x2, y)), stroke: blue.darken(10%)) }
        if j < n - 1 { line((x, y, f(x, y)), (x, y2, f(x, y2)), stroke: blue.darken(10%)) }
      }
    }
  })`;
      return { importLines: [CETZ], canvas };
    }
    return null;
  };

  const markerOf = (line: string) => line.match(/"([^"]+)"/)?.[1] ?? line;

  const wrap = (importLines: string[], canvas: string) => {
    const tag = label.trim() ? ` <fig:${label.trim()}>` : '';
    const inner = asFigure
      ? `#figure(\n  ${canvas},\n  caption: [${caption}],\n)${tag}`
      : `#align(center)[\n  #${canvas}\n]`;
    if (onEnsureSetup) {
      importLines.forEach(line => onEnsureSetup(markerOf(line), line));
      onInsert('\n' + inner + '\n\n');
    } else {
      onInsert('\n' + importLines.join('\n') + '\n' + inner + '\n\n');
    }
    onClose();
  };

  const canInsert = mode === 'fn' || mode === 'data' || mode === 'surf';
  const doInsert = () => { const b = build(); if (b) wrap(b.importLines, b.canvas); };

  // ---- Live preview -------------------------------------------------------
  const previewDoc = (() => {
    if (!canInsert) return '';
    const b = build();
    if (!b) return '';
    return b.importLines.join('\n') + '\n#set page(width: auto, height: auto, margin: 8pt)\n#' + b.canvas + '\n';
  })();

  const [preview, setPreview] = useState<{ state: 'idle' | 'loading' | 'error'; url?: string }>({ state: 'idle' });

  useEffect(() => {
    if (!previewDoc) { setPreview({ state: 'idle' }); return; }
    let cancelled = false;
    setPreview(p => ({ ...p, state: 'loading' }));
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`${API}/template/render-preview`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entry: 'p.typ', files: [{ path: 'p.typ', content: previewDoc }] }),
        });
        if (cancelled) return;
        if (!res.ok) { setPreview({ state: 'error' }); return; }
        const blob = await res.blob();
        if (cancelled) return;
        setPreview({ state: 'idle', url: URL.createObjectURL(blob) });
      } catch { if (!cancelled) setPreview({ state: 'error' }); }
    }, 450);
    return () => { cancelled = true; clearTimeout(id); };
  }, [previewDoc]);

  // Revoke the previous blob URL so quick edits don't pile up PNGs in memory.
  useEffect(() => () => { if (preview.url) URL.revokeObjectURL(preview.url); }, [preview.url]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '920px', maxWidth: '95vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Plot Studio</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div style={{ display: 'flex', gap: 16, minHeight: 0 }}>
          <div className="modal-body" style={{ flex: canInsert ? '1 1 58%' : '1 1 100%', minWidth: 0 }}>
          <div className="seg" style={{ flexWrap: 'wrap' }}>
            {MODES.map(m => (
              <button key={m.key} className={mode === m.key ? 'active' : ''} onClick={() => setMode(m.key)}>{m.label}</button>
            ))}
          </div>

          {mode === 'fn' && (
            <>
              {field('Kind', (
                <div className="seg">
                  {(['explicit', 'implicit', 'parametric'] as FnKind[]).map(k => (
                    <button key={k} className={fnKind === k ? 'active' : ''} onClick={() => setFnKind(k)}>
                      {k === 'explicit' ? 'y = f(x)' : k === 'implicit' ? 'f(x,y) = 0' : 'Parametric'}
                    </button>
                  ))}
                </div>
              ))}
              {fnKind === 'explicit' && (
                <div className="form-field" style={{ display: 'block' }}>
                  <span>Curves — one line each, as you would write them</span>
                  {compiled.map((c, i) => (
                    <div key={c.id} style={{ marginTop: i ? 8 : 6 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ position: 'relative', width: 18, height: 18, flex: 'none' }} title="Colour of this curve">
                          <span style={{ display: 'block', width: 14, height: 14, margin: 2, borderRadius: 4, background: c.colour, opacity: c.visible ? 1 : 0.3 }} />
                          <input type="color" value={c.colour} onChange={e => patchCurve(c.id, { colour: e.target.value })}
                            style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
                        </span>
                        <input type="text" value={c.expr} placeholder="sin(x)"
                          onChange={e => patchCurve(c.id, { expr: e.target.value })}
                          style={{ flex: 1, fontFamily: 'ui-monospace, SFMono-Regular, monospace', opacity: c.visible ? 1 : 0.5 }} />
                        <button className="btn-ghost" style={{ padding: '0 8px' }} title={c.visible ? 'Hide this curve' : 'Show this curve'}
                          onClick={() => patchCurve(c.id, { visible: !c.visible })}>{c.visible ? '◉' : '○'}</button>
                        <button className="btn-ghost" style={{ padding: '0 8px' }} title="Line, axis, derivative, shading"
                          onClick={() => setOpenCurve(openCurve === c.id ? null : c.id)}>⋯</button>
                        {compiled.length > 1 && (
                          <button className="btn-ghost" title="Remove this curve" style={{ padding: '0 8px' }}
                            onClick={() => setCurves(list => list.filter(x => x.id !== c.id))}>×</button>
                        )}
                      </div>
                      {c.error && <div style={{ fontSize: '0.74rem', color: '#b45309', marginLeft: 26, marginTop: 3 }}>{c.error}</div>}
                      {openCurve === c.id && (
                        <div style={{ marginLeft: 26, marginTop: 6, padding: '8px 10px', borderLeft: `2px solid ${c.colour}`, display: 'flex', flexDirection: 'column', gap: 7 }}>
                          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.8rem' }}>
                            <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                              Line
                              <select value={c.dash} onChange={e => patchCurve(c.id, { dash: e.target.value as ExprCurve['dash'] })}>
                                <option value="solid">solid</option>
                                <option value="dashed">dashed</option>
                                <option value="dotted">dotted</option>
                              </select>
                            </label>
                            <label style={{ display: 'flex', gap: 5, alignItems: 'center' }} title="Measure this curve against the left or the right-hand scale">
                              Scale
                              <select value={c.axis} onChange={e => patchCurve(c.id, { axis: e.target.value as ExprCurve['axis'] })}>
                                <option value="left">left axis</option>
                                <option value="right">right axis</option>
                              </select>
                            </label>
                            <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                              <input type="checkbox" checked={c.derivative} onChange={e => patchCurve(c.id, { derivative: e.target.checked })} />
                              also f′(x)
                            </label>
                          </div>
                          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.8rem' }}>
                            <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                              Area beneath
                              <select value={c.fill} onChange={e => patchCurve(c.id, { fill: e.target.value as ExprCurve['fill'] })}>
                                <option value="none">nothing</option>
                                <option value="solid">shaded</option>
                                <option value="hatch">hatched</option>
                                <option value="cross">cross-hatched</option>
                              </select>
                            </label>
                            {c.fill !== 'none' && (
                              <>
                                <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                                  from
                                  <input type="text" value={c.fillFrom} placeholder={round(view.xMin)} style={{ width: 66 }}
                                    onChange={e => patchCurve(c.id, { fillFrom: e.target.value })} />
                                </label>
                                <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                                  to
                                  <input type="text" value={c.fillTo} placeholder={round(view.xMax)} style={{ width: 66 }}
                                    onChange={e => patchCurve(c.id, { fillTo: e.target.value })} />
                                </label>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                  <button className="btn-ghost" style={{ marginTop: 8 }} onClick={addCurve}>+ Add curve</button>
                </div>
              )}
              {fnKind === 'implicit' && field('Expression f(x, y) — curve where f = 0', <input type="text" value={implicitExpr} onChange={e => setImplicitExpr(e.target.value)} placeholder="x*x + y*y - 1" />)}
              {fnKind === 'parametric' && (
                <div className="form-row">
                  {field('x(t)', <input type="text" value={paramX} onChange={e => setParamX(e.target.value)} />)}
                  {field('y(t)', <input type="text" value={paramY} onChange={e => setParamY(e.target.value)} />)}
                </div>
              )}
              {fnKind !== 'explicit' && field(fnKind === 'parametric' ? 'Domain of t (min, max)' : 'Domain (min, max)', <input type="text" value={domain} onChange={e => setDomain(e.target.value)} placeholder="-5, 5" />)}

              {fnKind === 'explicit' && anyRight && (
                <div className="form-field" style={{ display: 'block' }}>
                  <span>Right-hand scale — for the curves measured against it</span>
                  <div className="form-row" style={{ gap: 6, marginTop: 4 }}>
                    <input type="text" value={String(rightView.yMin)} placeholder="min"
                      onChange={e => { const n = Number(e.target.value); if (e.target.value.trim() && Number.isFinite(n)) setRightView(r => ({ ...r, yMin: n })); }} />
                    <input type="text" value={String(rightView.yMax)} placeholder="max"
                      onChange={e => { const n = Number(e.target.value); if (e.target.value.trim() && Number.isFinite(n)) setRightView(r => ({ ...r, yMax: n })); }} />
                    <input type="text" value={rightLabel} placeholder="label" onChange={e => setRightLabel(e.target.value)} />
                    <button className="btn-ghost" onClick={() => {
                      const onRight = drawnCurves.filter(c => c.axis === 'right');
                      const fitted = fitY(onRight, { ...view, yMin: rightView.yMin, yMax: rightView.yMax });
                      setRightView({ yMin: fitted.yMin, yMax: fitted.yMax });
                    }}>Fit</button>
                  </div>
                </div>
              )}
              <div className="form-hint">
                {fnKind === 'explicit'
                  ? <>Write it as you would on paper: <code>sin(x)</code>, <code>x^2</code>, <code>2x</code>, <code>exp(-x^2/2)</code>. <code>log</code> is base ten, <code>ln</code> natural, angles in radians. Typst's own <code>calc.sin(x)</code> works too.</>
                  : <>Uses <code>cetz-plot</code>. Use <code>calc.</code> functions, e.g. <code>calc.exp(x)</code>, <code>calc.pow(x, 2)</code>.</>}
              </div>
            </>
          )}

          {mode === 'data' && (
            <>
              {field('Chart type', (
                <div className="seg">
                  {(['line', 'scatter', 'bar'] as DataKind[]).map(k => (
                    <button key={k} className={dataKind === k ? 'active' : ''} onClick={() => setDataKind(k)}>{k.charAt(0).toUpperCase() + k.slice(1)}</button>
                  ))}
                </div>
              ))}
              {field('Data points — one "x, y" per line', (
                <textarea rows={6} value={dataPoints} onChange={e => setDataPoints(e.target.value)} style={{ fontFamily: 'monospace', resize: 'vertical' }} />
              ))}
            </>
          )}

          {mode === 'surf' && (
            <>
              {field('z = f(x, y)', <input type="text" value={surfExpr} onChange={e => setSurfExpr(e.target.value)} placeholder="calc.sin(calc.sqrt(x*x + y*y))" />)}
              {field('Range (± on x and y)', <input type="text" value={surfRange} onChange={e => setSurfRange(e.target.value)} placeholder="4" />)}
              <div className="form-hint">A wireframe surface via <code>cetz</code>. For a shaded, rotatable surface use <b>3D Interactive</b>; for anything beyond that, run the plot in a Python or Julia cell and insert the figure it produces.</div>
            </>
          )}

          {mode === 'interactive' && (
            <div style={{ padding: '10px 2px' }}>
              <div className="form-hint" style={{ marginBottom: 12 }}>Rotate a real 3D surface to the exact angle you want, then insert that view as an image. Best for presentation-quality figures.</div>
              <button className="btn-primary" onClick={() => { onClose(); onOpenInteractive(); }}>Open 3D Interactive Studio →</button>
            </div>
          )}

          {(mode === 'fn' || mode === 'data') && (
            <>
              <div className="form-row">
                {field('X-axis label', <input type="text" value={xlabel} onChange={e => setXlabel(e.target.value)} />)}
                {field('Y-axis label', <input type="text" value={ylabel} onChange={e => setYlabel(e.target.value)} />)}
              </div>
              {mode === 'fn' && fnKind === 'explicit' ? (
                <div className="form-field" style={{ display: 'block' }}>
                  <span>Axis ranges — these follow the graph, and the graph follows these</span>
                  <div className="form-row" style={{ gap: 6, marginTop: 4 }}>
                    {([['xMin', 'x min'], ['xMax', 'x max'], ['yMin', 'y min'], ['yMax', 'y max']] as const).map(([key, place]) => (
                      <input key={key} type="text" placeholder={place}
                        value={typing[key] ?? round(view[key])}
                        onChange={e => {
                          const text = e.target.value;
                          setTyping(t => ({ ...t, [key]: text }));
                          const n = Number(text);
                          // A lone “-” or a trailing point is someone mid-way
                          // through a number, so the graph waits for the rest.
                          if (text.trim() && Number.isFinite(n)) setView({ ...view, [key]: n });
                        }}
                        onBlur={() => setTyping(t => ({ ...t, [key]: undefined }))} />
                    ))}
                  </div>
                  <div className="form-hint" style={{ marginTop: 5 }}>
                    Or move the graph itself — the two stay in step.
                  </div>
                </div>
              ) : (
                <div className="form-field" style={{ display: 'block' }}>
                  <span>Axis ranges — blank auto-fits (set x and y independently)</span>
                  <div className="form-row" style={{ gap: 6, marginTop: 4 }}>
                    <input type="text" value={xMin} onChange={e => setXMin(e.target.value)} placeholder="x min" />
                    <input type="text" value={xMax} onChange={e => setXMax(e.target.value)} placeholder="x max" />
                    <input type="text" value={yMin} onChange={e => setYMin(e.target.value)} placeholder="y min" />
                    <input type="text" value={yMax} onChange={e => setYMax(e.target.value)} placeholder="y max" />
                  </div>
                </div>
              )}
              <details style={{ margin: '4px 0 2px' }}>
                <summary style={{ cursor: 'pointer', fontSize: '0.82rem', color: 'var(--text-muted)', padding: '4px 0' }}>Size, tick spacing and decimals</summary>
                <div className="form-row" style={{ gap: 6, marginTop: 6 }}>
                  <input type="text" value={width} onChange={e => setWidth(e.target.value)} placeholder="width" title="Plot width" />
                  <input type="text" value={height} onChange={e => setHeight(e.target.value)} placeholder="height" title="Plot height" />
                  <input type="text" value={xTick} onChange={e => setXTick(e.target.value)} placeholder="x step" title="Gap between x tick marks" />
                  <input type="text" value={yTick} onChange={e => setYTick(e.target.value)} placeholder="y step" title="Gap between y tick marks" />
                  <input type="text" value={decimals} onChange={e => setDecimals(e.target.value)} placeholder="decimals" title="Decimal places on tick labels" />
                </div>
                <div className="form-hint" style={{ marginTop: 4 }}>If tick numbers crowd together, set a tick step (e.g. <code>1</code>) and decimals (e.g. <code>1</code>).</div>
              </details>
            </>
          )}

          {canInsert && (
            <>
              <label className="form-check">
                <input type="checkbox" checked={asFigure} onChange={e => setAsFigure(e.target.checked)} />
                Wrap in a numbered figure (adds “Figure N” + caption)
              </label>
              {asFigure && (
                <div className="form-row">
                  {field('Caption', <input type="text" value={caption} onChange={e => setCaption(e.target.value)} />)}
                  {field('Label (optional)', <input type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="plot1 → @fig:plot1" />)}
                </div>
              )}
            </>
          )}
          </div>

          {canInsert && (
            <div style={{ flex: '1 1 46%', minWidth: 0, borderLeft: '1px solid var(--border-color)', padding: '16px', display: 'flex', flexDirection: 'column' }}>
              {mode === 'fn' && fnKind === 'explicit' && (
                <>
                  <div style={{ border: '1px solid var(--border-color)', borderRadius: 6, padding: 4 }}>
                    <PlotCanvas curves={drawnCurves} view={view} rightView={anyRight ? { ...view, ...rightView } : null}
                      onView={onView} height={320} xLabel={xlabel} yLabel={ylabel} rightLabel={rightLabel} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '7px 2px 16px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                    <span style={{ whiteSpace: 'nowrap' }}>Drag to move, scroll to zoom, double-click to reset.</span>
                    <button className="btn-ghost" style={{ marginLeft: 'auto', padding: '2px 10px', fontSize: '0.78rem', whiteSpace: 'nowrap' }}
                      onClick={() => setView(fitY(drawnCurves, view))}>Fit</button>
                  </div>
                </>
              )}
              <div className="dropdown-header" style={{ padding: 0, marginBottom: 8, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.6 }}>
                {mode === 'fn' && fnKind === 'explicit' ? 'As it will print' : 'Live preview'}
              </div>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 260, background: 'var(--bg-secondary, rgba(127,127,127,0.06))', borderRadius: 6, overflow: 'auto', padding: 8 }}>
                {preview.state === 'error' ? (
                  <div className="empty-state" style={{ textAlign: 'center', fontSize: 12 }}>Couldn’t render — check the expression, domain, and that ranges are numbers.</div>
                ) : preview.url ? (
                  <img src={preview.url} alt="plot preview" style={{ maxWidth: '100%', maxHeight: 360, opacity: preview.state === 'loading' ? 0.5 : 1, transition: 'opacity 0.15s' }} />
                ) : preview.state === 'loading' ? (
                  <div className="empty-state" style={{ fontSize: 12 }}><div className="spinner" /> Rendering…</div>
                ) : (
                  <div className="empty-state" style={{ fontSize: 12 }}>Preview appears here.</div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          {mode === 'fn' && fnKind === 'explicit' && (
            <label style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.82rem', color: 'var(--text-muted)' }}>
              Put in the document
              <select value={emit} onChange={e => setEmit(e.target.value as 'formula' | 'points')} style={{ fontSize: '0.82rem' }}>
                <option value="formula">the formula, to edit later</option>
                <option value="points">the points, exactly as drawn</option>
              </select>
            </label>
          )}
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          {canInsert && <button className="btn-primary" onClick={doInsert}>Insert</button>}
        </div>
      </div>
    </div>
  );
}
