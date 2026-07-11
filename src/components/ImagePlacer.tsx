import { useState, useEffect, useMemo } from 'react';

/**
 * Image Placer — a visual way to drop an image on the page and choose how the
 * surrounding text behaves. No document setup required: the width is a percentage,
 * so it adapts to whatever page size the document already uses.
 *
 *   • Wrap    — text flows around the image (image sits left or right) → `wrap-it`
 *   • Below   — image on its own line, text continues underneath  → plain figure
 *   • Float   — figure floats to the top or bottom of the page     → figure placement
 *   • Full    — image spans the full text width                    → plain figure
 *   • Free    — #place(dx, dy) at an exact point; opaque backing over text → drag anywhere
 */

const WRAP_IMPORT = '#import "@preview/wrap-it:0.1.1": wrap-content\n';

type Flow = 'wrap-left' | 'wrap-right' | 'below' | 'float-top' | 'float-bottom' | 'full' | 'free';

const PAPERS: Record<string, { label: string; ratio: number }> = {
  'a4': { label: 'A4', ratio: 595.28 / 841.89 },
  'us-letter': { label: 'US Letter', ratio: 612 / 792 },
  'a5': { label: 'A5', ratio: 419.53 / 595.28 },
};

// Sensible default width (% of text block) when switching mode.
const DEFAULT_WIDTH: Record<Flow, number> = {
  'wrap-left': 38, 'wrap-right': 38, 'below': 60, 'float-top': 60, 'float-bottom': 60, 'full': 100, 'free': 38,
};



/** Try to extract image path, width, and caption from existing Typst code. */
function parseExistingCode(code: string): { path?: string; width?: number; caption?: string; flow?: Flow } | null {
  if (!code) return null;
  const pathMatch = code.match(/image\(\s*"([^"]+)"/);
  const widthMatch = code.match(/width:\s*(\d+)%/);
  const captionMatch = code.match(/caption:\s*\[([^\]]*)\]/);
  const path = pathMatch?.[1];
  const width = widthMatch ? parseInt(widthMatch[1]) : undefined;
  const caption = captionMatch?.[1];
  let flow: Flow | undefined;
  if (code.includes('wrap-content')) flow = code.includes('left') ? 'wrap-left' : 'wrap-right';
  else if (code.includes('placement: top')) flow = 'float-top';
  else if (code.includes('placement: bottom')) flow = 'float-bottom';
  else if (code.includes('#place(')) flow = 'free';
  else if (width === 100) flow = 'full';
  return { path, width, caption, flow };
}

export default function ImagePlacer({
  onClose, onEnsureImport, onInsert, workspaceImages = [], selectedCode,
}: {
  onClose: () => void,
  onEnsureImport: (importLine: string) => void,  // add an import at the top if missing
  onInsert: (code: string) => void,               // insert the figure at the cursor
  workspaceImages?: string[],                      // image paths available in the workspace
  selectedCode?: string,                           // existing code to re-wrap (from editor selection)
}) {
  const parsed = useMemo(() => parseExistingCode(selectedCode || ''), [selectedCode]);
  // Distinguish the two kinds of selection we can be opened on:
  //  • an existing image/figure  → re-place it (parse & regenerate)
  //  • a plain paragraph of text → wrap the image around THIS text
  const looksLikeImage = !!selectedCode && (selectedCode.includes('image(') || selectedCode.includes('figure('));
  const bodyText = selectedCode && !looksLikeImage ? selectedCode.trim() : null;

  const [imgPath, setImgPath] = useState(parsed?.path || 'images/figure.png');
  const [caption, setCaption] = useState(parsed?.caption || 'My figure');
  const [width, setWidth] = useState(parsed?.width || 38);
  const [flow, setFlow] = useState<Flow>(parsed?.flow || 'wrap-right');
  const [paper, setPaper] = useState('a4');
  // Free-position offset as a fraction (0..1) of the text area, from its top-left.
  const [pos, setPos] = useState({ x: 0.32, y: 0.30 });
  const [dragging, setDragging] = useState(false);

  // Sync initial width to the parsed flow default on first render.
  useEffect(() => {
    if (parsed?.flow && !parsed?.width) setWidth(DEFAULT_WIDTH[parsed.flow]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setMode = (f: Flow) => { setFlow(f); setWidth(DEFAULT_WIDTH[f]); };

  // ---- Preview geometry -----------------------------------------------------
  const PH = 320;
  const PW = PH * PAPERS[paper].ratio;
  const pad = 12;
  const areaW = PW - 2 * pad, areaH = PH - 2 * pad;
  const lineGap = 11, lineH = 3;
  const nLines = Math.floor(areaH / lineGap);

  // Image block rectangle in preview coords.
  const iw = areaW * (Math.min(width, 100) / 100);
  const ih = flow === 'full' ? areaH * 0.22 : Math.min(areaH * 0.5, iw * 0.72);
  const ihFrac = ih / areaH, iwFrac = iw / areaW;
  const img = (() => {
    switch (flow) {
      case 'wrap-left':  return { x: pad, y: pad, w: iw, h: ih };
      case 'wrap-right': return { x: PW - pad - iw, y: pad, w: iw, h: ih };
      case 'float-top':  return { x: pad + (areaW - iw) / 2, y: pad, w: iw, h: ih };
      case 'float-bottom': return { x: pad + (areaW - iw) / 2, y: PH - pad - ih, w: iw, h: ih };
      case 'full':       return { x: pad, y: pad + areaH * 0.30, w: areaW, h: ih };
      case 'free':       return { x: pad + pos.x * areaW, y: pad + pos.y * areaH, w: iw, h: ih };
      default:           return { x: pad + (areaW - iw) / 2, y: pad + areaH * 0.30, w: iw, h: ih }; // below
    }
  })();

  // Free-mode: set position from a pointer, centring the image on the cursor and
  // clamping it inside the page.
  const posFromEvent = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const ax = (e.clientX - r.left - pad) / areaW - iwFrac / 2;
    const ay = (e.clientY - r.top - pad) / areaH - ihFrac / 2;
    setPos({
      x: Math.min(Math.max(ax, 0), 1 - iwFrac),
      y: Math.min(Math.max(ay, 0), 1 - ihFrac),
    });
  };

  // Build the simulated text lines, shortened where they meet the image.
  const lines = Array.from({ length: nLines }, (_, i) => {
    const y = pad + 5 + i * lineGap;
    // A line overlaps the image if its bottom is below the image's top AND its top is above the image's bottom
    const within = (y + lineH) > img.y && y < (img.y + img.h);
    // Block modes (below/float/full): skip lines that fall inside the image band.
    if (within && (flow === 'below' || flow === 'float-top' || flow === 'float-bottom' || flow === 'full')) return null;
    
    let x = pad, w = areaW;
    if (within) {
      if (flow === 'wrap-left') {
        x = img.x + img.w + 6;
        w = PW - pad - x;
      } else if (flow === 'wrap-right') {
        w = img.x - 6 - pad;
      } else if (flow === 'free') {
        // Free mode wraps on whichever side has more space
        if (img.x > areaW / 2) {
          w = img.x - 6 - pad; // wrap left
        } else {
          x = img.x + img.w + 6; // wrap right
          w = PW - pad - x;
        }
      }
    }
    
    // last line of a paragraph is a touch shorter, for realism
    if (i % 5 === 4) w *= 0.72;
    return { y, x, w: Math.max(w, 6) };
  }).filter(Boolean) as { y: number; x: number; w: number }[];

  const onPageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const rx = (e.clientX - r.left) / r.width;
    const ry = (e.clientY - r.top) / r.height;
    if (flow.startsWith('wrap')) setFlow(rx < 0.5 ? 'wrap-left' : 'wrap-right');
    else if (flow.startsWith('float')) setFlow(ry < 0.5 ? 'float-top' : 'float-bottom');
  };

  const insert = () => {
    const image = `image("${imgPath}", width: ${width}%)`;
    const fig = `figure(\n    ${image},\n    caption: [${caption}],\n  )`;
    // The paragraph the text wraps around: the user's selection if they had one,
    // otherwise a placeholder they can replace.
    const wrapBody = bodyText
      ? bodyText.replace(/\n/g, '\n    ')
      : '// Replace this with the text that should wrap around the figure.\n    #lorem(60)';
    let code: string;
    if (flow === 'wrap-left' || flow === 'wrap-right' || flow === 'free') {
      onEnsureImport(WRAP_IMPORT);
      let al: string;
      if (flow === 'free') {
        const hAlign = pos.x > 0.5 ? 'right' : 'left';
        const vAlign = pos.y > 0.5 ? 'bottom' : 'top';
        al = `${vAlign} + ${hAlign}`;
      } else {
        al = flow === 'wrap-left' ? 'top + left' : 'top + right';
      }
      // Text flows around the image with no overlap.
      code = `#wrap-content(\n  ${fig},\n  [\n    ${wrapBody}\n  ],\n  align: ${al},\n)\n`;
    } else if (flow === 'float-top' || flow === 'float-bottom') {
      const p = flow === 'float-top' ? 'top' : 'bottom';
      code = `#figure(\n  ${image},\n  caption: [${caption}],\n  placement: ${p},\n)\n`;
    } else {
      // below / full — a plain block figure (width already set: 100% for full)
      code = `#figure(\n  ${image},\n  caption: [${caption}],\n)\n`;
    }
    onInsert(code);
    onClose();
  };

  const FLOWS: { key: Flow; label: string }[] = [
    { key: 'wrap-right', label: 'Wrap (image right)' },
    { key: 'wrap-left', label: 'Wrap (image left)' },
    { key: 'below', label: 'Below (own line)' },
    { key: 'float-top', label: 'Float to top' },
    { key: 'float-bottom', label: 'Float to bottom' },
    { key: 'full', label: 'Full width' },
    { key: 'free', label: 'Free — drag anywhere' },
  ];
  const hints: Record<Flow, React.ReactNode> = {
    'wrap-right': <>Text flows around the image, which sits at the <b>top-right</b>. Uses the <code>wrap-it</code> package — you type the wrapping text into the placeholder.</>,
    'wrap-left': <>Text flows around the image, which sits at the <b>top-left</b>. Uses the <code>wrap-it</code> package — you type the wrapping text into the placeholder.</>,
    'below': <>A normal figure on its own line; the text you write next simply continues <b>underneath</b> it.</>,
    'float-top': <>The figure <b>floats to the top</b> of whatever page it lands on; body text fills the rest. No fixed position.</>,
    'float-bottom': <>The figure <b>floats to the bottom</b> of its page; body text fills the space above.</>,
    'full': <>The image spans the <b>full text width</b> on its own line — good for wide plots and diagrams.</>,
    'free': <><b>Drag the image anywhere</b> — text wraps around it using <code>wrap-it</code>, automatically aligning based on where you drag it.</>,
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: 720, maxWidth: '95vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{looksLikeImage ? 'Re-place Image' : bodyText ? 'Wrap Text with an Image' : 'Place an Image'}</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          <div style={{ display: 'flex', gap: 22 }}>
            {/* ---------- Live page preview ---------- */}
            <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <div
                onClick={flow === 'free' ? undefined : onPageClick}
                onMouseDown={flow === 'free' ? (e) => { setDragging(true); posFromEvent(e); } : undefined}
                onMouseMove={flow === 'free' && dragging ? posFromEvent : undefined}
                onMouseUp={flow === 'free' ? () => setDragging(false) : undefined}
                onMouseLeave={flow === 'free' ? () => setDragging(false) : undefined}
                title={flow === 'free' ? 'Drag the image anywhere' : flow.startsWith('wrap') ? 'Click left/right to move the image' : flow.startsWith('float') ? 'Click top/bottom to move the image' : undefined}
                style={{
                  position: 'relative', width: PW, height: PH, background: 'var(--bg-color)',
                  border: '1px solid var(--border-color)', borderRadius: 3,
                  boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
                  cursor: flow === 'free' ? (dragging ? 'grabbing' : 'grab') : (flow.startsWith('wrap') || flow.startsWith('float')) ? 'pointer' : 'default',
                  userSelect: 'none',
                }}
              >
                {lines.map((l, i) => (
                  <div key={i} style={{ position: 'absolute', left: l.x, top: l.y, width: l.w, height: lineH, borderRadius: 2, background: 'color-mix(in srgb, var(--text-muted) 42%, transparent)' }} />
                ))}
                <div style={{
                  position: 'absolute', left: img.x, top: img.y, width: img.w, height: img.h,
                  border: '1.5px solid var(--accent)', borderRadius: 4,
                  background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8">
                    <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.6" /><path d="M21 15l-5-5L5 21" />
                  </svg>
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {PAPERS[paper].label} · {width}% width
                {flow === 'free' && <> · at <b style={{ color: 'var(--text-main)' }}>{Math.round(pos.x * 100)}%, {Math.round(pos.y * 100)}%</b></>}
              </div>
            </div>

            {/* ---------- Controls ---------- */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="form-field">
                <span>Text flow — how text behaves around the image</span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 2 }}>
                  {FLOWS.map(f => (
                    <button key={f.key} className={flow === f.key ? 'active' : ''} onClick={() => setMode(f.key)}
                      style={{
                        padding: '8px 10px', borderRadius: 6, fontSize: '0.82rem', cursor: 'pointer', textAlign: 'left',
                        border: '1px solid ' + (flow === f.key ? 'var(--accent)' : 'var(--border-color)'),
                        background: flow === f.key ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'var(--bg-color)',
                        color: flow === f.key ? 'var(--text-main)' : 'var(--text-muted)',
                        fontWeight: flow === f.key ? 600 : 400,
                      }}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="form-row" style={{ marginTop: 12 }}>
                <label className="form-field" style={{ flex: 1 }}>
                  <span>Image path</span>
                  {workspaceImages.length > 0 ? (
                    <select value={imgPath} onChange={e => setImgPath(e.target.value)}>
                      {/* Show typed-in value if it's not in the list */}
                      {!workspaceImages.includes(imgPath) && <option value={imgPath}>{imgPath}</option>}
                      {workspaceImages.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  ) : (
                    <input type="text" value={imgPath} onChange={e => setImgPath(e.target.value)} placeholder="images/figure.png" />
                  )}
                </label>
                <label className="form-field" style={{ maxWidth: 120 }}>
                  <span>Preview page</span>
                  <select value={paper} onChange={e => setPaper(e.target.value)}>
                    {Object.entries(PAPERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                </label>
              </div>
              {/* Manual path entry when images exist (in case the user wants a different path) */}
              {workspaceImages.length > 0 && (
                <label className="form-field" style={{ marginTop: 4 }}>
                  <input type="text" value={imgPath} onChange={e => setImgPath(e.target.value)} placeholder="Or type a custom path…" style={{ fontSize: '0.8rem', padding: '4px 8px', color: 'var(--text-muted)' }} />
                </label>
              )}
              <label className="form-field">
                <span>Caption</span>
                <input type="text" value={caption} onChange={e => setCaption(e.target.value)} placeholder="Figure caption" />
              </label>
              <label className="form-field">
                <span>Width — {width}% of the text block</span>
                <input type="range" min={15} max={100} step={1} value={width} onChange={e => setWidth(Number(e.target.value))} />
              </label>

              <div className="form-hint">{hints[flow]}</div>
              {(flow === 'wrap-left' || flow === 'wrap-right') && (
                <div className="form-hint" style={{ marginTop: 6, color: bodyText ? 'var(--accent)' : undefined }}>
                  {bodyText
                    ? <>✓ Your selected paragraph will wrap around the image.</>
                    : <><b>Tip:</b> select a paragraph in the editor <i>before</i> opening this, and the image will wrap <b>your</b> text instead of a placeholder.</>}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={insert}>{looksLikeImage ? 'Replace image' : bodyText ? 'Wrap my text' : 'Insert image'}</button>
        </div>
      </div>
    </div>
  );
}
