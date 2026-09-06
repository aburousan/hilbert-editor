# Stability verification

Local worktree verification, September 6, 2026. These checks are not a claim
that every feature or platform is bug-free. No runtime dependencies were added.

## Changes covered

- PDF preview releases distant canvas bitmaps, cancels superseded rendering,
  guards against stale document loads, and counts words one page at a time.
  Background text-layer warming is limited to eight additional pages and pauses
  in hidden documents; concurrent requests for one text layer share its build.
- Package/template installer JavaScript loads on demand; shared dialog CSS
  remains in the startup stylesheet.
- The header fits the supported 900px minimum window width without overlap.
- Desktop icon assets use the existing coloured badge with a white glyph,
  instead of the black transparent glyph that disappeared on dark backgrounds.
- Whiteboard shapes participate in undo history; saves report errors and retain
  unsaved status when the drawing changes during a save. Scientific shape labels
  wrap, can be searched, follow the theme, and insert beside the open palette.
- Feynman generation renders outside numbered figures too. Displayed code is
  compilable, edits support bounded undo/redo, and drawing supports pointer capture.
- Symbol recognition caches templates, yields during initialization, and handles
  scaled canvases and cancelled strokes. Inserting into Typst prose adds math
  delimiters; insertion within an existing math block keeps that block.
- Python equation mode uses Python's AST and SymPy's LaTeX printer. Multiline
  expressions, assignments, assumptions and function bodies retain their meaning.
  Printed diagnostics do not contaminate the equation. Editing a snippet hides
  stale execution results. Existing execution restrictions remain in place.
- Arabic/Persian digits and combining marks no longer incorrectly determine a
  line's base direction before its first letter.
- Excalidraw's optional AI controls are explicitly disabled. Source scanning
  found no user-facing AI-provider branding; dictionary words were left intact.

## Reproduction

Build with `npm run build` and `cargo build --locked` in `src-tauri`.

`npm run test:smoke` starts a temporary backend and project, then checks PDF
scrolling, window sizes, every Feynman template, unnumbered export, pointer-based
symbol recognition, and whiteboard JSON/SVG saving. It prints its screenshot
directory. Set `TEST_PYTHON` to an interpreter with SymPy to additionally test
real `/run` requests, Typst equation compilation, and stale-result prevention.
`BIN`, `TYPST_BIN`, `PORT` and `ARTIFACTS` can override test defaults.

Run `python scripts/test-symbolic.py` with SymPy installed for isolated Python
tests. Run `npm run test:bidi` for measured RTL layout, `npm run test:typing` for
typing integrity, `npm run test:sync-all` for synchronization/language/graph
regressions, and `cargo test --locked` in `src-tauri` for backend tests.

Desktop icon regeneration: `npm run icons`. This uses `build/icon.svg` and an
installed `cargo tauri` CLI; it does not replace mobile assets.

## Measurements and limits

- A 36-page preview at 1440x920 and device scale factor 2 retained about 26-28 MiB
  of page bitmaps after scrolling, down from about 306.4 MiB. This measures canvas
  pixel buffers, not total process RSS or PDF worker memory.
- The bounded-background-work regression retained ten prepared text layers
  after idle in the 36-page fixture; remaining pages are still available on demand.
- The main startup JavaScript chunk decreased from about 556.2 kB to 521.4 kB
  before gzip. Deferred functionality still exists in separate chunks.
- Backend suite: 63 passed, two downloaded-dictionary tests skipped.
- Symbolic helper: nine cases passed with SymPy 1.14.0 on macOS and 1.12 on Linux.
- Browser smoke: five symbolic API/Typst cases, 13 Feynman templates, whiteboard
  JSON/SVG saving, symbol recognition and stale-result checks passed.
- RTL layout: 18 cases passed. Typing integrity passed three trials at each of
  30, 15, 8, 4 and 0 ms per keystroke, the last being as fast as the browser
  will dispatch events.
- Native macOS Tauri startup and PDF rendering were visually checked.
- Linux was checked on Ubuntu 24.04 with WebKitGTK 2.52.6, building both the
  frontend and the Rust backend from source on that machine: 63 backend tests and
  every browser-driven suite passed there, matching macOS.
- The native GTK/WebKit script (`scripts/test-linux-webkit.py`) times out under
  Xvfb software rendering and is not counted as passed. It stalls at a different
  step on each run while the machine sits idle, so the budget is not the cause;
  the interactions it covers are also covered by `test:smoke` under Chromium,
  which does pass on the same machine. Its time budget is configurable with
  `--budget`, and it still requires an explicit `--allow-gui`.
- A report of desktop-wide slowness on one Linux test machine was traced to that
  machine rather than to Hilbert: a Pascal-generation card on the nouveau driver
  logging `pmu: firmware unavailable` at boot, so the GPU never reclocks, with
  GPU traps in the kernel log raised by GNOME's own `gst-plugin-scan` at session
  start and logout. Measured on that machine, the backend used no measurable CPU
  over 60 idle seconds with a project open, and 66 MB resident.
- Windows icon assets were regenerated, but a Windows installer/taskbar runtime
  test is still needed. Existing shortcuts may retain Windows' cached icon.
- Full handwriting recognition, every Arabic/Hebrew caret/IME workflow, extended
  stress tests, Julia/Wolfram execution, and all OS versions are not covered.
- A session soak (40-page document scrolled end to end twelve times, files and
  dialogs opened and closed, typing each round, proofreading on, forced GC before
  each reading) grew the JS heap 18.6 MB to 19.7 MB over five rounds with DOM
  nodes falling, event listeners unchanged and backend RSS flat. Retained page
  bitmaps stayed at three canvases throughout.
- Every ready-made equation in the three Insert menus is compiled individually,
  once without the physica package and once with it, so a snippet that needs the
  import cannot ship without asking for it.
- Lint still reports existing warnings, primarily from vendored Quiver code.
  Vendored libraries and unrelated warnings were not broadly rewritten.
