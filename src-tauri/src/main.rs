// Tauri shell: starts the embedded backend (Rust port of server.js) and opens
// the built UI in a native window — the Electron main.cjs, replicated.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod proofread;
mod sandbox;
mod server;

use std::fs;
use std::net::{TcpListener, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use serde::{Deserialize, Serialize};

// A GUI-launched app inherits a bare PATH (roughly /usr/bin:/bin on macOS/Linux),
// so it can't find typst/python/julia installed via Homebrew, cargo, etc. Prepend
// the usual install locations so spawned tools are found.
fn augment_path() {
    let home = dirs::home_dir().unwrap_or_default();
    // Platform-appropriate extra locations. CRITICAL: join with the OS path
    // separator — using ':' on Windows (where it must be ';') corrupts the whole
    // PATH, breaking `which()` for typst AND python (template installer + code
    // runner both stop working).
    let extra: Vec<PathBuf> = if cfg!(windows) {
        let local = std::env::var("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|_| home.join("AppData/Local"));
        let program_data =
            std::env::var("ProgramData").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(r"C:\ProgramData"));
        vec![
            // Where the Windows package managers put the shims they expect to be
            // called by name. winget does add its Links folder to the stored user
            // PATH, but a running program keeps the environment it was started
            // with, and the desktop hands every app a copy of the one it captured
            // at login. Install tinymist today and it answers in a new PowerShell
            // while Hilbert, started from that older environment, reports it as
            // missing — which is exactly what people have been seeing.
            local.join("Microsoft/WinGet/Links"),
            home.join("scoop/shims"),
            program_data.join("chocolatey/bin"),
            home.join(".cargo/bin"),
            home.join(".juliaup/bin"),
            local.join("Programs/Python/Launcher"), // the `py` launcher
        ]
    } else {
        vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/local/sbin"),
            home.join(".cargo/bin"),
            home.join(".juliaup/bin"),
            home.join(".local/bin"),
            PathBuf::from("/opt/local/bin"),
        ]
    };
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut parts: Vec<String> = extra.iter().filter(|p| p.exists()).map(|p| p.to_string_lossy().into_owned()).collect();
    parts.push(std::env::var("PATH").unwrap_or_default());
    std::env::set_var("PATH", parts.join(sep));
}

// Prefer the standard port, but fall back to an ephemeral one when it's taken.
fn bind_free_port(preferred: u16) -> (TcpListener, u16) {
    if let Ok(l) = TcpListener::bind(("127.0.0.1", preferred)) {
        return (l, preferred);
    }
    let l = TcpListener::bind(("127.0.0.1", 0)).expect("bind ephemeral port");
    let port = l.local_addr().unwrap().port();
    (l, port)
}

// The collaboration listener is deliberately separate from the loopback-only
// workspace API. It may be reachable from the LAN/campus, but exposes only the
// encrypted CRDT relay.
fn bind_collab_port(preferred: u16) -> std::io::Result<(TcpListener, u16)> {
    let listener = TcpListener::bind(("0.0.0.0", preferred))
        .or_else(|_| TcpListener::bind(("0.0.0.0", 0)))?;
    let port = listener.local_addr()?.port();
    Ok((listener, port))
}

fn collab_addresses() -> Vec<String> {
    let mut addresses = Vec::new();
    // Connecting a UDP socket selects the interface the OS would use for a
    // routed destination without sending any packet. This gives the useful
    // campus/LAN address on the common single-active-interface setup.
    if let Ok(socket) = UdpSocket::bind(("0.0.0.0", 0)) {
        if socket.connect(("192.0.2.1", 9)).is_ok() {
            if let Ok(local) = socket.local_addr() {
                if !local.ip().is_loopback() {
                    addresses.push(local.ip().to_string());
                }
            }
        }
    }
    addresses.push("127.0.0.1".into());
    addresses.dedup();
    addresses
}

fn start_embedded_sync_server() {
    // HILBERT_COLLAB=0 keeps the app strictly loopback-only for setups where
    // even an encrypted, room-gated listener on the LAN is unwanted.
    if matches!(
        std::env::var("HILBERT_COLLAB").ok().as_deref(),
        Some("0") | Some("off")
    ) {
        eprintln!("[hilbert-collab] direct session listener disabled by HILBERT_COLLAB");
        return;
    }
    let preferred = std::env::var("HILBERT_COLLAB_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(3020);
    match bind_collab_port(preferred) {
        Ok((listener, port)) => {
            let addresses = collab_addresses();
            server::set_embedded_collab_server(port, addresses.clone());
            eprintln!(
                "[hilbert-collab] direct session listener on {}",
                addresses
                    .iter()
                    .map(|address| format!("ws://{address}:{port}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            tauri::async_runtime::spawn(server::serve_sync_server(listener));
        }
        Err(error) => {
            eprintln!("[hilbert-collab] direct session listener unavailable: {error}");
        }
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)?.flatten() {
        if package_metadata(&entry.path()) {
            continue;
        }
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

// macOS archive tools can materialize Finder metadata as AppleDouble files
// when a source bundle is unpacked on Linux. They are not Typst package data,
// and trying to treat `._<version>` as a version directory creates a noisy
// startup error for every bundled package.
fn package_metadata(path: &Path) -> bool {
    path.file_name()
        .map(|name| {
            let name = name.to_string_lossy();
            name == ".DS_Store" || name.starts_with("._")
        })
        .unwrap_or(false)
}

// Copy the Typst packages bundled with the app into a writable cache dir and
// return that dir. Pointing typst at it (TYPST_PACKAGE_CACHE_PATH) means
// documents compile on any machine with no network / no downloads.
fn seed_packages(bundled_preview: &Path, cache_root: &Path) {
    if !bundled_preview.exists() {
        return;
    }
    let Ok(rd) = fs::read_dir(bundled_preview) else { return };
    for name in rd.flatten() {
        if !name.path().is_dir() {
            continue;
        }
        let Ok(vd) = fs::read_dir(name.path()) else { continue };
        for ver in vd.flatten() {
            if !ver.path().is_dir() || package_metadata(&ver.path()) {
                continue;
            }
            let dst = cache_root.join("preview").join(name.file_name()).join(ver.file_name());
            if !dst.exists() {
                if let Some(parent) = dst.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                if let Err(e) = copy_dir_recursive(&ver.path(), &dst) {
                    eprintln!("[typst-editor] package seed failed: {e}");
                }
            }
        }
    }
}

#[cfg(test)]
mod package_seed_tests {
    use super::package_metadata;
    use std::path::Path;

    #[test]
    fn package_seed_ignores_platform_metadata() {
        assert!(package_metadata(Path::new("._0.1.1")));
        assert!(package_metadata(Path::new(".DS_Store")));
        assert!(!package_metadata(Path::new("0.1.1")));
        assert!(!package_metadata(Path::new("src")));
    }
}

// Optional bundled tinymist for hover/completion: if a copy is present under the
// app resource dir (bin/tinymist) or beside the crate, use it; otherwise the
// backend falls back to `tinymist` on PATH. Not shipped by default (keeps the
// app small) — drop a binary in bin/ and re-add the tauri.conf resource entry.
fn find_bundled_tinymist(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(r) = resource_dir {
        candidates.push(r.join("bin").join("tinymist"));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin").join("tinymist"));
    candidates.into_iter().find(|p| p.exists())
}

fn set_bundled_tinymist(resource_dir: Option<&Path>) {
    if std::env::var_os("TINYMIST_BIN").is_some() {
        return;
    }
    if let Some(tm) = find_bundled_tinymist(resource_dir) {
        std::env::set_var("TINYMIST_BIN", tm);
        std::env::set_var("HILBERT_TINYMIST_SOURCE", "bundled");
    }
}

fn workspace_dir(default_docs: Option<PathBuf>) -> PathBuf {
    if let Ok(ws) = std::env::var("TYPST_WORKSPACE") {
        return PathBuf::from(ws);
    }
    let docs = default_docs
        .or_else(dirs::document_dir)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join("Documents"));
    // Renamed from "Typst Editor"; migrate the old Documents/TypstEditor folder to
    // Documents/Hilbert on first launch so existing users don't lose their files.
    let ws = docs.join("Hilbert");
    let legacy = docs.join("TypstEditor");
    if !ws.exists() && legacy.exists() {
        let _ = fs::rename(&legacy, &ws);
    }
    ws
}

// Bridge injected into the page: replaces the Electron preload (`window.desktop`)
// and the window-open handler (external links go to the real browser).
const INIT_SCRIPT: &str = r#"
(() => {
  if (window.__TYPST_DESKTOP__) return; window.__TYPST_DESKTOP__ = true;
  window.desktop = {
    pickFolder: async () => {
      try { const r = await fetch('/desktop/pick-folder', { method: 'POST' }); const j = await r.json(); return j.path || null; }
      catch { return null; }
    }
  };
  const isExternal = (u) => {
    try { const url = new URL(u, location.href);
      return (url.protocol === 'mailto:' || ((url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== location.origin));
    } catch { return false; }
  };
  const openExternal = (u) => { fetch('/desktop/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: u }) }).catch(() => {}); };
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a && isExternal(a.href)) { e.preventDefault(); openExternal(a.href); }
  }, true);
  const _open = window.open ? window.open.bind(window) : null;
  window.open = (u, ...rest) => {
    if (u && isExternal(String(u))) { openExternal(String(u)); return null; }
    return _open ? _open(u, ...rest) : null;
  };
})();
"#;

fn init_script(api_token: &str) -> String {
    format!(
        r#"Object.defineProperty(window,"__HILBERT_API_TOKEN__",{{value:"{api_token}",enumerable:false,writable:false,configurable:false}});"#
    ) + INIT_SCRIPT
}

fn sync_server_main() {
    let port: u16 = arg_value("--port").and_then(|p| p.parse().ok()).unwrap_or(3020);
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    rt.block_on(async {
        let listener = TcpListener::bind(("0.0.0.0", port)).expect("bind sync server port");
        println!("Hilbert collaboration server on ws://0.0.0.0:{port}/collab/<room>");
        println!("Collaborators connect to: ws://<this-machine-ip>:{port}");
        server::serve_sync_server(listener).await;
    });
}

// Where an installed build keeps the built UI. The windowed app asks Tauri for
// its resource directory, but hosted mode runs before any Tauri app exists, so
// the same layouts are derived from the executable: resources sit beside the
// binary on Windows, in Contents/Resources inside a .app, and under
// /usr/lib/Hilbert for a .deb or AppImage whose binary lives in /usr/bin.
fn dist_candidates(exe_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![exe_dir.join("dist")];
    if let Some(parent) = exe_dir.parent() {
        candidates.push(parent.join("Resources").join("dist"));
        candidates.push(parent.join("lib").join("Hilbert").join("dist"));
    }
    candidates
}

fn packaged_dist() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    dist_candidates(exe.parent()?)
        .into_iter()
        .find(|candidate| candidate.join("index.html").is_file())
}

#[cfg(test)]
mod packaged_dist_tests {
    use super::dist_candidates;
    use std::path::Path;

    #[test]
    fn hosted_mode_finds_the_ui_in_every_packaged_layout() {
        // Windows keeps resources beside the executable.
        let windows = dist_candidates(Path::new("/opt/Hilbert"));
        assert!(windows.contains(&Path::new("/opt/Hilbert/dist").to_path_buf()));
        // A macOS bundle: Contents/MacOS/hilbert -> Contents/Resources/dist.
        let macos = dist_candidates(Path::new("/Applications/Hilbert.app/Contents/MacOS"));
        assert!(macos.contains(&Path::new("/Applications/Hilbert.app/Contents/Resources/dist").to_path_buf()));
        // A .deb or AppImage: usr/bin/hilbert -> usr/lib/Hilbert/dist.
        let linux = dist_candidates(Path::new("/usr/bin"));
        assert!(linux.contains(&Path::new("/usr/lib/Hilbert/dist").to_path_buf()));
    }
}

fn hosted_server_main() {
    let Some(access_token) = std::env::var("HILBERT_SERVER_TOKEN")
        .ok()
        .filter(|token| token.len() >= 32)
    else {
        eprintln!("Hosted mode requires HILBERT_SERVER_TOKEN with at least 32 characters.");
        eprintln!("Set a long random token in the environment; it is the browser sign-in secret.");
        std::process::exit(2);
    };
    // A hosted workspace runs whatever its users write, and nobody is standing
    // over it. Unless the operator says otherwise, that means no sandbox, no
    // code — decided here, before anything is bound, so the banner below can
    // say what the answer turned out to be.
    sandbox::set_policy(sandbox::parse_policy(
        std::env::var("HILBERT_SANDBOX").ok().as_deref(),
        true,
    ));
    let bind = arg_value("--bind").unwrap_or_else(|| "127.0.0.1".into());
    let port: u16 = arg_value("--port").and_then(|value| value.parse().ok()).unwrap_or(3001);
    let workspace = arg_value("--workspace")
        .map(PathBuf::from)
        .or_else(|| std::env::var("TYPST_WORKSPACE").ok().map(PathBuf::from))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default().join("workspace"));
    if let Err(error) = fs::create_dir_all(&workspace) {
        eprintln!("Could not create hosted workspace {}: {error}", workspace.display());
        std::process::exit(2);
    }
    let dist = std::env::var("TYPST_DIST")
        .ok()
        .map(PathBuf::from)
        .or_else(packaged_dist)
        .or_else(|| {
            let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
            development.exists().then_some(development)
        })
        .filter(|path| path.join("index.html").is_file());
    let Some(dist) = dist else {
        eprintln!("Hosted mode needs the built web app. Run npm run build or set TYPST_DIST.");
        std::process::exit(2);
    };
    if std::env::var_os("HILBERT_SESSION_FILE").is_none() {
        std::env::set_var("HILBERT_SESSION_FILE", workspace.join(".hilbert/server-session.json"));
    }
    set_bundled_tinymist(None);
    let listener = TcpListener::bind((bind.as_str(), port)).unwrap_or_else(|error| {
        eprintln!("Could not bind hosted Hilbert on {bind}:{port}: {error}");
        std::process::exit(2);
    });
    let state = Arc::new(server::AppState::new_remote(workspace.clone(), Some(dist), access_token));
    println!("Hilbert hosted workspace: http://{bind}:{port}");
    println!("Workspace: {}", workspace.display());
    println!("Collaboration relay: ws://{bind}:{port}/collab/<room>");
    println!("Use HTTPS through a reverse proxy before exposing this service to the public internet.");
    println!("Sandbox: {}", sandbox::describe());
    server::note(format!("sandbox: {}", sandbox::describe()));
    match (state.allow_exec, sandbox::refusal()) {
        (false, _) => println!("Code execution: disabled (ALLOW_CODE_EXECUTION=0)"),
        (true, Some(reason)) => {
            println!("Code execution: REFUSED");
            println!("  {reason}");
        }
        (true, None) => println!("Code execution: ENABLED for signed-in users"),
    }
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    rt.block_on(async move {
        let shutdown_state = state.clone();
        tokio::spawn(async move {
            wait_for_process_signal().await;
            server::shutdown_children(&shutdown_state).await;
        });
        server::serve(listener, state).await;
    });
}

fn headless_main() {
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    rt.block_on(async {
        let ws = if std::env::var("TYPST_WORKSPACE").is_ok() {
            workspace_dir(None)
        } else {
            std::env::current_dir().unwrap_or_default().join("workspace")
        };
        let _ = fs::create_dir_all(&ws);
        set_bundled_tinymist(None);
        let dist = std::env::var("TYPST_DIST").map(PathBuf::from).ok();
        let preferred: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3001);
        let (listener, port) = bind_free_port(preferred);
        let state = Arc::new(server::AppState::new(ws, dist));
        // The spell/grammar dictionaries cost ~150 MB resident and proofreading is
        // off by default, so they load on the first /lint call instead of at boot.
        println!("Typst compiler server running on http://127.0.0.1:{port}");
        println!("  code execution: {}", if state.allow_exec { "ENABLED" } else { "disabled" });
        println!("  sandbox: {}", sandbox::describe());
        server::note(format!("sandbox: {}", sandbox::describe()));
        start_embedded_sync_server();
        let shutdown_state = state.clone();
        tokio::spawn(async move {
            wait_for_process_signal().await;
            server::shutdown_children(&shutdown_state).await;
        });
        server::serve(listener, state).await;
    });
}

#[cfg(unix)]
async fn wait_for_process_signal() {
    use tokio::signal::unix::{signal, SignalKind};

    let mut interrupt = signal(SignalKind::interrupt()).ok();
    let mut terminate = signal(SignalKind::terminate()).ok();
    match (&mut interrupt, &mut terminate) {
        (Some(interrupt), Some(terminate)) => {
            tokio::select! {
                _ = interrupt.recv() => {}
                _ = terminate.recv() => {}
            }
        }
        (Some(interrupt), None) => {
            interrupt.recv().await;
        }
        (None, Some(terminate)) => {
            terminate.recv().await;
        }
        (None, None) => std::future::pending::<()>().await,
    }
}

#[cfg(not(unix))]
async fn wait_for_process_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

// Every window's backend, by window label, for the close/exit hooks: the
// typst-watch preview processes and tinymist must be killed or they outlive
// the app. Several windows can live in this one process.
static BACKENDS: std::sync::Mutex<Vec<(String, Arc<server::AppState>)>> = std::sync::Mutex::new(Vec::new());
static NEXT_WINDOW: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
struct WindowGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

fn window_geometry_path(session: &Path) -> PathBuf {
    session.with_extension("window.json")
}

fn read_window_geometry(session: &Path) -> Option<WindowGeometry> {
    let raw = fs::read_to_string(window_geometry_path(session)).ok()?;
    let geometry: WindowGeometry = serde_json::from_str(&raw).ok()?;
    (geometry.width >= 900 && geometry.height >= 600 && geometry.width <= 32_768 && geometry.height <= 32_768)
        .then_some(geometry)
}

fn write_window_geometry(session: &Path, geometry: WindowGeometry) {
    let path = window_geometry_path(session);
    if let Some(parent) = path.parent() { let _ = fs::create_dir_all(parent); }
    let Ok(bytes) = serde_json::to_vec(&geometry) else { return };
    let tmp = path.with_extension(format!("window.json.tmp.{}", std::process::id()));
    if fs::write(&tmp, bytes).and_then(|_| fs::rename(&tmp, &path)).is_err() {
        let _ = fs::remove_file(tmp);
    }
}

// Keep enough of the title bar on a current display to recover the window by
// dragging it. A monitor unplugged between launches must not strand Hilbert at
// its old coordinates; size can still be restored while the OS chooses a safe
// position on the remaining display.
fn geometry_visible_on(geometry: WindowGeometry, monitors: &[(i32, i32, u32, u32)]) -> bool {
    monitors.iter().any(|&(x, y, width, height)| {
        let left = geometry.x.max(x) as i64;
        let right = (geometry.x as i64 + geometry.width as i64).min(x as i64 + width as i64);
        let top = geometry.y.max(y) as i64;
        let bottom = (geometry.y as i64 + geometry.height as i64).min(y as i64 + height as i64);
        right - left >= 120 && bottom - top >= 48
    })
}

fn session_for_window(label: &str) -> Option<PathBuf> {
    BACKENDS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .iter()
        .find(|(registered, _)| registered == label)
        .map(|(_, state)| state.session_file.clone())
}

fn capture_window_geometry(app: &tauri::AppHandle, label: &str, session: &Path) {
    use tauri::Manager;
    let Some(window) = app.get_webview_window(label) else { return };
    let maximized = window.is_maximized().unwrap_or(false);
    // Maximized bounds are the monitor, not the size/position to return to after
    // unmaximizing. Preserve the last normal rectangle and change only the flag.
    if maximized {
        if let Some(mut previous) = read_window_geometry(session) {
            previous.maximized = true;
            write_window_geometry(session, previous);
            return;
        }
    }
    let Ok(size) = window.inner_size() else { return };
    if size.width < 900 || size.height < 600 { return; }
    // Wayland deliberately withholds absolute window coordinates from clients.
    // Still remember size/maximized state there; X11, Windows and macOS also
    // provide outer_position and therefore restore the exact display placement.
    let previous = read_window_geometry(session);
    let (x, y) = window.outer_position()
        .map(|position| (position.x, position.y))
        .ok()
        .or_else(|| previous.map(|geometry| (geometry.x, geometry.y)))
        .unwrap_or((0, 0));
    write_window_geometry(session, WindowGeometry {
        x,
        y,
        width: size.width,
        height: size.height,
        maximized,
    });
}

static WINDOW_GEOMETRY_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
static WINDOW_GEOMETRY_PENDING: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, u64>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

fn schedule_window_geometry(app: tauri::AppHandle, label: String, session: PathBuf) {
    let sequence = WINDOW_GEOMETRY_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    WINDOW_GEOMETRY_PENDING.lock().unwrap_or_else(|error| error.into_inner()).insert(label.clone(), sequence);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let current = {
            let mut pending = WINDOW_GEOMETRY_PENDING.lock().unwrap_or_else(|error| error.into_inner());
            let current = pending.get(&label).copied();
            if current == Some(sequence) { pending.remove(&label); }
            current
        };
        if current == Some(sequence) {
            capture_window_geometry(&app, &label, &session);
        }
    });
}

#[cfg(test)]
mod window_geometry_tests {
    use super::{geometry_visible_on, window_geometry_path, WindowGeometry};
    use std::path::Path;

    #[test]
    fn window_geometry_has_an_independent_sidecar() {
        assert_eq!(window_geometry_path(Path::new("/tmp/session.json")), Path::new("/tmp/session.window.json"));
    }

    #[test]
    fn window_restore_accepts_multimonitor_coordinates_but_rejects_stranded_windows() {
        let monitors = [(-1920, 0, 1920, 1080), (0, 0, 2560, 1440)];
        let mut geometry = WindowGeometry { x: -1700, y: 80, width: 1200, height: 800, maximized: false };
        assert!(geometry_visible_on(geometry, &monitors));
        geometry.x = 2400; // enough of the title bar remains on the right display
        assert!(geometry_visible_on(geometry, &monitors));
        geometry.x = 4000;
        assert!(!geometry_visible_on(geometry, &monitors));
        geometry.x = 100;
        geometry.y = 2000;
        assert!(!geometry_visible_on(geometry, &monitors));
    }
}

// One window = its own port + backend + session, hosted in this process so the
// OS shows a single running app however many windows are open.
fn open_instance_window(
    handle: &tauri::AppHandle,
    label: String,
    ws: PathBuf,
    session: PathBuf,
    dist: Option<PathBuf>,
) -> tauri::Result<()> {
    let _ = fs::create_dir_all(&ws);
    let (listener, port) = bind_free_port(3001);
    let mut st = server::AppState::new(ws, dist.clone());
    let window_session = session.clone();
    st.session_file = session;
    let state = Arc::new(st);
    *state.app.lock().unwrap() = Some(handle.clone());
    // "New Window" from any window opens another one in this same process.
    // Window creation must happen on the main thread on macOS.
    let opener = handle.clone();
    let opener_dist = dist;
    *state.open_window.lock().unwrap() = Some(Box::new(move || {
        let h = opener.clone();
        let d = opener_dist.clone();
        let _ = opener.run_on_main_thread(move || {
            use tauri::Manager;
            let n = NEXT_WINDOW.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let ws = workspace_dir(h.path().document_dir().ok());
            let _ = open_instance_window(&h, format!("extra-{n}"), ws, server::new_window_session_path(), d);
        });
    }));
    let init_script = init_script(state.api_token());
    BACKENDS.lock().unwrap().push((label.clone(), state.clone()));
    tauri::async_runtime::spawn(server::serve(listener, state));

    let url: tauri::Url = format!("http://127.0.0.1:{port}").parse().unwrap();
    let window = tauri::WebviewWindowBuilder::new(handle, &label, tauri::WebviewUrl::External(url))
        .title("Hilbert")
        .inner_size(1440.0, 920.0)
        .min_inner_size(900.0, 600.0)
        // Avoid showing a default-sized window for one frame before its saved
        // rectangle is applied — especially visible when restoring maximized.
        .visible(false)
        // Let OS file drops reach the webview instead of being swallowed
        // by Tauri's native handler, so dragging files onto the file tree
        // fires the app's own drop upload.
        .disable_drag_drop_handler()
        .initialization_script(&init_script)
        // Open external links (mailto:, https:) in the real browser, not the app.
        .on_navigation(|url| {
            let scheme = url.scheme();
            if scheme == "http" || scheme == "https" {
                let host = url.host_str().unwrap_or("");
                if host == "127.0.0.1" || host == "localhost" {
                    return true;
                }
                let _ = open::that_detached(url.as_str());
                return false;
            }
            true
        })
        .build()?;
    if let Some(geometry) = read_window_geometry(&window_session) {
        let monitors: Vec<_> = window.available_monitors().unwrap_or_default().into_iter().map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            (position.x, position.y, size.width, size.height)
        }).collect();
        let _ = window.set_size(tauri::PhysicalSize::new(geometry.width, geometry.height));
        if geometry_visible_on(geometry, &monitors) {
            let _ = window.set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y));
        } else {
            let _ = window.center();
        }
        if geometry.maximized { let _ = window.maximize(); }
    }
    window.show()?;
    Ok(())
}

fn arg_value(flag: &str) -> Option<String> {
    let mut it = std::env::args();
    while let Some(a) = it.next() {
        if a == flag {
            return it.next();
        }
        if let Some(v) = a.strip_prefix(&format!("{flag}=")) {
            return Some(v.to_string());
        }
    }
    None
}

// WebKitGTK draws into a buffer it hands to the compositor over DMA-BUF. On a
// good number of Linux setups that handoff quietly produces nothing at all and
// the window comes up black — no error, no warning, the app otherwise running
// fine underneath. NVIDIA's driver, nouveau, virtual machines and remote
// desktops are the usual ones; confirmed here on a Quadro P400 on nouveau,
// black every time until this is set and correct every time after.
//
// The older path it falls back to costs a little compositing performance and
// nothing else, so the only machines that lose anything are the ones where the
// fast path already worked. Leave it overridable for them.
#[cfg(target_os = "linux")]
fn avoid_blank_webkit_window() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    avoid_blank_webkit_window();
    augment_path();
    // A window opened from "New Window" is handed its own session file, so extra
    // windows restore and persist independently and never overwrite the primary
    // window's remembered project. Set before anything reads the session path.
    if let Some(path) = arg_value("--session-file") {
        std::env::set_var("HILBERT_SESSION_FILE", path);
    }
    if std::env::args().any(|a| a == "--hosted-server" || a == "--serve") {
        hosted_server_main();
        return;
    }
    if std::env::args().any(|a| a == "--headless") {
        headless_main();
        return;
    }
    // Run purely as a collaboration sync server (e.g. on a Pi or a campus box):
    //   hilbert --sync-server --port 3020
    if std::env::args().any(|a| a == "--sync-server") {
        sync_server_main();
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            use tauri::Manager;

            // Auto-update: on launch, check the release feed; if a newer signed
            // build exists, ASK the user, then download + install + relaunch.
            // Fully in Rust (the UI is served from a local http URL). Best-effort:
            // a failed/absent check never blocks startup.
            let up_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
                use tauri_plugin_updater::UpdaterExt;
                if let Ok(updater) = up_handle.updater() {
                    if let Ok(Some(update)) = updater.check().await {
                        let notes = update.body.clone().unwrap_or_default();
                        let msg = format!(
                            "Hilbert {} is available (you have {}).\n\n{}\nUpdate now? The app will restart.",
                            update.version, update.current_version,
                            if notes.is_empty() { String::new() } else { format!("{}\n\n", notes.chars().take(300).collect::<String>()) }
                        );
                        let h2 = up_handle.clone();
                        up_handle
                            .dialog()
                            .message(msg)
                            .title("Update available")
                            .kind(MessageDialogKind::Info)
                            .buttons(MessageDialogButtons::OkCancelCustom("Update now".into(), "Later".into()))
                            .show(move |accepted| {
                                if accepted {
                                    tauri::async_runtime::spawn(async move {
                                        use tauri::Manager;
                                        // The download is ~16 MB, which is over a minute on a
                                        // slow link. Without a sign of it the app looks like it
                                        // ignored the click, so the progress goes in the title
                                        // bar, and a failure says so rather than leaving the
                                        // user waiting for a restart that is never coming.
                                        let window = h2.get_webview_window("main");
                                        let announce = |text: &str| {
                                            if let Some(w) = &window {
                                                let _ = w.set_title(text);
                                            }
                                        };
                                        announce("Hilbert — downloading update…");

                                        let progress_window = window.clone();
                                        let installing_window = window.clone();
                                        let mut downloaded: u64 = 0;
                                        let mut total: Option<u64> = None;
                                        let mut shown_percent = u64::MAX;
                                        let outcome = update
                                            .download_and_install(
                                                move |chunk, content_length| {
                                                    downloaded += chunk as u64;
                                                    if total.is_none() {
                                                        total = content_length;
                                                    }
                                                    let Some(w) = &progress_window else { return };
                                                    match total.filter(|size| *size > 0) {
                                                        // Retitling on every chunk is wasted work;
                                                        // the bar only changes each whole percent.
                                                        Some(size) => {
                                                            let percent = downloaded * 100 / size;
                                                            if percent != shown_percent {
                                                                shown_percent = percent;
                                                                let _ = w.set_title(&format!(
                                                                    "Hilbert — downloading update… {percent}%"
                                                                ));
                                                            }
                                                        }
                                                        // A server that sends no length still gets
                                                        // to show that something is happening.
                                                        None => {
                                                            let _ = w.set_title(&format!(
                                                                "Hilbert — downloading update… {} MB",
                                                                downloaded / (1024 * 1024)
                                                            ));
                                                        }
                                                    }
                                                },
                                                move || {
                                                    if let Some(w) = &installing_window {
                                                        let _ = w.set_title("Hilbert — installing update…");
                                                    }
                                                },
                                            )
                                            .await;

                                        match outcome {
                                            Ok(()) => h2.restart(),
                                            Err(error) => {
                                                announce("Hilbert");
                                                h2.dialog()
                                                    .message(format!(
                                                        "The update could not be installed.\n\n{error}\n\nNothing has changed and your work is safe. Try again later, or download the new version from the releases page."
                                                    ))
                                                    .title("Update failed")
                                                    .kind(MessageDialogKind::Warning)
                                                    .show(|_| {});
                                            }
                                        }
                                    });
                                }
                            });
                    }
                }
            });

            let resource_dir = app.path().resource_dir().ok();
            set_bundled_tinymist(resource_dir.as_deref());
            start_embedded_sync_server();

            // Built UI: bundled resource, overridable for development.
            let dist = std::env::var("TYPST_DIST")
                .map(PathBuf::from)
                .ok()
                .or_else(|| resource_dir.as_ref().map(|r| r.join("dist")))
                .or_else(|| {
                    cfg!(debug_assertions)
                        .then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist"))
                })
                .filter(|d| d.exists());

            // Seed bundled Typst packages into a writable cache and point the
            // compiler (and the Packages UI) at it.
            if std::env::var("TYPST_PACKAGE_CACHE_PATH").is_err() {
                let cache_root = app
                    .path()
                    .app_data_dir()
                    .unwrap_or_else(|_| dirs::data_dir().unwrap_or_default().join("com.kaziaburousan.hilbert"))
                    .join("typst-cache");
                if let Some(res) = resource_dir.as_ref() {
                    seed_packages(&res.join("typst-packages").join("preview"), &cache_root);
                }
                let _ = fs::create_dir_all(&cache_root);
                std::env::set_var("TYPST_PACKAGE_CACHE_PATH", &cache_root);
            }

            // Reopen the last project if its folder still exists (session restore),
            // otherwise fall back to the default documents workspace.
            let ws = server::saved_workspace()
                .unwrap_or_else(|| workspace_dir(app.path().document_dir().ok()));
            // Dictionaries load on the first /lint call; see the note in headless_main.
            open_instance_window(app.handle(), "main".into(), ws, server::session_file_path(), dist)?;
            #[cfg(unix)]
            {
                // Service managers and terminal launches stop the app with
                // SIGTERM/SIGINT. Turn that into a normal Tauri exit so every
                // window can release its listener, Typst watcher, and shared
                // language-server reference instead of orphaning children.
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    wait_for_process_signal().await;
                    handle.exit(0);
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match event {
            // Move/resize can fire dozens of times during one gesture. Debounce
            // the tiny sidecar write so remembering the window has no visible
            // CPU or disk cost.
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_),
                ..
            } => {
                if let Some(session) = session_for_window(&label) {
                    schedule_window_geometry(app.clone(), label, session);
                }
            }
            // Flush immediately at stable lifecycle edges; the delayed resize
            // task may not get another 300 ms if the user closes right away.
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Focused(false) | tauri::WindowEvent::CloseRequested { .. },
                ..
            } => {
                if let Some(session) = session_for_window(&label) {
                    capture_window_geometry(app, &label, &session);
                }
            }
            // A closed window takes its preview watcher with it; the shared
            // per-workspace language servers stay for the remaining windows.
            tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } => {
                // Remove the registry's Arc as well as shutting down the
                // watcher. Keeping it here used to keep every closed window's
                // backend state and port alive until the entire app exited.
                let state = {
                    let mut backends = BACKENDS.lock().unwrap_or_else(|e| e.into_inner());
                    backends
                        .iter()
                        .position(|(registered, _)| *registered == label)
                        .map(|index| backends.remove(index).1)
                };
                if let Some(state) = state {
                    tauri::async_runtime::block_on(server::shutdown_window(&state));
                }
            }
            tauri::RunEvent::Exit => {
                let states: Vec<_> = BACKENDS.lock().unwrap().iter().map(|(label, state)| (label.clone(), state.clone())).collect();
                for (label, state) in states {
                    capture_window_geometry(app, &label, &state.session_file);
                    tauri::async_runtime::block_on(server::shutdown_children(&state));
                }
            }
            _ => {}
        });
}
