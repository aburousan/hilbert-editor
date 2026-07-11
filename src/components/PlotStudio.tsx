import React, { useState, useEffect } from 'react';
import { API } from '../api';

// One unified plot engine — replaces the four separate plot menu items with a
// single tool. Built-in modes generate cetz / cetz-plot code (2D functions, 2D
// data, 3D surface); the two heavy interactive tools (rotatable 3D studio,
// Python/matplotlib) are launched from here so everything lives under one roof.
type Mode = 'fn' | 'data' | 'surf' | 'interactive' | 'python';
type FnKind = 'explicit' | 'implicit' | 'parametric';
type DataKind = 'line' | 'scatter' | 'bar';

const MODES: { key: Mode; label: string }[] = [
  { key: 'fn', label: '2D Function' },
  { key: 'data', label: '2D Data' },
  { key: 'surf', label: '3D Surface' },
  { key: 'interactive', label: '3D Interactive' },
  { key: 'python', label: 'From Python' },
];

const CETZ = '#import "@preview/cetz:0.3.4"';
const PLOT = '#import "@preview/cetz-plot:0.1.1": plot';

export default function PlotStudio({ onClose, onInsert, onEnsureSetup, onOpenInteractive, onOpenPython }: {
  onClose: () => void;
  onInsert: (code: string) => void;
  // When provided, imports are hoisted to the top of the document (added once)
  // instead of being pasted inline at the cursor.
  onEnsureSetup?: (marker: string, block: string) => void;
  onOpenInteractive: () => void;
  onOpenPython: () => void;
}) {
  const [mode, setMode] = useState<Mode>('fn');
  // 2D function
  const [fnKind, setFnKind] = useState<FnKind>('explicit');
  const [funcExprs, setFuncExprs] = useState<string[]>(['calc.sin(x)']);  // one entry = one overlaid curve
  const [implicitExpr, setImplicitExpr] = useState('x*x + y*y - 1');
  const [paramX, setParamX] = useState('calc.cos(t) * t');
  const [paramY, setParamY] = useState('calc.sin(t) * t');
  const [domain, setDomain] = useState('-5, 5');
  const [derivative, setDerivative] = useState(false);  // also plot f'(x), numerically
  const [integral, setIntegral] = useState(false);      // shade the area under the first curve
  const [intA, setIntA] = useState('0');
  const [intB, setIntB] = useState('3');
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

  // Build the plot.plot(...) options, emitting only the ones the user set so an
  // unset value keeps cetz-plot's automatic behaviour.
  const plotCanvas = (preamble: string, body: string) => {
    const opts = [`size: (${width.trim() || '8'}, ${height.trim() || '6'})`];
    const bound = (key: string, v: string) => { const t = v.trim(); if (t) opts.push(`${key}: ${t}`); };
    bound('x-min', xMin); bound('x-max', xMax); bound('y-min', yMin); bound('y-max', yMax);
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
        const exprs = funcExprs.map(e => e.trim()).filter(Boolean);
        // A `let f(x)` is only needed when we reuse the function (derivative or
        // fill); otherwise the expression goes inline as before.
        const useLet = derivative || integral;
        if (derivative) preamble += '  let h = 1e-4\n';
        exprs.forEach((e, i) => {
          if (useLet) preamble += `  let f${i}(x) = ${e}\n`;
          const call = useLet ? `f${i}(x)` : e;
          body += `      plot.add(domain: (${domain}), x => ${call})\n`;
          if (derivative) body += `      plot.add(domain: (${domain}), x => (f${i}(x + h) - f${i}(x - h)) / (2 * h), style: (stroke: (dash: "dashed")))\n`;
        });
        if (integral && exprs.length) {
          body += `      plot.add(domain: (${intA.trim() || '0'}, ${intB.trim() || '1'}), x => f0(x), fill: true, style: (fill: rgb(40, 120, 220, 60), stroke: none))\n`;
        }
        if (!exprs.length) return null;
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
                  <span>Functions f(x) — each is one overlaid curve</span>
                  {funcExprs.map((ex, i) => (
                    <div key={i} className="form-row" style={{ gap: 6, marginTop: i ? 6 : 4 }}>
                      <input type="text" value={ex} placeholder="calc.sin(x)"
                        onChange={e => setFuncExprs(list => list.map((v, j) => (j === i ? e.target.value : v)))} />
                      {funcExprs.length > 1 && (
                        <button className="btn-ghost" title="Remove this curve" style={{ padding: '0 10px' }}
                          onClick={() => setFuncExprs(list => list.filter((_, j) => j !== i))}>×</button>
                      )}
                    </div>
                  ))}
                  <button className="btn-ghost" style={{ marginTop: 8 }} onClick={() => setFuncExprs(list => [...list, ''])}>+ Add curve</button>
                </div>
              )}
              {fnKind === 'implicit' && field('Expression f(x, y) — curve where f = 0', <input type="text" value={implicitExpr} onChange={e => setImplicitExpr(e.target.value)} placeholder="x*x + y*y - 1" />)}
              {fnKind === 'parametric' && (
                <div className="form-row">
                  {field('x(t)', <input type="text" value={paramX} onChange={e => setParamX(e.target.value)} />)}
                  {field('y(t)', <input type="text" value={paramY} onChange={e => setParamY(e.target.value)} />)}
                </div>
              )}
              {field(fnKind === 'parametric' ? 'Domain of t (min, max)' : 'Domain (min, max)', <input type="text" value={domain} onChange={e => setDomain(e.target.value)} placeholder="-5, 5" />)}

              {fnKind === 'explicit' && (
                <>
                  <label className="form-check">
                    <input type="checkbox" checked={derivative} onChange={e => setDerivative(e.target.checked)} />
                    Also plot the derivative f′(x) (numerical, dashed)
                  </label>
                  <label className="form-check">
                    <input type="checkbox" checked={integral} onChange={e => setIntegral(e.target.checked)} />
                    Shade the area under the first curve (integral)
                  </label>
                  {integral && (
                    <div className="form-row">
                      {field('Shade from x =', <input type="text" value={intA} onChange={e => setIntA(e.target.value)} placeholder="0" />)}
                      {field('to x =', <input type="text" value={intB} onChange={e => setIntB(e.target.value)} placeholder="3" />)}
                    </div>
                  )}
                </>
              )}
              <div className="form-hint">Uses <code>cetz-plot</code>. Use <code>calc.</code> functions, e.g. <code>calc.exp(x)</code>, <code>calc.pow(x, 2)</code>.</div>
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
              <div className="form-hint">A wireframe surface via <code>cetz</code>. For a shaded, rotatable surface use <b>3D Interactive</b> or <b>From Python</b>.</div>
            </>
          )}

          {mode === 'interactive' && (
            <div style={{ padding: '10px 2px' }}>
              <div className="form-hint" style={{ marginBottom: 12 }}>Rotate a real 3D surface to the exact angle you want, then insert that view as an image. Best for presentation-quality figures.</div>
              <button className="btn-primary" onClick={() => { onClose(); onOpenInteractive(); }}>Open 3D Interactive Studio →</button>
            </div>
          )}

          {mode === 'python' && (
            <div style={{ padding: '10px 2px' }}>
              <div className="form-hint" style={{ marginBottom: 12 }}>Full control with Python / matplotlib — surfaces, heatmaps, anything. Runs your code and drops the figure into the document.</div>
              <button className="btn-primary" onClick={() => { onClose(); onOpenPython(); }}>Open Python plot runner →</button>
            </div>
          )}

          {(mode === 'fn' || mode === 'data') && (
            <>
              <div className="form-row">
                {field('X-axis label', <input type="text" value={xlabel} onChange={e => setXlabel(e.target.value)} />)}
                {field('Y-axis label', <input type="text" value={ylabel} onChange={e => setYlabel(e.target.value)} />)}
              </div>
              <div className="form-field" style={{ display: 'block' }}>
                <span>Axis ranges — blank auto-fits (set x and y independently)</span>
                <div className="form-row" style={{ gap: 6, marginTop: 4 }}>
                  <input type="text" value={xMin} onChange={e => setXMin(e.target.value)} placeholder="x min" />
                  <input type="text" value={xMax} onChange={e => setXMax(e.target.value)} placeholder="x max" />
                  <input type="text" value={yMin} onChange={e => setYMin(e.target.value)} placeholder="y min" />
                  <input type="text" value={yMax} onChange={e => setYMax(e.target.value)} placeholder="y max" />
                </div>
              </div>
              <div className="form-field" style={{ display: 'block' }}>
                <span>Axis appearance — size, tick spacing, decimals (blank = auto)</span>
                <div className="form-row" style={{ gap: 6, marginTop: 4 }}>
                  <input type="text" value={width} onChange={e => setWidth(e.target.value)} placeholder="width" title="Plot width" />
                  <input type="text" value={height} onChange={e => setHeight(e.target.value)} placeholder="height" title="Plot height" />
                  <input type="text" value={xTick} onChange={e => setXTick(e.target.value)} placeholder="x step" title="Gap between x tick marks" />
                  <input type="text" value={yTick} onChange={e => setYTick(e.target.value)} placeholder="y step" title="Gap between y tick marks" />
                  <input type="text" value={decimals} onChange={e => setDecimals(e.target.value)} placeholder="decimals" title="Decimal places on tick labels" />
                </div>
                <div className="form-hint" style={{ marginTop: 4 }}>If tick numbers crowd together, set a tick step (e.g. <code>1</code>) and decimals (e.g. <code>1</code>).</div>
              </div>
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
            <div style={{ flex: '1 1 42%', minWidth: 0, borderLeft: '1px solid var(--border-color)', padding: '16px', display: 'flex', flexDirection: 'column' }}>
              <div className="dropdown-header" style={{ padding: 0, marginBottom: 8, fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', opacity: 0.6 }}>Live preview</div>
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
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          {canInsert && <button className="btn-primary" onClick={doInsert}>Insert</button>}
        </div>
      </div>
    </div>
  );
}
