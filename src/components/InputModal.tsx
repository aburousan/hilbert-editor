import { useState, useRef } from 'react';

// --- colour maths ----------------------------------------------------------
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h /= 6; if (h < 0) h += 1; }
  return [h, mx ? d / mx : 0, mx];
}
const toHex = (r: number, g: number, b: number) => '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');

const SWATCHES = [
  '#000000', '#334155', '#64748b', '#e2e8f0', '#ffffff',
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#facc15',
  '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#3b82f6',
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
];

// A draggable colour-grid picker (saturation/value square + hue & alpha bars +
// swatches) → emits a Typst `rgb("#rrggbb")` / `#rrggbbaa` string.
function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const m = /#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?/.exec(value || '');
  const ir = m ? parseInt(m[1].slice(0, 2), 16) : 59, ig = m ? parseInt(m[1].slice(2, 4), 16) : 130, ib = m ? parseInt(m[1].slice(4, 6), 16) : 246;
  const [hsv, setHsv] = useState<[number, number, number]>(() => rgbToHsv(ir, ig, ib));
  const [a, setA] = useState(m && m[2] ? parseInt(m[2], 16) : 255);
  const [h, s, v] = hsv;
  const [r, g, b] = hsvToRgb(h, s, v);
  const hex = toHex(r, g, b);

  const emit = (nh: number, ns: number, nv: number, na: number) => {
    const [rr, gg, bb] = hsvToRgb(nh, ns, nv);
    const aa = na >= 255 ? '' : na.toString(16).padStart(2, '0');
    onChange(`rgb("${toHex(rr, gg, bb)}${aa}")`);
  };

  // Generic pointer-drag on a bar/box: calls `on(fx, fy)` with fractions 0..1.
  const drag = (el: HTMLElement, e: React.PointerEvent, on: (fx: number, fy: number) => void) => {
    const move = (cx: number, cy: number) => {
      const rect = el.getBoundingClientRect();
      on(Math.min(1, Math.max(0, (cx - rect.left) / rect.width)), Math.min(1, Math.max(0, (cy - rect.top) / rect.height)));
    };
    move(e.clientX, e.clientY);
    const mv = (ev: PointerEvent) => move(ev.clientX, ev.clientY);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const svRef = useRef<HTMLDivElement | null>(null);
  const hueRef = useRef<HTMLDivElement | null>(null);
  const alphaRef = useRef<HTMLDivElement | null>(null);
  const setFromHex = (hx: string) => { const [nh, ns, nv] = rgbToHsv(parseInt(hx.slice(1, 3), 16), parseInt(hx.slice(3, 5), 16), parseInt(hx.slice(5, 7), 16)); setHsv([nh, ns, nv]); emit(nh, ns, nv, a); };
  const hueRgb = toHex(...hsvToRgb(h, 1, 1));
  const checker = 'linear-gradient(45deg,#bbb 25%,transparent 25%,transparent 75%,#bbb 75%),linear-gradient(45deg,#bbb 25%,#fff 25%,#fff 75%,#bbb 75%)';

  return (
    <div style={{ background: 'var(--bg-color)', borderRadius: 8, padding: 10 }}>
      <div style={{ display: 'flex', gap: 10 }}>
        {/* SV square */}
        <div ref={svRef} onPointerDown={e => { e.preventDefault(); drag(svRef.current!, e, (fx, fy) => { const ns = fx, nv = 1 - fy; setHsv([h, ns, nv]); emit(h, ns, nv, a); }); }}
          style={{ position: 'relative', width: 150, height: 110, borderRadius: 6, cursor: 'crosshair', touchAction: 'none', background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueRgb})` }}>
          <div style={{ position: 'absolute', left: `${s * 100}%`, top: `${(1 - v) * 100}%`, width: 12, height: 12, transform: 'translate(-50%,-50%)', borderRadius: '50%', border: '2px solid #fff', boxShadow: '0 0 2px #000', pointerEvents: 'none' }} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
          {/* Hue bar */}
          <div ref={hueRef} onPointerDown={e => { e.preventDefault(); drag(hueRef.current!, e, (fx) => { setHsv([fx, s, v]); emit(fx, s, v, a); }); }}
            style={{ position: 'relative', height: 14, borderRadius: 7, cursor: 'pointer', touchAction: 'none', background: 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)' }}>
            <div style={{ position: 'absolute', left: `${h * 100}%`, top: '50%', width: 10, height: 10, transform: 'translate(-50%,-50%)', borderRadius: '50%', border: '2px solid #fff', boxShadow: '0 0 2px #000', pointerEvents: 'none' }} />
          </div>
          {/* Alpha bar */}
          <div ref={alphaRef} onPointerDown={e => { e.preventDefault(); drag(alphaRef.current!, e, (fx) => { const na = Math.round(fx * 255); setA(na); emit(h, s, v, na); }); }}
            style={{ position: 'relative', height: 14, borderRadius: 7, cursor: 'pointer', touchAction: 'none', background: `${checker}, linear-gradient(to right, transparent, ${hex})`, backgroundSize: '8px 8px, 100%', backgroundBlendMode: 'normal' }}>
            <div style={{ position: 'absolute', inset: 0, borderRadius: 7, background: `linear-gradient(to right, transparent, ${hex})` }} />
            <div style={{ position: 'absolute', left: `${(a / 255) * 100}%`, top: '50%', width: 10, height: 10, transform: 'translate(-50%,-50%)', borderRadius: '50%', border: '2px solid #fff', boxShadow: '0 0 2px #000', pointerEvents: 'none' }} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 26, height: 26, borderRadius: 5, background: checker, backgroundSize: '8px 8px', border: '1px solid var(--border-color)', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', inset: 0, background: hex, opacity: a / 255 }} />
            </div>
            <code style={{ fontSize: 11 }}>{hex}{a < 255 ? a.toString(16).padStart(2, '0') : ''}</code>
          </div>
        </div>
      </div>
      {/* Swatch grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 4, marginTop: 8 }}>
        {SWATCHES.map(sw => (
          <button key={sw} type="button" onClick={() => setFromHex(sw)} title={sw}
            style={{ height: 18, borderRadius: 4, background: sw, border: hex.toLowerCase() === sw ? '2px solid var(--accent, #a78bfa)' : '1px solid var(--border-color)', cursor: 'pointer', padding: 0 }} />
        ))}
      </div>
    </div>
  );
}

type Field = {
  key: string;
  label: string;
  placeholder?: string;
  type?: 'text' | 'number' | 'textarea' | 'checkbox' | 'select' | 'color';
  default?: string;
  options?: string[];        // datalist suggestions (text) or option list (select)
  hint?: string;
};

export type InputModalConfig = {
  title: string;
  fields: Field[];
  submitLabel?: string;
  onSubmit: (values: Record<string, string>) => void;
};

export default function InputModal({ title, fields, submitLabel = 'Insert', onSubmit, onClose }: InputModalConfig & { onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(
    () => Object.fromEntries(fields.map(f => [f.key, f.default ?? '']))
  );

  const submit = () => { onSubmit(values); onClose(); };
  const set = (k: string, v: string) => setValues(prev => ({ ...prev, [k]: v }));
  const listId = (k: string) => `dl-${k}`;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '460px' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {fields.map(f => f.type === 'checkbox' ? (
            <label className="form-check" key={f.key} style={{ marginTop: 2 }}>
              <input type="checkbox" checked={values[f.key] === 'true'} onChange={e => set(f.key, e.target.checked ? 'true' : 'false')} />
              {f.label}
            </label>
          ) : f.type === 'select' ? (
            <label className="form-field" key={f.key}>
              <span>{f.label}</span>
              <select value={values[f.key]} onChange={e => set(f.key, e.target.value)}>
                {(f.options || []).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              {f.hint && <span className="form-hint" style={{ fontWeight: 400 }}>{f.hint}</span>}
            </label>
          ) : f.type === 'color' ? (
            <div className="form-field" key={f.key}>
              <span>{f.label}</span>
              <ColorField value={values[f.key]} onChange={v => set(f.key, v)} />
              {f.hint && <span className="form-hint" style={{ fontWeight: 400 }}>{f.hint}</span>}
            </div>
          ) : (
            <label className="form-field" key={f.key}>
              <span>{f.label}</span>
              {f.type === 'textarea' ? (
                <textarea
                  autoFocus={f === fields[0]}
                  value={values[f.key]}
                  placeholder={f.placeholder}
                  onChange={e => set(f.key, e.target.value)}
                />
              ) : (
                <>
                  <input
                    autoFocus={f === fields[0]}
                    type={f.type === 'number' ? 'number' : 'text'}
                    value={values[f.key]}
                    placeholder={f.placeholder}
                    list={f.options ? listId(f.key) : undefined}
                    onChange={e => set(f.key, e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') submit(); }}
                  />
                  {f.options && (
                    <datalist id={listId(f.key)}>
                      {f.options.map(o => <option key={o} value={o} />)}
                    </datalist>
                  )}
                </>
              )}
              {f.hint && <span className="form-hint" style={{ fontWeight: 400 }}>{f.hint}</span>}
            </label>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={submit}>{submitLabel}</button>
        </div>
      </div>
    </div>
  );
}
