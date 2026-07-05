# Typst Editor — Tauri port

A Tauri-based build of [Typst Editor](https://github.com/aburousan/typsteditor).
Same UI, same features, same behaviour — but the Electron shell + Node/Express
backend are replaced by **one small Rust binary**, so the app is dramatically
smaller and lighter.

| | Electron build | Tauri build |
| --- | --- | --- |
| macOS `.dmg` | 97–104 MB | **7.2 MB** |
| Unpacked app | 248–255 MB | **18 MB** |
| Runtime processes | Electron + Node utility process | one native process + system WebView |
| Idle RAM (macOS, same document) | ~320 MB (bundled Chromium + Node) | **~160 MB** (shared system WKWebView) |

![Electron vs Tauri — RAM and disk](docs/ram-vs-electron.png)

Measured at idle steady-state with the same document open (release builds, macOS
Apple Silicon, summing every process: main, renderer, GPU, network and backend).
The Tauri app uses about half the RAM because it renders through the OS's WebKit
(shared with the system) instead of shipping its own copy of Chromium, and its
backend is compiled into the same native process instead of a separate Node one.
On disk it is about **39× smaller** (18 MB vs 711 MB unpacked). RAM figures
fluctuate with page activity: the WebContent process spikes during heavy
compiles, then the garbage collector reclaims it. Disk size is exact.

## How it works

The original app is a React UI that talks to a local HTTP backend
(`server.js`, Express) on `127.0.0.1`. This port keeps that contract intact:

- **`src-tauri/src/server.rs`** — a 1:1 Rust (axum) reimplementation of every
  `server.js` endpoint: workspace file tree / read / write / upload / delete,
  Typst compile (PDF/HTML/PNG), templates, Typst Universe package search /
  install / remove, git (init/commit/push/log), code execution
  (Python / Julia / Wolfram with the same interpreter auto-detection, sandbox,
  denylist screening, equation-mode wrapping and image detection), DOI/arXiv
  BibTeX lookup, WebDAV sync, local-folder sync, export — plus serving the
  built UI on the same origin.
- **`src-tauri/src/main.rs`** — the shell (mirrors `electron/main.cjs`):
  free-port pick (3001 preferred), PATH augmentation for GUI launches,
  bundled Typst-package seeding into a writable cache
  (`TYPST_PACKAGE_CACHE_PATH`), workspace at `~/Documents/TypstEditor`,
  a native window pointing at the local server, external links opened in the
  real browser, and a `window.desktop.pickFolder()` bridge (native folder
  dialog) injected so **File → Open Folder** works exactly as in Electron.
- **`src-tauri/resources/dist`** — the *unmodified* production build of the
  original frontend (copied from `../typst-editor/dist`). Zero frontend
  changes were needed.
- **`src-tauri/resources/typst-packages`** — the same bundled packages
  (cetz, physica, fletcher, …) as the Electron app.

Like the original: the **Typst CLI** must be on your PATH, and
Python/Julia/Wolfram are optional (only for the code-execution features).
`ALLOW_CODE_EXECUTION=0` and `EXEC_TIMEOUT_MS` are honoured.

## Build

```bash
cd src-tauri
cargo build                        # debug binary
npx @tauri-apps/cli@latest build   # release .app (+ dmg)
```

If the Tauri dmg step fails (Finder scripting), make it manually:

```bash
cd target/release/bundle
mkdir dmg-staging && cp -R "macos/Typst Editor.app" dmg-staging/ && ln -s /Applications dmg-staging/Applications
hdiutil create -volname "Typst Editor" -srcfolder dmg-staging -ov -format UDZO "dmg/Typst Editor.dmg"
```

### Refreshing the UI from the original project

The frontend is consumed as a build artifact — to pick up UI changes:

```bash
cd ../typst-editor && npm run build
rm -rf ../typst-editor-tauri/src-tauri/resources/dist
cp -R dist ../typst-editor-tauri/src-tauri/resources/dist
```

## Linux and Windows builds

Tauri compiles native code against each OS's system webview (WebKitGTK on
Linux, WebView2 on Windows, WKWebView on macOS), so — unlike Electron — it
**cannot cross-compile**. Each platform is built on (or in a container of) that
OS. Two supported paths:

### Linux — locally, in a container (used to produce the shipped `.deb`/AppImage)

```bash
docker build -t typst-editor-linux-builder -f linux-build/Dockerfile linux-build/
docker run --rm -v "$PWD":/work typst-editor-linux-builder
# → src-tauri/target-linux/release/bundle/{appimage,deb}/…
```

On an Apple-Silicon Mac this builds native **arm64** Linux bundles; on an x86_64
host (e.g. the build server) it builds native **amd64** bundles. To force the
other arch add `--platform linux/amd64` (or `linux/arm64`) to both commands —
that runs under emulation and is slower.

### Windows

Building Windows **must** happen on a real Windows toolchain (MSVC + WebView2).
A `cargo-xwin` cross-build from Linux exists (`linux-build/Dockerfile.win`) and
produces an NSIS installer, but it is **experimental and unreliable** — the
resulting app frequently fails to launch on real Windows (resource / WebView2
embedding differs from a native MSVC build). Confirmed broken in testing, so do
**not** ship the cross-built `.exe`. **Build it in CI instead.** The workflow
below now includes a native `windows-latest` runner, which produces a working
`.msi` and `.exe` with no local Windows machine needed:

### GitHub Actions (`.github/workflows/build.yml`)

A manual **workflow_dispatch** build runs on native macOS + Linux runners and
uploads each bundle as a downloadable artifact (build-only — it does not cut a
release). Windows is omitted; add a `windows-latest` matrix entry back when a
native Windows build is wanted.

## Releases — Electron vs Tauri, kept separate

Both live in the one `aburousan/typsteditor` repo but never collide, by
convention:

| | Branch | Tag | Release title | Bundle names |
| --- | --- | --- | --- | --- |
| **Electron** (original) | `main` | `v0.1.1` | *Typst Editor v0.1.1 (Electron)* | `TypstEditor-Electron-<ver>-<os>-<arch>.…` |
| **Tauri** (this port) | `tauri-port` | `tauri-v0.1.1` | *Typst Editor (Tauri) v0.1.1* | `TypstEditor-Tauri-<ver>-<os>-<arch>.…` |

Releases are cut manually so the two lines stay clean. The bundles are built
locally (macOS) and on the Linux server (`linux-build/` for Tauri,
`electron-build/` on the server for the Electron AppImage), then:

```bash
# Electron
gh release create v0.1.1 --target main \
  --title "Typst Editor v0.1.1 (Electron)" --notes-file notes.md \
  TypstEditor-Electron-0.1.1-macOS-arm64.dmg TypstEditor-Electron-0.1.1-Linux-x86_64.AppImage

# Tauri
gh release create tauri-v0.1.1 --target tauri-port \
  --title "Typst Editor (Tauri) v0.1.1" --notes-file notes.md \
  TypstEditor-Tauri-0.1.1-macOS-arm64.dmg TypstEditor-Tauri-0.1.1-Linux-x86_64.deb \
  TypstEditor-Tauri-0.1.1-Linux-x86_64.AppImage
```

GitHub attaches the tagged source archive to each release automatically, so each
download page also carries its own code.

## Headless / server-only mode

For testing (or Docker-style use) the same binary can run the backend alone,
like `node server.js` did:

```bash
./target/release/typst-editor --headless        # PORT, TYPST_WORKSPACE, TYPST_DIST respected
```

## Security model

Same posture as the original (local, single-user), with extra hardening added
in the Rust backend:

- Binds to `127.0.0.1` only.
- **Host-header check** — requests whose `Host` isn't `127.0.0.1`/`localhost`
  are rejected (blocks DNS-rebinding, where a hostile domain resolves to
  loopback to reach this server from a victim's browser).
- **Origin check** — any request carrying a non-local `Origin` is rejected
  (blocks drive-by websites POSTing to the local port; browsers attach `Origin`
  to cross-site requests, including the "simple" ones that skip CORS preflight).
- Workspace file access is confined to the workspace dir (path-traversal
  rejected, lexically — same guard as the original).
- Code execution is opt-outable (`ALLOW_CODE_EXECUTION=0`), time-limited
  (`EXEC_TIMEOUT_MS`), runs in `workspace/sandbox/`, and is screened for
  process/network/shell/destructive calls. As in the original, this is a
  heuristic guardrail, **not** a hardened sandbox — don't run untrusted
  documents.

## Performance notes

- Release profile: `lto = true`, `codegen-units = 1`, `opt-level = "s"`,
  `strip = true`, `panic = "abort"` — smaller, faster binary.
- Hashed `assets/` (Monaco is ~3.6 MB) are served `immutable, max-age=1y` so the
  webview caches them across launches; `index.html` is `no-cache` so UI updates
  still land.
- One native process using the OS webview instead of Electron + a bundled
  Chromium + a Node backend process — **~160 MB idle vs Electron's ~320 MB**
  (see the chart above) and a faster cold start.
- Shared runtime-memory hygiene (both builds): the PDF preview destroys each
  pdf.js document on recompile, version history is capped per file, and the
  in-editor blob URLs are revoked — so RAM stays flat over a long editing session
  instead of climbing.

## Notes

- The Tauri app is ad-hoc signed automatically; the same first-launch
  Gatekeeper note as the Electron build applies.
- If the macOS dmg step fails with a Finder-automation error, approve the
  "control Finder" permission prompt, or build it manually with `hdiutil` (see
  the Build section).
