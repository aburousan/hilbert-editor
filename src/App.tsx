import React, { useState, useEffect, useCallback, useRef, useMemo, lazy, Suspense } from 'react';
import { API } from './api';
import Editor, { useMonaco } from '@monaco-editor/react';
import { setupTypstLanguage, lookupTypstDoc, type TypstDoc } from './typstMonaco';
import { PackageInstaller } from './PackageInstaller';
import { TemplateInstaller } from './TemplateInstaller';
import DiagramBuilder from './components/DiagramBuilder';
import FigureBuilder from './components/FigureBuilder';
import QuiverDiagram from './components/QuiverDiagram';
import EditSettings from './components/EditSettings';
import SymbolPicker from './components/SymbolPicker';
import DriveSyncModal from './components/DriveSyncModal';
import AppSettingsModal from './components/AppSettingsModal';
import InputModal, { type InputModalConfig } from './components/InputModal';
import CodeRunnerModal from './components/CodeRunnerModal';
import SaveAsModal from './components/SaveAsModal';
import PdfPreview from './components/PdfPreview';
// Loaded on demand: pulls in all of three.js, which nothing else needs.
const Plot3DStudio = lazy(() => import('./components/Plot3DStudio'));
const FeynmanBuilder = lazy(() => import('./components/FeynmanBuilder'));
import SymbolDraw from './components/SymbolDraw';
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

type FileNode = { type: 'file' | 'directory'; name: string; path: string; children?: FileNode[] };
type Tab = { path: string; content: string; isDirty: boolean };

const DEFAULT_CODE = `#set page(paper: "a4")
#set text(font: "New Computer Modern", size: 11pt)

// Sections and equations are numbered by default:
#set heading(numbering: "1.")
#set math.equation(numbering: "(1)")

#import "@preview/cetz:0.3.4"
#import "@preview/physica:0.9.8": *

= Typst with Physics and CeTZ!

This is a local, offline editor for *Typst*. It comes pre-configured with packages!
`;

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

export default function App() {
  const editorRef = useRef<any>(null);
  const [tabs, setTabs] = useState<Tab[]>([{ path: 'main.typ', content: DEFAULT_CODE, isDirty: true }]);
  const [activeTabPath, setActiveTabPath] = useState<string>('main.typ');
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [errorLogs, setErrorLogs] = useState<string | null>(null);
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
  useEffect(() => { localStorage.setItem('text_color', textColor); }, [textColor]);
  useEffect(() => { localStorage.setItem('editor_font_size', String(editorFontSize)); }, [editorFontSize]);
  useEffect(() => { localStorage.setItem('compile_delay', String(compileDelay)); }, [compileDelay]);

  const activeTab = tabs.find(t => t.path === activeTabPath);
  
  const getStats = () => {
    if (!activeTab) return { words: 0, chars: 0 };
    const text = activeTab.content;
    const chars = text.length;
    const words = text.trim().split(/\s+/).filter(w => w.length > 0).length;
    return { words, chars };
  };
  const stats = getStats();
  const [showPackageInstaller, setShowPackageInstaller] = useState(false);
  const [showTemplateInstaller, setShowTemplateInstaller] = useState(false);
  const [showSymbolPicker, setShowSymbolPicker] = useState(false);
  const [showDiagramBuilder, setShowDiagramBuilder] = useState(false);
  const [showFeynman, setShowFeynman] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showFigureBuilder, setShowFigureBuilder] = useState(false);
  const [showQuiver, setShowQuiver] = useState(false);
  const [showEditSettings, setShowEditSettings] = useState(false);
  const [showDriveSync, setShowDriveSync] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showAppSettings, setShowAppSettings] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('Project Report');
  const [editingTitle, setEditingTitle] = useState(false);
  const [inputModal, setInputModal] = useState<InputModalConfig | null>(null);
  const [codeRunner, setCodeRunner] = useState<null | { initialLang?: 'python' | 'julia' | 'wolfram'; initialCode?: string; initialMode?: 'text' | 'equation' }>(null);
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [showPlot3D, setShowPlot3D] = useState(false);
  const [showSymbolDraw, setShowSymbolDraw] = useState(false);
  const [docPopup, setDocPopup] = useState<{ info: TypstDoc; x: number; y: number } | { notFound: string } | null>(null);
  const [showRefManager, setShowRefManager] = useState(false);
  const [showBibManager, setShowBibManager] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  
  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [editorWidth, setEditorWidth] = useState(500);
  const [treeHeight, setTreeHeight] = useState(220);
  const isResizingSidebar = useRef(false);
  const isResizingEditor = useRef(false);
  const isResizingTree = useRef(false);
  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const toggleNumberingRef = useRef<() => void>(() => {});

  const monaco = useMonaco();

  useEffect(() => { if (monaco) setupTypstLanguage(monaco); }, [monaco]);
  useEffect(() => { fetchTree(); }, []);

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
      }
    };
    const handleMouseUp = () => {
      isResizingSidebar.current = false;
      isResizingEditor.current = false;
      isResizingTree.current = false;
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
      if (res.ok) setFileTree(await res.json());
    } catch(e) {}
  };


  const compileTypst = useCallback(async (mainFile: string = 'main.typ') => {
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
      
      const res = await fetch(`${API}/compile?main=${encodeURIComponent(mainFile)}`, { method: 'POST' });
      if (!res.ok) {
        const errData = await res.json();
        setErrorLogs(errData.error || 'Compilation failed');
        return;
      }
      
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setPdfUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url; });
      setErrorLogs(null);
      
      setHistory(prev => {
        let newHistory = [...prev];
        for (const tab of tabs) {
          const last = prev.filter(h => h.path === tab.path).pop();
          if (!last || last.content !== tab.content) {
            newHistory.push({ id: Math.random().toString(), timestamp: Date.now(), path: tab.path, content: tab.content });
          }
        }
        return newHistory;
      });

      setTabs(prev => prev.map(t => ({ ...t, isDirty: false })));
      fetchTree();
    } catch (error) {
      setErrorLogs(String(error));
    } finally {
      setIsCompiling(false);
    }
  }, [tabs]);

  const restoreHistory = (h: HistoryEntry) => {
    if (confirm(`Restore version from ${new Date(h.timestamp).toLocaleTimeString()}?`)) {
      setTabs(prev => {
        if (!prev.find(t => t.path === h.path)) {
          return [...prev, { path: h.path, content: h.content, isDirty: true }];
        }
        return prev.map(t => t.path === h.path ? { ...t, content: h.content, isDirty: true } : t);
      });
    }
  };

  const currentMain = activeTabPath && activeTabPath.endsWith('.typ') ? activeTabPath : 'main.typ';
  const [lastCompiledPath, setLastCompiledPath] = useState<string>('');

  const saveActiveFile = useCallback(async () => {
    if (!activeTab) return;
    try {
      await fetch(`${API}/workspace/file?path=${encodeURIComponent(activeTab.path)}`, {
        method: 'POST', body: activeTab.content, headers: { 'Content-Type': 'text/plain' }
      });
      syncToDisk(activeTab.path, activeTab.content);   // mirror to the opened folder on disk
      setTabs(prev => prev.map(t => t.path === activeTab.path ? { ...t, isDirty: false } : t));
      fetchTree();
      compileTypst(currentMain);
      webdavAutoSync();
    } catch (e) {}
  }, [activeTab, currentMain, compileTypst]);

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
    'S-m': () => insertMatrix(),
    'S-p': () => setShowSymbolPicker(true),
    'S-f': () => setShowFeynman(true),
    'S-k': () => setCodeRunner({ initialLang: 'python' }),
    'S-u': () => computeSelection(),
    'b': () => wrapSelection('*', '*'),
    'i': () => wrapSelection('_', '_'),
    'e': () => wrapSelection('$', '$'),
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === 's' && !e.shiftKey) { e.preventDefault(); saveActiveFile(); return; }
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
    const hasDirty = tabs.some(t => t.isDirty);
    if (hasDirty || currentMain !== lastCompiledPath) {
      const timeoutId = setTimeout(() => { 
        compileTypst(currentMain); 
        setLastCompiledPath(currentMain);
      }, hasDirty ? compileDelay : 50);
      return () => clearTimeout(timeoutId);
    }
  }, [tabs, compileTypst, currentMain, lastCompiledPath, compileDelay]);

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined && activeTabPath) {
      setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, content: value, isDirty: true } : t));
    }
  };

  const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'];
  const openFile = async (path: string) => {
    const ext = (path.split('.').pop() || '').toLowerCase();
    // Images/binaries aren't text — clicking one inserts a reference instead.
    if (IMG_EXT.includes(ext)) {
      insertCode(`\n#figure(\n  image("${path}", width: 80%),\n  caption: [],\n)\n`);
      return;
    }
    if (!tabs.find(t => t.path === path)) {
      try {
        const res = await fetch(`${API}/workspace/file?path=${encodeURIComponent(path)}`);
        if (res.ok) {
          const content = await res.text();
          setTabs(prev => [...prev, { path, content, isDirty: false }]);
        }
      } catch (e) {}
    }
    setActiveTabPath(path);
  };

  const closeTab = (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    setTabs(prev => {
      const newTabs = prev.filter(t => t.path !== path);
      if (activeTabPath === path && newTabs.length > 0) setActiveTabPath(newTabs[newTabs.length - 1].path);
      else if (newTabs.length === 0) setActiveTabPath('');
      return newTabs;
    });
  };

  const deleteEntry = async (e: React.MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Delete ${isDir ? 'folder' : 'file'} "${path}"?${isDir ? '\nAll of its contents will be removed.' : ''}`)) return;
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

  const createNewFile = async () => {
    const name = prompt('File name (use a slash for a subfolder, e.g. chapters/intro.typ):', 'new.typ');
    if (!name) return;
    await fetch(`${API}/workspace/file?path=${encodeURIComponent(name)}`, { method: 'POST', body: '' });
    fetchTree();
    openFile(name);
  };

  const createNewFolder = async () => {
    const name = prompt('Folder name (e.g. images):', 'images');
    if (!name) return;
    await fetch(`${API}/workspace/mkdir?path=${encodeURIComponent(name)}`, { method: 'POST' });
    fetchTree();
  };

  // Upload any file (images included) into the workspace, optionally into a folder.
  const uploadAsset = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const folder = (prompt('Destination folder (leave blank for the project root):', 'images') || '').replace(/^\/+|\/+$/g, '');
      const path = folder ? `${folder}/${file.name}` : file.name;
      const buf = await file.arrayBuffer();
      await fetch(`${API}/workspace/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream' } });
      await fetchTree();
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (IMG_EXT.includes(ext)) insertCode(`\n#figure(\n  image("${path}", width: 80%),\n  caption: [],\n)\n`);
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
      if (files.length > 400 && !confirm(`Import ${files.length} files? This may take a moment.`)) return;
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
      if (!res.ok) { alert(data.error || 'Could not open that folder.'); return; }
      dirHandleRef.current = null;   // desktop backend edits the folder directly
      const name = folder.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || 'Project';
      await loadWorkspace(name);
      addRecentFolder({ name, path: folder });
    } catch { alert('Could not reach the local server.'); }
  };

  // Chrome/Edge: writable directory handle → edits reflect on disk (also used by
  // Open Recent, where the handle comes back out of IndexedDB).
  const openDirHandleAsRoot = async (dir: any, ask = true) => {
    try {
      if (dir.requestPermission && (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        alert('Write permission is needed so your edits save back to the folder.'); return;
      }
      if (ask && !confirm(`Open “${dir.name}” as the workspace? Your edits will be saved back to this folder on disk.`)) return;
      await fetch(`${API}/workspace/clear`, { method: 'POST' });
      dirHandleRef.current = dir;
      await importDirHandle(dir, '');
      await loadWorkspace(dir.name);
      const key = `dir:${dir.name}`;
      try { await idbPut(key, dir); addRecentFolder({ name: dir.name, idb: key }); } catch { /* recents are best-effort */ }
    } catch { alert('Could not open that folder.'); }
  };

  const openRecentFolder = async (r: RecentFolder) => {
    if (r.path) { await openFolderPathAsRoot(r.path); return; }
    if (r.idb) {
      try {
        const h = await idbGet(r.idb);
        if (!h) throw new Error('gone');
        await openDirHandleAsRoot(h, false);
      } catch { alert('Could not reopen this folder — open it once via File → Open Folder…'); }
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
      if (!confirm(`Open “${rootName}” as the workspace? This browser can't save edits back to disk, so a working copy is imported (${files.length} files). Use the desktop app or Chrome to edit the folder in place.`)) return;
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
      } catch { alert('Could not import that folder.'); }
    };
    input.click();
  };

  // Import a data file (CSV/JSON/…) into the workspace and insert the matching
  // Typst read function so it can be used in the document.
  const insertDataFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.json,.yaml,.yml,.toml,.xml,.txt';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      const name = file.name;
      await fetch(`${API}/workspace/file?path=${encodeURIComponent(name)}`, { method: 'POST', body: text, headers: { 'Content-Type': 'text/plain' } });
      await fetchTree();
      const ext = (name.split('.').pop() || '').toLowerCase();
      let snippet: string;
      if (ext === 'csv') snippet =
`#let data = csv("${name}")
// Preview: header + first 10 rows, auto-scaled to fit the page. \`data\` holds every row.
#let _rows = data.slice(0, calc.min(11, data.len()))
#let _tbl = text(size: 8pt, table(
  columns: data.first().len(),
  align: left,
  table.header(.._rows.first()),
  .._rows.slice(1).flatten(),
))
#layout(size => scale(
  calc.min(1, size.width / measure(_tbl).width) * 100%,
  reflow: true,
  _tbl,
))`;
      else if (ext === 'json') snippet = `#let data = json("${name}")\n// e.g. #data.at("key")`;
      else if (ext === 'yaml' || ext === 'yml') snippet = `#let data = yaml("${name}")`;
      else if (ext === 'toml') snippet = `#let data = toml("${name}")`;
      else if (ext === 'xml') snippet = `#let data = xml("${name}")`;
      else snippet = `#let text-data = read("${name}")`;
      insertCode('\n' + snippet + '\n\n');
    };
    input.click();
  };
  
  const handleInitTemplate = async (templateCode: string) => {
    setShowTemplateInstaller(false);
    await fetchTree();
    setTabs([{ path: 'main.typ', content: templateCode, isDirty: false }]);
    setActiveTabPath('main.typ');
    compileTypst('main.typ');
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

  // Replace the current selection with `text` (wrapping it), or insert at the
  // cursor when nothing is selected.
  const replaceOrInsert = (sel: any, editor: any, model: any, text: string) => {
    if (sel && model && !sel.isEmpty()) {
      editor.executeEdits('wrap', [{ range: sel, text, forceMoveMarkers: true }]);
      editor.focus();
    } else insertCode(text);
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
  const insertEquationFromLatex = (latex: string, codeBlock?: string) => {
    ensureRule('@preview/mitex', '#import "@preview/mitex:0.2.7": mitex');
    const lines = latex.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const body = lines.map(l => '#mitex(`' + l + '`)').join('\n\n');
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

  const insertTable = () => setInputModal({
    title: 'Insert Table',
    fields: [
      { key: 'rows', label: 'Rows (incl. header)', type: 'number', default: '3' },
      { key: 'cols', label: 'Columns', type: 'number', default: '3' },
      { key: 'header', label: 'Bold coloured header row', type: 'checkbox', default: 'true' },
      { key: 'headercolor', label: 'Header colour', type: 'select', default: 'blue', options: ['blue', 'gray', 'green', 'orange', 'purple', 'red'] },
      { key: 'stripe', label: 'Zebra striping', type: 'checkbox', default: 'false' },
      { key: 'align', label: 'Cell alignment', type: 'select', default: 'left', options: ['left', 'center', 'right', 'horizon'] },
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
      const lines: string[] = [`  columns: ${c},`, `  align: ${v.align} + horizon,`, `  inset: 7pt,`, strokeMap[v.border] || strokeMap['all lines']];
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
    const editor = editorRef.current, model = editor?.getModel();
    const sel = editor?.getSelection();
    const inner = sel && model && !sel.isEmpty() ? model.getValueInRange(sel).trim() : 'x';
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
    const editor = editorRef.current, model = editor?.getModel();
    const sel = editor?.getSelection();
    const inner = sel && model && !sel.isEmpty() ? model.getValueInRange(sel).trim() : '$ E = m c^2 $';
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
    const editor = editorRef.current, model = editor?.getModel();
    const sel = editor?.getSelection();
    const inner = sel && model && !sel.isEmpty() ? model.getValueInRange(sel).trim() : 'text';
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

  const insertHighlight = () => {
    const editor = editorRef.current, model = editor?.getModel();
    const sel = editor?.getSelection();
    const inner = sel && model && !sel.isEmpty() ? model.getValueInRange(sel).trim() : 'text';
    setInputModal({
      title: 'Highlight / Background Colour',
      fields: [
        { key: 'body', label: 'Text', default: inner },
        { key: 'color', label: 'Background colour', type: 'color', default: 'rgb("#fff59d")' },
      ],
      submitLabel: 'Insert',
      onSubmit: (v) => replaceOrInsert(sel, editor, model, `#highlight(fill: ${v.color})[${v.body}]`)
    });
  };

  const insertTextColor = () => {
    const editor = editorRef.current, model = editor?.getModel();
    const sel = editor?.getSelection();
    const inner = sel && model && !sel.isEmpty() ? model.getValueInRange(sel).trim() : 'text';
    setInputModal({
      title: 'Text Colour',
      fields: [
        { key: 'body', label: 'Text', default: inner },
        { key: 'color', label: 'Colour', type: 'color', default: 'rgb("#ef4444")' },
      ],
      submitLabel: 'Insert',
      onSubmit: (v) => replaceOrInsert(sel, editor, model, `#text(fill: ${v.color})[${v.body}]`)
    });
  };

  const setSelectionFontSizePrompt = () => setInputModal({
    title: 'Font Size',
    fields: [{ key: 'pt', label: 'Size (pt)', type: 'number', default: '12' }],
    submitLabel: 'Apply',
    onSubmit: (v) => setSelectionFontSize(v.pt)
  });

  const insertBox = () => {
    const editor = editorRef.current, model = editor?.getModel();
    const sel = editor?.getSelection();
    const inner = sel && model && !sel.isEmpty() ? model.getValueInRange(sel).trim() : 'content';
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
    const editor = editorRef.current, model = editor?.getModel();
    const sel = editor?.getSelection();
    const inner = sel && model && !sel.isEmpty() ? model.getValueInRange(sel).trim() : 'content';
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

  // Wrap the selected element (figure/table/plot/image/…) in a numbered #figure
  // with a caption, so it gets a "Figure N" number and can be cross-referenced.
  const wrapInFigure = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    editor.focus();
    const sel = editor.getSelection();
    const selected = sel && !sel.isEmpty() ? model.getValueInRange(sel).trim() : '';
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

  const insertCetz3D = () => setInputModal({
    title: 'Insert 3D Surface (cetz)',
    fields: [
      { key: 'expr', label: 'z = f(x, y)  (Typst calc syntax)', default: 'calc.sin(calc.sqrt(x*x + y*y))' },
      { key: 'range', label: 'Range (± value on x and y)', default: '4' },
      { key: 'caption', label: 'Figure caption', default: '3D surface' },
      { key: 'label', label: 'Label (optional)', placeholder: 'surf1 → @fig:surf1' },
    ],
    onSubmit: (v) => {
      const R = Math.abs(parseFloat(v.range)) || 4;
      const s = (2 * R / 16).toFixed(3);
      const canvas = `canvas({
    import draw: *
    rotate(x: 70deg, z: 30deg)
    let f(x, y) = ${v.expr}
    let n = 16
    let s = ${s}
    for i in range(n) {
      for j in range(n) {
        let x = (i - n/2)*s
        let y = (j - n/2)*s
        let x2 = (i + 1 - n/2)*s
        let y2 = (j + 1 - n/2)*s
        if i < n - 1 { line((x, y, f(x, y)), (x2, y, f(x2, y)), stroke: blue.darken(10%)) }
        if j < n - 1 { line((x, y, f(x, y)), (x, y2, f(x, y2)), stroke: blue.darken(10%)) }
      }
    }
  })`;
      const imp = '#import "@preview/cetz:0.3.4": canvas, draw\n';
      const tag = v.label ? ` <fig:${v.label}>` : '';
      insertCode(`\n${imp}#figure(\n  ${canvas},\n  caption: [${v.caption}],\n)${tag}\n\n`);
    }
  });

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

  // Ensure a multi-line preamble block exists once, at the top of the document.
  const ensureSetup = (marker: string, block: string) => {
    if (!activeTab || activeTab.content.includes(marker)) return;
    const editor = editorRef.current, model = editor?.getModel();
    if (editor && model) editor.executeEdits('setup', [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as any, text: block + '\n\n', forceMoveMarkers: true }]);
  };

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

  const insertLabel = () => setInputModal({
    title: 'Insert Label',
    fields: [{ key: 'label', label: 'Label name', default: 'sec:intro', hint: 'Attach to the preceding heading/equation; reference it with @name.' }],
    submitLabel: 'Add Label',
    onSubmit: (v) => { if (v.label) insertCode(` <${v.label}>`); }
  });

  // Best-effort Typst-math → sympy translation for the compute dialog.
  const typstToSympy = (s: string) => s.replace(/\$/g, '').replace(/\^/g, '**').replace(/\bdif\b/g, 'd').trim();

  // Compute on the current selection: send it to sympy (simplify / solve / diff /
  // integrate / numeric) and return the result as a typeset equation. Reuses the
  // existing code runner (equation mode → "Insert as equation").
  const computeSelection = () => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const sel = editor?.getSelection();
    const selected = sel && model && !sel.isEmpty() ? model.getValueInRange(sel).trim() : '';
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

  // Reverse "SyncTeX"-style search: a word double-clicked in the PDF preview is
  // matched in the source and the editor jumps to it (best effort — works for
  // prose/headings; rendered math may not match the source token).
  const syncDecorations = useRef<string[]>([]);
  const jumpToWord = useCallback((raw: string, context?: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const word = raw.replace(/[^\p{L}\p{N}_]/gu, ' ').trim().split(/\s+/).filter(w => w.length > 1).pop();
    if (!word) return;
    // Whole-word matches only (avoids partial hits inside longer words).
    const all = model.findMatches(word, true, false, true, ' \t\n.,;:!?()[]{}*_$#=+-/\\"\'<>', false);
    // Drop matches that fall inside line comments (// ...) — they aren't real text.
    const real = all.filter((m: any) => {
      const lineText = model.getLineContent(m.range.startLineNumber);
      const c = lineText.indexOf('//');
      return c === -1 || m.range.startColumn - 1 < c;
    });
    const matches = real.length ? real : all;
    if (!matches.length) { setErrorLogs(`"${word}" not found in source (rendered math/symbols may differ).`); return; }
    // Use the surrounding words from the PDF (context) to pick the right instance
    // when the word occurs more than once: score each match by how many of the
    // neighbouring words appear on the same or an adjacent source line.
    const cur = editor.getPosition();
    let next: any;
    const ctxWords = (context || '').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(w => w.length > 2 && w !== word.toLowerCase());
    if (matches.length > 1 && ctxWords.length) {
      const scoreAt = (m: any) => {
        const from = Math.max(1, m.range.startLineNumber - 1), to = Math.min(model.getLineCount(), m.range.startLineNumber + 1);
        let text = '';
        for (let ln = from; ln <= to; ln++) text += ' ' + model.getLineContent(ln).toLowerCase();
        return ctxWords.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
      };
      let best = -1;
      for (const m of matches) { const s = scoreAt(m); if (s > best) { best = s; next = m; } }
      if (best <= 0) next = undefined; // no context hit — fall back to cursor cycling
    }
    // Otherwise prefer the next match strictly after the cursor, so repeated clicks cycle.
    if (!next) next = matches.find((m: any) => !cur || m.range.startLineNumber > cur.lineNumber ||
      (m.range.startLineNumber === cur.lineNumber && m.range.startColumn > cur.column)) || matches[0];
    editor.revealLineInCenter(next.range.startLineNumber);
    editor.setPosition({ lineNumber: next.range.startLineNumber, column: next.range.startColumn });
    editor.focus();
    syncDecorations.current = editor.deltaDecorations(syncDecorations.current, [{ range: next.range, options: { inlineClassName: 'sync-flash' } }]);
    setTimeout(() => { if (editorRef.current) syncDecorations.current = editorRef.current.deltaDecorations(syncDecorations.current, []); }, 1300);
  }, []);

  const renderTree = (nodes: FileNode[]) => {
    return nodes.map(node => (
      <div key={node.path} className="tree-node">
        {node.type === 'directory' ? (
          <details open>
            <summary className="tree-dir">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
              <span className="tree-name">{node.name}</span>
              <button className="tree-del" title="Delete folder" onClick={(e) => deleteEntry(e, node.path, true)}>×</button>
            </summary>
            <div className="tree-children">{node.children && renderTree(node.children)}</div>
          </details>
        ) : (
          <div className={`tree-file ${activeTabPath === node.path ? 'active' : ''}`} onClick={() => openFile(node.path)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
            <span className="tree-name">{node.name}</span>
            <button className="tree-del" title="Delete file" onClick={(e) => deleteEntry(e, node.path, false)}>×</button>
          </div>
        )}
      </div>
    ));
  };

  // Memoize derived views so typing doesn't re-walk the tree / re-scan headings
  // on every keystroke (they only depend on the tree and the active file).
  const treeJsx = useMemo(() => renderTree(fileTree), [fileTree, activeTabPath]);
  const outline = useMemo(() => getOutline(), [activeTab?.content]);

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

  return (
    <div className="app-container" onClick={() => { setActiveMenu(null); setColorPopAt(null); }}>
      <header className="header">
        <div className="header-left">
          <div className="logo logo-btn" style={{ fontSize: '0.9rem', gap: '4px' }} title="About Typst Editor" onClick={() => setShowAbout(true)}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="logoGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a78bfa"/><stop offset="1" stopColor="#60a5fa"/></linearGradient></defs><path fillRule="evenodd" clipRule="evenodd" fill="url(#logoGrad)" d="M9.29289 1.29289C9.48043 1.10536 9.73478 1 10 1H18C19.6569 1 21 2.34315 21 4V9C21 9.55228 20.5523 10 20 10C19.4477 10 19 9.55228 19 9V4C19 3.44772 18.5523 3 18 3H11V8C11 8.55228 10.5523 9 10 9H5V20C5 20.5523 5.44772 21 6 21H10C10.5523 21 11 21.4477 11 22C11 22.5523 10.5523 23 10 23H6C4.34315 23 3 21.6569 3 20V8C3 7.73478 3.10536 7.48043 3.29289 7.29289L9.29289 1.29289ZM6.41421 7H9V4.41421L6.41421 7ZM11.2929 10.2929C11.63 9.95583 12.1581 9.90353 12.5547 10.1679C12.7377 10.29 13.138 10.4206 13.8692 10.5557C14.2116 10.619 14.5873 10.6773 15.0006 10.7413L15.0159 10.7436C15.42 10.8062 15.8556 10.8736 16.3008 10.9531C18.0592 11.2671 20.2179 11.8037 21.7071 13.2929C22.907 14.4928 23.2701 15.7765 23.1846 16.8892C23.1413 17.4519 22.9841 17.9568 22.7829 18.3687L23 18.5858C23.781 19.3668 23.781 20.6332 23 21.4142L21.4142 23C20.6332 23.781 19.3668 23.781 18.5858 23L18.3687 22.7829C17.9568 22.9841 17.4519 23.1413 16.8892 23.1846C15.7765 23.2701 14.4928 22.907 13.2929 21.7071C11.8037 20.2179 11.2671 18.0592 10.9531 16.3008C10.8736 15.8556 10.8062 15.42 10.7436 15.0159L10.7413 15.0006C10.6773 14.5873 10.619 14.2116 10.5557 13.8692C10.4206 13.138 10.29 12.7377 10.1679 12.5547C9.90353 12.1581 9.95583 11.63 10.2929 11.2929L10.7926 10.7931L10.7929 10.7929L11.2929 10.2929ZM15.0677 16.482L12.6124 14.0266C12.6482 14.2458 12.683 14.47 12.7177 14.6947L12.7186 14.7006L12.7187 14.7007C12.7821 15.1107 12.8465 15.527 12.9219 15.9492C13.2329 17.6908 13.6963 19.2821 14.7071 20.2929C15.5072 21.093 16.2235 21.2299 16.7358 21.1904C17.3109 21.1462 17.7121 20.8737 17.7929 20.7929C18.1834 20.4024 18.8166 20.4024 19.2071 20.7929L20 21.5858L21.5858 20L20.7929 19.2071C20.6054 19.0196 20.5 18.7652 20.5 18.5C20.5 18.2348 20.6054 17.9804 20.7929 17.7929C20.8737 17.7121 21.1462 17.3109 21.1904 16.7358C21.2299 16.2235 21.093 15.5072 20.2929 14.7071C19.2821 13.6963 17.6908 13.2329 15.9492 12.9219C15.527 12.8465 15.1107 12.7821 14.7007 12.7187L14.7006 12.7186L14.6947 12.7177C14.47 12.683 14.2458 12.6482 14.0266 12.6124L16.482 15.0677C16.6472 15.0236 16.8208 15 17 15C18.1046 15 19 15.8954 19 17C19 18.1046 18.1046 19 17 19C15.8954 19 15 18.1046 15 17C15 16.8208 15.0236 16.6472 15.0677 16.482Z"/></svg>
            TypstEditor
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
                      <div className="dropdown-item" onClick={() => { wrapSelection('$', '$'); setActiveMenu(null); }}>Inline Equation <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘E</span></div>
                      <div className="dropdown-item" onClick={() => { insertCode('\n$ E = m c^2 $\n\n'); setActiveMenu(null); }}>Block Equation</div>
                      <div className="dropdown-item" onClick={() => { insertMultilineEquation(); setActiveMenu(null); }}>Multiline / Aligned Equation</div>
                      <div className="dropdown-item" onClick={() => { insertNumberedEquation(); setActiveMenu(null); }}>Numbered Equation... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧E</span></div>
                      <div className="dropdown-item" onClick={() => { insertMatrix(); setActiveMenu(null); }}>Matrix (delimiters, lines, colour)... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧M</span></div>
                      <div className="dropdown-item" onClick={() => { insertCases(); setActiveMenu(null); }}>Conditional / Piecewise (cases)...</div>
                      <div className="dropdown-item" onClick={() => { insertBrace(); setActiveMenu(null); }}>Over / Under Brace...</div>
                      <div className="dropdown-item" onClick={() => { insertCancel(); setActiveMenu(null); }}>Cancel / Strike Term...</div>
                      <div className="dropdown-item" onClick={() => { setShowSymbolPicker(true); setActiveMenu(null); }}>Math &amp; Physics Symbols... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧P</span></div>
                      <div className="dropdown-item" onClick={() => { setShowSymbolDraw(true); setActiveMenu(null); }}>Draw a Symbol → Typst (experimental)...</div>
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
                    </div>
                  </div>
                  <div className="dropdown-item has-submenu">
                    <span>Media &amp; Tables</span><span className="submenu-arrow">›</span>
                    <div className="submenu">
                      <div className="dropdown-item" onClick={() => { setShowFigureBuilder(true); setActiveMenu(null); }}>Figure...</div>
                      <div className="dropdown-item" onClick={() => { insertImage(); setActiveMenu(null); }}>Image...</div>
                      <div className="dropdown-item" onClick={() => { insertTable(); setActiveMenu(null); }}>Table...</div>
                      <div className="dropdown-item" onClick={() => { insertDataFile(); setActiveMenu(null); }}>Import Data (CSV/JSON)...</div>
                      <div className="dropdown-item" onClick={() => { insertCode('\n```rust\nfn main() {\n  println!("Hello World!");\n}\n```\n'); setActiveMenu(null); }}>Code Block</div>
                    </div>
                  </div>
                  <div className="dropdown-item has-submenu">
                    <span>Plots</span><span className="submenu-arrow">›</span>
                    <div className="submenu">
                      <div className="dropdown-item" onClick={() => { setShowDiagramBuilder(true); setActiveMenu(null); }}>Diagram / Plot (2D, cetz)...</div>
                      <div className="dropdown-item" onClick={() => { insertCetz3D(); setActiveMenu(null); }}>3D Surface (cetz)...</div>
                      <div className="dropdown-item" onClick={() => { setCodeRunner({ initialLang: 'python', initialCode: SURFACE_3D_TEMPLATE }); setActiveMenu(null); }}>3D Surface (Python/matplotlib)...</div>
                      <div className="dropdown-item" onClick={() => { setShowPlot3D(true); setActiveMenu(null); }}>3D Plot Studio (rotate &amp; pick view)...</div>
                      <div className="dropdown-item" onClick={() => { setShowQuiver(true); setActiveMenu(null); }}>Commutative Diagram (quiver)...</div>
                      <div className="dropdown-item" onClick={() => { setShowFeynman(true); setActiveMenu(null); }}>Feynman Diagram (visual)... <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧F</span></div>
                    </div>
                  </div>
                  <div className="dropdown-item has-submenu">
                    <span>Compute</span><span className="submenu-arrow">›</span>
                    <div className="submenu">
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
                  <div className="dropdown-item" onClick={() => { wrapSelection('*', '*'); setActiveMenu(null); }}>Bold <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘B</span></div>
                  <div className="dropdown-item" onClick={() => { wrapSelection('_', '_'); setActiveMenu(null); }}>Italic <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘I</span></div>
                  <div className="dropdown-item" onClick={() => { wrapSelection('#super[', ']'); setActiveMenu(null); }}>Superscript</div>
                  <div className="dropdown-item" onClick={() => { wrapSelection('#sub[', ']'); setActiveMenu(null); }}>Subscript</div>
                  <div className="dropdown-divider"></div>
                  <div className="dropdown-item" onClick={() => { insertTextColor(); setActiveMenu(null); }}>Text Colour...</div>
                  <div className="dropdown-item" onClick={() => { insertUnderline(); setActiveMenu(null); }}>Underline (colour, background)...</div>
                  <div className="dropdown-item" onClick={() => { insertHighlight(); setActiveMenu(null); }}>Highlight / Background Colour...</div>
                  <div className="dropdown-item" onClick={() => { insertCancel(); setActiveMenu(null); }}>Cross Out / Strike Through...</div>
                  <div className="dropdown-divider"></div>
                  <div className="dropdown-item" onClick={() => { insertBox(); setActiveMenu(null); }}>Box Selection (fill, border, texture)...</div>
                  <div className="dropdown-item" onClick={() => { setSelectionFontSizePrompt(); setActiveMenu(null); }}>Font Size...</div>
                  <div className="dropdown-item" onClick={() => { insertAlign(); setActiveMenu(null); }}>Align Content...</div>
                  <div className="dropdown-item" onClick={() => { insertRotate(); setActiveMenu(null); }}>Rotate (content or equation)...</div>
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
          <button className="theme-toggle" onClick={() => setTheme(t => t === 'typst-dark' ? 'typst-light' : 'typst-dark')}
            title={theme === 'typst-dark' ? 'Editor theme: dark — click for light (the PDF preview has its own toggle)' : 'Editor theme: light — click for dark (the PDF preview has its own toggle)'}>
            {theme === 'typst-dark'
              ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
              : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2"></path><path d="M12 20v2"></path><path d="M4.93 4.93l1.41 1.41"></path><path d="M17.66 17.66l1.41 1.41"></path><path d="M2 12h2"></path><path d="M20 12h2"></path><path d="M4.93 19.07l1.41-1.41"></path><path d="M17.66 6.34l1.41-1.41"></path></svg>}
          </button>
          <div style={{ opacity: 0.8, display: 'flex', alignItems: 'center' }} title="Words / Characters">
            {stats.words} Words
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', opacity: 0.8 }} title="History" onClick={() => setShowHistoryModal(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v4"></path><path d="M12 18v4"></path><path d="M4.93 4.93l2.83 2.83"></path><path d="M16.24 16.24l2.83 2.83"></path><path d="M2 12h4"></path><path d="M18 12h4"></path><path d="M4.93 19.07l2.83-2.83"></path><path d="M16.24 7.76l2.83-2.83"></path></svg>
          </div>
          <a href="https://github.com/aburousan/typsteditor" target="_blank" rel="noopener noreferrer" title="Source code on GitHub" style={{ display: 'flex', alignItems: 'center', color: 'inherit', opacity: 0.8 }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.79 2.73 1.27 3.4.97.11-.75.41-1.27.74-1.56-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 2.9-.39c.98 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.68.42.36.8 1.08.8 2.18 0 1.57-.01 2.84-.01 3.23 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z"></path></svg>
          </a>
          <button style={{ background: '#10b981', color: 'white', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 500, display: 'flex', alignItems: 'center', gap: '6px' }} onClick={() => setShowDriveSync(true)}>
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
          <div className="toolbar-divider" style={{ width: '1px', height: '20px', background: 'var(--border-color)', margin: '0 4px' }}></div>
          <button className="tool-btn" onClick={() => wrapSelection('*', '*')} title="Bold"><b>B</b></button>
          <button className="tool-btn" onClick={() => wrapSelection('_', '_')} title="Italic"><i>I</i></button>
          <button className="tool-btn" onClick={() => wrapSelection('#underline[', ']')} title="Underline"><u>U</u></button>
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
          <button className="tool-btn" onClick={() => wrapSelection('#super[', ']')} title="Superscript">x²</button>
          <button className="tool-btn" onClick={() => wrapSelection('#sub[', ']')} title="Subscript">x₂</button>
          <button className="tool-btn" onClick={insertWebLink} title="Insert Web Link"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg></button>
          <button className="tool-btn" onClick={() => insertCode('#image("path.png", width: 80%)')} title="Image"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg></button>
          <button className="tool-btn" onClick={() => wrapSelection('$', '$')} title="Math"><b>∑</b></button>
          <div className="toolbar-divider" style={{ width: '1px', height: '20px', background: 'var(--border-color)', margin: '0 4px' }}></div>
          <button className="tool-btn" onClick={() => wrapSelection('#align(left)[', ']')} title="Align Left"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="17" y1="6" x2="3" y2="6"></line><line x1="21" y1="12" x2="3" y2="12"></line><line x1="17" y1="18" x2="3" y2="18"></line></svg></button>
          <button className="tool-btn" onClick={() => wrapSelection('#align(center)[', ']')} title="Align Center"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="6"></line><line x1="21" y1="12" x2="3" y2="12"></line><line x1="18" y1="18" x2="6" y2="18"></line></svg></button>
          <button className="tool-btn" onClick={() => wrapSelection('#align(right)[', ']')} title="Align Right"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="21" y1="6" x2="7" y2="6"></line><line x1="21" y1="12" x2="3" y2="12"></line><line x1="21" y1="18" x2="7" y2="18"></line></svg></button>
          <div className="toolbar-divider" style={{ width: '1px', height: '20px', background: 'var(--border-color)', margin: '0 4px' }}></div>
          <button className="tool-btn" onClick={insertLabel} title="Add Label (anchor)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg></button>
          <button className="tool-btn" onClick={insertCrossRef} title="Cross-reference (@label)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7V4h16v3"></path><path d="M9 20h6"></path><path d="M12 4v16"></path></svg><span style={{ fontWeight: 700, marginLeft: -2 }}>@</span></button>
          <button className="tool-btn" onClick={toggleNumbering} title="Toggle Numbering (⌘⇧N)"><span style={{ fontWeight: 700, fontSize: 13 }}>#1</span></button>
          <div className="toolbar-divider" style={{ width: '1px', height: '20px', background: 'var(--border-color)', margin: '0 4px' }}></div>
          <button className="tool-btn" onClick={() => makeList('-')} title="Bullet List"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><circle cx="3.5" cy="6" r="1.2" fill="currentColor"></circle><circle cx="3.5" cy="12" r="1.2" fill="currentColor"></circle><circle cx="3.5" cy="18" r="1.2" fill="currentColor"></circle></svg></button>
          <button className="tool-btn" onClick={() => makeList('+')} title="Numbered List"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="10" y1="6" x2="21" y2="6"></line><line x1="10" y1="12" x2="21" y2="12"></line><line x1="10" y1="18" x2="21" y2="18"></line><text x="2" y="8" fontSize="7" fill="currentColor" stroke="none">1</text><text x="2" y="14" fontSize="7" fill="currentColor" stroke="none">2</text><text x="2" y="20" fontSize="7" fill="currentColor" stroke="none">3</text></svg></button>
          <button className="tool-btn" onClick={insertMultilineEquation} title="Multiline / Aligned Equation"><span style={{ fontWeight: 700, fontSize: 13 }}>≣</span></button>
          <select className="fontsize-select" defaultValue="" onChange={(e) => { setSelectionFontSize(e.target.value); e.target.value = ''; }} title="Font size of selection">
            <option value="" disabled>A↕</option>
            <option value="8">8pt</option>
            <option value="10">10pt</option>
            <option value="11">11pt</option>
            <option value="12">12pt</option>
            <option value="14">14pt</option>
            <option value="17">17pt</option>
            <option value="20">20pt</option>
            <option value="24">24pt</option>
          </select>
          <div className="toolbar-divider" style={{ width: '1px', height: '20px', background: 'var(--border-color)', margin: '0 4px' }}></div>
          <button className="tool-btn" onClick={insertHeading} title="Heading"><b style={{ fontSize: 14 }}>H</b></button>
          <button className="tool-btn" onClick={insertNumberedEquation} title="Numbered Equation"><span style={{ fontStyle: 'italic' }}>f(x)</span></button>
          <button className="tool-btn" onClick={insertTable} title="Table"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="1"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="3" y1="15" x2="21" y2="15"></line><line x1="9" y1="3" x2="9" y2="21"></line></svg></button>
          <button className="tool-btn" onClick={wrapInFigure} title="Wrap selection in a numbered Figure (caption + number)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="14" rx="1"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 13 16 9 5 17"></polyline><line x1="7" y1="21" x2="17" y2="21"></line></svg></button>
          <button className="tool-btn" onClick={() => setShowSymbolPicker(true)} title="Math & Physics Symbols"><b>Ω</b></button>
          <button className="tool-btn" onClick={() => setShowSymbolDraw(true)} title="Draw a symbol → Typst code (experimental)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19l7-7 3 3-7 7-3-3z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path><path d="M2 2l7.586 7.586"></path><circle cx="11" cy="11" r="2"></circle></svg></button>
          <button className="tool-btn" onClick={() => setShowBibManager(true)} title="Citations & Bibliography (DOI/arXiv)"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg></button>
          <button className="tool-btn" onClick={() => setCodeRunner({})} title="Run Code / Live Output"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg></button>
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
                <div className="sidebar-header" style={{ padding: '8px 16px', background: 'var(--panel-bg)', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  FILE TREE
                  <span style={{ display: 'flex', gap: 10 }}>
                    <svg className="tree-action" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ cursor: 'pointer' }} onClick={createNewFile}><title>New file</title><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="12" x2="12" y2="18"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>
                    <svg className="tree-action" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ cursor: 'pointer' }} onClick={createNewFolder}><title>New folder</title><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line></svg>
                    <svg className="tree-action" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ cursor: 'pointer' }} onClick={uploadAsset}><title>Upload file / image</title><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
                  </span>
                </div>
                <div className="file-tree" style={{ flex: 1, overflowY: 'auto' }}>
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
                <div className="sidebar-header" style={{ padding: '8px 16px', background: 'var(--panel-bg)', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                  FILE OUTLINE
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

              <div className="sidebar-section problems-section" style={{ flex: 'none', maxHeight: '38%', display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border-color)' }}>
                <div className="sidebar-header" style={{ padding: '8px 16px', background: 'var(--panel-bg)', fontSize: '0.85rem', fontWeight: 600, color: problems.some(p => p.severity === 'error') ? '#f87171' : 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>PROBLEMS</span>
                  {problems.length > 0 && <span className="problem-badge">{problems.length}</span>}
                </div>
                <div className="problems-list" style={{ overflowY: 'auto', padding: '6px' }}>
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

              <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', color: 'var(--text-muted)' }} onClick={() => setShowAppSettings(true)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
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
        <div className="editor-pane" style={{ width: editorWidth, minWidth: editorWidth, maxWidth: editorWidth, flex: 'none', display: 'flex', flexDirection: 'column' }}>
          <div className="tabs">
            {tabs.map(tab => (
              <div key={tab.path} className={`tab ${activeTabPath === tab.path ? 'active' : ''}`} onClick={() => setActiveTabPath(tab.path)}>
                {tab.path} {tab.isDirty && '*'}
                <button className="tab-close" onClick={(e) => closeTab(e, tab.path)}>×</button>
              </div>
            ))}
          </div>
          <div className="editor-container" style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column' }}>
            {activeTab ? (
              <Editor
                height="100%"
                language={activeTab.path.endsWith('.typ') ? 'typst' : 'plaintext'}
                theme={theme}
                path={activeTab.path}
                value={activeTab.content}
                onChange={handleEditorChange}
                beforeMount={(monacoInstance) => setupTypstLanguage(monacoInstance)}
                onMount={(e, monacoInstance) => {
                  editorRef.current = e;
                  // Ensure our custom themes are applied on the very first paint
                  // (otherwise the editor briefly renders in the default light theme).
                  monacoInstance.editor.setTheme(theme);
                  // Force-disable mouse hover (the options prop alone isn't always
                  // honoured); docs are on right-click instead.
                  e.updateOptions({ hover: { enabled: false } });
                  const m = e.getModel();
                  if (m) { const last = m.getLineCount(); e.setPosition({ lineNumber: last, column: m.getLineMaxColumn(last) }); }
                  // Right-click (or ⌘⇧D) → show Typst documentation for the symbol
                  // under the cursor in a small popup near the cursor.
                  e.addAction({
                    id: 'typst.showDocs',
                    label: 'Show Typst Documentation',
                    contextMenuGroupId: 'navigation',
                    contextMenuOrder: 0.5,
                    keybindings: [monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyMod.Shift | monacoInstance.KeyCode.KeyD],
                    run: (ed: any) => {
                      const pos = ed.getPosition(); const model = ed.getModel();
                      if (!pos || !model) return;
                      const w = model.getWordAtPosition(pos);
                      if (!w) { setDocPopup(null); return; }
                      const line = model.getLineContent(pos.lineNumber);
                      let s = w.startColumn - 1, en = w.endColumn - 1;
                      while (s > 0 && /[\w.-]/.test(line[s - 1])) s--;
                      while (en < line.length && /[\w.-]/.test(line[en])) en++;
                      const full = line.slice(s, en).replace(/^[.-]+|[.-]+$/g, '');
                      const info = lookupTypstDoc(w.word, full);
                      if (!info) { setDocPopup({ notFound: w.word } as any); return; }
                      const vp = ed.getScrolledVisiblePosition(pos);
                      const rect = ed.getDomNode()?.getBoundingClientRect();
                      setDocPopup({ info, x: (rect?.left || 0) + (vp?.left || 0), y: (rect?.top || 0) + (vp?.top || 0) + 22 });
                    },
                  });
                }}
                options={{
                  automaticLayout: true,
                  minimap: { enabled: false },
                  wordWrap: 'on',
                  // Only offer our Typst completions — no generic word/HTML noise.
                  wordBasedSuggestions: 'off',
                  fontSize: editorFontSize,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  padding: { top: 16, bottom: 16 },
                  autoClosingBrackets: 'always',
                  autoClosingQuotes: 'always',
                  bracketPairColorization: { enabled: true },
                  // Docs are shown on right-click ("Show Typst Documentation"),
                  // not on mouse-hover, so the hover popup is disabled.
                  hover: { enabled: false },
                }}
              />
            ) : (
              <div className="empty-state">No file selected</div>
            )}
            {problems.some(p => p.severity === 'error') && (
              <div className="error-banner" onClick={() => { if (!sidebarOpen) setSidebarOpen(true); }} title="See the PROBLEMS panel">
                <b>{problems.filter(p => p.severity === 'error').length} error(s)</b> — {problems.find(p => p.severity === 'error')?.message}
                {problems[0]?.line ? ` (line ${problems.find(p => p.severity === 'error')?.line})` : ''}
              </div>
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
          {pdfUrl ? (
            <PdfPreview url={pdfUrl} onWordClick={jumpToWord} />
          ) : (
            <div className="empty-preview">{isCompiling ? 'Generating PDF...' : 'No preview available'}</div>
          )}
        </div>
      </div>
      
      {showPackageInstaller && <PackageInstaller onClose={() => setShowPackageInstaller(false)} onInsert={(pkg) => {
        if (!editorRef.current) return;
        editorRef.current.executeEdits('packages', [{ range: new monaco!.Range(1, 1, 1, 1), text: `#import "@preview/${pkg.name}:${pkg.version}": *\n`, forceMoveMarkers: true }]);
        setShowPackageInstaller(false);
      }} />}
      {showTemplateInstaller && <TemplateInstaller onClose={() => setShowTemplateInstaller(false)} onInsert={handleInitTemplate} />}
      {showDiagramBuilder && <DiagramBuilder onClose={() => setShowDiagramBuilder(false)} onInsert={(code) => { insertCode(code); setShowDiagramBuilder(false); }} />}
      {showFeynman && <Suspense fallback={null}><FeynmanBuilder onClose={() => setShowFeynman(false)} onInsert={(code) => { insertCode(code); setShowFeynman(false); }} /></Suspense>}
      {showAbout && (
        <div className="modal-overlay" onClick={() => setShowAbout(false)}>
          <div className="modal-content about-modal" onClick={e => e.stopPropagation()}>
            <svg width="52" height="52" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="aboutGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a78bfa"/><stop offset="1" stopColor="#60a5fa"/></linearGradient></defs><path fillRule="evenodd" clipRule="evenodd" fill="url(#aboutGrad)" d="M9.29289 1.29289C9.48043 1.10536 9.73478 1 10 1H18C19.6569 1 21 2.34315 21 4V9C21 9.55228 20.5523 10 20 10C19.4477 10 19 9.55228 19 9V4C19 3.44772 18.5523 3 18 3H11V8C11 8.55228 10.5523 9 10 9H5V20C5 20.5523 5.44772 21 6 21H10C10.5523 21 11 21.4477 11 22C11 22.5523 10.5523 23 10 23H6C4.34315 23 3 21.6569 3 20V8C3 7.73478 3.10536 7.48043 3.29289 7.29289L9.29289 1.29289ZM6.41421 7H9V4.41421L6.41421 7ZM11.2929 10.2929C11.63 9.95583 12.1581 9.90353 12.5547 10.1679C12.7377 10.29 13.138 10.4206 13.8692 10.5557C14.2116 10.619 14.5873 10.6773 15.0006 10.7413L15.0159 10.7436C15.42 10.8062 15.8556 10.8736 16.3008 10.9531C18.0592 11.2671 20.2179 11.8037 21.7071 13.2929C22.907 14.4928 23.2701 15.7765 23.1846 16.8892C23.1413 17.4519 22.9841 17.9568 22.7829 18.3687L23 18.5858C23.781 19.3668 23.781 20.6332 23 21.4142L21.4142 23C20.6332 23.781 19.3668 23.781 18.5858 23L18.3687 22.7829C17.9568 22.9841 17.4519 23.1413 16.8892 23.1846C15.7765 23.2701 14.4928 22.907 13.2929 21.7071C11.8037 20.2179 11.2671 18.0592 10.9531 16.3008C10.8736 15.8556 10.8062 15.42 10.7436 15.0159L10.7413 15.0006C10.6773 14.5873 10.619 14.2116 10.5557 13.8692C10.4206 13.138 10.29 12.7377 10.1679 12.5547C9.90353 12.1581 9.95583 11.63 10.2929 11.2929L10.7926 10.7931L10.7929 10.7929L11.2929 10.2929ZM15.0677 16.482L12.6124 14.0266C12.6482 14.2458 12.683 14.47 12.7177 14.6947L12.7186 14.7006L12.7187 14.7007C12.7821 15.1107 12.8465 15.527 12.9219 15.9492C13.2329 17.6908 13.6963 19.2821 14.7071 20.2929C15.5072 21.093 16.2235 21.2299 16.7358 21.1904C17.3109 21.1462 17.7121 20.8737 17.7929 20.7929C18.1834 20.4024 18.8166 20.4024 19.2071 20.7929L20 21.5858L21.5858 20L20.7929 19.2071C20.6054 19.0196 20.5 18.7652 20.5 18.5C20.5 18.2348 20.6054 17.9804 20.7929 17.7929C20.8737 17.7121 21.1462 17.3109 21.1904 16.7358C21.2299 16.2235 21.093 15.5072 20.2929 14.7071C19.2821 13.6963 17.6908 13.2329 15.9492 12.9219C15.527 12.8465 15.1107 12.7821 14.7007 12.7187L14.7006 12.7186L14.6947 12.7177C14.47 12.683 14.2458 12.6482 14.0266 12.6124L16.482 15.0677C16.6472 15.0236 16.8208 15 17 15C18.1046 15 19 15.8954 19 17C19 18.1046 18.1046 19 17 19C15.8954 19 15 18.1046 15 17C15 16.8208 15.0236 16.6472 15.0677 16.482Z"/></svg>
            <h2 style={{ margin: '10px 0 2px' }}>Typst Editor</h2>
            <div className="about-version">Version {__APP_VERSION__}</div>
            <div className="about-author">Created by <a href="https://rousan.netlify.app/" target="_blank" rel="noreferrer" style={{ color: 'inherit', fontWeight: 600, textDecoration: 'underline', textDecorationColor: 'var(--accent)' }}>Kazi Abu Rousan</a></div>
            <div className="about-links">
              <a href="https://github.com/aburousan/typsteditor" target="_blank" rel="noreferrer">GitHub</a>
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
      {docPopup && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 998 }} onClick={() => setDocPopup(null)} onContextMenu={(e) => { e.preventDefault(); setDocPopup(null); }} />
          <div style={{ position: 'fixed', left: Math.min(('x' in docPopup ? docPopup.x : 0), window.innerWidth - 380), top: 'y' in docPopup ? docPopup.y : 0, zIndex: 999, width: 360, maxHeight: 360, overflow: 'auto', background: 'var(--panel-bg, #1e293b)', color: 'var(--text-color, #e2e8f0)', border: '1px solid var(--border-color, #334155)', borderRadius: 8, boxShadow: '0 8px 30px rgba(0,0,0,0.5)', padding: 14, fontSize: 13 }} onClick={(e) => e.stopPropagation()}>
            {'notFound' in docPopup ? (
              <div style={{ opacity: 0.8 }}>No Typst documentation found for <code>{docPopup.notFound}</code>. Try right-clicking directly on a function name (e.g. <code>figure</code>, <code>table</code>, <code>vec</code>).</div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                  <strong style={{ fontSize: 15 }}>{docPopup.info.key}</strong>
                  {docPopup.info.detail && <span style={{ fontSize: 11, opacity: 0.7, border: '1px solid var(--border-color, #334155)', borderRadius: 4, padding: '1px 6px' }}>{docPopup.info.detail}</span>}
                </div>
                {docPopup.info.doc && <div style={{ lineHeight: 1.5, marginBottom: 8 }}>{docPopup.info.doc}</div>}
                <pre style={{ background: 'var(--bg-color, #0f172a)', borderRadius: 6, padding: '8px 10px', margin: '0 0 10px', overflowX: 'auto', fontSize: 12 }}><code>#{docPopup.info.usage}</code></pre>
                <a href={docPopup.info.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent, #a78bfa)', fontSize: 12 }}>Open Typst documentation ↗</a>
              </>
            )}
          </div>
        </>
      )}
      {inputModal && <InputModal {...inputModal} onClose={() => setInputModal(null)} />}
      {codeRunner && <CodeRunnerModal {...codeRunner} onClose={() => setCodeRunner(null)} onInsert={(code) => { insertCode(code); setCodeRunner(null); }} onInsertEquation={(latex, codeBlock) => { insertEquationFromLatex(latex, codeBlock); setCodeRunner(null); }} onChanged={fetchTree} />}
      {showSaveAs && activeTab && <SaveAsModal onClose={() => setShowSaveAs(false)} fileName={activeTabPath} content={activeTab.content} pdfUrl={pdfUrl} projectName={projectName} mainFile={currentMain} />}
      {showPlot3D && <Suspense fallback={null}><Plot3DStudio onClose={() => setShowPlot3D(false)} onInsert={(code) => { insertCode(code); setShowPlot3D(false); fetchTree(); }} /></Suspense>}
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
                  <div style={{ color: '#94a3b8', fontSize: '13px', textAlign: 'center', marginTop: '20px' }}>No history for this file yet.<br/>Compile to save history.</div>
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
    </div>
  );
}
