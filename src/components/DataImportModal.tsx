import { useEffect, useMemo, useRef, useState } from 'react';
import { API } from '../api';
import { notify } from '../notify';
import { parseDelimited, sniffDelim, sanitizeName as sanitize } from '../csvUtil';

type ImportPayload = { filename: string; content: string; snippet: string };
type Props = { onClose: () => void; onImport: (p: ImportPayload) => Promise<void> | void };

const EXCEL_EXT = ['xlsx', 'xls', 'xlsb', 'ods'];
const STRUCTURED_EXT = ['json', 'yaml', 'yml', 'toml', 'xml'];

function csvSnippet(name: string, delim: string, hasHeader: boolean, withTable: boolean): string {
  const delimArg = delim === ',' ? '' : `, delimiter: "${delim === '\t' ? '\\t' : delim}"`;
  const load = `#let data = csv("${name}"${delimArg})`;
  if (!withTable) return load;
  const body = hasHeader
    ? '  table.header(.._rows.first()),\n  .._rows.slice(1).flatten(),'
    : '  .._rows.flatten(),';
  const take = hasHeader ? 11 : 10;
  return `${load}
// Preview: ${hasHeader ? 'header + first 10 rows' : 'first 10 rows'}, auto-scaled to fit the page. \`data\` holds every row.
#let _rows = data.slice(0, calc.min(${take}, data.len()))
#let _tbl = text(size: 8pt, table(
  columns: data.first().len(),
  align: left,
${body}
))
#layout(size => scale(
  calc.min(1, size.width / measure(_tbl).width) * 100%,
  reflow: true,
  _tbl,
))`;
}

const escLabel = (s: string) => s.replace(/([\\[\]#])/g, '\\$1');
const csvField = (v: string) => /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

// A real cetz-plot line plot that reads two columns of the saved CSV at compile
// time — data-driven, so editing the file updates the figure.
function plotSnippet(name: string, xi: number, yi: number, xlabel: string, ylabel: string, caption: string, hasHeader: boolean): string {
  const hdr = hasHeader ? 1 : 0;
  return `#import "@preview/cetz:0.3.4"
#import "@preview/cetz-plot:0.1.1": plot
#let _num = regex("^[-+]?(\\d+\\.?\\d*|\\.\\d+)([eE][-+]?\\d+)?$")
#let _raw = csv("${name}")
// Keep only rows where both chosen columns are numeric (skips headers, labels, blanks).
#let _pts = _raw.slice(${hdr}).filter(r => r.len() > ${Math.max(xi, yi)} and r.at(${xi}).trim().match(_num) != none and r.at(${yi}).trim().match(_num) != none).map(r => (float(r.at(${xi})), float(r.at(${yi}))))
#if _pts.len() < 2 [
  #text(fill: red)[Plot: the chosen columns have fewer than two numeric points.]
] else [
  #figure(
    cetz.canvas({
      plot.plot(size: (9, 6), x-label: [${escLabel(xlabel)}], y-label: [${escLabel(ylabel)}], {
        plot.add(_pts)
      })
    }),
    caption: [${escLabel(caption)}],
  )
]`;
}

function structuredSnippet(ext: string, name: string): string {
  if (ext === 'json') return `#let data = json("${name}")\n// e.g. #data.at("key")`;
  if (ext === 'yaml' || ext === 'yml') return `#let data = yaml("${name}")`;
  if (ext === 'toml') return `#let data = toml("${name}")`;
  if (ext === 'xml') return `#let data = xml("${name}")`;
  return `#let text-data = read("${name}")`;
}

export default function DataImportModal({ onClose, onImport }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [ext, setExt] = useState('');
  const [origName, setOrigName] = useState('');
  const [kind, setKind] = useState<'table' | 'structured' | ''>('');
  const [rawText, setRawText] = useState('');       // csv/structured text
  const [sheets, setSheets] = useState<{ name: string; csv: string }[]>([]);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [delim, setDelim] = useState(',');
  const [hasHeader, setHasHeader] = useState(true);
  const [insertAs, setInsertAs] = useState<'table' | 'plot' | 'var'>('table');
  const [xcol, setXcol] = useState(0);
  const [ycol, setYcol] = useState(1);
  const [plotCaption, setPlotCaption] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);

  const isExcel = EXCEL_EXT.includes(ext);
  // The CSV text actually driving preview + insert: an Excel sheet or a raw file.
  const csvText = isExcel ? (sheets[sheetIdx]?.csv ?? '') : rawText;
  const effDelim = isExcel ? ',' : delim;

  const table = useMemo(() => (kind === 'table' ? parseDelimited(csvText, effDelim) : []), [kind, csvText, effDelim]);
  // Column labels for the plot X/Y pickers: header row if present, else col N.
  const columns = useMemo(() =>
    (table[0] || []).map((h, i) => (hasHeader ? (h.trim() || `col ${i + 1}`) : `col ${i + 1}`)),
    [table, hasHeader]);
  // Columns whose data cells are mostly numbers — the only ones worth plotting.
  const numericCols = useMemo(() => {
    const rows = hasHeader ? table.slice(1) : table;
    const n = table[0]?.length ?? 0;
    const res: number[] = [];
    for (let c = 0; c < n; c++) {
      let num = 0, tot = 0;
      for (const r of rows) { const v = (r[c] ?? '').trim(); if (!v) continue; tot++; if (Number.isFinite(Number(v))) num++; }
      if (tot > 0 && num >= tot * 0.6) res.push(c);
    }
    return res;
  }, [table, hasHeader]);
  // Keep the X/Y selections on numeric columns as the data/header toggle changes.
  useEffect(() => {
    if (numericCols.length && !numericCols.includes(xcol)) setXcol(numericCols[0]);
    if (numericCols.length && !numericCols.includes(ycol)) setYcol(numericCols[1] ?? numericCols[0]);
  }, [numericCols]); // eslint-disable-line react-hooks/exhaustive-deps

  async function pick(file: File) {
    const e = (file.name.split('.').pop() || '').toLowerCase();
    setExt(e); setOrigName(file.name); setSheetIdx(0); setSheets([]);
    if (EXCEL_EXT.includes(e)) {
      setBusy(true);
      try {
        const res = await fetch(`${API}/data/xlsx`, { method: 'POST', body: await file.arrayBuffer() });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { notify(j.error || 'Could not read that spreadsheet.'); setExt(''); return; }
        setSheets(j.sheets || []);
        setKind('table');
        const base = file.name.replace(/\.[^.]+$/, '');
        setTarget(sanitize(`${base}-${(j.sheets?.[0]?.name || 'sheet')}.csv`));
      } catch { notify('Could not reach the local server.'); setExt(''); }
      finally { setBusy(false); }
      return;
    }
    const text = await file.text();
    setRawText(text);
    setTarget(sanitize(file.name));
    if (STRUCTURED_EXT.includes(e)) { setKind('structured'); return; }
    // csv / tsv / txt and anything else tabular-ish
    setKind('table');
    setDelim(e === 'tsv' ? '\t' : sniffDelim(text.split('\n')[0] || ''));
  }

  function onSheetChange(i: number) {
    setSheetIdx(i);
    const base = origName.replace(/\.[^.]+$/, '');
    setTarget(sanitize(`${base}-${sheets[i]?.name || 'sheet'}.csv`));
  }

  async function doImport() {
    if (!target.trim()) { notify('Give the file a name first.', 'info'); return; }
    let filename = target.trim();
    let content: string, snippet: string;
    if (kind === 'table') {
      // Excel is normalised to comma CSV on the backend; a raw file keeps its text.
      content = csvText;
      if (isExcel && !/\.csv$/i.test(filename)) filename += '.csv';
      const d = isExcel ? ',' : delim;
      if (insertAs === 'plot') {
        // The plot reads with csv()'s default comma, so normalise non-comma files.
        if (!isExcel && d !== ',') content = table.map(r => r.map(csvField).join(',')).join('\n') + '\n';
        if (!/\.csv$/i.test(filename)) filename += '.csv';
        snippet = plotSnippet(filename, xcol, ycol, columns[xcol] || 'x', columns[ycol] || 'y', plotCaption.trim() || 'Plot', hasHeader);
      } else {
        snippet = csvSnippet(filename, d, hasHeader, insertAs === 'table');
      }
    } else {
      content = rawText;
      snippet = structuredSnippet(ext, filename);
    }
    setBusy(true);
    try { await onImport({ filename, content, snippet }); }
    finally { setBusy(false); }
  }

  const DELIMS: [string, string][] = [[',', 'Comma'], [';', 'Semicolon'], ['\t', 'Tab'], ['|', 'Pipe']];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '720px', maxWidth: '92vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Import Data</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input ref={fileInput} type="file" accept=".csv,.tsv,.txt,.json,.yaml,.yml,.toml,.xml,.xlsx,.xls,.xlsb,.ods"
            style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) pick(f); e.currentTarget.value = ''; }} />

          {!kind ? (
            <div onClick={() => fileInput.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) pick(f); }}
              style={{
                border: '2px dashed var(--border-color)', borderRadius: 8, padding: '36px 20px',
                textAlign: 'center', cursor: 'pointer', color: 'var(--text-muted, #94a3b8)',
              }}>
              {busy ? 'Reading…' : <>
                <div style={{ fontSize: 15, marginBottom: 6 }}>Choose a file or drop it here</div>
                <div style={{ fontSize: 12 }}>CSV, TSV, Excel (xlsx / xls / ods), JSON, YAML, TOML, XML</div>
              </>}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13 }}>📄 <b>{origName}</b></span>
                <button className="btn-ghost" style={{ padding: '4px 10px', fontSize: 12 }}
                  onClick={() => { setKind(''); setExt(''); setSheets([]); setRawText(''); }}>Change file</button>
              </div>

              {isExcel && sheets.length > 0 && (
                <label className="form-field" style={{ maxWidth: 280 }}>
                  <span>Sheet</span>
                  <select value={sheetIdx} onChange={e => onSheetChange(Number(e.target.value))}>
                    {sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
                  </select>
                </label>
              )}

              {kind === 'table' && !isExcel && (
                <label className="form-field" style={{ maxWidth: 280 }}>
                  <span>Delimiter</span>
                  <select value={delim} onChange={e => setDelim(e.target.value)}>
                    {DELIMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
              )}

              {/* Preview */}
              <div style={{ border: '1px solid var(--border-color)', borderRadius: 6, overflow: 'auto', maxHeight: 260 }}>
                {kind === 'table' ? (
                  <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
                    <tbody>
                      {table.slice(0, 15).map((r, ri) => (
                        <tr key={ri} style={hasHeader && ri === 0 ? { background: 'var(--bg-elevated, #1e293b)', fontWeight: 600 } : undefined}>
                          {r.map((c, ci) => (
                            <td key={ci} style={{ border: '1px solid var(--border-color)', padding: '3px 8px', whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <pre style={{ margin: 0, padding: 10, fontSize: 12, whiteSpace: 'pre' }}>{rawText.split('\n').slice(0, 40).join('\n')}</pre>
                )}
              </div>
              {kind === 'table' && (
                <div style={{ fontSize: 11, color: 'var(--text-muted, #94a3b8)' }}>
                  {table.length} rows × {table[0]?.length ?? 0} columns{table.length > 15 ? ' (showing first 15)' : ''}
                </div>
              )}

              {/* Options */}
              {kind === 'table' && (
                <>
                  <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <label className="form-check" style={{ marginBottom: 6 }}><input type="checkbox" checked={hasHeader} onChange={e => setHasHeader(e.target.checked)} /> First row is a header</label>
                    <label className="form-field" style={{ maxWidth: 220 }}>
                      <span>Insert as</span>
                      <select value={insertAs} onChange={e => setInsertAs(e.target.value as typeof insertAs)}>
                        <option value="table">Table preview</option>
                        <option value="plot">Line plot (pick X &amp; Y)</option>
                        <option value="var">Just load the variable</option>
                      </select>
                    </label>
                  </div>
                  {insertAs === 'plot' && (numericCols.length >= 2 ? (
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                      <label className="form-field" style={{ maxWidth: 190 }}>
                        <span>X column</span>
                        <select value={xcol} onChange={e => setXcol(Number(e.target.value))}>
                          {numericCols.map(i => <option key={i} value={i}>{columns[i]}</option>)}
                        </select>
                      </label>
                      <label className="form-field" style={{ maxWidth: 190 }}>
                        <span>Y column</span>
                        <select value={ycol} onChange={e => setYcol(Number(e.target.value))}>
                          {numericCols.map(i => <option key={i} value={i}>{columns[i]}</option>)}
                        </select>
                      </label>
                      <label className="form-field" style={{ flex: 1, minWidth: 160 }}>
                        <span>Caption</span>
                        <input value={plotCaption} onChange={e => setPlotCaption(e.target.value)} placeholder={columns[ycol] ? `${columns[ycol]} vs ${columns[xcol]}` : 'Plot'} />
                      </label>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: '#f59e0b' }}>
                      Need at least two numeric columns to plot — this data has {numericCols.length}. Try “Table preview” instead, or check the header setting.
                    </div>
                  ))}
                </>
              )}

              <label className="form-field">
                <span>Save into workspace as</span>
                <input value={target} onChange={e => setTarget(e.target.value)} spellCheck={false} />
              </label>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!kind || busy} onClick={doImport}>{busy ? 'Importing…' : 'Import'}</button>
        </div>
      </div>
    </div>
  );
}
