# Hilbert — Performance Report

Benchmarks and optimization notes for both editions of Hilbert:

- **Electron** edition — Node/Express backend (`server.js`), Chromium renderer.
- **Tauri** edition — Rust/axum backend (`src-tauri/src/server.rs`), system WebView.

Both editions share the exact same React UI; only the shell and backend differ.

---

## 1. Method

A reproducible backend benchmark (`bench.cjs`) generates four workspaces and runs
**both backends** (`node server.js` and `typst-editor --headless`) through the
same HTTP calls. Each backend is restarted per workspace for a clean memory
baseline. Compile uses the same `typst` CLI in both, so it isolates backend cost.

| Workspace | `.typ` | images | bib refs | total files |
|-----------|-------:|-------:|---------:|------------:|
| Tiny      | 3      | 1      | 5        | 7 |
| Medium    | 30     | 20     | 100      | 53 |
| Thesis    | 200    | 100    | 500      | 303 |
| Huge      | 1000   | 500    | 2000     | 1503 |

`main.typ` `#include`s every chapter, so "full compile" scales with the project.

Test machine: Apple Silicon (arm64), macOS 15; Node 26, Typst 0.14.2.
Numbers are averages over 10–20 iterations; re-run before each release.

---

## 2. Results — Electron (Node) vs Tauri (Rust)

| Metric | Tiny (N/R) | Medium (N/R) | Thesis (N/R) | Huge (N/R) |
|---|---|---|---|---|
| Index tree, avg (ms)      | 1.4 / **0.7** | 1.8 / **0.9** | 3.6 / **2.1** | 11.2 / **6.4** |
| Search, avg (ms)          | 0.9 / **0.6** | 1.7 / **1.2** | 4.5 / **3.9** | 22.1 / **15.8** |
| Search, worst (ms)        | 1.6 / **0.7** | 3.0 / **1.4** | 5.9 / **4.9** | 44.0 / **17.9** |
| File-op cycle¹ (ms)       | 3.3 / **1.9** | 2.5 / **1.5** | 2.1 / **1.1** | 2.0 / **1.0** |
| Full compile² (ms)        | 253 / 79 | 83 / 80 | 112 / 107 | 273 / 247 |
| **RSS at start (MB)**     | 67 / **12** | 67 / **12** | 70 / **12** | 74 / **14** |
| RSS after 100× load³ (MB) | 71 / **13** | 72 / **13** | 82 / **14** | 144 / **21** |
| RSS growth under load (MB)| +4.3 / **+1.0** | +4.7 / **+1.2** | +12.1 / **+1.7** | +69.9 / **+7.5** |

¹ create → rename → copy → delete, one round-trip each.
² `main.typ` including every chapter; both shell out to the same `typst` binary.
³ RSS after hammering 100 tree+search requests, to surface leaks.

### Reading the data

- **Memory is the headline.** The Tauri/Rust backend starts at **~12 MB vs ~70 MB**
  — 5–6× lighter — and stays nearly flat under load. On the Huge project, Node grew
  **+70 MB** after 100 hammered search calls (V8 holding large result-set JSON with
  delayed GC — a high ceiling, not a hard leak); Rust grew **+7.5 MB**.
- **Search & indexing** favour Rust at every size and scale better: worst-case search
  on 1,500 files is **18 ms (Rust) vs 44 ms (Node)**.
- **File ops** are ~1–3 ms either way; the tree stays instant.
- **Compile is effectively equal** — both invoke the same `typst` CLI, so backend
  choice barely matters. The Tiny 253 ms was cold-start warmup (drops to ~80 ms warm).

**Takeaway:** Electron is the capable baseline; Tauri is the optimized build —
same features, a fraction of the memory, and lower latency on large projects.

---

## 3. Improvements shipped this cycle

**Both editions (shared UI):**
- File tree rewritten: multi-select, drag-and-drop move, rename/duplicate/delete,
  cut/copy/paste, right-click context menu, content search with jump-to-line.
- Folder collapse state moved into React state (survives re-renders); collapse/
  expand hide children via CSS rather than destroying nodes.
- Non-`.typ` tabs (`.bib`, `.toml`, …) no longer hijack the preview — the last
  `.typ` file stays compiled.
- Whiteboard (Excalidraw) gained a scientific-shape palette (axes, vectors, circuits,
  optics, waves), shading controls, and an **Experimental** group (function plotter,
  vector field, Bohr atom, free-body diagram).
- Image editor is raster-only (PNG/JPG/…); SVGs open as a safe preview instead of
  being rasterised and corrupted.
- **Memory leak fixed:** Monaco models are now disposed on tab close (previously each
  opened-then-closed file leaked a full-document model).
- UI density pass on the sidebar labels and toolbar buttons.

**Electron backend (`server.js`):** `--root` on all compile paths (multi-file
projects), `/workspace/search`, `/workspace/raw`, file `size`/`mtime` in the tree,
`/workspace/compress`, Windows console-popup suppression, cross-platform interpreter
detection.

**Tauri backend (`server.rs`):** ported the above endpoint-for-endpoint — `--root`
compiles, `/workspace/{rename,reveal,search,raw,compress}`, tree `size`/`mtime`,
`git status --porcelain` — keeping the Rust backend a 1:1 match of the Node one.

---

## 4. Component-lifecycle scorecard

The hot paths use keep-alive / model-swap; occasional tools mount on demand.

| Component | Pattern | Status |
|---|---|---|
| **Monaco editor** | one instance, swap models per file | ✅ keep-alive |
| **PDF preview** | viewer stays mounted, replaces the pdf.js document | ✅ keep-alive |
| **File explorer** | collapse hides children (CSS), nodes reused | ✅ hide-not-destroy |
| **Tabs** | file contents kept in state; editor state preserved | ✅ keep-alive |
| **Package list** | Typst-universe index cached on disk (TTL) | ✅ cached |
| **Settings / Excalidraw / Plot Studio / builders** | lazy-mounted, freed on close | ⚠️ on-demand |

The on-demand tools trade a ~100 ms reopen cost for **zero idle memory** — a
deliberate choice that keeps the resting footprint low (see §2). Converting the
most-reopened ones (Plot Studio's WebGL, Excalidraw's canvas) to "init once, then
hide/show" is a viable future optimization if reopen latency becomes noticeable.

---

## 5. Workspace model (VS Code–style)

"Open Folder" makes any folder on disk the live project — the backend repoints its
workspace root at that path (`POST /workspace/root`) and reads/writes files there
directly. Recent folders are remembered. In the browser build, the File System
Access API writes edits straight back to the chosen folder. No copy, no import step
for the desktop app — exactly like opening a folder in VS Code.
