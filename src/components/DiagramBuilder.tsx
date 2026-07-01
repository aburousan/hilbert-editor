import React, { useState } from 'react';

type Tab = 'primitives' | 'grid' | 'plot' | 'combination';
type PlotKind = 'explicit' | 'implicit' | 'parametric';

export default function DiagramBuilder({ onClose, onInsert }: { onClose: () => void, onInsert: (code: string) => void }) {
  const [tab, setTab] = useState<Tab>('plot');
  const [primShape, setPrimShape] = useState('circle');
  const [primOpacity, setPrimOpacity] = useState('100');
  const [primColor, setPrimColor] = useState('blue');
  const [gridX, setGridX] = useState(5);
  const [gridY, setGridY] = useState(5);

  // Plot state
  const [plotKind, setPlotKind] = useState<PlotKind>('explicit');
  const [plotX, setPlotX] = useState('x');
  const [plotY, setPlotY] = useState('y');
  const [funcExpr, setFuncExpr] = useState('calc.sin(x)');
  const [implicitExpr, setImplicitExpr] = useState('x*x + y*y - 1');
  const [paramX, setParamX] = useState('calc.cos(t) * t');
  const [paramY, setParamY] = useState('calc.sin(t) * t');
  const [domain, setDomain] = useState('-5, 5');

  const [alignCenter, setAlignCenter] = useState(true);
  const [asFigure, setAsFigure] = useState(true);
  const [caption, setCaption] = useState('Diagram');
  const [label, setLabel] = useState('');

  const buildPlot = () => {
    // cetz-plot 0.1.1 must be paired with cetz 0.3.2 (canvas + plot drawables
    // have to share the same cetz version, otherwise the `auto-scale` error).
    let body = '';
    if (plotKind === 'explicit') {
      body = `      plot.add(domain: (${domain}), x => ${funcExpr})\n`;
    } else if (plotKind === 'implicit') {
      const [a, b] = domain.split(',').map(s => s.trim());
      body = `      plot.add-contour(\n        x-domain: (${a}, ${b}), y-domain: (${a}, ${b}),\n        z: (0,), op: "<",\n        (x, y) => ${implicitExpr})\n`;
    } else {
      body = `      plot.add(domain: (${domain}), t => (${paramX}, ${paramY}))\n`;
    }
    const imports = `#import "@preview/cetz:0.3.2"\n#import "@preview/cetz-plot:0.1.1": plot\n`;
    const canvas = `cetz.canvas({\n  plot.plot(size: (8, 6),\n    x-label: [${plotX}], y-label: [${plotY}],\n    {\n${body}    })\n})`;
    return { imports, canvas };
  };

  const buildCanvas = () => {
    let inner = '';
    if (tab === 'primitives') {
      const fill = `${primColor}.transparentize(${100 - parseInt(primOpacity)}%)`;
      if (primShape === 'circle') inner = `  circle((0, 0), radius: 2, fill: ${fill})\n`;
      else inner = `  rect((0, 0), (2, 2), fill: ${fill})\n`;
    } else if (tab === 'grid') {
      inner = `  grid((0, 0), (${gridX}, ${gridY}), step: 1, stroke: gray.lighten(50%))\n`;
    } else {
      inner = `  grid((0, 0), (4, 4), step: 1, stroke: gray.lighten(50%))\n  circle((2, 2), radius: 1, fill: red.transparentize(20%))\n  content((2, 2), [*Center*])\n`;
    }
    const imports = `#import "@preview/cetz:0.3.2": canvas, draw\n`;
    const canvas = `canvas({\n  import draw: *\n${inner}})`;
    return { imports, canvas };
  };

  const handleInsert = () => {
    const { imports, canvas } = tab === 'plot' ? buildPlot() : buildCanvas();
    let body;
    if (asFigure) {
      const tag = label.trim() ? ` <fig:${label.trim()}>` : '';
      body = `${imports}#figure(\n  ${canvas},\n  caption: [${caption}],\n)${tag}`;
    } else {
      body = alignCenter ? `${imports}#align(center)[\n${canvas}\n]` : `${imports}${canvas}`;
    }
    onInsert('\n' + body + '\n\n');
  };

  const field = (label: string, el: React.ReactNode) => (
    <label className="form-field"><span>{label}</span>{el}</label>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '520px' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Insert Diagram / Plot</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <div className="seg">
            {(['primitives', 'grid', 'plot', 'combination'] as Tab[]).map(t => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {tab === 'primitives' && (
            <>
              {field('Shape', <select value={primShape} onChange={e => setPrimShape(e.target.value)}><option value="circle">Circle</option><option value="square">Square</option></select>)}
              {field('Color', <select value={primColor} onChange={e => setPrimColor(e.target.value)}><option>blue</option><option>red</option><option>green</option><option>black</option><option>orange</option></select>)}
              {field(`Opacity — ${primOpacity}%`, <input type="range" min="0" max="100" value={parseInt(primOpacity)} onChange={e => setPrimOpacity(e.target.value)} />)}
            </>
          )}

          {tab === 'grid' && (
            <div className="form-row">
              {field('Columns (X)', <input type="number" value={gridX} onChange={e => setGridX(Number(e.target.value))} />)}
              {field('Rows (Y)', <input type="number" value={gridY} onChange={e => setGridY(Number(e.target.value))} />)}
            </div>
          )}

          {tab === 'plot' && (
            <>
              {field('Plot kind', (
                <div className="seg">
                  {(['explicit', 'implicit', 'parametric'] as PlotKind[]).map(k => (
                    <button key={k} className={plotKind === k ? 'active' : ''} onClick={() => setPlotKind(k)}>
                      {k === 'explicit' ? 'y = f(x)' : k === 'implicit' ? 'f(x,y) = 0' : 'Parametric'}
                    </button>
                  ))}
                </div>
              ))}

              {plotKind === 'explicit' && field('Function f(x) — Typst math', <input type="text" value={funcExpr} onChange={e => setFuncExpr(e.target.value)} placeholder="calc.sin(x)" />)}
              {plotKind === 'implicit' && field('Expression f(x, y) — drawn where f = 0', <input type="text" value={implicitExpr} onChange={e => setImplicitExpr(e.target.value)} placeholder="x*x + y*y - 1" />)}
              {plotKind === 'parametric' && (
                <div className="form-row">
                  {field('x(t)', <input type="text" value={paramX} onChange={e => setParamX(e.target.value)} />)}
                  {field('y(t)', <input type="text" value={paramY} onChange={e => setParamY(e.target.value)} />)}
                </div>
              )}

              {field(plotKind === 'parametric' ? 'Domain of t (min, max)' : 'Domain (min, max)', <input type="text" value={domain} onChange={e => setDomain(e.target.value)} placeholder="-5, 5" />)}

              <div className="form-row">
                {field('X-axis label', <input type="text" value={plotX} onChange={e => setPlotX(e.target.value)} />)}
                {field('Y-axis label', <input type="text" value={plotY} onChange={e => setPlotY(e.target.value)} />)}
              </div>
              <div className="form-hint">Uses <code>cetz 0.3.2</code> + <code>cetz-plot 0.1.1</code>. Tip: use <code>calc.</code> functions (e.g. <code>calc.exp(x)</code>, <code>calc.pow(x, 2)</code>).</div>
            </>
          )}

          {tab === 'combination' && (
            <div className="form-hint">Inserts a worked example: a grid, a semi-transparent circle, and centered text — handy as a starting point.</div>
          )}

          <label className="form-check">
            <input type="checkbox" checked={asFigure} onChange={e => setAsFigure(e.target.checked)} />
            Wrap in a numbered figure (adds “Figure N” + caption)
          </label>
          {asFigure ? (
            <div className="form-row">
              {field('Caption', <input type="text" value={caption} onChange={e => setCaption(e.target.value)} />)}
              {field('Label (optional)', <input type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="plot1 → @fig:plot1" />)}
            </div>
          ) : (
            <label className="form-check">
              <input type="checkbox" checked={alignCenter} onChange={e => setAlignCenter(e.target.checked)} />
              Center on the page
            </label>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleInsert}>Insert</button>
        </div>
      </div>
    </div>
  );
}
