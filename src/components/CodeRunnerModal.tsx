import { useState, useEffect } from 'react';

const API = 'http://localhost:3001';

type Lang = 'python' | 'julia' | 'wolfram';
type Interp = { label: string; path: string };
type Tools = { execEnabled: boolean; interpreters: Record<Lang, Interp[]>; available: Record<Lang, boolean> };
type RunResult = { ok: boolean; stdout: string; stderr: string; images: string[]; timedOut?: boolean; interpreter?: string };

const LANG_FENCE: Record<Lang, string> = { python: 'python', julia: 'julia', wolfram: 'mathematica' };

const TEMPLATES: Record<Lang, { label: string; code: string }[]> = {
  python: [
    { label: 'Compute (text)', code: 'import numpy as np\n\nx = np.linspace(0, 1, 5)\nprint(x.mean())' },
    { label: 'Symbolic → equation (sympy)', code: 'from sympy import *\n\nx = symbols("x")\nexpr = diff(sin(x**2), x)\nprint(latex(expr))' },
    { label: '2D plot', code: 'import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nimport numpy as np\n\nx = np.linspace(0, 2*np.pi, 200)\nplt.figure(figsize=(6,4))\nplt.plot(x, np.sin(x), label="sin")\nplt.legend(); plt.grid(True)\nplt.savefig("figure.png", dpi=150, bbox_inches="tight")\nprint("saved figure.png")' },
    { label: '3D surface', code: 'import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nimport numpy as np\n\nx = np.linspace(-5, 5, 60); y = np.linspace(-5, 5, 60)\nX, Y = np.meshgrid(x, y)\nZ = np.sin(np.sqrt(X**2 + Y**2))\nfig = plt.figure(figsize=(6,5))\nax = fig.add_subplot(111, projection="3d")\nax.plot_surface(X, Y, Z, cmap="viridis")\nplt.savefig("surface3d.png", dpi=150, bbox_inches="tight")\nprint("saved surface3d.png")' },
  ],
  julia: [
    { label: 'Compute (text)', code: 'println(sum(1:100))' },
    { label: 'Linear algebra', code: 'using LinearAlgebra\nA = [2 1; 1 3]\nprintln("eigenvalues: ", eigvals(A))' },
  ],
  wolfram: [
    { label: 'Numeric (text)', code: 'Print[N[Pi, 20]]\nPrint[Integrate[Sin[x], {x, 0, Pi}]]' },
    { label: 'Plot', code: 'Export["wolfram.png", Plot[Sin[x]/x, {x, -10, 10}, ImageSize -> 500]]\nPrint["saved wolfram.png"]' },
  ],
};

// In equation mode the user writes plain maths — output is auto-converted to LaTeX.
const EQ_TEMPLATES: Record<Lang, { label: string; code: string }[]> = {
  python: [
    { label: 'Derivative', code: 'diff(sin(x**2), x)' },
    { label: 'Integral', code: 'integrate(1/(1 + x**2), x)' },
    { label: 'Simplify', code: 'simplify((x**2 - 1)/(x - 1))' },
  ],
  julia: [
    { label: 'Expression', code: '(x + y)^2' },
  ],
  wolfram: [
    { label: 'Derivative', code: 'D[Sin[x^2], x]' },
    { label: 'Integral', code: 'Integrate[1/(1 + x^2), x]' },
    { label: 'Solve', code: 'Solve[a x^2 + b x + c == 0, x]' },
  ],
};

export default function CodeRunnerModal({ onClose, onInsert, onInsertEquation, onChanged, initialLang, initialCode, initialMode }: { onClose: () => void, onInsert: (code: string) => void, onInsertEquation?: (latex: string, codeBlock?: string) => void, onChanged?: () => void, initialLang?: Lang, initialCode?: string, initialMode?: 'text' | 'equation' }) {
  const [tools, setTools] = useState<Tools | null>(null);
  const [lang, setLang] = useState<Lang>(initialLang ?? 'python');
  const [bin, setBin] = useState<string>('');
  const [outputMode, setOutputMode] = useState<'text' | 'equation'>(initialMode ?? 'text');
  const [code, setCode] = useState(initialCode ?? TEMPLATES[initialLang ?? 'python'][0].code);
  const [includeCode, setIncludeCode] = useState(true);
  const templatesFor = (l: Lang, mode: 'text' | 'equation') => (mode === 'equation' ? EQ_TEMPLATES : TEMPLATES)[l];
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);

  useEffect(() => {
    fetch(`${API}/tools`).then(r => r.json()).then((t: Tools) => {
      setTools(t);
      let l = initialLang ?? lang;
      if (!t.available[l]) { l = (['python', 'julia', 'wolfram'] as Lang[]).find(x => t.available[x]) ?? l; setLang(l); if (!initialCode) setCode(TEMPLATES[l][0].code); }
      const saved = localStorage.getItem(`interp_${l}`);
      const opts = t.interpreters[l] || [];
      setBin(opts.find(o => o.path === saved)?.path || opts[0]?.path || '');
    }).catch(() => {});
  }, []);

  const switchLang = (l: Lang) => {
    const mode = l === 'julia' && outputMode === 'equation' ? 'text' : outputMode;
    setLang(l); setOutputMode(mode); setCode(templatesFor(l, mode)[0].code); setResult(null);
    const opts = tools?.interpreters[l] || [];
    const saved = localStorage.getItem(`interp_${l}`);
    setBin(opts.find(o => o.path === saved)?.path || opts[0]?.path || '');
  };

  const switchMode = (mode: 'text' | 'equation') => {
    setOutputMode(mode);
    setCode(templatesFor(lang, mode)[0].code);
    setResult(null);
  };

  const run = async () => {
    setRunning(true); setResult(null);
    try {
      const res = await fetch(`${API}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang, code, bin, outputMode }) });
      const data = await res.json();
      if (!res.ok) { setResult({ ok: false, stdout: '', stderr: data.error || 'Failed.', images: [] }); }
      else { setResult(data); if (data.images?.length && onChanged) onChanged(); }
    } catch {
      setResult({ ok: false, stdout: '', stderr: 'Could not reach the local server.', images: [] });
    } finally { setRunning(false); }
  };

  const codeBlock = () => '```' + LANG_FENCE[lang] + '\n' + code.trim() + '\n```\n';

  const insertText = () => {
    let out = '\n';
    if (includeCode) out += codeBlock() + '\n';
    if (result?.stdout.trim()) out += '*Output:*\n```\n' + result.stdout.trimEnd() + '\n```\n';
    onInsert(out + '\n');
    onClose();
  };

  const insertFigure = async (img: string) => {
    // Promote the sandbox plot into the workspace images/ folder so it lives with
    // the document (and survives sandbox cleanup), then reference it there.
    const base = img.replace(/^sandbox\//, '');
    const dest = `images/${base}`;
    let ref = img;
    try {
      const r = await fetch(`${API}/workspace/copy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: img, to: dest }) });
      if (r.ok) { ref = dest; onChanged?.(); }
    } catch { /* fall back to sandbox path */ }
    let out = '\n';
    if (includeCode) out += codeBlock() + '\n';
    out += `#figure(\n  image("${ref}", width: 70%),\n  caption: [${lang} output],\n)\n`;
    onInsert(out + '\n');
    onClose();
  };

  const interpOptions = tools?.interpreters[lang] || [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '660px', maxHeight: '90vh' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Run Code &amp; Insert</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {tools && !tools.execEnabled && (
            <div className="form-hint" style={{ color: '#fca5a5' }}>Code execution is disabled on this server (ALLOW_CODE_EXECUTION=0).</div>
          )}

          <div className="form-row" style={{ alignItems: 'flex-end' }}>
            <label className="form-field" style={{ maxWidth: 150 }}>
              <span>Language</span>
              <select value={lang} onChange={e => switchLang(e.target.value as Lang)}>
                {(['python', 'julia', 'wolfram'] as Lang[]).map(l => (
                  <option key={l} value={l} disabled={tools ? !tools.available[l] : false}>
                    {l === 'wolfram' ? 'Wolfram' : l[0].toUpperCase() + l.slice(1)}{tools && !tools.available[l] ? ' (n/a)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span>Environment</span>
              <select value={bin} onChange={e => { setBin(e.target.value); localStorage.setItem(`interp_${lang}`, e.target.value); }}>
                {interpOptions.map(o => <option key={o.path} value={o.path}>{o.label}</option>)}
                {interpOptions.length === 0 && <option>None detected</option>}
              </select>
            </label>
            <label className="form-field" style={{ maxWidth: 140 }}>
              <span>Output</span>
              <select value={outputMode} onChange={e => switchMode(e.target.value as any)}>
                <option value="text">Text</option>
                <option value="equation" disabled={lang === 'julia'}>Equation (auto-LaTeX)</option>
              </select>
            </label>
            <label className="form-field" style={{ maxWidth: 150 }}>
              <span>Template</span>
              <select onChange={e => { const t = templatesFor(lang, outputMode)[Number(e.target.value)]; if (t) setCode(t.code); }} value="">
                <option value="" disabled>Examples…</option>
                {templatesFor(lang, outputMode).map((t, i) => <option key={i} value={i}>{t.label}</option>)}
              </select>
            </label>
          </div>
          {outputMode === 'equation' && (
            <div className="form-hint" style={{ marginTop: -6 }}>Just write the maths (e.g. <code>{lang === 'wolfram' ? 'D[Sin[x^2], x]' : 'diff(sin(x**2), x)'}</code>) — the result is converted to a typeset equation automatically.</div>
          )}

          <label className="form-field">
            <span>Code</span>
            <textarea value={code} onChange={e => setCode(e.target.value)} style={{ minHeight: 160, fontSize: '0.85rem' }} spellCheck={false} />
          </label>

          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <button className="btn-primary" onClick={run} disabled={running || (tools ? !tools.execEnabled : false)}>{running ? 'Running…' : `▶ Run`}</button>
            <label className="form-check"><input type="checkbox" checked={includeCode} onChange={e => setIncludeCode(e.target.checked)} /> Include source code in document</label>
          </div>

          {result && (
            <div className="form-field">
              <span>Output {result.interpreter ? `· ${result.interpreter}` : ''} {result.timedOut ? '(timed out)' : ''}</span>
              {result.stdout && <pre style={{ background: 'var(--bg-color)', padding: 10, borderRadius: 6, fontSize: '0.8rem', maxHeight: 130, overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap' }}>{result.stdout}</pre>}
              {result.stderr && <pre style={{ background: 'rgba(127,29,29,0.4)', color: '#fecaca', padding: 10, borderRadius: 6, fontSize: '0.8rem', maxHeight: 130, overflow: 'auto', margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>{result.stderr}</pre>}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {outputMode === 'equation' && onInsertEquation && result.stdout.trim() ? (
                  <button className="btn-primary" onClick={() => { onInsertEquation(result.stdout, includeCode ? codeBlock() : undefined); onClose(); }} title="Render the output as a typeset Typst equation (with the source code if checked)">
                    Insert {includeCode ? 'code + equation' : 'equation'}
                  </button>
                ) : (
                  <>
                    {(result.stdout.trim() || includeCode) && <button className="btn-ghost" onClick={insertText}>Insert {includeCode ? 'code + output' : 'output'}</button>}
                    {onInsertEquation && result.stdout.trim() && (
                      <button className="btn-primary" onClick={() => { onInsertEquation(result.stdout, includeCode ? codeBlock() : undefined); onClose(); }} title="Render the output (LaTeX) as a typeset equation via mitex">
                        Insert as equation
                      </button>
                    )}
                  </>
                )}
                {result.images.map(img => <button key={img} className="btn-primary" onClick={() => insertFigure(img)}>Insert figure: {img.replace('sandbox/', '')}</button>)}
              </div>
            </div>
          )}

          <div className="form-hint">Runs in an isolated <code>sandbox/</code> folder. Save plots with a filename to embed them (Python <code>savefig</code> / Wolfram <code>Export</code>). For <b>Insert as equation</b>, print LaTeX — Wolfram <code>TeXForm</code> or sympy <code>latex()</code>.</div>
        </div>
      </div>
    </div>
  );
}
