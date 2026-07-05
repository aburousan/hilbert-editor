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
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{Arc, LazyLock, Mutex, RwLock},
    time::{Duration, Instant, SystemTime},
};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Clone, serde::Serialize)]
pub struct Interp {
    pub label: String,
    pub path: String,
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
}

pub struct AppState {
    pub workspace: RwLock<PathBuf>,
    pub dist: Option<PathBuf>,
    pub interpreters: Interpreters,
    pub allow_exec: bool,
    pub exec_timeout_ms: u64,
    pub universe: tokio::sync::Mutex<Option<(Instant, Arc<Vec<Value>>)>>,
    pub http: reqwest::Client,
    pub app: Mutex<Option<tauri::AppHandle>>,
}

impl AppState {
    pub fn new(workspace: PathBuf, dist: Option<PathBuf>) -> Self {
        AppState {
            workspace: RwLock::new(workspace),
            dist,
            interpreters: detect_interpreters(),
            allow_exec: std::env::var("ALLOW_CODE_EXECUTION").ok().as_deref() != Some("0"),
            exec_timeout_ms: std::env::var("EXEC_TIMEOUT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(45000),
            universe: tokio::sync::Mutex::new(None),
            http: reqwest::Client::builder().redirect(reqwest::redirect::Policy::limited(10)).build().unwrap(),
            app: Mutex::new(None),
        }
    }

    fn ws(&self) -> PathBuf {
        self.workspace.read().unwrap().clone()
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

// Confine a user-supplied path to the workspace, blocking `../` traversal and
// absolute paths that would escape it.
fn safe_workspace_path(ws: &Path, p: &str) -> Option<PathBuf> {
    if p.is_empty() {
        return None;
    }
    let target = lexical_resolve(ws, p);
    if target != ws && !target.starts_with(ws) {
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
async fn run_cmd(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    timeout_ms: Option<u64>,
) -> std::io::Result<CmdOut> {
    let mut cmd = Command::new(program);
    // Windows: don't flash a console window for each spawned tool (typst, git,
    // python, julia…). CREATE_NO_WINDOW = 0x08000000. No-op on other platforms.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(d) = cwd {
        cmd.current_dir(d);
    }
    let mut child = cmd.spawn()?;
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let so_task = tokio::spawn(async move {
        let mut b = Vec::new();
        let _ = so.read_to_end(&mut b).await;
        b
    });
    let se_task = tokio::spawn(async move {
        let mut b = Vec::new();
        let _ = se.read_to_end(&mut b).await;
        b
    });
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
    let stdout = String::from_utf8_lossy(&so_task.await.unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&se_task.await.unwrap_or_default()).into_owned();
    Ok(CmdOut { code, killed, stdout, stderr })
}

const TYPST_NOT_FOUND: &str = "Typst compiler not found. Install the Typst CLI (macOS: `brew install typst`; Linux: a release binary from github.com/typst/typst or `cargo install typst-cli`) so that `typst --version` works, then restart the editor.";
const TYPST_NOT_FOUND_SHORT: &str = "Typst compiler not found — install the Typst CLI so `typst --version` works.";

// ---------------------------------------------------------------------------
// Workspace file tree + files
// ---------------------------------------------------------------------------

fn get_tree(dir: &Path, ws: &Path) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else { return out };
    let mut items: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    items.sort();
    for item in items {
        // Hide dotfiles, node_modules, the sandbox scratch dir and build output.
        if item.starts_with('.') || item == "node_modules" || item == "sandbox" || item.ends_with(".pdf") {
            continue;
        }
        let full = dir.join(&item);
        let Ok(st) = fs::metadata(&full) else { continue };
        let rel = full.strip_prefix(ws).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        if st.is_dir() {
            out.push(json!({ "type": "directory", "name": item, "path": rel, "children": get_tree(&full, ws) }));
        } else {
            out.push(json!({ "type": "file", "name": item, "path": rel }));
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
    *st.workspace.write().unwrap() = resolved.clone();
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
    if let Some(parent) = full.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match fs::write(&full, content) {
        Ok(_) => "OK".into_response(),
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

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

async fn compile(State(st): St, Query(q): Q, body: Bytes) -> Response {
    let ws = st.ws();
    let main_q = q.get("main").map(String::as_str).unwrap_or("main.typ");
    let Some(main_path) = safe_workspace_path(&ws, main_q) else {
        return json_err(StatusCode::BAD_REQUEST, "Invalid main path");
    };
    let output_path = ws.join("out.pdf");
    let body_str = String::from_utf8_lossy(&body);
    if !body_str.trim().is_empty() {
        let _ = fs::write(&main_path, body_str.as_bytes());
    }
    // Make any fonts the user imported into <workspace>/fonts discoverable by the
    // compiler so `#set text(font: "…")` works with custom .ttf/.otf files.
    let mut compile_args: Vec<String> = vec!["compile".into()];
    if ws.join("fonts").is_dir() {
        compile_args.push("--font-path".into());
        compile_args.push("fonts".into());
    }
    compile_args.push(main_path.to_string_lossy().into_owned());
    compile_args.push(output_path.to_string_lossy().into_owned());
    let compile_argv: Vec<&str> = compile_args.iter().map(String::as_str).collect();
    let out = match run_cmd("typst", &compile_argv, Some(&ws), None).await {
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
    match fs::read(&output_path) {
        Ok(bytes) => ([(header::CONTENT_TYPE, "application/pdf")], bytes).into_response(),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
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
    let typ = files.iter().find(|f| f.ends_with(".typ")).cloned().unwrap_or_else(|| "main.typ".into());
    match fs::read_to_string(ws.join(&typ)) {
        Ok(content) => Json(json!({ "code": content })).into_response(),
        Err(_) => json_err(StatusCode::INTERNAL_SERVER_ERROR, "Failed to read template files"),
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
    let out = match run_cmd(
        "typst",
        &["compile", "--format", "html", "--features", "html", &main_path.to_string_lossy(), &out_file.to_string_lossy()],
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
async fn export(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let Some(folder) = jstr(&v, "folder").filter(|f| !f.is_empty()) else {
        return json_err(StatusCode::BAD_REQUEST, "Destination folder required.");
    };
    let format = jstr(&v, "format").unwrap_or("");
    let name = jstr(&v, "name").filter(|n| !n.is_empty()).unwrap_or("document");
    let main_file = jstr(&v, "main").filter(|m| !m.is_empty()).unwrap_or("main.typ");
    let ws = st.ws();
    if let Err(e) = fs::create_dir_all(folder) {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    if format == "typ" {
        let target = Path::new(folder).join(format!("{name}.typ"));
        return match fs::copy(ws.join(main_file), &target) {
            Ok(_) => Json(json!({ "ok": true, "target": target.to_string_lossy() })).into_response(),
            Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
    }
    if format == "pdf" || format == "html" {
        let ext = if format == "html" { "html" } else { "pdf" };
        let target = Path::new(folder).join(format!("{name}.{ext}"));
        let main_abs = ws.join(main_file);
        let mut args: Vec<&str> = vec!["compile", "--format", ext];
        if format == "html" {
            args.extend(["--features", "html"]);
        }
        let main_s = main_abs.to_string_lossy().into_owned();
        let target_s = target.to_string_lossy().into_owned();
        args.push(&main_s);
        args.push(&target_s);
        let out = match run_cmd("typst", &args, Some(&ws), None).await {
            Ok(o) => o,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return json_err(StatusCode::INTERNAL_SERVER_ERROR, TYPST_NOT_FOUND_SHORT),
            Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
        return if out.code == Some(0) {
            Json(json!({ "ok": true, "target": target.to_string_lossy() })).into_response()
        } else {
            json_err(StatusCode::BAD_REQUEST, if out.stderr.is_empty() { "Compilation failed.".into() } else { out.stderr })
        };
    }
    json_err(StatusCode::BAD_REQUEST, "Unknown format.")
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

async fn get_universe_index(st: &AppState) -> Option<Arc<Vec<Value>>> {
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
    let idx = Arc::new(by_name.into_values().collect::<Vec<_>>());
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
        let name = p.get("name").and_then(|x| x.as_str()).unwrap_or("").to_lowercase();
        let desc = p.get("description").and_then(|x| x.as_str()).unwrap_or("");
        let keywords = p.get("keywords").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|k| k.as_str()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
        let categories = p.get("categories").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(|k| k.as_str()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
        let hay = format!("{name} {desc} {keywords} {categories}").to_lowercase();
        let mut score = 0i64;
        if tokens.is_empty() {
            score = 1;
        } else {
            for t in &tokens {
                if name.contains(t) {
                    score += 3;
                } else if hay.contains(t) {
                    score += 1;
                }
            }
        }
        if score > 0 {
            scored.push((score, p));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
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

fn is_repo(ws: &Path) -> bool {
    ws.join(".git").exists()
}

async fn git_status(State(st): St) -> Response {
    let ws = st.ws();
    if !is_repo(&ws) {
        return Json(json!({ "initialized": false })).into_response();
    }
    let branch = git(&ws, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
    let status = git(&ws, &["status", "--short"]).await;
    let remote = git(&ws, &["remote", "get-url", "origin"]).await;
    let files: Vec<String> = status.stdout.split('\n').filter(|l| !l.is_empty()).map(|l| l.trim().to_string()).collect();
    Json(json!({
        "initialized": true,
        "branch": if branch.code == Some(0) { branch.stdout.trim().to_string() } else { "main".to_string() },
        "remote": if remote.code == Some(0) { Value::String(remote.stdout.trim().to_string()) } else { Value::Null },
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
    let _ = fs::write(ws.join(".gitignore"), "*.pdf\nout.pdf\n.DS_Store\n");
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
    // Inject a GitHub token into the HTTPS URL so the push is non-interactive.
    let push_url = if !token.is_empty() && url.starts_with("https://") {
        url.replacen("https://", &format!("https://{token}@"), 1)
    } else {
        url.to_string()
    };
    if !push_url.is_empty() {
        let has = git(&ws, &["remote", "get-url", "origin"]).await;
        let set = if has.code == Some(0) {
            git(&ws, &["remote", "set-url", "origin", &push_url]).await
        } else {
            git(&ws, &["remote", "add", "origin", &push_url]).await
        };
        if set.code != Some(0) {
            return json_err(StatusCode::INTERNAL_SERVER_ERROR, set.stderr);
        }
    }
    let push = git(&ws, &["push", "-u", "origin", branch]).await;
    // Scrub the token from any echoed output before returning it.
    let scrub = |s: &str| if token.is_empty() { s.to_string() } else { s.replace(token, "***") };
    if push.code != Some(0) {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, scrub(if push.stderr.is_empty() { "Push failed." } else { &push.stderr }));
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

async fn git_log(State(st): St) -> Response {
    let ws = st.ws();
    if !is_repo(&ws) {
        return Json(json!({ "commits": [] })).into_response();
    }
    let sep = '\u{1f}';
    let fmt = format!("--pretty=format:%h{sep}%an{sep}%ar{sep}%s");
    let log = git(&ws, &["log", &fmt, "-n", "20"]).await;
    let commits: Vec<Value> = if log.code == Some(0) {
        log.stdout
            .split('\n')
            .filter(|l| !l.is_empty())
            .map(|l| {
                let parts: Vec<&str> = l.split(sep).collect();
                json!({
                    "hash": parts.first().unwrap_or(&""),
                    "author": parts.get(1).unwrap_or(&""),
                    "date": parts.get(2).unwrap_or(&""),
                    "subject": parts.get(3).unwrap_or(&""),
                })
            })
            .collect()
    } else {
        vec![]
    };
    Json(json!({ "commits": commits })).into_response()
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
        let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        if entry.metadata().map(|m| m.is_dir()).unwrap_or(false) {
            collect_workspace(&full, &rel, out);
        } else {
            out.push((rel, full));
        }
    }
}

async fn compile_to_pdf(ws: &Path, main: &Path, out: &Path) -> bool {
    match run_cmd("typst", &["compile", &main.to_string_lossy(), &out.to_string_lossy()], Some(ws), Some(30000)).await {
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

// Discover every interpreter we can offer (conda envs, venvs, juliaup, ...).
fn detect_interpreters() -> Interpreters {
    let home = dirs::home_dir().unwrap_or_default();
    let mut out = Interpreters::default();

    // Interpreter binary layout differs by OS: bin/python (Unix) vs python.exe
    // (Windows). Returns whichever exists under an env dir.
    let py_in = |dir: &Path| -> Option<String> {
        let p = if cfg!(windows) { dir.join("python.exe") } else { dir.join("bin/python") };
        if p.is_file() { Some(p.to_string_lossy().into_owned()) } else { None }
    };
    let first_file = |cands: &[PathBuf]| cands.iter().find(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned());

    let base_py = which("python3")
        .or_else(|| which("python"))
        .or_else(|| if cfg!(windows) { which("py") } else { None })
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
        });
    if let Some(p) = base_py {
        out.python.push(Interp { label: "Default (python)".into(), path: p });
    }

    // conda / mamba environments — root locations differ per platform.
    let conda_roots: Vec<PathBuf> = if cfg!(windows) {
        ["miniconda3", "anaconda3", "mambaforge", "miniforge3"]
            .iter()
            .flat_map(|r| vec![home.join(r), PathBuf::from(format!(r"C:\{r}")), PathBuf::from(format!(r"C:\ProgramData\{r}"))])
            .collect()
    } else {
        ["miniconda3", "anaconda3", "mambaforge", "miniforge3"].iter().map(|r| home.join(r)).collect()
    };
    for root in &conda_roots {
        let envs_dir = root.join("envs");
        if let Ok(rd) = fs::read_dir(&envs_dir) {
            let mut envs: Vec<_> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            envs.sort();
            for env in envs {
                if let Some(p) = py_in(&envs_dir.join(&env)) {
                    out.python.push(Interp { label: format!("conda: {env}"), path: p });
                }
            }
        }
    }

    let venv_dir = home.join(".virtualenvs");
    if let Ok(rd) = fs::read_dir(&venv_dir) {
        let mut envs: Vec<_> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        envs.sort();
        for env in envs {
            if let Some(p) = py_in(&venv_dir.join(&env)) {
                out.python.push(Interp { label: format!("venv: {env}"), path: p });
            }
        }
    }

    let jl = which("julia").or_else(|| {
        first_file(&if cfg!(windows) {
            vec![home.join(".juliaup/bin/julia.exe"), home.join("AppData/Local/Programs/Julia/bin/julia.exe")]
        } else {
            vec![home.join(".juliaup/bin/julia"), PathBuf::from("/opt/homebrew/bin/julia"), PathBuf::from("/usr/local/bin/julia")]
        })
    });
    if let Some(p) = jl {
        out.julia.push(Interp { label: "Default (julia)".into(), path: p });
    }

    let wl = which("wolframscript").or_else(|| {
        first_file(&if cfg!(windows) {
            vec![PathBuf::from(r"C:\Program Files\Wolfram Research\WolframScript\wolframscript.exe")]
        } else {
            vec![PathBuf::from("/usr/local/bin/wolframscript"), PathBuf::from("/opt/homebrew/bin/wolframscript")]
        })
    });
    if let Some(p) = wl {
        out.wolfram.push(Interp { label: "WolframScript".into(), path: p });
    }

    out
}

async fn tools(State(st): St) -> Response {
    Json(json!({
        "execEnabled": st.allow_exec,
        "interpreters": st.interpreters,
        "available": {
            "python": !st.interpreters.python.is_empty(),
            "julia": !st.interpreters.julia.is_empty(),
            "wolfram": !st.interpreters.wolfram.is_empty(),
        }
    }))
    .into_response()
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
        r"\bsubprocess\b", r"\bsocket\b", r"\bos\.system\b", r"\bos\.popen\b", r"(?i)\bpopen\b",
        r"\beval\s*\(", r"\bexec\s*\(", r"\b__import__\b", r"\brequests\b", r"\burllib\b",
        r"\bshutil\b", r"\bos\.remove\b", r"\bos\.unlink\b", r"\brmtree\b", r"\bpickle\b",
        r"\bctypes\b", r"\bos\.environ\b",
    ]
    .iter()
    .map(|p| Regex::new(p).unwrap())
    .collect()
});
static DENY_JULIA: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [r"\brun\s*\(", r"\bdownload\s*\(", r"\bSys\.\w", r"\bccall\b", r"\bpipeline\s*\(", r"\bopen\s*\(`", r"\brm\s*\(", r"\bmv\s*\("]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect()
});
static DENY_WOLFRAM: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"\bRun\s*\[", r"\bRunProcess\s*\[", r"\bStartProcess\s*\[", r"\bDeleteFile\s*\[",
        r"\bDeleteDirectory\s*\[", r"\bURL(Fetch|Read|Submit|Save)\s*\[", r"\bSystemOpen\s*\[",
        r"\bCreateFile\s*\[", r#"(?i)\bImport\s*\[\s*"https?:"#,
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

    // Pick the interpreter: an explicit path if it is one we detected, else the default.
    let options = st.interpreters.for_lang(lang);
    let Some(chosen) = options.iter().find(|o| o.path == bin).or_else(|| options.first()) else {
        return json_err(StatusCode::BAD_REQUEST, format!("{lang} is not available on this system."));
    };

    let sandbox = st.ws().join("sandbox");
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
    let out = match run_cmd(&chosen.path, &args, Some(&sandbox), Some(st.exec_timeout_ms)).await {
        Ok(o) => o,
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Failed to start {lang}: {e}")),
    };

    // Report new OR rewritten images, referenced relative to the workspace.
    let after = image_stats(&sandbox);
    let mut images: Vec<String> = after
        .iter()
        .filter(|(f, t)| before.get(*f).map(|old| old != *t).unwrap_or(true))
        .map(|(f, _)| format!("sandbox/{f}"))
        .collect();
    images.sort();

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

async fn desktop_open(body: Bytes) -> Response {
    let v = parse_json(&body);
    let url = jstr(&v, "url").unwrap_or("");
    if url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:") {
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

static ORIGIN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^http://(localhost|127\.0\.0\.1):\d+$").unwrap());

// Defence beyond binding to loopback: reject requests whose Host header isn't
// local (DNS-rebinding — a hostile domain resolving to 127.0.0.1 to reach this
// server from a victim's browser) and any browser request carrying a foreign
// Origin (drive-by websites POSTing to localhost; browsers always attach
// Origin to cross-site POSTs, and "simple" ones skip the CORS preflight).
async fn local_guard(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    if let Some(host) = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()) {
        let hostname = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
        if hostname != "127.0.0.1" && hostname != "localhost" {
            return (StatusCode::FORBIDDEN, "Forbidden: non-local Host").into_response();
        }
    }
    if let Some(origin) = req.headers().get(header::ORIGIN).and_then(|h| h.to_str().ok()) {
        if !ORIGIN_RE.is_match(origin) {
            return (StatusCode::FORBIDDEN, "Forbidden: cross-site request").into_response();
        }
    }
    next.run(req).await
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
}

// Resolve the tinymist LSP binary: prefer a bundled copy (main.rs sets
// TINYMIST_BIN to the app-resource path when present), else `tinymist` on PATH.
fn tinymist_bin() -> String {
    std::env::var("TINYMIST_BIN")
        .ok()
        .filter(|p| Path::new(p).exists())
        .unwrap_or_else(|| "tinymist".into())
}

fn content_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

static LSP: LazyLock<tokio::sync::Mutex<Option<LspProxy>>> =
    LazyLock::new(|| tokio::sync::Mutex::new(None));

static LSP_CMD_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[.*?\]\(command:[^)]+\)(?:\s*\|\s*)?").unwrap());
static LSP_TRAILING_RULE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n+---\n*$").unwrap());

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

async fn lsp_write(stdin: &mut tokio::process::ChildStdin, obj: &Value) {
    let json = obj.to_string();
    let header = format!("Content-Length: {}\r\n\r\n", json.as_bytes().len());
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
    async fn sync_file(&mut self, uri: &str, content: &str) {
        let hash = content_hash(content);
        match self.opened.get(uri).copied() {
            None => {
                self.opened.insert(uri.to_string(), (1, hash));
                self.notify(
                    "textDocument/didOpen",
                    json!({ "textDocument": { "uri": uri, "languageId": "typst", "version": 1, "text": content } }),
                )
                .await;
            }
            Some((ver, prev_hash)) => {
                if prev_hash == hash {
                    return;
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
            }
        }
    }
}

// Ensure a tinymist process is running and initialized. Returns false if it
// could not be spawned (e.g. tinymist not installed) so callers degrade to null.
async fn ensure_lsp(ws: &Path) -> bool {
    let mut guard = LSP.lock().await;
    if guard.is_some() {
        return true;
    }
    let mut cmd = Command::new(tinymist_bin());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console popup
    cmd.arg("lsp")
        .current_dir(ws)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(false); // keep it alive after this fn drops the Child handle
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return false,
    };
    let stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>> =
        Arc::new(Mutex::new(HashMap::new()));

    // Reader task: parse Content-Length framed JSON-RPC and dispatch responses.
    let pending_reader = pending.clone();
    tokio::spawn(async move {
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 16384];
        loop {
            let n = match stdout.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            buf.extend_from_slice(&chunk[..n]);
            loop {
                let Some(hdr_end) = find_subslice(&buf, b"\r\n\r\n") else { break };
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
                    }
                }
            }
        }
        // Process ended — drop the proxy so the next request respawns it.
        *LSP.lock().await = None;
    });

    let mut proxy = LspProxy { stdin, pending, opened: HashMap::new(), next_id: 0 };

    // initialize → (await result) → initialized
    let root_uri = format!("file://{}", ws.to_string_lossy());
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
    let _ = tokio::time::timeout(Duration::from_secs(5), rx).await;
    proxy.notify("initialized", json!({})).await;

    *guard = Some(proxy);
    true
}

fn lsp_pos(v: &Value) -> Option<(String, i64, i64)> {
    let file = jstr(v, "file")?.to_string();
    let line = v.get("line")?.as_i64()?;
    let character = v.get("character")?.as_i64()?;
    Some((file, line, character))
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
    let uri = format!("file://{}", lexical_resolve(&ws, &file).to_string_lossy());
    let rx = {
        let mut guard = LSP.lock().await;
        let Some(p) = guard.as_mut() else {
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
    let uri = format!("file://{}", lexical_resolve(&ws, &file).to_string_lossy());
    let rx = {
        let mut guard = LSP.lock().await;
        let Some(p) = guard.as_mut() else {
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

pub fn router(state: Arc<AppState>) -> Router {
    use tower_http::cors::{AllowOrigin, Any, CorsLayer};
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _| origin.to_str().map(|o| ORIGIN_RE.is_match(o)).unwrap_or(false)))
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/workspace", get(workspace_tree))
        .route("/workspace/root", get(workspace_root_get).post(workspace_root_post))
        .route("/workspace/clear", post(workspace_clear))
        .route("/workspace/file", get(workspace_file_get).post(workspace_file_post).delete(workspace_file_delete))
        .route("/workspace/mkdir", post(workspace_mkdir))
        .route("/workspace/upload", post(workspace_upload))
        .route("/workspace/save-image", post(workspace_save_image))
        .route("/workspace/copy", post(workspace_copy))
        .route("/compile", post(compile))
        .route("/compile/html", get(compile_html))
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
        .route("/git/log", get(git_log))
        .route("/drive/sync", post(drive_sync))
        .route("/export", post(export))
        .route("/webdav/sync", post(webdav_sync))
        .route("/tools", get(tools))
        .route("/run", post(run_code))
        .route("/template/preview", get(template_preview))
        .route("/bib/fetch", post(bib_fetch))
        .route("/desktop/pick-folder", post(desktop_pick_folder))
        .route("/desktop/open", post(desktop_open))
        .route("/lsp/hover", post(lsp_hover))
        .route("/lsp/completion", post(lsp_completion))
        .fallback(static_fallback)
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024))
        .layer(cors)
        .layer(axum::middleware::from_fn(local_guard))
        .with_state(state)
}

pub async fn serve(listener: std::net::TcpListener, state: Arc<AppState>) {
    listener.set_nonblocking(true).expect("nonblocking");
    let listener = tokio::net::TcpListener::from_std(listener).expect("tokio listener");
    let app = router(state);
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[typst-editor] server error: {e}");
    }
}
