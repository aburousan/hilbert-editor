import { useState, useEffect } from 'react';

import { API } from '../api';

type Lang = 'python' | 'julia' | 'wolfram';
type Interp = { label: string; path: string };
type Tools = { execEnabled: boolean; interpreters: Record<Lang, Interp[]>; available: Record<Lang, boolean> };
type RunResult = { ok: boolean; stdout: string; stderr: string; images: string[]; timedOut?: boolean; interpreter?: string };

const LANG_FENCE: Record<Lang, string> = { python: 'python', julia: 'julia', wolfram: 'mathematica' };
// File extension per language — runs are auto-saved into codes/<lang>/ so the
// user keeps a record of every computation inside the project.
const LANG_EXT: Record<Lang, string> = { python: 'py', julia: 'jl', wolfram: 'wls' };

const TEMPLATES: Record<Lang, { label: string; code: string }[]> = {
  python: [
    { label: 'Compute (text)', code: 'import numpy as np\n\nx = np.linspace(0, 1, 5)\nprint(x.mean())' },
    { label: 'Symbolic → equation (sympy)', code: 'from sympy import *\n\nx = symbols("x")\nexpr = diff(sin(x**2), x)\nprint(latex(expr))' },
    { label: '2D plot', code: 'import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nimport numpy as np\n\nx = np.linspace(0, 2*np.pi, 200)\nplt.figure(figsize=(6,4))\nplt.plot(x, np.sin(x), label="sin")\nplt.legend(); plt.grid(True)\nplt.savefig("figure.png", dpi=150, bbox_inches="tight")\nprint("saved figure.png")' },
    { label: '3D surface', code: 'import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nimport numpy as np\n\nx = np.linspace(-5, 5, 60); y = np.linspace(-5, 5, 60)\nX, Y = np.meshgrid(x, y)\nZ = np.sin(np.sqrt(X**2 + Y**2))\nfig = plt.figure(figsize=(6,5))\nax = fig.add_subplot(111, projection="3d")\nax.plot_surface(X, Y, Z, cmap="viridis")\nplt.savefig("surface3d.png", dpi=150, bbox_inches="tight")\nprint("saved surface3d.png")' },
    { label: 'GR: Christoffel symbols (sympy)', code: '# Christoffels of the flat-FRW metric — swap in any metric you like\nfrom sympy import *\n\nt, r, th, ph, k = symbols("t r theta phi k")\na = Function("a")(t)\nx = [t, r, th, ph]\ng = diag(-1, a**2/(1 - k*r**2), a**2*r**2, a**2*r**2*sin(th)**2)\nginv = g.inv()\nfor l in range(4):\n    for m in range(4):\n        for n in range(m, 4):\n            G = simplify(sum(ginv[l, s]*(diff(g[s, m], x[n]) + diff(g[s, n], x[m]) - diff(g[m, n], x[s])) for s in range(4))/2)\n            if G != 0:\n                print(f"Gamma^{x[l]}_({x[m]} {x[n]}) =", G)' },
    { label: 'Cosmology: a(t) from Friedmann (scipy)', code: '# Scale factor for a flat matter + Lambda universe\nimport matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nimport numpy as np\nfrom scipy.integrate import solve_ivp\n\nH0 = 70/3.086e19            # s^-1\nOm, OL = 0.3, 0.7\nadot = lambda t, a: H0*np.sqrt(Om/a + OL*a**2)\nT = 4.6e17                  # ~14.6 Gyr in s\nsol = solve_ivp(adot, [0, T], [1e-3], dense_output=True, rtol=1e-8)\nt = np.linspace(1e-6*T, T, 400)\nplt.figure(figsize=(6,4))\nplt.plot(t/3.156e16, sol.sol(t)[0])\nplt.xlabel("t  [Gyr]"); plt.ylabel("a(t)"); plt.grid(True)\nplt.savefig("friedmann.png", dpi=150, bbox_inches="tight")\nprint("saved friedmann.png")' },
  ],
  julia: [
    { label: 'Compute (text)', code: 'println(sum(1:100))' },
    { label: 'Linear algebra', code: 'using LinearAlgebra\nA = [2 1; 1 3]\nprintln("eigenvalues: ", eigvals(A))' },
    { label: 'Plot (Plots.jl)', code: 'using Plots\nx = range(0, 2π; length = 200)\nplot(x, sin.(x); label = "sin", lw = 2)\nsavefig("julia_plot.png")\nprintln("saved julia_plot.png")' },
    { label: 'QM: harmonic oscillator spectrum', code: '# E_n of x²/2 potential by finite differences — exact: n + 1/2\nusing LinearAlgebra\nN = 400; dx = 0.05\nx = (-(N - 1)/2:(N - 1)/2) .* dx\nT = SymTridiagonal(fill(2.0, N), fill(-1.0, N - 1)) ./ (2dx^2)\nH = Matrix(T) + Diagonal(x .^ 2 ./ 2)\nprintln("lowest levels: ", round.(eigvals(H)[1:5]; digits = 4))' },
  ],
  wolfram: [
    { label: 'Numeric (text)', code: 'Print[N[Pi, 20]]\nPrint[Integrate[Sin[x], {x, 0, Pi}]]' },
    { label: 'Symbolic → TeX', code: 'Print[ToString[TeXForm[Integrate[Exp[-x^2], {x, -Infinity, Infinity}]]]]' },
    { label: 'Solve ODE (DSolve)', code: 'Print[DSolve[y\'\'[x] + w^2 y[x] == 0, y[x], x]]' },
    { label: 'Plot', code: 'Export["wolfram.png", Plot[Sin[x]/x, {x, -10, 10}, ImageSize -> 500]]\nPrint["saved wolfram.png"]' },
    { label: '3D plot', code: 'Export["wolfram3d.png", Plot3D[Sin[x] Cos[y], {x, -3, 3}, {y, -3, 3}, ImageSize -> 500]]\nPrint["saved wolfram3d.png"]' },
    { label: 'GR: Schwarzschild curvature (xAct)', code: `(* Requires xAct installed. Curvature of the Schwarzschild metric via xCoba. *)
Off[General::shdw];
AppendTo[$Path, FileNameJoin[{$UserBaseDirectory, "Applications"}]];
AppendTo[$Path, FileNameJoin[{$HomeDirectory, "Library", "Wolfram", "Applications"}]];
Block[{Print}, Get["xAct\`xCoba\`"]]; xAct\`xCoba\`$CVVerbose = False;
Block[{Print},
  DefManifold[M, 4, {a, b, c, d, e, f}];
  DefChart[ch, M, {0, 1, 2, 3}, {t[], r[], θ[], φ[]}];
  DefMetric[-1, g[-a, -b], CD];
  gS = {{-(1 - 2 m/r[]), 0, 0, 0}, {0, 1/(1 - 2 m/r[]), 0, 0}, {0, 0, r[]^2, 0}, {0, 0, 0, r[]^2 Sin[θ[]]^2}};
  MetricInBasis[g, -ch, gS];
  MetricCompute[g, ch, "Ricci"[-1, -1]];
  MetricCompute[g, ch, "Riemann"[-1, -1, -1, -1]]];
Print["Ricci tensor R_ab = ", Simplify[Table[RicciCD[{i, -ch}, {j, -ch}] // ToValues, {i, 0, 3}, {j, 0, 3}]], "  (=> vacuum solution)"];
gi = Inverse[gS];
Rd = Table[RiemannCD[{i, -ch}, {j, -ch}, {k, -ch}, {l, -ch}] // ToValues, {i, 0, 3}, {j, 0, 3}, {k, 0, 3}, {l, 0, 3}];
raise[Tn_] := Transpose[gi . Tn, RotateRight[Range[ArrayDepth[Tn]]]];
K = Simplify[Total[Rd Nest[raise, Rd, 4], 4]];
Print["Kretschmann K = R_abcd R^abcd = ", K /. r[] -> r];
Print["LaTeX (wrap in $...$ or use mitex): ", ToString[TeXForm[K /. r[] -> r]]];` },
    { label: 'GR: Penrose diagram (Minkowski)', code: `(* Conformal (Penrose) diagram of Minkowski spacetime -> saves penrose.png *)
pp[t_, r_] := ArcTan[t + r]; qq[t_, r_] := ArcTan[t - r];
tt[t_, r_] := pp[t, r] + qq[t, r]; xx[t_, r_] := pp[t, r] - qq[t, r];
cR = Table[ParametricPlot[{xx[t, r], tt[t, r]}, {t, -200, 200}, PlotStyle -> {Blue, Thin}], {r, {0.3, 1, 2, 5, 20}}];
cT = Table[ParametricPlot[{xx[t, r], tt[t, r]}, {r, 0, 200}, PlotStyle -> {Red, Thin}], {t, {-5, -2, -0.01, 2, 5}}];
bnd = Graphics[{Thick, Line[{{0, -Pi}, {Pi, 0}}], Line[{{Pi, 0}, {0, Pi}}], Line[{{0, -Pi}, {0, Pi}}],
  Text[Style[Superscript["i", "+"], 14], {0, Pi}, {0, -1.4}], Text[Style[Superscript["i", "-"], 14], {0, -Pi}, {0, 1.4}], Text[Style[Superscript["i", "0"], 14], {Pi, 0}, {-1.4, 0}],
  Text[Style[Superscript["\\[ScriptCapitalI]", "+"], 14], {Pi/2 + 0.2, Pi/2 + 0.13}], Text[Style[Superscript["\\[ScriptCapitalI]", "-"], 14], {Pi/2 + 0.2, -Pi/2 - 0.13}]}];
Export["penrose.png", Show[cR, cT, bnd, PlotRange -> {{-0.2, Pi + 0.4}, {-Pi - 0.4, Pi + 0.4}}, Axes -> False, ImageSize -> 520, PlotLabel -> Style["Penrose diagram: Minkowski", 14]]];
Print["saved penrose.png  (blue = worldlines r=const, red = slices t=const)"];` },
    { label: 'Clebsch–Gordan table (image)', code: `(* CG coefficients for j1=1 ⊗ j2=1, as a colored change-of-basis matrix -> cg.png *)
j1 = 1; j2 = 1;
ms = Flatten[Table[{m1, m2}, {m1, j1, -j1, -1}, {m2, j2, -j2, -1}], 1];
js = Flatten[Table[{j, m}, {j, j1 + j2, Abs[j1 - j2], -1}, {m, j, -j, -1}], 1];
mat = Quiet[Table[ClebschGordan[{j1, mm[[1]]}, {j2, mm[[2]]}, jm], {jm, js}, {mm, ms}], ClebschGordan::phy];
ket[s_] := "|" <> ToString[s[[1]]] <> "," <> ToString[s[[2]]] <> "\\[RightAngleBracket]";
Quiet[Export["cg.png", MatrixPlot[N[mat], ColorFunction -> "TemperatureMap", PlotLegends -> Automatic,
  FrameTicks -> {{Transpose[{Range[Length[js]], ket /@ js}], None}, {None, Transpose[{Range[Length[ms]], ket /@ ms}]}},
  PlotLabel -> Style["Clebsch-Gordan  1\\[CircleTimes]1", 14], ImageSize -> 560]], FrontEndObject::notavail];
Print["saved cg.png  (rows |j,m>, columns |m1,m2>)"];` },
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
    { label: 'Clebsch–Gordan coefficient', code: 'ClebschGordan[{1, 1}, {1, -1}, {2, 0}]' },
    { label: 'Wigner 3-j symbol', code: 'ThreeJSymbol[{1, 1}, {1, -1}, {2, 0}]' },
  ],
};

export default function CodeRunnerModal({ onClose, onInsert, onInsertEquation, onChanged, initialLang, initialCode, initialMode }: { onClose: () => void, onInsert: (code: string) => void, onInsertEquation?: (latex: string, codeBlock?: string) => void, onChanged?: () => void, initialLang?: Lang, initialCode?: string, initialMode?: 'text' | 'equation' }) {
  const [tools, setTools] = useState<Tools | null>(null);
  const [lang, setLang] = useState<Lang>(initialLang ?? 'python');
  const [bin, setBin] = useState<string>('');
  const [outputMode, setOutputMode] = useState<'text' | 'equation'>(initialMode ?? 'text');
  const [code, setCode] = useState(initialCode ?? TEMPLATES[initialLang ?? 'python'][0].code);
  const [includeCode, setIncludeCode] = useState(true);
  // A stable name for this runner session so re-runs update one file instead of
  // spawning a new one each time.
  const [snippetName] = useState(() => 'snippet-' + Date.now().toString(36));
  const [savedPath, setSavedPath] = useState<string | null>(null);
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
    // Keep every run: persist the current snippet into codes/<lang>/ before it runs.
    const path = `codes/${lang}/${snippetName}.${LANG_EXT[lang]}`;
    try {
      await fetch(`${API}/workspace/file?path=${encodeURIComponent(path)}`, { method: 'POST', body: code, headers: { 'Content-Type': 'text/plain' } });
      setSavedPath(path);
      onChanged?.();
    } catch { /* saving is best-effort; a run should still proceed offline */ }
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
      <div className="modal-content" style={{ width: '960px', maxWidth: '96vw', maxHeight: '90vh' }} onClick={e => e.stopPropagation()}>
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

          <div style={{ display: 'flex', gap: 14, alignItems: 'center', margin: '2px 0' }}>
            <button className="btn-primary" onClick={run} disabled={running || (tools ? !tools.execEnabled : false)}>{running ? 'Running…' : `▶ Run`}</button>
            <label className="form-check"><input type="checkbox" checked={includeCode} onChange={e => setIncludeCode(e.target.checked)} /> Include source code in document</label>
            {savedPath && <span className="form-hint" style={{ margin: 0, opacity: 0.7 }} title="Every run is kept in the project">💾 saved to <code>{savedPath}</code></span>}
          </div>

          {/* Code on the left, output on the right — run and read them together. */}
          <div style={{ display: 'flex', gap: 14, alignItems: 'stretch' }}>
            <label className="form-field" style={{ flex: 1, minWidth: 0, marginBottom: 0 }}>
              <span>Code</span>
              <textarea value={code} onChange={e => setCode(e.target.value)} style={{ minHeight: 260, height: '100%', fontSize: '0.85rem', resize: 'vertical' }} spellCheck={false} />
            </label>
            <div className="form-field" style={{ flex: 1, minWidth: 0, marginBottom: 0, display: 'flex', flexDirection: 'column' }}>
              <span>Output {result?.interpreter ? `· ${result.interpreter}` : ''} {result?.timedOut ? '(timed out)' : ''}</span>
              <div style={{ flex: 1, minHeight: 260, background: 'var(--bg-color)', borderRadius: 6, padding: 10, overflow: 'auto' }}>
                {running ? (
                  <span className="form-hint" style={{ margin: 0 }}>Running…</span>
                ) : result ? (
                  <>
                    {result.stdout && <pre style={{ fontSize: '0.8rem', margin: 0, whiteSpace: 'pre-wrap' }}>{result.stdout}</pre>}
                    {result.stderr && <pre style={{ color: '#fecaca', fontSize: '0.8rem', margin: result.stdout ? '6px 0 0' : 0, whiteSpace: 'pre-wrap' }}>{result.stderr}</pre>}
                    {result.images.map(img => (
                      <img key={img} src={`${API}/workspace/raw?path=${encodeURIComponent(img)}`} alt={img} style={{ maxWidth: '100%', marginTop: 8, borderRadius: 4, display: 'block' }} />
                    ))}
                    {!result.stdout && !result.stderr && !result.images.length && <span className="form-hint" style={{ margin: 0 }}>(no output)</span>}
                  </>
                ) : (
                  <span className="form-hint" style={{ margin: 0, opacity: 0.6 }}>Press ▶ Run to see the output here.</span>
                )}
              </div>
            </div>
          </div>

          {result && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
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
          )}

          <div className="form-hint">Runs in an isolated <code>sandbox/</code> folder. Save plots with a filename to embed them (Python <code>savefig</code> / Wolfram <code>Export</code>). For <b>Insert as equation</b>, print LaTeX — Wolfram <code>TeXForm</code> or sympy <code>latex()</code>.</div>
        </div>
      </div>
    </div>
  );
}
