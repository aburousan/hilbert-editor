# Hilbert: performance report

Measured numbers for the shipping app: a Rust/axum backend
(`src-tauri/src/server.rs`) behind the system WebView, driving the Typst CLI.

Everything here is reproducible. `scripts/bench.mjs` generates the workspaces and runs
the backend against each one; `scripts/bench_plot.py` draws the chart from the JSON it
writes.

```bash
node scripts/bench.mjs        # writes bench-results.json
python scripts/bench_plot.py  # writes docs/performance.png
```

Test machine: Apple Silicon (arm64), macOS 15, release build, Typst 0.15.0. Averages
over 5 to 20 iterations per figure. Re-run before each release.

---

## 1. Backend

Four workspaces of increasing size. `main.typ` `#include`s every chapter, so a full
compile scales with the project.

| Workspace | chapters | bib refs | files |
|---|---:|---:|---:|
| Tiny   | 3    | 5    | 5 |
| Medium | 30   | 100  | 32 |
| Thesis | 200  | 500  | 202 |
| Huge   | 1000 | 2000 | 1002 |

![Backend benchmarks](performance.png)

| Metric | Tiny | Medium | Thesis | Huge |
|---|---:|---:|---:|---:|
| Index the file tree, avg (ms) | 0.9 | 0.6 | 1.6 | 4.4 |
| Full-text search, avg (ms)    | 0.4 | 1.1 | 3.9 | 17.3 |
| Full-text search, worst (ms)  | 0.6 | 1.9 | 5.7 | 18.4 |
| File-op cycle, avg (ms)¹      | 1.7 | 0.8 | 0.8 | 0.7 |
| Full compile, avg (ms)²       | 212 | 134 | 204 | 536 |
| RSS at start (MB)             | 12  | 12  | 12  | 12 |
| RSS after 100x load (MB)³     | 14  | 14  | 15  | 18 |

¹ create, rename, then delete: one HTTP round trip each.
² `main.typ` including every chapter, through the Typst CLI.
³ After 100 hammered tree and search requests, to surface leaks.

Reading the data. The backend starts at **12 MB** and stays there: a thousand-file
project costs about 6 MB more, and hammering it adds a few MB that get reclaimed.
Search is the only thing that scales visibly with project size, and even across 1000
files the worst case is 18 ms, comfortably inside a keystroke. File operations stay
under 2 ms at every size. Compile is dominated by the Typst CLI rather than by the
backend, which is why the Huge figure (0.54 s for 1000 chapters) sits close to what
`typst compile` costs on its own.

---

## 2. Startup, and the app as a whole

| Metric | Value |
|---|---|
| Backend process to first HTTP response | 32 ms warm, roughly 650 ms on a cold first run |
| App launch to embedded server ready | 231 ms |
| Page load to editor interactive | about 300 ms |
| Page load to a rendered 300-page PDF | about 1.5 s |
| Installed size (`Hilbert.app`) | 37 MB (16 MB binary, 18 MB UI, 2 MB Typst packages) |
| Frontend JS heap | about 31 MB |

A 300-page stress document (7000 lines, 300 tables, 100 code blocks, heavy maths)
compiles in about **1.0 s** and first-renders in about **1.5 s**. Twenty consecutive
compiles of it leave resident memory flat.

Every compile spawns a fresh `typst` process, so an edit recompiles the whole
document. A second per 300 pages is comfortable, but this is the one number that would
need attention for a very large book. A `typst watch` sidecar, or the compiler used as
a library, would make edits incremental.

---

## 3. The optimizations behind these numbers

**Dictionaries load on demand, cutting idle memory by 14x.** The spelling and grammar
dictionaries (spellbook and Harper) cost about 150 MB resident. They used to be
preloaded on a background thread at launch, but proofreading is off by default, so
most people carried that memory forever without ever using it. They now load the first
time `/lint` is called, which only happens once proofreading is switched on, and the
load runs in the background so the first sentence is still checked promptly. Idle RSS
fell from **173 MB to 12 MB**.

**Monaco is created once** and swaps models between tabs rather than being torn down
and rebuilt. Models are disposed on tab close, which fixed a leak where every
opened-then-closed file kept a full document in memory.

**The editor's options object is memoised.** `@monaco-editor/react` calls
`updateOptions()` whenever the options prop changes identity, and reconfiguring the
editor mid-search resets its find-match highlights, which showed up as flicker while
typing in the find box.

**The PDF preview re-rasterises pages in place.** Resizing or zooming used to replace
the whole page area, blanking the document for a frame. Each page now renders
off-screen and is swapped in when ready, and pages outside the viewport are skipped
with an IntersectionObserver.

**Compile output lives in a hidden `.hilbert/` folder** per workspace, next to the
scratch directory used for code execution. Plots produced by a notebook run are moved
out into a visible `assets/` folder, because the document embeds them and they have to
survive a cleanup.

**Code execution is capped by the kernel**, not only by a timer. File-size and CPU
limits are set on the child process and captured output is truncated at 8 MB, so a
runaway cell cannot fill the disk or exhaust memory.

---

## 4. Where the memory actually goes

| Process | RSS |
|---|---|
| Backend, idle | 12 MB |
| Backend, once proofreading is enabled | about 174 MB (dictionaries) |
| WebKit content process | about 200 MB |
| tinymist language server (child) | about 33 MB |

The WebView dominates, which is the expected shape for a Tauri app: the system WebKit
is shared rather than bundled, so the binary stays at 16 MB where an Electron build
ships a whole copy of Chromium. The earlier Electron edition of this app idled around
320 MB across five processes and unpacked to 711 MB on disk.

Switching proofreading on is now the largest single memory decision in the app, and it
belongs to the user.

---

## 5. Component lifecycle

| Component | Pattern |
|---|---|
| Monaco editor | one instance, models swapped per file |
| PDF preview | stays mounted, re-rasterises in place |
| File tree | collapse hides children, nodes reused |
| Tabs | contents kept in state, editor state preserved |
| Package index | cached on disk with a TTL |
| Plot Studio, 3D studio, whiteboard, builders | lazy-mounted, freed on close |

The heavy tools are loaded on demand and freed when closed. That costs roughly 100 ms
to reopen one and keeps the resting footprint near zero, which is the right trade for
tools opened a few times per session. If reopening ever starts to feel slow, the WebGL
and canvas tools are the ones to convert to init-once-then-hide.
