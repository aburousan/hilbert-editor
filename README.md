# Typst Editor

I wanted an offline, Overleaf-feeling place to write physics and maths in
[Typst](https://typst.app) — a real code editor on the left, a live PDF on the
right, and all the fiddly stuff (equations, figures, plots, theorems, citations)
one click away instead of memorised. So I built one. It runs entirely on your
machine, and it can even run your Python / Julia / Wolfram snippets and drop the
result straight into the document.

![Typst Editor](docs/screenshot.png)

## Demo

**Live editing with an instant PDF preview:**

![Live preview](docs/gifs/live-preview.gif)

**Run Python/Julia/Wolfram and drop the result in as a typeset equation:**

![Run code → equation](docs/gifs/run-code-equation.gif)

**Insert plots (cetz) without leaving the editor:**

![Insert a plot](docs/gifs/insert-plot.gif)

**Browse Typst Universe templates with a rendered preview:**

![Template preview](docs/gifs/template-preview.gif)

**Toggle a dark PDF preview (like Overleaf):**

![Dark PDF](docs/gifs/dark-pdf.gif)

> Everything happens on your computer. A tiny local Node server drives the Typst
> compiler and (optional) code execution — nothing leaves the machine unless you
> deliberately turn on Google Drive or WebDAV sync.

## What's in the box

**Writing & preview**
- Live PDF preview that recompiles as you type, with zoom / fit-to-width and a
  dark mode. Double-click a word in the PDF to jump to it in the source (it uses
  the surrounding words to land on the right one).
- Monaco editor with Typst highlighting, completions, `@`-reference autocomplete,
  a file tree (files **and** folders, image upload), an outline, a clickable
  **Problems** panel, and resizable panes.

**Inserting the annoying stuff**
- Title blocks, headings, abstracts; inline / block / aligned / **numbered**
  equations; matrices; tables; figures; images; lists — most with a
  *center on page* toggle. Numbering is on by default (toggle it under the cursor
  with **⌘⇧N**).
- A **math & physics symbol picker** (`physica`), and — *experimental* — a
  **draw-a-symbol** pad: sketch a symbol and it guesses the Typst code.
- **Theorems / proofs / lemmas** — plain or in coloured boxes, each kind numbered
  on its own.
- **Feynman diagrams** (`fletcher`) from ready-made, editable templates.

**Maths that computes**
- **Run code → insert result** (Python / Julia / Wolfram). Take the text output,
  a generated figure, or — in *equation mode* — write plain maths like
  `diff(sin(x**2), x)` and get a typeset equation back automatically.
- **Compute on a selection**: highlight an expression and simplify / solve /
  differentiate / integrate / evaluate it with sympy, dropped back in as an
  equation.

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
- Templates from Typst Universe with a rendered preview.
- Git (init / commit / push to GitHub), and Save / Open / Export to PDF, HTML,
  `.typ`, a local folder, Google Drive, or WebDAV (Nextcloud / ownCloud).
- Manage installed Typst packages — search, download, and remove.

## What you need

- **Node.js 18+**
- **[Typst CLI](https://github.com/typst/typst)** on your `PATH`
  (`brew install typst`, `cargo install typst-cli`, or a release binary).
- Optional, only for running code:
  - **Python 3** with `numpy`, `matplotlib`, `sympy`
  - **Julia** (`Latexify` for equation mode)
  - **WolframScript**

## Get it running

```bash
git clone https://github.com/aburousan/typsteditor.git
cd typsteditor
bash scripts/setup.sh   # installs Typst + Python deps and runs npm install (macOS/Linux)
npm run dev
```

`scripts/setup.sh` sets up everything (Typst CLI, the Python stack, npm deps). If
you already have the tools, `npm install && npm run dev` is enough. `npm run dev`
starts the Vite dev server and the local backend; open the printed URL (default
<http://localhost:5173>), with the backend on `http://127.0.0.1:3001`.

### Prefer a desktop app?

There are prebuilt installers on the [Releases](https://github.com/aburousan/typsteditor/releases)
page — a **`.dmg`** for macOS (Apple Silicon and Intel) and an **`.AppImage`**
for Linux — or build them yourself:

```bash
npm run app     # build the UI and launch the desktop window
npm run dist    # build installers into release/ (.dmg on macOS, .AppImage on Linux)
```

Your documents live in `~/Documents/TypstEditor`. The desktop app still needs the
**Typst CLI** on your `PATH` (and Python/Julia/Wolfram for the optional code
features) — those aren't bundled.

> **macOS note:** the app is ad-hoc signed but not notarised, so the first launch
> needs a right-click → **Open** (or `xattr -cr "/Applications/Typst Editor.app"`).

### Windows

Windows isn't in the prebuilt releases yet, but it runs fine — two ways:

**1. Run from source** (quickest):

```powershell
winget install Typst.Typst        # or: scoop install typst / choco install typst
git clone https://github.com/aburousan/typsteditor.git
cd typsteditor
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

## License

MIT — see [LICENSE](LICENSE).
