import { useEffect, useMemo, useState } from 'react';
import { API } from '../api';

// Boxed asides — the "keep this number in your head" kind. Pick what the box is
// for and the colour, the rule and the title style follow from that, rather
// than from eight separate controls.
//
// A plain block, not showybox: it needs no package, and its rule runs the whole
// height of the box whether or not the box may break across pages, which
// showybox's does not.

type Rule = 'left' | 'full' | 'none';

type Preset = {
  key: string;
  label: string;
  colour: string;
  title: string;
  body: string;
};

// Named after what a writer is doing, not after a colour. The bodies are the
// examples someone would actually write, so the preview says something.
const PRESETS: Preset[] = [
  {
    key: 'remember', label: 'Remember', colour: '#e2622a',
    title: 'Keep this number in your head',
    body: '$nu_"pk" approx 1900$ GHz. Every band we use sits below the peak — we are measuring the rising side of a curve whose turnover we never see.',
  },
  {
    key: 'note', label: 'Note', colour: '#2563eb',
    title: 'A note on conventions',
    body: 'Throughout, $c = \u210f = 1$ and the metric signature is $(-, +, +, +)$.',
  },
  {
    key: 'careful', label: 'Careful', colour: '#b45309',
    title: 'This is where it goes wrong',
    body: 'The integral converges only for $s > 1$. Below that the sum has to be continued analytically instead.',
  },
  {
    key: 'result', label: 'Result', colour: '#7c3aed',
    title: 'What we found',
    body: 'The measured emissivity is negative at twenty sigma, which no dust model allows — the survey, not the fit, is the culprit.',
  },
  {
    key: 'proof', label: 'Worked example', colour: '#047857',
    title: 'Worked example',
    body: 'Take $f(x) = e^x sin x$. Differentiating once gives $e^x (sin x + cos x)$, and the phase shift of $pi slash 4$ is already visible.',
  },
  {
    key: 'aside', label: 'Aside', colour: '#64748b',
    title: 'Aside',
    body: 'Hubble wrote the constant as $K$; the letter $H$ only settled later.',
  },
];

// A tint of the accent for the paper, dark enough to read black text on.
const tint = (hex: string, strength: number) => `rgb("${hex}").lighten(${strength}%)`;

export default function CalloutBuilder({ onClose, onInsert }: {
  onClose: () => void,
  onInsert: (code: string) => void,
}) {
  const [preset, setPreset] = useState(PRESETS[0]);
  const [colour, setColour] = useState(PRESETS[0].colour);
  const [title, setTitle] = useState(PRESETS[0].title);
  const [body, setBody] = useState(PRESETS[0].body);
  const [rule, setRule] = useState<Rule>('left');
  const [thickness, setThickness] = useState(3);
  const [strength, setStrength] = useState(88);
  const [rounded, setRounded] = useState(true);
  const [breakable, setBreakable] = useState(true);
  const [showTitle, setShowTitle] = useState(true);

  const choose = (p: Preset) => {
    setPreset(p); setColour(p.colour);
    setTitle(p.title); setBody(p.body);
  };

  const code = useMemo(() => {
    const stroke = rule === 'left' ? `(left: ${thickness}pt + rgb("${colour}"))`
      : rule === 'full' ? `${thickness}pt + rgb("${colour}")`
      : 'none';
    const lines = [
      '#block(',
      `  fill: ${tint(colour, strength)},`,
      `  stroke: ${stroke},`,
      `  radius: ${rounded ? '4pt' : '0pt'},`,
      '  inset: (x: 12pt, y: 10pt),',
      '  width: 100%,',
      `  breakable: ${breakable},`,
      ')[',
    ];
    // The title is told apart by weight and colour rather than by a second
    // coloured strip across the top of the box.
    if (showTitle && title.trim()) lines.push(`  #text(fill: rgb("${colour}"), weight: "bold")[${title.trim()}]`, '');
    lines.push(`  ${body.trim()}`, ']');
    return lines.join('\n');
  }, [colour, strength, rule, thickness, rounded, breakable, showTitle, title, body]);

  const [preview, setPreview] = useState<{ state: 'idle' | 'loading' | 'error'; url?: string }>({ state: 'idle' });
  useEffect(() => {
    let cancelled = false;
    setPreview(p => ({ ...p, state: 'loading' }));
    const doc = `#set page(width: 15cm, height: auto, margin: 10pt)\n#set text(size: 11pt)\n${code}\n`;
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`${API}/template/render-preview`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ entry: 'p.typ', files: [{ path: 'p.typ', content: doc }] }),
        });
        if (cancelled) return;
        if (!res.ok) { setPreview({ state: 'error' }); return; }
        const blob = await res.blob();
        if (cancelled) return;
        setPreview({ state: 'idle', url: URL.createObjectURL(blob) });
      } catch { if (!cancelled) setPreview({ state: 'error' }); }
    }, 400);
    return () => { cancelled = true; clearTimeout(id); };
  }, [code]);
  useEffect(() => () => { if (preview.url) URL.revokeObjectURL(preview.url); }, [preview.url]);

  const insert = () => onInsert('\n' + code + '\n\n');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: 880, maxWidth: '96vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Boxed aside</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div className="modal-body" style={{ flexDirection: 'row', gap: 20, alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 340px', minWidth: 300, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="dropdown-header" style={{ padding: 0, marginBottom: 6 }}>What is this box for</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
              {PRESETS.map(p => (
                <button key={p.key} onClick={() => choose(p)}
                  title={p.title}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 999,
                    border: `1px solid ${preset.key === p.key ? p.colour : 'var(--border-color)'}`,
                    background: preset.key === p.key ? `${p.colour}1f` : 'transparent',
                    color: preset.key === p.key ? p.colour : 'var(--text-main)',
                    cursor: 'pointer', fontSize: '0.82rem', fontWeight: preset.key === p.key ? 600 : 400,
                  }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: p.colour, display: 'inline-block' }} />
                  {p.label}
                </button>
              ))}
            </div>

            <label className="form-field">
              <span>Title</span>
              <input type="text" value={title} onChange={e => setTitle(e.target.value)} disabled={!showTitle} placeholder="Keep this number in your head" />
            </label>
            <label className="form-field">
              <span>Body — Typst markup, maths included</span>
              <textarea rows={5} value={body} onChange={e => setBody(e.target.value)} style={{ resize: 'vertical' }} />
            </label>

            <div className="dropdown-header" style={{ padding: 0, margin: '12px 0 6px' }}>Colour</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {['#e2622a', '#2563eb', '#b45309', '#7c3aed', '#047857', '#be123c', '#0891b2', '#64748b'].map(c => (
                <button key={c} onClick={() => setColour(c)} title={c}
                  style={{
                    width: 22, height: 22, borderRadius: 6, background: c, cursor: 'pointer',
                    border: colour.toLowerCase() === c ? '2px solid var(--text-main)' : '1px solid rgba(0,0,0,0.25)',
                  }} />
              ))}
              <input type="color" value={colour} onChange={e => setColour(e.target.value)} style={{ width: 34, height: 26, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }} />
              <input type="text" value={colour} onChange={e => setColour(e.target.value.trim())} style={{ width: 88 }} />
            </div>

            <div className="dropdown-header" style={{ padding: 0, margin: '14px 0 6px' }}>Rule</div>
            <div className="seg">
              {([['left', 'Line on the left'], ['full', 'All round'], ['none', 'No line']] as const).map(([k, label]) => (
                <button key={k} className={rule === k ? 'active' : ''} onClick={() => setRule(k as Rule)}>{label}</button>
              ))}
            </div>
            {rule !== 'none' && (
              <label className="form-field" style={{ marginTop: 8 }}>
                <span>Line width — {thickness}pt</span>
                <input type="range" min={1} max={8} step={0.5} value={thickness} onChange={e => setThickness(Number(e.target.value))} />
              </label>
            )}
            <label className="form-field" style={{ marginTop: 4 }}>
              <span>Background — {strength === 100 ? 'none' : `${100 - strength}% of the colour`}</span>
              <input type="range" min={70} max={100} step={1} value={strength} onChange={e => setStrength(Number(e.target.value))} />
            </label>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={showTitle} onChange={e => setShowTitle(e.target.checked)} /> Title
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={rounded} onChange={e => setRounded(e.target.checked)} /> Rounded corners
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={breakable} onChange={e => setBreakable(e.target.checked)} /> May break across pages
              </label>
            </div>
          </div>

          <div style={{ flex: '1 1 400px', minWidth: 320, position: 'sticky', top: 0, alignSelf: 'flex-start' }}>
            <div className="dropdown-header" style={{ padding: 0, marginBottom: 8 }}>How it will look</div>
            <div style={{
              border: '1px solid var(--border-color)', borderRadius: 6, padding: 12, background: '#fff',
              minHeight: 150, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {preview.state === 'error' ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.84rem' }}>That does not compile yet — check the Typst markup in the body.</div>
              ) : preview.url ? (
                <img src={preview.url} alt="callout preview" style={{ maxWidth: '100%', opacity: preview.state === 'loading' ? 0.55 : 1, transition: 'opacity 0.15s' }} />
              ) : (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.84rem' }}>Drawing…</div>
              )}
            </div>
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: 'pointer', fontSize: '0.8rem', color: 'var(--text-muted)' }}>The Typst it writes</summary>
              <pre style={{ fontSize: '0.74rem', overflowX: 'auto', marginTop: 6 }}>{code}</pre>
            </details>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={insert}>Insert</button>
        </div>
      </div>
    </div>
  );
}
