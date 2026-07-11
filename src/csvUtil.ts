// RFC-4180-ish parser shared by the data importer and the cetz data-curve tool.
// Honours quoted fields, doubled quotes, and the chosen delimiter.
export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function sniffDelim(firstLine: string): string {
  const cands = [',', ';', '\t', '|'];
  let best = ',', max = -1;
  for (const d of cands) {
    const n = firstLine.split(d).length - 1;
    if (n > max) { max = n; best = d; }
  }
  return best;
}

export const sanitizeName = (n: string) => n.replace(/[^\w.\-]+/g, '_');

// A row is treated as a header when at least one cell is present and not numeric.
export function looksLikeHeader(row: string[] | undefined): boolean {
  if (!row || !row.length) return false;
  return row.some(c => c.trim() !== '' && !Number.isFinite(Number(c)));
}
