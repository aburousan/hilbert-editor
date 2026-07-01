import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Editor, { useMonaco } from '@monaco-editor/react';
import { setupTypstLanguage } from './typstMonaco';
import { PackageInstaller } from './PackageInstaller';
import { TemplateInstaller } from './TemplateInstaller';
import DiagramBuilder from './components/DiagramBuilder';
import FigureBuilder from './components/FigureBuilder';
import EditSettings from './components/EditSettings';
import SymbolPicker from './components/SymbolPicker';
import DriveSyncModal from './components/DriveSyncModal';
import AppSettingsModal from './components/AppSettingsModal';
import InputModal, { type InputModalConfig } from './components/InputModal';
import CodeRunnerModal from './components/CodeRunnerModal';
import SaveAsModal from './components/SaveAsModal';
import PdfPreview from './components/PdfPreview';
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

// Verified Feynman-diagram templates (fletcher). Each is a `diagram(...)` expression.
const FEYNMAN: Record<string, string> = {
  's-channel: e⁻e⁺ → μ⁻μ⁺': `diagram(
    spacing: 2cm,
    node((0, 0), $e^-$),
    node((0, 2), $e^+$),
    node((1, 1), $$, name: <v1>),
    node((2, 1), $$, name: <v2>),
    node((3, 1), $mu^-$),
    node((3, -1), $mu^+$),
    edge((0, 0), <v1>, "-|>"),
    edge((0, 2), <v1>, "<|-"),
    edge(<v1>, <v2>, $gamma$, "wave"),
    edge(<v2>, (3, 1), "-|>"),
    edge(<v2>, (3, -1), "<|-"),
  )`,
  'QED vertex: e⁻ → e⁻ γ': `diagram(
    spacing: 2cm,
    node((0, 0), $e^-$),
    node((1, 0), $$, name: <x>),
    node((2, 0), $e^-$),
    node((1, -1.3), $gamma$),
    edge((0, 0), <x>, "-|>"),
    edge(<x>, (2, 0), "-|>"),
    edge(<x>, (1, -1.3), "wave"),
  )`,
  'Compton: γe⁻ → γe⁻': `diagram(
    spacing: 1.6cm,
    node((0, 2), $gamma$), node((0, 0), $e^-$),
    node((1.5, 1), $$, name: <a>),
    node((3, 1), $$, name: <b>),
    node((4.5, 2), $gamma$), node((4.5, 0), $e^-$),
    edge((0, 0), <a>, "-|>"),
    edge((0, 2), <a>, "wave"),
    edge(<a>, <b>, $e^-$, "-|>"),
    edge(<b>, (4.5, 0), "-|>"),
    edge(<b>, (4.5, 2), "wave"),
  )`,
  'q q̄ → Z′ → b b̄ (math mode)': `diagram(
    mark-scale: 130%,
    $
      edge("rdr", overline(q), "-<|-")
      edge(#(4, 0), #(3.5, 0.5), b, "-<|-")
      edge(#(4, 1), #(3.5, 0.5), overline(b), "-<|-", label-side: #left) \\
      & & edge("d", "-<|-") & & edge(#(3.5, 0.5), #(2, 1), Z', "wave") \\
      & & edge(#(3.5, 2.5), #(2, 2), gamma, "wave") \\
      edge("rru", q, "-|>-") & \\
    $
  )`,
};

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

#import "@preview/cetz:0.3.2"
#import "@preview/physica:0.9.3": *

= Typst with Physics and CeTZ!

This is a local, offline editor for *Typst*. It comes pre-configured with packages!
`;

interface HistoryEntry {
  id: string;
  timestamp: number;
  path: string;
  content: string;
}

export default function App() {
  const editorRef = useRef<any>(null);
  const [tabs, setTabs] = useState<Tab[]>([{ path: 'main.typ', content: DEFAULT_CODE, isDirty: true }]);
  const [activeTabPath, setActiveTabPath] = useState<string>('main.typ');
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [errorLogs, setErrorLogs] = useState<string | null>(null);
  const [theme, setTheme] = useState<'typst-dark' | 'typst-light'>('typst-dark');

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
  const [showFigureBuilder, setShowFigureBuilder] = useState(false);
  const [showEditSettings, setShowEditSettings] = useState(false);
  const [showDriveSync, setShowDriveSync] = useState(false);
  const [showHistoryModal, setShowHistoryModal] = useState(false);
  const [showAppSettings, setShowAppSettings] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('Project Report');
  const [editingTitle, setEditingTitle] = useState(false);
  const [inputModal, setInputModal] = useState<InputModalConfig | null>(null);
  const [codeRunner, setCodeRunner] = useState<null | { initialLang?: 'python' | 'julia' | 'wolfram'; initialCode?: string }>(null);
  const [showSaveAs, setShowSaveAs] = useState(false);
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

  const fetchTree = async () => {
    try {
      const res = await fetch('http://localhost:3001/workspace');
      if (res.ok) setFileTree(await res.json());
    } catch(e) {}
  };


  const compileTypst = useCallback(async (mainFile: string = 'main.typ') => {
    setIsCompiling(true);
    try {
      for (const tab of tabs) {
        if (tab.isDirty || tab.path === mainFile) {
          await fetch(`http://localhost:3001/workspace/file?path=${encodeURIComponent(tab.path)}`, {
            method: 'POST', body: tab.content, headers: { 'Content-Type': 'text/plain' }
          });
        }
      }
      
      const res = await fetch(`http://localhost:3001/compile?main=${encodeURIComponent(mainFile)}`, { method: 'POST' });
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
      await fetch(`http://localhost:3001/workspace/file?path=${encodeURIComponent(activeTab.path)}`, {
        method: 'POST', body: activeTab.content, headers: { 'Content-Type': 'text/plain' }
      });
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
    fetch('http://localhost:3001/webdav/sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, username: localStorage.getItem('webdav_user') || '', password: localStorage.getItem('webdav_pass') || '', projectName })
    }).catch(() => {});
  };

  // Intercept Cmd/Ctrl+S so the browser "Save As" dialog never appears.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        saveActiveFile();
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        toggleNumberingRef.current();
      }
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
      }, hasDirty ? 1000 : 50);
      return () => clearTimeout(timeoutId);
    }
  }, [tabs, compileTypst, currentMain, lastCompiledPath]);

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
        const res = await fetch(`http://localhost:3001/workspace/file?path=${encodeURIComponent(path)}`);
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
      await fetch(`http://localhost:3001/workspace/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
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
    await fetch(`http://localhost:3001/workspace/file?path=${encodeURIComponent(name)}`, { method: 'POST', body: '' });
    fetchTree();
    openFile(name);
  };

  const createNewFolder = async () => {
    const name = prompt('Folder name (e.g. images):', 'images');
    if (!name) return;
    await fetch(`http://localhost:3001/workspace/mkdir?path=${encodeURIComponent(name)}`, { method: 'POST' });
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
      await fetch(`http://localhost:3001/workspace/upload?path=${encodeURIComponent(path)}`, { method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream' } });
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
      await fetch(`http://localhost:3001/workspace/file?path=${encodeURIComponent(name)}`, { method: 'POST', body: text, headers: { 'Content-Type': 'text/plain' } });
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
          await fetch(`http://localhost:3001/workspace/file?path=${encodeURIComponent(rel)}`, { method: 'POST', body: text, headers: { 'Content-Type': 'text/plain' } });
        } else {
          const buf = await f.arrayBuffer();
          await fetch(`http://localhost:3001/workspace/upload?path=${encodeURIComponent(rel)}`, { method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream' } });
        }
      }
      await fetchTree();
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
      await fetch(`http://localhost:3001/workspace/file?path=${encodeURIComponent(name)}`, { method: 'POST', body: text, headers: { 'Content-Type': 'text/plain' } });
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
    // Insert at the live cursor; if none exists yet, append at the end of the file.
    let range = editor.getSelection();
    if (!range) {
      const last = model.getLineCount();
      const col = model.getLineMaxColumn(last);
      range = { startLineNumber: last, startColumn: col, endLineNumber: last, endColumn: col } as any;
    }
    editor.executeEdits('insert', [{ range, text, forceMoveMarkers: true }]);
    editor.focus();
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
    ensureRule('@preview/mitex', '#import "@preview/mitex:0.2.5": mitex');
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
      { key: 'author', label: 'Author(s)', default: 'Kazi Abu Rousan' },
      { key: 'email', label: 'Email', default: 'kaziaburousan@gmail.com' },
      { key: 'institute', label: 'Institute / Affiliation', default: 'University' },
    ],
    onSubmit: (v) => insertAtTop(
`#align(center)[
  #text(17pt, weight: "bold")[${v.title}]

  #v(0.4em)
  ${v.author} \\
  #text(fill: gray)[${v.institute}]${v.email ? ` \\\n  #link("mailto:${v.email}")[${v.email}]` : ''}
]

`)
  });

  const insertAuthor = () => setInputModal({
    title: 'Insert Author',
    fields: [
      { key: 'author', label: 'Author name', default: 'Kazi Abu Rousan' },
      { key: 'email', label: 'Email (optional)', default: 'kaziaburousan@gmail.com' },
    ],
    onSubmit: (v) => insertAtTop(`#align(center)[${v.author}${v.email ? ` \\\n  #link("mailto:${v.email}")[${v.email}]` : ''}]\n`)
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

  const insertMatrix = () => setInputModal({
    title: 'Insert Matrix',
    fields: [
      { key: 'rows', label: 'Rows', type: 'number', default: '2' },
      { key: 'cols', label: 'Columns', type: 'number', default: '2' },
      { key: 'center', label: 'Center on page', type: 'checkbox', default: 'false' },
    ],
    onSubmit: (v) => {
      const r = Math.max(1, parseInt(v.rows) || 1), c = Math.max(1, parseInt(v.cols) || 1);
      let mat = '$ mat(\n';
      for (let i = 0; i < r; i++) mat += '  ' + Array(c).fill('0').join(', ') + (i < r - 1 ? ';' : '') + '\n';
      mat += ') $';
      insertCode(centerWrap(mat, v.center));
    }
  });

  const insertTable = () => setInputModal({
    title: 'Insert Table',
    fields: [
      { key: 'rows', label: 'Rows', type: 'number', default: '2' },
      { key: 'cols', label: 'Columns', type: 'number', default: '2' },
      { key: 'center', label: 'Center on page', type: 'checkbox', default: 'false' },
    ],
    onSubmit: (v) => {
      const r = Math.max(1, parseInt(v.rows) || 1), c = Math.max(1, parseInt(v.cols) || 1);
      let t = `#table(\n  columns: ${c},\n`;
      for (let i = 0; i < r; i++) t += '  ' + Array(c).fill('[]').join(', ') + ',\n';
      t += ')';
      insertCode(centerWrap(t, v.center));
    }
  });

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
      const imp = '#import "@preview/cetz:0.3.2": canvas, draw\n';
      const tag = v.label ? ` <fig:${v.label}>` : '';
      insertCode(`\n${imp}#figure(\n  ${canvas},\n  caption: [${v.caption}],\n)${tag}\n\n`);
    }
  });

  const insertFeynman = () => setInputModal({
    title: 'Insert Feynman Diagram (fletcher)',
    fields: [
      { key: 'template', label: 'Diagram', type: 'select', options: Object.keys(FEYNMAN), default: Object.keys(FEYNMAN)[0] },
      { key: 'caption', label: 'Caption', default: 'Feynman diagram' },
      { key: 'label', label: 'Label (optional)', placeholder: 'feyn1 → @fig:feyn1' },
    ],
    onSubmit: (v) => {
      ensureRule('@preview/fletcher', '#import "@preview/fletcher:0.5.8" as fletcher: diagram, node, edge');
      const tag = v.label ? ` <fig:${v.label}>` : '';
      const code = FEYNMAN[v.template] || FEYNMAN[Object.keys(FEYNMAN)[0]];
      insertCode(`\n#figure(\n  ${code},\n  caption: [${v.caption}],\n)${tag}\n\n`);
    }
  });

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
      { key: 'name', label: 'Name / title (optional)', placeholder: 'e.g. Noether' },
      { key: 'label', label: 'Label (optional)', placeholder: 'noether → @thm:noether' },
      { key: 'body', label: 'Statement', type: 'textarea', default: 'Statement here.' },
    ],
    onSubmit: (v) => {
      ensureSetup('@preview/lemming', THEOREM_SETUP);
      const body = v.body || '';
      if (v.kind === 'proof') { insertCode(`\n#proof[${body}]\n\n`); return; }
      const args = [];
      if (v.name) args.push(`name: "${v.name}"`);
      if (v.label) args.push(`label: <thm:${v.label}>`);
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
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const loc = lines[j].match(/([\w./\-]+):(\d+):(\d+)/);
        if (loc) { prob.file = loc[1]; prob.line = Number(loc[2]); prob.col = Number(loc[3]); break; }
      }
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
  const jumpToWord = (raw: string) => {
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
    const cur = editor.getPosition();
    // Prefer the next match strictly after the cursor, so repeated clicks cycle.
    const next = matches.find((m: any) => !cur || m.range.startLineNumber > cur.lineNumber ||
      (m.range.startLineNumber === cur.lineNumber && m.range.startColumn > cur.column)) || matches[0];
    editor.revealLineInCenter(next.range.startLineNumber);
    editor.setPosition({ lineNumber: next.range.startLineNumber, column: next.range.startColumn });
    editor.focus();
    syncDecorations.current = editor.deltaDecorations(syncDecorations.current, [{ range: next.range, options: { inlineClassName: 'sync-flash' } }]);
    setTimeout(() => { if (editorRef.current) syncDecorations.current = editorRef.current.deltaDecorations(syncDecorations.current, []); }, 1300);
  };

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

  return (
    <div className="app-container" onClick={() => setActiveMenu(null)}>
      <header className="header">
        <div className="header-left">
          <div className="logo" style={{ fontSize: '0.9rem', gap: '4px' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="logoGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a78bfa"/><stop offset="1" stopColor="#60a5fa"/></linearGradient></defs><path fillRule="evenodd" clipRule="evenodd" fill="url(#logoGrad)" d="M9.29289 1.29289C9.48043 1.10536 9.73478 1 10 1H18C19.6569 1 21 2.34315 21 4V9C21 9.55228 20.5523 10 20 10C19.4477 10 19 9.55228 19 9V4C19 3.44772 18.5523 3 18 3H11V8C11 8.55228 10.5523 9 10 9H5V20C5 20.5523 5.44772 21 6 21H10C10.5523 21 11 21.4477 11 22C11 22.5523 10.5523 23 10 23H6C4.34315 23 3 21.6569 3 20V8C3 7.73478 3.10536 7.48043 3.29289 7.29289L9.29289 1.29289ZM6.41421 7H9V4.41421L6.41421 7ZM11.2929 10.2929C11.63 9.95583 12.1581 9.90353 12.5547 10.1679C12.7377 10.29 13.138 10.4206 13.8692 10.5557C14.2116 10.619 14.5873 10.6773 15.0006 10.7413L15.0159 10.7436C15.42 10.8062 15.8556 10.8736 16.3008 10.9531C18.0592 11.2671 20.2179 11.8037 21.7071 13.2929C22.907 14.4928 23.2701 15.7765 23.1846 16.8892C23.1413 17.4519 22.9841 17.9568 22.7829 18.3687L23 18.5858C23.781 19.3668 23.781 20.6332 23 21.4142L21.4142 23C20.6332 23.781 19.3668 23.781 18.5858 23L18.3687 22.7829C17.9568 22.9841 17.4519 23.1413 16.8892 23.1846C15.7765 23.2701 14.4928 22.907 13.2929 21.7071C11.8037 20.2179 11.2671 18.0592 10.9531 16.3008C10.8736 15.8556 10.8062 15.42 10.7436 15.0159L10.7413 15.0006C10.6773 14.5873 10.619 14.2116 10.5557 13.8692C10.4206 13.138 10.29 12.7377 10.1679 12.5547C9.90353 12.1581 9.95583 11.63 10.2929 11.2929L10.7926 10.7931L10.7929 10.7929L11.2929 10.2929ZM15.0677 16.482L12.6124 14.0266C12.6482 14.2458 12.683 14.47 12.7177 14.6947L12.7186 14.7006L12.7187 14.7007C12.7821 15.1107 12.8465 15.527 12.9219 15.9492C13.2329 17.6908 13.6963 19.2821 14.7071 20.2929C15.5072 21.093 16.2235 21.2299 16.7358 21.1904C17.3109 21.1462 17.7121 20.8737 17.7929 20.7929C18.1834 20.4024 18.8166 20.4024 19.2071 20.7929L20 21.5858L21.5858 20L20.7929 19.2071C20.6054 19.0196 20.5 18.7652 20.5 18.5C20.5 18.2348 20.6054 17.9804 20.7929 17.7929C20.8737 17.7121 21.1462 17.3109 21.1904 16.7358C21.2299 16.2235 21.093 15.5072 20.2929 14.7071C19.2821 13.6963 17.6908 13.2329 15.9492 12.9219C15.527 12.8465 15.1107 12.7821 14.7007 12.7187L14.7006 12.7186L14.6947 12.7177C14.47 12.683 14.2458 12.6482 14.0266 12.6124L16.482 15.0677C16.6472 15.0236 16.8208 15 17 15C18.1046 15 19 15.8954 19 17C19 18.1046 18.1046 19 17 19C15.8954 19 15 18.1046 15 17C15 16.8208 15.0236 16.6472 15.0677 16.482Z"/></svg>
            TypstEditor
          </div>
          <div className="menu-bar">
            <div className="menu-item" onClick={(e) => toggleMenu(e, 'file')}>
              File
              {activeMenu === 'file' && (
                <div className="dropdown">
                  <div className="dropdown-item" onClick={createNewFile}>New File...</div>
                  <div className="dropdown-item" onClick={() => { openFromDisk(); setActiveMenu(null); }}>Open File...</div>
                  <div className="dropdown-item" onClick={() => { openFolderFromDisk(); setActiveMenu(null); }}>Open Folder...</div>
                  <div className="dropdown-item" onClick={() => setShowTemplateInstaller(true)}>New from Template...</div>
                  <div className="dropdown-divider"></div>
                  <div className="dropdown-item" onClick={() => { saveActiveFile(); setActiveMenu(null); }}>Save <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘S</span></div>
                  <div className="dropdown-item" onClick={() => { setShowSaveAs(true); setActiveMenu(null); }}>Save As / Export...</div>
                </div>
              )}
            </div>
            <div className="menu-item" onClick={(e) => toggleMenu(e, 'edit')}>
              Edit
              {activeMenu === 'edit' && (
                <div className="dropdown">
                  <div className="dropdown-item" onClick={() => { editorRef.current?.trigger('menu', 'undo', null); setActiveMenu(null); }}>Undo</div>
                  <div className="dropdown-item" onClick={() => { editorRef.current?.trigger('menu', 'redo', null); setActiveMenu(null); }}>Redo</div>
                  <div className="dropdown-divider"></div>
                  <div className="dropdown-item" onClick={() => { editorRef.current?.getAction('actions.find')?.run(); setActiveMenu(null); }}>Find...</div>
                  <div className="dropdown-item" onClick={() => { editorRef.current?.getAction('editor.action.startFindReplaceAction')?.run(); setActiveMenu(null); }}>Find &amp; Replace...</div>
                  <div className="dropdown-divider"></div>
                  <div className="dropdown-item" onClick={() => { toggleNumbering(); setActiveMenu(null); }}>Toggle Numbering <span style={{ marginLeft: 'auto', opacity: 0.5, fontSize: '0.75rem' }}>⌘⇧N</span></div>
                  <div className="dropdown-item" onClick={() => { setShowEditSettings(true); setActiveMenu(null); }}>Document Settings...</div>
                </div>
              )}
            </div>
            <div className="menu-item" onClick={(e) => toggleMenu(e, 'insert')}>
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
                      <div className="dropdown-item" onClick={() => { wrapSelection('$', '$'); setActiveMenu(null); }}>Inline Equation</div>
                      <div className="dropdown-item" onClick={() => { insertCode('\n$ E = m c^2 $\n\n'); setActiveMenu(null); }}>Block Equation</div>
                      <div className="dropdown-item" onClick={() => { insertMultilineEquation(); setActiveMenu(null); }}>Multiline / Aligned Equation</div>
                      <div className="dropdown-item" onClick={() => { insertNumberedEquation(); setActiveMenu(null); }}>Numbered Equation...</div>
                      <div className="dropdown-item" onClick={() => { insertMatrix(); setActiveMenu(null); }}>Matrix...</div>
                      <div className="dropdown-item" onClick={() => { setShowSymbolPicker(true); setActiveMenu(null); }}>Math &amp; Physics Symbols...</div>
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
                      <div className="dropdown-item" onClick={() => { insertFeynman(); setActiveMenu(null); }}>Feynman Diagram (fletcher)...</div>
                    </div>
                  </div>
                  <div className="dropdown-item has-submenu">
                    <span>Compute</span><span className="submenu-arrow">›</span>
                    <div className="submenu">
                      <div className="dropdown-item" onClick={() => { setCodeRunner({ initialLang: 'python' }); setActiveMenu(null); }}>Run Python...</div>
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
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="menu-item" onClick={(e) => toggleMenu(e, 'packages')}>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', opacity: 0.8 }} onClick={() => setTheme(t => t === 'typst-dark' ? 'typst-light' : 'typst-dark')} title="Toggle Editor Theme">
            {theme === 'typst-dark' ? '🌙 Dark' : '☀️ Light'}
          </div>
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
          <button className="tool-btn" onClick={() => wrapSelection('#text(fill: red)[', ']')} title="Text Color"><span style={{color:'#ef4444'}}>A</span></button>
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
                  const m = e.getModel();
                  if (m) { const last = m.getLineCount(); e.setPosition({ lineNumber: last, column: m.getLineMaxColumn(last) }); }
                }}
                options={{
                  automaticLayout: true,
                  minimap: { enabled: false },
                  wordWrap: 'on',
                  fontSize: 14,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  padding: { top: 16, bottom: 16 },
                  autoClosingBrackets: 'always',
                  autoClosingQuotes: 'always',
                  bracketPairColorization: { enabled: true }
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
      {showFigureBuilder && <FigureBuilder onClose={() => setShowFigureBuilder(false)} onInsert={(code) => { insertCode(code); setShowFigureBuilder(false); }} />}
      {showEditSettings && <EditSettings onClose={() => setShowEditSettings(false)} editorRef={editorRef} monaco={monaco} />}
      {showDriveSync && <DriveSyncModal onClose={() => setShowDriveSync(false)} projectName={projectName} />}
      {showAppSettings && <AppSettingsModal onClose={() => setShowAppSettings(false)} />}
      {inputModal && <InputModal {...inputModal} onClose={() => setInputModal(null)} />}
      {codeRunner && <CodeRunnerModal {...codeRunner} onClose={() => setCodeRunner(null)} onInsert={(code) => { insertCode(code); setCodeRunner(null); }} onInsertEquation={(latex, codeBlock) => { insertEquationFromLatex(latex, codeBlock); setCodeRunner(null); }} onChanged={fetchTree} />}
      {showSaveAs && activeTab && <SaveAsModal onClose={() => setShowSaveAs(false)} fileName={activeTabPath} content={activeTab.content} pdfUrl={pdfUrl} projectName={projectName} mainFile={currentMain} />}
      
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
