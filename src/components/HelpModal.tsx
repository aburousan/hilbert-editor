import { useMemo, useState } from 'react';

type Feature = {
  title: string;
  where: string;      // how to reach it in the UI
  desc: string;
  keys?: string;      // keyboard shortcut
};

type Section = { name: string; features: Feature[] };

const SECTIONS: Section[] = [
  {
    name: 'Writing & Editing',
    features: [
      { title: 'Command Palette', where: 'Edit menu, or anywhere', keys: '⌘K', desc: 'Search and run every command in the app — inserts, tools, export, settings — without hunting through menus.' },
      { title: 'Live preview', where: 'Right pane', desc: 'The PDF recompiles as you type. On errors the last good preview stays visible; errors go to the Problems tab instead of taking over.' },
      { title: 'Find & Replace', where: 'Edit menu', keys: '⌘F', desc: 'Monaco search with regex and replace-all across the open file.' },
      { title: 'Typst code intelligence', where: 'Edit menu / editor context menu', keys: 'F2', desc: 'Tinymist-powered go to definition, find references, symbol rename, quick fixes and whole-document formatting with the bundled typstyle formatter.' },
      { title: 'External-change protection', where: 'Automatic', desc: 'Reloads clean files changed by Git or another editor. If you have unsaved edits, Hilbert shows both versions and waits for you to choose.' },
      { title: 'Formatting', where: 'Formatting menu / toolbar', keys: '⌘B · ⌘I', desc: 'Bold, italic, underline, sub/superscript, small caps, colours, highlights, alignment, rotation, letter spacing, boxes.' },
      { title: 'Spelling & grammar', where: 'Tick icon in the header', desc: 'Offline proofreading (Nuspell + Harper). Squiggles in the editor, an issues panel in the sidebar, one-click fixes, personal dictionary.' },
      { title: 'Version history', where: 'Clock icon in the header', desc: 'Snapshots of your file as you work — restore any earlier version.' },
      { title: 'Comment lines', where: 'Edit menu, or the command palette', keys: '⌘/ · Ctrl+/', desc: 'Comment or uncomment the current line, or every line in the selection. Uses the comment syntax of the file you are in — // in Typst, # in Python and Julia, % in a .bib.' },
      { title: 'Show / hide panels', where: 'View menu, or the status bar', desc: 'Switch the file tree, outline, problems, editor and PDF preview on and off — hide the editor to read, hide the preview to write. Your layout is remembered.' },
      { title: 'New window', where: 'File menu, or the command palette', desc: 'Open a second, independent Hilbert window so you can work on two projects at once. Each window has its own preview and its own state; open the other project with File → Open Folder.' },
      { title: 'Click-to-source', where: 'PDF preview', desc: 'Click anywhere in the rendered PDF to jump to the matching line in the source, and back.' },
      { title: 'Zoom the preview', where: 'PDF preview', keys: '⌘/Ctrl + scroll', desc: 'Hold Ctrl (⌘ on macOS) and scroll — or pinch on a trackpad — to zoom around the pointer. The toolbar’s +/−, a zoom menu and Fit width are still there.' },
    ],
  },
  {
    name: 'Mathematics',
    features: [
      { title: 'Equations', where: 'Insert → Math', keys: '⌘E · ⌘⇧E', desc: 'Inline, block, multiline/aligned and numbered equations; toggle numbering per equation or document-wide.' },
      { title: 'Equation templates', where: 'Insert → Math', keys: '⌘⇧G', desc: 'A gallery of ready-made structures — integrals, sums, derivatives, brackets — inserted as editable Typst.' },
      { title: 'Physics notation (physica)', where: 'Insert → Math → Insert Physics', desc: 'Derivatives, tensors, bra–ket, isotopes, Taylor terms and more, powered by the physica package.' },
      { title: 'Matrix Studio', where: 'Insert → Math', keys: '⌘⇧M', desc: 'Visual matrix builder: fill cells, add augmentation lines and borders, get clean Typst array code.' },
      { title: 'Symbols', where: 'Insert → Math', keys: '⌘⇧P', desc: 'Searchable maths & physics symbol picker. Or draw a symbol with the mouse and let the app find it (⌘⇧Y).' },
      { title: 'Compute selection', where: 'Insert → Math', keys: '⌘⇧U', desc: 'Select an expression and simplify or solve it in place using a computer algebra backend.' },
    ],
  },
  {
    name: 'Figures & Diagrams',
    features: [
      { title: 'Feynman diagrams', where: 'Insert → Plots', keys: '⌘⇧F', desc: 'Visual builder: propagators (fermion, photon, gluon, scalar, ghost…), loops with fermion-flow arrows, vertices, labels — emits editable cetz code.' },
      { title: 'Plot Studio', where: 'Insert → Plots', desc: '2D function plots, data plots from CSV, and 3D surfaces (rendered via Python when available).' },
      { title: 'cetz canvas', where: 'Insert → Plots', desc: 'Free-form shapes, grids and data curves on a canvas; pick X/Y columns straight from an imported data file.' },
      { title: 'Commutative diagrams', where: 'Insert → Plots', desc: 'The quiver editor, embedded — build arrow diagrams visually.' },
      { title: 'Flowcharts', where: 'Insert → Compute', keys: '⌘⇧L', desc: 'Draw a flowchart and get runnable code logic from it, or a fletcher flow diagram for the document.' },
      { title: 'Whiteboard sketches', where: 'Insert → Media', desc: 'An Excalidraw board inside the app — sketch freely, insert as a figure.' },
      { title: 'Images & figures', where: 'Insert → Media, or drag & drop', desc: 'Drop files into the file tree, wrap images in captioned figures, place them floating or wrapped by text, build subfigures.' },
    ],
  },
  {
    name: 'Data & Code',
    features: [
      { title: 'Run Notebook', where: 'Toolbar </> button', desc: 'Executes every ```python / ```julia block in the document as one session — variables persist between cells, output and plots appear below each block, with the language logo beside the code in the PDF.' },
      { title: 'Code runner', where: 'Insert → Compute', keys: '⌘⇧K', desc: 'Scratchpad for Python, Julia and Wolfram with live output; insert results or plots into the document.' },
      { title: 'Interpreter picker', where: 'Code runner → dropdown', desc: 'Choose which Python/Julia/conda environment runs your code; the notebook uses the same choice.' },
      { title: 'Data import', where: 'Insert → Media → Import Data', desc: 'CSV, TSV or Excel — preview the sheet, then insert as a Typst table, a line plot with chosen columns, or a variable.' },
      { title: 'Sandboxed execution', where: 'Automatic', desc: 'User code runs with OS resource limits (file size, CPU) and capped output, so a runaway cell can’t take the app down.' },
    ],
  },
  {
    name: 'References & Bibliography',
    features: [
      { title: 'Citations by DOI / arXiv', where: 'Insert → References', desc: 'Paste a DOI or arXiv ID and the entry is fetched and added to your bibliography.' },
      { title: 'Label & reference manager', where: 'Insert → References', desc: 'See every label in the project and insert cross-references without remembering names.' },
      { title: 'File outline', where: 'Sidebar', desc: 'Headings, figures and labels of the current file, clickable.' },
    ],
  },
  {
    name: 'Projects & Sharing',
    features: [
      { title: 'Open any folder', where: 'File → Open Folder', desc: 'Point the app at a folder on disk and it becomes the workspace — multi-file projects with #include work via the project root.' },
      { title: 'Templates', where: 'File → New from Template', desc: 'Start from built-in paper/thesis/notes layouts or install templates from Typst Universe.' },
      { title: 'Packages', where: 'Packages menu', desc: 'Search and install Typst Universe packages; imports download automatically on compile too.' },
      { title: 'Git & GitHub', where: 'Settings → Git & GitHub', desc: 'Version-control the workspace locally, commit, and push to GitHub with a personal access token (used once per push, never stored).' },
      { title: 'Export', where: 'File → Save As / Export', desc: 'PDF (combined PDF/UA and PDF/A standards, accessibility preflight, tagging, page ranges), PNG, SVG, HTML, experimental multi-file bundle, plain .typ, or the whole project folder.' },
      { title: 'HTML preview', where: 'View → HTML Preview', desc: 'Experimental Typst HTML/MathML preview, capability-gated by the installed Typst compiler.' },
      { title: 'Folder sync', where: 'Share button', desc: 'Mirror the project into a synced folder (Google Drive, Dropbox…) or a WebDAV server (Nextcloud).' },
      { title: 'Custom fonts', where: 'File → Import Font', desc: 'Import .ttf/.otf files and use them with #set text(font: "…").' },
    ],
  },
];

export default function HelpModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS;
    return SECTIONS
      .map(s => ({
        ...s,
        features: s.features.filter(f =>
          `${f.title} ${f.desc} ${f.where} ${f.keys || ''}`.toLowerCase().includes(q)),
      }))
      .filter(s => s.features.length > 0);
  }, [query]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: 720, maxWidth: '94vw' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Features &amp; Help</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '70vh' }}>
          <input
            autoFocus
            placeholder="Search features… (e.g. feynman, export, notebook)"
            value={query}
            onChange={e => setQuery(e.target.value)}
            spellCheck={false}
          />
          <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18, paddingRight: 4 }}>
            {shown.map(s => (
              <div key={s.name}>
                <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>{s.name}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {s.features.map(f => (
                    <div key={f.title} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
                      <div style={{ flex: '0 0 190px' }}>
                        <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{f.title}</div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--accent-hover)' }}>{f.where}{f.keys ? ` · ${f.keys}` : ''}</div>
                      </div>
                      <div style={{ flex: 1, fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>{f.desc}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {shown.length === 0 && <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>Nothing matches “{query}”.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
