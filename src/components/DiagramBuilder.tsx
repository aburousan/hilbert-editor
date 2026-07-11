import { useRef, useState } from 'react';
import { API } from '../api';
import { notify } from '../notify';
import { parseDelimited, sniffDelim, sanitizeName, looksLikeHeader } from '../csvUtil';

// Visual cetz canvas builder with a LIVE preview. Click shape icons to add
// primitives; set each one's X/Y (position), Size (radius / length / grid range),
// Rotation and Colour, and see it rendered live before inserting. The "Data"
// tool imports a CSV/Excel file and plots two chosen columns as a real curve.

type PrimType =
  | 'circle' | 'ellipse' | 'rect' | 'triangle' | 'hexagon' | 'line'
  | 'arrow' | 'arc' | 'bezier' | 'grid' | 'dot' | 'axes' | 'text' | 'datacurve';

type Item = {
  uid: number; type: PrimType; color: string; x: number; y: number; size: number; rot: number; text?: string;
  // Populated only for 'datacurve': the file to save + parsed columns.
  dataFile?: string; dataContent?: string; dataHeaders?: string[]; dataRows?: string[][];
  dataHasHeader?: boolean; xcol?: number; ycol?: number;
};

const COLORS = ['blue', 'red', 'green', 'orange', 'purple', 'teal', 'gray', 'black'];
const HEX: Record<string, string> = {
  blue: '#4a90d9', red: '#e04a4a', green: '#2ecc71', orange: '#ff851b',
  purple: '#b10dc9', teal: '#39cccc', gray: '#9aa3ab', black: '#1a1a1a',
};
const DEF_SIZE: Record<PrimType, number> = {
  circle: 1.5, ellipse: 2, rect: 1.6, triangle: 1.5, hexagon: 1.6, line: 1.8,
  arrow: 1.8, arc: 1.5, bezier: 2, grid: 2, dot: 1.5, axes: 2, text: 1, datacurve: 3,
};

const EXCEL_EXT = ['xlsx', 'xls', 'xlsb', 'ods'];
const csvField = (v: string) => /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

const PRIMS: { type: PrimType; name: string; icon: React.ReactNode }[] = [
  { type: 'circle',   name: 'Circle',    icon: <circle cx="20" cy="20" r="12" /> },
  { type: 'ellipse',  name: 'Ellipse',   icon: <ellipse cx="20" cy="20" rx="15" ry="9" /> },
  { type: 'rect',     name: 'Rectangle', icon: <rect x="7" y="11" width="26" height="18" rx="1" /> },
  { type: 'triangle', name: 'Triangle',  icon: <polygon points="20,7 33,32 7,32" /> },
  { type: 'hexagon',  name: 'Hexagon',   icon: <polygon points="20,6 32,13 32,27 20,34 8,27 8,13" /> },
  { type: 'line',     name: 'Line',      icon: <line x1="8" y1="30" x2="32" y2="10" /> },
  { type: 'arrow',    name: 'Arrow',     icon: <><line x1="7" y1="20" x2="30" y2="20" /><polygon points="30,15 36,20 30,25" stroke="none" /></> },
  { type: 'arc',      name: 'Arc',       icon: <path d="M8 28 A14 14 0 1 1 32 20" fill="none" /> },
  { type: 'bezier',   name: 'Curve',     icon: <path d="M7 30 C15 5, 25 35, 33 10" fill="none" /> },
  { type: 'grid',     name: 'Grid',      icon: <><line x1="8" y1="14" x2="32" y2="14"/><line x1="8" y1="20" x2="32" y2="20"/><line x1="8" y1="26" x2="32" y2="26"/><line x1="14" y1="8" x2="14" y2="32"/><line x1="20" y1="8" x2="20" y2="32"/><line x1="26" y1="8" x2="26" y2="32"/></> },
  { type: 'dot',      name: 'Point',     icon: <circle cx="20" cy="20" r="4" stroke="none" /> },
  { type: 'axes',     name: 'Axes',      icon: <><line x1="8" y1="32" x2="34" y2="32"/><polygon points="34,29 38,32 34,35" stroke="none"/><line x1="8" y1="32" x2="8" y2="6"/><polygon points="5,6 8,2 11,6" stroke="none"/></> },
  { type: 'text',     name: 'Label',     icon: <text x="20" y="26" fontSize="18" textAnchor="middle" stroke="none" fill="currentColor">T</text> },
  { type: 'datacurve', name: 'Data',      icon: <><line x1="7" y1="33" x2="7" y2="7"/><line x1="7" y1="33" x2="34" y2="33"/><path d="M9 28 L16 18 L23 22 L32 10" fill="none" strokeWidth="2.4" /></> },
];

let counter = 0;

export default function DiagramBuilder({ onClose, onInsert, onSaveFile }: { onClose: () => void, onInsert: (code: string) => void, onSaveFile?: (filename: string, content: string) => Promise<void> }) {
  const [scene, setScene] = useState<Item[]>([{ uid: ++counter, type: 'circle', color: 'blue', x: 0, y: 0, size: 1.5, rot: 0 }]);
  const [asFigure, setAsFigure] = useState(true);
  const [caption, setCaption] = useState('Diagram');
  const [label, setLabel] = useState('');
  const dataInput = useRef<HTMLInputElement>(null);

  const add = (type: PrimType) => setScene(s => [...s, { uid: ++counter, type, color: 'blue', x: 0, y: 0, size: DEF_SIZE[type], rot: 0, ...(type === 'text' ? { text: 'Label' } : {}) }]);
  const remove = (uid: number) => setScene(s => s.filter(i => i.uid !== uid));
  const patch = (uid: number, p: Partial<Item>) => setScene(s => s.map(i => i.uid === uid ? { ...i, ...p } : i));

  // Parse a data cell of a chosen column into numbers, skipping unparseable rows.
  const dataPoints = (it: Item): [number, number][] => {
    if (!it.dataRows || it.xcol == null || it.ycol == null) return [];
    const rows = it.dataHasHeader ? it.dataRows.slice(1) : it.dataRows;
    const out: [number, number][] = [];
    for (const r of rows) {
      const x = parseFloat(r[it.xcol]), y = parseFloat(r[it.ycol]);
      if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
    }
    return out;
  };

  // Import a CSV/TSV/Excel file, sniff columns, and drop a data-curve into the scene.
  const importData = async (file: File) => {
    const e = (file.name.split('.').pop() || '').toLowerCase();
    let content = '', rows: string[][] = [];
    if (EXCEL_EXT.includes(e)) {
      try {
        const res = await fetch(`${API}/data/xlsx`, { method: 'POST', body: await file.arrayBuffer() });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { notify(j.error || 'Could not read that spreadsheet.'); return; }
        const sheet = j.sheets?.[0];
        if (!sheet) { notify('No readable sheets in that file.'); return; }
        content = sheet.csv; rows = parseDelimited(content, ',');
        if (j.sheets.length > 1) notify(`Using sheet "${sheet.name}" (first of ${j.sheets.length}).`, 'info');
      } catch { notify('Could not reach the local server.'); return; }
    } else {
      content = await file.text();
      const delim = e === 'tsv' ? '\t' : sniffDelim(content.split('\n')[0] || '');
      rows = parseDelimited(content, delim);
      // Save everything as comma CSV so Typst's csv() reads it with defaults.
      if (delim !== ',') content = rows.map(r => r.map(csvField).join(',')).join('\n') + '\n';
    }
    if (rows.length < 2 || (rows[0]?.length || 0) < 2) { notify('Need at least two columns and two rows of data.', 'info'); return; }
    const hasHeader = looksLikeHeader(rows[0]);
    const headers = hasHeader ? rows[0] : rows[0].map((_, i) => `col ${i + 1}`);
    const dataFile = sanitizeName(file.name.replace(/\.[^.]+$/, '') + '.csv');
    setScene(s => [...s, {
      uid: ++counter, type: 'datacurve', color: 'blue', x: 0, y: 0, size: 3, rot: 0,
      dataFile, dataContent: content, dataHeaders: headers, dataRows: rows, dataHasHeader: hasHeader,
      xcol: 0, ycol: Math.min(1, rows[0].length - 1),
    }]);
  };

  const hexPts = (cx: number, cy: number, r: number) => Array.from({ length: 6 }, (_, k) => { const a = Math.PI / 3 * k - Math.PI / 2; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number]; });

  // ---- cetz code (uses each item's x/y/size, wrapped in a rotate group) -----
  const genLine = (it: Item): string => {
    const { x: cx, y: cy, color: c, size: s } = it;
    const fill = `${c}.transparentize(35%)`, st = `stroke: ${c}`;
    let body: string;
    switch (it.type) {
      case 'circle':   body = `circle((${cx}, ${cy}), radius: ${s}, fill: ${fill}, ${st})`; break;
      case 'ellipse':  body = `circle((${cx}, ${cy}), radius: (${s}, ${(s / 2).toFixed(2)}), fill: ${fill}, ${st})`; break;
      case 'rect':     body = `rect((${cx - s}, ${(cy - s * 0.62).toFixed(2)}), (${cx + s}, ${(cy + s * 0.62).toFixed(2)}), fill: ${fill}, ${st})`; break;
      case 'triangle': body = `line((${cx}, ${(cy + s).toFixed(2)}), (${(cx + s * 0.87).toFixed(2)}, ${(cy - s * 0.5).toFixed(2)}), (${(cx - s * 0.87).toFixed(2)}, ${(cy - s * 0.5).toFixed(2)}), close: true, fill: ${fill}, ${st})`; break;
      case 'hexagon':  body = `line(${hexPts(cx, cy, s).map(([a, b]) => `(${a.toFixed(2)}, ${b.toFixed(2)})`).join(', ')}, close: true, fill: ${fill}, ${st})`; break;
      case 'line':     body = `line((${cx - s}, ${(cy - s * 0.67).toFixed(2)}), (${cx + s}, ${(cy + s * 0.67).toFixed(2)}), ${st})`; break;
      case 'arrow':    body = `line((${cx - s}, ${cy}), (${cx + s}, ${cy}), mark: (end: ">", scale: ${s}), stroke: (paint: ${c}, thickness: ${(s * 0.9).toFixed(2)}pt))`; break;
      case 'arc':      body = `arc((${cx}, ${cy}), start: 0deg, stop: 260deg, radius: ${s}, ${st})`; break;
      case 'bezier':   body = `bezier((${cx - s}, ${cy}), (${cx + s}, ${cy}), (${(cx - s / 2).toFixed(2)}, ${cy + s}), (${(cx + s / 2).toFixed(2)}, ${cy - s}), ${st})`; break;
      case 'grid':     body = `grid((${cx - s}, ${cy - s}), (${cx + s}, ${cy + s}), step: 1, stroke: gray.lighten(50%))`; break;
      case 'dot':      body = `circle((${cx}, ${cy}), radius: ${Math.max(0.08, s * 0.1).toFixed(2)}, fill: ${c}, stroke: none)`; break;
      case 'axes':     body = `line((${cx - s}, ${cy}), (${cx + s}, ${cy}), mark: (end: ">"), ${st})\n    line((${cx}, ${cy - s}), (${cx}, ${cy + s}), mark: (end: ">"), ${st})`; break;
      case 'text':     body = `content((${cx}, ${cy}), text(size: ${Math.max(6, Math.round(s * 9))}pt, fill: ${c})[${(it.text || 'Label').replace(/([\[\]#])/g, '\\$1')}])`; break;
      case 'datacurve': {
        const hdr = it.dataHasHeader ? 1 : 0, xi = it.xcol ?? 0, yi = it.ycol ?? 1;
        // Reads the saved CSV at compile time and normalises the two chosen
        // columns into a (2·size) box centred at (x, y) so it sits in the canvas.
        body = `{
    let _num = regex("^[-+]?(\\d+\\.?\\d*|\\.\\d+)([eE][-+]?\\d+)?$")
    let _raw = csv("${it.dataFile}")
    let _pts = _raw.slice(${hdr}).filter(r => r.len() > ${Math.max(xi, yi)} and r.at(${xi}).trim().match(_num) != none and r.at(${yi}).trim().match(_num) != none).map(r => (float(r.at(${xi})), float(r.at(${yi}))))
    if _pts.len() >= 2 {
      let _xs = _pts.map(p => p.at(0)); let _ys = _pts.map(p => p.at(1))
      let _x0 = calc.min(.._xs); let _x1 = calc.max(.._xs)
      let _y0 = calc.min(.._ys); let _y1 = calc.max(.._ys)
      let _nx(v) = if _x1 == _x0 { ${cx} } else { ${cx} - ${s} + 2 * ${s} * (v - _x0) / (_x1 - _x0) }
      let _ny(v) = if _y1 == _y0 { ${cy} } else { ${cy} - ${s} + 2 * ${s} * (v - _y0) / (_y1 - _y0) }
      line(.._pts.map(p => (_nx(p.at(0)), _ny(p.at(1)))), stroke: ${c})
    }
  }`;
        break;
      }
    }
    if (it.rot) return `  group({\n    rotate(${it.rot}deg, origin: (${cx}, ${cy}))\n    ${body}\n  })`;
    return `  ${body}`;
  };

  // ---- live SVG preview ----------------------------------------------------
  const W = 360, H = 240, PAD = 24;
  const ext = (i: Item): [number, number] => { const s = i.size; return i.type === 'ellipse' ? [s, s / 2] : i.type === 'rect' ? [s, s * 0.62] : i.type === 'text' ? [1, 0.6] : [s, s]; };
  let minX = -3, maxX = 3, minY = -2, maxY = 2;
  if (scene.length) {
    minX = Math.min(...scene.map(i => i.x - ext(i)[0])); maxX = Math.max(...scene.map(i => i.x + ext(i)[0]));
    minY = Math.min(...scene.map(i => i.y - ext(i)[1])); maxY = Math.max(...scene.map(i => i.y + ext(i)[1]));
  }
  minX -= 1; maxX += 1; minY -= 1; maxY += 1;
  const scale = Math.min((W - 2 * PAD) / Math.max(maxX - minX, 1), (H - 2 * PAD) / Math.max(maxY - minY, 1));
  const ox = W / 2 - ((minX + maxX) / 2) * scale, oy = H / 2 + ((minY + maxY) / 2) * scale;
  const px = (x: number) => ox + x * scale, py = (y: number) => oy - y * scale;

  const renderShape = (it: Item) => {
    const c = HEX[it.color] || '#4a90d9', s = it.size;
    const line = { stroke: c, strokeWidth: 1.5, fill: 'none' } as any;
    const filled = { stroke: c, strokeWidth: 1.5, fill: c, fillOpacity: 0.55 } as any;
    // cetz rotates CCW (y-up); our preview flips y, so negate the angle to match.
    const rot = it.rot ? `rotate(${-it.rot} ${px(it.x)} ${py(it.y)})` : undefined;
    let el: React.ReactNode;
    switch (it.type) {
      case 'circle':   el = <circle cx={px(it.x)} cy={py(it.y)} r={s * scale} {...filled} />; break;
      case 'ellipse':  el = <ellipse cx={px(it.x)} cy={py(it.y)} rx={s * scale} ry={(s / 2) * scale} {...filled} />; break;
      case 'rect':     el = <rect x={px(it.x - s)} y={py(it.y + s * 0.62)} width={2 * s * scale} height={2 * s * 0.62 * scale} {...filled} />; break;
      case 'triangle': el = <polygon points={[[it.x, it.y + s], [it.x + s * 0.87, it.y - s * 0.5], [it.x - s * 0.87, it.y - s * 0.5]].map(([a, b]) => `${px(a)},${py(b)}`).join(' ')} {...filled} />; break;
      case 'hexagon':  el = <polygon points={hexPts(it.x, it.y, s).map(([a, b]) => `${px(a)},${py(b)}`).join(' ')} {...filled} />; break;
      case 'line':     el = <line x1={px(it.x - s)} y1={py(it.y - s * 0.67)} x2={px(it.x + s)} y2={py(it.y + s * 0.67)} {...line} />; break;
      case 'arrow':    { const sw = Math.max(1, s * 1.1); el = <line x1={px(it.x - s)} y1={py(it.y)} x2={px(it.x + s)} y2={py(it.y)} markerEnd="url(#pv-arrow)" stroke={c} strokeWidth={sw} fill="none" />; break; }
      case 'arc':      { const r = s * scale, a1 = 260 * Math.PI / 180; const x0 = px(it.x) + r, y0 = py(it.y); const x1 = px(it.x) + r * Math.cos(a1), y1 = py(it.y) - r * Math.sin(a1); el = <path d={`M ${x0} ${y0} A ${r} ${r} 0 1 0 ${x1} ${y1}`} {...line} />; break; }
      case 'bezier':   el = <path d={`M ${px(it.x - s)} ${py(it.y)} C ${px(it.x - s / 2)} ${py(it.y + s)}, ${px(it.x + s / 2)} ${py(it.y - s)}, ${px(it.x + s)} ${py(it.y)}`} {...line} />; break;
      case 'grid':     { const els = []; for (let i = -s; i <= s + 1e-6; i++) { els.push(<line key={`h${i}`} x1={px(it.x - s)} y1={py(it.y + i)} x2={px(it.x + s)} y2={py(it.y + i)} stroke="#c9ced6" strokeWidth={1} />); els.push(<line key={`v${i}`} x1={px(it.x + i)} y1={py(it.y - s)} x2={px(it.x + i)} y2={py(it.y + s)} stroke="#c9ced6" strokeWidth={1} />); } el = <g>{els}</g>; break; }
      case 'dot':      el = <circle cx={px(it.x)} cy={py(it.y)} r={Math.max(2.5, s * 0.1 * scale)} fill={c} />; break;
      case 'axes':     el = <g><line x1={px(it.x - s)} y1={py(it.y)} x2={px(it.x + s)} y2={py(it.y)} markerEnd="url(#pv-arrow)" {...line} /><line x1={px(it.x)} y1={py(it.y - s)} x2={px(it.x)} y2={py(it.y + s)} markerEnd="url(#pv-arrow)" {...line} /></g>; break;
      case 'text':     el = <text x={px(it.x)} y={py(it.y)} fill={c} fontSize={Math.max(9, s * 11)} textAnchor="middle" dominantBaseline="middle">{it.text || 'Label'}</text>; break;
      case 'datacurve': {
        const pts = dataPoints(it);
        if (pts.length < 2) { el = <text x={px(it.x)} y={py(it.y)} fill={c} fontSize={11} textAnchor="middle">no data</text>; break; }
        const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        const nx = (v: number) => x1 === x0 ? it.x : it.x - s + 2 * s * (v - x0) / (x1 - x0);
        const ny = (v: number) => y1 === y0 ? it.y : it.y - s + 2 * s * (v - y0) / (y1 - y0);
        const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${px(nx(p[0]))} ${py(ny(p[1]))}`).join(' ');
        el = <path d={d} {...line} />; break;
      }
    }
    return <g key={it.uid} transform={rot}>{el}</g>;
  };

  const handleInsert = async () => {
    // Persist each referenced data file into the workspace (shown in the tree).
    if (onSaveFile) {
      const seen = new Set<string>();
      for (const it of scene) {
        if (it.type === 'datacurve' && it.dataFile && it.dataContent && !seen.has(it.dataFile)) {
          seen.add(it.dataFile);
          await onSaveFile(it.dataFile, it.dataContent);
        }
      }
    }
    const inner = scene.map(genLine).join('\n');
    const imports = `#import "@preview/cetz:0.3.4": canvas, draw\n`;
    const canvas = `canvas({\n  import draw: *\n${inner}\n})`;
    const tag = label.trim() ? ` <fig:${label.trim()}>` : '';
    const body = asFigure ? `${imports}#figure(\n  ${canvas},\n  caption: [${caption}],\n)${tag}` : `${imports}#align(center)[\n${canvas}\n]`;
    onInsert('\n' + body + '\n\n');
    onClose();
  };

  const numIn = (v: number, on: (n: number) => void, step = 0.5, width = 46) => (
    <input type="number" step={step} value={v} onChange={e => on(parseFloat(e.target.value) || 0)}
      style={{ width, background: 'var(--bg-color)', color: 'var(--text-color)', border: '1px solid var(--border-color)', borderRadius: 4, padding: '2px 3px', fontSize: '0.76rem' }} />
  );
  const lbl = (t: string) => <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{t}</span>;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '820px', maxWidth: '96vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>cetz Canvas</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <input ref={dataInput} type="file" accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsb,.ods" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) importData(f); e.currentTarget.value = ''; }} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 372px', gap: 16 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 6 }}>Click to add</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, marginBottom: 14 }}>
                {PRIMS.map(p => (
                  <button key={p.type} title={p.type === 'datacurve' ? 'Plot a curve from a data file' : `Add ${p.name}`} onClick={() => p.type === 'datacurve' ? dataInput.current?.click() : add(p.type)}
                    style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '6px 2px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 7, cursor: 'pointer', color: 'var(--text-color)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(139,92,246,0.22)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}>
                    <svg width="30" height="30" viewBox="0 0 40 40" fill="currentColor" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.9 }}>{p.icon}</svg>
                    <span style={{ fontSize: '0.56rem' }}>{p.name}</span>
                  </button>
                ))}
              </div>
              <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 6 }}>Scene ({scene.length})</div>
              <div style={{ maxHeight: 210, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
                {scene.length === 0 && <div className="form-hint">Empty — click a shape above.</div>}
                {scene.map(it => {
                  const prim = PRIMS.find(p => p.type === it.type)!;
                  return (
                    <div key={it.uid} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 6px', background: 'rgba(255,255,255,0.04)', borderRadius: 6, flexWrap: 'wrap' }}>
                      <svg width="18" height="18" viewBox="0 0 40 40" fill="currentColor" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0, opacity: 0.85 }}>{prim.icon}</svg>
                      {it.type === 'text'
                        ? <input value={it.text || ''} onChange={e => patch(it.uid, { text: e.target.value })} placeholder="text" style={{ width: 58, background: 'var(--bg-color)', color: 'var(--text-color)', border: '1px solid var(--border-color)', borderRadius: 4, padding: '2px 5px', fontSize: '0.76rem' }} />
                        : it.type === 'datacurve'
                          ? <span title={it.dataFile} style={{ width: 78, fontSize: '0.7rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.dataFile}</span>
                          : <span style={{ width: 50, fontSize: '0.76rem' }}>{prim.name}</span>}
                      {it.type === 'datacurve' && (<>
                        {lbl('X')}<select value={it.xcol} onChange={e => patch(it.uid, { xcol: Number(e.target.value) })} style={{ maxWidth: 84, background: 'var(--bg-color)', color: 'var(--text-color)', border: '1px solid var(--border-color)', borderRadius: 4, padding: '2px 2px', fontSize: '0.72rem' }}>
                          {it.dataHeaders?.map((h, i) => <option key={i} value={i}>{h}</option>)}
                        </select>
                        {lbl('Y')}<select value={it.ycol} onChange={e => patch(it.uid, { ycol: Number(e.target.value) })} style={{ maxWidth: 84, background: 'var(--bg-color)', color: 'var(--text-color)', border: '1px solid var(--border-color)', borderRadius: 4, padding: '2px 2px', fontSize: '0.72rem' }}>
                          {it.dataHeaders?.map((h, i) => <option key={i} value={i}>{h}</option>)}
                        </select>
                      </>)}
                      {lbl('x')}{numIn(it.x, n => patch(it.uid, { x: n }))}
                      {lbl('y')}{numIn(it.y, n => patch(it.uid, { y: n }))}
                      {lbl(it.type === 'grid' ? 'range' : 'size')}{numIn(it.size, n => patch(it.uid, { size: Math.max(0.1, n) }))}
                      {lbl('rot°')}{numIn(it.rot, n => patch(it.uid, { rot: n }), 15, 42)}
                      <select value={it.color} onChange={e => patch(it.uid, { color: e.target.value })} style={{ background: 'var(--bg-color)', color: 'var(--text-color)', border: '1px solid var(--border-color)', borderRadius: 4, padding: '2px 2px', fontSize: '0.72rem' }}>
                        {COLORS.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                      <button onClick={() => remove(it.uid)} title="Remove" style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '17px', lineHeight: 1 }}>×</button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <div style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 6 }}>Live preview</div>
              <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ background: '#fbfbfd', borderRadius: 8, border: '1px solid var(--border-color)' }}>
                <defs><marker id="pv-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="context-stroke" /></marker></defs>
                <line x1={px(minX)} y1={py(0)} x2={px(maxX)} y2={py(0)} stroke="#e6e8ec" strokeWidth={1} />
                <line x1={px(0)} y1={py(minY)} x2={px(0)} y2={py(maxY)} stroke="#e6e8ec" strokeWidth={1} />
                {scene.map(renderShape)}
              </svg>
              <div className="form-hint" style={{ marginTop: 6 }}>Same X, Y → shapes stack. Use <b>size</b> (grid = range) and <b>rot°</b> to shape each.</div>
            </div>
          </div>

          <label className="form-check" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={asFigure} onChange={e => setAsFigure(e.target.checked)} />
            Wrap in a numbered figure (adds “Figure N” + caption)
          </label>
          {asFigure && (
            <div className="form-row">
              <label className="form-field"><span>Caption</span><input type="text" value={caption} onChange={e => setCaption(e.target.value)} /></label>
              <label className="form-field"><span>Label (optional)</span><input type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="fig1 → @fig:fig1" /></label>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleInsert} disabled={scene.length === 0}>Insert</button>
        </div>
      </div>
    </div>
  );
}
