# Hilbert — an offline editor for Typst

> **Unofficial.** Hilbert is an independent, community-built editor. It is not
> the Typst web app, IDE, or compiler, and is not affiliated with or endorsed by
> the Typst team. "Typst" is a trademark of its respective owners; this project
> merely builds on top of the open-source Typst compiler.

I wanted an offline, Overleaf-feeling place to write physics and maths in
[Typst](https://typst.app) — a real code editor on the left, a live PDF on the
right, and all the fiddly stuff (equations, figures, plots, theorems, citations)
one click away instead of memorised. So I built one. It runs entirely on your
machine, and it can even run your Python / Julia / Wolfram snippets and drop the
result straight into the document.

![Hilbert](docs/screenshot.png)

## Demo

**Live editing with an instant PDF preview:**

![Live preview](docs/gifs/live-preview.gif)

**Draw a commutative diagram visually ([quiver](https://github.com/varkor/quiver), bundled) — it lands in your document as editable `fletcher` code:**

![Commutative diagram with quiver](docs/gifs/quiver-diagram.gif)

**Colour anything with the draggable colour grid (Formatting menu):**

![Text colour picker](docs/gifs/text-colour.gif)

**Run Python/Julia/Wolfram and drop the result in as a typeset equation:**

![Run code → equation](docs/gifs/run-code-equation.gif)

**Sketch a symbol and get its Typst code (experimental):**

![Draw a symbol](docs/gifs/draw-symbol.gif)

**Look a paper up by DOI or arXiv id and cite it:**

![Citations](docs/gifs/citations.gif)

**Insert plots (cetz) without leaving the editor:**

![Insert a plot](docs/gifs/insert-plot.gif)

**Browse Typst Universe templates with a rendered preview:**

![Template preview](docs/gifs/template-preview.gif)

**Toggle a dark PDF preview (like Overleaf):**

![Dark PDF](docs/gifs/dark-pdf.gif)

### Visual builders

Point-and-click tools for the parts that are painful to hand-write. Each one
generates editable Typst and drops it into your document.

**Flowchart → Code.** Draw the logic and it writes the `while`, `if` and `for`
for you:

![Flowchart to code](docs/flowchart-code.png)

**Feynman diagrams.** Draw propagators, loops and vertices, then get editable
`cetz` back:

![Feynman diagram builder](docs/feynman-builder.png)

**Matrix Studio.** A visual grid with fills, borders, brackets and a code-array
output mode:

![Matrix Studio](docs/matrix-studio.png)

**3D Plot Studio.** Rotate a surface to the angle you want, then insert that exact
view:

![3D Plot Studio](docs/plot3d-studio.png)

> Everything happens on your computer. A tiny local Node server drives the Typst
> compiler and (optional) code execution — nothing leaves the machine unless you
> deliberately turn on Google Drive or WebDAV sync.

## What's in the box

**Writing & preview**
- Live PDF preview that recompiles as you type, with zoom / fit-to-width and a
  dark mode. Double-click a word in the PDF to jump to it in the source (it uses
  the surrounding words to land on the right one).
- Monaco editor with Typst highlighting, plus **hover documentation and smart
  autocomplete powered by [tinymist](https://github.com/Myriad-Dreamin/tinymist)** —
  hover any function for its signature and docs, and get completions for every
  builtin, package export and label. On top of that: `@`-reference autocomplete,
  **image-path autocomplete** inside `image("…")` (Overleaf-style, offered from
  your workspace), a file tree (files **and** folders, image upload, **full right-click context menu** with rename/duplicate/copy/paste), an outline,
  a clickable **Problems** panel, and resizable panes.
- **Open Folder** works like VS Code — pick any folder as the workspace (edits
  save back to disk in the desktop app and Chrome/Edge) — with **File → Open
  Recent** to jump back to it later.
- A **live word count of the rendered document** (read from the PDF, so `#set`,
  `#import` and markup syntax don't inflate it), a one-click **highlighter** and a
  **font-size dropdown** in the toolbar, and control-flow completions that offer
  **both `{ }` code and `[ ]` content bodies** for `if` / `for` / `while` — the two
  forms Typst actually allows.

**Inserting the annoying stuff**
- Title blocks, headings, abstracts; inline / block / aligned / **numbered**
  equations; matrices; tables; figures; images; lists — most with a
  *center on page* toggle. Numbering is on by default (toggle it under the cursor
  with **⌘⇧N**).
- A **math & physics symbol picker** (`physica`), and — *experimental* — a
  **draw-a-symbol** pad: sketch a symbol and it guesses the Typst code.
- **Theorems / proofs / lemmas** — plain or in coloured boxes, each kind numbered
  on its own.
- A **Physics & Cosmology menu** with ready-made, compile-checked equations —
  bra–kets, commutators, the Dirac / Klein–Gordon equations, the QED Lagrangian,
  Einstein's field equations, Christoffel symbols, the FRW metric, the Friedmann
  equations, and more.
- **Commutative diagrams** drawn visually with a bundled, offline copy of
  [quiver](https://github.com/varkor/quiver) — *Insert Diagram* drops the
  result into the document as editable `fletcher` code.
- **Feynman diagrams** drawn visually — fermion / photon / gluon / scalar / ghost
  propagators, loops (plain, wavy or coiled circles), hatched or shaded blobs,
  vertices and labels, with per-element colour and thickness — inserted as
  editable `cetz` code.

**Maths that computes**
- **Run code → insert result** (Python / Julia / Wolfram). Take the text output,
  a generated figure, or — in *equation mode* — write plain maths like
  `diff(sin(x**2), x)` and get a typeset equation back automatically.
- **Compute on a selection**: highlight an expression and simplify / solve /
  differentiate / integrate / evaluate it with sympy, dropped back in as an
  equation.
- **Ready-made physics examples** in the runner's *Examples* menu — including
  **General Relativity with [xAct](http://www.xact.es/)** (Schwarzschild curvature
  → Ricci tensor and the Kretschmann scalar), **Penrose (conformal) diagrams**,
  and **Clebsch–Gordan / Wigner 3-j coefficients** — inserted either as a rendered
  image or, in equation mode, as a typeset equation.

**Plots**
- 2D via `cetz` + `cetz-plot`.
- **3D Plot Studio**: an interactive surface you rotate to the angle you like,
  then *insert exactly that view* as a figure (saved into `images/`).

**References & bibliography**
- A **reference & label manager** that lists every label and `@reference`, and
  flags undefined / duplicate / unused ones.
- A **citation manager**: look a paper up by **DOI or arXiv id**, save it to
  `refs.bib`, and cite it with `@key` (the bibliography section is added for you).

**Getting it in and out**
- Import data (CSV / JSON / YAML / TOML) with the matching Typst reader wired up.
- **Import your own fonts** (`.ttf` / `.otf`) via **File → Import Font** — they
  drop into `workspace/fonts/` and compile with `#set text(font: "…")`.
- Templates from Typst Universe with a rendered preview.
- Git (init / commit / push to GitHub), and Save / Open / Export to PDF, HTML,
  `.typ`, a local folder, Google Drive, or WebDAV (Nextcloud / ownCloud).
- Manage installed Typst packages — search, download, and remove.

## What you need

- **Node.js 18+**
- **[Typst CLI](https://github.com/typst/typst) 0.14 or newer** on your `PATH`
  (`brew install typst`, `cargo install typst-cli`, or a release binary).
- Optional but recommended — **[tinymist](https://github.com/Myriad-Dreamin/tinymist)**,
  the Typst language server. With `tinymist` on your `PATH` the editor adds
  **inline hover documentation** (hover any function for its signature and docs)
  and **smart autocomplete** (builtins, package exports, labels). Without it the
  editor still works fully — those two features simply stay quiet. Install it:
  - **macOS:** `brew install tinymist`
  - **Windows:** `winget install Myriad-Dreamin.tinymist` (or `scoop install tinymist`)
  - **Linux:** `cargo install tinymist`, or download a prebuilt binary from the
    [tinymist releases](https://github.com/Myriad-Dreamin/tinymist/releases) and
    put it on your `PATH`
  - **Any OS with Rust:** `cargo install tinymist` works everywhere. Verify with
    `tinymist --version`, then restart the editor.
- Optional, only for running code:
  - **Python 3** with `numpy`, `matplotlib`, `sympy`
  - **Julia** (`Latexify` for equation mode)
  - **WolframScript**

## Get it running

```bash
git clone https://github.com/aburousan/hilbert-editor.git
cd hilbert-editor
bash scripts/setup.sh   # installs Typst + Python deps and runs npm install (macOS/Linux)
npm run dev
```

`scripts/setup.sh` sets up everything (Typst CLI, the Python stack, npm deps). If
you already have the tools, `npm install && npm run dev` is enough. `npm run dev`
starts the Vite dev server and the local backend; open the printed URL (default
<http://localhost:5173>), with the backend on `http://127.0.0.1:3001`.

### Prefer a desktop app?

There are prebuilt installers on the [Releases](https://github.com/aburousan/hilbert-editor/releases)
page — a **`.dmg`** for macOS (Apple Silicon and Intel) and an **`.AppImage`**
for Linux — or build them yourself:

```bash
npm run app     # build the UI and launch the desktop window
npm run dist    # build installers into release/ (.dmg on macOS, .AppImage on Linux)
```

Your documents live in `~/Documents/Hilbert`. The desktop app still needs the
**Typst CLI** on your `PATH` (and Python/Julia/Wolfram for the optional code
features) — those aren't bundled.

> **macOS note:** the app is not notarised (no paid Apple developer account), so
> macOS warns on first launch. It's the standard warning for any indie app
> distributed outside the App Store — the code is open, so you can audit or
> build it yourself. To open:
> - **macOS 15 (Sequoia) and newer:** double-click once (it will refuse), then
>   go to **System Settings → Privacy & Security**, scroll down, and click
>   **Open Anyway** next to Hilbert.
> - **macOS 14 and older:** right-click the app → **Open** → **Open**.
> - **Terminal alternative** (any version): `xattr -cr "/Applications/Hilbert.app"`
>   removes the quarantine flag, then it opens normally.
>
> This only happens once; afterwards the app opens like any other.

### Windows

Windows isn't in the prebuilt releases yet, but it runs fine — two ways:

**1. Run from source** (quickest):

```powershell
winget install Typst.Typst        # or: scoop install typst / choco install typst
git clone https://github.com/aburousan/hilbert-editor.git
cd hilbert-editor
npm install
npm run dev                        # then open http://localhost:5173
```

Make sure `typst` is on your `PATH` (`typst --version` should work). For the
optional code-execution features, install Python (with `numpy`, `matplotlib`,
`sympy`) and/or Julia and put them on `PATH` too.

**2. Build a desktop installer** — on a Windows machine, `npm run dist` produces
an `.exe` (NSIS) installer in `release/`. (It has to be built on Windows;
cross-building from macOS/Linux isn't reliable.)

Tip: opening a folder to edit its files in place works best in the desktop app or
in **Chrome/Edge** (which support writing changes back to the folder). Other
browsers open a working copy instead.

### Docker (bundles Typst + Python)

```bash
docker build -t typst-editor .
docker run --rm -p 127.0.0.1:3001:3001 -v "$PWD/workspace:/app/workspace" typst-editor
# open http://localhost:3001
```

The image ships the Typst CLI and a Python stack, so nothing else is needed; your
documents persist in the mounted `workspace/`. Keep the port on `127.0.0.1` only
— code execution runs inside the container.

## A few tips

- **Compile**: edits recompile after a short pause; **⌘S** saves + recompiles now.
- **Numbering**: put the cursor on a heading or block equation and press **⌘⇧N**.
- **Cross-references**: add a label (`= Intro <sec:intro>`), then type `@` and pick it.
- **Cite a paper**: Insert → References → Citations, look it up by DOI/arXiv, hit **Cite**.
- **Compute**: select an expression, Insert → Math → Compute Selection.
- **Quick formatting**: click **Aa** for a font-size dropdown, the highlighter for
  a colour popover, and hover any Typst function to read its docs inline.

## Troubleshooting

- **macOS says the app is "damaged" or won't open** — This is macOS Gatekeeper quarantining the app, or a broken signature from renaming the `.app` file. To fix it, run these two commands in your terminal:
  ```bash
  xattr -cr "/Applications/Hilbert.app"
  codesign --force --deep --sign - "/Applications/Hilbert.app"
  ```
  *(If the app is in your Downloads folder, adjust the path accordingly).*
- **Window is blank / "couldn't start its local engine"** — something else is
  using port 3001. Quit it and reopen.
- **It opens but nothing compiles** — the **Typst CLI** isn't installed or isn't
  found. Install it (`brew install typst`, `winget install Typst.Typst`, or a
  release binary) and make sure `typst --version` works. The desktop app looks in
  the usual install locations (Homebrew, cargo, `~/.local/bin`, …).
- **`npm run dev` only prints `concurrently "node server.js" "vite"` and stops** —
  the dev dependencies aren't installed. Run a full `npm install` (not
  `--production`), then `npm run dev` again.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALLOW_CODE_EXECUTION` | `1` | Set to `0` to disable all code execution. |
| `EXEC_TIMEOUT_MS` | `45000` | Per-run wall-clock limit. |

Interpreters (including conda environments) are auto-detected; choose the default
per language in **App Settings → Interpreters**.

## Security model

The backend is built for **local, single-user** use:

- Binds to `127.0.0.1` only; CORS limited to `localhost` / `127.0.0.1`.
- File access is confined to `workspace/` (path traversal rejected).
- Code execution is opt-outable (`ALLOW_CODE_EXECUTION=0`), time-limited, runs in
  `workspace/sandbox/`, and is screened for process/network/shell/destructive calls.

These are guardrails, **not** a hardened sandbox — code runs with your user
privileges and the denylist is heuristic. **Don't expose port 3001 to a network
or run untrusted documents.** For multi-user or untrusted use you'd want real
OS-level isolation (a container or VM).

Cloud credentials (Google Drive OAuth, WebDAV) live only in your browser's local
storage — they're never committed or sent anywhere but the service you're syncing
to. For Google Drive you supply your own OAuth Client ID in App Settings.

## Feedback & updates

A lot of the recent UI changes came from suggestions by friends who use the
editor day to day. Thank you. If you want a feature or have an idea, open a
[Discussion](https://github.com/aburousan/hilbert-editor/discussions); I read them
and pick up what makes sense. I try to ship an update every couple of months,
sooner if a serious bug turns up.

## Support

Built and maintained by [Kazi Abu Rousan](https://rousan.netlify.app/). If it
saves you time, you can [**buy me a coffee**](https://buymeacoffee.com/rousan).
It's genuinely appreciated and helps keep the project going. (There's also a
button in the app's **About** dialog.)

## License

MIT — see [LICENSE](LICENSE).

Bundled third-party software: [quiver](https://github.com/varkor/quiver)
(MIT, © varkor) with [KaTeX](https://katex.org/) (MIT) under `public/quiver/`.
