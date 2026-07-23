// Tauri shell: starts the embedded backend (Rust port of server.js) and opens
// the built UI in a native window — the Electron main.cjs, replicated.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod proofread;
mod server;

use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;

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
        vec![
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

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)?.flatten() {
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
        println!("  code execution: {}", if state.allow_exec { "ENABLED (sandbox/)" } else { "disabled" });
        server::serve(listener, state).await;
    });
}

// Every window's backend, by window label, for the close/exit hooks: the
// typst-watch preview processes and tinymist must be killed or they outlive
// the app. Several windows can live in this one process.
static BACKENDS: std::sync::Mutex<Vec<(String, Arc<server::AppState>)>> = std::sync::Mutex::new(Vec::new());
static NEXT_WINDOW: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

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
    tauri::WebviewWindowBuilder::new(handle, &label, tauri::WebviewUrl::External(url))
        .title("Hilbert")
        .inner_size(1440.0, 920.0)
        .min_inner_size(900.0, 600.0)
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

fn main() {
    augment_path();
    // A window opened from "New Window" is handed its own session file, so extra
    // windows restore and persist independently and never overwrite the primary
    // window's remembered project. Set before anything reads the session path.
    if let Some(path) = arg_value("--session-file") {
        std::env::set_var("HILBERT_SESSION_FILE", path);
    }
    if std::env::args().any(|a| a == "--headless") {
        headless_main();
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
                                        if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                                            h2.restart();
                                        }
                                    });
                                }
                            });
                    }
                }
            });

            let resource_dir = app.path().resource_dir().ok();
            set_bundled_tinymist(resource_dir.as_deref());

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
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| match event {
            // A closed window takes its preview watcher with it; the shared
            // per-workspace language servers stay for the remaining windows.
            tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } => {
                let state = BACKENDS
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(l, _)| *l == label)
                    .map(|(_, s)| s.clone());
                if let Some(state) = state {
                    tauri::async_runtime::block_on(server::shutdown_window(&state));
                }
            }
            tauri::RunEvent::Exit => {
                let states: Vec<_> = BACKENDS.lock().unwrap().iter().map(|(_, s)| s.clone()).collect();
                for state in states {
                    tauri::async_runtime::block_on(server::shutdown_children(&state));
                }
            }
            _ => {}
        });
}
