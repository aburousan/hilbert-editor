// Rust port of the Typst Editor backend (server.js), endpoint-for-endpoint.
// The React UI is served from `dist` on the same origin, so the unmodified
// frontend build works exactly as it does under Electron + Express.
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State},
    http::{header, HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS, NON_ALPHANUMERIC};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{atomic::{AtomicU64, Ordering}, Arc, LazyLock, Mutex, RwLock},
    time::{Duration, Instant, SystemTime},
};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::Command;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Clone, serde::Serialize)]
pub struct Interp {
    pub label: String,
    pub path: String,
    // Added by hand through Settings → Interpreters (and removable there),
    // as opposed to one we found by scanning the usual install locations.
    pub custom: bool,
}

impl Interp {
    fn found(label: impl Into<String>, path: impl Into<String>) -> Self {
        Interp { label: label.into(), path: path.into(), custom: false }
    }
}

#[derive(Clone, serde::Serialize, Default)]
pub struct Interpreters {
    pub python: Vec<Interp>,
    pub julia: Vec<Interp>,
    pub wolfram: Vec<Interp>,
}

impl Interpreters {
    fn for_lang(&self, lang: &str) -> &[Interp] {
        match lang {
            "python" => &self.python,
            "julia" => &self.julia,
            "wolfram" => &self.wolfram,
            _ => &[],
        }
    }

    fn for_lang_mut(&mut self, lang: &str) -> Option<&mut Vec<Interp>> {
        match lang {
            "python" => Some(&mut self.python),
            "julia" => Some(&mut self.julia),
            "wolfram" => Some(&mut self.wolfram),
            _ => None,
        }
    }

    // Append entries we haven't already got, comparing by path so a hand-added
    // interpreter that detection later learns to find doesn't show up twice.
    fn merge(&mut self, other: &Interpreters) {
        for lang in ["python", "julia", "wolfram"] {
            let extra: Vec<Interp> = other
                .for_lang(lang)
                .iter()
                .filter(|c| !self.for_lang(lang).iter().any(|have| same_path(&have.path, &c.path)))
                .cloned()
                .collect();
            if let Some(list) = self.for_lang_mut(lang) {
                list.extend(extra);
            }
        }
    }
}

// Windows paths are case-insensitive and users type them with either slash, so
// comparing the raw strings would let the same interpreter be added twice.
fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let s = s.replace('\\', "/");
        if cfg!(windows) { s.to_lowercase() } else { s }
    };
    norm(a) == norm(b)
}

// A universe package with its searchable text lowercased once at index time,
// so a search request doesn't re-allocate a haystack per package per keystroke.
pub struct Pkg {
    pub value: Value,
    pub name_lc: String,
    pub hay: String,
}

#[derive(Clone, Debug)]
enum PreviewOutcome {
    Waiting,
    Success,
    Error(String),
    Unavailable,
}

#[derive(Clone, Debug)]
struct PreviewEvent {
    generation: u64,
    outcome: PreviewOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PreviewKey {
    workspace: PathBuf,
    main: PathBuf,
    font_signature: u64,
}

struct PreviewWatcher {
    key: PreviewKey,
    child: tokio::process::Child,
    events: tokio::sync::watch::Receiver<PreviewEvent>,
}

pub struct AppState {
    pub workspace: RwLock<PathBuf>,
    pub dist: Option<PathBuf>,
    api_token: String,
    // Interpreters found by scanning the usual install locations, plus the ones
    // the user added by hand (persisted, so they survive a restart).
    pub detected: Interpreters,
    pub custom: RwLock<Interpreters>,
    pub allow_exec: bool,
    pub exec_timeout_ms: u64,
    source_generation: AtomicU64,
    preview_watcher: tokio::sync::Mutex<Option<PreviewWatcher>>,
    pub compile_gate: tokio::sync::Semaphore,
    pub render_gate: tokio::sync::Semaphore,
    pub exec_gate: tokio::sync::Semaphore,
    pub universe: tokio::sync::Mutex<Option<(Instant, Arc<Vec<Pkg>>)>>,
    pub http: reqwest::Client,
    pub app: Mutex<Option<tauri::AppHandle>>,
    // Windows persist their session separately, so a second window never
    // overwrites the project the first one will restore on the next launch.
    pub session_file: PathBuf,
    // Set by the GUI shell: opens another window IN THIS process (one Dock
    // icon). When absent — headless — /app/new-window spawns a process instead.
    pub open_window: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

impl AppState {
    pub fn new(workspace: PathBuf, dist: Option<PathBuf>) -> Self {
        let mut token_bytes = [0u8; 32];
        getrandom::fill(&mut token_bytes).expect("operating-system randomness for API token");
        let generated_token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token_bytes);
        let api_token = std::env::var("HILBERT_API_TOKEN")
            .ok()
            .filter(|token| token.len() >= 32)
            .unwrap_or(generated_token);
        AppState {
            workspace: RwLock::new(workspace),
            dist,
            api_token,
            detected: detect_interpreters(),
            custom: RwLock::new(load_custom_interpreters()),
            allow_exec: std::env::var("ALLOW_CODE_EXECUTION").ok().as_deref() != Some("0"),
            exec_timeout_ms: std::env::var("EXEC_TIMEOUT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(45000),
            source_generation: AtomicU64::new(0),
            preview_watcher: tokio::sync::Mutex::new(None),
            compile_gate: tokio::sync::Semaphore::new(1),
            render_gate: tokio::sync::Semaphore::new(2),
            exec_gate: tokio::sync::Semaphore::new(1),
            universe: tokio::sync::Mutex::new(None),
            http: reqwest::Client::builder().redirect(reqwest::redirect::Policy::limited(10)).build().unwrap(),
            app: Mutex::new(None),
            session_file: session_file(),
            open_window: Mutex::new(None),
        }
    }

    fn ws(&self) -> PathBuf {
        // Recover from a poisoned lock instead of panicking: a workspace path is
        // always readable, and one panicked handler shouldn't wedge every request.
        self.workspace.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn api_token(&self) -> &str {
        &self.api_token
    }

    // Everything the user may run right now: what we found on the system, the
    // virtualenv living in the open project (uv/venv put one there, and it is
    // almost always the right answer), then anything added by hand. Computed per
    // request rather than cached because opening another project changes it.
    fn available(&self) -> Interpreters {
        let mut all = self.detected.clone();
        all.merge(&workspace_interpreters(&self.ws()));
        all.merge(&self.custom.read().unwrap_or_else(|e| e.into_inner()));
        all
    }
}

type St = State<Arc<AppState>>;
type Q = Query<HashMap<String, String>>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn json_err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

fn text_err(status: StatusCode, msg: &'static str) -> Response {
    (status, msg).into_response()
}

fn parse_json(body: &Bytes) -> Value {
    serde_json::from_slice(body).unwrap_or(Value::Null)
}

fn jstr<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

// Node's path.resolve is purely lexical (no symlink resolution) — mirror that.
fn lexical_resolve(base: &Path, p: &str) -> PathBuf {
    let path = Path::new(p);
    let mut result = if path.is_absolute() { PathBuf::from("/") } else { base.to_path_buf() };
    for comp in path.components() {
        match comp {
            Component::RootDir | Component::Prefix(_) | Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            Component::Normal(c) => result.push(c),
        }
    }
    result
}

// Confine a user-supplied path to the workspace. The lexical check rejects
// traversal, while canonicalizing the nearest existing ancestor also prevents
// an in-workspace symlink from redirecting reads or writes outside the project.
fn safe_workspace_path(ws: &Path, p: &str) -> Option<PathBuf> {
    if p.is_empty() {
        return None;
    }
    let target = lexical_resolve(ws, p);
    if target != ws && !target.starts_with(ws) {
        return None;
    }

    let canonical_ws = fs::canonicalize(ws).ok()?;
    let mut existing = target.as_path();
    while !existing.exists() {
        existing = existing.parent()?;
    }
    let canonical_existing = fs::canonicalize(existing).ok()?;
    if canonical_existing != canonical_ws && !canonical_existing.starts_with(&canonical_ws) {
        return None;
    }
    Some(target)
}

fn epoch_ms(t: SystemTime) -> f64 {
    t.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

struct CmdOut {
    code: Option<i32>,
    killed: bool,
    stdout: String,
    stderr: String,
}

// Run a command, capture output, kill it after `timeout_ms` (if given).
// When the app runs from a Linux AppImage, the AppRun launcher exports
// PYTHONHOME / PYTHONPATH / LD_LIBRARY_PATH pointing inside the mounted image
// (e.g. /tmp/.mount_XXXX/usr). Those leak into any tool we spawn: the user's
// system python3 then hunts for its standard library inside the image and dies
// with "No module named 'encodings'". When we detect the image, drop the
// injected values so spawned interpreters use their own environment. Parts of
// LD_LIBRARY_PATH that don't belong to the image are preserved.
#[cfg(target_os = "linux")]
fn strip_appimage_env(cmd: &mut Command) {
    if std::env::var("APPIMAGE").is_err() && std::env::var("APPDIR").is_err() {
        return; // not launched from an AppImage
    }
    let appdir = std::env::var("APPDIR").ok().filter(|d| !d.is_empty());
    let looks_injected = |v: &str| {
        v.contains("/.mount_") || appdir.as_deref().map_or(false, |d| v.contains(d))
    };
    for key in ["PYTHONHOME", "PYTHONPATH"] {
        if std::env::var(key).map(|v| looks_injected(&v)).unwrap_or(false) {
            cmd.env_remove(key);
        }
    }
    if let Ok(v) = std::env::var("LD_LIBRARY_PATH") {
        let kept: Vec<&str> = v.split(':').filter(|s| !s.is_empty() && !looks_injected(s)).collect();
        if kept.is_empty() {
            cmd.env_remove("LD_LIBRARY_PATH");
        } else {
            cmd.env("LD_LIBRARY_PATH", kept.join(":"));
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn strip_appimage_env(_cmd: &mut Command) {}

// Cap on captured stdout/stderr. A runaway `while True: print(...)` can emit
// gigabytes long before the wall-clock timeout fires; without a cap the backend
// buffers all of it and can OOM. We keep draining the pipe (so a benign, slightly
// chatty program still exits cleanly) but stop storing past the cap.
const MAX_CAPTURE: usize = 8 * 1024 * 1024;

async fn read_capped<R: tokio::io::AsyncRead + Unpin>(mut r: R) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut buf = [0u8; 64 * 1024];
    let mut truncated = false;
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if out.len() < MAX_CAPTURE {
                    let take = n.min(MAX_CAPTURE - out.len());
                    out.extend_from_slice(&buf[..take]);
                    if out.len() >= MAX_CAPTURE { truncated = true; }
                }
            }
        }
    }
    (out, truncated)
}

async fn run_cmd(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    timeout_ms: Option<u64>,
) -> std::io::Result<CmdOut> {
    run_cmd_inner(program, args, cwd, timeout_ms, false).await
}

// Like run_cmd, but for untrusted user code: applies per-process OS resource
// limits (max file size, CPU seconds) on top of the wall-clock timeout so a
// runaway cell can't fill the disk or peg a core if the kill is ever missed.
async fn run_exec_cmd(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    timeout_ms: Option<u64>,
) -> std::io::Result<CmdOut> {
    run_cmd_inner(program, args, cwd, timeout_ms, true).await
}

async fn run_cmd_inner(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    timeout_ms: Option<u64>,
    sandboxed: bool,
) -> std::io::Result<CmdOut> {
    let mut cmd = Command::new(program);
    // Windows: don't flash a console window for each spawned tool (typst, git,
    // python, julia…). CREATE_NO_WINDOW = 0x08000000. No-op on other platforms.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    // Never let a spawned tool block on an interactive prompt. Without this a
    // `git push` that needs a password (no TTY available) would hang the request
    // instead of failing fast. Harmless to the other tools we run.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    strip_appimage_env(&mut cmd);
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    // Defence-in-depth for code execution: hard caps enforced by the kernel on the
    // child. RLIMIT_FSIZE stops disk-fill; RLIMIT_CPU is a generous backstop to the
    // wall-clock timeout. Kept loose enough not to disturb normal numerical work.
    #[cfg(unix)]
    if sandboxed {
        let cpu_secs = timeout_ms.map(|ms| ms / 1000 + 30).unwrap_or(180);
        unsafe {
            cmd.pre_exec(move || {
                // The resource argument is c_int on macOS/BSD but __rlimit_resource_t
                // (u32) on Linux, so let the compiler infer it from the constant
                // rather than naming a type that is only right on one platform.
                let set = |res, cur: u64, max: u64| {
                    let lim = libc::rlimit { rlim_cur: cur as libc::rlim_t, rlim_max: max as libc::rlim_t };
                    libc::setrlimit(res, &lim);
                };
                set(libc::RLIMIT_FSIZE, 256 * 1024 * 1024, 256 * 1024 * 1024);
                set(libc::RLIMIT_CPU, cpu_secs, cpu_secs + 5);
                Ok(())
            });
        }
    }
    let _ = sandboxed; // (Windows: limits are enforced by the wall-clock timeout only.)
    let mut child = cmd.spawn()?;
    let so = child.stdout.take().unwrap();
    let se = child.stderr.take().unwrap();
    let so_task = tokio::spawn(read_capped(so));
    let se_task = tokio::spawn(read_capped(se));
    let dur = Duration::from_millis(timeout_ms.unwrap_or(u64::MAX / 1000));
    let mut killed = false;
    let code = match tokio::time::timeout(dur, child.wait()).await {
        Ok(Ok(status)) => status.code(),
        Ok(Err(_)) => None,
        Err(_) => {
            killed = true;
            let _ = child.start_kill();
            let _ = child.wait().await;
            None
        }
    };
    let (so_bytes, so_trunc) = so_task.await.unwrap_or_default();
    let (se_bytes, se_trunc) = se_task.await.unwrap_or_default();
    let mut stdout = String::from_utf8_lossy(&so_bytes).into_owned();
    let stderr = String::from_utf8_lossy(&se_bytes).into_owned();
    if so_trunc || se_trunc {
        stdout.push_str("\n[output truncated — exceeded 8 MB]");
    }
    Ok(CmdOut { code, killed, stdout, stderr })
}

const TYPST_NOT_FOUND: &str = "Typst compiler not found. Install the Typst CLI (macOS: `brew install typst`; Linux: a release binary from github.com/typst/typst or `cargo install typst-cli`) so that `typst --version` works, then restart the editor.";
const TYPST_NOT_FOUND_SHORT: &str = "Typst compiler not found — install the Typst CLI so `typst --version` works.";

async fn toolchain_status() -> Response {
    let Some(path) = which("typst") else {
        return Json(json!({
            "typst": { "available": false },
            "features": { "html": false, "bundle": false, "multiplePdfStandards": false }
        }))
        .into_response();
    };
    let output = run_cmd(&path, &["--version"], None, Some(3000)).await.ok();
    let raw = output
        .map(|out| if out.stdout.trim().is_empty() { out.stderr } else { out.stdout })
        .unwrap_or_default();
    static VERSION_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\b(\d+\.\d+(?:\.\d+)?)\b").unwrap());
    let version = VERSION_RE
        .captures(&raw)
        .and_then(|caps| caps.get(1))
        .map(|value| value.as_str())
        .unwrap_or("");
    let html = cmp_version(version, "0.13.0") != std::cmp::Ordering::Less;
    let v15 = cmp_version(version, "0.15.0") != std::cmp::Ordering::Less;
    Json(json!({
        "typst": {
            "available": true,
            "version": version,
            "label": raw.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim(),
            "path": path,
        },
        "features": {
            "html": html,
            "bundle": v15,
            "multiplePdfStandards": v15,
            "variableFonts": v15,
        }
    }))
    .into_response()
}

// ---------------------------------------------------------------------------
// Workspace file tree + files
// ---------------------------------------------------------------------------

fn get_tree(dir: &Path, ws: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else { return out };
    let mut items: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    items.sort();
    for item in items {
        // Hide dotfiles, node_modules and the sandbox scratch dir. PDFs (both the
        // compiled out.pdf and any the user adds) stay visible so they can be
        // opened and downloaded from the tree.
        if item.starts_with('.') || item == "node_modules" || item == "sandbox" {
            continue;
        }
        let full = dir.join(&item);
        let Ok(kind) = fs::symlink_metadata(&full).map(|m| m.file_type()) else { continue };
        if kind.is_symlink() {
            continue;
        }
        let Ok(st) = fs::metadata(&full) else { continue };
        let rel = full.strip_prefix(ws).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        if st.is_dir() {
            out.push(json!({ "type": "directory", "name": item, "path": rel, "children": get_tree(&full, ws) }));
        } else {
            let mtime = st.modified().map(epoch_ms).unwrap_or(0.0);
            out.push(json!({ "type": "file", "name": item, "path": rel, "size": st.len(), "mtime": mtime }));
        }
    }
    out
}

async fn workspace_tree(State(st): St) -> Response {
    let ws = st.ws();
    Json(get_tree(&ws, &ws)).into_response()
}

async fn workspace_root_get(State(st): St) -> Response {
    Json(json!({ "root": st.ws().to_string_lossy() })).into_response()
}

async fn workspace_root_post(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let Some(raw) = jstr(&v, "path").map(str::trim).filter(|s| !s.is_empty()) else {
        return json_err(StatusCode::BAD_REQUEST, "Folder path required.");
    };
    let home = dirs::home_dir().unwrap_or_default();
    let expanded = if raw == "~" {
        home.to_string_lossy().into_owned()
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home.join(rest).to_string_lossy().into_owned()
    } else {
        raw.to_string()
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let resolved = lexical_resolve(&cwd, &expanded);
    match fs::metadata(&resolved) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return json_err(StatusCode::BAD_REQUEST, format!("Not a folder: {}", resolved.display())),
        Err(_) => return json_err(StatusCode::BAD_REQUEST, format!("Not a folder: {}", resolved.display())),
    }
    let old_ws = st.ws();
    *st.workspace.write().unwrap_or_else(|e| e.into_inner()) = resolved.clone();
    stop_preview_watcher(&st).await;
    // The old project's language server is no longer needed here. If another
    // window still shows that project it simply respawns on its next request.
    stop_lsp_for(&old_ws).await;
    Json(json!({ "ok": true, "root": resolved.to_string_lossy() })).into_response()
}

// Empty the current workspace (browser "Open Folder" imports into it).
async fn workspace_clear(State(st): St) -> Response {
    let ws = st.ws();
    let rd = match fs::read_dir(&ws) {
        Ok(r) => r,
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    for entry in rd.flatten() {
        if entry.file_name() == ".git" {
            continue;
        }
        let p = entry.path();
        let _ = if p.is_dir() { fs::remove_dir_all(&p) } else { fs::remove_file(&p) };
    }
    Json(json!({ "ok": true })).into_response()
}

async fn workspace_file_get(State(st): St, Query(q): Q) -> Response {
    let Some(full) = q.get("path").and_then(|p| safe_workspace_path(&st.ws(), p)) else {
        return text_err(StatusCode::BAD_REQUEST, "Invalid path");
    };
    match fs::read(&full) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned().into_response(),
        Err(_) => text_err(StatusCode::NOT_FOUND, "Not found"),
    }
}

async fn workspace_file_state(State(st): St, Query(q): Q) -> Response {
    let Some(full) = q.get("path").and_then(|p| safe_workspace_path(&st.ws(), p)) else {
        return json_err(StatusCode::BAD_REQUEST, "Invalid path");
    };
    match fs::read_to_string(&full) {
        Ok(content) => {
            let hash = format!("{:016x}", content_hash(&content));
            if q.get("content").map(String::as_str) == Some("0") {
                Json(json!({ "hash": hash })).into_response()
            } else {
                Json(json!({ "content": content, "hash": hash })).into_response()
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Json(json!({ "content": "", "hash": Value::Null, "missing": true })).into_response()
        }
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// Hashes for several open files in one round-trip. The editor polls every open
// tab for external changes; doing that as one request instead of one per tab
// keeps the poll cheap however many files are open. Missing files hash to null.
async fn workspace_files_state(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let ws = st.ws();
    let mut states = serde_json::Map::new();
    if let Some(paths) = v.get("paths").and_then(Value::as_array) {
        for p in paths.iter().take(64).filter_map(Value::as_str) {
            let Some(full) = safe_workspace_path(&ws, p) else { continue };
            let hash = fs::read_to_string(&full)
                .ok()
                .map(|c| Value::String(format!("{:016x}", content_hash(&c))))
                .unwrap_or(Value::Null);
            states.insert(p.to_string(), hash);
        }
    }
    Json(json!({ "states": states })).into_response()
}

async fn workspace_file_post(State(st): St, Query(q): Q, headers: HeaderMap, body: Bytes) -> Response {
    let Some(full) = q.get("path").and_then(|p| safe_workspace_path(&st.ws(), p)) else {
        return text_err(StatusCode::BAD_REQUEST, "Invalid path");
    };
    // Accept both a raw text body and JSON { content } — like express.text/json.
    let is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("application/json"))
        .unwrap_or(false);
    let content: Vec<u8> = if is_json {
        parse_json(&body).get("content").and_then(|c| c.as_str()).unwrap_or("").as_bytes().to_vec()
    } else {
        body.to_vec()
    };
    if let Some(expected) = headers.get(header::IF_MATCH).and_then(|v| v.to_str().ok()) {
        let current = fs::read_to_string(&full).unwrap_or_default();
        let current_hash = format!("{:016x}", content_hash(&current));
        if expected != current_hash {
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "The file changed outside Hilbert.",
                    "content": current,
                    "hash": current_hash,
                })),
            )
                .into_response();
        }
    }
    if let Some(parent) = full.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match fs::write(&full, content) {
        Ok(_) => {
            st.source_generation.fetch_add(1, Ordering::AcqRel);
            let saved = fs::read_to_string(&full).unwrap_or_default();
            Json(json!({ "ok": true, "hash": format!("{:016x}", content_hash(&saved)) })).into_response()
        }
        Err(_) => text_err(StatusCode::INTERNAL_SERVER_ERROR, "Error"),
    }
}

async fn workspace_file_delete(State(st): St, Query(q): Q) -> Response {
    let ws = st.ws();
    let Some(full) = q.get("path").and_then(|p| safe_workspace_path(&ws, p)) else {
        return text_err(StatusCode::BAD_REQUEST, "Invalid path");
    };
    if full == ws {
        return text_err(StatusCode::BAD_REQUEST, "Invalid path");
    }
    let res = match fs::metadata(&full) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(&full),
        _ => fs::remove_file(&full),
    };
    match res {
        Ok(_) => "OK".into_response(),
        Err(_) => text_err(StatusCode::INTERNAL_SERVER_ERROR, "Error"),
    }
}

async fn workspace_mkdir(State(st): St, Query(q): Q) -> Response {
    let Some(full) = q.get("path").and_then(|p| safe_workspace_path(&st.ws(), p)) else {
        return text_err(StatusCode::BAD_REQUEST, "Invalid path");
    };
    match fs::create_dir_all(&full) {
        Ok(_) => "OK".into_response(),
        Err(_) => text_err(StatusCode::INTERNAL_SERVER_ERROR, "Error"),
    }
}

async fn workspace_upload(State(st): St, Query(q): Q, body: Bytes) -> Response {
    let Some(full) = q.get("path").and_then(|p| safe_workspace_path(&st.ws(), p)) else {
        return text_err(StatusCode::BAD_REQUEST, "Invalid path");
    };
    if let Some(parent) = full.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match fs::write(&full, body) {
        Ok(_) => "OK".into_response(),
        Err(_) => text_err(StatusCode::INTERNAL_SERVER_ERROR, "Error"),
    }
}

// Convert an uploaded spreadsheet (xlsx/xls/xlsb/ods) into one CSV per sheet.
// Typst only reads CSV natively, so Excel import goes through here — fully
// offline, no dependency on Excel or a Python/pandas install.
async fn data_xlsx(body: Bytes) -> Response {
    use calamine::{open_workbook_auto_from_rs, Data, Reader};
    let mut wb = match open_workbook_auto_from_rs(std::io::Cursor::new(body.to_vec())) {
        Ok(w) => w,
        Err(e) => return json_err(StatusCode::BAD_REQUEST, format!("Could not read spreadsheet: {e}")),
    };
    fn field(c: &Data) -> String {
        let s = if matches!(c, Data::Empty) { String::new() } else { c.to_string() };
        if s.contains(['"', ',', '\n', '\r']) {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s
        }
    }
    let mut sheets = Vec::new();
    for name in wb.sheet_names().to_owned() {
        let Ok(range) = wb.worksheet_range(&name) else { continue };
        let mut csv = String::new();
        for row in range.rows() {
            let cols: Vec<String> = row.iter().map(field).collect();
            csv.push_str(&cols.join(","));
            csv.push('\n');
        }
        sheets.push(json!({ "name": name, "csv": csv, "rows": range.height(), "cols": range.width() }));
    }
    if sheets.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "No readable sheets in that file.");
    }
    Json(json!({ "sheets": sheets })).into_response()
}

// Save a base64 data-URL image into the workspace (3D Plot Studio).
async fn workspace_save_image(State(st): St, body: Bytes) -> Response {
    static DATA_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)^data:image/\w+;base64,(.+)$").unwrap());
    let v = parse_json(&body);
    let path = jstr(&v, "path").unwrap_or("");
    let Some(full) = safe_workspace_path(&st.ws(), path) else {
        return json_err(StatusCode::BAD_REQUEST, "Invalid path");
    };
    let data_url = jstr(&v, "dataUrl").unwrap_or("");
    let Some(caps) = DATA_URL.captures(data_url) else {
        return json_err(StatusCode::BAD_REQUEST, "Invalid image data.");
    };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(caps[1].replace(['\n', '\r'], "")) else {
        return json_err(StatusCode::BAD_REQUEST, "Invalid image data.");
    };
    if let Some(parent) = full.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match fs::write(&full, bytes) {
        Ok(_) => Json(json!({ "ok": true, "path": path })).into_response(),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// Copy a file within the workspace (e.g. promote a sandbox plot into images/).
async fn workspace_copy(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let ws = st.ws();
    let (Some(src), Some(dst)) = (
        jstr(&v, "from").and_then(|p| safe_workspace_path(&ws, p)),
        jstr(&v, "to").and_then(|p| safe_workspace_path(&ws, p)),
    ) else {
        return json_err(StatusCode::BAD_REQUEST, "Invalid path");
    };
    if !src.exists() {
        return json_err(StatusCode::NOT_FOUND, "Source not found.");
    }
    if let Some(parent) = dst.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match fs::copy(&src, &dst) {
        Ok(_) => Json(json!({ "ok": true, "path": jstr(&v, "to").unwrap_or("") })).into_response(),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// Rename / move a file or folder within the workspace.
async fn workspace_rename(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let ws = st.ws();
    let (Some(src), Some(dst)) = (
        jstr(&v, "from").and_then(|p| safe_workspace_path(&ws, p)),
        jstr(&v, "to").and_then(|p| safe_workspace_path(&ws, p)),
    ) else {
        return json_err(StatusCode::BAD_REQUEST, "Invalid path");
    };
    if !src.exists() {
        return json_err(StatusCode::NOT_FOUND, "Source not found.");
    }
    if dst.exists() {
        return json_err(StatusCode::CONFLICT, "Destination already exists.");
    }
    if let Some(parent) = dst.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match fs::rename(&src, &dst) {
        Ok(_) => Json(json!({ "ok": true, "path": jstr(&v, "to").unwrap_or("") })).into_response(),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// Reveal a file or folder in the native OS file manager.
async fn workspace_reveal(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let ws = st.ws();
    let target = jstr(&v, "path").and_then(|p| safe_workspace_path(&ws, p)).unwrap_or_else(|| ws.clone());
    if !target.exists() {
        return json_err(StatusCode::NOT_FOUND, "Path not found");
    }
    reveal_in_file_manager(&target);
    Json(json!({ "ok": true })).into_response()
}

async fn app_new_window(State(st): St) -> Response {
    // In the GUI the shell registers an opener that creates the window inside
    // this process, so the OS shows one app with several windows rather than a
    // second Dock icon per window.
    {
        let guard = st.open_window.lock().unwrap();
        if let Some(open) = guard.as_ref() {
            open();
            return Json(json!({ "ok": true })).into_response();
        }
    }
    match spawn_new_instance() {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Could not open a new window: {e}")),
    }
}

// Full-text search across the workspace (skips dotfiles, binaries, build output).
async fn workspace_search(State(st): St, Query(q): Q) -> Response {
    let query = q.get("q").map(|s| s.to_lowercase()).unwrap_or_default();
    if query.is_empty() {
        return Json(json!([])).into_response();
    }
    let ws = st.ws();
    let results = tokio::task::spawn_blocking(move || {
        let mut results: Vec<Value> = Vec::new();
        search_walk(&ws, &ws, &query, &mut results);
        results
    })
    .await
    .unwrap_or_default();
    Json(results).into_response()
}

fn search_walk(dir: &Path, ws: &Path, q: &str, out: &mut Vec<Value>) {
    if out.len() >= 200 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        if out.len() >= 200 {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" || name == "sandbox" || name.ends_with(".pdf") {
            continue;
        }
        let full = entry.path();
        if entry.file_type().map(|t| t.is_symlink()).unwrap_or(true) {
            continue;
        }
        let Ok(meta) = fs::metadata(&full) else { continue };
        if meta.is_dir() {
            search_walk(&full, ws, q, out);
            continue;
        }
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        if matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "bmp" | "zip" | "tar" | "gz") {
            continue;
        }
        // Skip very large files — reading a huge data file into memory would stall
        // search and spike RAM.
        if meta.len() > 2 * 1024 * 1024 {
            continue;
        }
        let Ok(bytes) = fs::read(&full) else { continue };
        let Ok(content) = String::from_utf8(bytes) else { continue };
        let lower = content.to_lowercase();
        if !lower.contains(q) {
            continue;
        }
        let matches: Vec<Value> = content
            .lines()
            .zip(lower.lines())
            .enumerate()
            .filter(|(_, (_, folded))| folded.contains(q))
            .take(100)
            .map(|(i, (line, _))| json!({ "lineNum": i + 1, "text": line.trim() }))
            .collect();
        if !matches.is_empty() {
            let rel = full.strip_prefix(ws).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            out.push(json!({ "path": rel, "matches": matches }));
        }
    }
}

// Serve a raw workspace file (e.g. image / file preview) with a guessed MIME type.
async fn workspace_raw(State(st): St, Query(q): Q) -> Response {
    let Some(full) = q.get("path").and_then(|p| safe_workspace_path(&st.ws(), p)) else {
        return text_err(StatusCode::BAD_REQUEST, "Invalid path");
    };
    match fs::read(&full) {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&full).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], bytes).into_response()
        }
        Err(_) => text_err(StatusCode::NOT_FOUND, "Not found"),
    }
}

// Compress selected files/folders into a zip archive inside the workspace.
async fn workspace_compress(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let ws = st.ws();
    let Some(paths) = v.get("paths").and_then(|p| p.as_array()).filter(|a| !a.is_empty()) else {
        return json_err(StatusCode::BAD_REQUEST, "Paths required");
    };
    let archive_name = jstr(&v, "archiveName").filter(|s| !s.is_empty()).unwrap_or("archive.zip");
    let Some(out_path) = safe_workspace_path(&ws, archive_name) else {
        return json_err(StatusCode::BAD_REQUEST, "Invalid archive name");
    };
    let mut selected: Vec<PathBuf> = Vec::new();
    for p in paths {
        if let Some(full) = p.as_str().and_then(|s| safe_workspace_path(&ws, s)) {
            selected.push(full);
        }
    }
    if selected.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "No valid paths");
    }

    let result = tokio::task::spawn_blocking(move || -> Result<usize, String> {
        use std::io::Write as _;
        use zip::write::{SimpleFileOptions, ZipWriter};

        fn collect(path: &Path, ws: &Path, output: &Path, entries: &mut Vec<(String, PathBuf, bool)>) {
            let Ok(meta) = fs::symlink_metadata(path) else { return };
            if meta.file_type().is_symlink() || path == output {
                return;
            }
            let Ok(rel) = path.strip_prefix(ws) else { return };
            let rel = rel.to_string_lossy().replace('\\', "/");
            if rel.is_empty() {
                return;
            }
            if meta.is_dir() {
                entries.push((format!("{rel}/"), path.to_path_buf(), true));
                if let Ok(children) = fs::read_dir(path) {
                    for child in children.flatten() {
                        collect(&child.path(), ws, output, entries);
                    }
                }
            } else {
                entries.push((rel, path.to_path_buf(), false));
            }
        }

        let mut entries = Vec::new();
        for path in &selected {
            collect(path, &ws, &out_path, &mut entries);
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        entries.dedup_by(|a, b| a.0 == b.0);
        if entries.is_empty() {
            return Err("No files to compress.".to_string());
        }

        let file = fs::File::create(&out_path).map_err(|e| e.to_string())?;
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut files = 0;
        for (name, full, is_dir) in entries {
            if is_dir {
                zip.add_directory(name, options).map_err(|e| e.to_string())?;
            } else {
                let bytes = fs::read(full).map_err(|e| e.to_string())?;
                zip.start_file(name, options).map_err(|e| e.to_string())?;
                zip.write_all(&bytes).map_err(|e| e.to_string())?;
                files += 1;
            }
        }
        zip.finish().map_err(|e| e.to_string())?;
        Ok(files)
    })
    .await;

    match result {
        Ok(Ok(files)) => Json(json!({ "ok": true, "files": files })).into_response(),
        Ok(Err(e)) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

fn font_signature(dir: &Path) -> u64 {
    use std::hash::{Hash, Hasher};

    fn walk(path: &Path, state: &mut std::collections::hash_map::DefaultHasher) {
        let Ok(entries) = fs::read_dir(path) else { return };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() { continue; }
            let path = entry.path();
            path.hash(state);
            if kind.is_dir() {
                walk(&path, state);
            } else if let Ok(meta) = entry.metadata() {
                meta.len().hash(state);
                meta.modified().ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos()).hash(state);
            }
        }
    }

    let mut state = std::collections::hash_map::DefaultHasher::new();
    if dir.is_dir() { walk(dir, &mut state); }
    state.finish()
}

async fn read_preview_lines<R: AsyncRead + Unpin>(reader: R, tx: tokio::sync::mpsc::UnboundedSender<String>) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if tx.send(line).is_err() { break; }
    }
}

async fn collect_preview_events(
    st: Arc<AppState>,
    mut lines: tokio::sync::mpsc::UnboundedReceiver<String>,
    events: tokio::sync::watch::Sender<PreviewEvent>,
) {
    let mut cycle_generation = st.source_generation.load(Ordering::Acquire);
    let mut pending_error = false;
    let mut diagnostics: Vec<String> = Vec::new();

    loop {
        let next = if pending_error {
            match tokio::time::timeout(Duration::from_millis(45), lines.recv()).await {
                Ok(line) => line,
                Err(_) => {
                    let message = if diagnostics.is_empty() { "Compilation failed.".into() } else { diagnostics.join("\n") };
                    let _ = events.send(PreviewEvent { generation: cycle_generation, outcome: PreviewOutcome::Error(message) });
                    pending_error = false;
                    diagnostics.clear();
                    continue;
                }
            }
        } else {
            lines.recv().await
        };

        let Some(line) = next else {
            if pending_error {
                let message = if diagnostics.is_empty() { "Compilation failed.".into() } else { diagnostics.join("\n") };
                let _ = events.send(PreviewEvent { generation: cycle_generation, outcome: PreviewOutcome::Error(message) });
            } else {
                let generation = st.source_generation.load(Ordering::Acquire);
                let _ = events.send(PreviewEvent { generation, outcome: PreviewOutcome::Unavailable });
            }
            break;
        };
        let line = line.trim_end_matches('\r').to_string();

        if line.contains("compiling ...") {
            cycle_generation = st.source_generation.load(Ordering::Acquire);
            pending_error = false;
            diagnostics.clear();
            // Announce the in-flight cycle so waiters can tell "still compiling"
            // apart from "no compile is coming for this generation".
            let _ = events.send(PreviewEvent { generation: cycle_generation, outcome: PreviewOutcome::Waiting });
        } else if line.contains("compiled successfully") || line.contains("compiled with warnings") {
            let _ = events.send(PreviewEvent { generation: cycle_generation, outcome: PreviewOutcome::Success });
            pending_error = false;
            diagnostics.clear();
        } else if line.contains("compiled with errors") {
            pending_error = true;
            diagnostics.clear();
        } else if pending_error && !line.trim().is_empty() {
            diagnostics.push(line);
        }
    }
}

async fn stop_preview_watcher(st: &Arc<AppState>) {
    let mut guard = st.preview_watcher.lock().await;
    if let Some(mut watcher) = guard.take() {
        let _ = watcher.child.start_kill();
        let _ = watcher.child.wait().await;
    }
}

async fn ensure_preview_watcher(
    st: &Arc<AppState>,
    ws: &Path,
    main_path: &Path,
    output_path: &Path,
) -> std::io::Result<tokio::sync::watch::Receiver<PreviewEvent>> {
    let key = PreviewKey {
        workspace: ws.to_path_buf(),
        main: main_path.to_path_buf(),
        font_signature: font_signature(&ws.join("fonts")),
    };
    let mut guard = st.preview_watcher.lock().await;
    if let Some(watcher) = guard.as_mut() {
        if watcher.key == key && matches!(watcher.child.try_wait(), Ok(None)) {
            return Ok(watcher.events.clone());
        }
    }
    if let Some(mut old) = guard.take() {
        let _ = old.child.start_kill();
        let _ = old.child.wait().await;
    }

    ensure_hilbert(ws);
    let mut cmd = Command::new("typst");
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd.arg("watch").arg("--root").arg(ws);
    if ws.join("fonts").is_dir() {
        cmd.arg("--font-path").arg("fonts");
    }
    cmd.arg(main_path)
        .arg(output_path)
        .current_dir(ws)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    strip_appimage_env(&mut cmd);
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (line_tx, line_rx) = tokio::sync::mpsc::unbounded_channel();
    if let Some(stdout) = stdout {
        tokio::spawn(read_preview_lines(stdout, line_tx.clone()));
    }
    if let Some(stderr) = stderr {
        tokio::spawn(read_preview_lines(stderr, line_tx.clone()));
    }
    drop(line_tx);

    let initial = PreviewEvent { generation: 0, outcome: PreviewOutcome::Waiting };
    let (event_tx, event_rx) = tokio::sync::watch::channel(initial);
    tokio::spawn(collect_preview_events(st.clone(), line_rx, event_tx));
    *guard = Some(PreviewWatcher { key, child, events: event_rx.clone() });
    Ok(event_rx)
}

enum WatchCompileResult {
    Pdf(Vec<u8>),
    CompileError(String),
    Fallback,
}

async fn compile_from_watcher(
    st: &Arc<AppState>,
    ws: &Path,
    main_path: &Path,
    output_path: &Path,
    target_generation: u64,
) -> WatchCompileResult {
    let Ok(mut events) = ensure_preview_watcher(st, ws, main_path, output_path).await else {
        return WatchCompileResult::Fallback;
    };
    let finish = |outcome: PreviewOutcome| match outcome {
        PreviewOutcome::Success => fs::read(output_path).map(WatchCompileResult::Pdf).unwrap_or(WatchCompileResult::Fallback),
        PreviewOutcome::Error(message) => WatchCompileResult::CompileError(message),
        _ => WatchCompileResult::Fallback,
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        let event = events.borrow().clone();
        let in_flight = matches!(event.outcome, PreviewOutcome::Waiting);
        if event.generation >= target_generation && !in_flight {
            return finish(event.outcome);
        }
        // While a cycle is compiling, wait for it to finish (typst watch queues
        // file events, so a newer write starts the next cycle right after). When
        // the last cycle is already complete but predates the target and no new
        // one begins shortly, the triggering write wasn't part of the compile
        // graph (an asset, an unreferenced .bib, ...) — the completed result is
        // already current, so serve it instead of stalling out the preview.
        let wait = if in_flight {
            deadline.saturating_duration_since(tokio::time::Instant::now())
        } else {
            Duration::from_millis(1500)
        };
        match tokio::time::timeout(wait, events.changed()).await {
            Ok(Ok(())) => continue,
            Ok(Err(_)) => return WatchCompileResult::Fallback,
            Err(_) if in_flight => return WatchCompileResult::Fallback,
            Err(_) => return finish(event.outcome),
        }
    }
}

async fn compile_once(ws: &Path, main_path: &Path, output_path: &Path) -> Response {
    let mut compile_args: Vec<String> = vec!["compile".into(), "--root".into(), ws.to_string_lossy().into_owned()];
    if ws.join("fonts").is_dir() {
        compile_args.push("--font-path".into());
        compile_args.push("fonts".into());
    }
    compile_args.push(main_path.to_string_lossy().into_owned());
    compile_args.push(output_path.to_string_lossy().into_owned());
    let compile_argv: Vec<&str> = compile_args.iter().map(String::as_str).collect();
    let out = match run_cmd("typst", &compile_argv, Some(ws), None).await {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return json_err(StatusCode::INTERNAL_SERVER_ERROR, TYPST_NOT_FOUND),
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Could not run typst: {e}")),
    };
    if out.code != Some(0) {
        let msg = if out.stderr.is_empty() {
            format!("typst exited with code {}", out.code.map(|c| c.to_string()).unwrap_or_else(|| "null".into()))
        } else {
            out.stderr
        };
        return json_err(StatusCode::BAD_REQUEST, msg);
    }
    match fs::read(output_path) {
        Ok(bytes) => ([(header::CONTENT_TYPE, "application/pdf")], bytes).into_response(),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn compile(State(st): St, Query(q): Q, body: Bytes) -> Response {
    let Ok(_permit) = st.compile_gate.acquire().await else {
        return json_err(StatusCode::SERVICE_UNAVAILABLE, "Compiler is shutting down.");
    };
    let ws = st.ws();
    let main_q = q.get("main").map(String::as_str).unwrap_or("main.typ");
    let Some(main_path) = safe_workspace_path(&ws, main_q) else {
        return json_err(StatusCode::BAD_REQUEST, "Invalid main path");
    };
    ensure_hilbert(&ws);
    let output_path = hilbert_dir(&ws).join("out.pdf");
    let body_str = String::from_utf8_lossy(&body);
    if !body_str.trim().is_empty() && fs::write(&main_path, body_str.as_bytes()).is_ok() {
        st.source_generation.fetch_add(1, Ordering::AcqRel);
    }
    let generation = st.source_generation.load(Ordering::Acquire);
    match compile_from_watcher(&st, &ws, &main_path, &output_path, generation).await {
        WatchCompileResult::Pdf(bytes) => ([(header::CONTENT_TYPE, "application/pdf")], bytes).into_response(),
        WatchCompileResult::CompileError(message) => json_err(StatusCode::BAD_REQUEST, message),
        WatchCompileResult::Fallback => {
            stop_preview_watcher(&st).await;
            compile_once(&ws, &main_path, &output_path).await
        }
    }
}

async fn init_template(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let Some(template) = jstr(&v, "template").filter(|t| !t.is_empty()) else {
        return json_err(StatusCode::BAD_REQUEST, "Template name required");
    };
    let ws = st.ws();
    let _ = fs::remove_dir_all(&ws);
    let out = match run_cmd("typst", &["init", template, &ws.to_string_lossy()], None, None).await {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return json_err(StatusCode::INTERNAL_SERVER_ERROR, TYPST_NOT_FOUND),
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if out.code != Some(0) {
        return json_err(StatusCode::BAD_REQUEST, out.stderr);
    }
    let files: Vec<String> = fs::read_dir(&ws)
        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    // `typst init` prints the real entrypoint, e.g. `> typst watch main.typ`.
    // Trust that over "first .typ alphabetically" so multi-file templates open the
    // correct entry (a chapter file could otherwise sort ahead of it).
    static ENTRY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?:watch|compile)\s+"?([^\s"]+\.typ)"#).unwrap());
    let haystack = format!("{}\n{}", out.stdout, out.stderr);
    let entry = ENTRY_RE
        .captures(&haystack)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .filter(|e| ws.join(e).exists())
        .or_else(|| if files.iter().any(|f| f == "main.typ") { Some("main.typ".into()) } else { files.iter().find(|f| f.ends_with(".typ")).cloned() })
        .unwrap_or_else(|| "main.typ".into());
    match fs::read_to_string(ws.join(&entry)) {
        Ok(content) => Json(json!({ "code": content, "entrypoint": entry })).into_response(),
        Err(_) => json_err(StatusCode::INTERNAL_SERVER_ERROR, "Failed to read template files"),
    }
}

// Compile a small standalone snippet to a transparent PNG. Slide Studio uses
// this to draw real previews of tool-inserted blocks on the canvas. Unique
// temp names inside .hilbert keep concurrent requests and user files apart.
async fn render_snippet(State(st): St, body: Bytes) -> Response {
    let Ok(_permit) = st.render_gate.acquire().await else {
        return json_err(StatusCode::SERVICE_UNAVAILABLE, "Preview renderer is shutting down.");
    };
    let ws = st.ws();
    ensure_hilbert(&ws);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let src = hilbert_dir(&ws).join(format!("snippet-{stamp}.typ"));
    let out = hilbert_dir(&ws).join(format!("snippet-{stamp}.png"));
    if fs::write(&src, &body).is_err() {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not write snippet");
    }
    let ws_s = ws.to_string_lossy().into_owned();
    let mut args: Vec<String> = vec![
        "compile".into(), "--root".into(), ws_s,
        "--format".into(), "png".into(), "--ppi".into(), "144".into(), "--pages".into(), "1".into(),
    ];
    if ws.join("fonts").is_dir() {
        args.push("--font-path".into());
        args.push("fonts".into());
    }
    args.push(src.to_string_lossy().into_owned());
    args.push(out.to_string_lossy().into_owned());
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let res = run_cmd("typst", &argv, Some(&ws), None).await;
    let _ = fs::remove_file(&src);
    match res {
        Ok(o) if o.code == Some(0) => match fs::read(&out) {
            Ok(bytes) => {
                let _ = fs::remove_file(&out);
                ([(header::CONTENT_TYPE, "image/png")], bytes).into_response()
            }
            Err(_) => json_err(StatusCode::INTERNAL_SERVER_ERROR, "No snippet output"),
        },
        Ok(o) => {
            let _ = fs::remove_file(&out);
            let msg = if o.stderr.is_empty() { o.stdout } else { o.stderr };
            json_err(StatusCode::BAD_REQUEST, msg.chars().take(4000).collect::<String>())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json_err(StatusCode::INTERNAL_SERVER_ERROR, TYPST_NOT_FOUND_SHORT),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// Compile to HTML and return it (for in-browser download).
async fn compile_html(State(st): St, Query(q): Q) -> Response {
    let ws = st.ws();
    let main_q = q.get("main").map(String::as_str).unwrap_or("main.typ");
    let Some(main_path) = safe_workspace_path(&ws, main_q) else {
        return json_err(StatusCode::BAD_REQUEST, "Invalid main path");
    };
    let out_file = ws.join(".out.html");
    let ws_s = ws.to_string_lossy();
    let out = match run_cmd(
        "typst",
        &["compile", "--root", &ws_s, "--format", "html", "--features", "html", &main_path.to_string_lossy(), &out_file.to_string_lossy()],
        Some(&ws),
        None,
    )
    .await
    {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return json_err(StatusCode::INTERNAL_SERVER_ERROR, TYPST_NOT_FOUND_SHORT),
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if out.code != Some(0) {
        return json_err(StatusCode::BAD_REQUEST, if out.stderr.is_empty() { "HTML export failed.".into() } else { out.stderr });
    }
    match fs::read(&out_file) {
        Ok(bytes) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], bytes).into_response(),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// Export a single file (compiled PDF/HTML or Typst source) into a target folder.
fn export_ext(format: &str) -> &'static str {
    match format { "png" => "png", "svg" => "svg", "html" => "html", "bundle" => "zip", "typ" => "typ", _ => "pdf" }
}

// Build the typst CLI args for the requested format + the user's export options
// (page range, PDF standard, tagging, pretty-print, PNG resolution).
fn export_opts_args(v: &Value, format: &str) -> Vec<String> {
    let mut a: Vec<String> = vec!["--format".into(), format.into()];
    if format == "html" { a.push("--features".into()); a.push("html".into()); }
    if format == "bundle" { a.push("--features".into()); a.push("bundle,html".into()); }
    if let Some(p) = jstr(v, "pages").map(str::trim).filter(|s| !s.is_empty()) {
        a.push("--pages".into()); a.push(p.to_string());
    }
    if format == "pdf" {
        if let Some(s) = jstr(v, "pdfStandard").map(str::trim).filter(|s| !s.is_empty() && *s != "default") {
            a.push("--pdf-standard".into()); a.push(s.to_string());
        }
        // Typst tags PDFs by default; the flag opts out.
        if v.get("tagged").and_then(Value::as_bool) == Some(false) {
            a.push("--no-pdf-tags".into());
        }
    }
    if format == "png" {
        let ppi = v.get("ppi").and_then(Value::as_f64).filter(|n| (16.0..=2400.0).contains(n)).unwrap_or(144.0);
        a.push("--ppi".into()); a.push((ppi as u32).to_string());
    }
    if matches!(format, "pdf" | "svg" | "html" | "bundle") && v.get("pretty").and_then(Value::as_bool) == Some(true) {
        a.push("--pretty".into());
    }
    a
}

// Run one typst export (input → output) with the option args applied.
async fn run_typst_export(ws: &Path, main_abs: &Path, out_path: &Path, v: &Value, format: &str) -> Result<(), String> {
    let ws_s = ws.to_string_lossy().into_owned();
    let main_s = main_abs.to_string_lossy().into_owned();
    let out_s = out_path.to_string_lossy().into_owned();
    let opts = export_opts_args(v, format);
    let mut args: Vec<&str> = vec!["compile", "--root", &ws_s];
    for o in &opts { args.push(o); }
    args.push(&main_s);
    args.push(&out_s);
    match run_cmd("typst", &args, Some(ws), None).await {
        Ok(o) if o.code == Some(0) => Ok(()),
        Ok(o) => Err(if o.stderr.is_empty() { "Compilation failed.".into() } else { o.stderr }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(TYPST_NOT_FOUND_SHORT.into()),
        Err(e) => Err(e.to_string()),
    }
}

async fn export_preflight(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let main_file = jstr(&v, "main").filter(|m| !m.is_empty()).unwrap_or("main.typ");
    let ws = st.ws();
    let Some(main_abs) = safe_workspace_path(&ws, main_file) else {
        return json_err(StatusCode::BAD_REQUEST, "Invalid main path");
    };
    let source = fs::read_to_string(&main_abs).unwrap_or_default();
    static TITLE_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?s)#set\s+document\s*\([^)]*\btitle\s*:").unwrap());
    static LANG_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?s)#set\s+text\s*\([^)]*\blang\s*:").unwrap());
    let checks = vec![
        json!({
            "label": "Document title is set in the entry file",
            "ok": TITLE_RE.is_match(&source),
            "advisory": true,
        }),
        json!({
            "label": "Document language is set in the entry file",
            "ok": LANG_RE.is_match(&source),
            "advisory": true,
        }),
        json!({
            "label": "Tagged PDF output is enabled",
            "ok": v.get("tagged").and_then(Value::as_bool) != Some(false),
            "advisory": false,
        }),
    ];
    ensure_hilbert(&ws);
    let stamp = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let output = hilbert_dir(&ws).join(format!("accessibility-preflight-{stamp}.pdf"));
    let result = run_typst_export(&ws, &main_abs, &output, &v, "pdf").await;
    let _ = fs::remove_file(&output);
    match result {
        Ok(()) => Json(json!({
            "ok": true,
            "checks": checks,
            "message": "Typst completed the PDF standards check.",
        }))
        .into_response(),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "checks": checks,
                "error": error,
            })),
        )
            .into_response(),
    }
}

// PNG/SVG can emit one file per page (via the `{p}` template). Count what was
// produced; if only one page was written, drop the "-1" suffix for a clean name.
fn collapse_pages(dir: &Path, stem: &str, ext: &str) -> (usize, String) {
    let prefix = format!("{stem}-");
    let suffix = format!(".{ext}");
    let mut pages: Vec<PathBuf> = fs::read_dir(dir).into_iter().flatten().flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str())
            .map(|n| n.starts_with(&prefix) && n.ends_with(&suffix)).unwrap_or(false))
        .collect();
    pages.sort();
    if pages.len() == 1 {
        let single = dir.join(format!("{stem}{suffix}"));
        let _ = fs::rename(&pages[0], &single);
        return (1, single.to_string_lossy().into_owned());
    }
    (pages.len(), pages.first().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default())
}

// Export directly into a caller-supplied folder (the "save to folder" path).
// Show a file selected in Finder / Explorer, rather than opening it.
fn reveal_in_file_manager(target: &Path) {
    #[cfg(target_os = "macos")]
    { let _ = std::process::Command::new("open").arg("-R").arg(target).spawn(); }
    #[cfg(target_os = "windows")]
    { let _ = std::process::Command::new("explorer").arg(format!("/select,{}", target.display())).spawn(); }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if target.is_dir() { target.to_path_buf() } else { target.parent().map(Path::to_path_buf).unwrap_or_else(|| target.to_path_buf()) };
        let _ = open::that_detached(dir);
    }
}

// Launch a second, independent copy of the app so the user can have two
// projects open at once. Each instance runs its own backend on its own port,
// so they don't interfere. We relaunch the real installed artifact rather than
// the bare executable: on macOS ask LaunchServices for a new instance of the
// .app (otherwise it just refocuses the running one), and on Linux relaunch the
// .AppImage itself, since the running binary lives on a throwaway mount.
fn spawn_new_instance() -> std::io::Result<()> {
    // Its own session file, so the new window starts fresh at the default
    // workspace and never clobbers the primary window's remembered project.
    // Passed as an argument (not an env var) because macOS `open` doesn't
    // forward the caller's environment to the launched app.
    let session = new_window_session_path();
    let session = session.to_string_lossy().into_owned();
    #[cfg(target_os = "macos")]
    if let Some(app) = macos_app_bundle() {
        return std::process::Command::new("open")
            .arg("-n").arg(app).arg("--args")
            .arg("--session-file").arg(&session)
            .spawn().map(|_| ());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        return std::process::Command::new(appimage)
            .arg("--session-file").arg(&session)
            .spawn().map(|_| ());
    }
    std::process::Command::new(std::env::current_exe()?)
        .arg("--session-file").arg(&session)
        .spawn().map(|_| ())
}

// A unique, throwaway session file for an extra window. Kept in the temp dir so
// the OS reclaims it; the window persists its own state here while open and it
// is simply not read again afterwards.
pub fn new_window_session_path() -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("hilbert-window-{}-{stamp}.json", std::process::id()))
}

#[cfg(target_os = "macos")]
fn macos_app_bundle() -> Option<PathBuf> {
    // .../Hilbert.app/Contents/MacOS/hilbert  ->  .../Hilbert.app
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
        .map(Path::to_path_buf)
}

// "Open after export". A multi-page export reveals the file instead of opening N
// viewer windows. So does SVG: the app registered for it is often a source editor
// (LaTeXiT, an IDE, a text editor) rather than a renderer, and handing the user a
// wall of XML reads like the export failed. Everything else opens normally.
fn open_exported(target: &str, count: u64) {
    let p = Path::new(target);
    let is_svg = p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("svg"));
    if count > 1 || is_svg {
        reveal_in_file_manager(p);
    } else {
        let _ = open::that_detached(p);
    }
}

fn wants_open(v: &Value) -> bool {
    v.get("open").and_then(Value::as_bool).unwrap_or(false)
}

// Export through the OS "save file" dialog so the user picks the exact location
// (no more silent writes to Downloads). Returns { noDialog: true } when there's
// no desktop app handle (headless / browser dev), so the UI can fall back to a
// plain download.
async fn export_native(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let format = jstr(&v, "format").unwrap_or("pdf").to_string();
    let name = jstr(&v, "name").filter(|n| !n.is_empty()).unwrap_or("document").to_string();
    let main_file = jstr(&v, "main").filter(|m| !m.is_empty()).unwrap_or("main.typ").to_string();
    let ws = st.ws();
    let ext = export_ext(&format).to_string();

    let Some(app) = st.app.lock().unwrap().clone() else {
        return Json(json!({ "ok": false, "noDialog": true })).into_response();
    };
    let suggested = format!("{name}.{ext}");
    let ext_up = ext.to_uppercase();
    let ext_filter = ext.clone();
    let chosen = tokio::task::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().file().set_title("Export").set_file_name(&suggested)
            .add_filter(ext_up, &[ext_filter.as_str()]).blocking_save_file()
    }).await.ok().flatten().and_then(|fp| fp.into_path().ok());
    let Some(chosen) = chosen else {
        return Json(json!({ "ok": false, "cancelled": true })).into_response();
    };

    if format == "typ" {
        return match fs::copy(ws.join(&main_file), &chosen) {
            Ok(_) => {
                if wants_open(&v) { open_exported(&chosen.to_string_lossy(), 1); }
                Json(json!({ "ok": true, "target": chosen.to_string_lossy(), "count": 1 })).into_response()
            }
            Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
    }

    let main_abs = ws.join(&main_file);
    if format == "bundle" {
        ensure_hilbert(&ws);
        let stamp = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let bundle_dir = hilbert_dir(&ws).join(format!("bundle-export-{stamp}"));
        if let Err(error) = fs::create_dir_all(&bundle_dir) {
            return json_err(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
        if let Err(error) = run_typst_export(&ws, &main_abs, &bundle_dir, &v, "bundle").await {
            let _ = fs::remove_dir_all(&bundle_dir);
            return json_err(StatusCode::BAD_REQUEST, error);
        }
        let target = chosen.clone();
        let source = bundle_dir.clone();
        let zipped = tokio::task::spawn_blocking(move || -> Result<usize, String> {
            use std::io::Write as _;
            use zip::write::{SimpleFileOptions, ZipWriter};

            fn walk(dir: &Path, root: &Path, files: &mut Vec<(String, PathBuf)>) {
                let Ok(entries) = fs::read_dir(dir) else { return };
                for entry in entries.flatten() {
                    let path = entry.path();
                    let Ok(kind) = entry.file_type() else { continue };
                    if kind.is_symlink() {
                        continue;
                    }
                    if kind.is_dir() {
                        walk(&path, root, files);
                    } else if kind.is_file() {
                        if let Ok(rel) = path.strip_prefix(root) {
                            files.push((rel.to_string_lossy().replace('\\', "/"), path));
                        }
                    }
                }
            }

            let mut files = Vec::new();
            walk(&source, &source, &mut files);
            files.sort_by(|a, b| a.0.cmp(&b.0));
            if files.is_empty() {
                return Err("The Typst bundle did not produce any files.".into());
            }
            let file = fs::File::create(&target).map_err(|error| error.to_string())?;
            let mut zip = ZipWriter::new(file);
            let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            for (name, path) in &files {
                zip.start_file(name, options).map_err(|error| error.to_string())?;
                let bytes = fs::read(path).map_err(|error| error.to_string())?;
                zip.write_all(&bytes).map_err(|error| error.to_string())?;
            }
            zip.finish().map_err(|error| error.to_string())?;
            Ok(files.len())
        })
        .await;
        let _ = fs::remove_dir_all(&bundle_dir);
        return match zipped {
            Ok(Ok(count)) => {
                if wants_open(&v) {
                    reveal_in_file_manager(&chosen);
                }
                Json(json!({ "ok": true, "target": chosen.to_string_lossy(), "count": count })).into_response()
            }
            Ok(Err(error)) => json_err(StatusCode::INTERNAL_SERVER_ERROR, error),
            Err(error) => json_err(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        };
    }
    let multi = matches!(format.as_str(), "png" | "svg");
    let dir = chosen.parent().map(Path::to_path_buf).unwrap_or_else(|| ws.clone());
    let stem = chosen.file_stem().and_then(|s| s.to_str()).unwrap_or(&name).to_string();
    let out_path = if multi { dir.join(format!("{stem}-{{p}}.{ext}")) } else { chosen.clone() };
    match run_typst_export(&ws, &main_abs, &out_path, &v, &format).await {
        Ok(()) => {
            let (count, first) = if multi { collapse_pages(&dir, &stem, &ext) }
                else { (1, chosen.to_string_lossy().into_owned()) };
            if wants_open(&v) { open_exported(&first, count as u64); }
            Json(json!({ "ok": true, "target": first, "count": count })).into_response()
        }
        Err(msg) => json_err(StatusCode::BAD_REQUEST, msg),
    }
}

// Export the whole project as a single .zip through the OS save dialog. Uses a
// pure-Rust zip writer, so it behaves the same on Windows, macOS and Linux with
// no dependency on a system `zip` binary. The file set matches cloud sync: source
// plus assets, skipping dotfiles, node_modules, the sandbox and built PDFs.
async fn export_project_native(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let name = jstr(&v, "name").filter(|n| !n.is_empty()).unwrap_or("project").to_string();
    let open_after = wants_open(&v);
    let ws = st.ws();

    let Some(app) = st.app.lock().unwrap().clone() else {
        return Json(json!({ "ok": false, "noDialog": true })).into_response();
    };
    let suggested = format!("{name}.zip");
    let chosen = tokio::task::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().file().set_title("Export project").set_file_name(&suggested)
            .add_filter("ZIP archive", &["zip"]).blocking_save_file()
    }).await.ok().flatten().and_then(|fp| fp.into_path().ok());
    let Some(chosen) = chosen else {
        return Json(json!({ "ok": false, "cancelled": true })).into_response();
    };

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_workspace(&ws, "", &mut files);
    if files.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "The project has no files to archive.");
    }

    let target = chosen.clone();
    let res = tokio::task::spawn_blocking(move || -> std::io::Result<usize> {
        use std::io::Write as _;
        use zip::write::{SimpleFileOptions, ZipWriter};
        let f = fs::File::create(&target)?;
        let mut zip = ZipWriter::new(f);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut n = 0usize;
        for (rel, full) in &files {
            let Ok(bytes) = fs::read(full) else { continue };
            zip.start_file(rel.as_str(), opts)?;
            zip.write_all(&bytes)?;
            n += 1;
        }
        zip.finish()?;
        Ok(n)
    }).await;

    match res {
        Ok(Ok(count)) => {
            if open_after { reveal_in_file_manager(&chosen); }
            Json(json!({ "ok": true, "target": chosen.to_string_lossy(), "count": count })).into_response()
        }
        Ok(Err(e)) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Typst Universe package search (index cached on disk, matched locally)
// ---------------------------------------------------------------------------

const UNIVERSE_INDEX_URL: &str = "https://packages.typst.org/preview/index.json";
const UNIVERSE_TTL: Duration = Duration::from_secs(24 * 3600);

fn universe_cache_file() -> PathBuf {
    std::env::temp_dir().join("typst-editor-universe-index.json")
}

fn cmp_version(a: &str, b: &str) -> std::cmp::Ordering {
    let pa: Vec<i64> = a.split('.').map(|n| n.parse().unwrap_or(0)).collect();
    let pb: Vec<i64> = b.split('.').map(|n| n.parse().unwrap_or(0)).collect();
    for i in 0..3 {
        let (x, y) = (*pa.get(i).unwrap_or(&0), *pb.get(i).unwrap_or(&0));
        if x != y {
            return x.cmp(&y);
        }
    }
    std::cmp::Ordering::Equal
}

async fn get_universe_index(st: &AppState) -> Option<Arc<Vec<Pkg>>> {
    let mut guard = st.universe.lock().await;
    if let Some((at, idx)) = guard.as_ref() {
        if at.elapsed() < UNIVERSE_TTL {
            return Some(idx.clone());
        }
    }
    let mut raw: Option<String> = None;
    if let Ok(resp) = st.http.get(UNIVERSE_INDEX_URL).timeout(Duration::from_secs(15)).send().await {
        if resp.status().is_success() {
            if let Ok(text) = resp.text().await {
                let _ = fs::write(universe_cache_file(), &text);
                raw = Some(text);
            }
        }
    }
    if raw.is_none() {
        raw = fs::read_to_string(universe_cache_file()).ok();
    }
    let raw = match raw {
        Some(r) => r,
        None => return guard.as_ref().map(|(_, idx)| idx.clone()),
    };
    let all: Vec<Value> = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return guard.as_ref().map(|(_, idx)| idx.clone()),
    };
    // Keep only the latest version of each package.
    let mut by_name: HashMap<String, Value> = HashMap::new();
    for p in all {
        let Some(name) = p.get("name").and_then(|n| n.as_str()).map(String::from) else { continue };
        let ver = p.get("version").and_then(|x| x.as_str()).unwrap_or("").to_string();
        match by_name.get(&name) {
            Some(cur) => {
                let cur_v = cur.get("version").and_then(|x| x.as_str()).unwrap_or("");
                if cmp_version(&ver, cur_v) == std::cmp::Ordering::Greater {
                    by_name.insert(name, p);
                }
            }
            None => {
                by_name.insert(name, p);
            }
        }
    }
    let idx = Arc::new(by_name.into_values().map(|value| {
        let name_lc = value.get("name").and_then(|x| x.as_str()).unwrap_or("").to_lowercase();
        let desc = value.get("description").and_then(|x| x.as_str()).unwrap_or("");
        let keywords = value.get("keywords").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|k| k.as_str()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
        let categories = value.get("categories").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|k| k.as_str()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
        let hay = format!("{name_lc} {desc} {keywords} {categories}").to_lowercase();
        Pkg { value, name_lc, hay }
    }).collect::<Vec<_>>());
    *guard = Some((Instant::now(), idx.clone()));
    Some(idx)
}

async fn packages_search(State(st): St, Query(q): Q) -> Response {
    static EMAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*<[^>]*>").unwrap());
    let query = q.get("q").map(String::as_str).unwrap_or("").to_lowercase();
    let query = query.trim();
    let Some(idx) = get_universe_index(&st).await else {
        return Json(json!([])).into_response();
    };
    let tokens: Vec<&str> = query.split(|c: char| !c.is_ascii_alphanumeric()).filter(|t| t.len() > 1).collect();
    let mut scored: Vec<(i64, &Value)> = Vec::new();
    for p in idx.iter() {
        let mut score = 0i64;
        if tokens.is_empty() {
            score = 1;
        } else {
            for t in &tokens {
                if p.name_lc.contains(t) {
                    score += 3;
                } else if p.hay.contains(t) {
                    score += 1;
                }
            }
        }
        if score > 0 {
            scored.push((score, &p.value));
        }
    }
    scored.sort_by_key(|x| std::cmp::Reverse(x.0));
    let out: Vec<Value> = scored
        .iter()
        .take(15)
        .map(|(_, p)| {
            let authors: Vec<String> = p
                .get("authors")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .map(|s| EMAIL.replace_all(&s.as_str().map(String::from).unwrap_or_else(|| s.to_string()), "").trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            json!({
                "name": p.get("name").and_then(|x| x.as_str()).unwrap_or(""),
                "version": p.get("version").and_then(|x| x.as_str()).unwrap_or(""),
                "description": p.get("description").and_then(|x| x.as_str()).unwrap_or(""),
                "authors": authors,
            })
        })
        .collect();
    Json(out).into_response()
}

// ---------------------------------------------------------------------------
// Git integration (via the local `git` CLI inside the workspace folder)
// ---------------------------------------------------------------------------

async fn git(ws: &Path, args: &[&str]) -> CmdOut {
    match run_cmd("git", args, Some(ws), None).await {
        Ok(o) => o,
        Err(e) => CmdOut { code: Some(1), killed: false, stdout: String::new(), stderr: e.to_string() },
    }
}

// Same as git(), but with a wall-clock cap for the network operations (push)
// so a stalled connection can't leave the request hanging indefinitely.
async fn git_timed(ws: &Path, args: &[&str], ms: u64) -> CmdOut {
    match run_cmd("git", args, Some(ws), Some(ms)).await {
        Ok(o) => o,
        Err(e) => CmdOut { code: Some(1), killed: false, stdout: String::new(), stderr: e.to_string() },
    }
}

fn is_repo(ws: &Path) -> bool {
    ws.join(".git").exists()
}

// Drop any credentials embedded in a remote URL (https://token@host/… or
// https://user:pass@host/…) before it's shown in the UI or logged. Only the
// userinfo ahead of the host is touched; the path is left alone.
fn strip_url_creds(url: &str) -> String {
    if let Some(i) = url.find("://") {
        let (scheme, rest) = url.split_at(i + 3);
        let host_end = rest.find('/').unwrap_or(rest.len());
        if let Some(at) = rest[..host_end].find('@') {
            return format!("{scheme}{}", &rest[at + 1..]);
        }
    }
    url.to_string()
}

async fn git_status(State(st): St) -> Response {
    let ws = st.ws();
    if !is_repo(&ws) {
        return Json(json!({ "initialized": false })).into_response();
    }
    let branch = git(&ws, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
    let status = git(&ws, &["status", "--porcelain"]).await;
    let remote = git(&ws, &["remote", "get-url", "origin"]).await;
    let files: Vec<String> = status.stdout.split('\n').filter(|l| !l.is_empty()).map(|l| l.to_string()).collect();
    Json(json!({
        "initialized": true,
        "branch": if branch.code == Some(0) { branch.stdout.trim().to_string() } else { "main".to_string() },
        "remote": if remote.code == Some(0) { Value::String(strip_url_creds(remote.stdout.trim())) } else { Value::Null },
        "changes": files,
        "clean": files.is_empty(),
    }))
    .into_response()
}

async fn git_init_defaults(ws: &Path) {
    let _ = git(ws, &["config", "user.name", "Typst Editor"]).await;
    let _ = git(ws, &["config", "user.email", "typst-editor@localhost"]).await;
}

async fn git_init(State(st): St) -> Response {
    let ws = st.ws();
    if is_repo(&ws) {
        return Json(json!({ "ok": true, "message": "Repository already initialized." })).into_response();
    }
    let init = git(&ws, &["init", "-b", "main"]).await;
    if init.code != Some(0) {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, if init.stderr.is_empty() { "git init failed".into() } else { init.stderr });
    }
    git_init_defaults(&ws).await;
    let _ = fs::write(ws.join(".gitignore"), ".hilbert/\n*.pdf\n.DS_Store\n");
    Json(json!({ "ok": true, "message": "Initialized empty Git repository." })).into_response()
}

async fn git_remote(State(st): St, body: Bytes) -> Response {
    let ws = st.ws();
    if !is_repo(&ws) {
        return json_err(StatusCode::BAD_REQUEST, "Repository not initialized.");
    }
    let v = parse_json(&body);
    let Some(url) = jstr(&v, "url").filter(|u| !u.is_empty()) else {
        return json_err(StatusCode::BAD_REQUEST, "Repository URL required.");
    };
    let has = git(&ws, &["remote", "get-url", "origin"]).await;
    let r = if has.code == Some(0) {
        git(&ws, &["remote", "set-url", "origin", url]).await
    } else {
        git(&ws, &["remote", "add", "origin", url]).await
    };
    if r.code != Some(0) {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, if r.stderr.is_empty() { "Failed to set remote.".into() } else { r.stderr });
    }
    Json(json!({ "ok": true })).into_response()
}

async fn git_commit(State(st): St, body: Bytes) -> Response {
    let ws = st.ws();
    if !is_repo(&ws) {
        let init = git(&ws, &["init", "-b", "main"]).await;
        if init.code != Some(0) {
            return json_err(StatusCode::INTERNAL_SERVER_ERROR, init.stderr);
        }
        git_init_defaults(&ws).await;
    }
    let v = parse_json(&body);
    let message = jstr(&v, "message").filter(|m| !m.is_empty()).unwrap_or("Update from Typst Editor");
    let _ = git(&ws, &["add", "-A"]).await;
    let commit = git(&ws, &["commit", "-m", message]).await;
    if commit.code != Some(0) {
        let msg = format!("{}{}", commit.stdout, commit.stderr).to_lowercase();
        if msg.contains("nothing to commit") {
            return Json(json!({ "ok": true, "message": "Nothing to commit — working tree clean." })).into_response();
        }
        let err = if !commit.stderr.is_empty() {
            commit.stderr
        } else if !commit.stdout.is_empty() {
            commit.stdout
        } else {
            "Commit failed.".into()
        };
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, err);
    }
    Json(json!({ "ok": true, "message": commit.stdout.trim() })).into_response()
}

async fn git_push(State(st): St, body: Bytes) -> Response {
    let ws = st.ws();
    if !is_repo(&ws) {
        return json_err(StatusCode::BAD_REQUEST, "Repository not initialized.");
    }
    let v = parse_json(&body);
    let url = jstr(&v, "url").unwrap_or("");
    let token = jstr(&v, "token").unwrap_or("");
    let branch = jstr(&v, "branch").filter(|b| !b.is_empty()).unwrap_or("main");

    // Keep `origin` pointed at the clean URL — the token is never written into
    // .git/config (the settings panel promises it isn't stored). It's injected
    // only into the one-shot push target below.
    if !url.is_empty() {
        let has = git(&ws, &["remote", "get-url", "origin"]).await;
        let set = if has.code == Some(0) {
            git(&ws, &["remote", "set-url", "origin", url]).await
        } else {
            git(&ws, &["remote", "add", "origin", url]).await
        };
        if set.code != Some(0) {
            return json_err(StatusCode::INTERNAL_SERVER_ERROR, set.stderr);
        }
    }

    // Push straight to a tokened URL when we have one, so authentication works
    // without leaving the secret behind. Otherwise fall back to `origin`.
    let target = if !token.is_empty() && url.starts_with("https://") {
        url.replacen("https://", &format!("https://{token}@"), 1)
    } else if !url.is_empty() {
        url.to_string()
    } else {
        "origin".to_string()
    };
    let refspec = format!("HEAD:{branch}");
    let push = git_timed(&ws, &["push", &target, &refspec], 120_000).await;
    // Scrub the token from any echoed output before returning it.
    let scrub = |s: &str| if token.is_empty() { s.to_string() } else { s.replace(token, "***") };
    if push.code != Some(0) {
        let err = if push.killed {
            "Push timed out after 120s — check your connection and token.".to_string()
        } else if !push.stderr.is_empty() {
            scrub(&push.stderr)
        } else {
            "Push failed.".to_string()
        };
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, err);
    }
    let msg = if !push.stderr.is_empty() {
        push.stderr
    } else if !push.stdout.is_empty() {
        push.stdout
    } else {
        "Pushed.".into()
    };
    Json(json!({ "ok": true, "message": scrub(&msg) })).into_response()
}

// ---------------------------------------------------------------------------
// Local-folder sync (works with the Google Drive Desktop synced folder)
// ---------------------------------------------------------------------------

fn copy_all(dir: &Path, ws: &Path, folder: &Path, count: &mut u64) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".DS_Store" || name == ".git" || name.ends_with(".pdf") {
            continue;
        }
        let src = entry.path();
        if entry.file_type().map(|t| t.is_symlink()).unwrap_or(true) {
            continue;
        }
        let rel = src.strip_prefix(ws).unwrap_or(&src).to_path_buf();
        let dest = folder.join(&rel);
        if entry.metadata()?.is_dir() {
            fs::create_dir_all(&dest)?;
            copy_all(&src, ws, folder, count)?;
        } else {
            if let Some(p) = dest.parent() {
                fs::create_dir_all(p)?;
            }
            fs::copy(&src, &dest)?;
            *count += 1;
        }
    }
    Ok(())
}

async fn drive_sync(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let Some(folder) = jstr(&v, "folder").filter(|f| !f.is_empty()) else {
        return json_err(StatusCode::BAD_REQUEST, "Target folder path required.");
    };
    let ws = st.ws();
    let target = PathBuf::from(folder);
    if let Err(e) = fs::create_dir_all(&target) {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    let mut count = 0u64;
    match copy_all(&ws, &ws, &target, &mut count) {
        Ok(_) => Json(json!({ "ok": true, "count": count, "folder": folder })).into_response(),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// WebDAV sync (Nextcloud, ownCloud, any WebDAV server)
// ---------------------------------------------------------------------------

// JS encodeURIComponent keeps A-Za-z0-9 - _ . ! ~ * ' ( )
const ENC_URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

fn enc(s: &str) -> String {
    utf8_percent_encode(s, ENC_URI_COMPONENT).to_string()
}

fn collect_workspace(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut items: Vec<_> = rd.flatten().collect();
    items.sort_by_key(|e| e.file_name());
    for entry in items {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" || name == "sandbox" || name.ends_with(".pdf") {
            continue;
        }
        let full = entry.path();
        if entry.file_type().map(|t| t.is_symlink()).unwrap_or(true) {
            continue;
        }
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        if entry.metadata().map(|m| m.is_dir()).unwrap_or(false) {
            collect_workspace(&full, &rel, out);
        } else {
            out.push((rel, full));
        }
    }
}

async fn compile_to_pdf(ws: &Path, main: &Path, out: &Path) -> bool {
    match run_cmd("typst", &["compile", "--root", &ws.to_string_lossy(), &main.to_string_lossy(), &out.to_string_lossy()], Some(ws), Some(30000)).await {
        Ok(o) => o.code == Some(0) && out.exists(),
        Err(_) => false,
    }
}

async fn webdav_sync(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let Some(url) = jstr(&v, "url").filter(|u| !u.is_empty()) else {
        return json_err(StatusCode::BAD_REQUEST, "WebDAV URL required.");
    };
    let username = jstr(&v, "username").unwrap_or("");
    let password = jstr(&v, "password").unwrap_or("");
    let project = jstr(&v, "projectName").unwrap_or("Typst Project");
    static BAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[\\/:*?"<>|]+"#).unwrap());
    let proj = {
        let cleaned = BAD.replace_all(project, "_").trim().to_string();
        if cleaned.is_empty() { "Typst Project".to_string() } else { cleaned }
    };
    let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{username}:{password}")));
    let root = if url.ends_with('/') { url.to_string() } else { format!("{url}/") };
    let base = format!("{root}{}/", enc(&proj));
    let mkcol = Method::from_bytes(b"MKCOL").unwrap();

    let ws = st.ws();
    let res: Result<(u64, String), String> = async {
        // Create the project folder (also verifies auth early).
        let mk = st.http.request(mkcol.clone(), &base).header("Authorization", &auth).send().await.map_err(|e| e.to_string())?;
        if mk.status().as_u16() == 401 {
            return Err("Authentication failed (check username / app password).".into());
        }
        let mut files = Vec::new();
        collect_workspace(&ws, "", &mut files);
        let mut made_dirs: std::collections::HashSet<String> = Default::default();
        let mut count = 0u64;
        let tmp = std::env::temp_dir().join(format!("typst-dav-{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);

        let put = |rel: String, bytes: Vec<u8>| {
            let url = format!("{base}{}", rel.split('/').map(enc).collect::<Vec<_>>().join("/"));
            let client = st.http.clone();
            let auth = auth.clone();
            async move {
                let r = client.put(&url).header("Authorization", &auth).body(bytes).send().await.map_err(|e| e.to_string())?;
                let s = r.status().as_u16();
                if !r.status().is_success() && ![200u16, 201, 204].contains(&s) {
                    if s == 401 {
                        return Err("Authentication failed (check username / app password).".to_string());
                    }
                    return Err(format!("Upload of {rel} failed (HTTP {s})."));
                }
                Ok::<(), String>(())
            }
        };

        for (rel, full) in &files {
            // Ensure parent collections exist inside the project folder.
            let parts: Vec<&str> = rel.split('/').collect();
            let mut acc = String::new();
            for part in parts.iter().take(parts.len().saturating_sub(1)) {
                if !acc.is_empty() {
                    acc.push('/');
                }
                acc.push_str(part);
                if made_dirs.insert(acc.clone()) {
                    let url = format!("{base}{}", acc.split('/').map(enc).collect::<Vec<_>>().join("/"));
                    let _ = st.http.request(mkcol.clone(), &url).header("Authorization", &auth).send().await;
                }
            }
            let bytes = fs::read(full).map_err(|e| e.to_string())?;
            put(rel.clone(), bytes).await?;
            count += 1;

            // Compile .typ files to PDF and upload alongside.
            if rel.ends_with(".typ") {
                let out_pdf = tmp.join("out.pdf");
                if compile_to_pdf(&ws, full, &out_pdf).await {
                    if let Ok(bytes) = fs::read(&out_pdf) {
                        put(rel.trim_end_matches(".typ").to_string() + ".pdf", bytes).await?;
                        count += 1;
                    }
                    let _ = fs::remove_file(&out_pdf);
                }
            }
        }
        let _ = fs::remove_dir_all(&tmp);
        Ok((count, proj.clone()))
    }
    .await;

    match res {
        Ok((count, folder)) => Json(json!({ "ok": true, "count": count, "folder": folder })).into_response(),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

// ---------------------------------------------------------------------------
// Live code execution (Python / Julia / Wolfram)
// ---------------------------------------------------------------------------

const IMAGE_EXT: [&str; 5] = [".png", ".jpg", ".jpeg", ".svg", ".gif"];

// Cross-platform `which`: walk PATH ourselves. On Windows the entries are
// separated by ';' and we try each PATHEXT extension so `which("python")`
// matches `python.exe`; on Unix it's ':' and a bare name.
fn which(name: &str) -> Option<String> {
    let path = std::env::var("PATH").unwrap_or_default();
    let sep = if cfg!(windows) { ';' } else { ':' };
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into())
            .split(';')
            .map(|s| s.to_string())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in path.split(sep) {
        if dir.is_empty() {
            continue;
        }
        for ext in &exts {
            let cand = Path::new(dir).join(format!("{name}{ext}"));
            if cand.is_file() {
                return Some(cand.to_string_lossy().into_owned());
            }
        }
    }
    None
}

// Where a Python environment keeps its interpreter. Unix uses bin/python;
// Windows differs by tool — conda writes python.exe at the env root, while
// venv/virtualenv/uv put it under Scripts\ — so both have to be checked or
// every .venv on Windows looks like "not found".
fn python_in(dir: &Path) -> Option<String> {
    let cands: [PathBuf; 3] = if cfg!(windows) {
        [dir.join("python.exe"), dir.join("Scripts/python.exe"), dir.join("bin/python.exe")]
    } else {
        [dir.join("bin/python3"), dir.join("bin/python"), dir.join("python")]
    };
    cands.iter().find(|p| usable_binary(p)).map(|p| p.to_string_lossy().into_owned())
}

fn usable_binary(p: &Path) -> bool {
    p.is_file()
}

// Windows registers "App Execution Aliases" for python/python3 under
// WindowsApps: 0-byte reparse stubs that open the Microsoft Store rather than
// running anything when Store Python isn't installed. One may well be first on
// PATH, so prefer a real install and keep the alias as a last resort.
fn is_store_alias(p: &Path) -> bool {
    cfg!(windows)
        && fs::metadata(p).map(|m| m.len() == 0).unwrap_or(false)
        && p.to_string_lossy().to_lowercase().contains("windowsapps")
}

// Every immediate subdirectory, sorted, so listings are stable between launches.
fn sorted_subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    out.sort();
    out
}

fn dir_name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

// Discover every interpreter we can offer (conda envs, venvs, uv, pyenv, ...).
fn detect_interpreters() -> Interpreters {
    let home = dirs::home_dir().unwrap_or_default();
    let mut out = Interpreters::default();

    let py_in = |dir: &Path| python_in(dir);
    let first_file = |cands: &[PathBuf]| cands.iter().find(|p| usable_binary(p)).map(|p| p.to_string_lossy().into_owned());

    let on_path = |name: &str| which(name).filter(|p| usable_binary(Path::new(p)));
    let real_on_path = |name: &str| on_path(name).filter(|p| !is_store_alias(Path::new(p)));
    let base_py = real_on_path("python3")
        .or_else(|| real_on_path("python"))
        .or_else(|| if cfg!(windows) { real_on_path("py") } else { None })
        .or_else(|| {
            let mut cands: Vec<PathBuf> = if cfg!(windows) {
                vec![
                    PathBuf::from(r"C:\Python313\python.exe"),
                    PathBuf::from(r"C:\Python312\python.exe"),
                    PathBuf::from(r"C:\Python311\python.exe"),
                ]
            } else {
                vec![
                    home.join("miniconda3/bin/python3"),
                    PathBuf::from("/opt/homebrew/bin/python3"),
                    PathBuf::from("/usr/local/bin/python3"),
                    PathBuf::from("/usr/bin/python3"),
                ]
            };
            // Windows per-user installs: %LOCALAPPDATA%\Programs\Python\Python3xx\python.exe
            if cfg!(windows) {
                if let Ok(rd) = fs::read_dir(home.join("AppData/Local/Programs/Python")) {
                    for e in rd.flatten() {
                        cands.push(e.path().join("python.exe"));
                    }
                }
            }
            first_file(&cands)
        })
        // No real install anywhere: a Store alias still beats reporting that
        // Python isn't on this machine at all.
        .or_else(|| on_path("python3"))
        .or_else(|| on_path("python"));
    if let Some(p) = base_py {
        out.python.push(Interp::found("Default (python)", p));
    }

    // conda / mamba environments — root locations differ per platform.
    let conda_roots: Vec<PathBuf> = if cfg!(windows) {
        ["miniconda3", "anaconda3", "mambaforge", "miniforge3"]
            .iter()
            .flat_map(|r| {
                vec![
                    home.join(r),
                    home.join("AppData/Local").join(r),
                    PathBuf::from(format!(r"C:\{r}")),
                    PathBuf::from(format!(r"C:\ProgramData\{r}")),
                ]
            })
            .collect()
    } else {
        ["miniconda3", "anaconda3", "mambaforge", "miniforge3"].iter().map(|r| home.join(r)).collect()
    };
    for root in &conda_roots {
        for env in sorted_subdirs(&root.join("envs")) {
            if let Some(p) = py_in(&env) {
                out.python.push(Interp::found(format!("conda: {}", dir_name(&env)), p));
            }
        }
    }

    // Virtualenv collections: virtualenvwrapper's ~/.virtualenvs and the plain
    // ~/.venvs a lot of people keep by hand.
    for (kind, dir) in [("venv", home.join(".virtualenvs")), ("venv", home.join(".venvs"))] {
        for env in sorted_subdirs(&dir) {
            if let Some(p) = py_in(&env) {
                out.python.push(Interp::found(format!("{kind}: {}", dir_name(&env)), p));
            }
        }
    }

    // uv's own Python builds. uv keeps them under its data directory, which is
    // XDG_DATA_HOME (or ~/.local/share) on Unix and %APPDATA%\uv\data on Windows.
    let uv_roots: Vec<PathBuf> = if cfg!(windows) {
        vec![home.join("AppData/Roaming/uv/data/python"), home.join("AppData/Local/uv/data/python")]
    } else {
        let mut roots = vec![home.join(".local/share/uv/python")];
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            roots.insert(0, PathBuf::from(xdg).join("uv/python"));
        }
        roots
    };
    for root in &uv_roots {
        for env in sorted_subdirs(root) {
            if let Some(p) = py_in(&env) {
                out.python.push(Interp::found(format!("uv: {}", dir_name(&env)), p));
            }
        }
    }

    // pyenv versions (pyenv-win keeps the same layout one level deeper).
    for root in [home.join(".pyenv/versions"), home.join(".pyenv/pyenv-win/versions")] {
        for env in sorted_subdirs(&root) {
            if let Some(p) = py_in(&env) {
                out.python.push(Interp::found(format!("pyenv: {}", dir_name(&env)), p));
            }
        }
    }

    let mut jl = on_path("julia").or_else(|| {
        first_file(&if cfg!(windows) {
            vec![
                home.join(".juliaup/bin/julia.exe"),
                home.join("AppData/Local/Programs/Julia/bin/julia.exe"),
                home.join("AppData/Local/Microsoft/WindowsApps/julia.exe"),
            ]
        } else {
            vec![home.join(".juliaup/bin/julia"), PathBuf::from("/opt/homebrew/bin/julia"), PathBuf::from("/usr/local/bin/julia")]
        })
    });
    // Windows installers drop a versioned folder (Julia-1.11.2\bin\julia.exe)
    // rather than a fixed path, so fall back to scanning for the newest one.
    if jl.is_none() && cfg!(windows) {
        for parent in [home.join("AppData/Local/Programs"), PathBuf::from(r"C:\")] {
            let mut versioned: Vec<PathBuf> = sorted_subdirs(&parent)
                .into_iter()
                .filter(|d| dir_name(d).to_lowercase().starts_with("julia"))
                .collect();
            versioned.reverse();
            jl = versioned.iter().map(|d| d.join("bin/julia.exe")).find(|p| usable_binary(p)).map(|p| p.to_string_lossy().into_owned());
            if jl.is_some() {
                break;
            }
        }
    }
    if let Some(p) = jl {
        out.julia.push(Interp::found("Default (julia)", p));
    }

    let wl = on_path("wolframscript").or_else(|| {
        first_file(&if cfg!(windows) {
            vec![PathBuf::from(r"C:\Program Files\Wolfram Research\WolframScript\wolframscript.exe")]
        } else {
            vec![PathBuf::from("/usr/local/bin/wolframscript"), PathBuf::from("/opt/homebrew/bin/wolframscript")]
        })
    });
    if let Some(p) = wl {
        out.wolfram.push(Interp::found("WolframScript", p));
    }

    // The same interpreter often turns up twice (the one on PATH is also the one
    // pyenv or conda manages). Keep the first, most descriptive entry.
    for lang in ["python", "julia", "wolfram"] {
        if let Some(list) = out.for_lang_mut(lang) {
            let mut seen: Vec<String> = Vec::new();
            list.retain(|i| {
                if seen.iter().any(|s| same_path(s, &i.path)) {
                    return false;
                }
                seen.push(i.path.clone());
                true
            });
        }
    }

    out
}

// The environment belonging to the project that's open. `uv venv`, `python -m
// venv` and Poetry all create one of these in the project root, and it is the
// interpreter a reproducibility-minded user actually wants — so offer it without
// making them hunt for the path.
fn workspace_interpreters(ws: &Path) -> Interpreters {
    let mut out = Interpreters::default();
    for name in [".venv", "venv", ".env", "env"] {
        let dir = ws.join(name);
        if !dir.is_dir() {
            continue;
        }
        if let Some(p) = python_in(&dir) {
            out.python.push(Interp::found(format!("project: {name}"), p));
        }
    }
    out
}

fn custom_interpreters_file() -> PathBuf {
    if let Ok(p) = std::env::var("HILBERT_INTERPRETERS_FILE") {
        return PathBuf::from(p);
    }
    dirs::config_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config"))
        .join("hilbert")
        .join("interpreters.json")
}

// Stored as { "python": [{ "label": …, "path": … }], … }. Entries whose binary
// has since been deleted are dropped on load so a stale list can't be executed.
fn load_custom_interpreters() -> Interpreters {
    let mut out = Interpreters::default();
    let Ok(raw) = fs::read_to_string(custom_interpreters_file()) else { return out };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else { return out };
    for lang in ["python", "julia", "wolfram"] {
        let Some(entries) = v.get(lang).and_then(|e| e.as_array()) else { continue };
        let list: Vec<Interp> = entries
            .iter()
            .filter_map(|e| {
                let path = e.get("path")?.as_str()?.to_string();
                if !usable_binary(Path::new(&path)) {
                    return None;
                }
                let label = e.get("label").and_then(|l| l.as_str()).unwrap_or("custom").to_string();
                Some(Interp { label, path, custom: true })
            })
            .collect();
        if let Some(slot) = out.for_lang_mut(lang) {
            *slot = list;
        }
    }
    out
}

fn save_custom_interpreters(all: &Interpreters) -> std::io::Result<()> {
    let path = custom_interpreters_file();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = json!({ "python": all.python, "julia": all.julia, "wolfram": all.wolfram });
    fs::write(path, serde_json::to_vec_pretty(&body).unwrap_or_default())
}

// Name an environment after the folder that owns it, so a list of a dozen
// project venvs stays readable: …/proj/.venv/bin/python → "proj".
fn env_name_for(path: &Path) -> String {
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "custom".into());
    let mut dir = path.parent();
    // Step over bin/ or Scripts/ to reach the environment root.
    if dir.map(|d| matches!(dir_name(d).as_str(), "bin" | "Scripts")).unwrap_or(false) {
        dir = dir.and_then(|d| d.parent());
    }
    let Some(dir) = dir else { return stem };
    let name = dir_name(dir);
    // A venv folder is named after the convention, not the project, so it says
    // nothing on its own — borrow the name of the folder holding it.
    let is_venv_marker = matches!(name.as_str(), "venv" | "env") || name.starts_with(".venv") || name.starts_with(".env");
    if is_venv_marker {
        let parent = dir.parent().map(dir_name).unwrap_or_default();
        if !parent.is_empty() {
            return parent;
        }
    }
    // A binary sitting in a system prefix (/usr/local/bin/julia) has no
    // environment to name it after; the binary's own name is more use.
    let generic = name.is_empty() || matches!(name.to_lowercase().as_str(), "usr" | "local" | "opt" | "programs" | "program files" | "bin");
    if generic {
        return stem;
    }
    name.trim_start_matches('.').to_string()
}

// Check a hand-entered interpreter before we agree to run it: it must exist, be
// executable, and answer --version. The version goes into the label so the list
// distinguishes several environments at a glance.
async fn probe_interpreter(lang: &str, path: &str) -> Result<Interp, String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err("Enter the full path to the interpreter.".into());
    }
    if !usable_binary(p) {
        return Err(format!("No executable file at {path}."));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = fs::metadata(p).map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false);
        if !executable {
            return Err(format!("{path} is not executable."));
        }
    }
    let arg = if lang == "wolfram" { "-version" } else { "--version" };
    let out = run_cmd(path, &[arg], None, Some(15_000))
        .await
        .map_err(|e| format!("Could not run {path}: {e}"))?;
    if out.killed {
        return Err(format!("{path} did not respond to {arg} within 15 s."));
    }
    let banner = out.stdout.lines().chain(out.stderr.lines()).map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if out.code != Some(0) || banner.is_empty() {
        return Err(format!("{path} did not look like a working {lang} interpreter."));
    }
    // Every one of these names itself in its version banner ("Python 3.12.1",
    // "julia version 1.11.2", "WolframScript 1.10"), so this catches pointing
    // the Python slot at, say, a Julia binary before a run fails confusingly.
    if !banner.to_lowercase().contains(lang) {
        return Err(format!("That looks like \"{banner}\", not {lang}. Pick the {lang} executable itself."));
    }
    // "Python 3.12.1" / "julia version 1.11.2" → just the number.
    let version = banner.split_whitespace().find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit())).unwrap_or(banner);
    Ok(Interp { label: format!("{} ({version})", env_name_for(p)), path: path.to_string(), custom: true })
}

async fn tools(State(st): St) -> Response {
    let all = st.available();
    Json(json!({
        "execEnabled": st.allow_exec,
        "interpreters": all,
        "available": {
            "python": !all.python.is_empty(),
            "julia": !all.julia.is_empty(),
            "wolfram": !all.wolfram.is_empty(),
        }
    }))
    .into_response()
}

// Add an interpreter the user pointed us at. Registering it here is what later
// lets /exec run it: the runner only ever launches a path present in this list.
async fn tools_interpreter_add(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let lang = jstr(&v, "lang").unwrap_or("").to_string();
    let path = jstr(&v, "path").unwrap_or("").trim().to_string();
    if !matches!(lang.as_str(), "python" | "julia" | "wolfram") {
        return json_err(StatusCode::BAD_REQUEST, "Choose python, julia, or wolfram.");
    }
    if path.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "Give the path to the interpreter.");
    }
    let interp = match probe_interpreter(&lang, &path).await {
        Ok(i) => i,
        Err(message) => return json_err(StatusCode::BAD_REQUEST, message),
    };
    {
        let mut custom = st.custom.write().unwrap_or_else(|e| e.into_inner());
        if let Some(list) = custom.for_lang_mut(&lang) {
            list.retain(|i| !same_path(&i.path, &interp.path));
            list.push(interp.clone());
        }
        if let Err(e) = save_custom_interpreters(&custom) {
            return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Could not save the interpreter list: {e}"));
        }
    }
    Json(json!({ "ok": true, "interpreter": interp })).into_response()
}

async fn tools_interpreter_remove(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let lang = jstr(&v, "lang").unwrap_or("").to_string();
    let path = jstr(&v, "path").unwrap_or("").to_string();
    let mut custom = st.custom.write().unwrap_or_else(|e| e.into_inner());
    let Some(list) = custom.for_lang_mut(&lang) else {
        return json_err(StatusCode::BAD_REQUEST, "Choose python, julia, or wolfram.");
    };
    list.retain(|i| !same_path(&i.path, &path));
    if let Err(e) = save_custom_interpreters(&custom) {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Could not save the interpreter list: {e}"));
    }
    Json(json!({ "ok": true })).into_response()
}

// Native "browse for the executable" picker. Returns the path only; the caller
// still has to add it, so a mistaken pick fails with a readable message.
async fn tools_interpreter_pick(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let lang = jstr(&v, "lang").unwrap_or("python").to_string();
    let app = st.app.lock().unwrap().clone();
    let Some(app) = app else {
        return Json(json!({ "path": null, "noDialog": true })).into_response();
    };
    let picked = tokio::task::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let mut dialog = app.dialog().file().set_title(format!("Choose a {lang} interpreter"));
        // Windows hides extensionless files behind a filter, and every
        // interpreter there ends in .exe; elsewhere the binary has no extension.
        if cfg!(windows) {
            dialog = dialog.add_filter("Executable", &["exe", "bat", "cmd"]);
        }
        dialog.blocking_pick_file()
    })
    .await
    .ok()
    .flatten();
    let path = picked.and_then(|fp| fp.into_path().ok()).map(|p| p.to_string_lossy().into_owned());
    Json(json!({ "path": path })).into_response()
}

fn ext_for(lang: &str) -> Option<&'static str> {
    match lang {
        "python" => Some("py"),
        "julia" => Some("jl"),
        "wolfram" => Some("wls"),
        _ => None,
    }
}

// Auto-convert a result to LaTeX so users write plain maths and still get a
// typeset equation — without writing TeXForm / latex() themselves.
fn wrap_for_equation(lang: &str, code: &str) -> String {
    let lines: Vec<&str> = code
        .split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("//"))
        .collect();
    if lines.is_empty() {
        return code.to_string();
    }
    match lang {
        "wolfram" => format!("Print[ToString[TeXForm[(\n{}\n)]]]", lines.join(";\n")),
        "python" => {
            let last = lines[lines.len() - 1];
            let setup = lines[..lines.len() - 1].join("\n");
            format!("from sympy import *\nx, y, z, t, n, k, a, b, c = symbols('x y z t n k a b c')\n{setup}\nprint(latex({last}))")
        }
        "julia" => {
            let last = lines[lines.len() - 1];
            let setup = lines[..lines.len() - 1].join("\n");
            format!("using Latexify\n{setup}\nprint(latexify({last}))")
        }
        _ => code.to_string(),
    }
}

// Extra safety layer: refuse code that does process spawning, networking, shell
// access or destructive file ops. Heuristic, NOT a real sandbox.
static DENY_COMMON: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        // process / shell / dynamic-exec
        r"\bsubprocess\b", r"\bos\.system\b", r"\bos\.popen\b", r"(?i)\bpopen\b",
        r"\bos\.fork\b", r"\bos\.exec\w*", r"\bos\.spawn\w*", r"\bposix_spawn\b",
        r"\bmultiprocessing\b", r"\bpty\b", r"\bcommands\b",
        r"\beval\s*\(", r"\bexec\s*\(", r"\bcompile\s*\(", r"\b__import__\b",
        r"\bimportlib\b", r"\bmarshal\b",
        // networking
        r"\bsocket\b", r"\brequests\b", r"\burllib\b", r"\bhttpx\b", r"\baiohttp\b",
        r"\bhttp\.client\b", r"\bsmtplib\b", r"\bftplib\b", r"\btelnetlib\b",
        r"\bxmlrpc\b", r"\bsocketserver\b", r"\bwebbrowser\b", r"\bparamiko\b",
        // filesystem: destructive, escaping cwd, or environment tampering
        r"\bshutil\b", r"\bos\.remove\b", r"\bos\.unlink\b", r"\.unlink\s*\(",
        r"\brmtree\b", r"\bos\.rmdir\b", r"\bos\.rename\b", r"\bos\.replace\b",
        r"\bos\.chdir\b", r"\bos\.chmod\b", r"\bos\.chown\b", r"\bos\.truncate\b",
        r"\bos\.environ\b", r"\bos\.putenv\b", r"\bpickle\b", r"\bctypes\b",
        r#"open\s*\(\s*[rbfu]*['"]\s*(/|~|\.\.)"#,
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});
static DENY_JULIA: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"\brun\s*\(", r"\bdownload\s*\(", r"\bSys\.\w", r"\bccall\b", r"\bpipeline\s*\(",
        r"\bopen\s*\(`", r"\brm\s*\(", r"\bmv\s*\(", r"\bcp\s*\(", r"\bcd\s*\(",
        r"\btouch\s*\(", r"\bchmod\s*\(", r"\bchown\s*\(", r"\bsymlink\s*\(",
        r"\binclude\s*\(", r"\bevalfile\b", r"\bLibdl\b", r"\bLibc\b", r"\bunsafe_\w",
        r"\bPkg\.", r"\bHTTP\.", r"\bSockets\b", r"\bDistributed\b", r"\baddprocs\b",
        r#"open\s*\(\s*"\s*(/|~|\.\.)"#,
    ]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
});
static DENY_WOLFRAM: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"\bRun\s*\[", r"\bRunProcess\s*\[", r"\bStartProcess\s*\[", r"\bDeleteFile\s*\[",
        r"\bDeleteDirectory\s*\[", r"\bURL(Fetch|Read|Submit|Save|Download|Execute)\s*\[",
        r"\bSystemOpen\s*\[", r"\bCreateFile\s*\[", r#"(?i)\bImport\s*\[\s*"https?:"#,
        r"\bExternalEvaluate\s*\[", r"\bStartExternalSession\s*\[", r"\bLibraryFunctionLoad\s*\[",
        r"\bInstall\s*\[", r"\bDumpSave\s*\[", r"\bOpenWrite\s*\[", r"\bOpenAppend\s*\[",
        r"\bSendMail\s*\[", r"\bCloudDeploy\s*\[", r"\bDeleteObject\s*\[",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});

static DENY_NONE: LazyLock<Vec<Regex>> = LazyLock::new(Vec::new);

fn screen_code(lang: &str, code: &str) -> Option<String> {
    let extra: &Vec<Regex> = match lang {
        "julia" => &DENY_JULIA,
        "wolfram" => &DENY_WOLFRAM,
        _ => &DENY_NONE,
    };
    for re in DENY_COMMON.iter().chain(extra.iter()) {
        if let Some(m) = re.find(code) {
            return Some(m.as_str().to_string());
        }
    }
    None
}

fn image_stats(dir: &Path) -> HashMap<String, f64> {
    let mut m = HashMap::new();
    let Ok(rd) = fs::read_dir(dir) else { return m };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let lower = name.to_lowercase();
        if !IMAGE_EXT.iter().any(|e| lower.ends_with(e)) {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(t) = meta.modified() {
                m.insert(name, epoch_ms(t));
            }
        }
    }
    m
}

// Reserved per-workspace scratch dir. Compile output and code-exec scratch live
// here (hidden, since it's a dotfile), so they never clutter the user's files —
// and it's the future home for per-workspace settings and logs.
fn hilbert_dir(ws: &Path) -> PathBuf { ws.join(".hilbert") }
fn hilbert_run(ws: &Path) -> PathBuf { hilbert_dir(ws).join("run") }

// Python/Julia logos used to badge code blocks in the compiled PDF. Written into
// the (hidden) .hilbert dir so a document's `#image(".hilbert/logos/…")` show
// rule always resolves, and they never clutter the user's files.
const PY_LOGO_SVG: &str = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path fill='#3776AB' d='M15.9 2C9 2 9.5 5 9.5 5v3.1h6.6v.9H6.9S2.5 8.6 2.5 15.9c0 7.4 3.8 7.1 3.8 7.1h2.3v-3.3s-.1-3.9 3.8-3.9h6.5s3.7.1 3.7-3.6V6.2S24 2 15.9 2zM12.2 4.1c.6 0 1.1.5 1.1 1.1s-.5 1.1-1.1 1.1-1.1-.5-1.1-1.1.5-1.1 1.1-1.1z'/><path fill='#FFD43B' d='M16.1 30c6.9 0 6.4-3 6.4-3v-3.1h-6.6v-.9h9.2s4.4.5 4.4-7.1c0-7.3-3.8-7.1-3.8-7.1h-2.3v3.3s.1 3.9-3.8 3.9h-6.5s-3.7-.1-3.7 3.6v6.1S8 30 16.1 30zm3.7-2.1c-.6 0-1.1-.5-1.1-1.1s.5-1.1 1.1-1.1 1.1.5 1.1 1.1-.5 1.1-1.1 1.1z'/></svg>";
const JL_LOGO_SVG: &str = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><circle cx='10' cy='22' r='5.5' fill='#389826'/><circle cx='22' cy='22' r='5.5' fill='#9558B2'/><circle cx='16' cy='9' r='5.5' fill='#CB3C33'/></svg>";

// Ensure the scratch dir exists, drop the legacy root out.pdf, and make sure the
// code-block logos are present so a compile referencing them never fails.
fn ensure_hilbert(ws: &Path) {
    let _ = fs::create_dir_all(hilbert_run(ws));
    let legacy = ws.join("out.pdf");
    if legacy.exists() { let _ = fs::remove_file(&legacy); }
    let logos = hilbert_dir(ws).join("logos");
    let _ = fs::create_dir_all(&logos);
    let py = logos.join("python.svg");
    if !py.exists() { let _ = fs::write(&py, PY_LOGO_SVG); }
    let jl = logos.join("julia.svg");
    if !jl.exists() { let _ = fs::write(&jl, JL_LOGO_SVG); }
}

// Move freshly-produced plot images out of the ephemeral run dir into a visible,
// persistent assets/ folder. A document that embeds a plot references it, so it
// must survive the scratch dir being swept — assets/ is the right home for it.
// Returns the workspace-relative paths to reference from the document.
fn promote_images(ws: &Path, run_dir: &Path, names: &[String]) -> Vec<String> {
    if names.is_empty() { return Vec::new(); }
    let assets = ws.join("assets");
    let _ = fs::create_dir_all(&assets);
    let mut out = Vec::new();
    for name in names {
        let from = run_dir.join(name);
        let to = assets.join(name);
        // rename is atomic within one filesystem; fall back to copy+remove.
        if fs::rename(&from, &to).is_ok()
            || (fs::copy(&from, &to).is_ok() && { let _ = fs::remove_file(&from); true })
        {
            out.push(format!("assets/{name}"));
        } else if from.exists() {
            out.push(format!(".hilbert/run/{name}"));
        }
    }
    out.sort();
    out
}

async fn run_code(State(st): St, body: Bytes) -> Response {
    static CONNECTING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Connecting….*?\n").unwrap());
    if !st.allow_exec {
        return json_err(StatusCode::FORBIDDEN, "Code execution is disabled on this server (ALLOW_CODE_EXECUTION=0).");
    }
    let v = parse_json(&body);
    let lang = jstr(&v, "lang").unwrap_or("");
    let mut code = jstr(&v, "code").unwrap_or("").to_string();
    let bin = jstr(&v, "bin").unwrap_or("");
    let output_mode = jstr(&v, "outputMode").unwrap_or("");
    let Some(ext) = ext_for(lang) else {
        return json_err(StatusCode::BAD_REQUEST, "Valid lang and code are required.");
    };
    if code.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "Valid lang and code are required.");
    }

    if let Some(blocked) = screen_code(lang, &code) {
        return json_err(
            StatusCode::BAD_REQUEST,
            format!("Blocked for safety: code uses \"{blocked}\" (process/network/filesystem access is not allowed). Disable this check only if you trust the code."),
        );
    }

    if output_mode == "equation" {
        code = wrap_for_equation(lang, &code);
    }

    // Pick the interpreter: an explicit path if it is one we know about (detected,
    // in the project, or added by the user), else the default.
    let known = st.available();
    let options = known.for_lang(lang);
    let Some(chosen) = options.iter().find(|o| same_path(&o.path, bin)).or_else(|| options.first()) else {
        return json_err(StatusCode::BAD_REQUEST, format!("{lang} is not available on this system."));
    };
    let Ok(_permit) = st.exec_gate.acquire().await else {
        return json_err(StatusCode::SERVICE_UNAVAILABLE, "Code runner is shutting down.");
    };

    let ws = st.ws();
    let sandbox = hilbert_run(&ws);
    let _ = fs::create_dir_all(&sandbox);
    let script_name = format!("_run.{ext}");
    let script_path = sandbox.join(&script_name);

    let before = image_stats(&sandbox);
    if fs::write(&script_path, &code).is_err() {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not write script.");
    }

    // Julia: skip the user's startup.jl and stay quiet — noticeably snappier.
    let args: Vec<&str> = match lang {
        "wolfram" => vec!["-file", &script_name],
        "julia" => vec!["--startup-file=no", "-q", &script_name],
        _ => vec![&script_name],
    };
    let out = match run_exec_cmd(&chosen.path, &args, Some(&sandbox), Some(st.exec_timeout_ms)).await {
        Ok(o) => o,
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to start {lang}: {e}")),
    };

    // New OR rewritten images become persistent assets/ files (see promote_images).
    let after = image_stats(&sandbox);
    let changed: Vec<String> = after
        .iter()
        .filter(|(f, t)| before.get(*f).map(|old| old != *t).unwrap_or(true))
        .map(|(f, _)| f.clone())
        .collect();
    let images = promote_images(&ws, &sandbox, &changed);

    Json(json!({
        "ok": out.code == Some(0) && !out.killed,
        "exitCode": out.code,
        "timedOut": out.killed,
        "interpreter": chosen.label,
        "stdout": out.stdout,
        "stderr": CONNECTING.replace_all(&out.stderr, "").into_owned(),
        "images": images,
    }))
    .into_response()
}

// ---------------------------------------------------------------------------
// Notebook execution — run a document's code chunks in ONE persistent session
// per language, so variables carry from chunk to chunk (Jupyter-style). Idea
// borrowed from calepin: a single interpreter process executes every chunk in a
// shared namespace, and each chunk's result is framed with a random sentinel so
// the combined output can be split back apart. Nothing stays resident between
// runs — the process lives only for the length of one run.
// ---------------------------------------------------------------------------

const NB_PY: &str = r#"import sys, io, os, base64, traceback, ast
os.environ.setdefault("MPLBACKEND", "Agg")
SEP = "__SEP__"; SENT = "__SENT__"
src = open("nb_cells.txt", encoding="utf-8").read()
cells = src.split("\n" + SEP + "\n") if src else []
g = {"__name__": "__main__"}
real = sys.__stdout__
def _pngs(): return {f: os.path.getmtime(f) for f in os.listdir(".") if f.lower().endswith(".png")}
def _b(s): return base64.b64encode(s.encode("utf-8")).decode("ascii")
for i, code in enumerate(cells):
    before = _pngs(); buf = io.StringIO(); old = sys.stdout; sys.stdout = buf; err = ""
    try:
        tree = ast.parse(code)
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = tree.body.pop()
            exec(compile(tree, "<cell>", "exec"), g)
            val = eval(compile(ast.Expression(last.value), "<cell>", "eval"), g)
            if val is not None: print(repr(val))
        else:
            exec(compile(code, "<cell>", "exec"), g)
    except SystemExit:
        pass
    except BaseException:
        err = traceback.format_exc()
    finally:
        sys.stdout = old
    imgs = []
    try:
        import matplotlib.pyplot as plt
        if plt.get_fignums():
            p = "nb_cell%d.png" % i; plt.gcf().savefig(p, dpi=130, bbox_inches="tight"); plt.close("all"); imgs.append(p)
    except Exception:
        pass
    after = _pngs()
    for f in sorted(after):
        if f not in imgs and (f not in before or after[f] != before[f]): imgs.append(f)
    real.write("%s\t%d\t%s\t%s\t%s\n" % (SENT, i, _b(buf.getvalue()), _b(err), ",".join(imgs))); real.flush()
"#;

const NB_JL: &str = r#"using Base64
SEP = "__SEP__"; SENT = "__SENT__"
src = read("nb_cells.txt", String)
cells = isempty(src) ? String[] : split(src, "\n" * SEP * "\n")
real = stdout
pngs() = Dict(f => mtime(f) for f in filter(x->endswith(lowercase(x), ".png"), readdir(".")))
for (idx, code) in enumerate(cells)
    i = idx - 1
    before = pngs()
    outfile = "nb_out_$i.txt"
    err = ""
    open(outfile, "w") do io
        redirect_stdout(io) do
            try
                val = include_string(Main, code, "cell_$i")
                # Echo the last expression's value, IJulia-style, unless the cell
                # ends with ';' or the value is nothing.
                if val !== nothing && !endswith(rstrip(code), ";")
                    # invokelatest: the cell may have just `using`-ed a package
                    # (e.g. Plots), defining methods in a newer world age. This
                    # loop body runs at the world captured before that, so calling
                    # show()/showable() directly would hit "method too new" world-age
                    # errors — invokelatest runs them in the current world instead.
                    # A displayable value (a plot) is written to a PNG so the
                    # notebook shows it as an image; anything else echoes as text.
                    if Base.invokelatest(showable, "image/png", val)
                        open("nb_plot_$i.png", "w") do pio
                            Base.invokelatest(show, pio, "image/png", val)
                        end
                    else
                        Base.invokelatest(show, stdout, "text/plain", val); println(stdout)
                    end
                end
            catch e
                err = sprint(showerror, e)
            end
        end
    end
    out = read(outfile, String)
    rm(outfile, force=true)
    after = pngs()
    imgs = sort([f for f in keys(after) if !haskey(before, f) || after[f] != before[f]])
    println(real, join([SENT, string(i), base64encode(out), base64encode(err), join(imgs, ",")], "\t"))
    flush(real)
end
"#;

async fn notebook_run(State(st): St, body: Bytes) -> Response {
    if !st.allow_exec {
        return json_err(StatusCode::FORBIDDEN, "Code execution is disabled on this server (ALLOW_CODE_EXECUTION=0).");
    }
    let v = parse_json(&body);
    let lang = jstr(&v, "lang").unwrap_or("");
    let bin = jstr(&v, "bin").unwrap_or("");
    if lang != "python" && lang != "julia" {
        return json_err(StatusCode::BAD_REQUEST, "Notebook run supports only python and julia.");
    }
    let cells: Vec<String> = v.get("cells").and_then(|c| c.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if cells.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "No code cells to run.");
    }
    // Same heuristic safety screen as the one-shot runner, per cell.
    for (i, c) in cells.iter().enumerate() {
        if let Some(blocked) = screen_code(lang, c) {
            return json_err(StatusCode::BAD_REQUEST, format!("Cell {} blocked for safety: code uses \"{}\" (process/network/filesystem access is not allowed).", i + 1, blocked));
        }
    }
    let known = st.available();
    let options = known.for_lang(lang);
    let Some(chosen) = options.iter().find(|o| same_path(&o.path, bin)).or_else(|| options.first()) else {
        return json_err(StatusCode::BAD_REQUEST, format!("{lang} is not available on this system."));
    };
    let Ok(_permit) = st.exec_gate.acquire().await else {
        return json_err(StatusCode::SERVICE_UNAVAILABLE, "Code runner is shutting down.");
    };

    let ws = st.ws();
    let sandbox = hilbert_run(&ws);
    let _ = fs::create_dir_all(&sandbox);

    // Random sentinel + separator so user output can never be mistaken for framing.
    let tag = format!("{:x}{:x}", std::process::id(), epoch_ms(SystemTime::now()) as u64);
    let sep = format!("<<<CELL {tag}>>>");
    let sent = format!("@@NB{tag}@@");

    let joined = cells.join(&format!("\n{sep}\n"));
    if fs::write(sandbox.join("nb_cells.txt"), joined).is_err() {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not stage notebook cells.");
    }
    let (script_name, harness) = match lang {
        "julia" => ("_nb.jl", NB_JL),
        _ => ("_nb.py", NB_PY),
    };
    let script = harness.replace("__SEP__", &sep).replace("__SENT__", &sent);
    if fs::write(sandbox.join(script_name), script).is_err() {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not write notebook harness.");
    }

    let args: Vec<&str> = match lang {
        "julia" => vec!["--startup-file=no", "-q", script_name],
        _ => vec![script_name],
    };
    // One process runs every cell, so give it room proportional to cell count.
    let timeout = st.exec_timeout_ms.saturating_mul(cells.len() as u64).min(600_000);
    let out = match run_exec_cmd(&chosen.path, &args, Some(&sandbox), Some(timeout)).await {
        Ok(o) => o,
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to start {lang}: {e}")),
    };

    // Split the sentinel-framed lines into per-cell results.
    let mut results: Vec<Value> = (0..cells.len())
        .map(|_| json!({ "stdout": "", "error": "Cell did not run (the session ended before reaching it).", "images": [] }))
        .collect();
    let dec = |s: &str| -> String {
        base64::engine::general_purpose::STANDARD.decode(s).ok().and_then(|b| String::from_utf8(b).ok()).unwrap_or_default()
    };
    let prefix = format!("{sent}\t");
    for line in out.stdout.lines() {
        let Some(rest) = line.strip_prefix(&prefix) else { continue };
        let parts: Vec<&str> = rest.splitn(4, '\t').collect();
        if parts.len() < 4 { continue; }
        let Ok(idx) = parts[0].parse::<usize>() else { continue };
        if idx >= results.len() { continue; }
        let names: Vec<String> = parts[3].split(',').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect();
        let imgs = promote_images(&ws, &sandbox, &names);
        results[idx] = json!({ "stdout": dec(parts[1]), "error": dec(parts[2]), "images": imgs });
    }

    let any_sentinel = out.stdout.contains(&sent);
    Json(json!({
        "ok": out.code == Some(0) && !out.killed && any_sentinel,
        "timedOut": out.killed,
        "interpreter": chosen.label,
        "results": results,
        "stderr": if any_sentinel { String::new() } else { out.stderr },
    })).into_response()
}

// ---------------------------------------------------------------------------
// Template preview (one page, cached on disk)
// ---------------------------------------------------------------------------

async fn template_preview(State(st): St, Query(q): Q) -> Response {
    static NAME_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w-]+$").unwrap());
    static VER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w.]*$").unwrap());
    let name = q.get("name").map(String::as_str).unwrap_or("");
    let version = q.get("version").map(String::as_str).unwrap_or("");
    if !NAME_RE.is_match(name) {
        return json_err(StatusCode::BAD_REQUEST, "Invalid template name.");
    }
    if !VER_RE.is_match(version) {
        return json_err(StatusCode::BAD_REQUEST, "Invalid template version.");
    }
    let ws = st.ws();
    let cache_dir = ws.join(".previews");
    let _ = fs::create_dir_all(&cache_dir);
    let cached = cache_dir.join(format!("{name}-{}.png", if version.is_empty() { "latest" } else { version }));
    if cached.exists() {
        if let Ok(bytes) = fs::read(&cached) {
            return ([(header::CONTENT_TYPE, "image/png")], bytes).into_response();
        }
    }

    let dir = std::env::temp_dir().join(format!("typst-tpl-{}-{}", std::process::id(), name));
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::create_dir_all(&dir);
    let target = dir.join("t");
    let spec = if version.is_empty() { format!("@preview/{name}") } else { format!("@preview/{name}:{version}") };
    let cleanup = |dir: &Path| {
        let _ = fs::remove_dir_all(dir);
    };

    let init = match run_cmd("typst", &["init", &spec, &target.to_string_lossy()], None, Some(45000)).await {
        Ok(o) => o,
        Err(_) => {
            cleanup(&dir);
            return json_err(StatusCode::INTERNAL_SERVER_ERROR, "typst not found");
        }
    };
    if init.code != Some(0) {
        cleanup(&dir);
        return json_err(StatusCode::BAD_REQUEST, "Could not scaffold template.");
    }
    let files: Vec<String> = match fs::read_dir(&target) {
        Ok(rd) => rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect(),
        Err(_) => {
            cleanup(&dir);
            return json_err(StatusCode::INTERNAL_SERVER_ERROR, "No template files.");
        }
    };
    let main = files
        .iter()
        .find(|f| f.eq_ignore_ascii_case("main.typ"))
        .or_else(|| files.iter().find(|f| f.ends_with(".typ")))
        .cloned();
    let Some(main) = main else {
        cleanup(&dir);
        return json_err(StatusCode::BAD_REQUEST, "No .typ entry point.");
    };
    let out = target.join("preview.png");
    let comp = run_cmd(
        "typst",
        &["compile", "--format", "png", "--pages", "1", &target.join(&main).to_string_lossy(), &out.to_string_lossy()],
        Some(&target),
        Some(45000),
    )
    .await;
    let ok = matches!(comp, Ok(ref o) if o.code == Some(0)) && out.exists();
    if !ok {
        cleanup(&dir);
        return json_err(StatusCode::BAD_REQUEST, "Could not render preview.");
    }
    let bytes = fs::read(&out).unwrap_or_default();
    let _ = fs::write(&cached, &bytes);
    cleanup(&dir);
    ([(header::CONTENT_TYPE, "image/png")], bytes).into_response()
}

// Render page 1 of an app-bundled starter template to a PNG, so the New-from-
// Template dialog can preview the built-ins the same way it previews Universe
// ones. The template's files ride along in the request (they live in the
// frontend), get written to a throwaway temp dir, and are compiled there —
// never in the user's workspace. Cached by a hash of the entry content so
// re-selecting a template is instant.
async fn builtin_preview(body: Bytes) -> Response {
    use std::hash::{Hash, Hasher};
    let v = parse_json(&body);
    let Some(entry) = jstr(&v, "entry").filter(|e| !e.is_empty()) else {
        return json_err(StatusCode::BAD_REQUEST, "entry required");
    };
    let Some(files) = v.get("files").and_then(|f| f.as_array()) else {
        return json_err(StatusCode::BAD_REQUEST, "files required");
    };
    let entry_content = files
        .iter()
        .find(|f| f.get("path").and_then(|x| x.as_str()) == Some(entry))
        .and_then(|f| f.get("content").and_then(|x| x.as_str()))
        .unwrap_or("");
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    entry_content.hash(&mut hasher);
    let key = format!("{:x}", hasher.finish());

    let cache_dir = std::env::temp_dir().join("typst-editor-builtin-previews");
    let _ = fs::create_dir_all(&cache_dir);
    let cached = cache_dir.join(format!("{key}.png"));
    if let Ok(bytes) = fs::read(&cached) {
        return ([(header::CONTENT_TYPE, "image/png")], bytes).into_response();
    }

    let dir = std::env::temp_dir().join(format!("typst-editor-bp-{}-{key}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::create_dir_all(&dir);
    for f in files {
        let (Some(p), Some(c)) = (
            f.get("path").and_then(|x| x.as_str()),
            f.get("content").and_then(|x| x.as_str()),
        ) else { continue };
        let Some(full) = safe_workspace_path(&dir, p) else { continue };
        if let Some(parent) = full.parent() { let _ = fs::create_dir_all(parent); }
        let _ = fs::write(&full, c);
    }
    let Some(entry_path) = safe_workspace_path(&dir, entry) else {
        let _ = fs::remove_dir_all(&dir);
        return json_err(StatusCode::BAD_REQUEST, "bad entry path");
    };
    let out = dir.join("preview.png");
    let comp = run_cmd(
        "typst",
        &["compile", "--root", &dir.to_string_lossy(), "--format", "png", "--pages", "1", &entry_path.to_string_lossy(), &out.to_string_lossy()],
        Some(&dir),
        Some(45000),
    )
    .await;
    let ok = matches!(comp, Ok(ref o) if o.code == Some(0)) && out.exists();
    if !ok {
        let _ = fs::remove_dir_all(&dir);
        return json_err(StatusCode::BAD_REQUEST, "Could not render preview.");
    }
    let bytes = fs::read(&out).unwrap_or_default();
    let _ = fs::write(&cached, &bytes);
    let _ = fs::remove_dir_all(&dir);
    ([(header::CONTENT_TYPE, "image/png")], bytes).into_response()
}

// ---------------------------------------------------------------------------
// Typst package cache — list installed, download, remove
// ---------------------------------------------------------------------------

fn typst_cache_dir() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("TYPST_PACKAGE_CACHE_PATH") {
        let dir = Path::new(&p).join("preview");
        let _ = fs::create_dir_all(&dir);
        return Some(dir);
    }
    let home = dirs::home_dir()?;
    [home.join("Library/Caches/typst/packages/preview"), home.join(".cache/typst/packages/preview")]
        .into_iter()
        .find(|p| p.exists())
}

async fn packages_installed(State(_st): St) -> Response {
    static DESC_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"description\s*=\s*"([^"]*)""#).unwrap());
    static AUTH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"authors\s*=\s*\[([^\]]*)\]").unwrap());
    let Some(dir) = typst_cache_dir() else {
        return Json(json!([])).into_response();
    };
    let mut out: Vec<(String, String, String, Vec<String>)> = Vec::new();
    let Ok(rd) = fs::read_dir(&dir) else { return Json(json!([])).into_response() };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let nd = entry.path();
        if !nd.is_dir() {
            continue;
        }
        let Ok(vd) = fs::read_dir(&nd) else { continue };
        for ver in vd.flatten() {
            let version = ver.file_name().to_string_lossy().into_owned();
            let mut description = String::new();
            let mut authors: Vec<String> = Vec::new();
            if let Ok(toml) = fs::read_to_string(nd.join(&version).join("typst.toml")) {
                if let Some(c) = DESC_RE.captures(&toml) {
                    description = c[1].to_string();
                }
                if let Some(c) = AUTH_RE.captures(&toml) {
                    authors = c[1]
                        .split(',')
                        .map(|s| s.chars().filter(|ch| *ch != '"' && !ch.is_whitespace()).collect::<String>())
                        .filter(|s| !s.is_empty())
                        .collect();
                }
            }
            out.push((name.clone(), version, description, authors));
        }
    }
    out.sort_by(|a, b| if a.0 == b.0 { b.1.cmp(&a.1) } else { a.0.cmp(&b.0) });
    let arr: Vec<Value> = out
        .into_iter()
        .map(|(name, version, description, authors)| json!({ "name": name, "version": version, "description": description, "authors": authors }))
        .collect();
    Json(arr).into_response()
}

static PKG_NAME_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w-]+$").unwrap());
static PKG_VER_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\w.]+$").unwrap());

async fn packages_download(State(_st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let name = jstr(&v, "name").unwrap_or("");
    let version = jstr(&v, "version").unwrap_or("");
    if !PKG_NAME_RE.is_match(name) || !PKG_VER_RE.is_match(version) {
        return json_err(StatusCode::BAD_REQUEST, "Invalid package name/version.");
    }
    let dir = std::env::temp_dir().join(format!("typst-pkg-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let _ = fs::create_dir_all(&dir);
    let file = dir.join("t.typ");
    let _ = fs::write(&file, format!("#import \"@preview/{name}:{version}\"\n"));
    let out = run_cmd("typst", &["compile", &file.to_string_lossy(), &dir.join("o.pdf").to_string_lossy()], None, None).await;
    let err = match &out {
        Ok(o) => o.stderr.clone(),
        Err(e) => e.to_string(),
    };
    let _ = fs::remove_dir_all(&dir);
    // Typst fetches the package before evaluating, so it's cached even if the
    // bare import errors — verify by looking in the cache.
    let installed = typst_cache_dir().map(|c| c.join(name).join(version).exists()).unwrap_or(false);
    if installed {
        Json(json!({ "ok": true })).into_response()
    } else {
        let first = err.lines().next().unwrap_or("").to_string();
        json_err(StatusCode::BAD_REQUEST, if first.is_empty() { "Could not download package.".into() } else { first })
    }
}

async fn packages_remove(State(_st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let name = jstr(&v, "name").unwrap_or("");
    let version = jstr(&v, "version").unwrap_or("");
    if !PKG_NAME_RE.is_match(name) || !PKG_VER_RE.is_match(version) {
        return json_err(StatusCode::BAD_REQUEST, "Invalid package name/version.");
    }
    let Some(dir) = typst_cache_dir() else {
        return json_err(StatusCode::BAD_REQUEST, "No package cache found.");
    };
    let target = lexical_resolve(&dir, &format!("{name}/{version}"));
    if !target.starts_with(&dir) || target == dir {
        return json_err(StatusCode::BAD_REQUEST, "Invalid path.");
    }
    if !target.exists() {
        return json_err(StatusCode::NOT_FOUND, "Not installed.");
    }
    match fs::remove_dir_all(&target) {
        Ok(_) => {
            let name_dir = dir.join(name);
            if fs::read_dir(&name_dir).map(|mut rd| rd.next().is_none()).unwrap_or(false) {
                let _ = fs::remove_dir_all(&name_dir);
            }
            Json(json!({ "ok": true })).into_response()
        }
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Bibliography lookup — DOI or arXiv id → BibTeX
// ---------------------------------------------------------------------------

fn unesc(s: &str) -> String {
    static WS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());
    let s = s.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'");
    WS.replace_all(&s, " ").trim().to_string()
}

fn cite_key(author: &str, year: &str) -> String {
    let author = if author.is_empty() { "ref" } else { author };
    let first = author.split(" and ").next().unwrap_or("ref");
    let first = first.split(',').next().unwrap_or("ref").trim();
    let last = first.split_whitespace().last().unwrap_or("ref");
    let clean: String = last.chars().filter(|c| c.is_ascii_alphabetic()).collect();
    format!("{}{year}", if clean.is_empty() { "ref".to_string() } else { clean.to_lowercase() })
}

fn arxiv_to_bibtex(xml: &str, id: &str) -> Option<(String, String)> {
    static ENTRY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<entry>(.*?)</entry>").unwrap());
    static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<title>(.*?)</title>").unwrap());
    static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<name>(.*?)</name>").unwrap());
    static PUBLISHED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<published>(\d{4})").unwrap());
    static DOI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<arxiv:doi[^>]*>(.*?)</arxiv:doi>").unwrap());
    static VER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"v\d+$").unwrap());
    let entry = ENTRY.captures(xml)?.get(1)?.as_str();
    let title = unesc(TITLE.captures(entry).and_then(|c| c.get(1)).map(|m| m.as_str()).unwrap_or(""));
    let authors: Vec<String> = NAME.captures_iter(entry).filter_map(|c| c.get(1)).map(|m| unesc(m.as_str())).collect();
    let year = PUBLISHED.captures(entry).and_then(|c| c.get(1)).map(|m| m.as_str()).unwrap_or("").to_string();
    let doi = unesc(DOI.captures(entry).and_then(|c| c.get(1)).map(|m| m.as_str()).unwrap_or(""));
    let clean_id = VER.replace(id, "").into_owned();
    let key = cite_key(authors.first().map(String::as_str).unwrap_or(""), &year);
    let mut fields = vec![
        format!("  title = {{{title}}}"),
        format!("  author = {{{}}}", authors.join(" and ")),
        format!("  year = {{{year}}}"),
        format!("  eprint = {{{id}}}"),
        "  archivePrefix = {arXiv}".to_string(),
    ];
    if !doi.is_empty() {
        fields.push(format!("  doi = {{{doi}}}"));
    }
    fields.push(format!("  url = {{https://arxiv.org/abs/{clean_id}}}"));
    let bibtex = format!("@article{{{key},\n{},\n}}\n", fields.join(",\n"));
    Some((key, bibtex))
}

async fn bib_fetch(State(st): St, body: Bytes) -> Response {
    static ARXIV1: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)arxiv[:/ ]?\s*([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)").unwrap());
    static ARXIV2: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9]{4}\.[0-9]{4,5}(?:v\d+)?)$").unwrap());
    static DOI_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(10\.\d{4,9}/[^\s"'<>]+)"#).unwrap());
    static KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"@\w+\{\s*([^,\s]+)").unwrap());
    let v = parse_json(&body);
    let raw = jstr(&v, "id").unwrap_or("").trim().to_string();
    if raw.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "Enter a DOI or arXiv id.");
    }
    let timeout_err = |e: &reqwest::Error| if e.is_timeout() { "Lookup timed out.".to_string() } else { e.to_string() };

    // arXiv? (2101.12345, arXiv:2101.12345v2, or an arxiv.org URL)
    let arxiv_id = ARXIV1.captures(&raw).or_else(|| ARXIV2.captures(&raw)).map(|c| c[1].to_string());
    if let Some(id) = arxiv_id {
        let url = format!("http://export.arxiv.org/api/query?id_list={}", enc(&id));
        let resp = match st.http.get(&url).timeout(Duration::from_secs(15)).send().await {
            Ok(r) => r,
            Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, timeout_err(&e)),
        };
        let xml = resp.text().await.unwrap_or_default();
        return match arxiv_to_bibtex(&xml, &id) {
            Some((key, bibtex)) => Json(json!({ "key": key, "bibtex": bibtex })).into_response(),
            None => json_err(StatusCode::NOT_FOUND, "arXiv paper not found."),
        };
    }
    // DOI? (bare 10.xxxx/… or a doi.org URL)
    if let Some(c) = DOI_RE.captures(&raw) {
        let doi = c[1].trim_end_matches(['.', ',', ';']).to_string();
        let url = format!("https://doi.org/{doi}");
        let resp = match st
            .http
            .get(&url)
            .header("Accept", "application/x-bibtex; charset=utf-8")
            .timeout(Duration::from_secs(15))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, timeout_err(&e)),
        };
        if !resp.status().is_success() {
            return json_err(StatusCode::NOT_FOUND, format!("DOI lookup failed (HTTP {}).", resp.status().as_u16()));
        }
        let bibtex = resp.text().await.unwrap_or_default().trim().to_string();
        if !bibtex.starts_with('@') {
            return json_err(StatusCode::NOT_FOUND, "No BibTeX returned for that DOI.");
        }
        let key = KEY_RE.captures(&bibtex).and_then(|c| c.get(1)).map(|m| m.as_str().to_string()).unwrap_or_else(|| cite_key("", ""));
        return Json(json!({ "key": key, "bibtex": format!("{bibtex}\n") })).into_response();
    }
    json_err(StatusCode::BAD_REQUEST, "Could not recognise a DOI or arXiv id in that input.")
}

// ---------------------------------------------------------------------------
// Zotero — talks to the Zotero desktop app's local server on 127.0.0.1:23119.
// The cite picker and BibTeX export come from its Better BibTeX plugin. The
// default target is loopback; ZOTERO_URL in the environment overrides it (for
// setups like WSL, where Zotero runs on the Windows host), and requests bypass
// any system proxy — http_proxy would otherwise swallow loopback calls.
// ---------------------------------------------------------------------------

static ZOTERO_HTTP: LazyLock<reqwest::Client> =
    LazyLock::new(|| reqwest::Client::builder().no_proxy().build().unwrap());

fn zotero_base() -> String {
    std::env::var("ZOTERO_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "http://127.0.0.1:23119".to_string())
}

const ZOTERO_DOWN: &str = "Zotero doesn't seem to be running — start the Zotero desktop app first.";

async fn zotero_ping() -> Response {
    let z = zotero_base();
    match ZOTERO_HTTP.get(format!("{z}/better-bibtex/cayw?probe=true")).timeout(Duration::from_secs(3)).send().await {
        Ok(r) if r.status().is_success() => {
            let t = r.text().await.unwrap_or_default();
            if t.trim().eq_ignore_ascii_case("ready") {
                Json(json!({ "ok": true })).into_response()
            } else {
                Json(json!({ "ok": false, "error": "Zotero answered but Better BibTeX doesn't look ready yet." })).into_response()
            }
        }
        Ok(_) => Json(json!({ "ok": false, "error": "Zotero is running, but the Better BibTeX plugin is missing (retorque.re/zotero-better-bibtex)." })).into_response(),
        Err(_) => Json(json!({ "ok": false, "error": ZOTERO_DOWN })).into_response(),
    }
}

// The CAYW picker opens fine without Zotero's main library window, but Better
// BibTeX resolves citation keys and library exports against the active pane,
// which is null once that window is closed (the app keeps running windowless
// on macOS). Opening a zotero:// URL makes Zotero recreate the window; only
// meaningful against the default local instance, not a ZOTERO_URL override.
fn zotero_pane_missing(text: &str) -> bool {
    text.contains("getActiveZoteroPane")
}

const ZOTERO_NO_WINDOW: &str =
    "Zotero's main window is closed and could not be reopened automatically — open the Zotero window, then try again.";

async fn summon_zotero_window() -> bool {
    if std::env::var("ZOTERO_URL").is_ok() {
        return false;
    }
    if open::that_detached("zotero://select/library").is_err() {
        return false;
    }
    tokio::time::sleep(Duration::from_millis(2000)).await;
    true
}

// Opens Zotero's own "cite as you write" search popup and blocks until the
// user picks papers (or cancels, which returns an empty body).
async fn zotero_pick() -> Response {
    let z = zotero_base();
    match ZOTERO_HTTP.get(format!("{z}/better-bibtex/cayw?format=biblatex")).timeout(Duration::from_secs(300)).send().await {
        Ok(r) if r.status().is_success() => r.text().await.unwrap_or_default().into_response(),
        Ok(r) => json_err(StatusCode::BAD_GATEWAY, format!("Zotero picker failed (HTTP {}).", r.status())),
        Err(e) if e.is_timeout() => json_err(StatusCode::BAD_GATEWAY, "Zotero picker timed out."),
        Err(_) => json_err(StatusCode::BAD_GATEWAY, ZOTERO_DOWN),
    }
}

// Export specific entries (by Better BibTeX citation key) as biblatex.
async fn zotero_export(body: Bytes) -> Response {
    let v = parse_json(&body);
    let keys: Vec<String> = v
        .get("citekeys")
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if keys.is_empty() {
        return json_err(StatusCode::BAD_REQUEST, "No citation keys given.");
    }
    let rpc = json!({ "jsonrpc": "2.0", "method": "item.export", "params": [keys, "biblatex"], "id": 1 });
    let z = zotero_base();
    let mut summoned = false;
    loop {
        match ZOTERO_HTTP.post(format!("{z}/better-bibtex/json-rpc")).json(&rpc).timeout(Duration::from_secs(30)).send().await {
            Ok(r) => {
                let v: Value = r.json().await.unwrap_or(Value::Null);
                if let Some(err) = v.get("error") {
                    let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("Zotero export failed.");
                    if zotero_pane_missing(msg) {
                        if !summoned && summon_zotero_window().await {
                            summoned = true;
                            continue;
                        }
                        return json_err(StatusCode::BAD_GATEWAY, ZOTERO_NO_WINDOW);
                    }
                    return json_err(StatusCode::BAD_GATEWAY, msg.to_string());
                }
                // Older Better BibTeX versions wrap the text in an array.
                let text = match v.get("result") {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Array(a)) => a.iter().rev().find_map(|x| x.as_str()).unwrap_or("").to_string(),
                    _ => String::new(),
                };
                return text.into_response();
            }
            Err(_) => return json_err(StatusCode::BAD_GATEWAY, ZOTERO_DOWN),
        }
    }
}

// Whole-library export as biblatex (URL shape varies across BBT versions).
async fn zotero_library() -> Response {
    let z = zotero_base();
    let urls = [
        format!("{z}/better-bibtex/export/library.biblatex"),
        format!("{z}/better-bibtex/export/library?/1/library.biblatex"),
    ];
    let mut summoned = false;
    let mut pane_blocked = false;
    'attempt: loop {
        for url in &urls {
            if let Ok(r) = ZOTERO_HTTP.get(url).timeout(Duration::from_secs(120)).send().await {
                let ok = r.status().is_success();
                let Ok(t) = r.text().await else { continue };
                if ok && (t.trim().is_empty() || t.trim_start().starts_with('@')) {
                    return t.into_response();
                }
                if zotero_pane_missing(&t) {
                    pane_blocked = true;
                    if !summoned && summon_zotero_window().await {
                        summoned = true;
                        continue 'attempt;
                    }
                }
            } else {
                return json_err(StatusCode::BAD_GATEWAY, ZOTERO_DOWN);
            }
        }
        break;
    }
    if pane_blocked {
        return json_err(StatusCode::BAD_GATEWAY, ZOTERO_NO_WINDOW);
    }
    json_err(StatusCode::BAD_GATEWAY, "Could not export the library — check that Better BibTeX is installed in Zotero.")
}

// ---------------------------------------------------------------------------
// Desktop bridges (replace the Electron preload/IPC)
// ---------------------------------------------------------------------------

async fn desktop_pick_folder(State(st): St) -> Response {
    let app = st.app.lock().unwrap().clone();
    let Some(app) = app else {
        return Json(json!({ "path": null })).into_response();
    };
    let picked = tokio::task::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().file().set_title("Open Folder as Workspace").blocking_pick_folder()
    })
    .await
    .ok()
    .flatten();
    let path = picked.and_then(|fp| fp.into_path().ok()).map(|p| p.to_string_lossy().into_owned());
    Json(json!({ "path": path })).into_response()
}

fn allowed_external_url(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else { return false };
    match url.scheme() {
        "http" | "https" => url.host_str().is_some(),
        "mailto" => !url.path().trim().is_empty(),
        _ => false,
    }
}

async fn desktop_open(body: Bytes) -> Response {
    let v = parse_json(&body);
    let url = jstr(&v, "url").unwrap_or("");
    if allowed_external_url(url) {
        let _ = open::that_detached(url);
        return Json(json!({ "ok": true })).into_response();
    }
    json_err(StatusCode::BAD_REQUEST, "Invalid URL.")
}

// ---------------------------------------------------------------------------
// Static file serving (built UI) with SPA fallback
// ---------------------------------------------------------------------------

async fn static_fallback(State(st): St, method: Method, uri: Uri) -> Response {
    let Some(dist) = st.dist.as_ref().filter(|d| d.exists()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if method != Method::GET {
        return StatusCode::NOT_FOUND.into_response();
    }
    let raw_path = uri.path();
    let decoded = percent_decode_str(raw_path).decode_utf8_lossy().into_owned();
    let rel = decoded.trim_start_matches('/');
    if !rel.is_empty() {
        let target = lexical_resolve(dist, rel);
        if target.starts_with(dist) && target.is_file() {
            let mime = mime_guess::from_path(&target).first_or_octet_stream();
            // Vite content-hashes everything under assets/ — let the webview
            // cache those forever (Monaco alone is ~3.6 MB). Everything else
            // (index.html, quiver, logos) must revalidate so updates land.
            let cache = if rel.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "no-cache" };
            if let Ok(bytes) = fs::read(&target) {
                return ([(header::CONTENT_TYPE, mime.as_ref().to_string()), (header::CACHE_CONTROL, cache.to_string())], bytes).into_response();
            }
        }
    }
    // SPA fallback: any GET path without a dot serves the app shell.
    if !decoded.contains('.') {
        if let Ok(bytes) = fs::read(dist.join("index.html")) {
            return (
                [(header::CONTENT_TYPE, "text/html; charset=utf-8".to_string()), (header::CACHE_CONTROL, "no-cache".to_string())],
                bytes,
            )
                .into_response();
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

// ---------------------------------------------------------------------------
// Router + serve
// ---------------------------------------------------------------------------

static DEV_ORIGIN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^http://(localhost|127\.0\.0\.1):5173$").unwrap());

fn local_host(host: &str) -> bool {
    let hostname = host.rsplit_once(':').map(|(name, _)| name).unwrap_or(host);
    hostname == "127.0.0.1" || hostname == "localhost"
}

fn origin_allowed(host: &str, origin: &str) -> bool {
    origin == format!("http://{host}") || (cfg!(debug_assertions) && DEV_ORIGIN_RE.is_match(origin))
}

// Defence beyond binding to loopback: reject requests whose Host header isn't
// local (DNS-rebinding — a hostile domain resolving to 127.0.0.1 to reach this
// server from a victim's browser) and any browser request carrying a foreign
// Origin (drive-by websites POSTing to localhost; browsers always attach
// Origin to cross-site POSTs, and "simple" ones skip the CORS preflight).
async fn local_guard(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let Some(host) = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()) else {
        return (StatusCode::FORBIDDEN, "Forbidden: missing Host").into_response();
    };
    if !local_host(host) {
        return (StatusCode::FORBIDDEN, "Forbidden: non-local Host").into_response();
    }
    if let Some(origin) = req.headers().get(header::ORIGIN).and_then(|h| h.to_str().ok()) {
        if !origin_allowed(host, origin) {
            return (StatusCode::FORBIDDEN, "Forbidden: cross-site request").into_response();
        }
    }
    next.run(req).await
}

fn valid_bearer(headers: &HeaderMap, expected: &str) -> bool {
    let Some(value) = headers.get(header::AUTHORIZATION).and_then(|h| h.to_str().ok()) else {
        return false;
    };
    let Some(candidate) = value.strip_prefix("Bearer ") else {
        return false;
    };
    let candidate = candidate.as_bytes();
    let expected = expected.as_bytes();
    let mut difference = candidate.len() ^ expected.len();
    for i in 0..candidate.len().max(expected.len()) {
        difference |= usize::from(candidate.get(i).copied().unwrap_or(0) ^ expected.get(i).copied().unwrap_or(0));
    }
    difference == 0
}

async fn auth_guard(State(st): St, req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    if !valid_bearer(req.headers(), &st.api_token) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }
    next.run(req).await
}

#[cfg(debug_assertions)]
async fn dev_api_token(State(st): St, headers: HeaderMap) -> Response {
    let from_vite = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(|origin| DEV_ORIGIN_RE.is_match(origin))
        .unwrap_or(false);
    if !from_vite {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    }
    Json(json!({ "token": st.api_token })).into_response()
}

// ---------------------------------------------------------------------------
// Tinymist LSP proxy for hover/docs & command completion
// ---------------------------------------------------------------------------
// A single long-lived `tinymist lsp` process on the backend, driven over its
// stdio JSON-RPC channel. Two trivial REST endpoints (/lsp/hover,
// /lsp/completion) let Monaco's providers query it without shipping the full
// LSP protocol (WebSockets, monaco-languageclient) to the browser. This mirrors
// the Express port's implementation in server.js.

use tokio::io::AsyncWriteExt as _;
use tokio::sync::oneshot;

struct LspProxy {
    stdin: tokio::process::ChildStdin,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    opened: HashMap<String, (i64, u64)>, // uri → (last version sent, content hash)
    next_id: i64,
    workspace: PathBuf,
    binary_path: String,
    child: tokio::process::Child,
    diagnostics: Arc<Mutex<LspDiagnosticState>>,
    capabilities: Value,
    instance: u64,
}

#[derive(Clone)]
struct TinymistBinary {
    path: String,
    source: &'static str,
}

#[derive(Clone)]
struct PublishedDiagnostics {
    version: Option<i64>,
    items: Value,
    revision: u64,
}

#[derive(Default)]
struct LspDiagnosticState {
    revision: u64,
    by_uri: HashMap<String, PublishedDiagnostics>,
}

fn managed_tinymist_path() -> PathBuf {
    let name = if cfg!(windows) { "tinymist.exe" } else { "tinymist" };
    dirs::config_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config"))
        .join("hilbert")
        .join("bin")
        .join(name)
}

// Resolution order is deterministic: an explicit/bundled override, a binary
// managed under Hilbert's config directory, then the user's PATH.
fn resolve_tinymist() -> Option<TinymistBinary> {
    if let Some(path) = std::env::var("TINYMIST_BIN").ok().filter(|p| Path::new(p).is_file()) {
        let source = if std::env::var("HILBERT_TINYMIST_SOURCE").ok().as_deref() == Some("bundled") {
            "bundled"
        } else {
            "environment"
        };
        return Some(TinymistBinary { path, source });
    }
    let managed = managed_tinymist_path();
    if managed.is_file() {
        return Some(TinymistBinary { path: managed.to_string_lossy().into_owned(), source: "managed" });
    }
    which("tinymist").map(|path| TinymistBinary { path, source: "path" })
}

fn content_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

// One tinymist per workspace, keyed by root: with several windows in one
// process each window's project gets its own language server instead of the
// windows stealing a single slot from each other on every request.
static LSPS: LazyLock<tokio::sync::Mutex<HashMap<PathBuf, LspProxy>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(HashMap::new()));
static LSP_INSTANCE: AtomicU64 = AtomicU64::new(0);

static LSP_CMD_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[.*?\]\(command:[^)]+\)(?:\s*\|\s*)?").unwrap());
static LSP_TRAILING_RULE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n+---\n*$").unwrap());
const FILE_URI_ENCODE: &AsciiSet = &CONTROLS.add(b' ').add(b'#').add(b'?').add(b'%');

fn file_uri(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let encoded = utf8_percent_encode(&normalized, FILE_URI_ENCODE);
    if normalized.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

async fn lsp_write(stdin: &mut tokio::process::ChildStdin, obj: &Value) {
    let json = obj.to_string();
    let header = format!("Content-Length: {}\r\n\r\n", json.len());
    let _ = stdin.write_all(header.as_bytes()).await;
    let _ = stdin.write_all(json.as_bytes()).await;
    let _ = stdin.flush().await;
}

impl LspProxy {
    // Write a request and hand back the receiver for its id-correlated response.
    async fn begin_request(&mut self, method: &str, params: Value) -> oneshot::Receiver<Value> {
        self.next_id += 1;
        let id = self.next_id;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        lsp_write(
            &mut self.stdin,
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )
        .await;
        rx
    }

    async fn notify(&mut self, method: &str, params: Value) {
        lsp_write(
            &mut self.stdin,
            &json!({ "jsonrpc": "2.0", "method": method, "params": params }),
        )
        .await;
    }

    // Keep tinymist's view of the file current: didOpen once, then didChange —
    // but only push a didChange when the text actually differs from last time,
    // so repeated hovers on an unchanged doc don't force a full re-parse.
    async fn sync_file(&mut self, uri: &str, content: &str) -> (i64, bool) {
        let hash = content_hash(content);
        match self.opened.get(uri).copied() {
            None => {
                self.opened.insert(uri.to_string(), (1, hash));
                self.notify(
                    "textDocument/didOpen",
                    json!({ "textDocument": { "uri": uri, "languageId": "typst", "version": 1, "text": content } }),
                )
                .await;
                (1, true)
            }
            Some((ver, prev_hash)) => {
                if prev_hash == hash {
                    return (ver, false);
                }
                let nv = ver + 1;
                self.opened.insert(uri.to_string(), (nv, hash));
                self.notify(
                    "textDocument/didChange",
                    json!({
                        "textDocument": { "uri": uri, "version": nv },
                        "contentChanges": [{ "text": content }]
                    }),
                )
                .await;
                (nv, true)
            }
        }
    }
}

// Ensure a tinymist process is running and initialized. Returns false if it
// could not be spawned (e.g. tinymist not installed) so callers degrade to null.
async fn ensure_lsp(ws: &Path) -> bool {
    let Some(binary) = resolve_tinymist() else {
        return false;
    };
    let mut guard = LSPS.lock().await;
    if let Some(proxy) = guard.get_mut(ws) {
        let alive = proxy.child.try_wait().ok().flatten().is_none();
        if alive && proxy.binary_path == binary.path {
            return true;
        }
    }
    if let Some(mut old) = guard.remove(ws) {
        let _ = old.child.kill().await;
    }
    let mut cmd = Command::new(&binary.path);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console popup
    cmd.arg("lsp")
        .current_dir(ws)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let diagnostics = Arc::new(Mutex::new(LspDiagnosticState::default()));
    let instance = LSP_INSTANCE.fetch_add(1, Ordering::Relaxed) + 1;

    // Reader task: parse Content-Length framed JSON-RPC and dispatch responses.
    let pending_reader = pending.clone();
    let diagnostics_reader = diagnostics.clone();
    let ws_key = ws.to_path_buf();
    tokio::spawn(async move {
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 16384];
        loop {
            let n = match stdout.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            buf.extend_from_slice(&chunk[..n]);
            while let Some(hdr_end) = find_subslice(&buf, b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&buf[..hdr_end]).to_ascii_lowercase();
                let len = header
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .and_then(|v| v.trim().parse::<usize>().ok());
                let Some(len) = len else {
                    buf.drain(..hdr_end + 4);
                    continue;
                };
                let total = hdr_end + 4 + len;
                if buf.len() < total {
                    break;
                }
                let body = buf[hdr_end + 4..total].to_vec();
                buf.drain(..total);
                if let Ok(msg) = serde_json::from_slice::<Value>(&body) {
                    if let Some(id) = msg.get("id").and_then(Value::as_i64) {
                        if let Some(tx) = pending_reader.lock().unwrap().remove(&id) {
                            let _ = tx.send(msg.get("result").cloned().unwrap_or(Value::Null));
                        }
                    } else if msg.get("method").and_then(Value::as_str) == Some("textDocument/publishDiagnostics") {
                        let params = msg.get("params").cloned().unwrap_or(Value::Null);
                        if let Some(uri) = params.get("uri").and_then(Value::as_str) {
                            let mut state = diagnostics_reader.lock().unwrap();
                            state.revision += 1;
                            let revision = state.revision;
                            state.by_uri.insert(uri.to_string(), PublishedDiagnostics {
                                version: params.get("version").and_then(Value::as_i64),
                                items: params.get("diagnostics").cloned().unwrap_or_else(|| json!([])),
                                revision,
                            });
                        }
                    }
                }
            }
        }
        // Process ended — drop the proxy so the next request respawns it.
        let mut guard = LSPS.lock().await;
        if guard.get(&ws_key).map(|proxy| proxy.instance) == Some(instance) {
            guard.remove(&ws_key);
        }
    });

    let mut proxy = LspProxy {
        stdin,
        pending,
        opened: HashMap::new(),
        next_id: 0,
        workspace: ws.to_path_buf(),
        binary_path: binary.path,
        child,
        diagnostics,
        capabilities: Value::Null,
        instance,
    };

    // initialize → (await result) → initialized
    let root_uri = file_uri(ws);
    let rx = proxy
        .begin_request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "capabilities": {},
                "rootUri": root_uri,
                "workspaceFolders": [{ "uri": root_uri, "name": "workspace" }],
            }),
        )
        .await;
    let init = match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(result)) if result.is_object() => result,
        _ => {
            let _ = proxy.child.kill().await;
            return false;
        }
    };
    proxy.capabilities = init.get("capabilities").cloned().unwrap_or(Value::Null);
    proxy.notify("initialized", json!({})).await;
    proxy
        .notify(
            "workspace/didChangeConfiguration",
            json!({ "settings": {
                "formatterMode": "typstyle",
                "formatterIndentSize": 2,
                "formatterPrintWidth": 120,
                "formatterProseWrap": false
            }}),
        )
        .await;

    guard.insert(ws.to_path_buf(), proxy);
    true
}

fn lsp_pos(v: &Value) -> Option<(String, i64, i64)> {
    let file = jstr(v, "file")?.to_string();
    let line = v.get("line")?.as_i64()?;
    let character = v.get("character")?.as_i64()?;
    Some((file, line, character))
}

async fn lsp_document_request(
    st: &AppState,
    file: &str,
    content: &str,
    method: &str,
    extra: Value,
) -> Option<(PathBuf, Value)> {
    let ws = st.ws();
    if !ensure_lsp(&ws).await {
        return None;
    }
    let full_path = safe_workspace_path(&ws, file)?;
    let uri = file_uri(&full_path);
    let mut params = extra.as_object().cloned().unwrap_or_default();
    params.insert("textDocument".into(), json!({ "uri": uri }));
    let rx = {
        let mut guard = LSPS.lock().await;
        let proxy = guard.get_mut(&ws)?;
        proxy.sync_file(&uri, content).await;
        proxy.begin_request(method, Value::Object(params)).await
    };
    let result = tokio::time::timeout(Duration::from_secs(5), rx).await.ok()?.ok()?;
    Some((ws, result))
}

fn workspace_file_from_uri(ws: &Path, uri: &str) -> Option<String> {
    let raw = uri.strip_prefix("file://")?;
    let decoded = percent_decode_str(raw).decode_utf8().ok()?;
    #[cfg(windows)]
    let path = decoded.strip_prefix('/').unwrap_or(decoded.as_ref());
    #[cfg(not(windows))]
    let path = decoded.as_ref();
    Path::new(path)
        .strip_prefix(ws)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

fn normalize_locations(ws: &Path, result: &Value) -> Vec<Value> {
    let values: Vec<&Value> = match result {
        Value::Array(items) => items.iter().collect(),
        Value::Null => Vec::new(),
        one => vec![one],
    };
    values
        .into_iter()
        .filter_map(|item| {
            let uri = item
                .get("uri")
                .or_else(|| item.get("targetUri"))
                .and_then(Value::as_str)?;
            let range = item
                .get("range")
                .or_else(|| item.get("targetSelectionRange"))
                .or_else(|| item.get("targetRange"))?;
            Some(json!({ "file": workspace_file_from_uri(ws, uri)?, "range": range }))
        })
        .collect()
}

fn normalize_workspace_edit(ws: &Path, edit: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(changes) = edit.get("changes").and_then(Value::as_object) {
        for (uri, edits) in changes {
            if let Some(file) = workspace_file_from_uri(ws, uri) {
                out.push(json!({ "file": file, "edits": edits }));
            }
        }
    }
    if let Some(changes) = edit.get("documentChanges").and_then(Value::as_array) {
        for change in changes {
            let Some(uri) = change.pointer("/textDocument/uri").and_then(Value::as_str) else { continue };
            let Some(file) = workspace_file_from_uri(ws, uri) else { continue };
            out.push(json!({
                "file": file,
                "edits": change.get("edits").cloned().unwrap_or_else(|| json!([])),
            }));
        }
    }
    out
}

async fn lsp_definition(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let Some((file, line, character)) = lsp_pos(&v) else {
        return Json(json!({ "locations": [] })).into_response();
    };
    let content = jstr(&v, "content").unwrap_or("");
    match lsp_document_request(
        &st,
        &file,
        content,
        "textDocument/definition",
        json!({ "position": { "line": line, "character": character } }),
    )
    .await
    {
        Some((ws, result)) => Json(json!({ "locations": normalize_locations(&ws, &result) })).into_response(),
        None => Json(json!({ "locations": [] })).into_response(),
    }
}

async fn lsp_references(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let Some((file, line, character)) = lsp_pos(&v) else {
        return Json(json!({ "locations": [] })).into_response();
    };
    let content = jstr(&v, "content").unwrap_or("");
    match lsp_document_request(
        &st,
        &file,
        content,
        "textDocument/references",
        json!({
            "position": { "line": line, "character": character },
            "context": { "includeDeclaration": true }
        }),
    )
    .await
    {
        Some((ws, result)) => Json(json!({ "locations": normalize_locations(&ws, &result) })).into_response(),
        None => Json(json!({ "locations": [] })).into_response(),
    }
}

async fn lsp_rename(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let Some((file, line, character)) = lsp_pos(&v) else {
        return Json(json!({ "changes": [] })).into_response();
    };
    let content = jstr(&v, "content").unwrap_or("");
    let Some(new_name) = jstr(&v, "newName").filter(|name| !name.trim().is_empty()) else {
        return json_err(StatusCode::BAD_REQUEST, "A new name is required.");
    };
    match lsp_document_request(
        &st,
        &file,
        content,
        "textDocument/rename",
        json!({
            "position": { "line": line, "character": character },
            "newName": new_name
        }),
    )
    .await
    {
        Some((ws, result)) => Json(json!({ "changes": normalize_workspace_edit(&ws, &result) })).into_response(),
        None => Json(json!({ "changes": [] })).into_response(),
    }
}

async fn lsp_format(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let Some(file) = jstr(&v, "file") else {
        return Json(json!({ "edits": [] })).into_response();
    };
    let content = jstr(&v, "content").unwrap_or("");
    match lsp_document_request(
        &st,
        file,
        content,
        "textDocument/formatting",
        json!({ "options": { "tabSize": 2, "insertSpaces": true } }),
    )
    .await
    {
        Some((_, result)) => Json(json!({ "available": true, "edits": result.as_array().cloned().unwrap_or_default() })).into_response(),
        None => Json(json!({ "edits": [], "available": false })).into_response(),
    }
}

async fn lsp_code_actions(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let Some((file, line, character)) = lsp_pos(&v) else {
        return Json(json!({ "actions": [] })).into_response();
    };
    let content = jstr(&v, "content").unwrap_or("");
    let end_line = v.get("endLine").and_then(Value::as_i64).unwrap_or(line);
    let end_character = v.get("endCharacter").and_then(Value::as_i64).unwrap_or(character);
    match lsp_document_request(
        &st,
        &file,
        content,
        "textDocument/codeAction",
        json!({
            "range": {
                "start": { "line": line, "character": character },
                "end": { "line": end_line, "character": end_character }
            },
            "context": { "diagnostics": [] }
        }),
    )
    .await
    {
        Some((ws, result)) => {
            let actions: Vec<Value> = result
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|action| {
                    let title = action.get("title")?.as_str()?;
                    let changes = normalize_workspace_edit(&ws, action.get("edit").unwrap_or(&Value::Null));
                    if changes.is_empty() {
                        return None;
                    }
                    Some(json!({
                        "title": title,
                        "kind": action.get("kind").cloned().unwrap_or(Value::Null),
                        "preferred": action.get("isPreferred").cloned().unwrap_or(Value::Bool(false)),
                        "changes": changes,
                    }))
                })
                .collect();
            Json(json!({ "actions": actions })).into_response()
        }
        None => Json(json!({ "actions": [] })).into_response(),
    }
}

// POST /lsp/hover { file, line, character, content } → { contents, range }
async fn lsp_hover(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let Some((file, line, character)) = lsp_pos(&v) else {
        return Json(json!({ "contents": Value::Null })).into_response();
    };
    let content = jstr(&v, "content").unwrap_or("").to_string();
    let ws = st.ws();
    if !ensure_lsp(&ws).await {
        return Json(json!({ "contents": Value::Null })).into_response();
    }
    let Some(full_path) = safe_workspace_path(&ws, &file) else {
        return Json(json!({ "contents": Value::Null })).into_response();
    };
    let uri = file_uri(&full_path);
    let rx = {
        let mut guard = LSPS.lock().await;
        let Some(p) = guard.get_mut(&ws) else {
            return Json(json!({ "contents": Value::Null })).into_response();
        };
        p.sync_file(&uri, &content).await;
        p.begin_request(
            "textDocument/hover",
            json!({ "textDocument": { "uri": uri }, "position": { "line": line, "character": character } }),
        )
        .await
    };
    let result = match tokio::time::timeout(Duration::from_secs(3), rx).await {
        Ok(Ok(v)) => v,
        _ => Value::Null,
    };
    let md = match result.get("contents") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(o)) => o.get("value").and_then(Value::as_str).unwrap_or("").to_string(),
        _ => String::new(),
    };
    if md.trim().is_empty() {
        return Json(json!({ "contents": Value::Null })).into_response();
    }
    // Strip VSCode-specific command links; trim a trailing horizontal rule.
    let md = LSP_CMD_LINK.replace_all(&md, "");
    let md = LSP_TRAILING_RULE.replace(&md, "").trim().to_string();
    Json(json!({ "contents": md, "range": result.get("range").cloned().unwrap_or(Value::Null) }))
        .into_response()
}

// POST /lsp/completion { file, line, character, content } → { items: [...] }
async fn lsp_completion(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let Some((file, line, character)) = lsp_pos(&v) else {
        return Json(json!({ "items": [] })).into_response();
    };
    let content = jstr(&v, "content").unwrap_or("").to_string();
    let ws = st.ws();
    if !ensure_lsp(&ws).await {
        return Json(json!({ "items": [] })).into_response();
    }
    let Some(full_path) = safe_workspace_path(&ws, &file) else {
        return Json(json!({ "items": [] })).into_response();
    };
    let uri = file_uri(&full_path);
    let rx = {
        let mut guard = LSPS.lock().await;
        let Some(p) = guard.get_mut(&ws) else {
            return Json(json!({ "items": [] })).into_response();
        };
        p.sync_file(&uri, &content).await;
        p.begin_request(
            "textDocument/completion",
            json!({
                "textDocument": { "uri": uri },
                "position": { "line": line, "character": character },
                "context": { "triggerKind": 1 }
            }),
        )
        .await
    };
    let result = match tokio::time::timeout(Duration::from_secs(3), rx).await {
        Ok(Ok(v)) => v,
        _ => Value::Null,
    };
    // tinymist may return an array or { isIncomplete, items: [...] }.
    let items = if result.is_array() {
        result
    } else {
        result.get("items").cloned().unwrap_or_else(|| json!([]))
    };
    Json(json!({ "items": items })).into_response()
}

async fn lsp_status(State(st): St) -> Response {
    let binary = resolve_tinymist();
    let (running, workspace, capabilities) = {
        let mut guard = LSPS.lock().await;
        match guard.get_mut(&st.ws()) {
            Some(proxy) => (
                proxy.child.try_wait().ok().flatten().is_none()
                    && binary.as_ref().map(|item| item.path.as_str()) == Some(proxy.binary_path.as_str()),
                Some(proxy.workspace.to_string_lossy().into_owned()),
                proxy.capabilities.clone(),
            ),
            None => (false, None, Value::Null),
        }
    };
    let Some(binary) = binary else {
        return Json(json!({
            "available": false,
            "running": false,
            "managedPath": managed_tinymist_path(),
        }))
        .into_response();
    };
    let version_output = run_cmd(&binary.path, &["--version"], None, Some(3000))
        .await
        .ok()
        .map(|out| if out.stdout.trim().is_empty() { out.stderr } else { out.stdout })
        .unwrap_or_default();
    let version = version_output.lines().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
    Json(json!({
        "available": true,
        "running": running,
        "path": binary.path,
        "source": binary.source,
        "version": version,
        "workspace": workspace,
        "capabilities": capabilities,
        "managedPath": managed_tinymist_path(),
    }))
    .into_response()
}

async fn stop_lsp_for(ws: &Path) {
    let mut guard = LSPS.lock().await;
    if let Some(mut proxy) = guard.remove(ws) {
        let _ = proxy.child.kill().await;
    }
}

async fn stop_all_lsps() {
    let mut guard = LSPS.lock().await;
    for (_, mut proxy) in guard.drain() {
        let _ = proxy.child.kill().await;
    }
}

async fn lsp_restart(State(st): St) -> Response {
    stop_lsp_for(&st.ws()).await;
    let available = ensure_lsp(&st.ws()).await;
    Json(json!({
        "ok": available,
        "message": if available { "Tinymist restarted." } else { "Tinymist is not available." },
    }))
    .into_response()
}

// POST /lsp/diagnostics { file, content } waits for the publication belonging
// to the synced document version, avoiding stale errors after a quick edit.
async fn lsp_diagnostics(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let Some(file) = jstr(&v, "file") else {
        return Json(json!({ "available": true, "diagnostics": [] })).into_response();
    };
    let content = jstr(&v, "content").unwrap_or("").to_string();
    let ws = st.ws();
    let Some(full_path) = safe_workspace_path(&ws, file) else {
        return Json(json!({ "available": true, "diagnostics": [] })).into_response();
    };
    if !ensure_lsp(&ws).await {
        return Json(json!({ "available": false, "diagnostics": [] })).into_response();
    }
    let uri = file_uri(&full_path);
    let (target_version, changed, state, baseline) = {
        let mut guard = LSPS.lock().await;
        let Some(proxy) = guard.get_mut(&ws) else {
            return Json(json!({ "available": false, "diagnostics": [] })).into_response();
        };
        let state = proxy.diagnostics.clone();
        let baseline = state.lock().unwrap().revision;
        let (version, changed) = proxy.sync_file(&uri, &content).await;
        (version, changed, state, baseline)
    };

    let wait = async {
        loop {
            let published = state.lock().unwrap().by_uri.get(&uri).cloned();
            if let Some(published) = published {
                let current_version = published.version.map(|version| version >= target_version).unwrap_or(false);
                let fresh_unversioned = published.version.is_none() && published.revision > baseline;
                if current_version || fresh_unversioned || !changed {
                    return Some(published);
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    let published = tokio::time::timeout(Duration::from_secs(2), wait).await.ok().flatten();
    let pending = published.is_none();
    let version = published.as_ref().and_then(|item| item.version);
    Json(json!({
        "available": true,
        "diagnostics": published.as_ref().map(|item| item.items.clone()).unwrap_or_else(|| json!([])),
        "version": version,
        "pending": pending,
    }))
    .into_response()
}

// Proofreading: spelling (spellbook / Nuspell-compatible) + grammar & style
// (harper-core with a Typst-aware parser). Runs on a blocking thread so the
// dictionary work never stalls the async runtime.
async fn lint_text(body: Bytes) -> Response {
    // The spell/grammar dictionaries cost ~150 MB resident, and proofreading is off
    // by default, so nothing is loaded until the feature is actually used. The client
    // probes this route the moment the user switches proofreading on, and that probe
    // starts the load in the background, so the dictionaries are ready well before
    // the first sentence is typed.
    static WARM: std::sync::Once = std::sync::Once::new();
    WARM.call_once(|| {
        std::thread::spawn(crate::proofread::warm);
    });

    let v = parse_json(&body);
    let text = jstr(&v, "text").unwrap_or("").to_string();
    if text.trim().is_empty() {
        return Json(json!({ "issues": [] })).into_response();
    }
    let issues = tokio::task::spawn_blocking(move || crate::proofread::lint(&text)).await.unwrap_or_default();
    Json(json!({ "issues": issues })).into_response()
}

// Lazy spelling suggestions for the words the client actually displays. Kept
// off the lint hot path because each suggestion is a dictionary-wide search.
async fn lint_suggest(body: Bytes) -> Response {
    let v = parse_json(&body);
    let words: Vec<String> = v
        .get("words")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if words.is_empty() {
        return Json(json!({ "suggestions": {} })).into_response();
    }
    let pairs = tokio::task::spawn_blocking(move || crate::proofread::suggest_words(&words)).await.unwrap_or_default();
    let map: serde_json::Map<String, Value> = pairs.into_iter().map(|(w, s)| (w, json!(s))).collect();
    Json(json!({ "suggestions": map })).into_response()
}

async fn lint_ignore(body: Bytes) -> Response {
    let v = parse_json(&body);
    let word = jstr(&v, "word").unwrap_or("").to_string();
    if !word.trim().is_empty() {
        let _ = tokio::task::spawn_blocking(move || crate::proofread::add_ignored_word(&word)).await;
    }
    Json(json!({ "ok": true })).into_response()
}

// ---------------------------------------------------------------------------
// Session persistence — remember the last project, open files, and cursor so the
// app reopens exactly where the user left off, even across reboots. Stored on
// disk, not the webview's localStorage (which is tied to the port and can vanish).
// ---------------------------------------------------------------------------

// The default (primary-window) session path, used by the GUI shell at boot.
pub fn session_file_path() -> PathBuf {
    session_file()
}

fn session_file() -> PathBuf {
    // Overridable so headless/test runs don't touch the real user session file.
    if let Ok(p) = std::env::var("HILBERT_SESSION_FILE") {
        return PathBuf::from(p);
    }
    dirs::config_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config"))
        .join("hilbert")
        .join("session.json")
}

// The workspace folder from the last session, if it still exists. Lets the GUI
// reopen the previous project immediately at startup, before the UI even loads.
pub fn saved_workspace() -> Option<PathBuf> {
    let raw = fs::read_to_string(session_file()).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let p = v.get("workspacePath").and_then(|x| x.as_str())?;
    let path = PathBuf::from(p);
    path.is_dir().then_some(path)
}

async fn session_get(State(st): St) -> Response {
    match fs::read_to_string(&st.session_file) {
        Ok(s) if !s.trim().is_empty() => ([(header::CONTENT_TYPE, "application/json")], s).into_response(),
        _ => Json(json!({})).into_response(),
    }
}

async fn session_post(State(st): St, body: Bytes) -> Response {
    // Only persist well-formed JSON, and write atomically (temp + rename) so a
    // crash mid-write can't leave a corrupt file that breaks the next launch.
    if serde_json::from_slice::<Value>(&body).is_err() {
        return json_err(StatusCode::BAD_REQUEST, "Invalid session JSON");
    }
    let path = st.session_file.clone();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    // Unique temp name per write so overlapping writes never race on the same file
    // (the rename onto the target stays atomic; last writer wins).
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_extension(format!("json.tmp.{}", SEQ.fetch_add(1, Ordering::Relaxed)));
    if fs::write(&tmp, &body).and_then(|_| fs::rename(&tmp, &path)).is_err() {
        let _ = fs::remove_file(&tmp);
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not save session");
    }
    Json(json!({ "ok": true })).into_response()
}

pub fn router(state: Arc<AppState>) -> Router {
    use tower_http::cors::{AllowOrigin, Any, CorsLayer};
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _| {
            cfg!(debug_assertions) && origin.to_str().map(|o| DEV_ORIGIN_RE.is_match(o)).unwrap_or(false)
        }))
        .allow_methods(Any)
        .allow_headers(Any);

    let api = Router::new()
        .route("/workspace", get(workspace_tree))
        .route("/workspace/root", get(workspace_root_get).post(workspace_root_post))
        .route("/workspace/clear", post(workspace_clear))
        .route("/workspace/file", get(workspace_file_get).post(workspace_file_post).delete(workspace_file_delete).layer(DefaultBodyLimit::max(16 * 1024 * 1024)))
        .route("/workspace/file/state", get(workspace_file_state))
        .route("/workspace/files/state", post(workspace_files_state))
        .route("/workspace/mkdir", post(workspace_mkdir))
        .route("/workspace/upload", post(workspace_upload).layer(DefaultBodyLimit::max(50 * 1024 * 1024)))
        .route("/workspace/save-image", post(workspace_save_image).layer(DefaultBodyLimit::max(50 * 1024 * 1024)))
        .route("/workspace/copy", post(workspace_copy))
        .route("/workspace/rename", post(workspace_rename))
        .route("/workspace/reveal", post(workspace_reveal))
        .route("/app/new-window", post(app_new_window))
        .route("/workspace/search", get(workspace_search))
        .route("/workspace/raw", get(workspace_raw))
        .route("/workspace/compress", post(workspace_compress))
        .route("/data/xlsx", post(data_xlsx).layer(DefaultBodyLimit::max(50 * 1024 * 1024)))
        .route("/compile", post(compile).layer(DefaultBodyLimit::max(16 * 1024 * 1024)))
        .route("/compile/html", get(compile_html))
        .route("/render/snippet", post(render_snippet))
        .route("/zotero/ping", get(zotero_ping))
        .route("/zotero/pick", get(zotero_pick))
        .route("/zotero/export", post(zotero_export))
        .route("/zotero/library", get(zotero_library))
        .route("/init-template", post(init_template))
        .route("/packages", get(packages_search))
        .route("/packages/installed", get(packages_installed))
        .route("/packages/download", post(packages_download))
        .route("/packages/remove", post(packages_remove))
        .route("/git/status", get(git_status))
        .route("/git/init", post(git_init))
        .route("/git/remote", post(git_remote))
        .route("/git/commit", post(git_commit))
        .route("/git/push", post(git_push))
        .route("/drive/sync", post(drive_sync))
        .route("/export/native", post(export_native))
        .route("/export/preflight", post(export_preflight))
        .route("/export/project/native", post(export_project_native))
        .route("/webdav/sync", post(webdav_sync))
        .route("/tools", get(tools))
        .route("/toolchain/status", get(toolchain_status))
        .route("/tools/interpreter", post(tools_interpreter_add))
        .route("/tools/interpreter/remove", post(tools_interpreter_remove))
        .route("/tools/interpreter/pick", post(tools_interpreter_pick))
        .route("/run", post(run_code))
        .route("/notebook/run", post(notebook_run))
        .route("/template/preview", get(template_preview))
        .route("/template/render-preview", post(builtin_preview))
        .route("/bib/fetch", post(bib_fetch))
        .route("/desktop/pick-folder", post(desktop_pick_folder))
        .route("/desktop/open", post(desktop_open))
        .route("/lsp/status", get(lsp_status))
        .route("/lsp/restart", post(lsp_restart))
        .route("/lsp/hover", post(lsp_hover))
        .route("/lsp/completion", post(lsp_completion))
        .route("/lsp/definition", post(lsp_definition))
        .route("/lsp/references", post(lsp_references))
        .route("/lsp/rename", post(lsp_rename))
        .route("/lsp/format", post(lsp_format))
        .route("/lsp/code-actions", post(lsp_code_actions))
        .route("/lsp/diagnostics", post(lsp_diagnostics))
        .route("/lint", post(lint_text))
        .route("/lint/suggest", post(lint_suggest))
        .route("/lint/ignore", post(lint_ignore))
        .route("/session", get(session_get).post(session_post))
        .layer(axum::middleware::from_fn_with_state(state.clone(), auth_guard));

    let app = Router::new().merge(api);
    #[cfg(debug_assertions)]
    let app = app.route("/auth/dev-token", get(dev_api_token));

    app
        .fallback(static_fallback)
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(cors)
        .layer(axum::middleware::from_fn(local_guard))
        .with_state(state)
}

// Kill the long-lived child processes (typst watch, tinymist). Called on app
// exit — a GUI quit doesn't signal children, so without this they would keep
// running (and recompiling on every file change) after Hilbert closes.
// Full shutdown at app exit: every watcher owner calls this and the last one
// also reaps every language server.
pub async fn shutdown_children(state: &Arc<AppState>) {
    stop_preview_watcher(state).await;
    stop_all_lsps().await;
}

// One window closing: its preview watcher dies with it, but language servers
// are shared per-workspace across windows and stay for the survivors.
pub async fn shutdown_window(state: &Arc<AppState>) {
    stop_preview_watcher(state).await;
}

pub async fn serve(listener: std::net::TcpListener, state: Arc<AppState>) {
    listener.set_nonblocking(true).expect("nonblocking");
    let listener = tokio::net::TcpListener::from_std(listener).expect("tokio listener");
    let app = router(state);
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[typst-editor] server error: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "hilbert-{name}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn workspace_paths_allow_nested_creates_and_reject_traversal() {
        let ws = temp_workspace("paths");
        fs::create_dir(ws.join("chapters")).unwrap();
        assert_eq!(safe_workspace_path(&ws, "chapters/new.typ"), Some(ws.join("chapters/new.typ")));
        assert!(safe_workspace_path(&ws, "../outside.typ").is_none());
        fs::remove_dir_all(ws).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn workspace_paths_reject_symlink_escape() {
        use std::os::unix::fs::symlink;

        let ws = temp_workspace("symlink");
        let outside = temp_workspace("outside");
        fs::write(outside.join("secret.txt"), "secret").unwrap();
        symlink(&outside, ws.join("linked")).unwrap();
        assert!(safe_workspace_path(&ws, "linked/secret.txt").is_none());
        assert!(safe_workspace_path(&ws, "linked/new.txt").is_none());
        fs::remove_dir_all(ws).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn request_origins_must_match_the_backend() {
        assert!(local_host("127.0.0.1:3001"));
        assert!(local_host("localhost:3001"));
        assert!(!local_host("example.com:3001"));
        assert!(origin_allowed("127.0.0.1:3001", "http://127.0.0.1:3001"));
        assert!(!origin_allowed("127.0.0.1:3001", "http://localhost:4444"));
        assert_eq!(origin_allowed("127.0.0.1:3001", "http://localhost:5173"), cfg!(debug_assertions));
    }

    #[test]
    fn external_urls_require_an_allowed_scheme_and_valid_target() {
        assert!(allowed_external_url("https://typst.app/docs"));
        assert!(allowed_external_url("mailto:author@example.com"));
        assert!(!allowed_external_url("https://"));
        assert!(!allowed_external_url("file:///etc/passwd"));
        assert!(!allowed_external_url("javascript:alert(1)"));
    }

    #[test]
    fn api_bearer_token_must_match_exactly() {
        let mut headers = HeaderMap::new();
        assert!(!valid_bearer(&headers, "fixed-token"));
        headers.insert(header::AUTHORIZATION, "Bearer wrong-token".parse().unwrap());
        assert!(!valid_bearer(&headers, "fixed-token"));
        headers.insert(header::AUTHORIZATION, "Bearer fixed-token".parse().unwrap());
        assert!(valid_bearer(&headers, "fixed-token"));
    }
}
