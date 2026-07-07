# Hilbert — an unofficial scientific-writing IDE for Typst

> **Unofficial.** Hilbert is an independent, community-built application. It is not
> the Typst web app, IDE, or compiler, and is not affiliated with or endorsed by
> the Typst team. "Typst" is a trademark of its respective owners; this project
> merely builds on top of the open-source Typst compiler.

> **🔄 Automatic updates:** the **[Tauri build](https://github.com/aburousan/hilbert-editor/releases/latest)**
> updates itself — install it once and every future version arrives on its own (it
> asks before installing). This only works if you install *that* build, so grab it
> from the [latest release](https://github.com/aburousan/hilbert-editor/releases/latest).
> The Electron build and older versions don't auto-update. *(On Linux, the
> **AppImage** auto-updates; the `.deb` does not.)*

It started as "an offline, Overleaf-feeling place to write physics and maths." It
has grown into a full **scientific-writing IDE**: a real code editor on the left, a
live PDF on the right, and everything in between — equations, matrices, plots,
diagrams, theorems, citations, and *running code* — one click away instead of
memorised. It runs entirely on your machine, works offline, and can execute your
Python / Julia / Wolfram snippets and drop the result straight into the document.

![Hilbert](docs/screenshot.png)

---

## Contents

- [Why you'll like it](#why-youll-like-it)
- [Feature tour (with demos)](#feature-tour)
- [Everything in the box](#everything-in-the-box) — the exhaustive list
- [What you need](#what-you-need)
- [Get it — downloads & install](#get-it)
- [Run from source](#run-from-source)
- [Tips](#a-few-tips) · [Troubleshooting](#troubleshooting) · [Configuration](#configuration) · [Security](#security-model)
- [What's next](#whats-next)

---

## Why you'll like it

- **It feels instant.** The PDF re-renders as you type; the editor is Monaco (the
  one that powers VS Code) with real Typst hover-docs and autocomplete; the whole
  app is ready in well under a second.
- **The fiddly stuff is one click.** Equations, matrices, tables, figures, theorem
  boxes, citations by DOI/arXiv, 2D/3D plots, commutative and Feynman diagrams —
  all visual, all producing clean, editable Typst you own.
- **It does the maths for you.** Run Python / Julia / Wolfram and drop the result in
  as a typeset equation, or select an expression and simplify / solve / integrate it.
- **It's a real project workspace.** Open any folder like VS Code, multi-file
  documents with `#include`d chapters, drag-and-drop file tree, full-text search.
- **It's genuinely light.** The Tauri build starts at ~12 MB of memory and installs
  in under 9 MB — a fraction of a typical Electron editor
  ([benchmarks](docs/PERFORMANCE.md)).
- **It stays out of your way.** Offline by default, auto-updating, crash-isolated
  (an error in one tool never blanks the editor), and it never flashes a console
  window on Windows.

---

## Feature tour

**Live PDF preview that recompiles as you type** — with zoom / fit-to-width and a
dark mode. Double-click any word in the PDF to jump to it in the source.

![Live preview](docs/gifs/live-preview.gif)

**Plot Studio — one tool for every plot.** 2D functions (`y=f(x)`, implicit,
parametric), 2D data (line / scatter / bar), 3D surfaces, plus one-click launch into
the interactive 3D studio and the Python/matplotlib runner. Emits `cetz` / `cetz-plot`.

![Plot Studio](docs/plot-studio.png)

**cetz Canvas — draw diagrams visually.** Click shapes from a palette onto a **live
preview**, then set each one's position, size, rotation and colour. No blind coordinates.

![cetz Canvas](docs/gifs/cetz-canvas.gif)

**Commutative diagrams** drawn in a bundled, offline copy of
[quiver](https://github.com/varkor/quiver) → editable `fletcher` code.

![Commutative diagram with quiver](docs/gifs/quiver-diagram.gif)

**Run Python / Julia / Wolfram → insert the result** as text, a figure, or a typeset
equation.

![Run code → equation](docs/gifs/run-code-equation.gif)

**Colour anything** with a draggable colour-grid picker.

![Text colour picker](docs/gifs/text-colour.gif)

**Sketch a symbol** and get its Typst code (experimental).

![Draw a symbol](docs/gifs/draw-symbol.gif)

**Cite by DOI or arXiv id** — looks the paper up, saves it to `refs.bib`, cites it.

![Citations](docs/gifs/citations.gif)

**Browse Typst Universe templates** with a rendered preview.

![Template preview](docs/gifs/template-preview.gif)

**Toggle a dark PDF preview** (like Overleaf).

![Dark PDF](docs/gifs/dark-pdf.gif)

### More visual builders

**Feynman diagrams** — fermion / photon / gluon / scalar / ghost propagators, loops,
hatched or shaded blobs, vertices and labels → editable `cetz`.

![Feynman diagram builder](docs/feynman-builder.png)

**Matrix Studio** — a visual grid with fills, borders, brackets and a code-array mode.

![Matrix Studio](docs/matrix-studio.png)

**3D Plot Studio** — rotate a surface to the exact angle you want, then insert that view.

![3D Plot Studio](docs/plot3d-studio.png)

**Flowchart → Code** — draw the logic; it writes the `while`, `if` and `for`.

![Flowchart to code](docs/flowchart-code.png)

> Everything happens on your computer. A tiny local server drives the Typst
> compiler and (optional) code execution — nothing leaves the machine unless you
> deliberately turn on Google Drive or WebDAV sync.

---

## Everything in the box

The exhaustive list, grouped by what you're doing.

### Editing & preview
- **Monaco editor** with Typst highlighting, plus **hover documentation and smart
  autocomplete** powered by [tinymist](https://github.com/Myriad-Dreamin/tinymist)
  (hover any function for its signature/docs; completions for every builtin, package
  export and label). Plus **`@`-reference autocomplete** and **image-path
  autocomplete** inside `image("…")`.
- **Live PDF preview** that recompiles as you type, with zoom / fit-to-width, a **dark
  PDF mode**, and **double-click-to-source** (uses surrounding words to land on the
  right occurrence).
- **Multi-file projects.** The preview compiles the project **root** (`main.typ` or the
  `typst.toml` entrypoint), so `#include`d chapters that share a bibliography or labels
  render as a whole. The root shows a **MAIN** badge; right-click any `.typ` → **Set as
  main file** to change it.
- A clickable **Problems** panel, a **File Outline**, resizable panes, and a **live word
  count of the rendered document** (read from the PDF, so `#set`/`#import`/markup don't
  inflate it).
- Control-flow completions that offer **both `{ }` code and `[ ]` content bodies** for
  `if` / `for` / `while`.

### Project & file management (VS Code-style)
- **Open Folder** — make any folder on disk the workspace (edits save straight back on
  the desktop app and in Chrome/Edge), with **File → Open Recent**.
- **File tree**: multi-select, **drag-and-drop move**, rename, duplicate, delete, cut /
  copy / paste, a **right-click context menu**, new file / folder (styled in-app
  dialogs), image/asset upload, **compress to `.zip`**, and reveal-in-file-manager.
- **Full-text search** across the workspace with jump-to-line.

### Inserting the annoying stuff
- Title blocks, headings, abstracts, authors, institutes.
- Inline / block / aligned / **numbered** equations (numbering on by default; toggle
  under the cursor with **⌘⇧N**).
- **Matrices** (visual Matrix Studio), **tables**, **figures**, **images**, **lists** —
  most with a *center on page* toggle.
- **Page Setup builder** (Formatting → Page Setup): paper size, per-side margins,
  header/footer and page numbers → writes the `#set page(...)` rule.
- **Text formatting**: bold / italic / super- / subscript, a draggable **colour
  picker**, underline, highlight, strike-through, boxed selections (fill / border /
  texture), font-size dropdown, alignment, rotation, small caps.
- **Cross-references** — add a label (`= Intro <sec:intro>`), type `@`, pick it.
- **Image editor** — crop / rotate raster images (PNG/JPG) before inserting; SVGs open
  as a safe preview.

### Maths & physics
- A **maths & physics symbol picker** (`physica`), and — *experimental* — a
  **draw-a-symbol** pad.
- **Theorems / proofs / lemmas** — plain or in coloured boxes, each kind numbered.
- A **Physics & Cosmology menu** of ready-made, compile-checked equations — bra–kets,
  commutators, the Dirac / Klein–Gordon equations, the QED Lagrangian, Einstein's field
  equations, Christoffel symbols, the FRW metric, the Friedmann equations, and more.
- An **equation gallery** of fill-in templates.

### Plots & diagrams
- **Plot Studio** — the unified plotting tool: 2D functions (explicit / implicit /
  parametric), 2D data (line / scatter / bar), 3D `cetz` surfaces, plus launchers for
  the interactive 3D studio and the Python/matplotlib runner.
- **cetz Canvas** — a visual shape builder: 13 primitives (circle, ellipse, rectangle,
  triangle, hexagon, line, arrow, arc, curve, grid, point, axes, label) with a **live
  preview** and per-shape position, size (grid range / radius / length), rotation and
  colour.
- **3D Plot Studio** — an interactive surface you rotate, then *insert exactly that view*.
- **Commutative diagrams** via bundled offline [quiver](https://github.com/varkor/quiver)
  → editable `fletcher`.
- **Feynman diagrams** drawn visually → editable `cetz`.
- **Flowchart → Code** — draw logic, get `while` / `if` / `for`.
- 2D plotting via `cetz` + `cetz-plot`.

### Maths that computes
- **Run code → insert result** (Python / Julia / Wolfram): take the text output, a
  generated figure, or — in *equation mode* — write plain maths like `diff(sin(x**2), x)`
  and get a typeset equation back automatically.
- **Compute on a selection**: highlight an expression and simplify / solve /
  differentiate / integrate / evaluate it with sympy, dropped back in as an equation.
- **Ready-made physics examples** in the runner: **General Relativity with
  [xAct](http://www.xact.es/)** (Schwarzschild curvature → Ricci tensor and the
  Kretschmann scalar), **Penrose (conformal) diagrams**, and **Clebsch–Gordan /
  Wigner 3-j coefficients** — as a rendered image or a typeset equation.

### References & bibliography
- A **reference & label manager** listing every label and `@reference`, flagging
  undefined / duplicate / unused ones.
- A **citation manager**: look a paper up by **DOI or arXiv id**, save it to `refs.bib`,
  cite it with `@key` (the bibliography section is added for you).

### Getting things in and out
- Import data (**CSV / JSON / YAML / TOML**) with the matching Typst reader wired up.
- **Import your own fonts** (`.ttf` / `.otf`) via File → Import Font.
- **Templates** from Typst Universe with a rendered preview.
- **Git** (init / commit / push to GitHub).
- **Export** to PDF, HTML, `.typ`, a local folder, **Google Drive**, or **WebDAV**
  (Nextcloud / ownCloud).
- **Manage installed Typst packages** — search, download, remove.

### Reliability & platform
- **Auto-updater** (Tauri build) — checks on launch, **asks before installing**, and is
  best-effort: if the check can't run, the app still starts normally.
- **Crash isolation** — heavy tools (3D studio, Plot Studio, whiteboard, code runner)
  are sandboxed so an error shows a dismissible message instead of blanking the editor.
- A failed compile keeps your last good preview; on **Windows**, background tools never
  flash a console window; the backend survives a misbehaving tool.
- **Offline** — bundled Typst packages are cached locally, so documents compile with no
  network and no downloads.

---

## What you need

Hilbert drives external tools rather than reimplementing them, so a couple of things
must be on your `PATH`:

- **[Typst CLI](https://github.com/typst/typst) 0.14 or newer** — required for
  compiling. `brew install typst`, `winget install Typst.Typst`, `cargo install
  typst-cli`, or a release binary. Verify with `typst --version`.
- Optional but recommended — **[tinymist](https://github.com/Myriad-Dreamin/tinymist)**,
  the Typst language server, for hover docs + smart autocomplete:
  - **macOS:** `brew install tinymist`
  - **Windows:** `winget install Myriad-Dreamin.tinymist` (or `scoop install tinymist`)
  - **Linux / any OS with Rust:** `cargo install tinymist`
  Without it the editor still works fully; those two features just stay quiet.
- Optional, only for **running code**:
  - **Python 3** with `numpy`, `matplotlib`, `sympy`
  - **Julia** (`Latexify` for equation mode)
  - **WolframScript**
- **Node.js 18+** — only if you run from source.

---

## Get it

Prebuilt installers are on the [**Releases**](https://github.com/aburousan/hilbert-editor/releases)
page. **Two editions:**

- **Tauri** (recommended) — tiny (~9 MB) and light on memory, and it **auto-updates**.
- **Electron** — the reference build; heavier, no auto-update.

| Platform | Tauri | Electron |
| --- | --- | --- |
| **Windows** | `.exe` / `.msi` | — |
| **macOS — Apple Silicon** | `…-macOS-arm64.dmg` | `…-macOS-arm64.dmg` |
| **macOS — Intel** | `…-macOS-x64.dmg` | — |
| **Linux** | `.AppImage` (auto-updates) / `.deb` | `.AppImage` |

On a Mac, pick **Apple Silicon** for M-series chips and **Intel** for older Macs
(*About This Mac* tells you which). The desktop app still needs the **Typst CLI** on
your `PATH`.

> **macOS — first launch.** The app isn't notarised (no paid Apple developer account),
> so macOS quarantines it, and renaming/moving the `.app` can break its ad-hoc
> signature. If it won't open or says it's *"damaged"*, run these two commands once:
> ```bash
> xattr -cr "/Applications/Hilbert.app"
> codesign --force --deep --sign - "/Applications/Hilbert.app"
> ```
> *(Adjust the path if the app is elsewhere, e.g. `~/Downloads`.)* The code is open —
> you can audit or build it yourself. This is a one-time step.

### Windows
Download the **`.exe`** (or `.msi`) from Releases and run it. It behaves like a normal
Windows app — launching tools never flashes a console window, and a failed compile
shows an error panel instead of closing. You still need the **Typst CLI** on `PATH`.

### Docker (bundles Typst + Python)
```bash
docker build -t hilbert .
docker run --rm -p 127.0.0.1:3001:3001 -v "$PWD/workspace:/app/workspace" hilbert
# open http://localhost:3001
```
The image ships the Typst CLI and a Python stack. Keep the port on `127.0.0.1` only.

---

## Run from source

```bash
git clone https://github.com/aburousan/hilbert-editor.git
cd hilbert-editor
bash scripts/setup.sh   # installs Typst + Python deps and runs npm install (macOS/Linux)
npm run dev             # Vite UI on http://localhost:5173, backend on http://127.0.0.1:3001
```
If you already have the tools, `npm install && npm run dev` is enough. To build a
desktop installer yourself: `npm run dist` (Electron → `release/`) or, in
`../typst-editor-tauri`, `cargo tauri build` (Tauri).

On **Windows**, run from source with:
```powershell
winget install Typst.Typst
git clone https://github.com/aburousan/hilbert-editor.git
cd hilbert-editor ; npm install ; npm run dev   # then open http://localhost:5173
```

---

## A few tips

- **Compile**: edits recompile after a short pause; **⌘S** saves + recompiles now.
- **Numbering**: put the cursor on a heading or block equation and press **⌘⇧N**.
- **Cross-references**: add a label (`= Intro <sec:intro>`), then type `@` and pick it.
- **Cite a paper**: Insert → References → Citations, look it up by DOI/arXiv, hit **Cite**.
- **Plots**: Insert → Plots → **Plot Studio** for everything, or **cetz Canvas** for
  free-form diagrams.
- **Compute**: select an expression, Insert → Math → Compute Selection.

---

## Troubleshooting

- **macOS says the app is "damaged" / won't open** — Gatekeeper quarantine or a broken
  signature from renaming the `.app`. Fix with the two commands in [Get it](#get-it):
  ```bash
  xattr -cr "/Applications/Hilbert.app"
  codesign --force --deep --sign - "/Applications/Hilbert.app"
  ```
- **Window is blank / "couldn't start its local engine"** — something else is using
  port 3001. Quit it and reopen.
- **It opens but nothing compiles** — the **Typst CLI** isn't installed or on `PATH`.
  Install it and confirm `typst --version` works.
- **A template fails with an error inside `@preview/…`** — that's a *package*
  compatibility problem, not the editor: some Typst Universe templates pull in helper
  packages written for an older Typst. Pick a different template or match the Typst
  version the template expects. Your own document is fine.
- **`npm run dev` only prints the concurrently line and stops** — the dev dependencies
  aren't installed. Run a full `npm install` (not `--production`).

---

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALLOW_CODE_EXECUTION` | `1` | Set to `0` to disable all code execution. |
| `EXEC_TIMEOUT_MS` | `45000` | Per-run wall-clock limit. |

Interpreters (including conda environments) are auto-detected; choose the default per
language in **App Settings → Interpreters**. Your documents live in
`~/Documents/Hilbert`.

---

## Security model

The backend is built for **local, single-user** use:
- Binds to `127.0.0.1` only; CORS limited to `localhost` / `127.0.0.1`.
- File access is confined to the workspace (path traversal rejected).
- Code execution is opt-outable (`ALLOW_CODE_EXECUTION=0`), time-limited, runs in a
  `sandbox/` dir, and is screened for process / network / shell / destructive calls.

These are guardrails, **not** a hardened sandbox — code runs with your user privileges.
**Don't expose port 3001 to a network or run untrusted documents.** For untrusted use
you'd want real OS-level isolation (a container or VM).

The **auto-updater** verifies every update against a signing key: the repo holds only
the **public** key, so nothing in it can forge an update; the private key never leaves
the maintainer's machine. Cloud credentials (Google Drive OAuth, WebDAV) live only in
your browser's local storage.

---

## What's next

Hilbert already does most of what a scientific-writing IDE should. So the next releases
are about making what's here **rock-solid** — fixing rough edges, and making it faster
and lighter (tracked in the [benchmarks](docs/PERFORMANCE.md)) — rather than piling on
more. If something breaks or feels slow, that's exactly what I want to hear:
open a [Discussion](https://github.com/aburousan/hilbert-editor/discussions).

## Support

Built and maintained by [Kazi Abu Rousan](https://rousan.netlify.app/). If it saves you
time, you can [**buy me a coffee**](https://buymeacoffee.com/rousan) — genuinely
appreciated (there's also a button in the app's **About** dialog).

## License

MIT — see [LICENSE](LICENSE). Bundled third-party software:
[quiver](https://github.com/varkor/quiver) (MIT, © varkor) with
[KaTeX](https://katex.org/) (MIT) under `public/quiver/`.
