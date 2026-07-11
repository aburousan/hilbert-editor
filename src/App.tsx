import React, { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { API } from './api';
import Editor, { useMonaco } from '@monaco-editor/react';
import ImageEditor from './ImageEditor';
import ExcalidrawEditor from './ExcalidrawEditor';
import { setupTypstLanguage, setWorkspaceImages } from './typstMonaco';
import { useProofread } from './proofread';
import ProofreadPanel from './components/ProofreadPanel';
import { tokenizeLine, bestMatch, type SyncPayload } from './syncMatch';
import type { PdfHandle } from './components/PdfPreview';
import { PackageInstaller } from './PackageInstaller';
import { TemplateInstaller } from './TemplateInstaller';
import type { BuiltinTemplate } from './builtinTemplates';
import DiagramBuilder from './components/DiagramBuilder';
import FigureBuilder from './components/FigureBuilder';
import QuiverDiagram from './components/QuiverDiagram';
import EditSettings from './components/EditSettings';
import SymbolPicker from './components/SymbolPicker';
import DriveSyncModal from './components/DriveSyncModal';
import AppSettingsModal from './components/AppSettingsModal';
import InputModal, { type InputModalConfig } from './components/InputModal';
import CodeRunnerModal from './components/CodeRunnerModal';
import CommandPalette, { type PaletteCommand } from './components/CommandPalette';
import SaveAsModal from './components/SaveAsModal';
import PdfPreview from './components/PdfPreview';
// Loaded on demand: pulls in all of three.js, which nothing else needs.
const Plot3DStudio = lazy(() => import('./components/Plot3DStudio'));
const PlotStudio = lazy(() => import('./components/PlotStudio'));
const FeynmanBuilder = lazy(() => import('./components/FeynmanBuilder'));
const EquationGallery = lazy(() => import('./components/EquationGallery'));
const PhysicsGallery = lazy(() => import('./components/PhysicsGallery'));
const HelpModal = lazy(() => import('./components/HelpModal'));
import type { EqTemplate } from './components/EquationGallery';
const FlowchartCoder = lazy(() => import('./components/FlowchartCoder'));
const MatrixStudio = lazy(() => import('./components/MatrixStudio'));
const ImagePlacer = lazy(() => import('./components/ImagePlacer'));
import SymbolDraw from './components/SymbolDraw';
import Boundary from './components/Boundary';
import Toaster from './components/Toaster';
import DataImportModal from './components/DataImportModal';
import { notify } from './notify';
import RefManager from './components/RefManager';
import BibManager from './components/BibManager';
import './index.css';

const SURFACE_3D_TEMPLATE = `import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

x = np.linspace(-5, 5, 60)
y = np.linspace(-5, 5, 60)
X, Y = np.meshgrid(x, y)
Z = np.sin(np.sqrt(X**2 + Y**2))

fig = plt.figure(figsize=(6,5))
ax = fig.add_subplot(111, projection="3d")
ax.plot_surface(X, Y, Z, cmap="viridis")
ax.set_xlabel("x"); ax.set_ylabel("y"); ax.set_zlabel("z")
plt.savefig("surface3d.png", dpi=150, bbox_inches="tight")
print("saved surface3d.png")`;


// Boxed theorem-like environments (showybox). Each `kind` gets its own counter.
const THEOREM_SETUP_BOXED = `#import "@preview/showybox:2.0.4": showybox
#let _thmbox(kind, title, color) = {
  let c = counter("thm-" + kind)
  (name: none, body) => {
    c.step()
    context {
      let head = [#title #c.display()] + if name != none { [ (#name)] }
      showybox(title: head, frame: (title-color: rgb(color), border-color: rgb(color), body-color: rgb(color).lighten(88%), title-inset: 6pt), body)
    }
  }
}
#let theorem = _thmbox("theorem", "Theorem", "#2563eb")
#let lemma = _thmbox("lemma", "Lemma", "#7c3aed")
#let corollary = _thmbox("corollary", "Corollary", "#0891b2")
#let proposition = _thmbox("proposition", "Proposition", "#c026d3")
#let definition = _thmbox("definition", "Definition", "#059669")
#let remark = _thmbox("remark", "Remark", "#64748b")
#let example = _thmbox("example", "Example", "#d97706")
#let proof(body) = block(inset: (left: 2pt))[_Proof._ #body #h(1fr) $square$]`;

// Theorem-like environments (lemming). Each `kind` gets its own counter.
const THEOREM_SETUP = `#import "@preview/lemming:0.3.1" as lem
#let theorem = lem.environment.with(kind: "theorem")
#let lemma = lem.environment.with(kind: "lemma")
#let corollary = lem.environment.with(kind: "corollary")
#let proposition = lem.environment.with(kind: "proposition")
#let definition = lem.environment.with(kind: "definition")
#let remark = lem.environment.with(kind: "remark")
#let example = lem.environment.with(kind: "example")
#let proof = lem.proof
#show: lem.prepare()`;

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
  size?: number;
  mtime?: number;
  matches?: { lineNum: number; text: string }[];
}
type Tab = { path: string; content: string; isDirty: boolean };

// Show rule injected once when a notebook runs: badges each python/julia code
// block in the compiled PDF with its language logo (files under .hilbert/logos/,
// created by the backend on compile).
const NB_LOGO_MARKER = '#show raw.where(block: true, lang: "python")';
const NB_LOGO_SHOW_RULE = `// Language logo beside python/julia code blocks (Hilbert)
#show raw.where(block: true, lang: "python"): it => block(width: 100%, breakable: false, { place(top + right, dy: -3pt, box(height: 1.15em, image(".hilbert/logos/python.svg"))); it })
#show raw.where(block: true, lang: "julia"): it => block(width: 100%, breakable: false, { place(top + right, dy: -3pt, box(height: 1.15em, image(".hilbert/logos/julia.svg"))); it })

`;

const DEFAULT_CODE = `#set page(paper: "a4", numbering: "1")
#set text(font: "New Computer Modern", size: 11pt)

// Sections and equations are numbered by default:
#set heading(numbering: "1.")
#set math.equation(numbering: "(1)")

#import "@preview/cetz:0.3.4"
#import "@preview/physica:0.9.8": *

= Typst with Physics and CeTZ!

This is a local, offline editor for *Typst*. It comes pre-configured with packages!
`;

// Stable no-op so the read-only PDF viewer (opened .pdf tabs) keeps PdfPreview's
// memo intact instead of re-rendering on every parent render.
const NOOP_REVERSE_SYNC = () => {};

// Proofreading (spelling + grammar) is finished. This flag exposes it in the UI;
// it remains off per-user until toggled on (persisted in localStorage).
const PROOFREAD_FEATURE_ENABLED = true;

interface HistoryEntry {
  id: string;
  timestamp: number;
  path: string;
  content: string;
}

// Best-effort LaTeX math → Typst math, for labels coming out of quiver (which
// are written for KaTeX). Covers the symbols that show up in commutative
// diagrams; anything unknown just has its backslash dropped, which is already
// right for Greek letters and many operator names.
const LATEX_FN: Record<string, string> = {
  mathbb: 'bb', mathcal: 'cal', mathfrak: 'frak', mathbf: 'bold', boldsymbol: 'bold',
  mathsf: 'sans', mathtt: 'mono', mathrm: 'upright', text: 'upright', textrm: 'upright',
  operatorname: 'op', hat: 'hat', tilde: 'tilde', vec: 'arrow', bar: 'macron',
  overline: 'overline', underline: 'underline', dot: 'dot', ddot: 'dot.double', sqrt: 'sqrt',
};
const LATEX_SYM: Record<string, string> = {
  bullet: 'bullet', circ: 'compose', cdot: 'dot.op', ast: 'ast', star: 'star',
  times: 'times', otimes: 'times.o', oplus: 'plus.o', ominus: 'minus.o',
  odot: 'dot.o', pm: 'plus.minus', mp: 'minus.plus', div: 'div',
  to: 'arrow.r', rightarrow: 'arrow.r', longrightarrow: 'arrow.r.long', leftarrow: 'arrow.l',
  longleftarrow: 'arrow.l.long', leftrightarrow: 'arrow.l.r', Rightarrow: 'arrow.r.double',
  Leftarrow: 'arrow.l.double', Leftrightarrow: 'arrow.l.r.double', mapsto: 'arrow.r.bar',
  longmapsto: 'arrow.r.long.bar', hookrightarrow: 'arrow.r.hook', hookleftarrow: 'arrow.l.hook',
  twoheadrightarrow: 'arrow.r.twohead', rightharpoonup: 'harpoon.rt', uparrow: 'arrow.t',
  downarrow: 'arrow.b', Uparrow: 'arrow.t.double', Downarrow: 'arrow.b.double',
  nearrow: 'arrow.tr', searrow: 'arrow.br', swarrow: 'arrow.bl', nwarrow: 'arrow.tl',
  infty: 'infinity', partial: 'partial', emptyset: 'nothing', varnothing: 'nothing',
  setminus: 'without', subseteq: 'subset.eq', supseteq: 'supset.eq', notin: 'in.not',
  ni: 'in.rev', cup: 'union', cap: 'inter', bigcup: 'union.big', bigcap: 'inter.big',
  wedge: 'and', vee: 'or', lnot: 'not', neg: 'not',
  neq: 'eq.not', ne: 'eq.not', leq: 'lt.eq', le: 'lt.eq', geq: 'gt.eq', ge: 'gt.eq',
  ll: 'lt.double', gg: 'gt.double', cong: 'tilde.equiv', simeq: 'tilde.eq', sim: 'tilde.op',
  propto: 'prop', langle: 'chevron.l', rangle: 'chevron.r',
  ldots: 'dots.h', cdots: 'dots.h.c', vdots: 'dots.v', ddots: 'dots.down',
  hbar: 'ℏ', dagger: 'dagger', ddagger: 'dagger.double',
  int: 'integral', oint: 'integral.cont', prod: 'product', coprod: 'product.co',
  bigoplus: 'plus.o.big', bigotimes: 'times.o.big',
  varepsilon: 'epsilon.alt', varphi: 'phi.alt', vartheta: 'theta.alt', varrho: 'rho.alt',
  Box: 'square.stroked', perp: 'perp', parallel: 'parallel',
};
export const latexMathToTypst = (s: string): string => {
  let out = s;
  for (let i = 0; i < 8 && /\\frac\s*\{[^{}]*\}\s*\{[^{}]*\}/.test(out); i++)
    out = out.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
  for (let i = 0; i < 8 && /\\[a-zA-Z]+\s*\{[^{}]*\}/.test(out); i++)
    out = out.replace(/\\([a-zA-Z]+)\s*\{([^{}]*)\}/g,
      (_, name, body) => `${LATEX_FN[name] ?? LATEX_SYM[name] ?? name}(${body})`);
  out = out.replace(/\\([a-zA-Z]+)/g, (_, name) => (LATEX_SYM[name] ?? LATEX_FN[name] ?? name) + ' ');
  out = out.replace(/\{/g, '(').replace(/\}/g, ')');
  return out.replace(/\s+([_^])/g, '$1').replace(/\s{2,}/g, ' ').trim();
};

// Palette for the toolbar text-colour button.
const TEXT_COLORS = ['#000000', '#64748b', '#ef4444', '#f97316', '#f59e0b', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899', '#b91c1c', '#166534', '#1e3a8a'];
// Soft, readable marker tints for the highlight popover (text stays legible on top).
const HIGHLIGHT_COLORS = ['#fff59d', '#fde68a', '#bbf7d0', '#a7f3d0', '#bfdbfe', '#c7d2fe', '#ddd6fe', '#fbcfe8', '#fecaca', '#e2e8f0'];
const FONT_SIZE_PRESETS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72];

// --- File → Open Recent -------------------------------------------------------
// Desktop entries store the absolute path; Chrome/Edge entries store the
// FileSystemDirectoryHandle in IndexedDB (handles survive reloads there —
// localStorage can't hold them). Metadata lives in localStorage.
type RecentFolder = { name: string, path?: string, idb?: string, when: number };

const idbOpen = (): Promise<IDBDatabase> => new Promise((res, rej) => {
  const r = indexedDB.open('typst-editor', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('handles');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
const idbPut = async (key: string, val: any) => {
  const d = await idbOpen();
  return new Promise<void>((res, rej) => {
    const t = d.transaction('handles', 'readwrite');
    t.objectStore('handles').put(val, key);
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
};
const idbGet = async (key: string) => {
  const d = await idbOpen();
  return new Promise<any>((res, rej) => {
    const g = d.transaction('handles', 'readonly').objectStore('handles').get(key);
    g.onsuccess = () => res(g.result); g.onerror = () => rej(g.error);
  });
};
const shortenPath = (p: string) => {
  const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
};

// Ready-made equations for HEP / GR / cosmology (Insert → Physics & Cosmology).
// All symbol spellings are the long-standing ones so they compile on older CLIs;
// entries marked physica get the import added automatically on insert.
const PHYSICS_EQS: { group: string, name: string, physica?: boolean, code: string }[] = [
  { group: 'Quantum', name: 'Bra–ket & expectation value', physica: true, code: 'braket(psi, phi), quad expval(hat(A)) = mel(psi, hat(A), psi)' },
  { group: 'Quantum', name: 'Canonical commutators', physica: true, code: '[hat(x), hat(p)] = i hbar, quad {gamma^mu, gamma^nu} = 2 eta^(mu nu)' },
  { group: 'Quantum', name: "Fermi's golden rule", physica: true, code: 'Gamma_(f i) = (2 pi)/hbar abs(mel(f, hat(H)\', i))^2 rho(E_f)' },
  { group: 'HEP', name: 'Tensor indices & 4-gradient', physica: true, code: 'tensor(T, +mu, -nu), quad partial_mu = pdv(, x^mu)' },
  { group: 'HEP', name: 'Gauge covariant derivative', code: 'D_mu = partial_mu - i g A_mu^a T^a' },
  { group: 'HEP', name: 'Dirac equation', physica: true, code: '(i hbar gamma^mu partial_mu - m c) psi = 0' },
  { group: 'HEP', name: 'Klein–Gordon equation', physica: true, code: '(square + (m^2 c^2)/hbar^2) phi = 0' },
  { group: 'HEP', name: 'Feynman slash', code: 'cancel(D) = gamma^mu D_mu' },
  { group: 'HEP', name: 'QED Lagrangian', code: 'cal(L)_"QED" = macron(psi) (i gamma^mu D_mu - m) psi - 1/4 F_(mu nu) F^(mu nu)' },
  { group: 'GR & Cosmology', name: 'Einstein field equations', code: 'R_(mu nu) - 1/2 R g_(mu nu) + Lambda g_(mu nu) = (8 pi G)/c^4 T_(mu nu)' },
  { group: 'GR & Cosmology', name: 'Christoffel symbols', code: 'Gamma^lambda_(mu nu) = 1/2 g^(lambda sigma) (partial_mu g_(nu sigma) + partial_nu g_(mu sigma) - partial_sigma g_(mu nu))' },
  { group: 'GR & Cosmology', name: 'FRW metric', code: 'dif s^2 = -c^2 dif t^2 + a(t)^2 [ (dif r^2)/(1 - k r^2) + r^2 (dif theta^2 + sin^2 theta dif phi.alt^2) ]' },
  { group: 'GR & Cosmology', name: 'Friedmann equations', code: '(dot(a)/a)^2 = (8 pi G)/3 rho - (k c^2)/a^2 + Lambda/3, quad dot(rho) = -3 H (rho + p/c^2)' },
];

type SearchSnippet = { lineNum: number; text: string };
type SearchResult = { path: string; matches: SearchSnippet[] };

export default function App() {
  const editorRef = useRef<any>(null);
  const pdfRef = useRef<PdfHandle | null>(null);
  const forwardSyncRef = useRef<() => void>(() => {});
  const [tabs, setTabs] = useState<Tab[]>([{ path: 'main.typ', content: DEFAULT_CODE, isDirty: true }]);
  const [activeTabPath, setActiveTabPath] = useState<string>('main.typ');
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [treeSearch, setTreeSearch] = useState<string>('');
  const [isSearchVisible, setIsSearchVisible] = useState<boolean>(false);
  const [searchContentResults, setSearchContentResults] = useState<SearchResult[]>([]);
  useEffect(() => {
    if (!treeSearch) {
      setSearchContentResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`${API}/workspace/search?q=${encodeURIComponent(treeSearch)}`);
        if (res.ok) setSearchContentResults(await res.json());
      } catch (e) {}
    }, 300);
    return () => clearTimeout(timer);
  }, [treeSearch]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  // Word count of the RENDERED document (reported by PdfPreview from the PDF's
  // text), so the header reflects the reader-facing prose — not the Typst source.
  const [pdfWords, setPdfWords] = useState<number | null>(null);
  const handlePdfWordCount = useCallback((n: number) => setPdfWords(n), []);
  const [isCompiling, setIsCompiling] = useState(false);
  const [errorLogs, setErrorLogs] = useState<string | null>(null);
  // Set only when a real compile fails (kept separate from errorLogs, which is
  // also reused for transient UI hints). Drives the clear preview error panel.
  const [compileError, setCompileError] = useState<string | null>(null);
  // Which view the preview pane shows. On a failed compile we keep the last good
  // PDF up (VSCode/tinymist style) rather than taking over the pane; errors live
  // in a "Problems" tab you can switch to. Reset to the preview once it's clean.
  const [previewTab, setPreviewTab] = useState<'preview' | 'problems'>('preview');
  useEffect(() => { if (!compileError) setPreviewTab('preview'); }, [compileError]);
  const [theme, setTheme] = useState<'typst-dark' | 'typst-light'>(() =>
    localStorage.getItem('editor_theme') === 'typst-light' ? 'typst-light' : 'typst-dark');
  const [editorFontSize, setEditorFontSize] = useState<number>(() => Number(localStorage.getItem('editor_font_size')) || 14);
  const [compileDelay, setCompileDelay] = useState<number>(() => Number(localStorage.getItem('compile_delay')) || 1000);
  useEffect(() => { localStorage.setItem('editor_theme', theme); }, [theme]);
  const [recentFolders, setRecentFolders] = useState<RecentFolder[]>(() => {
    try { return JSON.parse(localStorage.getItem('recent_folders') || '[]'); } catch { return []; }
  });
  const addRecentFolder = (r: Omit<RecentFolder, 'when'>) => setRecentFolders(prev => {
    const next = [{ ...r, when: Date.now() }, ...prev.filter(p => r.path ? p.path !== r.path : p.idb !== r.idb)].slice(0, 8);
    localStorage.setItem('recent_folders', JSON.stringify(next));
    return next;
  });
  const clearRecentFolders = () => { localStorage.removeItem('recent_folders'); setRecentFolders([]); };
  const [textColor, setTextColor] = useState<string>(() => localStorage.getItem('text_color') || '#ef4444');
  // Palette anchor (viewport coords). Position: fixed — the toolbar scrolls
  // horizontally (overflow-x), which would clip an absolutely-positioned child.
  const [colorPopAt, setColorPopAt] = useState<{ x: number, y: number } | null>(null);
  const [highlightColor, setHighlightColor] = useState<string>(() => localStorage.getItem('highlight_color') || '#fff59d');
  const [highlightPopAt, setHighlightPopAt] = useState<{ x: number, y: number } | null>(null);
  const [fontSizePopAt, setFontSizePopAt] = useState<{ x: number, y: number } | null>(null);
  const [fontSizeVal, setFontSizeVal] = useState<number>(12);
  useEffect(() => { localStorage.setItem('highlight_color', highlightColor); }, [highlightColor]);
  useEffect(() => { localStorage.setItem('text_color', textColor); }, [textColor]);
  useEffect(() => { localStorage.setItem('editor_font_size', String(editorFontSize)); }, [editorFontSize]);
  useEffect(() => { localStorage.setItem('compile_delay', String(compileDelay)); }, [compileDelay]);

  const activeTab = tabs.find(t => t.path === activeTabPath);

  // Session restore: reopen the last project (workspace folder), its open tabs, and
  // the cursor position on the next launch, the way VS Code reopens where you left
  // off. Persisted to localStorage like the other saved settings above; no backend
  // state, so nothing to load or migrate.
  const workspacePathRef = useRef<string | null>(null);
  const sessionRef = useRef<{ workspacePath?: string; openPaths?: string[]; activePath?: string; cursor?: { line: number; column: number }; scrollTop?: number }>({});
  const sessionSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCursorRef = useRef<{ path: string; line: number; column: number; scrollTop?: number } | null>(null);
  const restoredRef = useRef(false);
  // In the browser dev flow vite is up long before the Rust backend, so the
  // first compile would hit a dead port and the error would stick until a
  // manual refresh. Compiles hold until the backend answers once.
  const [backendReady, setBackendReady] = useState(false);
  const scheduleSaveSession = () => {
    if (sessionSaveTimer.current) clearTimeout(sessionSaveTimer.current);
    sessionSaveTimer.current = setTimeout(() => {
      // Persist to the backend's on-disk session store (survives reboots and port
      // changes, unlike localStorage which is keyed to the webview origin).
      fetch(`${API}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sessionRef.current) }).catch(() => {});
    }, 500);
  };
  // Track the open tabs / active tab / workspace so the next launch can restore them.
  useEffect(() => {
    sessionRef.current.workspacePath = workspacePathRef.current || undefined;
    sessionRef.current.openPaths = tabs.map(t => t.path);
    sessionRef.current.activePath = activeTabPath;
    scheduleSaveSession();
  }, [tabs, activeTabPath]);
  // Once a restored tab's content is in the editor, put the cursor back where it was.
  useEffect(() => {
    const cur = pendingCursorRef.current, ed = editorRef.current;
    if (!cur || !ed || activeTab?.path !== cur.path || activeTab?.content === undefined) return;
    ed.setPosition({ lineNumber: cur.line, column: cur.column });
    ed.revealLineInCenter(cur.line);
    if (cur.scrollTop != null && ed.setScrollTop) ed.setScrollTop(cur.scrollTop);
    ed.focus();
    pendingCursorRef.current = null;
  }, [activeTabPath, activeTab?.content]);
  
  // Only a fallback for the header word count (until the PDF's own count lands),
  // so memoise it — no need to re-split the whole document on every render.
  const stats = useMemo(() => {
    if (!activeTab) return { words: 0, chars: 0 };
    const text = activeTab.content;
    return { words: text.trim().split(/\s+/).filter(w => w.length > 0).length, chars: text.length };
  }, [activeTab?.content]);
  const [showPackageInstaller, setShowPackageInstaller] = useState(false);
  const [showTemplateInstaller, setShowTemplateInstaller] = useState(false);
  const [showSymbolPicker, setShowSymbolPicker] = useState(false);
  const [showDiagramBuilder, setShowDiagramBuilder] = useState(false);
  const [showFeynman, setShowFeynman] = useState(false);
  const [showEqGallery, setShowEqGallery] = useState(false);
  const [showPhysics, setShowPhysics] = useState(false);
  const [showMatrixStudio, setShowMatrixStudio] = useState(false);
  const [showImagePlacer, setShowImagePlacer] = useState<string | boolean>(false);

  // Collect image file paths from the workspace tree for the ImagePlacer picker.
  const workspaceImages = useMemo(() => {
    const imgs: string[] = [];
    const walk = (nodes: typeof fileTree) => {
      for (const n of nodes) {
        if (n.type === 'directory' && n.children) walk(n.children);
        else if (/\.(png|jpe?g|gif|svg|webp|avif|bmp|tiff?)$/i.test(n.name)) imgs.push(n.path);
      }
    };
    walk(fileTree);
    return imgs;
  }, [fileTree]);
  const [showFlowchart, setShowFlowchart] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showFigureBuilder, setShowFigureBuilder] = useState(false);
  const [showQuiver, setShowQuiver] = useState(false);
  const [showEditSettings, setShowEditSettings] = useState(false);
  const [showDriveSync, setShowDriveSync] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showAppSettings, setShowAppSettings] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, node?: FileNode, type: 'file' | 'folder' | 'empty' } | null>(null);
  const [fileClipboard, setFileClipboard] = useState<{ path: string, type: 'copy' | 'cut' } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string>('');
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null);
  // Folders the user has collapsed. Kept in React state (not the DOM) so the
  // fold state survives tree re-renders triggered by selection / git updates.
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const toggleDir = (path: string) => setCollapsedDirs(prev => {
    const next = new Set(prev);
    next.has(path) ? next.delete(path) : next.add(path);
    return next;
  });
  const [projectName, setProjectName] = useState('Project Report');
  const [editingTitle, setEditingTitle] = useState(false);
  const [inputModal, setInputModal] = useState<InputModalConfig | null>(null);
  const [confirmModal, setConfirmModal] = useState<null | { message: string; danger?: boolean; confirmLabel?: string; resolve: (ok: boolean) => void }>(null);
  const confirmDialog = useCallback((message: string, opts?: { danger?: boolean; confirmLabel?: string }) =>
    new Promise<boolean>(resolve => setConfirmModal({ message, danger: opts?.danger, confirmLabel: opts?.confirmLabel, resolve })), []);
  const [showDataImport, setShowDataImport] = useState(false);

  // Stable options object: @monaco-editor/react calls editor.updateOptions() every
  // time this prop's identity changes, and reconfiguring mid-search makes the
  // find-match highlights flicker. Only rebuild it when the font size changes.
  const editorOptions = useMemo(() => ({
    automaticLayout: true,
    minimap: { enabled: false },
    wordWrap: 'on' as const,
    wordBasedSuggestions: 'off' as const,
    quickSuggestions: { other: true, comments: false, strings: false },
    quickSuggestionsDelay: 10,
    suggestOnTriggerCharacters: true,
    acceptSuggestionOnEnter: 'on' as const,
    tabCompletion: 'on' as const,
    snippetSuggestions: 'top' as const,
    suggest: { showSnippets: true, snippetsPreventQuickSuggestions: false },
    fontSize: editorFontSize,
    lineNumbers: 'on' as const,
    tabSize: 2,
    insertSpaces: true,
    detectIndentation: false,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    padding: { top: 16, bottom: 16 },
    autoClosingBrackets: 'always' as const,
    autoClosingQuotes: 'always' as const,
    bracketPairColorization: { enabled: true },
    hover: { enabled: true, delay: 300 },
  }), [editorFontSize]);
  const [codeRunner, setCodeRunner] = useState<null | { initialLang?: 'python' | 'julia' | 'wolfram'; initialCode?: string; initialMode?: 'text' | 'equation' }>(null);
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showPlot3D, setShowPlot3D] = useState(false);
  const [showPlotStudio, setShowPlotStudio] = useState(false);
  const [showSymbolDraw, setShowSymbolDraw] = useState(false);

  const [showRefManager, setShowRefManager] = useState(false);
  const [showBibManager, setShowBibManager] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [proofreadEnabled, setProofreadEnabled] = useState<boolean>(() => localStorage.getItem('proofread_enabled') === '1');
  useEffect(() => { localStorage.setItem('proofread_enabled', proofreadEnabled ? '1' : '0'); }, [proofreadEnabled]);

  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [editorWidth, setEditorWidth] = useState(500);
  const [treeHeight, setTreeHeight] = useState(220);
  const [problemsHeight, setProblemsHeight] = useState(160);
  const isResizingSidebar = useRef(false);
  const isResizingEditor = useRef(false);
  const isResizingTree = useRef(false);
  const isResizingProblems = useRef(false);
  const problemsResizeStart = useRef({ y: 0, height: 0 });
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const toggleNumberingRef = useRef<() => void>(() => {});

  const monaco = useMonaco();

  const proof = useProofread(monaco, editorRef, activeTab?.path, activeTab?.content, PROOFREAD_FEATURE_ENABLED && proofreadEnabled);

  useEffect(() => { if (monaco) setupTypstLanguage(monaco); }, [monaco]);
  // Keep the editor's image-path autocomplete (inside image("…")) in sync with
  // the workspace's image files.
  useEffect(() => { setWorkspaceImages(workspaceImages); }, [workspaceImages]);
  useEffect(() => { 
    // Restore the last project (folder + tabs + cursor) if one was saved, else load
    // the default workspace. Runs once.
    if (!restoredRef.current) {
      restoredRef.current = true;
      (async () => {
        // In the desktop app the page is served by the backend itself, so the
        // first probe succeeds immediately. Give a slow dev boot up to 30s,
        // then proceed anyway so a genuinely dead backend still surfaces.
        for (let i = 0; i < 60; i++) {
          try { await fetch(`${API}/workspace/root`); break; }
          catch { await new Promise(r => setTimeout(r, 500)); }
        }
        setBackendReady(true);
        restoreSessionOrDefault();
      })();
    }
    fetch(`${API}/lsp/hover`, { method: 'POST', body: JSON.stringify({ file: 'main.typ', line: 0, character: 0, content: '' }), headers: {'Content-Type': 'application/json'} })
      .then(() => {
        const w = (window as any);
        if (!w._hasLoggedTinymist) {
          w._hasLoggedTinymist = true;
          w.logTiming('Tinymist connected');
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizingSidebar.current) {
        setSidebarWidth(Math.max(150, Math.min(e.clientX, 600)));
      } else if (isResizingEditor.current) {
        const offset = (sidebarOpen ? sidebarWidth : 0) + 5;
        // Leave room for the sidebar, both resizers and a minimum preview width so
        // the PDF pane (and its toolbar) never gets pushed off-screen.
        const maxEditor = window.innerWidth - offset - 5 - 320;
        setEditorWidth(Math.max(200, Math.min(e.clientX - offset, maxEditor)));
      } else if (isResizingTree.current) {
        const top = sidebarRef.current?.getBoundingClientRect().top ?? 0;
        const total = sidebarRef.current?.clientHeight ?? 600;
        setTreeHeight(Math.max(80, Math.min(e.clientY - top, total - 140)));
      } else if (isResizingProblems.current) {
        // Drag the handle up → the Problems panel grows (it's anchored to the
        // bottom); delta-based so it works regardless of the panels below it.
        const dy = problemsResizeStart.current.y - e.clientY;
        const total = sidebarRef.current?.clientHeight ?? 600;
        setProblemsHeight(Math.max(60, Math.min(problemsResizeStart.current.height + dy, total - 200)));
      }
    };
    const handleMouseUp = () => {
      isResizingSidebar.current = false;
      isResizingEditor.current = false;
      isResizingTree.current = false;
      isResizingProblems.current = false;
      document.body.style.cursor = 'default';
      document.body.classList.remove('is-resizing');
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [sidebarOpen, sidebarWidth]);

  // When a folder is opened in the browser via the File System Access API, this
  // holds a writable handle to the real folder on disk so edits are saved back
  // to it (not just the app's working copy). Null in the desktop app (which
  // already points the backend straight at the folder) and in fallback mode.
  const dirHandleRef = useRef<any>(null);

  // Write a file back to the opened on-disk folder (browser File System Access).
  const syncToDisk = async (path: string, content: string) => {
    const root = dirHandleRef.current;
    if (!root) return;
    try {
      const parts = path.split('/');
      let dir = root;
      for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i], { create: true });
      const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(content);
      await w.close();
    } catch { /* ignore (permission revoked / removed) */ }
  };

  const fetchTree = async () => {
    try {
      const res = await fetch(`${API}/workspace`);
      if (res.ok) {
        setFileTree(await res.json());
        const w = (window as any);
        if (!w._hasLoggedBackend) {
          w._hasLoggedBackend = true;
          w.logTiming('Backend connected');
          w.logTiming('Workspace indexed');
        }
      }
    } catch(e) {}
  };


  // Single-flight compile: a newer compile aborts the one still running. Axum
  // drops the handler future when the client disconnects, and run_cmd kills the
  // child on drop, so aborting the fetch also kills the superseded `typst`
  // process — no orphaned compiles racing to write out.pdf.
  const compileAbortRef = useRef<AbortController | null>(null);

  const compileTypst = useCallback(async (mainFile: string = 'main.typ') => {
    compileAbortRef.current?.abort();
    const ac = new AbortController();
    compileAbortRef.current = ac;
    setIsCompiling(true);
    try {
      for (const tab of tabs) {
        if (tab.isDirty || tab.path === mainFile) {
          await fetch(`${API}/workspace/file?path=${encodeURIComponent(tab.path)}`, {
            method: 'POST', body: tab.content, headers: { 'Content-Type': 'text/plain' }
          });
          if (tab.isDirty) syncToDisk(tab.path, tab.content);   // mirror edits to the opened folder on disk
        }
      }

      const res = await fetch(`${API}/compile?main=${encodeURIComponent(mainFile)}`, { method: 'POST', signal: ac.signal });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const msg = errData.error || 'Compilation failed.';
        setErrorLogs(msg);
        setCompileError(msg);
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setPdfUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url; });
      setErrorLogs(null);
      setCompileError(null);

      const w = (window as any);
      if (!w._hasLoggedCompile) {
        w._hasLoggedCompile = true;
        w.logTiming('First compile');
      }

      setTabs(prev => prev.map(t => ({ ...t, isDirty: false })));
      fetchTree();
    } catch (error) {
      if (ac.signal.aborted) return;   // superseded by a newer compile — stay quiet
      const msg = error instanceof Error && /fetch/i.test(error.message)
        ? "Couldn't reach the local Typst engine. Make sure the app's backend is running, then recompile."
        : String(error);
      setErrorLogs(msg);
      setCompileError(msg);
    } finally {
      // Only the latest compile owns the spinner; a superseded one bows out.
      if (compileAbortRef.current === ac) setIsCompiling(false);
    }
  }, [tabs]);

  const restoreHistory = async (h: HistoryEntry) => {
    if (await confirmDialog(`Restore version from ${new Date(h.timestamp).toLocaleTimeString()}?`, { confirmLabel: 'Restore' })) {
      setTabs(prev => {
        if (!prev.find(t => t.path === h.path)) {
          return [...prev, { path: h.path, content: h.content, isDirty: true }];
        }
        return prev.map(t => t.path === h.path ? { ...t, content: h.content, isDirty: true } : t);
      });
    }
  };

  // Remember the last .typ file the user had open. When they switch to a
  // non-.typ tab (a .bib, .toml, .svg, …) we keep previewing that last .typ
  // instead of trying to compile the non-Typst file.
  const [lastTypPath, setLastTypPath] = useState<string>('');
  useEffect(() => {
    if (activeTabPath && activeTabPath.endsWith('.typ')) setLastTypPath(activeTabPath);
  }, [activeTabPath]);

  // The project's root/entry file — what the preview compiles. Multi-file
  // projects (templates, theses) have chapters that are `#include`d into a root
  // file and can't compile on their own (they reference a bibliography/labels
  // defined in the root). So instead of compiling whatever tab is active, we
  // compile the root, so editing any chapter updates the whole-document preview.
  const [mainOverride, setMainOverride] = useState<string | null>(null); // explicit "Set as main file"
  const [detectedEntry, setDetectedEntry] = useState<string | null>(null); // from typst.toml
  const treeHasPath = useCallback((target: string): boolean => {
    const walk = (nodes: FileNode[]): boolean => nodes.some(n => n.path === target || (n.children ? walk(n.children) : false));
    return walk(fileTree);
  }, [fileTree]);
  // Read the entrypoint from a root typst.toml if the project has one.
  useEffect(() => {
    if (!fileTree.some(n => n.type === 'file' && n.name === 'typst.toml')) { setDetectedEntry(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${API}/workspace/file?path=typst.toml`);
        if (!r.ok || cancelled) return;
        const m = (await r.text()).match(/entrypoint\s*=\s*"([^"]+\.typ)"/);
        if (m && !cancelled && treeHasPath(m[1])) setDetectedEntry(m[1]);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [fileTree, treeHasPath]);
  const currentMain = useMemo(() =>
    (mainOverride && treeHasPath(mainOverride)) ? mainOverride :
    (detectedEntry && treeHasPath(detectedEntry)) ? detectedEntry :
    treeHasPath('main.typ') ? 'main.typ' :
    (activeTabPath && activeTabPath.endsWith('.typ') ? activeTabPath : (lastTypPath || 'main.typ')),
    [mainOverride, detectedEntry, activeTabPath, lastTypPath, treeHasPath]);
  const [lastCompiledPath, setLastCompiledPath] = useState<string>('');

  // Record a version-history snapshot for one file. Called only on an explicit
  // save, so each entry is an intentional version the user chose to keep — not
  // one snapshot per second of compile-on-type. Skips a no-op save (unchanged
  // since the last snapshot) and keeps only the newest few per file, since each
  // entry holds a full copy of the document.
  const HISTORY_PER_FILE = 40;
  const snapshotHistory = useCallback((path: string, content: string) => {
    setHistory(prev => {
      const last = prev.filter(h => h.path === path).pop();
      if (last && last.content === content) return prev;
      const next = [...prev, { id: Math.random().toString(), timestamp: Date.now(), path, content }];
      const seen: Record<string, number> = {};
      const kept: typeof next = [];
      for (let i = next.length - 1; i >= 0; i--) {
        const h = next[i];
        seen[h.path] = (seen[h.path] || 0) + 1;
        if (seen[h.path] <= HISTORY_PER_FILE) kept.push(h);
      }
      return kept.reverse();
    });
  }, []);

  // Points at the latest runNotebook (defined further down). Held in a ref so an
  // intentional save can trigger it without pulling it into save's dependencies.

  const saveActiveFile = useCallback(async () => {
    if (!activeTab) return;
    try {
      await fetch(`${API}/workspace/file?path=${encodeURIComponent(activeTab.path)}`, {
        method: 'POST', body: activeTab.content, headers: { 'Content-Type': 'text/plain' }
      });
      snapshotHistory(activeTab.path, activeTab.content);   // keep a version, this save only
      syncToDisk(activeTab.path, activeTab.content);   // mirror to the opened folder on disk
      setTabs(prev => prev.map(t => t.path === activeTab.path ? { ...t, isDirty: false } : t));
      fetchTree();
      compileTypst(currentMain);
      webdavAutoSync();
    } catch (e) {}
  }, [activeTab, currentMain, compileTypst, snapshotHistory]);

  // If the user enabled WebDAV auto-sync, push the project on every save.
  const webdavAutoSync = () => {
    if (localStorage.getItem('webdav_autosync') !== 'true') return;
    const url = localStorage.getItem('webdav_url');
    if (!url) return;
    fetch(`${API}/webdav/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, username: localStorage.getItem('webdav_user') || '', password: localStorage.getItem('webdav_pass') || '', projectName })
    }).catch(() => {});
  };

  // Global shortcuts. Routed through a ref so the handler never captures stale
  // state; ⌘S is intercepted so the browser "Save As" dialog never appears.
  // ⌘B/⌘I/⌘E only fire inside the code editor (they'd be rude in modal inputs);
  // the ⌘⇧ dialogs work anywhere except while typing in another field.
  const shortcutRef = useRef<Record<string, () => void>>({});
  shortcutRef.current = {
    'S-e': () => insertNumberedEquation(),
    'S-m': () => setShowMatrixStudio(true),
    'S-p': () => setShowSymbolPicker(true),
    'S-g': () => setShowEqGallery(true),
    'S-l': () => setShowFlowchart(true),
    'S-f': () => setShowFeynman(true),
    'S-k': () => setCodeRunner({ initialLang: 'python' }),
    'S-u': () => computeSelection(),
    'S-y': () => setShowSymbolDraw(true),
    'S-b': () => insertCodeBlock(),
    'S-h': () => insertHRule(),
    'b': () => wrapSelection('*', '*'),
    'i': () => wrapSelection('_', '_'),
    'e': () => wrapSelection('$', '$'),
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === 's' && !e.shiftKey) { e.preventDefault(); saveActiveFile(); return; }
      if (key === 'k' && !e.shiftKey) { e.preventDefault(); setShowPalette(v => !v); return; }
      if (key === 'n' && e.shiftKey) { e.preventDefault(); toggleNumberingRef.current(); return; }
      const action = shortcutRef.current[`${e.shiftKey ? 'S-' : ''}${key}`];
      if (!action) return;
      const t = e.target as HTMLElement;
      const inMonaco = !!t.closest?.('.monaco-editor');
      const inField = !inMonaco && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (inField) return;                    // don't hijack typing in dialogs
      if (!e.shiftKey && !inMonaco) return;   // ⌘B/⌘I/⌘E are editor-only
      e.preventDefault();
      action();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [saveActiveFile]);

  useEffect(() => {
    if (!backendReady) return;
    const hasDirty = tabs.some(t => t.isDirty);
    if (hasDirty || currentMain !== lastCompiledPath) {
      const timeoutId = setTimeout(() => {
        compileTypst(currentMain);
        setLastCompiledPath(currentMain);
      }, hasDirty ? compileDelay : 50);
      return () => clearTimeout(timeoutId);
    }
  }, [backendReady, tabs, compileTypst, currentMain, lastCompiledPath, compileDelay]);

  // Stable so @monaco-editor/react doesn't dispose+resubscribe the content
  // listener on every render; identity only changes when the active tab does.
  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value !== undefined && activeTabPath) {
      setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, content: value, isDirty: true } : t));
    }
  }, [activeTabPath]);

  const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'];
  
  const openFile = async (path: string) => {
    const ext = (path.split('.').pop() || '').toLowerCase();
    // Images and PDFs are binary: open them as a preview tab rather than reading
    // their bytes as text, which would fill the editor with garbage.
    if (IMG_EXT.includes(ext) || ext === 'pdf') {
      if (!tabs.find(t => t.path === path)) {
        setTabs(prev => [...prev, { path, content: '', isDirty: false }]);
      }
    } else {
      if (!tabs.find(t => t.path === path)) {
        try {
          const res = await fetch(`${API}/workspace/file?path=${encodeURIComponent(path)}`);
          if (res.ok) {
            const content = await res.text();
            setTabs(prev => [...prev, { path, content, isDirty: false }]);
          }
        } catch (e) {}
      }
    }
    
    setActiveTabPath(path);
  };

  const closeTab = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    // Dispose the Monaco model for this file. @monaco-editor/react keeps every
    // model it creates in Monaco's global registry, so without this each
    // opened-then-closed file leaves a model holding the whole document behind —
    // a slow leak over a long editing session.
    if (monaco) {
      const model = monaco.editor.getModels().find(m => m.uri.path.replace(/^\//, '') === path);
      try { model?.dispose(); } catch {}
    }
    setTabs(prev => {
      const newTabs = prev.filter(t => t.path !== path);
      if (activeTabPath === path && newTabs.length > 0) setActiveTabPath(newTabs[newTabs.length - 1].path);
      else if (newTabs.length === 0) setActiveTabPath('');
      return newTabs;
    });
  };

  const createNewFile = (basePath?: string | React.MouseEvent) => {
    const dir = typeof basePath === 'string' ? basePath : undefined;
    setInputModal({
      title: 'New File',
      submitLabel: 'Create',
      fields: [{ key: 'name', label: 'File name', default: dir ? `${dir}/` : '', placeholder: 'chapters/intro.typ', hint: 'Use a slash for a subfolder, e.g. chapters/intro.typ' }],
      onSubmit: async (v) => {
        const name = (v.name || '').trim();
        if (!name || name.endsWith('/')) return;
        await fetch(`${API}/workspace/file?path=${encodeURIComponent(name)}`, { method: 'POST', body: '' });
        fetchTree();
        openFile(name);
      },
    });
  };

  const createNewFolder = (basePath?: string | React.MouseEvent) => {
    const dir = typeof basePath === 'string' ? basePath : undefined;
    setInputModal({
      title: 'New Folder',
      submitLabel: 'Create',
      fields: [{ key: 'name', label: 'Folder name', default: dir ? `${dir}/` : '', placeholder: 'images', hint: 'Use a slash for nested folders, e.g. assets/figures' }],
      onSubmit: async (v) => {
        const name = (v.name || '').trim().replace(/\/+$/, '');
        if (!name) return;
        await fetch(`${API}/workspace/mkdir?path=${encodeURIComponent(name)}`, { method: 'POST' });
        fetchTree();
      },
    });
  };

  const handleNodeClick = (e: React.MouseEvent, path: string, isDir: boolean) => {
    if (e && e.stopPropagation) e.stopPropagation();
    if (renamingPath === path) return;
    const treeEl = document.querySelector('.file-tree') as HTMLElement;
    if (treeEl) treeEl.focus();
    
    if (e && (e.ctrlKey || e.metaKey)) {
      setSelectedPaths(prev => prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]);
      setLastSelectedPath(path);
    } else if (e.shiftKey && lastSelectedPath) {
      const elements = Array.from(document.querySelectorAll('.tree-node [data-path]'));
      const paths = elements.map(el => el.getAttribute('data-path') as string);
      const startIdx = paths.indexOf(lastSelectedPath);
      const endIdx = paths.indexOf(path);
      if (startIdx !== -1 && endIdx !== -1) {
        const min = Math.min(startIdx, endIdx);
        const max = Math.max(startIdx, endIdx);
        const range = paths.slice(min, max + 1);
        setSelectedPaths(prev => Array.from(new Set([...prev, ...range])));
      }
    } else {
      setSelectedPaths([path]);
      setLastSelectedPath(path);
      if (!isDir) openFile(path);
    }
  };

  const handleNodeContextMenu = (e: React.MouseEvent, node: FileNode, type: 'file' | 'folder') => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedPaths.includes(node.path)) {
      setSelectedPaths([node.path]);
      setLastSelectedPath(node.path);
    }
    setContextMenu({ x: e.clientX, y: e.clientY, node, type });
  };

  const handleDragStart = (e: React.DragEvent, path: string) => {
    e.stopPropagation();
    const dragPaths = selectedPaths.includes(path) ? selectedPaths : [path];
    e.dataTransfer.setData('text/plain', JSON.stringify(dragPaths));
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleFileTreeKeyDown = async (e: React.KeyboardEvent) => {
    if (selectedPaths.length === 0) return;

    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      if (!await confirmDialog(`Delete ${selectedPaths.length} items?`, { danger: true, confirmLabel: 'Delete' })) return;
      for (const p of selectedPaths) await fetch(`${API}/workspace/file?path=${encodeURIComponent(p)}`, { method: 'DELETE' });
      setSelectedPaths([]); fetchTree();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleRename();
    } else if (e.key === 'c' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setFileClipboard({ path: selectedPaths[0], type: 'copy' });
    } else if (e.key === 'x' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setFileClipboard({ path: selectedPaths[0], type: 'cut' });
    } else if (e.key === 'v' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!fileClipboard) return;
      // Paste into the first selected folder, or the parent of the first selected file
      let targetDir = '';
      if (selectedPaths.length > 0) {
        const first = selectedPaths[0];
        // We don't have the node type easily here without searching the tree, but we can guess or just fetch
        const isSelectedDir = fileTree.some(n => {
           const search = (nodes: FileNode[]): boolean => {
             for (const no of nodes) {
               if (no.path === first) return no.type === 'directory';
               if (no.children) {
                 const res = search(no.children);
                 if (res) return true;
               }
             }
             return false;
           };
           return search([n]);
        });
        targetDir = isSelectedDir ? first : (first.includes('/') ? first.substring(0, first.lastIndexOf('/')) : '');
      }
      const toPath = targetDir ? `${targetDir}/${fileClipboard.path.split('/').pop()}` : fileClipboard.path.split('/').pop();
      await fetch(`${API}/workspace/${fileClipboard.type === 'cut' ? 'rename' : 'copy'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: fileClipboard.path, to: toPath }) });
      fetchTree();
    }
  };

  // Dragging OS files in reads as a "copy"; dragging tree nodes around is a "move".
  const dropEffectFor = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes('Files') ? 'copy' : 'move';

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = dropEffectFor(e);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = dropEffectFor(e);
  };

  const handleDrop = async (e: React.DragEvent, targetDir: string) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      // 1. Handle OS file drops (uploads). Some webviews (notably macOS WKWebView)
      // populate dataTransfer.items but leave dataTransfer.files empty for
      // non-image files, so gather from both and de-dupe by name+size.
      const dropped: File[] = [];
      if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
        for (const it of Array.from(e.dataTransfer.items)) {
          if (it.kind === 'file') { const f = it.getAsFile(); if (f) dropped.push(f); }
        }
      }
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        for (const f of Array.from(e.dataTransfer.files)) {
          if (!dropped.some(d => d.name === f.name && d.size === f.size)) dropped.push(f);
        }
      }
      if (dropped.length > 0) {
        const files = dropped;
        for (const file of files) {
          const newPath = targetDir ? `${targetDir}/${file.name}` : file.name;
          const arrayBuffer = await file.arrayBuffer();
          await fetch(`${API}/workspace/upload?path=${encodeURIComponent(newPath)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: arrayBuffer
          });
        }
        fetchTree();
        return;
      }

      // 2. Handle Internal File tree drag and drop
      const data = e.dataTransfer.getData('text/plain');
      if (!data) return;
      const pathsToMove: string[] = JSON.parse(data);
      let successCount = 0;
      for (const p of pathsToMove) {
        if (p === targetDir || targetDir.startsWith(p + '/')) continue;
        const filename = p.split('/').pop() || '';
        const newPath = targetDir ? `${targetDir}/${filename}` : filename;
        if (p !== newPath) {
          const res = await fetch(`${API}/workspace/rename`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: p, to: newPath })
          });
          if (res.ok) {
            successCount++;
            setTabs(prev => prev.map(t => {
              if (t.path === p) return { ...t, path: newPath };
              if (t.path.startsWith(p + '/')) return { ...t, path: newPath + t.path.substring(p.length) };
              return t;
            }));
            if (activeTabPath === p) setActiveTabPath(newPath);
            else if (activeTabPath.startsWith(p + '/')) setActiveTabPath(newPath + activeTabPath.substring(p.length));
          } else {
            const err = await res.json();
            notify(`Failed to move ${p}: ${err.error || 'Unknown error'}`);
          }
        }
      }
      if (successCount > 0) setSelectedPaths([]);
      fetchTree();
    } catch (err: any) {
      notify(`Drag and drop failed: ${err.message || err}`);
    }
  };

  const handleRename = (node?: FileNode) => {
    const paths = node && !selectedPaths.includes(node.path) ? [node.path] : (selectedPaths.length > 0 ? selectedPaths : (node ? [node.path] : []));
    if (paths.length === 0) return;
    if (paths.length === 1) {
      const p = paths[0];
      setRenamingPath(p);
      setRenameValue(p.split('/').pop() || '');
    } else {
      setInputModal({
        title: `Rename ${paths.length} items`,
        submitLabel: 'Rename',
        fields: [{ key: 'pattern', label: 'Name pattern', default: 'file_#', hint: '# is replaced by a number (1, 2, 3, …); the extension is kept' }],
        onSubmit: async (v) => {
          const pattern = (v.pattern || '').trim();
          if (!pattern) return;
          let i = 1;
          for (const p of paths) {
            const parent = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '';
            const originalName = p.split('/').pop() || '';
            const match = originalName.match(/(\.[^.]+)$/);
            const ext = match ? match[1] : '';
            let newName = pattern.replace('#', String(i++));
            if (ext && !newName.endsWith(ext)) newName += ext;
            const newPath = parent ? `${parent}/${newName}` : newName;
            await fetch(`${API}/workspace/rename`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: p, to: newPath })
            });
          }
          fetchTree();
        },
      });
    }
  };

  const commitRename = async (node: FileNode, newName: string) => {
    setRenamingPath(null);
    if (!newName || newName === node.name) return;
    const parentPath = node.path.includes('/') ? node.path.substring(0, node.path.lastIndexOf('/')) : '';
    const newPath = parentPath ? `${parentPath}/${newName}` : newName;
    try {
      const res = await fetch(`${API}/workspace/rename`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: node.path, to: newPath })
      });
      if (!res.ok) throw new Error('Rename failed');
      if (node.type === 'file') {
        setTabs(prev => prev.map(t => t.path === node.path ? { ...t, path: newPath } : t));
        if (activeTabPath === node.path) setActiveTabPath(newPath);
      } else {
        setTabs(prev => prev.map(t => t.path.startsWith(node.path + '/') ? { ...t, path: newPath + t.path.substring(node.path.length) } : t));
        if (activeTabPath.startsWith(node.path + '/')) setActiveTabPath(newPath + activeTabPath.substring(node.path.length));
      }
      fetchTree();
    } catch {}
  };

  const deleteEntry = async (e: React.MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    if (!await confirmDialog(`Delete ${isDir ? 'folder' : 'file'} "${path}"?${isDir ? '\nAll of its contents will be removed.' : ''}`, { danger: true, confirmLabel: 'Delete' })) return;
    try {
      await fetch(`${API}/workspace/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
    } catch {}
    setTabs(prev => {
      const remaining = prev.filter(t => t.path !== path && !t.path.startsWith(path + '/'));
      if (activeTabPath === path || activeTabPath.startsWith(path + '/')) {
        setActiveTabPath(remaining.length ? remaining[remaining.length - 1].path : '');
      }
      return remaining;
    });
    fetchTree();
  };

  const handleDuplicate = async (node?: FileNode) => {
    const pathsToCopy = node && !selectedPaths.includes(node.path) ? [node.path] : selectedPaths;
    if (pathsToCopy.length === 0) return;
    if (pathsToCopy.length === 1) {
      const path = pathsToCopy[0];
      const match = path.match(/^(.*?)(\.[^.]+)?$/);
      const suggested = `${match?.[1]}_copy${match?.[2] || ''}`;
      setInputModal({
        title: `Duplicate ${path.split('/').pop()}`,
        submitLabel: 'Duplicate',
        fields: [{ key: 'name', label: 'New name', default: suggested }],
        onSubmit: async (v) => {
          const newName = (v.name || '').trim();
          if (!newName || newName === path) return;
          try {
            await fetch(`${API}/workspace/copy`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: path, to: newName })
            });
            fetchTree();
          } catch {}
        },
      });
    } else {
      for (const p of pathsToCopy) {
        const match = p.match(/^(.*?)(\.[^.]+)?$/);
        const newPath = `${match?.[1]}_copy${match?.[2] || ''}`;
        await fetch(`${API}/workspace/copy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: p, to: newPath }) });
      }
      fetchTree();
    }
  };
  // Upload any file (images included) into the workspace, optionally into a folder.
  const uploadAsset = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      // Images belong with the other assets by default; source files, data and
      // everything else go to the project root unless the user says otherwise.
      const allImages = files.every(f => IMG_EXT.includes((f.name.split('.').pop() || '').toLowerCase()));
      const label = files.length === 1 ? `Upload ${files[0].name}` : `Upload ${files.length} files`;
      setInputModal({
        title: label,
        submitLabel: 'Upload',
        fields: [{ key: 'folder', label: 'Destination folder', default: allImages ? 'images' : '', placeholder: '(project root)', hint: 'Leave blank to upload into the project root' }],
        onSubmit: async (v) => {
          const folder = (v.folder || '').trim().replace(/^\/+|\/+$/g, '');
          for (const file of files) {
            const path = folder ? `${folder}/${file.name}` : file.name;
            const buf = await file.arrayBuffer();
            await fetch(`${API}/workspace/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream' } });
          }
          await fetchTree();
          if (files.length === 1) {
            const file = files[0];
            const path = folder ? `${folder}/${file.name}` : file.name;
            const ext = (file.name.split('.').pop() || '').toLowerCase();
            if (IMG_EXT.includes(ext)) insertCode(`\n#figure(\n  image("${path}", width: 80%),\n  caption: [],\n)\n`);
          }
        },
      });
    };
    input.click();
  };

  // Read the family name out of a .ttf/.otf name table so we can pre-fill the
  // #set text(font: …) call — Typst matches fonts by their internal family name,
  // which often differs from the file name.
  const readFontFamily = (buf: ArrayBuffer): string | null => {
    try {
      const dv = new DataView(buf);
      const numTables = dv.getUint16(4);
      let nameOff = -1;
      for (let i = 0; i < numTables; i++) {
        const rec = 12 + i * 16;
        const tag = String.fromCharCode(dv.getUint8(rec), dv.getUint8(rec + 1), dv.getUint8(rec + 2), dv.getUint8(rec + 3));
        if (tag === 'name') { nameOff = dv.getUint32(rec + 8); break; }
      }
      if (nameOff < 0) return null;
      const count = dv.getUint16(nameOff + 2);
      const strOff = nameOff + dv.getUint16(nameOff + 4);
      let best: string | null = null, bestScore = -1;
      for (let i = 0; i < count; i++) {
        const r = nameOff + 6 + i * 12;
        const platformID = dv.getUint16(r), nameID = dv.getUint16(r + 6);
        const len = dv.getUint16(r + 8), off = dv.getUint16(r + 10);
        if (nameID !== 1 && nameID !== 16) continue;
        const start = strOff + off; let s = '';
        if (platformID === 3 || platformID === 0) { for (let j = 0; j < len; j += 2) s += String.fromCharCode(dv.getUint16(start + j)); }
        else { for (let j = 0; j < len; j++) s += String.fromCharCode(dv.getUint8(start + j)); }
        s = s.replace(/\0/g, '').trim();
        if (!s) continue;
        const score = (nameID === 16 ? 2 : 1) + (platformID === 3 ? 0.5 : 0);
        if (score > bestScore) { bestScore = score; best = s; }
      }
      return best;
    } catch { return null; }
  };

  // Set (or replace) the document font in the first `#set text(font: …)` rule,
  // inserting one near the top if none exists yet.
  const applyDocumentFont = (fam: string) => {
    const editor = editorRef.current, model = editor?.getModel();
    if (!editor || !model || !fam) return;
    const text = model.getValue();
    const m = text.match(/#set\s+text\([^)]*\bfont:\s*"[^"]*"/);
    if (m) {
      const start = text.indexOf(m[0]);
      const newStr = m[0].replace(/font:\s*"[^"]*"/, `font: "${fam}"`);
      const from = model.getPositionAt(start), to = model.getPositionAt(start + m[0].length);
      editor.executeEdits('font', [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column } as any, text: newStr, forceMoveMarkers: true }]);
      editor.focus();
    } else {
      insertAtTop(`#set text(font: "${fam}")\n`);
    }
  };

  // Import a .ttf/.otf into <workspace>/fonts and point the document at it.
  const importFont = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.ttf,.otf';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const buf = await file.arrayBuffer();
      const detected = readFontFamily(buf) || file.name.replace(/\.(ttf|otf)$/i, '');
      await fetch(`${API}/workspace/upload?path=${encodeURIComponent('fonts/' + file.name)}`, { method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream' } });
      await fetchTree();
      setInputModal({
        title: 'Import Font',
        submitLabel: 'Use font',
        fields: [{ key: 'family', label: 'Font family name', default: detected, hint: 'Auto-detected from the file — edit if needed. Used in #set text(font: "…")' }],
        onSubmit: (v) => { if (v.family && v.family.trim()) applyDocumentFont(v.family.trim()); },
      });
    };
    input.click();
  };

  // Open a text file from disk into the workspace and a new tab.
  const openFromDisk = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.typ,.bib,.txt,.md,.csv,.json,.yml,.yaml,.tex';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const name = file.name;
      await fetch(`${API}/workspace/file?path=${encodeURIComponent(name)}`, { method: 'POST', body: text, headers: { 'Content-Type': 'text/plain' } });
      await fetchTree();
      setTabs(prev => prev.find(t => t.path === name)
        ? prev.map(t => t.path === name ? { ...t, content: text, isDirty: false } : t)
        : [...prev, { path: name, content: text, isDirty: false }]);
      setActiveTabPath(name);
    };
    input.click();
  };

  // Import an entire folder (with subfolders) from disk into the workspace.
  const openFolderFromDisk = () => {
    const input = document.createElement('input');
    input.type = 'file';
    (input as any).webkitdirectory = true;
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      if (files.length > 400 && !await confirmDialog(`Import ${files.length} files? This may take a moment.`, { confirmLabel: 'Import' })) return;
      const TEXT_EXT = ['typ', 'bib', 'txt', 'md', 'csv', 'json', 'yml', 'yaml', 'toml', 'xml', 'tex', 'html', 'css', 'js'];
      for (const f of files) {
        const rel = (f as any).webkitRelativePath || f.name;
        if (rel.includes('/.') || rel.includes('node_modules/')) continue;
        const ext = (f.name.split('.').pop() || '').toLowerCase();
        if (TEXT_EXT.includes(ext)) {
          const text = await f.text();
          await fetch(`${API}/workspace/file?path=${encodeURIComponent(rel)}`, { method: 'POST', body: text, headers: { 'Content-Type': 'text/plain' } });
        } else {
          const buf = await f.arrayBuffer();
          await fetch(`${API}/workspace/upload?path=${encodeURIComponent(rel)}`, { method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream' } });
        }
      }
      await fetchTree();
    };
    input.click();
  };

  // Find a sensible file to open in a freshly-opened folder (prefer main.typ,
  // then any .typ, searching nested folders last).
  const findFirstTyp = (nodes: FileNode[]): string | null => {
    const main = nodes.find(n => n.type === 'file' && n.name === 'main.typ');
    if (main) return main.path;
    const anyTyp = nodes.find(n => n.type === 'file' && n.name.endsWith('.typ'));
    if (anyTyp) return anyTyp.path;
    for (const n of nodes) if (n.type === 'directory' && n.children) { const r = findFirstTyp(n.children); if (r) return r; }
    return null;
  };

  // After the workspace contents change (root switch or import), reload the tree,
  // reset the editor, name the project after the folder, and open a starter file.
  const loadWorkspace = async (projectDisplayName?: string) => {
    setTabs([]);
    setActiveTabPath('');
    setHistory([]);
    setErrorLogs(null);
    setPdfUrl(prev => { if (prev) URL.revokeObjectURL(prev); return null; });
    if (projectDisplayName) setProjectName(projectDisplayName);
    const tree: FileNode[] = await (await fetch(`${API}/workspace`)).json();
    setFileTree(tree);
    // Open a starter file directly (don't route through openFile, whose closure
    // still holds the pre-switch tab list).
    const first = findFirstTyp(tree);
    if (first) {
      const r = await fetch(`${API}/workspace/file?path=${encodeURIComponent(first)}`);
      if (r.ok) { const content = await r.text(); setTabs([{ path: first, content, isDirty: false }]); setActiveTabPath(first); }
    }
  };

  // Reopen the tabs saved in the last session, restoring the active tab and cursor.
  // Returns false if nothing could be reopened (e.g. the files were deleted), so the
  // caller can fall back to the default startup.
  const restoreTabsFromSession = async (sess: any): Promise<boolean> => {
    const paths: string[] = Array.isArray(sess.openPaths) ? sess.openPaths : [];
    const loaded: Tab[] = [];
    for (const p of paths) {
      const ext = (p.split('.').pop() || '').toLowerCase();
      if (IMG_EXT.includes(ext) || ext === 'pdf') { loaded.push({ path: p, content: '', isDirty: false }); continue; }
      try {
        const r = await fetch(`${API}/workspace/file?path=${encodeURIComponent(p)}`);
        if (r.ok) loaded.push({ path: p, content: await r.text(), isDirty: false });
      } catch {}
    }
    if (!loaded.length) return false;
    setTabs(loaded);
    const active = loaded.find(t => t.path === sess.activePath) ? sess.activePath : loaded[loaded.length - 1].path;
    setActiveTabPath(active);
    if (sess.cursor) pendingCursorRef.current = { path: active, line: sess.cursor.line, column: sess.cursor.column, scrollTop: sess.scrollTop };
    return true;
  };

  // On launch: if a previous session exists, switch to its folder (desktop only —
  // it needs a native path) and reopen its tabs; otherwise load the default workspace.
  const restoreSessionOrDefault = async () => {
    let sess: any = null;
    try { sess = await (await fetch(`${API}/session`)).json(); } catch {}
    const desktop = (window as any).desktop;
    if (sess && Array.isArray(sess.openPaths) && sess.openPaths.length) {
      try {
        if (sess.workspacePath && desktop?.pickFolder) {
          const res = await fetch(`${API}/workspace/root`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: sess.workspacePath }) });
          if (res.ok) {
            workspacePathRef.current = sess.workspacePath;
            setProjectName(sess.workspacePath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'Project');
          }
        }
        setFileTree(await (await fetch(`${API}/workspace`)).json());
        if (await restoreTabsFromSession(sess)) return;
      } catch {}
    }
    fetchTree();
  };

  const TEXT_EXT = ['typ', 'bib', 'txt', 'md', 'csv', 'json', 'yml', 'yaml', 'toml', 'xml', 'tex', 'html', 'css', 'js'];

  // Recursively import an on-disk folder (File System Access handle) into the
  // backend workspace so Typst can compile it. The handle is kept so edits are
  // written straight back to the real files.
  const importDirHandle = async (dirHandle: any, prefix: string) => {
    for await (const entry of dirHandle.values()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') { await importDirHandle(entry, rel); continue; }
      const file = await entry.getFile();
      const ext = (entry.name.split('.').pop() || '').toLowerCase();
      if (TEXT_EXT.includes(ext)) {
        await fetch(`${API}/workspace/file?path=${encodeURIComponent(rel)}`, { method: 'POST', body: await file.text(), headers: { 'Content-Type': 'text/plain' } });
      } else {
        await fetch(`${API}/workspace/upload?path=${encodeURIComponent(rel)}`, { method: 'POST', body: await file.arrayBuffer(), headers: { 'Content-Type': 'application/octet-stream' } });
      }
    }
  };

  // "Open Folder" (VS Code style): make the chosen folder the project.
  // - Desktop app → repoints the backend straight at the folder on disk.
  // - Chrome/Edge → File System Access API: native picker + edits saved back to
  //   the real folder.
  // - Other browsers → folder picker that imports a working copy (no write-back).
  // Desktop: repoint the backend at an absolute path (also used by Open Recent).
  const openFolderPathAsRoot = async (folder: string) => {
    try {
      const res = await fetch(`${API}/workspace/root`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: folder }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { notify(data.error || 'Could not open that folder.'); return; }
      dirHandleRef.current = null;   // desktop backend edits the folder directly
      workspacePathRef.current = folder;   // remember this project for session restore
      const name = folder.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'Project';
      await loadWorkspace(name);
      addRecentFolder({ name, path: folder });
    } catch { notify('Could not reach the local server.'); }
  };

  // Chrome/Edge: writable directory handle → edits reflect on disk (also used by
  // Open Recent, where the handle comes back out of IndexedDB).
  const openDirHandleAsRoot = async (dir: any, ask = true) => {
    try {
      if (dir.requestPermission && (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        notify('Write permission is needed so your edits save back to the folder.', 'info'); return;
      }
      if (ask && !await confirmDialog(`Open “${dir.name}” as the workspace? Your edits will be saved back to this folder on disk.`, { confirmLabel: 'Open' })) return;
      await fetch(`${API}/workspace/clear`, { method: 'POST' });
      workspacePathRef.current = null;   // web-imported working copy: no native path to reopen
      dirHandleRef.current = dir;
      await importDirHandle(dir, '');
      await loadWorkspace(dir.name);
      const key = `dir:${dir.name}`;
      try { await idbPut(key, dir); addRecentFolder({ name: dir.name, idb: key }); } catch { /* recents are best-effort */ }
    } catch { notify('Could not open that folder.'); }
  };

  const openRecentFolder = async (r: RecentFolder) => {
    if (r.path) { await openFolderPathAsRoot(r.path); return; }
    if (r.idb) {
      try {
        const h = await idbGet(r.idb);
        if (!h) throw new Error('gone');
        await openDirHandleAsRoot(h, false);
      } catch { notify('Could not reopen this folder — open it once via File → Open Folder…'); }
    }
  };

  const openFolderAsRoot = async () => {
    const desktop = (window as any).desktop;
    if (desktop?.pickFolder) {
      const folder: string | null = await desktop.pickFolder();
      if (!folder || !folder.trim()) return;
      await openFolderPathAsRoot(folder);
      return;
    }

    if ((window as any).showDirectoryPicker) {
      let dir: any;
      try { dir = await (window as any).showDirectoryPicker({ mode: 'readwrite' }); }
      catch { return; } // cancelled
      await openDirHandleAsRoot(dir);
      return;
    }

    // Fallback (Safari/Firefox): folder picker that imports a working copy.
    const input = document.createElement('input');
    input.type = 'file';
    (input as any).webkitdirectory = true;
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      const rootName = (((files[0] as any).webkitRelativePath || files[0].name).split('/')[0]) || 'Project';
      if (!await confirmDialog(`Open “${rootName}” as the workspace? This browser can't save edits back to disk, so a working copy is imported (${files.length} files). Use the desktop app or Chrome to edit the folder in place.`, { confirmLabel: 'Open' })) return;
      try {
        await fetch(`${API}/workspace/clear`, { method: 'POST' });
        dirHandleRef.current = null;
        for (const f of files) {
          const rel = (f as any).webkitRelativePath || f.name;
          if (rel.includes('/.') || rel.includes('node_modules/')) continue;
          const dest = rel.split('/').slice(1).join('/') || f.name;   // drop the folder's own name
          const ext = (f.name.split('.').pop() || '').toLowerCase();
          if (TEXT_EXT.includes(ext)) {
            await fetch(`${API}/workspace/file?path=${encodeURIComponent(dest)}`, { method: 'POST', body: await f.text(), headers: { 'Content-Type': 'text/plain' } });
          } else {
            await fetch(`${API}/workspace/upload?path=${encodeURIComponent(dest)}`, { method: 'POST', body: await f.arrayBuffer(), headers: { 'Content-Type': 'application/octet-stream' } });
          }
        }
        await loadWorkspace(rootName);
      } catch { notify('Could not import that folder.'); }
    };
    input.click();
  };

  // Open the data-import dialog (CSV/Excel/JSON/…) with preview + options.
  const insertDataFile = () => setShowDataImport(true);

  // Called by DataImportModal once the user has chosen a file, sheet and options:
  // write the (possibly Excel-converted) data into the workspace and drop the
  // matching Typst read snippet at the cursor.
  const handleDataImport = async ({ filename, content, snippet }: { filename: string; content: string; snippet: string }) => {
    await fetch(`${API}/workspace/file?path=${encodeURIComponent(filename)}`, { method: 'POST', body: content, headers: { 'Content-Type': 'text/plain' } });
    await fetchTree();
    insertCode('\n' + snippet + '\n\n');
    setShowDataImport(false);
    notify(`Imported ${filename}`, 'success');
  };
  
  const handleInitTemplate = async (result: string | { code: string; entrypoint?: string }) => {
    setShowTemplateInstaller(false);
    await fetchTree();   // show every file the template created, not just the entry
    const entry = typeof result === 'string' ? 'main.typ' : (result.entrypoint || 'main.typ');
    const code = typeof result === 'string' ? result : result.code;
    setMainOverride(entry);   // preview compiles the template's root, not its chapters
    setTabs([{ path: entry, content: code, isDirty: false }]);
    setActiveTabPath(entry);
    compileTypst(entry);
  };

  // Write a built-in (offline) starter into the open folder. Unlike the Universe
  // templates above, these ship in the app; they land in the current workspace
  // as real files and open as a new tab, without discarding what's already open.
  const handleUseBuiltin = async (tpl: BuiltinTemplate) => {
    setShowTemplateInstaller(false);
    let existing: string[] = [];
    try {
      const res = await fetch(`${API}/workspace`);
      if (res.ok) {
        const tree = await res.json();
        if (Array.isArray(tree)) existing = tree.map((n: any) => n.path);
      }
    } catch { /* offline read of our own workspace — ignore */ }

    // Don't clobber an existing file of the same name: bump slides.typ → slides-1.typ.
    const dot = tpl.entry.lastIndexOf('.');
    const base = dot > 0 ? tpl.entry.slice(0, dot) : tpl.entry;
    const ext = dot > 0 ? tpl.entry.slice(dot) : '';
    let entry = tpl.entry;
    for (let i = 1; existing.includes(entry); i++) entry = `${base}-${i}${ext}`;

    for (const f of tpl.files) {
      const target = f.path === tpl.entry ? entry : f.path;
      if (f.keepExisting && existing.includes(target)) continue;
      await fetch(`${API}/workspace/file?path=${encodeURIComponent(target)}`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: f.content,
      });
    }

    await fetchTree();
    const content = tpl.files.find(f => f.path === tpl.entry)!.content;
    setMainOverride(entry);
    setTabs(prev => prev.some(t => t.path === entry) ? prev : [...prev, { path: entry, content, isDirty: false }]);
    setActiveTabPath(entry);
    compileTypst(entry);
  };

  const insertCode = (text: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    editor.focus();
    // Insert at the cursor. If a selection is active (e.g. left over from a PDF
    // double-click or symbol pick), collapse to its end so we insert *after* it
    // rather than overwriting the selected text. With no cursor, append at EOF.
    const sel = editor.getSelection();
    let range;
    if (sel) {
      range = { startLineNumber: sel.endLineNumber, startColumn: sel.endColumn, endLineNumber: sel.endLineNumber, endColumn: sel.endColumn } as any;
    } else {
      const last = model.getLineCount();
      const col = model.getLineMaxColumn(last);
      range = { startLineNumber: last, startColumn: col, endLineNumber: last, endColumn: col } as any;
    }
    editor.executeEdits('insert', [{ range, text, forceMoveMarkers: true }]);
    editor.focus();
  };

  // Run every ```python / ```julia code block in the active file as ONE
  // persistent session per language, so variables carry across blocks like a
  // Jupyter notebook, then write each block's output back into the document just
  // below it. A previous auto-generated output block is replaced, not stacked.
  const [notebookRunning, setNotebookRunning] = useState(false);
  const runNotebook = async () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || !activeTab) return;
    const content = model.getValue();

    // Line-anchored so a fence printed *inside* a cell's output can't be mistaken
    // for a real cell on a later run.
    const CELL_RE = /^```(python|julia)[^\n]*\n([\s\S]*?)^```/gm;
    type Cell = { lang: 'python' | 'julia'; code: string; end: number; result?: any };
    const cells: Cell[] = [];
    let m: RegExpExecArray | null;
    while ((m = CELL_RE.exec(content))) {
      cells.push({ lang: m[1] as 'python' | 'julia', code: m[2].replace(/\n$/, ''), end: CELL_RE.lastIndex });
    }
    if (!cells.length) { notify('No ```python or ```julia code blocks found in this file.', 'info'); return; }

    setNotebookRunning(true);
    try {
      for (const lang of ['python', 'julia'] as const) {
        const group = cells.filter(c => c.lang === lang);
        if (!group.length) continue;
        // Use the interpreter the user picked in the code runner (e.g. a conda
        // env with numpy), not just the default one the backend detected first.
        const bin = localStorage.getItem(`interp_${lang}`) || '';
        const res = await fetch(`${API}/notebook/run`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lang, cells: group.map(c => c.code), bin }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.results) {
          notify(`Notebook run failed (${lang}): ${data.error || data.stderr || res.statusText}`);
          return;
        }
        group.forEach((c, i) => { c.result = data.results[i]; });
      }

      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
      const outputBlock = (r: any) => {
        const parts: string[] = [];
        const so = (r?.stdout || '').replace(/\n+$/, '');
        const er = (r?.error || '').replace(/\n+$/, '');
        if (so) parts.push(`  #raw(block: true, "${esc(so)}")`);
        if (er) parts.push(`  #text(fill: red, raw(block: true, "${esc(er)}"))`);
        for (const img of (r?.images || [])) parts.push(`  #image("${img}", width: 70%)`);
        const inner = parts.length ? parts.join('\n') : '  #text(fill: gray)[(no output)]';
        return `// >>> nb-output — auto-generated; re-run replaces this\n#block(fill: luma(245), inset: 6pt, radius: 3pt, width: 100%)[\n${inner}\n]\n// <<< nb-output`;
      };

      // Splice outputs in back-to-front so earlier offsets stay valid.
      let next = content;
      for (let i = cells.length - 1; i >= 0; i--) {
        const c = cells[i];
        const after = next.slice(c.end);
        const existing = after.match(/^\s*\/\/ >>> nb-output[\s\S]*?\n\/\/ <<< nb-output[^\n]*/);
        const removeLen = existing ? existing[0].length : 0;
        next = next.slice(0, c.end) + '\n' + outputBlock(c.result) + next.slice(c.end + removeLen);
      }
      // Once, add the show rule that badges python/julia code blocks with their
      // language logo in the compiled PDF (logos live in .hilbert/logos/).
      if (!next.includes(NB_LOGO_MARKER)) next = NB_LOGO_SHOW_RULE + next;

      editor.executeEdits('notebook', [{ range: model.getFullModelRange(), text: next, forceMoveMarkers: true }]);
      editor.pushUndoStop();
    } catch (e: any) {
      notify('Notebook run error: ' + (e?.message || e));
    } finally {
      setNotebookRunning(false);
    }
  };

  // Replace the current selection with `text` (wrapping it), or insert at the
  // cursor when nothing is selected.
  const replaceOrInsert = (sel: any, editor: any, model: any, text: string) => {
    if (sel && model && !sel.isEmpty()) {
      editor.executeEdits('wrap', [{ range: sel, text, forceMoveMarkers: true }]);
      editor.focus();
    } else insertCode(text);
  };

  // --- Shared selection helper ------------------------------------------------
  // Many insert-* functions begin with the same 3-line boilerplate to grab the
  // editor, model, selection, and selected text (with a fallback default).
  // This helper extracts that pattern so callers can just write:
  //   const ctx = getSelectionCtx('fallback');
  const getSelectionCtx = (fallback = '') => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const sel = editor?.getSelection();
    const inner = sel && model && !sel.isEmpty() ? model.getValueInRange(sel).trim() : fallback;
    return { editor, model, sel, inner };
  };

  // Insert content near the top of the document, just after the preamble
  // (leading #import / #set / comment / blank lines). Used for title, author,
  // institute and abstract, which belong at the top regardless of the cursor.
  const insertAtTop = (text: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const total = model.getLineCount();
    let line = 1;
    for (let i = 1; i <= total; i++) {
      const t = model.getLineContent(i).trim();
      if (t === '' || t.startsWith('#import') || t.startsWith('#set') || t.startsWith('//')) line = i + 1;
      else break;
    }
    editor.executeEdits('insert-top', [{
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 } as any,
      text: text.startsWith('\n') ? text.slice(1) : text,
      forceMoveMarkers: true
    }]);
    editor.focus();
  };

  // Insert LaTeX (e.g. Wolfram TeXForm / sympy latex()) as rendered Typst math via
  // the mitex package, importing it once at the top of the document.
  // Includes a best-effort sanitiser that converts common SymPy str() output
  // (e.g. raw print()) into passable LaTeX so #mitex() can render it.

  /** Best-effort conversion of raw SymPy / Python math text into LaTeX. */
  const sympyToLatex = (raw: string): string => {
    let s = raw;

    // --- Derivative(f, x) / Derivative(f, x, n) → \frac{d}{dx} f  ---
    s = s.replace(/Derivative\(([^,]+),\s*([^,)]+)\)/g, (_m, f, v) =>
      `\\frac{d}{d${v.trim()}} ${f.trim()}`);

    // --- sqrt(expr) → \sqrt{expr} ---
    // Handle nested parens via a simple depth-aware scan
    s = s.replace(/sqrt\(/g, '\\sqrt{').replace(/\\sqrt\{([^}]*)\)/g, '\\sqrt{$1}');
    // Fallback: balanced single-level
    s = s.replace(/\\sqrt\{([^{}]*)\)/g, '\\sqrt{$1}');

    // --- Python ** exponent → LaTeX ^{} ---
    // e.g. r**2 → r^{2}, sin(theta)**2 → sin(theta)^{2}
    s = s.replace(/\*\*(\d+)/g, '^{$1}');
    s = s.replace(/\*\*\(([^)]+)\)/g, '^{$1}');

    // --- Greek letters (must come before trig so "theta" inside sin() is caught) ---
    const greekLetters = [
      'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta',
      'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi',
      'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi',
      'chi', 'psi', 'omega',
      'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma',
      'Upsilon', 'Phi', 'Psi', 'Omega',
    ];
    // Sort longest-first so "theta" is matched before "eta", etc.
    const sorted = [...greekLetters].sort((a, b) => b.length - a.length);
    // Custom word boundary: _ is a word char in JS regex \b, but in LaTeX
    // notation theta_ should still match "theta". Use lookaround on [A-Za-z]
    // instead of \b so underscores/carets don't block matches.
    for (const g of sorted) {
      const re = new RegExp(`(?<!\\\\)(?<![A-Za-z])${g}(?![A-Za-z])`, 'g');
      s = s.replace(re, `\\${g}`);
    }

    // --- Trig / log functions → \sin, \cos, etc. ---
    const funcs = ['sin', 'cos', 'tan', 'cot', 'sec', 'csc',
                   'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh',
                   'log', 'ln', 'exp'];
    for (const fn of funcs) {
      const re = new RegExp(`(?<!\\\\)(?<![A-Za-z])${fn}(?![A-Za-z])`, 'g');
      s = s.replace(re, `\\${fn}`);
    }

    // --- Subscript / superscript grouping ---
    // ^word  →  ^{word}   (single word/letter after ^)
    s = s.replace(/\^([A-Za-z\\][A-Za-z0-9]*)/g, '^{$1}');
    // ^{...} already OK — don't double-wrap (the above won't match { )
    // _(...)  →  _{...}   (parenthesised subscript like _(r r))
    s = s.replace(/_\(([^)]*)\)/g, '_{$1}');
    // _word  →  _{word}   (single word after _)
    s = s.replace(/_([A-Za-z\\][A-Za-z0-9]*)/g, '_{$1}');

    // --- Multiplication: remove explicit * between factors ---
    // "a*b" → "a b"  (but not ** which is already handled)
    s = s.replace(/(?<!\*)\*(?!\*)/g, ' ');

    return s;
  };

  const insertEquationFromLatex = (latex: string, codeBlock?: string) => {
    ensureRule('@preview/mitex', '#import "@preview/mitex:0.2.7": mitex');
    const lines = latex.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const body = lines.map(l => '#mitex(`' + sympyToLatex(l) + '`)').join('\n\n');
    insertCode('\n' + (codeBlock ? codeBlock + '\n' : '') + body + '\n\n');
  };

  // Ensure a document-level set rule exists exactly once, then run a follow-up insert.
  const ensureRule = (marker: string, rule: string) => {
    if (!activeTab) return;
    if (!activeTab.content.includes(marker)) {
      const editor = editorRef.current;
      const model = editor?.getModel();
      if (editor && model) {
        editor.executeEdits('rule', [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as any, text: rule + '\n', forceMoveMarkers: true }]);
      }
    }
  };

  const wrapSelection = (before: string, after: string) => {
    if (!editorRef.current) return;
    const editor = editorRef.current;
    editor.focus();
    const selection = editor.getSelection();
    const model = editor.getModel();
    if (!selection || !model) return;
    
    if (selection.isEmpty()) {
       insertCode(before + after);
       return;
    }

    const text = model.getValueInRange(selection);
    const newText = before + text + after;
    
    editor.executeEdits('formatting', [{
      range: selection,
      text: newText,
      forceMoveMarkers: true
    }]);
    editor.focus();
  };

  // --- Insert helpers (all driven by the styled InputModal) -------------------
  const docLabels = () => {
    if (!activeTab) return [];
    return Array.from(new Set(
      Array.from(activeTab.content.matchAll(/<([a-zA-Z_][\w:.\-]*)>/g)).map(m => m[1])
    ));
  };

  // Visual page setup → generates a `#set page(...)` rule (paper size, per-side
  // margins, header/footer, page numbers) and drops it at the top of the file,
  // where page setup belongs.
  const insertPageSetup = () => setInputModal({
    title: 'Page Setup',
    submitLabel: 'Apply',
    fields: [
      { key: 'paper', label: 'Paper size', type: 'select', default: 'a4', options: ['a4', 'a5', 'a3', 'a6', 'us-letter', 'us-legal', 'iso-b5', 'presentation-16-9', 'custom'] },
      { key: 'width', label: 'Custom width', placeholder: '21cm', hint: 'Only used when paper = custom' },
      { key: 'height', label: 'Custom height', placeholder: '29.7cm', hint: 'Only used when paper = custom' },
      { key: 'mtop', label: 'Top margin', placeholder: 'e.g. 2.5cm', hint: 'Leave any margin blank to keep the default' },
      { key: 'mbottom', label: 'Bottom margin', placeholder: 'e.g. 2.5cm' },
      { key: 'mleft', label: 'Left margin', placeholder: 'e.g. 2cm' },
      { key: 'mright', label: 'Right margin', placeholder: 'e.g. 2cm' },
      { key: 'header', label: 'Header text', placeholder: 'optional' },
      { key: 'footer', label: 'Footer text', placeholder: 'optional' },
      { key: 'pagenum', label: 'Page numbers', type: 'select', default: 'bottom center', options: ['none', 'bottom center', 'bottom right', 'bottom left', 'top center', 'top right'] },
    ],
    onSubmit: (v) => {
      const esc = (s: string) => s.replace(/([\[\]#])/g, '\\$1');
      const lines: string[] = [];
      if (v.paper === 'custom' && (v.width || v.height)) {
        if (v.width) lines.push(`  width: ${v.width},`);
        if (v.height) lines.push(`  height: ${v.height},`);
      } else {
        lines.push(`  paper: "${v.paper}",`);
      }
      const m: string[] = [];
      if (v.mtop?.trim()) m.push(`top: ${v.mtop.trim()}`);
      if (v.mbottom?.trim()) m.push(`bottom: ${v.mbottom.trim()}`);
      if (v.mleft?.trim()) m.push(`left: ${v.mleft.trim()}`);
      if (v.mright?.trim()) m.push(`right: ${v.mright.trim()}`);
      if (m.length) lines.push(`  margin: (${m.join(', ')}),`);
      if (v.header?.trim()) lines.push(`  header: [${esc(v.header.trim())}],`);
      const pn = v.pagenum;
      if (pn && pn !== 'none') {
        const horiz = pn.includes('right') ? 'right' : pn.includes('left') ? 'left' : 'center';
        const vert = pn.startsWith('top') ? 'top' : 'bottom';
        if (v.footer?.trim()) {
          // Combine footer text with the page number so they don't clash.
          lines.push(`  footer: [${esc(v.footer.trim())} #h(1fr) #context counter(page).display()],`);
        } else {
          lines.push(`  numbering: "1",`);
          lines.push(`  number-align: ${vert} + ${horiz},`);
        }
      } else if (v.footer?.trim()) {
        lines.push(`  footer: [${esc(v.footer.trim())}],`);
      }
      insertAtTop(`#set page(\n${lines.join('\n')}\n)\n\n`);
    },
  });

  const insertTitleBlock = () => setInputModal({
    title: 'Insert Title Block',
    fields: [
      { key: 'title', label: 'Document title', default: 'Document Title' },
      { key: 'author', label: 'Author(s)', default: '', placeholder: 'Author name' },
      { key: 'email', label: 'Email', default: '', placeholder: 'you@example.com' },
      { key: 'institute', label: 'Institute / Affiliation', default: '', placeholder: 'Affiliation' },
    ],
    onSubmit: (v) => insertAtTop(
`#align(center)[
  #text(17pt, weight: "bold")[${v.title}]

  #v(0.4em)
  ${v.author} \\
  #text(fill: gray)[${v.institute}]${v.email ? ` \\\n  #link("mailto:${v.email}")[${v.email.replace(/@/g, '\\@')}]` : ''}
]

`)
  });

  const insertAuthor = () => setInputModal({
    title: 'Insert Author',
    fields: [
      { key: 'author', label: 'Author name', default: '', placeholder: 'Author name' },
      { key: 'email', label: 'Email (optional)', default: '', placeholder: 'you@example.com' },
    ],
    onSubmit: (v) => insertAtTop(`#align(center)[${v.author}${v.email ? ` \\\n  #link("mailto:${v.email}")[${v.email.replace(/@/g, '\\@')}]` : ''}]\n`)
  });

  const insertInstitute = () => setInputModal({
    title: 'Insert Institute',
    fields: [{ key: 'inst', label: 'Institute / Affiliation', default: 'University' }],
    onSubmit: (v) => insertAtTop(`#align(center)[#text(fill: gray)[${v.inst}]]\n`)
  });

  const insertAbstract = () => {
    insertAtTop(
`#align(center)[
  #set par(justify: true)
  #box(width: 85%)[
    #text(weight: "bold")[Abstract] \\
    Write your abstract here.
  ]
]

`);
  };

  const insertHeading = () => setInputModal({
    title: 'Insert Heading',
    fields: [
      { key: 'text', label: 'Heading text', default: 'Section' },
      { key: 'level', label: 'Level (1 = section, 2 = subsection, ...)', type: 'number', default: '1' },
    ],
    onSubmit: (v) => { const n = Math.max(1, parseInt(v.level) || 1); insertCode(`\n${'='.repeat(n)} ${v.text}\n\n`); }
  });

  const insertNumberedEquation = () => setInputModal({
    title: 'Insert Numbered Equation',
    fields: [
      { key: 'body', label: 'Equation body (Typst math)', default: 'E = m c^2' },
      { key: 'label', label: 'Reference label (optional)', placeholder: 'energy', hint: 'Referenced later as @eq:label' },
    ],
    onSubmit: (v) => {
      ensureRule('math.equation(numbering', '#set math.equation(numbering: "(1)")');
      const tag = v.label ? ` <eq:${v.label}>` : '';
      insertCode(`\n$ ${v.body} $${tag}\n\n`);
    }
  });

  // Wrap a block in #align(center)[...] when the "center" checkbox is on.
  const centerWrap = (text: string, center: string) =>
    center === 'true' ? `\n#align(center)[\n${text.trim()}\n]\n\n` : `\n${text.trim()}\n\n`;

  const MAT_DELIMS: Record<string, string> = { '( )': '', '[ ]': 'delim: "[",', '{ }': 'delim: "{",', '| |': 'delim: "|",', '‖ ‖': 'delim: "||",', 'none': 'delim: #none,' };
  const insertMatrix = () => setInputModal({
    title: 'Insert Matrix',
    fields: [
      { key: 'rows', label: 'Rows', type: 'number', default: '2' },
      { key: 'cols', label: 'Columns', type: 'number', default: '2' },
      { key: 'delim', label: 'Brackets', type: 'select', default: '( )', options: Object.keys(MAT_DELIMS) },
      { key: 'align', label: 'Cell alignment', type: 'select', default: 'center', options: ['center', 'left', 'right'] },
      { key: 'vline', label: 'Vertical line after column (0 = none)', type: 'number', default: '0', hint: 'Draws an augmentation line — e.g. for [A|b].' },
      { key: 'hline', label: 'Horizontal line after row (0 = none)', type: 'number', default: '0' },
      { key: 'linecolor', label: 'Line colour', type: 'select', default: 'default', options: ['default', 'red', 'blue', 'green', 'orange', 'gray', 'purple'], hint: 'Colour of the augmentation lines.' },
      { key: 'linethickness', label: 'Line thickness', default: '0.5pt' },
      { key: 'center', label: 'Center on page', type: 'checkbox', default: 'false' },
    ],
    onSubmit: (v) => {
      const r = Math.max(1, parseInt(v.rows) || 1), c = Math.max(1, parseInt(v.cols) || 1);
      const vl = parseInt(v.vline) || 0, hl = parseInt(v.hline) || 0;
      const opts: string[] = [];
      if (MAT_DELIMS[v.delim]) opts.push('  ' + MAT_DELIMS[v.delim]);
      if (v.align !== 'center') opts.push(`  align: ${v.align},`);
      if (vl > 0 || hl > 0) {
        const parts: string[] = [];
        if (vl > 0) parts.push(`vline: ${vl}`);
        if (hl > 0) parts.push(`hline: ${hl}`);
        const s = strokeExpr(v.linethickness, v.linecolor);
        if (s) parts.push(`stroke: ${s}`);
        opts.push(`  augment: #(${parts.join(', ')}),`);
      }
      let mat = '$ mat(\n' + (opts.length ? opts.join('\n') + '\n' : '');
      for (let i = 0; i < r; i++) mat += '  ' + Array(c).fill('0').join(', ') + (i < r - 1 ? ';' : '') + '\n';
      mat += ') $';
      insertCode(centerWrap(mat, v.center));
    }
  });

  // Matrix Studio output: inject only the #let helpers the generated matrix
  // actually references (each helper is inserted at most once by ensureSetup).
  const insertMatrixBody = (body: string) => {
    // Border-drawing matrices use the pavemat package.
    if (body.includes('pavemat(')) ensureSetup('@preview/pavemat', '#import "@preview/pavemat:0.2.0": pavemat');
    // Code-array output can ship reusable array/matrix operation helpers.
    if (body.includes('mat-transpose') || body.includes('mat-mul') || body.includes('mat-show'))
      ensureSetup('#let mat-transpose', [
        '#let mat-transpose(a) = range(a.at(0).len()).map(j => a.map(row => row.at(j)))',
        '#let mat-add(a, b) = a.enumerate().map(((i, row)) => row.enumerate().map(((j, x)) => x + b.at(i).at(j)))',
        '#let mat-scale(a, s) = a.map(row => row.map(x => x * s))',
        '#let mat-mul(a, b) = a.map(row => range(b.at(0).len()).map(j => range(b.len()).fold(0, (acc, k) => acc + row.at(k) * b.at(k).at(j))))',
        '#let mat-show(a) = math.equation(math.mat(..a))',
      ].join('\n'));
    if (body.includes('cellbox(')) ensureSetup('#let cellbox', '#let cellbox(body, fill: none) = box(fill: fill, inset: 3pt, radius: 2pt, baseline: 3pt)[#body]');
    if (body.includes('hatch(')) ensureSetup('#let hatch(', '#let hatch(c) = tiling(size: (5pt, 5pt), line(start: (0%, 100%), end: (100%, 0%), stroke: 0.6pt + c))');
    if (body.includes('hatchx(')) ensureSetup('#let hatchx(', '#let hatchx(c) = tiling(size: (5pt, 5pt), { place(line(start: (0%, 100%), end: (100%, 0%), stroke: 0.6pt + c)); place(line(start: (0%, 0%), end: (100%, 100%), stroke: 0.6pt + c)) })');
    if (body.includes('hatchd(')) ensureSetup('#let hatchd(', '#let hatchd(c) = tiling(size: (5pt, 5pt), place(dx: 2pt, dy: 2pt, circle(radius: 0.7pt, fill: c)))');
    insertCode(body);
  };

  const insertTable = () => setInputModal({
    title: 'Insert Table',
    fields: [
      { key: 'rows', label: 'Rows (incl. header)', type: 'number', default: '3' },
      { key: 'cols', label: 'Columns', type: 'number', default: '3' },
      { key: 'header', label: 'Bold coloured header row', type: 'checkbox', default: 'true' },
      { key: 'headercolor', label: 'Header colour', type: 'select', default: 'blue', options: ['blue', 'gray', 'green', 'orange', 'purple', 'red'] },
      { key: 'stripe', label: 'Zebra striping', type: 'checkbox', default: 'false' },
      { key: 'colwidths', label: 'Column widths', default: '', placeholder: 'blank = equal · e.g. auto  or  1fr 2fr auto', hint: 'One token per column (space/comma separated): auto, 1fr, 3cm, 30%. One token → applied to all. Blank → equal columns.' },
      { key: 'align', label: 'Horizontal alignment', type: 'select', default: 'left', options: ['left', 'center', 'right'] },
      { key: 'colalign', label: 'Per-column alignment', default: '', placeholder: 'blank = same for all · e.g. left center right', hint: 'Override alignment per column, one token each (left/center/right). Blank uses the single alignment above.' },
      { key: 'valign', label: 'Vertical alignment', type: 'select', default: 'horizon', options: ['horizon', 'top', 'bottom'] },
      { key: 'inset', label: 'Cell padding', default: '7pt', placeholder: '7pt · or "x: 8pt, y: 4pt"' },
      { key: 'border', label: 'Border', type: 'select', default: 'all lines', options: ['all lines', 'none', 'horizontal only'] },
      { key: 'borderthickness', label: 'Border thickness', default: '0.5pt' },
      { key: 'bordercolor', label: 'Border colour', type: 'select', default: 'gray', options: ['gray', 'black', 'blue', 'red', 'green'] },
      { key: 'center', label: 'Center on page', type: 'checkbox', default: 'false' },
    ],
    onSubmit: (v) => {
      const r = Math.max(1, parseInt(v.rows) || 1), c = Math.max(1, parseInt(v.cols) || 1);
      const hdr = v.header === 'true', stripe = v.stripe === 'true';
      const bcol = v.bordercolor === 'gray' ? 'luma(200)' : v.bordercolor;
      const bstroke = `${(v.borderthickness || '0.5pt').trim()} + ${bcol}`;
      const strokeMap: Record<string, string> = {
        'all lines': `  stroke: ${bstroke},`,
        'none': '  stroke: none,',
        'horizontal only': `  stroke: (x, y) => (top: ${bstroke}, bottom: ${bstroke}),`,
      };
      const valign = v.valign || 'horizon';
      // Column sizing: blank → N equal columns; one token → repeated; many → a tuple.
      const widthTokens = (v.colwidths || '').trim().split(/[\s,]+/).filter(Boolean);
      const columns = widthTokens.length === 0 ? `${c}`
        : widthTokens.length === 1 ? `(${widthTokens[0]},) * ${c}`
        : `(${widthTokens.join(', ')})`;
      // Alignment: per-column list if given, else a single alignment.
      const alignTokens = (v.colalign || '').trim().split(/[\s,]+/).filter(Boolean);
      const alignExpr = alignTokens.length > 0
        ? `(${alignTokens.map(a => `${a} + ${valign}`).join(', ')})`
        : `${v.align} + ${valign}`;
      const inset = (v.inset || '7pt').trim().includes(':') ? `(${(v.inset).trim()})` : (v.inset || '7pt').trim();
      const lines: string[] = [`  columns: ${columns},`, `  align: ${alignExpr},`, `  inset: ${inset},`, strokeMap[v.border] || strokeMap['all lines']];
      // Fill: header row + optional zebra.
      const fillParts: string[] = [];
      if (hdr) fillParts.push(`if y == 0 { ${v.headercolor}.lighten(70%) }`);
      if (stripe) fillParts.push(`if calc.odd(y) { luma(245) }`);
      if (fillParts.length) lines.push(`  fill: (x, y) => ${fillParts.join(' else ')},`);
      let body = '';
      for (let i = 0; i < r; i++) {
        if (i === 0 && hdr) body += '  table.header(' + Array(c).fill('[*Head*]').join(', ') + '),\n';
        else body += '  ' + Array(c).fill('[]').join(', ') + ',\n';
      }
      const t = `#table(\n${lines.join('\n')}\n${body})`;
      insertCode(centerWrap(t, v.center));
    }
  });

  // ---- Math: conditional (cases), cancel, over/under braces ------------------
  const insertCases = () => setInputModal({
    title: 'Insert Conditional / Piecewise Equation',
    fields: [
      { key: 'name', label: 'Left-hand side', default: 'f(x)' },
      { key: 'n', label: 'Number of cases', type: 'number', default: '2' },
    ],
    onSubmit: (v) => {
      const n = Math.max(1, parseInt(v.n) || 2);
      const rows: string[] = [];
      for (let i = 0; i < n; i++) rows.push(i < n - 1 ? `  ${i === 0 ? 'x' : '-x'} & "if" x ${i === 0 ? '>= 0' : '< 0'}` : `  0 & "otherwise"`);
      insertCode(`\n$ ${v.name} = cases(\n${rows.join(',\n')}\n) $\n\n`);
    }
  });

  // A stroke string "thickness + color" (drops the parts left at their default).
  const strokeExpr = (thickness: string, color: string, defColor = 'default') => {
    const p: string[] = [];
    if (thickness && thickness.trim()) p.push(thickness.trim());
    if (color && color !== defColor) p.push(color);
    return p.length ? p.join(' + ') : '';
  };

  const insertCancel = () => {
    const { editor, model, sel, inner } = getSelectionCtx('x');
    setInputModal({
      title: 'Cross Out / Strike Through',
      fields: [
        { key: 'target', label: 'Apply to', type: 'select', default: 'a word / text', options: ['a word / text', 'an equation term'], hint: 'Text uses strike/overlay; equation uses cancel().' },
        { key: 'style', label: 'Style', type: 'select', default: 'line through', options: ['line through', 'diagonal', 'cross (X)'] },
        { key: 'body', label: 'Content', default: inner },
        { key: 'usecolor', label: 'Custom line colour', type: 'checkbox', default: 'false' },
        { key: 'color', label: 'Line colour', type: 'color', default: 'rgb("#ef4444")' },
        { key: 'thickness', label: 'Line thickness', default: '1pt' },
      ],
      submitLabel: 'Insert',
      onSubmit: (v) => {
        const stroke = strokeExpr(v.thickness, v.usecolor === 'true' ? v.color : 'default');
        let code: string;
        if (v.target.startsWith('an equation')) {
          const args: string[] = [v.body];
          if (v.style === 'cross (X)') args.push('cross: #true');
          if (v.style === 'diagonal') args.push('inverted: #true');
          if (stroke) args.push(`stroke: #(${stroke})`);
          code = sel && model && !sel.isEmpty() ? `cancel(${args.join(', ')})` : `$ cancel(${args.join(', ')}) $`;
        } else if (v.style === 'line through') {
          code = `#strike(${stroke ? `stroke: ${stroke}` : ''})[${v.body}]`;
        } else {
          const s = stroke || '1pt';
          // Percentage line coords resolve against the *page*, not the box — so
          // `line(end: (100%, ...))` drew the X across the whole page. Measure the
          // body and draw the strokes to its actual size so they cover only the text.
          const diag = `place(top + left, line(start: (0pt, sz.height), end: (sz.width, 0pt), stroke: ${s}))`;
          const anti = `place(top + left, line(start: (0pt, 0pt), end: (sz.width, sz.height), stroke: ${s}))`;
          const strokes = v.style === 'cross (X)' ? `${diag}\n  ${anti}` : diag;
          code = `#box(baseline: 0pt, context {\n  let b = [${v.body}]\n  let sz = measure(b)\n  b\n  ${strokes}\n})`;
        }
        replaceOrInsert(sel, editor, model, code);
      }
    });
  };

  // Rotate any content — equations included.
  const insertRotate = () => {
    const { editor, model, sel, inner } = getSelectionCtx('$ E = m c^2 $');
    setInputModal({
      title: 'Rotate Content / Equation',
      fields: [
        { key: 'body', label: 'Content', type: 'textarea', default: inner },
        { key: 'angle', label: 'Angle (degrees, + = counter-clockwise)', default: '45' },
        { key: 'reflow', label: 'Reserve rotated space in layout', type: 'checkbox', default: 'true' },
      ],
      submitLabel: 'Insert',
      onSubmit: (v) => {
        const a = /deg|rad/.test(v.angle) ? v.angle : `${v.angle}deg`;
        const reflow = v.reflow === 'true' ? ', reflow: true' : '';
        // origin: center + horizon pivots about the middle; wrapping in align keeps
        // a (full-width) block equation tight and centred instead of swinging off-page.
        replaceOrInsert(sel, editor, model, `\n#align(center)[#rotate(${a}, origin: center + horizon${reflow})[${v.body}]]\n\n`);
      }
    });
  };

  const insertBrace = () => setInputModal({
    title: 'Insert Over / Under Brace',
    fields: [
      { key: 'kind', label: 'Type', type: 'select', default: 'underbrace', options: ['underbrace', 'overbrace', 'underbracket', 'overbracket'] },
      { key: 'body', label: 'Content', default: '1 + 2 + dots.c + n' },
      { key: 'annot', label: 'Annotation (optional)', placeholder: 'e.g. n "terms"' },
    ],
    onSubmit: (v) => {
      const args = v.annot ? `${v.body}, ${v.annot}` : v.body;
      insertCode(`\n$ ${v.kind}(${args}) $\n\n`);
    }
  });

  // ---- Text: underline / highlight / box, with colour ------------------------
  const insertUnderline = () => {
    const { editor, model, sel, inner } = getSelectionCtx('text');
    setInputModal({
      title: 'Underline (with colour)',
      fields: [
        { key: 'body', label: 'Text', default: inner },
        { key: 'usecolor', label: 'Custom colour (else follows text)', type: 'checkbox', default: 'false' },
        { key: 'color', label: 'Colour', type: 'color', default: 'rgb("#ef4444")' },
        { key: 'thickness', label: 'Thickness', default: '1pt' },
        { key: 'offset', label: 'Offset from text', default: '2pt' },
        { key: 'background', label: 'Behind the text', type: 'checkbox', default: 'false' },
      ],
      submitLabel: 'Insert',
      onSubmit: (v) => {
        const a: string[] = [];
        const strokeParts: string[] = [];
        if (v.thickness && v.thickness !== '1pt') strokeParts.push(v.thickness);
        if (v.usecolor === 'true') strokeParts.push(v.color);
        if (strokeParts.length) a.push(`stroke: ${strokeParts.join(' + ')}`);
        if (v.offset && v.offset !== '2pt') a.push(`offset: ${v.offset}`);
        if (v.background === 'true') a.push('background: true');
        const args = a.length ? `(${a.join(', ')})` : '';
        replaceOrInsert(sel, editor, model, `#underline${args}[${v.body}]`);
      }
    });
  };

  // Factory for simple colour-wrapper inserts (highlight, text colour, etc.)
  const insertColorWrap = (title: string, colorLabel: string, defaultColor: string, fn: string, prop: string) => () => {
    const { editor, model, sel, inner } = getSelectionCtx('text');
    setInputModal({
      title,
      fields: [
        { key: 'body', label: 'Text', default: inner },
        { key: 'color', label: colorLabel, type: 'color', default: defaultColor },
      ],
      submitLabel: 'Insert',
      onSubmit: (v) => replaceOrInsert(sel, editor, model, `#${fn}(${prop}: ${v.color})[${v.body}]`)
    });
  };
  const insertHighlight = insertColorWrap('Highlight / Background Colour', 'Background colour', 'rgb("#fff59d")', 'highlight', 'fill');
  const insertTextColor = insertColorWrap('Text Colour', 'Colour', 'rgb("#ef4444")', 'text', 'fill');

  const setSelectionFontSizePrompt = () => setInputModal({
    title: 'Font Size',
    fields: [{ key: 'pt', label: 'Size (pt)', type: 'number', default: '12' }],
    submitLabel: 'Apply',
    onSubmit: (v) => setSelectionFontSize(v.pt)
  });

  const insertBox = () => {
    const { editor, model, sel, inner } = getSelectionCtx('content');
    setInputModal({
      title: 'Box Selection — fill, texture, border',
      fields: [
        { key: 'body', label: 'Content', type: 'textarea', default: inner },
        { key: 'kind', label: 'Layout', type: 'select', default: 'block (own line)', options: ['block (own line)', 'box (inline)'] },
        { key: 'fill', label: 'Fill / texture', type: 'select', default: 'solid', options: ['none', 'solid', 'gradient', 'cross-hatch', 'diagonal-hatch', 'dots'] },
        { key: 'fillcolor', label: 'Fill colour', type: 'color', default: 'rgb("#ffd54a")' },
        { key: 'fillcolor2', label: 'Gradient second colour', type: 'color', default: 'rgb("#a855f7")', hint: 'Only used for the gradient fill.' },
        { key: 'border', label: 'Border style', type: 'select', default: 'solid', options: ['solid', 'dashed', 'dotted', 'none'] },
        { key: 'thickness', label: 'Border thickness', default: '1pt' },
        { key: 'bordercolor', label: 'Border colour', type: 'color', default: 'rgb("#334155")' },
        { key: 'radius', label: 'Corner radius', default: '4pt' },
        { key: 'inset', label: 'Padding', default: '8pt' },
      ],
      submitLabel: 'Insert',
      onSubmit: (v) => {
        const fn = v.kind.startsWith('block') ? 'block' : 'box';
        const a: string[] = [];
        const th = (v.thickness || '1pt').trim();
        if (v.fill === 'cross-hatch' || v.fill === 'diagonal-hatch') {
          const hs = `${th} + ${v.fillcolor}`;
          const l1 = `#place(line(start: (0%, 0%), end: (100%, 100%), stroke: ${hs}))`;
          const l2 = `#place(line(start: (100%, 0%), end: (0%, 100%), stroke: ${hs}))`;
          a.push(`fill: tiling(size: (6pt, 6pt))[${l1}${v.fill === 'cross-hatch' ? l2 : ''}]`);
        } else if (v.fill === 'dots') {
          a.push(`fill: tiling(size: (8pt, 8pt))[#place(center + horizon, circle(radius: 1.5pt, fill: ${v.fillcolor}))]`);
        } else if (v.fill === 'gradient') {
          a.push(`fill: gradient.linear(${v.fillcolor}, ${v.fillcolor2})`);
        } else if (v.fill === 'solid') a.push(`fill: ${v.fillcolor}`);
        if (v.border !== 'none') {
          if (v.border === 'solid') a.push(`stroke: ${th} + ${v.bordercolor}`);
          else a.push(`stroke: (paint: ${v.bordercolor}, thickness: ${th}, dash: "${v.border}")`);
        }
        if (v.radius && v.radius !== '0pt') a.push(`radius: ${v.radius}`);
        if (v.inset) a.push(`inset: ${v.inset}`);
        const code = `#${fn}(${a.join(', ')})[${v.body}]`;
        replaceOrInsert(sel, editor, model, v.kind.startsWith('block') ? `\n${code}\n\n` : code);
      }
    });
  };

  // ---- Layout: alignment -----------------------------------------------------
  const insertAlign = () => {
    const { editor, model, sel, inner } = getSelectionCtx('content');
    setInputModal({
      title: 'Align Content',
      fields: [
        { key: 'body', label: 'Content', type: 'textarea', default: inner },
        { key: 'h', label: 'Horizontal', type: 'select', default: 'center', options: ['left', 'center', 'right', '—'] },
        { key: 'v', label: 'Vertical', type: 'select', default: '—', options: ['—', 'top', 'horizon', 'bottom'] },
      ],
      submitLabel: 'Insert',
      onSubmit: (v) => {
        const parts = [v.h, v.v].filter(x => x && x !== '—');
        const align = parts.length ? parts.join(' + ') : 'center';
        replaceOrInsert(sel, editor, model, `\n#align(${align})[\n  ${v.body}\n]\n\n`);
      }
    });
  };

  const insertImage = () => setInputModal({
    title: 'Insert Image',
    fields: [
      { key: 'path', label: 'Image path', default: 'image.png' },
      { key: 'width', label: 'Width', default: '80%' },
      { key: 'caption', label: 'Caption (optional)', placeholder: 'leave blank for a plain image' },
      { key: 'center', label: 'Center on page', type: 'checkbox', default: 'true' },
    ],
    onSubmit: (v) => {
      const img = v.caption
        ? `#figure(\n  image("${v.path}", width: ${v.width}),\n  caption: [${v.caption}],\n)`
        : `#image("${v.path}", width: ${v.width})`;
      insertCode(centerWrap(img, v.center));
    }
  });

  const insertWhiteboard = () => {
    setInputModal({
      title: 'New Whiteboard (Excalidraw)',
      fields: [
        { key: 'name', label: 'Diagram name (without extension)', default: 'whiteboard_1' },
      ],
      submitLabel: 'Create & Open',
      onSubmit: async (v) => {
        const base = v.name || 'whiteboard_1';
        const excalidrawFile = `white_board/${base}.excalidraw`;
        const svgFile = `white_board/${base}.svg`;
        const dummySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text y="50">Please save drawing...</text></svg>`;
        const svgBlob = new Blob([dummySvg], { type: 'image/svg+xml' });
        
        await fetch(`${API}/workspace/file?path=${encodeURIComponent(excalidrawFile)}`, { method: 'POST', body: '' });
        await fetch(`${API}/workspace/upload?path=${encodeURIComponent(svgFile)}`, { method: 'POST', body: svgBlob, headers: { 'Content-Type': 'application/octet-stream' } });
        
        fetchTree();
        insertCode(centerWrap(`#image("${svgFile}", width: 60%)`, 'true'));
        openFile(excalidrawFile);
      }
    });
  };

  // Wrap the selected element (figure/table/plot/image/…) in a numbered #figure
  // with a caption, so it gets a "Figure N" number and can be cross-referenced.
  const wrapInFigure = () => {
    const { editor, model, sel, inner: selected } = getSelectionCtx('');
    if (!editor || !model) return;
    editor.focus();
    setInputModal({
      title: 'Wrap in Figure',
      fields: [
        { key: 'caption', label: 'Caption', default: 'Caption' },
        { key: 'label', label: 'Label (optional)', placeholder: 'plot1', hint: 'Referenced later as @fig:plot1' },
      ],
      submitLabel: 'Wrap',
      onSubmit: (v) => {
        // Wrap the selection as a [content] block so any number of markup
        // statements (#set, #diagram, #image, #table, …) stay valid inside figure.
        const inner = selected || '#image("image.png", width: 80%)';
        const tag = v.label ? ` <fig:${v.label}>` : '';
        const fig = `#figure(\n  [${inner}],\n  caption: [${v.caption}],\n)${tag}`;
        if (sel && !sel.isEmpty()) {
          editor.executeEdits('wrap-figure', [{ range: sel, text: fig, forceMoveMarkers: true }]);
          editor.focus();
        } else {
          insertCode('\n' + fig + '\n\n');
        }
      }
    });
  };


  // Insert a commutative diagram drawn in quiver: add the fletcher import once,
  // then drop in the exported diagram code (stripping quiver's permalink comment).
  // quiver labels are LaTeX (it renders them with KaTeX) and its fletcher export
  // pastes them into Typst math verbatim — so `\bullet` arrives as an escape and
  // fails with "unknown variable: ullet". Translate the common macros.
  const insertQuiverDiagram = (code: string) => {
    ensureRule('@preview/fletcher', '#import "@preview/fletcher:0.5.8" as fletcher: diagram, node, edge');
    const clean = code.replace(/^\/\/[^\n]*\n/, '').trim()
      .replace(/\[\$(.*?)\$\]/g, (m, inner) =>
        inner.includes('\\') || /[{}]/.test(inner) ? `[$${latexMathToTypst(inner)}$]` : m);
    insertCode(`\n${clean}\n\n`);
    setShowQuiver(false);
  };

  // Insert a ready-made physics equation (Insert → Physics & Cosmology),
  // pulling in physica when the snippet needs it.
  const insertPhysicsEq = (eq: typeof PHYSICS_EQS[number]) => {
    if (eq.physica) ensureRule('@preview/physica', '#import "@preview/physica:0.9.8": *');
    insertCode(`\n$ ${eq.code} $\n\n`);
  };

  // Insert a Monaco snippet (with ${1:…} tab-stops) at the cursor so the reader
  // can Tab through the blanks. Falls back to plain text if the snippet
  // controller isn't available.
  const insertSnippet = (snippet: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const controller: any = editor.getContribution?.('snippetController2');
    if (controller && typeof controller.insert === 'function') controller.insert(snippet);
    else insertCode(snippet.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\}/g, '').replace(/\$\d+/g, ''));
  };

  // Insert an equation-gallery template, wrapped in inline or display math.
  const insertEqTemplate = (t: EqTemplate, display: boolean) => {
    if (t.physica) ensureRule('@preview/physica', '#import "@preview/physica:0.9.8": *');
    insertSnippet(display ? `\n$ ${t.snippet} $\n\n` : `$ ${t.snippet} $`);
    setShowEqGallery(false);
  };

  const insertPhysicsTemplate = (t: EqTemplate, display: boolean) => {
    if (t.physica) ensureRule('@preview/physica', '#import "@preview/physica:0.9.8": *');
    insertSnippet(display ? `\n$ ${t.snippet} $\n\n` : `$ ${t.snippet} $`);
    setShowPhysics(false);
  };

  // Ensure a multi-line preamble block exists once, at the top of the document.
  // A multi-line setup block (e.g. #let theorem = …) is just a rule with an
  // extra trailing blank line — delegate to ensureRule to avoid duplicating the
  // once-only insert-at-top logic.
  const ensureSetup = (marker: string, block: string) => ensureRule(marker, block + '\n');

  const insertTheorem = () => setInputModal({
    title: 'Insert Theorem / Proof',
    fields: [
      { key: 'kind', label: 'Environment (each kind is numbered separately)', type: 'select', default: 'theorem', options: ['theorem', 'lemma', 'corollary', 'proposition', 'definition', 'remark', 'example', 'proof'] },
      { key: 'style', label: 'Style', type: 'select', default: 'plain', options: ['plain', 'boxed (coloured box)'], hint: 'Set once per document by the first theorem you insert.' },
      { key: 'name', label: 'Name / title (optional)', placeholder: 'e.g. Noether' },
      { key: 'label', label: 'Label (optional, plain style only)', placeholder: 'noether → @thm:noether' },
      { key: 'body', label: 'Statement', type: 'textarea', default: 'Statement here.' },
    ],
    onSubmit: (v) => {
      const boxed = v.style.startsWith('boxed');
      // Marker matches both setups (each defines `#let theorem =`).
      ensureSetup('#let theorem =', boxed ? THEOREM_SETUP_BOXED : THEOREM_SETUP);
      const body = v.body || '';
      if (v.kind === 'proof') { insertCode(`\n#proof[${body}]\n\n`); return; }
      const args = [];
      if (v.name) args.push(`name: "${v.name}"`);
      if (v.label && !boxed) args.push(`label: <thm:${v.label}>`); // boxed style isn't cross-referenceable
      const argStr = args.length ? `(${args.join(', ')})` : '';
      insertCode(`\n#${v.kind}${argStr}[${body}]\n\n`);
    }
  });

  const insertWebLink = () => setInputModal({
    title: 'Insert Web Link',
    fields: [
      { key: 'url', label: 'URL', default: 'https://' },
      { key: 'text', label: 'Link text (optional)', placeholder: 'leave blank to show the URL' },
    ],
    onSubmit: (v) => insertCode(v.text ? `#link("${v.url}")[${v.text}]` : `#link("${v.url}")`)
  });

  const insertCrossRef = () => setInputModal({
    title: 'Insert Cross-reference',
    fields: [{ key: 'label', label: 'Reference a label', default: docLabels()[0] ?? '', options: docLabels(), placeholder: 'eq:energy', hint: docLabels().length ? 'Pick an existing label from the list.' : 'No labels in this file yet — add one with Insert → Label.' }],
    submitLabel: 'Reference',
    onSubmit: (v) => { if (v.label) insertCode(`@${v.label}`); }
  });

  // Suggest label names from the context around the cursor: a slug of the nearest
  // heading, plus the conventional prefixes for the element type nearby.
  const labelSuggestions = (): string[] => {
    const editor = editorRef.current, model = editor?.getModel();
    const slug = (s: string) => s.toLowerCase().replace(/\*|_|`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    const out: string[] = [];
    if (editor && model) {
      const ln = editor.getPosition()?.lineNumber ?? 1;
      for (let k = ln; k >= Math.max(1, ln - 8); k--) {
        const line = model.getLineContent(k);
        const h = line.match(/^\s*=+\s+(.+?)\s*$/);
        if (h) { out.push(`sec:${slug(h[1])}`); break; }
        if (/figure\(|\bimage\(/.test(line)) out.push('fig:');
        else if (/#table\(|\btable\(/.test(line)) out.push('tab:');
        else if (/\$|math\.equation/.test(line)) out.push('eq:');
      }
    }
    for (const p of ['eq:', 'fig:', 'tab:', 'sec:']) if (!out.includes(p)) out.push(p);
    return out;
  };

  const insertLabel = () => {
    const sugg = labelSuggestions();
    setInputModal({
      title: 'Insert Label',
      fields: [{ key: 'label', label: 'Label name', default: sugg[0] || 'sec:intro', options: sugg, placeholder: 'eq:energy', hint: 'Attach to the preceding heading / equation / figure; reference it later with @name. Pick a suggestion or type your own.' }],
      submitLabel: 'Add Label',
      onSubmit: (v) => { if (v.label) insertCode(` <${v.label}>`); }
    });
  };

  // Best-effort Typst-math → sympy translation for the compute dialog.
  const typstToSympy = (s: string) => s.replace(/\$/g, '').replace(/\^/g, '**').replace(/\bdif\b/g, 'd').trim();

  // Compute on the current selection: send it to sympy (simplify / solve / diff /
  // integrate / numeric) and return the result as a typeset equation. Reuses the
  // existing code runner (equation mode → "Insert as equation").
  const computeSelection = () => {
    const { inner: selected } = getSelectionCtx('');
    setInputModal({
      title: 'Compute Selection (sympy)',
      fields: [
        { key: 'op', label: 'Operation', type: 'select', default: 'simplify', options: ['simplify', 'expand', 'factor', 'solve = 0', 'differentiate', 'integrate', 'numeric value'] },
        { key: 'expr', label: 'Expression (sympy syntax: ** for powers, * for ×)', type: 'textarea', default: typstToSympy(selected) || 'x**2 - 1' },
        { key: 'var', label: 'Variable', default: 'x' },
      ],
      submitLabel: 'Open in runner',
      onSubmit: (v) => {
        const expr = typstToSympy(v.expr);
        const va = (v.var || 'x').trim() || 'x';
        let code = expr;
        switch (v.op) {
          case 'simplify': code = `simplify(${expr})`; break;
          case 'expand': code = `expand(${expr})`; break;
          case 'factor': code = `factor(${expr})`; break;
          case 'solve = 0': {
            const eq = expr.includes('=') && !expr.includes('==')
              ? `Eq(${expr.split('=')[0]}, ${expr.split('=').slice(1).join('=')})`
              : `Eq(${expr}, 0)`;
            code = `solve(${eq}, ${va})`; break;
          }
          case 'differentiate': code = `diff(${expr}, ${va})`; break;
          case 'integrate': code = `integrate(${expr}, ${va})`; break;
          case 'numeric value': code = `N(${expr})`; break;
        }
        setCodeRunner({ initialLang: 'python', initialMode: 'equation', initialCode: code });
      }
    });
  };

  // Add a #bibliography(...) call at the end of the document if it isn't there yet.
  const ensureBibliography = () => {
    const editor = editorRef.current, model = editor?.getModel();
    if (!editor || !model) return;
    if (model.getValue().includes('#bibliography(')) return;
    const last = model.getLineCount();
    const col = model.getLineMaxColumn(last);
    editor.executeEdits('bib', [{ range: { startLineNumber: last, startColumn: col, endLineNumber: last, endColumn: col } as any, text: '\n\n#bibliography("refs.bib")\n', forceMoveMarkers: true }]);
    editor.focus();
  };

  // Toggle numbering on the heading or block-equation under the cursor.
  const toggleNumbering = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const pos = editor.getPosition();
    if (!pos) return;
    const ln = pos.lineNumber;
    const line = model.getLineContent(ln);
    let next: string | null = null;

    const mHeadNum = line.match(/^(\s*)(=+)\s+(.*?)\s*$/);
    const mHeadUn = line.match(/^(\s*)#heading\(level:\s*(\d+),\s*numbering:\s*none\)\[(.*)\]\s*$/);
    const mEqUn = line.match(/^(\s*)#math\.equation\(block:\s*true,\s*numbering:\s*none,\s*(\$.*\$)\)\s*(<[^>]+>)?\s*$/);
    const mEqNum = line.match(/^(\s*)(\$.*\$)\s*(<[^>]+>)?\s*$/);

    if (mHeadUn) {
      next = `${mHeadUn[1]}${'='.repeat(Number(mHeadUn[2]))} ${mHeadUn[3]}`;
    } else if (mHeadNum) {
      next = `${mHeadNum[1]}#heading(level: ${mHeadNum[2].length}, numbering: none)[${mHeadNum[3]}]`;
    } else if (mEqUn) {
      next = `${mEqUn[1]}${mEqUn[2]}${mEqUn[3] ? ' ' + mEqUn[3] : ''}`;
    } else if (mEqNum) {
      next = `${mEqNum[1]}#math.equation(block: true, numbering: none, ${mEqNum[2]})${mEqNum[3] ? ' ' + mEqNum[3] : ''}`;
    }

    if (next === null) { setErrorLogs('Toggle numbering: place the cursor on a heading (= ...) or a block equation ($ ... $).'); return; }
    editor.executeEdits('toggle-numbering', [{
      range: { startLineNumber: ln, startColumn: 1, endLineNumber: ln, endColumn: line.length + 1 } as any,
      text: next, forceMoveMarkers: true
    }]);
    editor.focus();
  };
  toggleNumberingRef.current = toggleNumbering;

  // Turn equation numbering on/off for the whole document by flipping the
  // `#set math.equation(numbering: …)` rule (adds one if missing).
  const toggleEquationNumbering = () => {
    const editor = editorRef.current, model = editor?.getModel();
    if (!editor || !model) return;
    const text = model.getValue();
    const re = /#set\s+math\.equation\(numbering:\s*("[^"]*"|none|[^)]+)\)/;
    const m = text.match(re);
    if (m) {
      const off = m[1].trim() !== 'none';
      const newLine = `#set math.equation(numbering: ${off ? 'none' : '"(1)"'})`;
      const start = text.indexOf(m[0]);
      const from = model.getPositionAt(start), to = model.getPositionAt(start + m[0].length);
      editor.executeEdits('eq-num', [{ range: { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column } as any, text: newLine, forceMoveMarkers: true }]);
      setErrorLogs(null);
    } else {
      ensureRule('math.equation(numbering', '#set math.equation(numbering: "(1)")');
    }
    editor.focus();
  };

  // Number / un-number *this* equation only (independent of the document-wide
  // toggle). Operates on the selection, or the equation on the current line.
  // A numbered equation becomes `#math.equation(block: true, numbering: "(1)", $…$)`
  // (centred + numbered, whatever the global setting); toggling flips it to `none`.
  const toggleThisEquationNumber = () => {
    const editor = editorRef.current, model = editor?.getModel();
    if (!editor || !model) return;
    editor.focus();
    const sel = editor.getSelection();
    let text: string, range: any;
    if (sel && !sel.isEmpty()) {
      text = model.getValueInRange(sel); range = sel;
    } else {
      const ln = editor.getPosition()?.lineNumber ?? 1;
      text = model.getLineContent(ln);
      range = { startLineNumber: ln, startColumn: 1, endLineNumber: ln, endColumn: model.getLineMaxColumn(ln) };
    }
    let out: string;
    const wrapped = text.match(/#math\.equation\(block:\s*true,\s*numbering:\s*(none|"[^"]*"),\s*(\$[\s\S]*\$)\s*\)/);
    if (wrapped) {
      // Already an explicit numbered/unnumbered equation → flip its numbering.
      const flip = wrapped[1] === 'none' ? '"(1)"' : 'none';
      out = text.replace(wrapped[0], `#math.equation(block: true, numbering: ${flip}, ${wrapped[2]})`);
    } else {
      // Find a $…$ (or treat the whole selection as the body) and number it.
      const eq = text.match(/\$[\s\S]*?\$/);
      const body = eq ? eq[0].slice(1, -1).trim() : text.trim();
      const equation = `#math.equation(block: true, numbering: "(1)", $ ${body} $)`;
      out = eq ? text.replace(eq[0], equation) : equation;
    }
    editor.executeEdits('eq-num-one', [{ range, text: out, forceMoveMarkers: true }]);
    editor.focus();
  };

  // Turn the selected lines into a bullet (-) or numbered (+) list. With no
  // selection, insert a small starter list.
  const makeList = (marker: '-' | '+') => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    editor.focus();
    const sel = editor.getSelection();
    if (!sel || sel.isEmpty()) {
      insertCode(`\n${marker} First item\n${marker} Second item\n${marker} Third item\n\n`);
      return;
    }
    const lines = [];
    for (let ln = sel.startLineNumber; ln <= sel.endLineNumber; ln++) {
      const text = model.getLineContent(ln);
      lines.push(text.trim() ? `${marker} ${text.replace(/^\s*[-+]\s+/, '')}` : text);
    }
    editor.executeEdits('list', [{
      range: { startLineNumber: sel.startLineNumber, startColumn: 1, endLineNumber: sel.endLineNumber, endColumn: model.getLineMaxColumn(sel.endLineNumber) } as any,
      text: lines.join('\n'), forceMoveMarkers: true
    }]);
    editor.focus();
  };

  const insertMultilineEquation = () => {
    ensureRule('math.equation(numbering', '#set math.equation(numbering: "(1)")');
    insertCode('\n$\n  a &= b + c \\\n    &= d + e\n$\n\n');
  };

  // Nest / un-nest list items by shifting the selected lines two spaces — Typst
  // reads indentation as list depth, so this turns items into sub-items.
  const shiftIndent = (dir: 1 | -1) => {
    const editor = editorRef.current, model = editor?.getModel();
    if (!editor || !model) return;
    editor.focus();
    const sel = editor.getSelection();
    if (!sel) return;
    const from = sel.startLineNumber, to = sel.isEmpty() ? sel.startLineNumber : sel.endLineNumber;
    const edits: any[] = [];
    for (let ln = from; ln <= to; ln++) {
      const t = model.getLineContent(ln);
      if (dir > 0) {
        if (t.trim()) edits.push({ range: { startLineNumber: ln, startColumn: 1, endLineNumber: ln, endColumn: 1 }, text: '  ', forceMoveMarkers: true });
      } else {
        const m = t.match(/^ {1,2}/);
        if (m) edits.push({ range: { startLineNumber: ln, startColumn: 1, endLineNumber: ln, endColumn: m[0].length + 1 }, text: '', forceMoveMarkers: true });
      }
    }
    if (edits.length) editor.executeEdits('indent', edits);
    editor.focus();
  };

  // Insert a nested list starter (list-inside-list) or a term/definition list.
  const insertNestedList = () => insertCode('\n- First point\n  - Sub-point\n  - Sub-point\n    + Numbered sub-sub-point\n- Second point\n\n');
  const insertTermList = () => insertCode('\n/ Term: its definition or explanation.\n/ Second term: another definition.\n\n');

  // Slide building blocks. The floating box is plain built-in Typst; the
  // subfigure grid and the fletcher diagram each pull a small package, imported
  // once at the top of the document (skipped if it's already there).
  const insertFloatingBox = () => insertCode(
    '\n// Floating text box — move it by changing dx/dy (0% = top-left, 100% = bottom-right).\n' +
    '#place(top + left, dx: 55%, dy: 25%, block(\n' +
    '  fill: yellow.lighten(60%), inset: 8pt, radius: 4pt, stroke: 0.5pt,\n' +
    ')[\n  Floating callout \\\n  placed anywhere\n])\n');

  const insertSubfigures = () => {
    ensureSetup('@preview/subpar', '#import "@preview/subpar:0.2.2"');
    // Unique suffix per insert so two subfigure blocks never clash on labels.
    const id = Math.random().toString(36).slice(2, 7);
    insertCode(
      '\n#subpar.grid(\n' +
      `  figure(rect(width: 100%, height: 3cm, fill: luma(230)), caption: [left]), <${id}-a>,\n` +
      `  figure(rect(width: 100%, height: 3cm, fill: luma(200)), caption: [right]), <${id}-b>,\n` +
      '  columns: (1fr, 1fr),\n' +
      `  caption: [Two panels, @${id}-a and @${id}-b.],\n` +
      `  label: <fig-${id}>,\n)\n\n`);
  };

  const insertFletcher = () => {
    ensureSetup('@preview/fletcher', '#import "@preview/fletcher:0.5.8" as fletcher: node, edge');
    insertCode(
      '\n#fletcher.diagram(\n  node-stroke: 0.5pt,\n' +
      '  node((0,0), [Input]), edge("->"),\n' +
      '  node((1,0), [Process]), edge("->"),\n' +
      '  node((2,0), [Output]),\n)\n\n');
  };

  // --- Text features: callouts, notes, quotes, typographic emphasis ----------
  // Self-contained callout (no external package): a coloured, left-ruled block
  // whose colour, icon and title follow the chosen kind.
  const CALLOUT_SETUP = `#let callout(body, kind: "note") = {
  let (c, ic, tt) = if kind == "warning" { (orange, "⚠", "Warning") } else if kind == "definition" { (purple, "❖", "Definition") } else if kind == "example" { (green, "▸", "Example") } else if kind == "important" { (red, "‼", "Important") } else { (blue, "ℹ", "Note") }
  block(fill: c.lighten(90%), stroke: (left: 3pt + c), radius: 4pt, inset: 10pt, width: 100%, breakable: true)[
    #text(fill: c.darken(15%), weight: "bold")[#ic #h(4pt) #tt]
    #v(3pt)
    #body
  ]
}`;
  // Margin note via the `drafting` package: notes auto-stack in the right margin
  // (no overlap even when several sit close together) and adapt to the page's
  // actual margin — unlike the old fixed-offset `place`, which collided with
  // dense text and piled notes on top of each other. Tufte-style: small grey
  // text, no box.
  const SIDENOTE_SETUP = `#import "@preview/drafting:0.2.2": margin-note
#let sidenote(body) = margin-note(stroke: none, text(size: 8.5pt, fill: gray.darken(25%), body))`;

  const insertCallout = () => setInputModal({
    title: 'Insert Callout / Admonition',
    fields: [
      { key: 'kind', label: 'Type', type: 'select', default: 'note', options: ['note', 'important', 'warning', 'definition', 'example'] },
      { key: 'body', label: 'Content', type: 'textarea', default: 'Your text here.' },
    ],
    submitLabel: 'Insert',
    onSubmit: (v) => { ensureSetup('#let callout', CALLOUT_SETUP); insertCode(`\n#callout(kind: "${v.kind}")[${v.body}]\n\n`); },
  });

  const insertFootnote = () => {
    const { editor, model, sel, inner } = getSelectionCtx('note text');
    if (sel && model && !sel.isEmpty()) replaceOrInsert(sel, editor, model, `#footnote[${inner}]`);
    else insertCode('#footnote[note text]');
  };

  const insertHRule = () => insertCode('\n#line(length: 100%, stroke: 0.5pt)\n');

  const insertSideNote = () => setInputModal({
    title: 'Insert Margin / Side Note',
    fields: [{ key: 'body', label: 'Note (appears in the right margin)', type: 'textarea', default: 'side note' }],
    submitLabel: 'Insert',
    onSubmit: (v) => { ensureSetup('#let sidenote', SIDENOTE_SETUP); insertCode(`#sidenote[${v.body}]`); },
  });

  // Insert an empty fenced code block and drop the cursor on the blank line
  // inside it (⌘⇧B, or Insert → Code → Code Block).
  const insertCodeBlock = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) { insertCode('\n```\n\n```\n'); return; }
    const sel = editor.getSelection();
    const line = sel ? sel.startLineNumber : model.getLineCount();
    editor.executeEdits('code-block', [{
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 } as any,
      text: '```\n\n```\n', forceMoveMarkers: true,
    }]);
    editor.setPosition({ lineNumber: line + 1, column: 1 });
    editor.focus();
  };

  const insertBlockQuote = () => setInputModal({
    title: 'Insert Block Quote',
    fields: [
      { key: 'body', label: 'Quotation', type: 'textarea', default: 'Quoted text.' },
      { key: 'author', label: 'Attribution (optional)', default: '', placeholder: 'e.g. Dirac, 1928' },
    ],
    submitLabel: 'Insert',
    onSubmit: (v) => { const attr = v.author ? `attribution: [${v.author}], ` : ''; insertCode(`\n#quote(block: true, ${attr})[${v.body}]\n\n`); },
  });

  const insertTracking = () => setInputModal({
    title: 'Letter Spacing (tracking)',
    fields: [{ key: 'amt', label: 'Tracking (em — try 0.08)', default: '0.08' }],
    submitLabel: 'Apply',
    onSubmit: (v) => { const { editor, model, sel, inner } = getSelectionCtx('spaced'); replaceOrInsert(sel, editor, model, `#text(tracking: ${v.amt}em)[${inner}]`); },
  });

  // Change the font size of the selected text (wraps in #text(size: ..pt)[...]).
  const setSelectionFontSize = (pt: string) => {
    if (!pt) return;
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    editor.focus();
    const sel = editor.getSelection();
    if (sel && !sel.isEmpty()) {
      const inner = model.getValueInRange(sel);
      editor.executeEdits('font-size', [{ range: sel, text: `#text(size: ${pt}pt)[${inner}]`, forceMoveMarkers: true }]);
    } else {
      insertCode(`#text(size: ${pt}pt)[text]`);
    }
    editor.focus();
  };

  const getOutline = () => {
    if (!activeTab) return [];
    const lines = activeTab.content.split('\n');
    return lines.map((line, i) => {
      const match = line.match(/^(=+)\s+(.*)/);
      if (match) return { level: match[1].length, text: match[2], line: i + 1 };
      return null;
    }).filter(Boolean) as { level: number; text: string; line: number }[];
  };

  const jumpToLine = (line: number) => {
    if (!editorRef.current) return;
    editorRef.current.revealLineInCenter(line);
    editorRef.current.setPosition({ lineNumber: line, column: 1 });
    editorRef.current.focus();
  };

  // Parse `typst compile` diagnostics into structured, clickable problems.
  type Problem = { severity: 'error' | 'warning'; message: string; file?: string; line?: number; col?: number };
  const parseProblems = (logs: string | null): Problem[] => {
    if (!logs) return [];
    const lines = logs.split('\n');
    const out: Problem[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*(error|warning):\s*(.*)$/);
      if (!m) continue;
      const prob: Problem = { severity: m[1] as any, message: m[2].trim() };
      // The location line (┌─ file:line:col) usually follows within a few lines.
      let fromPackage = false;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        if (lines[j].includes('@preview/')) fromPackage = true; // location points inside a package
        const loc = lines[j].match(/([\w./\-]+):(\d+):(\d+)/);
        if (loc) { prob.file = loc[1]; prob.line = Number(loc[2]); prob.col = Number(loc[3]); break; }
      }
      // Skip warnings that originate inside an imported package (e.g. mitex's own
      // deprecation notices) — the user can't act on them and they only add noise.
      if (fromPackage && prob.severity === 'warning') continue;
      out.push(prob);
    }
    return out;
  };
  const problems = useMemo(() => parseProblems(errorLogs), [errorLogs]);

  const jumpToProblem = async (p: Problem) => {
    if (!p.line) return;
    if (p.file && p.file !== activeTabPath && !p.file.includes('@preview')) {
      const base = p.file.split('/').pop() || p.file;
      if (tabs.find(t => t.path === base) || fileTree.some(n => n.name === base)) await openFile(base);
    }
    const ed = editorRef.current;
    if (!ed) return;
    ed.revealLineInCenter(p.line);
    ed.setPosition({ lineNumber: p.line, column: p.col || 1 });
    ed.focus();
  };

  // Bidirectional PDF ↔ source sync. Both directions match a multi-word phrase
  // (not a lone word), so a word that repeats can't send you to the wrong line,
  // and both refuse to jump when the phrase can't be confidently pinned down.
  const syncDecorations = useRef<string[]>([]);

  const flashSourceRange = (line: number, col: number, len: number) => {
    const ed = editorRef.current; if (!ed) return;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: col });
    ed.focus();
    const range = { startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col + Math.max(1, len) };
    syncDecorations.current = ed.deltaDecorations(syncDecorations.current, [{ range, options: { inlineClassName: 'sync-flash' } }]);
    setTimeout(() => { if (editorRef.current) syncDecorations.current = editorRef.current.deltaDecorations(syncDecorations.current, []); }, 1300);
  };

  // Flatten the active model into positioned word tokens, skipping line comments
  // so `// note` text can't be matched. Markup punctuation (#, =, *, _, $ …) is
  // dropped naturally since only word characters form tokens.
  const tokenizeSourceModel = (model: any): { w: string; line: number; col: number }[] => {
    const out: { w: string; line: number; col: number }[] = [];
    const lc = model.getLineCount();
    for (let ln = 1; ln <= lc; ln++) {
      const text = model.getLineContent(ln);
      const ci = text.indexOf('//');
      for (const t of tokenizeLine(text)) {
        if (ci !== -1 && t.offset >= ci) break;
        out.push({ w: t.w, line: ln, col: t.offset + 1 });
      }
    }
    return out;
  };

  // Reverse: a PDF word (with its neighbours) → the exact source location.
  const reverseSync = useCallback(async (p: SyncPayload) => {
    const editor = editorRef.current; const model = editor?.getModel();
    if (!editor || !model) return;
    const focusWord = p.words[p.focus];
    if (!focusWord) return;

    const src = tokenizeSourceModel(model);
    const res = bestMatch(src.map(s => s.w), p.words, p.focus, Math.round(p.docFraction * src.length));
    if (res) {
      const tok = src[res.index];
      flashSourceRange(tok.line, tok.col, tok.w.length);
      return;
    }

    // Not in the active file — search the workspace, disambiguating by the
    // surrounding PDF words, and open the best-scoring file/line.
    try {
      const ctx = p.words.filter((_, i) => i !== p.focus);
      const resp = await fetch(`${API}/workspace/search?q=${encodeURIComponent(focusWord)}`);
      const hits = await resp.json();
      if (Array.isArray(hits) && hits.length) {
        let bestHit = hits[0], bestLine = hits[0].matches[0].lineNum, bestScore = -1;
        for (const hit of hits) for (const m of hit.matches) {
          const text = (m.text || '').toLowerCase();
          const score = ctx.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
          if (score > bestScore) { bestScore = score; bestHit = hit; bestLine = m.lineNum; }
        }
        handleNodeClick({} as any, bestHit.path, false);
        setTimeout(() => flashSourceRange(bestLine, 1, 0), 120);
        return;
      }
    } catch {}
    // Genuinely couldn't locate it (e.g. rendered math) — say so, don't guess.
    setErrorLogs(`Couldn't locate “${focusWord}” in the source (rendered math or symbols may differ from the markup).`);
  }, []);

  // Forward: the editor cursor → reveal & flash the matching word in the PDF.
  const forwardSync = useCallback(() => {
    const ed = editorRef.current; const model = ed?.getModel();
    if (!ed || !model || !pdfRef.current) return;
    const pos = ed.getPosition(); if (!pos) return;
    const total = model.getLineCount();

    // Find prose at/near the cursor (math and blank lines carry no words).
    let line = pos.lineNumber;
    let toks = tokenizeLine(model.getLineContent(line));
    for (let d = 1; !toks.length && d <= 6; d++) {
      if (pos.lineNumber - d >= 1 && (toks = tokenizeLine(model.getLineContent(pos.lineNumber - d))).length) { line = pos.lineNumber - d; break; }
      if (pos.lineNumber + d <= total && (toks = tokenizeLine(model.getLineContent(pos.lineNumber + d))).length) { line = pos.lineNumber + d; break; }
    }
    if (!toks.length) { setErrorLogs('Nothing to sync — place the cursor on a line with text.'); return; }

    let focus = 0, bestD = Infinity;
    const anchorCol = line === pos.lineNumber ? pos.column : 1;
    toks.forEach((t, i) => { const d = Math.abs(t.offset + 1 - anchorCol); if (d < bestD) { bestD = d; focus = i; } });
    const ok = pdfRef.current.revealSource({ words: toks.map(t => t.w), focus, docFraction: (line - 0.5) / total });
    if (!ok) setErrorLogs('Couldn’t find this line in the PDF (recompile if the preview is stale, or the text may be inside math).');
  }, []);

  useEffect(() => { forwardSyncRef.current = forwardSync; }, [forwardSync]);

  const formatBytes = (bytes: number, decimals = 1) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024, dm = decimals < 0 ? 0 : decimals, sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'], i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
  };

  const formatTime = (ms: number) => {
    if (!ms) return '';
    const date = new Date(ms);
    const isToday = new Date().toDateString() === date.toDateString();
    return (isToday ? 'Today ' : date.toLocaleDateString() + ' ') + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const getGitStatusForPath = (path: string, isDir: boolean) => {
    if (isDir) {
      // Check if any file inside this dir is dirty or untracked
      const hasDirty = tabs.some(t => t.isDirty && t.path.startsWith(path + '/'));
      return hasDirty ? 'DIR' : null;
    }
    
    const tab = tabs.find(t => t.path === path);
    if (tab && tab.isDirty) return 'M';
    return null;
  };

  const jumpToSnippetLine = (path: string, lineNum: number) => {
    handleNodeClick({} as any, path, false);
    // Let the tab switch and monaco editor update, then jump
    setTimeout(() => {
      if (editorRef.current) {
        editorRef.current.revealLineInCenter(lineNum);
        editorRef.current.setPosition({ lineNumber: lineNum, column: 1 });
        editorRef.current.focus();
      }
    }, 50);
  };

  const renderTree = (nodes: FileNode[]) => {
    return nodes.map(node => (
      <div key={node.path} className="tree-node">
        {node.type === 'directory' ? (
          <div className={`tree-dir-container ${collapsedDirs.has(node.path) ? '' : 'open'}`} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDrop={e => handleDrop(e, node.path)}>
            <div data-path={node.path} draggable={true} onDragStart={e => handleDragStart(e, node.path)} className={`tree-dir ${selectedPaths.includes(node.path) ? 'selected' : ''}`} onClick={(e) => { e.preventDefault(); if (!e.ctrlKey && !e.metaKey && !e.shiftKey && renamingPath !== node.path) toggleDir(node.path); handleNodeClick(e, node.path, true); }} onContextMenu={(e) => handleNodeContextMenu(e, node, 'folder')} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
              <svg className="tree-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginRight: '2px', flexShrink: 0, transition: 'transform 0.12s ease' }}><polyline points="9 18 15 12 9 6"></polyline></svg>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
              {renamingPath === node.path ? (
                <input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)} onBlur={() => setRenamingPath(null)} onKeyDown={e => { if (e.key === 'Enter') commitRename(node, renameValue); if (e.key === 'Escape') setRenamingPath(null); e.stopPropagation(); }} onClick={e => e.stopPropagation()} className="tree-name-input" style={{ flex: 1, background: 'var(--bg-color)', color: 'var(--text-color)', border: '1px solid var(--accent)', padding: '2px 4px', fontSize: 'inherit', outline: 'none' }} />
              ) : (
                <>
                  <span className="tree-name">{node.name}</span>
                  {getGitStatusForPath(node.path, true) && <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)', marginLeft: 'auto', marginRight: '6px' }} />}
                  <button className="tree-del" title="Delete folder" onClick={(e) => deleteEntry(e, node.path, true)}>×</button>
                </>
              )}
            </div>
            <div className="tree-children">{node.children && renderTree(node.children)}</div>
          </div>
        ) : (
          <div key={node.path} style={{ display: 'flex', flexDirection: 'column' }}>
            <div data-path={node.path} draggable={true} onDragStart={e => handleDragStart(e, node.path)} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDrop={e => {
              const parentDir = node.path.includes('/') ? node.path.substring(0, node.path.lastIndexOf('/')) : '';
              handleDrop(e, parentDir);
            }} className={`tree-file ${activeTabPath === node.path ? 'active' : ''} ${selectedPaths.includes(node.path) ? 'selected' : ''}`} onClick={(e) => handleNodeClick(e, node.path, false)} onContextMenu={(e) => handleNodeContextMenu(e, node, 'file')}
                 title={node.size !== undefined ? `${node.name}\n${formatBytes(node.size)}\nModified: ${formatTime(node.mtime || 0)}\n${node.name.endsWith('.typ') ? 'Typst Document' : 'File'}` : node.name}>
              <span style={{ width: '14px', flexShrink: 0 }} aria-hidden="true"></span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
              {renamingPath === node.path ? (
                <input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)} onBlur={() => setRenamingPath(null)} onKeyDown={e => { if (e.key === 'Enter') commitRename(node, renameValue); if (e.key === 'Escape') setRenamingPath(null); e.stopPropagation(); }} onClick={e => e.stopPropagation()} className="tree-name-input" style={{ flex: 1, background: 'var(--bg-color)', color: 'var(--text-color)', border: '1px solid var(--accent)', padding: '2px 4px', fontSize: 'inherit', outline: 'none', marginLeft: '5px' }} />
              ) : (
                <>
                  <span className="tree-name">{node.name}</span>
                  {node.path === currentMain && (
                    <span title="Main file — the preview compiles this" style={{ marginLeft: 'auto', marginRight: '4px', fontSize: '0.58rem', letterSpacing: '0.03em', fontWeight: 700, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: '4px', padding: '0 4px', opacity: 0.85 }}>MAIN</span>
                  )}
                  {(() => {
                    const stat = getGitStatusForPath(node.path, false);
                    if (!stat) return null;
                    const color = '#f59e0b'; // Yellow for 'M'
                    return <span style={{ marginLeft: node.path === currentMain ? '0' : 'auto', marginRight: '4px', fontSize: '0.65rem', color, fontWeight: 'bold' }}>{stat}</span>;
                  })()}
                  <button className="tree-del" title="Delete file" onClick={(e) => deleteEntry(e, node.path, false)}>×</button>
                </>
              )}
            </div>
            {node.matches && node.matches.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {node.matches.slice(0, 10).map((m, i) => (
                  <div key={i} className="tree-snippet tree-file" onClick={() => {
                     jumpToSnippetLine(node.path, m.lineNum);
                  }} style={{ paddingLeft: '32px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    <span style={{ color: 'var(--accent)', marginRight: '4px', opacity: 0.8 }}>{m.lineNum}:</span>
                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.text}</span>
                  </div>
                ))}
                {node.matches.length > 10 && (
                  <div style={{ paddingLeft: '32px', fontSize: '0.7rem', color: 'var(--text-muted)', opacity: 0.7, paddingBottom: '4px' }}>
                    + {node.matches.length - 10} more matches
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    ));
  };

  const filterTree = (nodes: FileNode[], query: string, contentMatches: SearchResult[]): FileNode[] => {
    if (!query) return nodes;
    const lowerQuery = query.toLowerCase();
    
    // Also find any unsaved tabs that match the query
    const dirtyTabMatches: SearchResult[] = tabs
      .map(t => {
        const lines = t.content.split('\n');
        const matches: SearchSnippet[] = [];
        lines.forEach((line, i) => {
          if (line.toLowerCase().includes(lowerQuery)) {
            matches.push({ lineNum: i + 1, text: line.trim() });
          }
        });
        return matches.length > 0 ? { path: t.path, matches } : null;
      })
      .filter(Boolean) as SearchResult[];
    
    // Map of path to matches
    const allMatches = new Map<string, SearchSnippet[]>();
    for (const r of [...contentMatches, ...dirtyTabMatches]) {
      allMatches.set(r.path, r.matches);
    }

    const walk = (ns: FileNode[]): FileNode[] => {
      return ns.map(node => {
        if (node.type === 'directory') {
          const filteredChildren: FileNode[] = walk(node.children || []);
          if (filteredChildren.length > 0 || node.name.toLowerCase().includes(lowerQuery) || allMatches.has(node.path)) {
            return { ...node, children: filteredChildren };
          }
          return null;
        }
        
        const isNameMatch = node.name.toLowerCase().includes(lowerQuery);
        const fileMatches = allMatches.get(node.path);
        
        if (isNameMatch || fileMatches) {
          return { ...node, matches: fileMatches || [] };
        }
        return null;
      }).filter(Boolean) as FileNode[];
    };
    return walk(nodes);
  };

  // Memoize derived views so typing doesn't re-walk the tree / re-scan headings
  // on every keystroke (they only depend on the tree and the active file).
  // The tree reads tabs only for the dirty markers, so key it on the set of
  // dirty paths — not the tabs array, whose identity changes on every keystroke.
  const dirtyPathsKey = useMemo(() => tabs.filter(t => t.isDirty).map(t => t.path).sort().join('\u0001'), [tabs]);
  const treeJsx = useMemo(() => renderTree(filterTree(fileTree, treeSearch, searchContentResults)), [fileTree, activeTabPath, renamingPath, renameValue, selectedPaths, collapsedDirs, currentMain, dirtyPathsKey, treeSearch, searchContentResults]);
  const outline = useMemo(() => (sidebarOpen ? getOutline() : []), [activeTab?.content, sidebarOpen]);

  const toggleMenu = (e: React.MouseEvent, menuName: string) => {
    e.stopPropagation();
    setActiveMenu(activeMenu === menuName ? null : menuName);
  };
  // Native-menubar feel: once a menu is open, sliding along the bar switches menus.
  const menuProps = (name: string) => ({
    className: activeMenu === name ? 'menu-item open' : 'menu-item',
    onClick: (e: React.MouseEvent) => toggleMenu(e, name),
    onMouseEnter: () => { if (activeMenu && activeMenu !== name) setActiveMenu(name); },
  });

  const revealInFileManager = async (path?: string) => {
    try { await fetch(`${API}/workspace/reveal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: path || '' }) }); } catch {}
  };
  const copyToClipboard = (text: string) => navigator.clipboard.writeText(text);
  const collectDirPaths = (nodes: FileNode[], acc: string[] = []): string[] => {
    for (const n of nodes) {
      if (n.type === 'directory') { acc.push(n.path); if (n.children) collectDirPaths(n.children, acc); }
    }
    return acc;
  };
  const collapseTree = () => setCollapsedDirs(new Set(collectDirPaths(fileTree)));
  const expandTree = () => setCollapsedDirs(new Set());
  const copyAbsolutePath = async (path: string) => {
    try {
      const res = await fetch(`${API}/workspace/root`);
      const { root } = await res.json();
      navigator.clipboard.writeText(`${root}/${path}`);
    } catch {}
  };

  // Everything reachable from the menus, exposed to the ⌘K palette. Built on
  // open (not memoised) so each command closes over current state.
  const paletteCommands = (): PaletteCommand[] => [
    { category: 'File', title: 'New File...', run: createNewFile },
    { category: 'File', title: 'Open File...', run: openFromDisk },
    { category: 'File', title: 'Open Folder as Workspace...', run: openFolderAsRoot },
    { category: 'File', title: 'Import Folder into Project...', run: openFolderFromDisk },
    { category: 'File', title: 'Import Font (.ttf / .otf)...', run: importFont },
    { category: 'File', title: 'New from Template...', run: () => setShowTemplateInstaller(true) },
    { category: 'File', title: 'Save', hint: '⌘S', run: saveActiveFile },
    { category: 'File', title: 'Save As / Export...', run: () => setShowSaveAs(true) },
    { category: 'File', title: 'Sync / Share (Drive, WebDAV)...', run: () => setShowDriveSync(true) },
    { category: 'Edit', title: 'Undo', run: () => editorRef.current?.trigger('palette', 'undo', null) },
    { category: 'Edit', title: 'Redo', run: () => editorRef.current?.trigger('palette', 'redo', null) },
    { category: 'Edit', title: 'Find...', run: () => editorRef.current?.getAction('actions.find')?.run() },
    { category: 'Edit', title: 'Find & Replace...', run: () => editorRef.current?.getAction('editor.action.startFindReplaceAction')?.run() },
    { category: 'Edit', title: 'Toggle Numbering (at cursor)', hint: '⌘⇧N', run: toggleNumbering },
    { category: 'Edit', title: 'Toggle Equation Numbering (all)', run: toggleEquationNumbering },
    { category: 'Edit', title: 'Document Settings...', run: () => setShowEditSettings(true) },
    { category: 'View', title: 'Toggle Sidebar', run: () => setSidebarOpen(v => !v) },
    { category: 'View', title: 'Toggle Editor Theme (dark / light)', run: () => setTheme(t => t === 'typst-dark' ? 'typst-light' : 'typst-dark') },
    { category: 'View', title: 'Version History...', run: () => setShowHistoryModal(true) },
    { category: 'View', title: 'Recompile Document', run: () => compileTypst(currentMain) },
    { category: 'View', title: 'App Settings (interpreters, git, cloud)...', run: () => setShowAppSettings(true) },
    { category: 'Insert', title: 'Title Block...', run: insertTitleBlock },
    { category: 'Insert', title: 'Author...', run: insertAuthor },
    { category: 'Insert', title: 'Institute...', run: insertInstitute },
    { category: 'Insert', title: 'Abstract', run: insertAbstract },
    { category: 'Insert', title: 'Heading...', run: insertHeading },
    { category: 'Insert', title: 'Theorem / Proof / Lemma...', run: insertTheorem },
    { category: 'Math', title: 'Inline Equation', hint: '⌘E', run: () => wrapSelection('$', '$') },
    { category: 'Math', title: 'Block Equation', run: () => insertCode('\n$ E = m c^2 $\n\n') },
    { category: 'Math', title: 'Multiline / Aligned Equation', run: insertMultilineEquation },
    { category: 'Math', title: 'Numbered Equation...', hint: '⌘⇧E', run: insertNumberedEquation },
    { category: 'Math', title: 'Equation Templates...', hint: '⌘⇧G', run: () => setShowEqGallery(true) },
    { category: 'Math', title: 'Insert Physics (physica)...', run: () => setShowPhysics(true) },
    { category: 'Math', title: 'Matrix Studio...', hint: '⌘⇧M', run: () => setShowMatrixStudio(true) },
    { category: 'Math', title: 'Matrix (augmentation lines)...', run: insertMatrix },
    { category: 'Math', title: 'Conditional / Piecewise (cases)...', run: insertCases },
    { category: 'Math', title: 'Over / Under Brace...', run: insertBrace },
    { category: 'Math', title: 'Cancel / Strike Term...', run: insertCancel },
    { category: 'Math', title: 'Math & Physics Symbols...', hint: '⌘⇧P', run: () => setShowSymbolPicker(true) },
    { category: 'Math', title: 'Draw a Symbol → Typst...', hint: '⌘⇧Y', run: () => setShowSymbolDraw(true) },
    { category: 'Math', title: 'Compute Selection (simplify / solve)...', hint: '⌘⇧U', run: computeSelection },
    { category: 'Lists', title: 'Bullet List', run: () => makeList('-') },
    { category: 'Lists', title: 'Numbered List', run: () => makeList('+') },
    { category: 'Lists', title: 'Nested List', run: insertNestedList },
    { category: 'Lists', title: 'Term / Definition List', run: insertTermList },
    { category: 'Text', title: 'Callout / Admonition box...', run: insertCallout },
    { category: 'Text', title: 'Block Quote...', run: insertBlockQuote },
    { category: 'Text', title: 'Footnote', run: insertFootnote },
    { category: 'Text', title: 'Margin / Side Note...', run: insertSideNote },
    { category: 'Text', title: 'Horizontal Line (full width)', hint: '⌘⇧H', run: insertHRule },
    { category: 'Figures', title: 'Figure...', run: () => setShowFigureBuilder(true) },
    { category: 'Figures', title: 'Image...', run: insertImage },
    { category: 'Figures', title: 'Whiteboard / Sketch (Excalidraw)...', run: insertWhiteboard },
    { category: 'Figures', title: 'Table...', run: insertTable },
    { category: 'Figures', title: 'Import Data (CSV/Excel/JSON)...', run: insertDataFile },
    { category: 'Figures', title: 'Code Block', hint: '⌘⇧B', run: insertCodeBlock },
    { category: 'Figures', title: 'Subfigures (side-by-side)...', run: insertSubfigures },
    { category: 'Plots', title: 'Plot Studio (2D · data · 3D · Python)...', run: () => setShowPlotStudio(true) },
    { category: 'Plots', title: 'cetz Canvas (shapes & grid)...', run: () => setShowDiagramBuilder(true) },
    { category: 'Plots', title: 'Commutative Diagram (quiver)...', run: () => setShowQuiver(true) },
    { category: 'Plots', title: 'Feynman Diagram...', hint: '⌘⇧F', run: () => setShowFeynman(true) },
    { category: 'Plots', title: 'Flow diagram (fletcher)...', run: insertFletcher },
    { category: 'Compute', title: 'Flowchart → Code...', hint: '⌘⇧L', run: () => setShowFlowchart(true) },
    { category: 'Compute', title: 'Run Notebook (all code cells)', run: () => runNotebook() },
    { category: 'Compute', title: 'Run Python...', hint: '⌘⇧K', run: () => setCodeRunner({ initialLang: 'python' }) },
    { category: 'Compute', title: 'Run Julia...', run: () => setCodeRunner({ initialLang: 'julia' }) },
    { category: 'Compute', title: 'Run Wolfram...', run: () => setCodeRunner({ initialLang: 'wolfram' }) },
    { category: 'References', title: 'Link (Web)...', run: insertWebLink },
    { category: 'References', title: 'Cross-reference (Internal)...', run: insertCrossRef },
    { category: 'References', title: 'Label...', run: insertLabel },
    { category: 'References', title: 'Reference & Label Manager...', run: () => setShowRefManager(true) },
    { category: 'References', title: 'Citations & Bibliography (DOI/arXiv)...', run: () => setShowBibManager(true) },
    { category: 'Format', title: 'Bold', hint: '⌘B', run: () => wrapSelection('*', '*') },
    { category: 'Format', title: 'Italic', hint: '⌘I', run: () => wrapSelection('_', '_') },
    { category: 'Format', title: 'Underline', run: () => wrapSelection('#underline[', ']') },
    { category: 'Format', title: 'Superscript', run: () => wrapSelection('#super[', ']') },
    { category: 'Format', title: 'Subscript', run: () => wrapSelection('#sub[', ']') },
    { category: 'Format', title: 'Text Colour...', run: insertTextColor },
    { category: 'Format', title: 'Highlight / Background Colour...', run: insertHighlight },
    { category: 'Format', title: 'Page Setup (size, margins)...', run: insertPageSetup },
    { category: 'Format', title: 'Box Selection (fill, border)...', run: insertBox },
    { category: 'Format', title: 'Font Size...', run: setSelectionFontSizePrompt },
    { category: 'Format', title: 'Align Content...', run: insertAlign },
    { category: 'Format', title: 'Rotate (content or equation)...', run: insertRotate },
    { category: 'Format', title: 'Small Caps', run: () => wrapSelection('#smallcaps[', ']') },
    { category: 'Format', title: 'Strikethrough', run: () => wrapSelection('#strike[', ']') },
    { category: 'Format', title: 'Letter Spacing...', run: insertTracking },
    { category: 'Packages', title: 'Install Typst Package...', run: () => setShowPackageInstaller(true) },
    { category: 'Help', title: 'Features & Help...', run: () => setShowHelp(true) },
  ];

  return (
    <div className="app-container" onClick={() => { setActiveMenu(null); setColorPopAt(null); setHighlightPopAt(null); setFontSizePopAt(null); setContextMenu(null); }} onContextMenu={() => setContextMenu(null)}>
      <Toaster />
      {showPalette && <CommandPalette commands={paletteCommands()} onClose={() => setShowPalette(false)} />}
      <header className="header">
        <div className="header-left">
          <div className="logo logo-btn" style={{ fontSize: '0.9rem', gap: '4px' }} title="About Hilbert" onClick={() => setShowAbout(true)}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="logoGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a78bfa"/><stop offset="1" stopColor="#60a5fa"/></linearGradient></defs><path fillRule="evenodd" clipRule="evenodd" fill="url(#logoGrad)" d="M9.29289 1.29289C9.48043 1.10536 9.73478 1 10 1H18C19.6569 1 21 2.34315 21 4V9C21 9.55228 20.5523 10 20 10C19.4477 10 19 9.55228 19 9V4C19 3.44772 18.5523 3 18 3H11V8C11 8.55228 10.5523 9 10 9H5V20C5 20.5523 5.44772 21 6 21H10C10.5523 21 11 21.4477 11 22C11 22.5523 10.5523 23 10 23H6C4.34315 23 3 21.6569 3 20V8C3 7.73478 3.10536 7.48043 3.29289 7.29289L9.29289 1.29289ZM6.41421 7H9V4.41421L6.41421 7ZM11.2929 10.2929C11.63 9.95583 12.1581 9.90353 12.5547 10.1679C12.7377 10.29 13.138 10.4206 13.8692 10.5557C14.2116 10.619 14.5873 10.6773 15.0006 10.7413L15.0159 10.7436C15.42 10.8062 15.8556 10.8736 16.3008 10.9531C18.0592 11.2671 20.2179 11.8037 21.7071 13.2929C22.907 14.4928 23.2701 15.7765 23.1846 16.8892C23.1413 17.4519 22.9841 17.9568 22.7829 18.3687L23 18.5858C23.781 19.3668 23.781 20.6332 23 21.4142L21.4142 23C20.6332 23.781 19.3668 23.781 18.5858 23L18.3687 22.7829C17.9568 22.9841 17.4519 23.1413 16.8892 23.1846C15.7765 23.2701 14.4928 22.907 13.2929 21.7071C11.8037 20.2179 11.2671 18.0592 10.9531 16.3008C10.8736 15.8556 10.8062 15.42 10.7436 15.0159L10.7413 15.0006C10.6773 14.5873 10.619 14.2116 10.5557 13.8692C10.4206 13.138 10.29 12.7377 10.1679 12.5547C9.90353 12.1581 9.95583 11.63 10.2929 11.2929L10.7926 10.7931L10.7929 10.7929L11.2929 10.2929ZM15.0677 16.482L12.6124 14.0266C12.6482 14.2458 12.683 14.47 12.7177 14.6947L12.7186 14.7006L12.7187 14.7007C12.7821 15.1107 12.8465 15.527 12.9219 15.9492C13.2329 17.6908 13.6963 19.2821 14.7071 20.2929C15.5072 21.093 16.2235 21.2299 16.7358 21.1904C17.3109 21.1462 17.7121 20.8737 17.7929 20.7929C18.1834 20.4024 18.8166 20.4024 19.2071 20.7929L20 21.5858L21.5858 20L20.7929 19.2071C20.6054 19.0196 20.5 18.7652 20.5 18.5C20.5 18.2348 20.6054 17.9804 20.7929 17.7929C20.8737 17.7121 21.1462 17.3109 21.1904 16.7358C21.2299 16.2235 21.093 15.5072 20.2929 14.7071C19.2821 13.6963 17.6908 13.2329 15.9492 12.9219C15.527 12.8465 15.1107 12.7821 14.7007 12.7187L14.7006 12.7186L14.6947 12.7177C14.47 12.683 14.2458 12.6482 14.0266 12.6124L16.482 15.0677C16.6472 15.0236 16.8208 15 17 15C18.1046 15 19 15.8954 19 17C19 18.1046 18.1046 19 17 19C15.8954 19 15 18.1046 15 17C15 16.8208 15.0236 16.6472 15.0677 16.482Z"/></svg>
            Hilbert
          </div>
          <div className="menu-bar">
            <div {...menuProps('file')}>
              File
              {activeMenu === 'file' && (
                <div className="dropdown">
                  <div className="dropdown-item" onClick={createNewFile}>New File...</div>
                  <div className="dropdown-item" onClick={() => { openFromDisk(); setActiveMenu(null); }}>Open File...</div>
                  <div className="dropdown-item" onClick={() => { openFolderAsRoot(); setActiveMenu(null); }}>Open Folder... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.72rem' }}>as workspace</span></div>
                  <div className="dropdown-item has-submenu">
                    <span>Open Recent</span><span className="submenu-arrow">›</span>
                    <div className="submenu">
                      {recentFolders.length === 0 && <div className="dropdown-item" style={{ opacity: 0.5, cursor: 'default' }} onClick={e => e.stopPropagation()}>No recent folders yet</div>}
                      {recentFolders.map(r => (
                        <div className="dropdown-item" key={(r.path ?? r.idb) + String(r.when)} onClick={() => { openRecentFolder(r); setActiveMenu(null); }}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                          {r.name}
                          <span style={{ marginLeft: 'auto', opacity: 0.45, fontSize: '0.7rem' }}>{r.path ? shortenPath(r.path) : 'this browser'}</span>
                        </div>
                      ))}
                      {recentFolders.length > 0 && <>
                        <div className="dropdown-divider"></div>
                        <div className="dropdown-item" onClick={() => { clearRecentFolders(); setActiveMenu(null); }}>Clear Recently Opened</div>
                      </>}
                    </div>
                  </div>
                  <div className="dropdown-item" onClick={() => { openFolderFromDisk(); setActiveMenu(null); }}>Import Folder into Project...</div>
                  <div className="dropdown-item" onClick={() => { importFont(); setActiveMenu(null); }}>Import Font (.ttf / .otf)...</div>
                  <div className="dropdown-item" onClick={() => setShowTemplateInstaller(true)}>New from Template...</div>
                  <div className="dropdown-divider"></div>
                  <div className="dropdown-item" onClick={() => { saveActiveFile(); setActiveMenu(null); }}>Save <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘S</span></div>
                  <div className="dropdown-item" onClick={() => { setShowSaveAs(true); setActiveMenu(null); }}>Save As / Export...</div>
                </div>
              )}
            </div>
            <div {...menuProps('edit')}>
              Edit
              {activeMenu === 'edit' && (
                <div className="dropdown">
                  <div className="dropdown-item" onClick={() => { setShowPalette(true); setActiveMenu(null); }}>Command Palette... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘K</span></div>
                  <div className="dropdown-divider"></div>
                  <div className="dropdown-item" onClick={() => { editorRef.current?.trigger('menu', 'undo', null); setActiveMenu(null); }}>Undo</div>
                  <div className="dropdown-item" onClick={() => { editorRef.current?.trigger('menu', 'redo', null); setActiveMenu(null); }}>Redo</div>
                  <div className="dropdown-divider"></div>
                  <div className="dropdown-item" onClick={() => { editorRef.current?.getAction('actions.find')?.run(); setActiveMenu(null); }}>Find...</div>
                  <div className="dropdown-item" onClick={() => { editorRef.current?.getAction('editor.action.startFindReplaceAction')?.run(); setActiveMenu(null); }}>Find &amp; Replace...</div>
                  <div className="dropdown-divider"></div>
                  <div className="dropdown-item" onClick={() => { toggleNumbering(); setActiveMenu(null); }}>Toggle Numbering (at cursor) <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧N</span></div>
                  <div className="dropdown-item" onClick={() => { toggleEquationNumbering(); setActiveMenu(null); }}>Toggle Equation Numbering (all)</div>
                  <div className="dropdown-item" onClick={() => { setShowEditSettings(true); setActiveMenu(null); }}>Document Settings...</div>
                </div>
              )}
            </div>
            <div {...menuProps('insert')}>
              Insert
              {activeMenu === 'insert' && (
                <div className="dropdown">
                  <div className="dropdown-header">Structure</div>
                  <div className="dropdown-item has-submenu">
                    <span>Document</span><span className="submenu-arrow">›</span>
                    <div className="submenu">
                      <div className="dropdown-item" onClick={() => { insertTitleBlock(); setActiveMenu(null); }}>Title Block...</div>
                      <div className="dropdown-item" onClick={() => { insertAuthor(); setActiveMenu(null); }}>Author...</div>
                      <div className="dropdown-item" onClick={() => { insertInstitute(); setActiveMenu(null); }}>Institute...</div>
                      <div className="dropdown-item" onClick={() => { insertAbstract(); setActiveMenu(null); }}>Abstract</div>
                      <div className="dropdown-item" onClick={() => { insertHeading(); setActiveMenu(null); }}>Heading...</div>
                      <div className="dropdown-item" onClick={() => { insertTheorem(); setActiveMenu(null); }}>Theorem / Proof / Lemma...</div>
                    </div>
                  </div>
                  <div className="dropdown-item has-submenu">
                    <span>Math</span><span className="submenu-arrow">›</span>
                    <div className="submenu">
                      <div className="dropdown-header">Equations</div>
                      <div className="dropdown-item" onClick={() => { wrapSelection('$', '$'); setActiveMenu(null); }}>Inline Equation <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘E</span></div>
                      <div className="dropdown-item" onClick={() => { insertCode('\n$ E = m c^2 $\n\n'); setActiveMenu(null); }}>Block Equation</div>
                      <div className="dropdown-item" onClick={() => { insertMultilineEquation(); setActiveMenu(null); }}>Multiline / Aligned Equation</div>
                      <div className="dropdown-item" onClick={() => { insertNumberedEquation(); setActiveMenu(null); }}>Numbered Equation... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧E</span></div>
                      <div className="dropdown-header">Templates &amp; Structures</div>
                      <div className="dropdown-item" onClick={() => { setShowEqGallery(true); setActiveMenu(null); }}>Equation Templates... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧G</span></div>
                      <div className="dropdown-item" onClick={() => { setShowPhysics(true); setActiveMenu(null); }}>Insert Physics... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>physica</span></div>
                      <div className="dropdown-item" onClick={() => { setShowMatrixStudio(true); setActiveMenu(null); }}>Matrix Studio (fill, borders, code array)... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧M</span></div>
                      <div className="dropdown-item" onClick={() => { insertMatrix(); setActiveMenu(null); }}>Matrix (augmentation lines)...</div>
                      <div className="dropdown-item" onClick={() => { insertCases(); setActiveMenu(null); }}>Conditional / Piecewise (cases)...</div>
                      <div className="dropdown-item" onClick={() => { insertBrace(); setActiveMenu(null); }}>Over / Under Brace...</div>
                      <div className="dropdown-item" onClick={() => { insertCancel(); setActiveMenu(null); }}>Cancel / Strike Term...</div>
                      <div className="dropdown-header">Symbols &amp; Compute</div>
                      <div className="dropdown-item" onClick={() => { setShowSymbolPicker(true); setActiveMenu(null); }}>Math &amp; Physics Symbols... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧P</span></div>
                      <div className="dropdown-item" onClick={() => { setShowSymbolDraw(true); setActiveMenu(null); }}>Draw a Symbol → Typst (experimental)... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧Y</span></div>
                      <div className="dropdown-item" onClick={() => { computeSelection(); setActiveMenu(null); }}>Compute Selection (simplify / solve)... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧U</span></div>
                    </div>
                  </div>
                  <div className="dropdown-item has-submenu">
                    <span>Physics &amp; Cosmology</span><span className="submenu-arrow">›</span>
                    <div className="submenu">
                      {PHYSICS_EQS.map((eq, i) => (
                        <React.Fragment key={eq.name}>
                          {i > 0 && PHYSICS_EQS[i - 1].group !== eq.group && <div className="dropdown-divider"></div>}
                          <div className="dropdown-item" onClick={() => { insertPhysicsEq(eq); setActiveMenu(null); }}>
                            {eq.name} <span style={{ marginLeft: 'auto', opacity: 0.45, fontSize: '0.72rem' }}>{eq.group}</span>
                          </div>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                  <div className="dropdown-item has-submenu">
                    <span>Lists</span><span className="submenu-arrow">›</span>
                    <div className="submenu">
                      <div className="dropdown-item" onClick={() => { makeList('-'); setActiveMenu(null); }}>Bullet List</div>
                      <div className="dropdown-item" onClick={() => { makeList('+'); setActiveMenu(null); }}>Numbered List</div>
                      <div className="dropdown-item" onClick={() => { insertNestedList(); setActiveMenu(null); }}>Nested List (list-in-list)</div>
                      <div className="dropdown-item" onClick={() => { insertTermList(); setActiveMenu(null); }}>Term / Definition List</div>
                      <div className="dropdown-divider"></div>
                      <div className="dropdown-item" onClick={() => { shiftIndent(1); setActiveMenu(null); }}>Indent → nest deeper <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘]</span></div>
                      <div className="dropdown-item" onClick={() => { shiftIndent(-1); setActiveMenu(null); }}>Outdent → nest shallower <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘[</span></div>
                    </div>
                  </div>
                  <div className="dropdown-item has-submenu">
                    <span>Text &amp; Notes</span><span className="submenu-arrow">›</span>
                    <div className="submenu">
                      <div className="dropdown-item" onClick={() => { insertCallout(); setActiveMenu(null); }}>Callout / Admonition box...</div>
                      <div className="dropdown-item" onClick={() => { insertBlockQuote(); setActiveMenu(null); }}>Block Quote...</div>
                      <div className="dropdown-item" onClick={() => { insertFootnote(); setActiveMenu(null); }}>Footnote</div>
                      <div className="dropdown-item" onClick={() => { insertSideNote(); setActiveMenu(null); }}>Margin / Side Note...</div>
                      <div className="dropdown-item" onClick={() => { insertHRule(); setActiveMenu(null); }}>Horizontal Line (full width) <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧H</span></div>
                    </div>
                  </div>
                  <div className="dropdown-header">Figures &amp; Data</div>
                  <div className="dropdown-item has-submenu">
                    <span>Media &amp; Tables</span><span className="submenu-arrow">›</span>
                    <div className="submenu">
                      <div className="dropdown-item" onClick={() => { setShowFigureBuilder(true); setActiveMenu(null); }}>Figure...</div>
                      <div className="dropdown-item" onClick={() => { insertImage(); setActiveMenu(null); }}>Image...</div>
                      <div className="dropdown-item" onClick={() => { insertWhiteboard(); setActiveMenu(null); }}>Whiteboard / Sketch (Excalidraw)...</div>
                      <div className="dropdown-item" onClick={() => { insertTable(); setActiveMenu(null); }}>Table...</div>
                      <div className="dropdown-item" onClick={() => { insertDataFile(); setActiveMenu(null); }}>Import Data (CSV/Excel/JSON)...</div>
                      <div className="dropdown-item" onClick={() => { insertCodeBlock(); setActiveMenu(null); }}>Code Block <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧B</span></div>
                    </div>
                  </div>
                  <div className="dropdown-item" onClick={() => { const sel = editorRef.current?.getSelection(); const model = editorRef.current?.getModel(); const code = sel && model && !sel.isEmpty() ? model.getValueInRange(sel).trim() : ''; setShowImagePlacer(code ? code : true); setActiveMenu(null); }}>Place Image (wrap your text / float / below)...</div>
                  <div className="dropdown-item has-submenu">
                    <span>Plots</span><span className="submenu-arrow">›</span>
                    <div className="submenu">
                      <div className="dropdown-header">Plots</div>
                      <div className="dropdown-item" onClick={() => { setShowPlotStudio(true); setActiveMenu(null); }}>Plot Studio (2D · data · 3D · Python)...</div>
                      <div className="dropdown-item" onClick={() => { setShowDiagramBuilder(true); setActiveMenu(null); }}>cetz Canvas (shapes &amp; grid)...</div>
                      <div className="dropdown-header">Diagrams</div>
                      <div className="dropdown-item" onClick={() => { setShowQuiver(true); setActiveMenu(null); }}>Commutative Diagram (quiver)...</div>
                      <div className="dropdown-item" onClick={() => { setShowFeynman(true); setActiveMenu(null); }}>Feynman Diagram (visual)... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧F</span></div>
                      <div className="dropdown-header">Slides</div>
                      <div className="dropdown-item" onClick={() => { insertFloatingBox(); setActiveMenu(null); }}>Floating text box (place anywhere)...</div>
                      <div className="dropdown-item" onClick={() => { insertFletcher(); setActiveMenu(null); }}>Flow diagram (fletcher)...</div>
                    </div>
                  </div>
                  <div className="dropdown-item" onClick={() => { insertSubfigures(); setActiveMenu(null); }}>Subfigures (side-by-side, labelled a/b)...</div>
                  <div className="dropdown-header">Compute &amp; References</div>
                  <div className="dropdown-item has-submenu">
                    <span>Compute</span><span className="submenu-arrow">›</span>
                    <div className="submenu">
                      <div className="dropdown-item" onClick={() => { setShowFlowchart(true); setActiveMenu(null); }}>Flowchart → Code (build logic visually)... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧L</span></div>
                      <div className="dropdown-divider"></div>
                      <div className="dropdown-item" onClick={() => { runNotebook(); setActiveMenu(null); }}>Run Notebook (all ```python / ```julia cells, variables persist)</div>
                      <div className="dropdown-item" onClick={() => { setCodeRunner({ initialLang: 'python' }); setActiveMenu(null); }}>Run Python... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧K</span></div>
                      <div className="dropdown-item" onClick={() => { setCodeRunner({ initialLang: 'julia' }); setActiveMenu(null); }}>Run Julia...</div>
                      <div className="dropdown-item" onClick={() => { setCodeRunner({ initialLang: 'wolfram' }); setActiveMenu(null); }}>Run Wolfram...</div>
                    </div>
                  </div>
                  <div className="dropdown-item has-submenu">
                    <span>References</span><span className="submenu-arrow">›</span>
                    <div className="submenu">
                      <div className="dropdown-item" onClick={() => { insertWebLink(); setActiveMenu(null); }}>Link (Web)...</div>
                      <div className="dropdown-item" onClick={() => { insertCrossRef(); setActiveMenu(null); }}>Cross-reference (Internal)...</div>
                      <div className="dropdown-item" onClick={() => { insertLabel(); setActiveMenu(null); }}>Label...</div>
                      <div className="dropdown-divider"></div>
                      <div className="dropdown-item" onClick={() => { setShowRefManager(true); setActiveMenu(null); }}>Reference &amp; Label Manager...</div>
                      <div className="dropdown-item" onClick={() => { setShowBibManager(true); setActiveMenu(null); }}>Citations &amp; Bibliography (DOI/arXiv)...</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div {...menuProps('formatting')}>
              Formatting
              {activeMenu === 'formatting' && (
                <div className="dropdown">
                  <div className="dropdown-header">Text</div>
                  <div className="dropdown-item" onClick={() => { wrapSelection('*', '*'); setActiveMenu(null); }}>Bold <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘B</span></div>
                  <div className="dropdown-item" onClick={() => { wrapSelection('_', '_'); setActiveMenu(null); }}>Italic <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘I</span></div>
                  <div className="dropdown-item" onClick={() => { wrapSelection('#underline[', ']'); setActiveMenu(null); }}>Underline</div>
                  <div className="dropdown-item" onClick={() => { wrapSelection('#super[', ']'); setActiveMenu(null); }}>Superscript</div>
                  <div className="dropdown-item" onClick={() => { wrapSelection('#sub[', ']'); setActiveMenu(null); }}>Subscript</div>
                  <div className="dropdown-header">Colour &amp; Emphasis</div>
                  <div className="dropdown-item" onClick={() => { insertTextColor(); setActiveMenu(null); }}>Text Colour...</div>
                  <div className="dropdown-item" onClick={() => { insertUnderline(); setActiveMenu(null); }}>Underline (colour, background)...</div>
                  <div className="dropdown-item" onClick={() => { insertHighlight(); setActiveMenu(null); }}>Highlight / Background Colour...</div>
                  <div className="dropdown-item" onClick={() => { insertCancel(); setActiveMenu(null); }}>Cross Out / Strike Through...</div>
                  <div className="dropdown-header">Layout</div>
                  <div className="dropdown-item" onClick={() => { insertPageSetup(); setActiveMenu(null); }}>Page Setup (size, margins, header/footer)...</div>
                  <div className="dropdown-item" onClick={() => { insertBox(); setActiveMenu(null); }}>Box Selection (fill, border, texture)...</div>
                  <div className="dropdown-item" onClick={() => { setSelectionFontSizePrompt(); setActiveMenu(null); }}>Font Size...</div>
                  <div className="dropdown-item" onClick={() => { insertAlign(); setActiveMenu(null); }}>Align Content...</div>
                  <div className="dropdown-item" onClick={() => { insertRotate(); setActiveMenu(null); }}>Rotate (content or equation)...</div>
                  <div className="dropdown-header">Typography</div>
                  <div className="dropdown-item" onClick={() => { wrapSelection('#smallcaps[', ']'); setActiveMenu(null); }}>Small Caps</div>
                  <div className="dropdown-item" onClick={() => { wrapSelection('#strike[', ']'); setActiveMenu(null); }}>Strikethrough (text)</div>
                  <div className="dropdown-item" onClick={() => { insertTracking(); setActiveMenu(null); }}>Letter Spacing...</div>
                  <div className="dropdown-item" onClick={() => { insertCode('~'); setActiveMenu(null); }}>Non-breaking Space  (~)</div>
                </div>
              )}
            </div>
            <div {...menuProps('packages')}>
              Packages
              {activeMenu === 'packages' && (
                <div className="dropdown">
                  <div className="dropdown-item" onClick={() => setShowPackageInstaller(true)}>Install Typst Package...</div>
                </div>
              )}
            </div>
            <div {...menuProps('help')}>
              Help
              {activeMenu === 'help' && (
                <div className="dropdown">
                  <div className="dropdown-item" onClick={() => { setShowHelp(true); setActiveMenu(null); }}>Features &amp; Help...</div>
                  <div className="dropdown-item" onClick={() => { setShowPalette(true); setActiveMenu(null); }}>Command Palette... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘K</span></div>
                </div>
              )}
            </div>
          </div>
        </div>

        {editingTitle ? (
          <input
            className="project-title-input"
            autoFocus
            defaultValue={projectName}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => { const v = e.target.value.trim(); if (v) setProjectName(v); setEditingTitle(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.trim(); if (v) setProjectName(v); setEditingTitle(false); }
              if (e.key === 'Escape') setEditingTitle(false);
            }}
          />
        ) : (
          <div className="project-title" title="Click to rename project" onClick={(e) => { e.stopPropagation(); setEditingTitle(true); }}>
            {projectName} <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </div>
        )}

        <div className="header-right">
          {PROOFREAD_FEATURE_ENABLED && proof.available && (
            <button
              className="theme-toggle"
              onClick={() => { setProofreadEnabled(v => !v); if (!proofreadEnabled && !sidebarOpen) setSidebarOpen(true); }}
              style={proofreadEnabled ? { color: '#34d399', borderColor: '#34d399' } : undefined}
              title={proofreadEnabled
                ? `Proofreading on — spelling (Nuspell) + grammar/style (Harper)${proof.issues.length ? ` · ${proof.issues.length} issue(s)` : ''}. Click to turn off.`
                : 'Proofreading off — click to check spelling & grammar as you type'}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" /><path d="M9 20h6" /><path d="M12 4v16" />
                <path d="M16 15l2 2 4-4" />
              </svg>
              {proofreadEnabled && proof.issues.length > 0 && (
                <span style={{ marginLeft: 4, fontSize: '0.7rem', fontWeight: 700 }}>{proof.issues.length}</span>
              )}
            </button>
          )}
          <button className="theme-toggle" onClick={() => setTheme(t => t === 'typst-dark' ? 'typst-light' : 'typst-dark')}
            title={theme === 'typst-dark' ? 'Editor theme: dark — click for light (the PDF preview has its own toggle)' : 'Editor theme: light — click for dark (the PDF preview has its own toggle)'}>
            {theme === 'typst-dark'
              ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
              : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="M4.93 4.93l1.41 1.41"></path><path d="M17.66 17.66l1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="M4.93 19.07l1.41-1.41"></path><path d="M17.66 6.34l1.41-1.41"></path></svg>}
          </button>
          <div className="header-meta" title={pdfWords != null ? 'Words in the rendered document' : 'Words in the source (compile to count the rendered document)'}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="4" y1="7" x2="20" y2="7"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="14" y2="17"></line></svg>
            {pdfWords != null ? pdfWords : stats.words} words
          </div>
          <div className="header-sep"></div>
          <button className="header-icon-btn" title="Version history" onClick={() => setShowHistoryModal(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v5h5"></path><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"></path><path d="M12 7v5l4 2"></path></svg>
          </button>
          <a className="header-icon-btn" href="https://github.com/aburousan/hilbert-editor" target="_blank" rel="noopener noreferrer" title="Source code on GitHub">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.79 2.73 1.27 3.4.97.11-.75.41-1.27.74-1.56-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 2.9-.39c.98 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.68.42.36.8 1.08.8 2.18 0 1.57-.01 2.84-.01 3.23 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z"></path></svg>
          </a>
          <button className="btn-share" onClick={() => setShowDriveSync(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg> Share
          </button>
        </div>
      </header>

      <div className="toolbar">
        <div className="toolbar-group">
          <button className="tool-btn" onClick={() => setSidebarOpen(!sidebarOpen)} title="Toggle Sidebar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>
          </button>
          
          <button className="tool-btn" onClick={() => editorRef.current?.trigger('source', 'undo', null)} title="Undo"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg></button>
          <button className="tool-btn" onClick={() => editorRef.current?.trigger('source', 'redo', null)} title="Redo"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 14 20 9 15 4"></polyline><path d="M4 20v-7a4 4 0 0 1 4-4h12"></path></svg></button>
          <div className="toolbar-divider"></div>
          <button className="tool-btn" onClick={() => wrapSelection('*', '*')} title="Bold  (⌘B)"><b>B</b></button>
          <button className="tool-btn" onClick={() => wrapSelection('_', '_')} title="Italic  (⌘I)"><i>I</i></button>
          <button className="tool-btn" onClick={() => wrapSelection('#underline[', ']')} title="Underline — for a coloured/offset underline use Formatting ▸ Underline…"><span style={{ textDecoration: 'underline' }}>U</span></button>
          <button className="tool-btn" title="Text size — resize the selected text"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setColorPopAt(null); setHighlightPopAt(null);
              setFontSizePopAt(p => p ? null : { x: r.left, y: r.bottom + 6 });
            }}>
            <span style={{ fontWeight: 700, letterSpacing: '-1px' }}><span style={{ fontSize: 15 }}>A</span><span style={{ fontSize: 10 }}>A</span></span>
            <span style={{ fontSize: 8, opacity: 0.7, marginLeft: 1 }}>▾</span>
          </button>
          {fontSizePopAt && (
            <div className="fontsize-menu" style={{ position: 'fixed', left: fontSizePopAt.x, top: fontSizePopAt.y }} onClick={e => e.stopPropagation()}>
              <div className="fontsize-menu-scroll">
                {FONT_SIZE_PRESETS.map(s => (
                  <button key={s} className={`fontsize-item ${s === fontSizeVal ? 'active' : ''}`}
                    onClick={() => { setFontSizeVal(s); setSelectionFontSize(String(s)); setFontSizePopAt(null); }}>
                    {s}<span className="fontsize-item-unit">pt</span>
                  </button>
                ))}
              </div>
              <button className="fontsize-item fontsize-custom"
                onClick={() => { setFontSizePopAt(null); setSelectionFontSizePrompt(); }}>Custom…</button>
            </div>
          )}
          <button className="tool-btn" title="Text colour — pick a colour to apply to the selection"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setColorPopAt(p => p ? null : { x: r.left, y: r.bottom + 6 });
            }}>
            <span style={{ color: textColor, borderBottom: `2.5px solid ${textColor}`, lineHeight: 1.05 }}>A</span>
            <span style={{ fontSize: 8, opacity: 0.7, marginLeft: 1 }}>▾</span>
          </button>
          {colorPopAt && (
            <div className="color-pop" style={{ position: 'fixed', left: colorPopAt.x, top: colorPopAt.y }} onClick={e => e.stopPropagation()}>
              {TEXT_COLORS.map(c => (
                <button key={c} className="color-swatch" style={{ background: c, boxShadow: c === textColor ? '0 0 0 2px var(--accent)' : 'none' }}
                  onClick={() => { setTextColor(c); setColorPopAt(null); wrapSelection(`#text(fill: rgb("${c}"))[`, ']'); }} title={`Colour the selection ${c}`} />
              ))}
              <label className="color-swatch color-custom" title="Pick a custom colour, then Apply below">
                <input type="color" value={textColor} onChange={e => setTextColor(e.target.value)} />
                <span>+</span>
              </label>
              <button className="color-more color-apply" title={`Apply ${textColor} to the selection`}
                onClick={() => { setColorPopAt(null); wrapSelection(`#text(fill: rgb("${textColor}"))[`, ']'); }}>
                <span className="color-chip" style={{ background: textColor }}></span> Apply to selection
              </button>
              <button className="color-more" onClick={() => { setColorPopAt(null); insertTextColor(); }}>Full colour grid…</button>
            </div>
          )}
          <button className="tool-btn" title="Highlight — mark the selection with a background colour"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setColorPopAt(null); setFontSizePopAt(null);
              setHighlightPopAt(p => p ? null : { x: r.left, y: r.bottom + 6 });
            }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l-6 6v3h3l6-6"></path><path d="M22 6l-4-4-9 9 4 4z"></path></svg>
            <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 2, background: highlightColor, marginLeft: 2, border: '1px solid rgba(0,0,0,0.15)' }}></span>
          </button>
          {highlightPopAt && (
            <div className="color-pop" style={{ position: 'fixed', left: highlightPopAt.x, top: highlightPopAt.y }} onClick={e => e.stopPropagation()}>
              {HIGHLIGHT_COLORS.map(c => (
                <button key={c} className="color-swatch" style={{ background: c, boxShadow: c === highlightColor ? '0 0 0 2px var(--accent)' : 'none' }}
                  onClick={() => { setHighlightColor(c); setHighlightPopAt(null); wrapSelection(`#highlight(fill: rgb("${c}"))[`, ']'); }} title={`Highlight the selection ${c}`} />
              ))}
              <label className="color-swatch color-custom" title="Pick a custom highlight colour, then Apply below">
                <input type="color" value={highlightColor} onChange={e => setHighlightColor(e.target.value)} />
                <span>+</span>
              </label>
              <button className="color-more color-apply" title={`Highlight the selection ${highlightColor}`}
                onClick={() => { setHighlightPopAt(null); wrapSelection(`#highlight(fill: rgb("${highlightColor}"))[`, ']'); }}>
                <span className="color-chip" style={{ background: highlightColor }}></span> Highlight selection
              </button>
              <button className="color-more" onClick={() => { setHighlightPopAt(null); insertHighlight(); }}>Full colour grid…</button>
            </div>
          )}
          <div className="toolbar-divider"></div>
          {/* Math — the core of physics/maths note-taking */}
          <button className="tool-btn" onClick={() => wrapSelection('$', '$')} title="Inline math — a symbol in running text   $x$   (⌘E)"><span style={{ fontFamily: "'iA Writer Mono', ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5, fontWeight: 600, letterSpacing: '-0.5px' }}>$x$</span></button>
          <button className="tool-btn" onClick={insertMultilineEquation} title="Display / aligned equation (its own line)"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="5" width="18" height="14" rx="2.5"></rect><line x1="8" y1="10.5" x2="16" y2="10.5" strokeWidth="2"></line><line x1="8" y1="13.5" x2="16" y2="13.5" strokeWidth="2"></line></svg></button>
          <button className="tool-btn" onClick={toggleEquationNumbering} title="Toggle equation numbering for the whole document  (1), (2), … on/off"><span style={{ fontWeight: 700, fontSize: 12.5, letterSpacing: '-0.5px' }}>(1)</span></button>
          <button className="tool-btn" onClick={toggleThisEquationNumber} title="Number / un-number THIS equation (the selection or current line)"><span style={{ fontWeight: 700, fontSize: 14 }}>№</span></button>
          <button className="tool-btn" onClick={() => wrapSelection('#align(center)[', ']')} title="Center the selection on the page"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="6"></line><line x1="21" y1="12" x2="3" y2="12"></line><line x1="18" y1="18" x2="6" y2="18"></line></svg></button>
          <button className="tool-btn" onClick={() => setShowMatrixStudio(true)} title="Matrix — visual grid editor  (⌘⇧M)"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><path d="M7 3H4v18h3"></path><path d="M17 3h3v18h-3"></path><circle cx="9.5" cy="9" r="1.15" fill="currentColor" stroke="none"></circle><circle cx="14.5" cy="9" r="1.15" fill="currentColor" stroke="none"></circle><circle cx="9.5" cy="15" r="1.15" fill="currentColor" stroke="none"></circle><circle cx="14.5" cy="15" r="1.15" fill="currentColor" stroke="none"></circle></svg></button>
          <button className="tool-btn" onClick={() => setShowSymbolPicker(true)} title="Greek &amp; physics symbols  (⌘⇧P)"><b style={{ fontSize: 15 }}>Ω</b></button>
          <button className="tool-btn" onClick={() => setShowSymbolDraw(true)} title="Draw a symbol → find its Typst name (sketch it with the mouse)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path><path d="M2 2l7.586 7.586"></path><circle cx="11" cy="11" r="2"></circle></svg></button>
          <div className="toolbar-divider"></div>
          {/* Structure */}
          <button className="tool-btn" onClick={insertHeading} title="Heading / section"><b style={{ fontSize: 14 }}>H</b></button>
          <button className="tool-btn" onClick={() => makeList('-')} title="Bullet list"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><circle cx="3.5" cy="6" r="1.2" fill="currentColor"></circle><circle cx="3.5" cy="12" r="1.2" fill="currentColor"></circle><circle cx="3.5" cy="18" r="1.2" fill="currentColor"></circle></svg></button>
          <button className="tool-btn" onClick={() => makeList('+')} title="Numbered list"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="10" y1="6" x2="21" y2="6"></line><line x1="10" y1="12" x2="21" y2="12"></line><line x1="10" y1="18" x2="21" y2="18"></line><text x="2" y="8" fontSize="7" fill="currentColor" stroke="none">1</text><text x="2" y="14" fontSize="7" fill="currentColor" stroke="none">2</text><text x="2" y="20" fontSize="7" fill="currentColor" stroke="none">3</text></svg></button>
          <div className="toolbar-divider"></div>
          {/* Figures, tables, references */}
          <button className="tool-btn" onClick={wrapInFigure} title="Figure — image with caption &amp; number"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="14" rx="1"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 13 16 9 5 17"></polyline><line x1="7" y1="21" x2="17" y2="21"></line></svg></button>
          <button className="tool-btn" onClick={insertTable} title="Table"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="1"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="3" x2="9" y2="21"></line></svg></button>
          <button className="tool-btn" onClick={insertLabel} title="Add label / tag (anchor) — reference it later with @name"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg></button>
          <button className="tool-btn" onClick={insertCrossRef} title="Cross-reference a labelled equation / figure / section  (@)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg></button>
          <div className="toolbar-divider"></div>
          <button className="tool-btn" onClick={insertCodeBlock} title="Code block — insert a fenced ``` code block"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg></button>
          <button className="tool-btn" onClick={() => runNotebook()} disabled={notebookRunning} title="Run Notebook — execute every ```python / ```julia block in this file as one session (variables persist), output written below each block"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="8 6 3 12 8 18"></polyline><polyline points="16 6 21 12 16 18"></polyline><line x1="13" y1="4" x2="11" y2="20"></line></svg>{notebookRunning && <span className="spinner" style={{ marginLeft: 4 }} />}</button>
        </div>

        <div className="toolbar-group">
          <button className="tool-btn" onClick={saveActiveFile} title="Save (⌘S)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg></button>
          <div style={{ display: 'flex', alignItems: 'center', marginLeft: '4px', marginRight: '8px' }} title={isCompiling ? 'Compiling…' : problems.some(p => p.severity === 'error') ? `${problems.filter(p => p.severity === 'error').length} error(s)` : 'No problems'}>
            {isCompiling ? <div className="status-dot compiling"></div> : problems.some(p => p.severity === 'error') ? <div className="status-dot error"></div> : <div className="status-dot"></div>}
          </div>

          <button className="tool-btn primary" title={`Force Compile ${currentMain}`} onClick={() => compileTypst(currentMain)}>
             Recompile
          </button>
        </div>
      </div>

      <div className="workspace" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {sidebarOpen && (
          <>
            <div ref={sidebarRef} className="sidebar" style={{ width: sidebarWidth, minWidth: sidebarWidth, maxWidth: sidebarWidth, flex: 'none', display: 'flex', flexDirection: 'column' }}>
              <div className="sidebar-section" style={{ height: treeHeight, flex: 'none', display: 'flex', flexDirection: 'column', borderBottom: '1px solid var(--border-color)' }}>
                <div className="sidebar-header" style={{ padding: '6px 14px', background: 'var(--panel-bg)', fontSize: '0.68rem', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)', opacity: 0.75, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)' }}>
                  File Tree
                  <span style={{ display: 'flex', gap: 10 }}>
                    <svg className="tree-action" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ cursor: 'pointer', color: isSearchVisible ? 'var(--accent)' : 'inherit' }} onClick={() => { setIsSearchVisible(!isSearchVisible); if (isSearchVisible) setTreeSearch(''); }}><title>Search files</title><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                    <svg className="tree-action" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ cursor: 'pointer' }} onClick={createNewFile}><title>New file</title><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="12" x2="12" y2="18"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>
                    <svg className="tree-action" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ cursor: 'pointer' }} onClick={createNewFolder}><title>New folder</title><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line></svg>
                    <svg className="tree-action" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ cursor: 'pointer' }} onClick={uploadAsset}><title>Upload file / image</title><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                  </span>
                </div>
                {isSearchVisible && (
                  <div style={{ padding: '6px 10px', background: 'var(--panel-bg)', display: 'flex' }}>
                    <input 
                      autoFocus
                      type="text" 
                      placeholder="Search files..." 
                      value={treeSearch}
                      onChange={e => setTreeSearch(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Escape') {
                          setIsSearchVisible(false);
                          if (!treeSearch) setTreeSearch('');
                        }
                      }}
                      style={{ 
                        flex: 1, 
                        padding: '4px 8px', 
                        fontSize: '0.8rem', 
                        background: 'var(--bg-color)', 
                        color: 'var(--text-color)',
                        border: '1px solid var(--border-color)',
                        borderRadius: '4px',
                        outline: 'none'
                      }}
                    />
                  </div>
                )}
                <div className="file-tree" tabIndex={0} style={{ flex: 1, overflowY: 'auto', outline: 'none' }} onKeyDown={handleFileTreeKeyDown} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, type: 'empty' }); }} onClick={() => { setSelectedPaths([]); setLastSelectedPath(null); }} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDrop={e => handleDrop(e, '')}>
                  {treeJsx}
                </div>
              </div>

              <div className="resizer-h" onMouseDown={(e) => {
                e.preventDefault();
                isResizingTree.current = true;
                document.body.style.cursor = 'row-resize';
                document.body.classList.add('is-resizing');
              }} />

              <div className="sidebar-section" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 80 }}>
                <div className="sidebar-header" style={{ padding: '6px 14px', background: 'var(--panel-bg)', fontSize: '0.68rem', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)', opacity: 0.75 }}>
                  File Outline
                </div>
                <div className="outline-list" style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>
                  {outline.length === 0 && (
                    <div style={{ color: '#94a3b8', fontSize: '12px', textAlign: 'center', marginTop: '20px' }}>No headings found.</div>
                  )}
                  {outline.map((item, i) => (
                    <div key={i} onClick={() => jumpToLine(item.line)} style={{ padding: '4px 0', paddingLeft: `${(item.level - 1) * 12}px`, cursor: 'pointer', fontSize: '13px', color: '#e2e8f0', borderBottom: '1px solid transparent' }} className="outline-item">
                      {item.text}
                    </div>
                  ))}
                </div>
              </div>

              <div className="resizer-h" onMouseDown={(e) => {
                e.preventDefault();
                isResizingProblems.current = true;
                problemsResizeStart.current = { y: e.clientY, height: problemsHeight };
                document.body.style.cursor = 'row-resize';
                document.body.classList.add('is-resizing');
              }} />

              <div className="sidebar-section problems-section" style={{ flex: 'none', height: problemsHeight, display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border-color)' }}>
                <div className="sidebar-header" style={{ padding: '6px 14px', background: 'var(--panel-bg)', fontSize: '0.68rem', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', opacity: 0.85, color: problems.some(p => p.severity === 'error') ? '#f87171' : 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Problems</span>
                  {problems.length > 0 && <span className="problem-badge">{problems.length}</span>}
                </div>
                <div className="problems-list" style={{ flex: 1, overflowY: 'auto', padding: '6px' }}>
                  {problems.length === 0 ? (
                    <div style={{ color: '#4ade80', fontSize: '12px', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
                      No problems — compiles cleanly.
                    </div>
                  ) : problems.map((p, i) => (
                    <div key={i} className="problem-item" onClick={() => jumpToProblem(p)} title={p.message}>
                      <span className={`problem-dot ${p.severity}`}></span>
                      <div style={{ minWidth: 0 }}>
                        <div className="problem-msg">{p.message}</div>
                        {p.line && <div className="problem-loc">{(p.file || activeTabPath)}:{p.line}:{p.col}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {PROOFREAD_FEATURE_ENABLED && proof.available && proofreadEnabled && (
                <ProofreadPanel
                  issues={proof.issues}
                  busy={proof.busy}
                  onJump={proof.jumpTo}
                  onApply={proof.applySuggestion}
                  onIgnore={proof.ignoreWord}
                />
              )}

              <div style={{ padding: '9px 14px', borderTop: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '7px', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.78rem' }} onClick={() => setShowAppSettings(true)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                App Settings
              </div>
            </div>
            <div className="resizer" onMouseDown={(e) => {
              e.preventDefault();
              isResizingSidebar.current = true;
              document.body.style.cursor = 'col-resize';
              document.body.classList.add('is-resizing');
            }} />
          </>
        )}
        <div className="editor-pane" onClick={() => setIsSearchVisible(false)} style={{ width: editorWidth, minWidth: editorWidth, maxWidth: editorWidth, flex: 'none', display: 'flex', flexDirection: 'column' }}>
          <div className="tabs">
            {tabs.map(tab => (
              <div key={tab.path} className={`tab ${activeTabPath === tab.path ? 'active' : ''}`} onClick={() => setActiveTabPath(tab.path)}>
                {tab.path} {tab.isDirty && '*'}
                <button className="tab-close" onClick={(e) => closeTab(e, tab.path)}>×</button>
              </div>
            ))}
            {pdfUrl && activeTabPath.endsWith('.typ') && (
              <button
                className="tab-sync-btn"
                style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, padding: '0 10px', background: 'transparent', border: 'none', borderLeft: '1px solid var(--border-color)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.72rem', whiteSpace: 'nowrap' }}
                onClick={() => forwardSync()}
                title="Reveal the cursor's line in the PDF preview (Ctrl/Cmd+Alt+J). Double-click a word in the PDF to jump back to the source."
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14" /><path d="M13 6l6 6-6 6" />
                </svg>
                Find in PDF
              </button>
            )}
          </div>
          <div className="editor-container" style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column' }}>
            {activeTab ? (
              (() => {
                const ext = (activeTabPath.split('.').pop() || '').toLowerCase();
                // The crop/rotate editor works on a <canvas>, which rasterises to
                // PNG — fine for raster images, but it would silently destroy a
                // vector SVG (and SVGs often report no pixel size, breaking crop).
                // So the editor is raster-only; SVG gets a plain preview.
                const RASTER_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];
                const rawSrc = `${API}/workspace/raw?path=${encodeURIComponent(activeTabPath)}&v=${tabs.find(t => t.path === activeTabPath)?.content.length || 0}`;
                if (RASTER_EXT.includes(ext)) {
                  return (
                    <ImageEditor
                      path={activeTabPath}
                      initialSrc={rawSrc}
                      onSave={async (buf) => {
                         await fetch(`${API}/workspace/upload?path=${encodeURIComponent(activeTabPath)}`, { method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream' } });
                         // Hack to trigger a reload of the image: update the tab's "content" string length which we use as a version cache-buster
                         setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, content: t.content + ' ' } : t));
                      }}
                    />
                  );
                }
                if (ext === 'svg') {
                  return (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--panel-bg)' }}>
                      <div style={{ display: 'flex', gap: '10px', padding: '10px 20px', background: 'var(--bg-color)', borderBottom: '1px solid var(--border-color)', alignItems: 'center' }}>
                        <div style={{ fontWeight: 600, color: 'var(--text-color)' }}>{activeTabPath}</div>
                        <div style={{ flex: 1 }}></div>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', background: 'var(--panel-bg)', padding: '3px 8px', borderRadius: '5px', border: '1px solid var(--border-color)' }}>Vector image · preview only</span>
                      </div>
                      <div style={{ flex: 1, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}>
                        <img src={rawSrc} style={{ maxWidth: '80vw', maxHeight: 'calc(100vh - 160px)', objectFit: 'contain' }} alt={activeTabPath} />
                      </div>
                      <div style={{ padding: '10px 20px', color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center' }}>
                        Cropping and rotating are available for raster images (PNG / JPG) only — SVGs are vector graphics.
                      </div>
                    </div>
                  );
                }
                if (ext === 'pdf') {
                  // View an ordinary PDF (dropped/uploaded, not the compile output)
                  // with the same zoom/fit/page-size viewer used for the preview.
                  return (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
                      <PdfPreview url={rawSrc} onReverseSync={NOOP_REVERSE_SYNC} downloadName={activeTabPath.split('/').pop()} />
                    </div>
                  );
                }
                if (ext === 'excalidraw') {
                  return (
                    <Boundary name="Whiteboard" onClose={() => { const rem = tabs.filter(t => t.path !== activeTabPath); setTabs(rem); setActiveTabPath(rem.length ? rem[rem.length - 1].path : ''); }}>
                    <ExcalidrawEditor
                      path={activeTabPath}
                      initialContent={activeTab.content}
                      onSave={async (jsonContent, svgBlob) => {
                        // Save the .excalidraw file
                        await fetch(`${API}/workspace/file?path=${encodeURIComponent(activeTabPath)}`, { method: 'POST', body: jsonContent });
                        setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, content: jsonContent, isDirty: false } : t));

                        // Automatically save the .svg file next to it for embedding in Typst!
                        const svgPath = activeTabPath.replace(/\.excalidraw$/, '.svg');
                        await fetch(`${API}/workspace/upload?path=${encodeURIComponent(svgPath)}`, { method: 'POST', body: svgBlob, headers: { 'Content-Type': 'application/octet-stream' } });
                        fetchTree(); // Refresh tree so the SVG appears
                      }}
                    />
                    </Boundary>
                  );
                }
                return (
                  <Editor
                    height="100%"
                    language={activeTab.path.endsWith('.typ') ? 'typst' : 'plaintext'}
                    theme={theme}
                    path={activeTab.path}
                    value={activeTab.content}
                    onChange={handleEditorChange}
                    beforeMount={(monacoInstance) => setupTypstLanguage(monacoInstance)}
                    onMount={(e, monacoInstance) => {
                      (window as any).logTiming('Monaco ready');
                      editorRef.current = e;
                      // Remember cursor position for session restore (debounced write).
                      e.onDidChangeCursorPosition(() => {
                        const p = e.getPosition();
                        if (p) { sessionRef.current.cursor = { line: p.lineNumber, column: p.column }; sessionRef.current.scrollTop = e.getScrollTop?.(); scheduleSaveSession(); }
                      });
                      (e as any).onDidType(() => {
                        const pos = e.getPosition(); const model = e.getModel();
                        if (!pos || !model) return;
                        const before = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
                        if (/\bimage\(\s*"[^"]*$/.test(before)) e.trigger('image-path', 'editor.action.triggerSuggest', {});
                      });
                      monacoInstance.editor.setTheme(theme);
                      e.updateOptions({ hover: { enabled: true, delay: 300 } });
                      e.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyY, () => e.trigger('keyboard', 'redo', null));
                      // Forward sync: reveal the cursor's line in the PDF preview.
                      e.addAction({
                        id: 'hilbert.syncToPdf',
                        label: 'Sync: reveal cursor position in the PDF',
                        keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyMod.Alt | monacoInstance.KeyCode.KeyJ],
                        contextMenuGroupId: 'navigation',
                        contextMenuOrder: 1.5,
                        run: () => forwardSyncRef.current(),
                      });
                      const m = e.getModel();
                      if (m) { const last = m.getLineCount(); e.setPosition({ lineNumber: last, column: m.getLineMaxColumn(last) }); }
                    }}
                    options={editorOptions}
                  />
                );
              })()
            ) : (
              <div className="empty-state">No file selected</div>
            )}
          </div>
        </div>
        <div className="resizer" onMouseDown={(e) => {
          e.preventDefault();
          isResizingEditor.current = true;
          document.body.style.cursor = 'col-resize';
          document.body.classList.add('is-resizing');
        }} />
        <div className="preview-pane" style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative', backgroundColor: '#ffffff' }}>
          {/* Non-intrusive status bar on a failed compile: the preview below stays
              on the last good render instead of being taken over. */}
          {compileError && (
            <div className="preview-status">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
              <span className="preview-status-msg">
                {(() => { const n = problems.filter(p => p.severity === 'error').length; return n > 0 ? `${n} error${n > 1 ? 's' : ''}` : 'Compilation failed'; })()}
                {pdfUrl ? ' · showing last successful preview' : ''}
                {isCompiling ? ' · recompiling…' : ''}
              </span>
              <button className="preview-status-btn" onClick={() => setPreviewTab(previewTab === 'problems' ? 'preview' : 'problems')}>
                {previewTab === 'problems' ? 'Back to preview' : (pdfUrl ? 'View errors' : 'Details')}
              </button>
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {/* PDF stays mounted whenever it exists, so its scroll/zoom survive
                switching to the Problems view and back. */}
            {pdfUrl && (
              <PdfPreview ref={pdfRef} url={pdfUrl} onReverseSync={reverseSync} onWordCount={handlePdfWordCount} downloadName={`${(projectName || 'document').replace(/\s+/g, '_')}.pdf`} />
            )}
            {!pdfUrl && !compileError && (
              <div className="empty-preview">{isCompiling ? 'Generating PDF…' : 'Nothing to preview yet — write some Typst and it renders here.'}</div>
            )}
            {compileError && (previewTab === 'problems' || !pdfUrl) && (() => {
              const errs = problems.filter(p => p.severity === 'error');
              // Errors coming from inside an installed package (a template's
              // dependency) usually mean the package isn't compatible with the
              // installed Typst version — reassure the user it isn't their file.
              const pkgRe = /@preview\/|\/preview\/|\b\d+\.\d+\.\d+\/src\//;
              const pkgIssue = pkgRe.test(compileError || '') || errs.some(p => pkgRe.test(p.file || ''));
              return (
                <div className="preview-error preview-problems-overlay">
                  <div className="preview-error-card">
                    <div className="preview-error-title">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                      Problems
                    </div>
                    <div className="preview-error-sub">
                      {errs.length > 0
                        ? `${errs.length} error${errs.length > 1 ? 's' : ''} — click one to jump to it.`
                        : "Typst couldn't build this document."}
                    </div>
                    {pkgIssue && (
                      <div style={{ margin: '2px 0 4px', padding: '9px 12px', borderRadius: '8px', background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.35)', color: 'var(--text-color)', fontSize: '0.82rem', lineHeight: 1.45 }}>
                        This error is inside a Typst <b>package</b> (a template's dependency), not your document. It usually means that package isn't compatible with your installed Typst version — try a different template, or update the Typst CLI. Nothing is broken on your end.
                      </div>
                    )}
                    {errs.length > 0 ? (
                      <ul className="preview-error-list">
                        {errs.map((p, i) => (
                          <li key={i} className="preview-error-item" onClick={() => jumpToProblem(p)} title="Jump to this line">
                            {p.line != null && <span className="preview-error-loc">{(p.file || activeTabPath)}:{p.line}{p.col != null ? `:${p.col}` : ''}</span>}
                            <span className="preview-error-msg">{p.message}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <pre className="preview-error-raw">{compileError}</pre>
                    )}
                    <div className="preview-error-foot">{isCompiling ? 'Recompiling…' : 'The preview updates automatically as soon as it compiles cleanly.'}</div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      </div>
      
      {showPackageInstaller && <PackageInstaller onClose={() => setShowPackageInstaller(false)} onInsert={(pkg) => {
        if (!editorRef.current) return;
        editorRef.current.executeEdits('packages', [{ range: new monaco!.Range(1, 1, 1, 1), text: `#import "@preview/${pkg.name}:${pkg.version}": *\n`, forceMoveMarkers: true }]);
        setShowPackageInstaller(false);
      }} />}
      {showTemplateInstaller && <TemplateInstaller onClose={() => setShowTemplateInstaller(false)} onInsert={handleInitTemplate} onUseBuiltin={handleUseBuiltin} />}
      {showDiagramBuilder && <DiagramBuilder onClose={() => setShowDiagramBuilder(false)} onInsert={(code) => { insertCode(code); setShowDiagramBuilder(false); }}
        onSaveFile={async (filename, content) => { await fetch(`${API}/workspace/file?path=${encodeURIComponent(filename)}`, { method: 'POST', body: content, headers: { 'Content-Type': 'text/plain' } }); await fetchTree(); }} />}
      {showFeynman && <Suspense fallback={null}><FeynmanBuilder onClose={() => setShowFeynman(false)} onInsert={(code) => { insertCode(code); setShowFeynman(false); }} /></Suspense>}
      {showEqGallery && <Suspense fallback={null}><EquationGallery onClose={() => setShowEqGallery(false)} onInsert={insertEqTemplate} /></Suspense>}
      {showPhysics && <Suspense fallback={null}><PhysicsGallery onClose={() => setShowPhysics(false)} onInsert={insertPhysicsTemplate} /></Suspense>}
      {showHelp && <Suspense fallback={null}><HelpModal onClose={() => setShowHelp(false)} /></Suspense>}
      {showMatrixStudio && <Suspense fallback={null}><MatrixStudio onClose={() => setShowMatrixStudio(false)} onInsert={insertMatrixBody} /></Suspense>}
      {showImagePlacer && <Suspense fallback={null}><ImagePlacer onClose={() => setShowImagePlacer(false)} onEnsureImport={(imp) => { const m = editorRef.current?.getModel(); if (m && !m.getValue().includes(imp.trim())) insertAtTop(imp); }} onInsert={(code) => { if (typeof showImagePlacer === 'string') { const { editor, model, sel } = getSelectionCtx(''); if (sel && editor && model && !sel.isEmpty()) { editor.executeEdits('re-place', [{ range: sel, text: code, forceMoveMarkers: true }]); editor.focus(); } else insertCode(code); } else insertCode(code); fetchTree(); }} workspaceImages={workspaceImages} selectedCode={typeof showImagePlacer === 'string' ? showImagePlacer : undefined} /></Suspense>}
      {showFlowchart && <Suspense fallback={null}><FlowchartCoder onClose={() => setShowFlowchart(false)} onInsert={(code) => { if (code.includes('fc-result(')) ensureSetup('#let fc-result', '#let fc-result(v) = box(inset: (x: 9pt, y: 6pt), radius: 6pt, fill: rgb(238, 242, 255), stroke: 0.6pt + rgb(165, 180, 252))[*Result:* #v]'); insertCode(`\n${code}\n`); setShowFlowchart(false); }} /></Suspense>}
      {showAbout && (
        <div className="modal-overlay" onClick={() => setShowAbout(false)}>
          <div className="modal-content about-modal" onClick={e => e.stopPropagation()}>
            <svg width="52" height="52" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="aboutGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a78bfa"/><stop offset="1" stopColor="#60a5fa"/></linearGradient></defs><path fillRule="evenodd" clipRule="evenodd" fill="url(#aboutGrad)" d="M9.29289 1.29289C9.48043 1.10536 9.73478 1 10 1H18C19.6569 1 21 2.34315 21 4V9C21 9.55228 20.5523 10 20 10C19.4477 10 19 9.55228 19 9V4C19 3.44772 18.5523 3 18 3H11V8C11 8.55228 10.5523 9 10 9H5V20C5 20.5523 5.44772 21 6 21H10C10.5523 21 11 21.4477 11 22C11 22.5523 10.5523 23 10 23H6C4.34315 23 3 21.6569 3 20V8C3 7.73478 3.10536 7.48043 3.29289 7.29289L9.29289 1.29289ZM6.41421 7H9V4.41421L6.41421 7ZM11.2929 10.2929C11.63 9.95583 12.1581 9.90353 12.5547 10.1679C12.7377 10.29 13.138 10.4206 13.8692 10.5557C14.2116 10.619 14.5873 10.6773 15.0006 10.7413L15.0159 10.7436C15.42 10.8062 15.8556 10.8736 16.3008 10.9531C18.0592 11.2671 20.2179 11.8037 21.7071 13.2929C22.907 14.4928 23.2701 15.7765 23.1846 16.8892C23.1413 17.4519 22.9841 17.9568 22.7829 18.3687L23 18.5858C23.781 19.3668 23.781 20.6332 23 21.4142L21.4142 23C20.6332 23.781 19.3668 23.781 18.5858 23L18.3687 22.7829C17.9568 22.9841 17.4519 23.1413 16.8892 23.1846C15.7765 23.2701 14.4928 22.907 13.2929 21.7071C11.8037 20.2179 11.2671 18.0592 10.9531 16.3008C10.8736 15.8556 10.8062 15.42 10.7436 15.0159L10.7413 15.0006C10.6773 14.5873 10.619 14.2116 10.5557 13.8692C10.4206 13.138 10.29 12.7377 10.1679 12.5547C9.90353 12.1581 9.95583 11.63 10.2929 11.2929L10.7926 10.7931L10.7929 10.7929L11.2929 10.2929ZM15.0677 16.482L12.6124 14.0266C12.6482 14.2458 12.683 14.47 12.7177 14.6947L12.7186 14.7006L12.7187 14.7007C12.7821 15.1107 12.8465 15.527 12.9219 15.9492C13.2329 17.6908 13.6963 19.2821 14.7071 20.2929C15.5072 21.093 16.2235 21.2299 16.7358 21.1904C17.3109 21.1462 17.7121 20.8737 17.7929 20.7929C18.1834 20.4024 18.8166 20.4024 19.2071 20.7929L20 21.5858L21.5858 20L20.7929 19.2071C20.6054 19.0196 20.5 18.7652 20.5 18.5C20.5 18.2348 20.6054 17.9804 20.7929 17.7929C20.8737 17.7121 21.1462 17.3109 21.1904 16.7358C21.2299 16.2235 21.093 15.5072 20.2929 14.7071C19.2821 13.6963 17.6908 13.2329 15.9492 12.9219C15.527 12.8465 15.1107 12.7821 14.7007 12.7187L14.7006 12.7186L14.6947 12.7177C14.47 12.683 14.2458 12.6482 14.0266 12.6124L16.482 15.0677C16.6472 15.0236 16.8208 15 17 15C18.1046 15 19 15.8954 19 17C19 18.1046 18.1046 19 17 19C15.8954 19 15 18.1046 15 17C15 16.8208 15.0236 16.6472 15.0677 16.482Z"/></svg>
            <h2 style={{ margin: '10px 0 2px' }}>Hilbert</h2>
            <div className="about-version">An offline editor for Typst · Unofficial</div>
            <div className="about-version">Version {__APP_VERSION__}</div>
            <div className="about-author">Created by <a href="https://rousan.netlify.app/" target="_blank" rel="noreferrer" style={{ color: 'inherit', fontWeight: 600, textDecoration: 'underline', textDecorationColor: 'var(--accent)' }}>Kazi Abu Rousan</a></div>
            <a className="about-sponsor" href="https://github.com/sponsors/aburousan" target="_blank" rel="noreferrer" title="Support Hilbert's development through GitHub Sponsors">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"></path></svg>
              Sponsor
            </a>
            <div className="about-links">
              <a href="https://github.com/aburousan/hilbert-editor" target="_blank" rel="noreferrer">GitHub</a>
              <span>·</span>
              <a href="https://typst.app" target="_blank" rel="noreferrer">Typst</a>
              <span>·</span>
              <span>MIT License</span>
            </div>
            <button className="btn-primary" style={{ marginTop: '16px' }} onClick={() => setShowAbout(false)}>OK</button>
          </div>
        </div>
      )}
      {showFigureBuilder && <FigureBuilder onClose={() => setShowFigureBuilder(false)} onInsert={(code) => { insertCode(code); setShowFigureBuilder(false); }} />}
      {showEditSettings && <EditSettings onClose={() => setShowEditSettings(false)} editorRef={editorRef} monaco={monaco} />}
      {showDriveSync && <DriveSyncModal onClose={() => setShowDriveSync(false)} projectName={projectName} />}
      {showAppSettings && <AppSettingsModal onClose={() => setShowAppSettings(false)}
        theme={theme} onTheme={setTheme}
        fontSize={editorFontSize} onFontSize={setEditorFontSize}
        compileDelay={compileDelay} onCompileDelay={setCompileDelay} />}
      {showQuiver && <QuiverDiagram onClose={() => setShowQuiver(false)} onInsert={insertQuiverDiagram} />}
      {inputModal && <InputModal {...inputModal} onClose={() => setInputModal(null)} />}
      {showDataImport && <DataImportModal onClose={() => setShowDataImport(false)} onImport={handleDataImport} />}
      {confirmModal && (
        <div className="modal-overlay" onClick={() => { confirmModal.resolve(false); setConfirmModal(null); }}>
          <div className="modal-content" style={{ width: '420px' }} onClick={e => e.stopPropagation()}
            onKeyDown={e => {
              if (e.key === 'Escape') { confirmModal.resolve(false); setConfirmModal(null); }
              if (e.key === 'Enter') { confirmModal.resolve(true); setConfirmModal(null); }
            }}>
            <div className="modal-header">
              <h2>Confirm</h2>
              <button className="close-btn" onClick={() => { confirmModal.resolve(false); setConfirmModal(null); }}>×</button>
            </div>
            <div className="modal-body" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{confirmModal.message}</div>
            <div className="modal-footer">
              <button className="btn-ghost" onClick={() => { confirmModal.resolve(false); setConfirmModal(null); }}>Cancel</button>
              <button className={confirmModal.danger ? 'btn-danger' : 'btn-primary'} autoFocus
                onClick={() => { confirmModal.resolve(true); setConfirmModal(null); }}>{confirmModal.confirmLabel || 'OK'}</button>
            </div>
          </div>
        </div>
      )}
      {codeRunner && <Boundary name="Code Runner" onClose={() => setCodeRunner(null)}><CodeRunnerModal {...codeRunner} onClose={() => setCodeRunner(null)} onInsert={(code) => { insertCode(code); setCodeRunner(null); }} onInsertEquation={(latex, codeBlock) => { insertEquationFromLatex(latex, codeBlock); setCodeRunner(null); }} onChanged={fetchTree} /></Boundary>}
      {showSaveAs && activeTab && <SaveAsModal onClose={() => setShowSaveAs(false)} fileName={activeTabPath} content={activeTab.content} pdfUrl={pdfUrl} projectName={projectName} mainFile={currentMain} />}
      {showPlot3D && <Boundary name="3D Plot Studio" onClose={() => setShowPlot3D(false)}><Suspense fallback={null}><Plot3DStudio onClose={() => setShowPlot3D(false)} onInsert={(code) => { insertCode(code); setShowPlot3D(false); fetchTree(); }} /></Suspense></Boundary>}
      {showPlotStudio && <Boundary name="Plot Studio" onClose={() => setShowPlotStudio(false)}><Suspense fallback={null}><PlotStudio onClose={() => setShowPlotStudio(false)} onInsert={(code) => insertCode(code)} onEnsureSetup={ensureSetup} onOpenInteractive={() => setShowPlot3D(true)} onOpenPython={() => setCodeRunner({ initialLang: 'python', initialCode: SURFACE_3D_TEMPLATE })} /></Suspense></Boundary>}
      {showSymbolDraw && <SymbolDraw onClose={() => setShowSymbolDraw(false)} onInsert={(name) => { insertCode(name + ' '); setShowSymbolDraw(false); }} />}
      {showRefManager && activeTab && <RefManager content={activeTab.content} onClose={() => setShowRefManager(false)} onJump={jumpToLine} onInsertRef={(name) => insertCode(`@${name}`)} />}
      {showBibManager && <BibManager onClose={() => setShowBibManager(false)} onCite={(key) => { insertCode(`@${key}`); ensureBibliography(); }} onEnsureBib={ensureBibliography} onChanged={fetchTree} />}
      
      {showHistoryModal && (
        <div className="modal-overlay" onClick={() => setShowHistoryModal(false)}>
          <div className="modal-content" style={{ width: '400px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>File History</h2>
              <button className="tab-close" style={{ fontSize: '24px', cursor: 'pointer' }} onClick={() => setShowHistoryModal(false)}>×</button>
            </div>
            <div style={{ padding: '10px' }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: '15px' }}>History for {activeTabPath}</div>
              <div className="history-list" style={{ maxHeight: '400px', overflowY: 'auto' }}>
                {history.filter(h => h.path === activeTabPath).length === 0 && (
                  <div style={{ color: '#94a3b8', fontSize: '13px', textAlign: 'center', marginTop: '20px' }}>No history for this file yet.<br/>Save the file (⌘S) to keep a version.</div>
                )}
                {history.filter(h => h.path === activeTabPath).reverse().map((h, i) => (
                  <div key={h.id} className="history-item" onClick={() => { restoreHistory(h); setShowHistoryModal(false); }} style={{ padding: '12px', borderBottom: '1px solid var(--border-color)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: '14px', fontWeight: i === 0 ? 'bold' : 'normal' }}>{new Date(h.timestamp).toLocaleString()}</div>
                    <div style={{ fontSize: '12px', color: '#94a3b8', background: 'rgba(255,255,255,0.1)', padding: '4px 8px', borderRadius: '4px' }}>Restore</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {showSymbolPicker && <SymbolPicker onClose={() => setShowSymbolPicker(false)} onInsert={(code) => { insertCode(code + ' '); setShowSymbolPicker(false); }} />}

      {contextMenu && (
        <div className="context-menu dropdown" style={{ position: 'fixed', top: contextMenu.y, left: contextMenu.x, zIndex: 9999, display: 'block' }} onClick={e => e.stopPropagation()}>
          {contextMenu.type === 'empty' ? (
            <>
              <div className="dropdown-item" onClick={() => { createNewFile(''); setContextMenu(null); }}>New File...</div>
              <div className="dropdown-item" onClick={() => { createNewFolder(''); setContextMenu(null); }}>New Folder...</div>
              <div className="dropdown-divider"></div>
              <div className="dropdown-item" onClick={async () => {
                if (!fileClipboard) return;
                await fetch(`${API}/workspace/${fileClipboard.type === 'cut' ? 'rename' : 'copy'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: fileClipboard.path, to: fileClipboard.path.split('/').pop() }) });
                fetchTree(); setContextMenu(null);
              }}>Paste</div>
              <div className="dropdown-divider"></div>
              <div className="dropdown-item" onClick={() => { fetchTree(); setContextMenu(null); }}>Refresh</div>
              <div className="dropdown-item" onClick={() => { revealInFileManager(); setContextMenu(null); }}>Reveal Workspace</div>
            </>
          ) : (
            <>
              {selectedPaths.length === 1 && (() => {
                if (contextMenu.node!.type !== 'file') return null;
                const ext = (contextMenu.node!.path.split('.').pop() || '').toLowerCase();
                const isImg = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext);
                if (isImg) {
                  return (
                    <div className="dropdown-item" onClick={() => { 
                      insertCode(`\n#figure(\n  image("${contextMenu.node!.path}", width: 80%),\n  caption: [],\n)\n`); 
                      setContextMenu(null); 
                    }}>Insert Image into Document</div>
                  );
                }
                return null;
              })()}
              {selectedPaths.length === 1 && <div className="dropdown-item" onClick={() => { if (contextMenu.node!.type === 'file') openFile(contextMenu.node!.path); setContextMenu(null); }}>Open</div>}
              {selectedPaths.length === 1 && contextMenu.node!.type === 'file' && contextMenu.node!.path.endsWith('.typ') && (
                <div className="dropdown-item" onClick={() => { setMainOverride(contextMenu.node!.path); compileTypst(contextMenu.node!.path); setContextMenu(null); }}>
                  {currentMain === contextMenu.node!.path ? '✓ Main file (compiled in preview)' : 'Set as main file'}
                </div>
              )}
              {selectedPaths.length === 1 && <div className="dropdown-divider"></div>}
              {selectedPaths.length === 1 && <div className="dropdown-item" onClick={() => { const dir = contextMenu.node!.type === 'directory' ? contextMenu.node!.path : (contextMenu.node!.path.includes('/') ? contextMenu.node!.path.substring(0, contextMenu.node!.path.lastIndexOf('/')) : ''); createNewFile(dir); setContextMenu(null); }}>New File...</div>}
              {selectedPaths.length === 1 && <div className="dropdown-item" onClick={() => { const dir = contextMenu.node!.type === 'directory' ? contextMenu.node!.path : (contextMenu.node!.path.includes('/') ? contextMenu.node!.path.substring(0, contextMenu.node!.path.lastIndexOf('/')) : ''); createNewFolder(dir); setContextMenu(null); }}>New Folder...</div>}
              {selectedPaths.length === 1 && <div className="dropdown-divider"></div>}
              <div className="dropdown-item" onClick={() => { handleRename(contextMenu.node!); setContextMenu(null); }}>Rename {selectedPaths.length > 1 ? `(${selectedPaths.length})` : ''}</div>
              <div className="dropdown-item" onClick={() => { handleDuplicate(contextMenu.node!); setContextMenu(null); }}>Duplicate {selectedPaths.length > 1 ? `(${selectedPaths.length})` : ''}</div>
              <div className="dropdown-divider"></div>
              <div className="dropdown-item" onClick={() => { setFileClipboard({ path: selectedPaths[0], type: 'copy' }); setContextMenu(null); }}>Copy</div>
              <div className="dropdown-item" onClick={() => { setFileClipboard({ path: selectedPaths[0], type: 'cut' }); setContextMenu(null); }}>Cut</div>
              <div className="dropdown-item" onClick={async () => {
                if (!fileClipboard) return;
                const dir = contextMenu.node!.type === 'directory' ? contextMenu.node!.path : (contextMenu.node!.path.includes('/') ? contextMenu.node!.path.substring(0, contextMenu.node!.path.lastIndexOf('/')) : '');
                const toPath = dir ? `${dir}/${fileClipboard.path.split('/').pop()}` : fileClipboard.path.split('/').pop();
                await fetch(`${API}/workspace/${fileClipboard.type === 'cut' ? 'rename' : 'copy'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: fileClipboard.path, to: toPath }) });
                fetchTree(); setContextMenu(null);
              }}>Paste</div>
              <div className="dropdown-divider"></div>
              <div className="dropdown-item" onClick={() => {
                const paths = selectedPaths;
                setContextMenu(null);
                setInputModal({
                  title: `Compress ${paths.length} item${paths.length > 1 ? 's' : ''}`,
                  submitLabel: 'Compress',
                  fields: [{ key: 'name', label: 'Archive name', default: 'archive.zip', hint: 'Saved as a .zip in the project root' }],
                  onSubmit: async (v) => {
                    const name = (v.name || '').trim();
                    if (!name) return;
                    await fetch(`${API}/workspace/compress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths, archiveName: name }) });
                    fetchTree();
                  },
                });
              }}>Compress {selectedPaths.length > 1 ? `(${selectedPaths.length})` : ''}</div>
              <div className="dropdown-divider"></div>
              <div className="dropdown-item" style={{ color: '#ef4444' }} onClick={async () => {
                if (!await confirmDialog(`Delete ${selectedPaths.length} items?`, { danger: true, confirmLabel: 'Delete' })) return;
                for (const p of selectedPaths) await fetch(`${API}/workspace/file?path=${encodeURIComponent(p)}`, { method: 'DELETE' });
                setSelectedPaths([]); fetchTree(); setContextMenu(null);
              }}>Delete {selectedPaths.length > 1 ? `(${selectedPaths.length})` : ''}</div>
              <div className="dropdown-divider"></div>
              <div className="dropdown-item" onClick={() => { revealInFileManager(contextMenu.node!.path); setContextMenu(null); }}>Reveal in File Manager</div>
              <div className="dropdown-item" onClick={() => { copyToClipboard(contextMenu.node!.path); setContextMenu(null); }}>Copy Relative Path</div>
              <div className="dropdown-item" onClick={() => { copyAbsolutePath(contextMenu.node!.path); setContextMenu(null); }}>Copy Absolute Path</div>
              {contextMenu.node!.type === 'directory' && (
                <>
                  <div className="dropdown-divider"></div>
                  <div className="dropdown-item" onClick={() => { collapseTree(); setContextMenu(null); }}>Collapse</div>
                  <div className="dropdown-item" onClick={() => { expandTree(); setContextMenu(null); }}>Expand All</div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
