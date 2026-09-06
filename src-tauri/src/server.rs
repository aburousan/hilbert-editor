// Rust port of the Typst Editor backend (server.js), endpoint-for-endpoint.
// The React UI is served from `dist` on the same origin, so the unmodified
// frontend build works exactly as it does under Electron + Express.
use axum::{
    body::Bytes,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Query, State,
    },
    http::{header, HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use percent_encoding::{percent_decode_str, utf8_percent_encode, AsciiSet, CONTROLS, NON_ALPHANUMERIC};
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    process::Stdio,
    sync::{atomic::{AtomicU64, Ordering}, Arc, LazyLock, Mutex, RwLock},
    time::{Duration, Instant, SystemTime},
};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::process::Command;

use crate::sandbox;

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
    // When this became the watcher's answer. Only meaningful for Waiting, where
    // it is the difference between "typst is working on it" and "typst said it
    // was working on it some time ago and has not been heard from since".
    since: Instant,
}

impl PreviewEvent {
    fn new(generation: u64, outcome: PreviewOutcome) -> Self {
        PreviewEvent { generation, outcome, since: Instant::now() }
    }
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
    // Present only for the explicitly requested hosted-workspace mode. The
    // normal desktop/headless backend remains loopback-only and never accepts
    // a browser login. A successful login receives an HttpOnly cookie carrying
    // a domain-separated derivative of the configured access token, so the
    // sign-in token itself is never stored in the browser and sessions remain
    // valid through an ordinary server restart.
    remote_access_token: Option<String>,
    remote_collab_room: Option<String>,
    remote_collab_key: Option<String>,
    sessions: Option<HostedSessions>,
    public_host: Option<String>,
    // Interpreters found by scanning the usual install locations, plus the ones
    // the user added by hand (persisted, so they survive a restart).
    pub detected: Interpreters,
    pub custom: RwLock<Interpreters>,
    pub allow_exec: bool,
    pub exec_timeout_ms: u64,
    source_generation: AtomicU64,
    lint_generation: AtomicU64,
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
    shutdown: tokio::sync::watch::Sender<bool>,
    workspace_released: std::sync::atomic::AtomicBool,
}

static WORKSPACE_USERS: LazyLock<Mutex<HashMap<PathBuf, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn register_workspace_user(path: &Path) {
    let mut users = WORKSPACE_USERS.lock().unwrap_or_else(|e| e.into_inner());
    *users.entry(path.to_path_buf()).or_insert(0) += 1;
}

// Move one live backend between projects. Returns true when nothing else still
// uses the old project's shared language server.
fn move_workspace_user(old: &Path, new: &Path) -> bool {
    if old == new {
        return false;
    }
    let mut users = WORKSPACE_USERS.lock().unwrap_or_else(|e| e.into_inner());
    let old_unused = if let Some(count) = users.get_mut(old) {
        *count = count.saturating_sub(1);
        if *count == 0 {
            users.remove(old);
            true
        } else {
            false
        }
    } else {
        true
    };
    *users.entry(new.to_path_buf()).or_insert(0) += 1;
    old_unused
}

fn release_workspace_user(path: &Path) -> bool {
    let mut users = WORKSPACE_USERS.lock().unwrap_or_else(|e| e.into_inner());
    let Some(count) = users.get_mut(path) else { return true };
    *count = count.saturating_sub(1);
    if *count == 0 {
        users.remove(path);
        true
    } else {
        false
    }
}

// Every TLS connection this program makes goes through rustls, which needs to be
// told once which cryptography to use. reqwest is built without a provider of
// its own on purpose: letting it choose pulls in aws-lc-rs, which wants cmake
// and NASM to build on Windows, where ring needs neither and is already here for
// the updater. Building a client without this panics, so it runs first.
fn use_ring() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

// HMAC-SHA256. Written out rather than pulled in as a dependency: it is fifteen
// lines, and sha2 is already here.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut padded = [0u8; 64];
    if key.len() > 64 {
        padded[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        padded[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = padded;
    let mut outer_pad = padded;
    for byte in inner_pad.iter_mut() {
        *byte ^= 0x36;
    }
    for byte in outer_pad.iter_mut() {
        *byte ^= 0x5c;
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner);
    outer.finalize().into()
}

// Browser sessions for a hosted workspace.
//
// The cookie used to be the API token itself, which meant three things at once:
// the browser held the server's master credential, the only expiry was the
// Max-Age the browser had promised to honour, and there was no way to end a
// session short of changing the token everybody signs in with.
//
// What the browser holds now says only when it stops being valid and which
// generation of sessions it belongs to, carried with a MAC this server alone can
// produce:
//
//     v1.<expires, unix seconds>.<generation>.<base64url MAC>
//
// The key is derived from the access token and the workspace path, so sessions
// still survive an ordinary restart — the thing that lets an open browser finish
// saving its draft after the service comes back.
struct HostedSessions {
    key: [u8; 32],
    generation: AtomicU64,
    generation_file: PathBuf,
    lifetime: Duration,
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl HostedSessions {
    fn new(key: [u8; 32], generation_file: PathBuf) -> Self {
        let hours = std::env::var("HILBERT_SESSION_HOURS")
            .ok()
            .and_then(|raw| raw.parse::<u64>().ok())
            .filter(|hours| (1..=24 * 30).contains(hours))
            .unwrap_or(24);
        let generation = fs::read_to_string(&generation_file)
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .unwrap_or(0);
        HostedSessions {
            key,
            generation: AtomicU64::new(generation),
            generation_file,
            lifetime: Duration::from_secs(hours * 3600),
        }
    }

    // Length-prefixed so no combination of fields can be reinterpreted as
    // another one — an expiry of 11 and a generation of 1 must not sign the
    // same bytes as an expiry of 1 and a generation of 11.
    fn tag(&self, expires: u64, generation: u64) -> String {
        let mut message = Vec::with_capacity(48);
        message.extend_from_slice(b"hilbert-session-v1");
        for field in [expires, generation] {
            message.extend_from_slice(&8u64.to_be_bytes());
            message.extend_from_slice(&field.to_be_bytes());
        }
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hmac_sha256(&self.key, &message))
    }

    fn issue(&self) -> String {
        let expires = unix_now() + self.lifetime.as_secs();
        let generation = self.generation.load(Ordering::Acquire);
        format!("v1.{expires}.{generation}.{}", self.tag(expires, generation))
    }

    fn verify(&self, candidate: &str) -> bool {
        let mut parts = candidate.split('.');
        if parts.next() != Some("v1") {
            return false;
        }
        let (Some(expires), Some(generation), Some(tag), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return false;
        };
        let (Ok(expires), Ok(generation)) = (expires.parse::<u64>(), generation.parse::<u64>()) else {
            return false;
        };
        // Both checks before the comparison are on values the client chose, so
        // they say nothing secret; the MAC is what decides.
        if expires <= unix_now() || generation != self.generation.load(Ordering::Acquire) {
            return false;
        }
        constant_time_eq(tag, &self.tag(expires, generation))
    }

    // End every session at once, without touching the token people sign in with.
    fn revoke_all(&self) -> u64 {
        let next = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        if let Some(parent) = self.generation_file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&self.generation_file, next.to_string());
        next
    }
}

fn hosted_secret(label: &str, access_token: &str, workspace: &Path) -> [u8; 32] {
    let identity = fs::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
    let identity = identity.to_string_lossy();
    let mut digest = Sha256::new();
    // Length prefixes keep the three fields unambiguous even if an operator's
    // token or path happens to contain the separator bytes.
    digest.update(b"hilbert-hosted-secret-v1");
    for field in [label.as_bytes(), access_token.as_bytes(), identity.as_bytes()] {
        digest.update((field.len() as u64).to_be_bytes());
        digest.update(field);
    }
    digest.finalize().into()
}

impl AppState {
    // Record that the workspace changed, so a compile can tell which edit it is
    // waiting for.
    fn note_write(&self) {
        self.source_generation.fetch_add(1, Ordering::AcqRel);
    }

    pub fn new(workspace: PathBuf, dist: Option<PathBuf>) -> Self {
        use_ring();
        let mut token_bytes = [0u8; 32];
        getrandom::fill(&mut token_bytes).expect("operating-system randomness for API token");
        let generated_token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token_bytes);
        let api_token = std::env::var("HILBERT_API_TOKEN")
            .ok()
            .filter(|token| token.len() >= 32)
            .unwrap_or(generated_token);
        register_workspace_user(&workspace);
        let (shutdown, _) = tokio::sync::watch::channel(false);
        AppState {
            workspace: RwLock::new(workspace),
            dist,
            api_token,
            remote_access_token: None,
            remote_collab_room: None,
            remote_collab_key: None,
            sessions: None,
            public_host: None,
            detected: detect_interpreters(),
            custom: RwLock::new(load_custom_interpreters()),
            allow_exec: std::env::var("ALLOW_CODE_EXECUTION").ok().as_deref() != Some("0"),
            exec_timeout_ms: std::env::var("EXEC_TIMEOUT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(45000),
            source_generation: AtomicU64::new(0),
            lint_generation: AtomicU64::new(0),
            preview_watcher: tokio::sync::Mutex::new(None),
            compile_gate: tokio::sync::Semaphore::new(1),
            render_gate: tokio::sync::Semaphore::new(2),
            exec_gate: tokio::sync::Semaphore::new(1),
            universe: tokio::sync::Mutex::new(None),
            http: reqwest::Client::builder().redirect(reqwest::redirect::Policy::limited(10)).build().unwrap(),
            app: Mutex::new(None),
            session_file: session_file(),
            open_window: Mutex::new(None),
            shutdown,
            workspace_released: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn new_remote(workspace: PathBuf, dist: Option<PathBuf>, access_token: String) -> Self {
        let explicit_api_token = std::env::var("HILBERT_API_TOKEN")
            .ok()
            .filter(|token| token.len() >= 32)
            .is_some();
        let session_secret = hosted_secret("session", &access_token, &workspace);
        let cookie_secret = hosted_secret("cookie", &access_token, &workspace);
        let room_secret = hosted_secret("room", &access_token, &workspace);
        let key_secret = hosted_secret("key", &access_token, &workspace);
        let mut state = Self::new(workspace, dist);
        // An explicit API token remains an operator override. Without one, derive
        // a strong, stable one from the hosted sign-in secret so the desktop
        // shell's bearer path behaves the same across a restart. Browsers no
        // longer see this value at all — they get a signed session instead.
        if !explicit_api_token {
            state.api_token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(session_secret);
        }
        // The revocation counter lives outside the workspace, so a signed-in
        // user cannot roll it back through the file API and bring cancelled
        // sessions back to life. Its name is derived from the token and the
        // workspace, so two hosted servers on one machine revoke separately.
        let scope = hosted_secret("generation", &access_token, &state.ws());
        let scope: String = scope[..8].iter().map(|byte| format!("{byte:02x}")).collect();
        state.sessions = Some(HostedSessions::new(
            cookie_secret,
            hilbert_config_dir().join(format!("hosted-sessions-{scope}")),
        ));
        state.public_host = std::env::var("HILBERT_PUBLIC_HOST")
            .ok()
            .map(|host| host.trim().to_string())
            .filter(|host| !host.is_empty());
        state.remote_access_token = Some(access_token);
        // Keep the encrypted hosted room stable too. Otherwise existing pages
        // reconnect to their pre-restart room while a newly opened page is sent
        // to a newly randomized room, silently splitting one document's users.
        state.remote_collab_room = Some(room_secret.iter().map(|byte| format!("{byte:02x}")).collect());
        state.remote_collab_key = Some(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key_secret));
        state
    }

    fn remote_mode(&self) -> bool {
        self.remote_access_token.is_some()
    }

    // Why a run cannot start, if it cannot. Both code runners ask this before
    // doing anything else, so the two reasons — switched off by the operator,
    // and no sandbox on a machine that insists on one — read the same way.
    fn exec_refusal(&self) -> Option<String> {
        if !self.allow_exec {
            return Some("Code execution is disabled on this server (ALLOW_CODE_EXECUTION=0).".to_string());
        }
        sandbox::refusal().map(str::to_string)
    }

    fn ws(&self) -> PathBuf {
        // Recover from a poisoned lock instead of panicking: a workspace path is
        // always readable, and one panicked handler shouldn't wedge every request.
        self.workspace.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn api_token(&self) -> &str {
        &self.api_token
    }

    fn preview_path(&self, ws: &Path, direct: bool) -> PathBuf {
        let id = Sha256::digest(self.session_file.to_string_lossy().as_bytes());
        let id: String = id[..12].iter().map(|byte| format!("{byte:02x}")).collect();
        hilbert_dir(ws).join(format!("preview-{id}{}.pdf", if direct { "-direct" } else { "" }))
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
    // An absolute path keeps its own root, and on Windows the root includes the
    // drive. Starting from a bare "/" threw the drive away: open a project at
    // C:\Users\you\Documents\Hilbert and the workspace became \Users\you\...,
    // which Windows then reads as that path on whatever drive the process
    // happens to be running from. Right by luck while everything is on C:, and
    // quietly the wrong folder the moment a project lives on D: or a mapped
    // network drive.
    let mut result = if path.is_absolute() {
        path.components()
            .take_while(|c| matches!(c, Component::Prefix(_) | Component::RootDir))
            .collect::<PathBuf>()
    } else {
        base.to_path_buf()
    };
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

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------
//
// On macOS and Linux the app is usually started from somewhere that shows
// stdout; on Windows it is a windowed process with no console attached, so
// everything it prints goes nowhere. That has made every Windows report a
// guessing game — the person in front of the problem can describe what they
// see, and there is nothing to look at afterwards. So keep the last few
// thousand lines both in memory (for /diagnostics) and in a file next to the
// session, and write down the things a stuck compile would need to explain
// itself: what typst was asked, what it said back, and how long each stage took.

const LOG_LINES: usize = 3000;
const LOG_BYTES: u64 = 4 * 1024 * 1024;

static LOG: LazyLock<Mutex<std::collections::VecDeque<String>>> =
    LazyLock::new(|| Mutex::new(std::collections::VecDeque::with_capacity(LOG_LINES)));

fn log_path() -> PathBuf {
    if let Ok(p) = std::env::var("HILBERT_LOG_FILE") {
        return PathBuf::from(p);
    }
    hilbert_config_dir().join("hilbert.log")
}

fn stamp() -> String {
    // Seconds since the epoch split by hand rather than pulling in a date crate
    // for the one place that needs it. Wall clock, so it lines up with when the
    // user says the app stopped answering.
    let now = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    let secs = now.as_secs();
    format!("{:02}:{:02}:{:02}.{:03}", secs / 3600 % 24, secs / 60 % 60, secs % 60, now.subsec_millis())
}

pub fn note(message: impl AsRef<str>) {
    let line = format!("[{}] {}", stamp(), message.as_ref());
    if let Ok(mut buffer) = LOG.lock() {
        if buffer.len() == LOG_LINES { buffer.pop_front(); }
        buffer.push_back(line.clone());
    }
    eprintln!("{line}");

    let path = log_path();
    if let Some(parent) = path.parent() { let _ = fs::create_dir_all(parent); }
    // Start a fresh file rather than growing without bound. One generation back
    // is kept, because the interesting run is often the one before the restart.
    if fs::metadata(&path).map(|m| m.len() > LOG_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, path.with_extension("log.1"));
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = writeln!(file, "{line}");
    }
}

macro_rules! note {
    ($($arg:tt)*) => { crate::server::note(format!($($arg)*)) };
}

fn recent_log() -> String {
    LOG.lock().map(|b| b.iter().cloned().collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

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

// Every spawned tool gets a wall-clock cap. `None` used to mean "wait forever",
// which is the wrong default when one hung typst holds `compile_gate` (a single
// permit) and every later compile queues behind it. Callers that genuinely need
// longer say so; nobody gets to say "never".
const DEFAULT_CMD_TIMEOUT_MS: u64 = 120_000;
// An export compiles every page of the document, sometimes to PDF/A with every
// figure embedded, so it is allowed to be the slowest thing in the app.
const EXPORT_TIMEOUT_MS: u64 = 300_000;

async fn run_cmd(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    timeout_ms: Option<u64>,
) -> std::io::Result<CmdOut> {
    run_cmd_inner(program, args, cwd, timeout_ms, false, None).await
}

// Like run_cmd, but for untrusted user code. Two things are added on top of the
// wall-clock timeout: OS-level confinement where the machine can provide it (see
// sandbox.rs), and per-process resource limits, so a runaway cell can't fill the
// disk or peg a core even if the kill is ever missed.
async fn run_exec_cmd(
    program: &str,
    args: &[&str],
    run_dir: &Path,
    timeout_ms: Option<u64>,
    lang: &str,
) -> std::io::Result<CmdOut> {
    let confined = sandbox::confine(program, args, run_dir, lang);
    run_cmd_inner(program, args, Some(run_dir), timeout_ms, true, confined).await
}

// Kill the child *and* anything it started. The child leads its own process
// group (see the spawn above), so on Unix one signal to the negated pid reaches
// the whole group. Windows has no process groups of that kind, so taskkill's /T
// walks the tree instead; it is part of the OS, which beats taking a dependency
// on the Job Object API for one call.
fn kill_tree(child: &mut tokio::process::Child) {
    let Some(pid) = child.id() else { return };
    #[cfg(unix)]
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/T", "/F", "/PID", &pid.to_string()]);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
        let _ = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    }
    #[cfg(not(any(unix, windows)))]
    let _ = pid;
}

async fn run_cmd_inner(
    program: &str,
    args: &[&str],
    cwd: Option<&Path>,
    timeout_ms: Option<u64>,
    limits: bool,
    confined: Option<sandbox::Confined>,
) -> std::io::Result<CmdOut> {
    // Under confinement the thing we actually launch is bwrap or sandbox-exec,
    // with the interpreter and its arguments handed over after the policy.
    let launch = confined.as_ref().map(|c| c.program.as_str()).unwrap_or(program);
    let launch_args: Vec<&str> = match &confined {
        Some(c) => c.args.iter().map(String::as_str).collect(),
        None => args.to_vec(),
    };
    let mut cmd = Command::new(launch);
    if let Some(c) = &confined {
        for (key, value) in &c.env {
            cmd.env(key, value);
        }
    }
    // Windows: don't flash a console window for each spawned tool (typst, git,
    // python, julia…). CREATE_NO_WINDOW = 0x08000000. No-op on other platforms.
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);
    cmd.args(&launch_args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
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
    if limits {
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
    let _ = limits; // (Windows: limits are enforced by the wall-clock timeout only.)
    // Give the child its own process group, so a timeout can signal the whole
    // tree rather than only the process we spawned. Without this a Python cell
    // that started workers leaves them running after the cell is killed. On
    // Linux the bubblewrap sandbox already tears its PID namespace down; this is
    // what covers macOS, and everything that runs outside the sandbox.
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn()?;
    let so = child.stdout.take().unwrap();
    let se = child.stderr.take().unwrap();
    let so_task = tokio::spawn(read_capped(so));
    let se_task = tokio::spawn(read_capped(se));
    let dur = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_CMD_TIMEOUT_MS));
    let mut killed = false;
    let code = match tokio::time::timeout(dur, child.wait()).await {
        Ok(Ok(status)) => status.code(),
        Ok(Err(_)) => None,
        Err(_) => {
            killed = true;
            kill_tree(&mut child);
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

// Which font families this machine can actually typeset with, workspace fonts
// included. Recommending a font the user does not have is worse than saying
// nothing: on a bare Linux box the Arabic fallback renders every letter in its
// isolated form, so the text is legible only to someone who already knows what
// it should say, and the fix is to name a family that is really installed.
async fn fonts_list(State(st): St) -> Response {
    let Some(typst) = which("typst") else {
        return Json(json!({ "available": false, "families": [] })).into_response();
    };
    let ws = st.ws();
    let mut args: Vec<String> = vec!["fonts".into()];
    if ws.join("fonts").is_dir() {
        args.push("--font-path".into());
        args.push("fonts".into());
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let Ok(out) = run_cmd(&typst, &argv, Some(&ws), Some(8000)).await else {
        return Json(json!({ "available": false, "families": [] })).into_response();
    };
    // One family per line, and `typst fonts` repeats a family once per style
    // unless asked otherwise, so this keeps the first of each.
    let mut families: Vec<&str> = Vec::new();
    for line in out.stdout.lines() {
        let name = line.trim();
        if name.is_empty() || line.starts_with(char::is_whitespace) { continue; }
        if !families.contains(&name) { families.push(name); }
    }
    Json(json!({ "available": true, "families": families })).into_response()
}

// Typst's PDF format has no SyncTeX sidecar. The compiler does, however, retain
// source spans while evaluating the paged document: querying equation elements
// gives their real page positions and structured rendered bodies. Reverse sync
// uses this only when ordinary text matching cannot resolve a PDF click, so no
// extra preview daemon or idle memory is required.
async fn workspace_math_locations(State(st): St, Query(q): Q) -> Response {
    let main = q.get("main").map(String::as_str).unwrap_or("main.typ");
    let ws = st.ws();
    let Some(main_path) = safe_workspace_path(&ws, main) else {
        return json_err(StatusCode::BAD_REQUEST, "Invalid main file");
    };
    if main_path.extension().and_then(|extension| extension.to_str()) != Some("typ") || !main_path.is_file() {
        return json_err(StatusCode::BAD_REQUEST, "Main file must be an existing .typ file");
    }
    let Some(typst) = which("typst") else {
        return json_err(StatusCode::SERVICE_UNAVAILABLE, TYPST_NOT_FOUND_SHORT);
    };
    // Position and body for locating a formula by its symbols, plus whether it
    // is a block equation and the number Typst actually printed beside it.
    // That number is the only reliable way back to the source: counting `$ … $`
    // in the file assumes every block equation is numbered, and in a real paper
    // several are not, so the count runs ahead of the numbering.
    let expression = "query(math.equation).map(it => (\
        it.location().position(), \
        it.body, \
        it.block, \
        if it.block and it.numbering != none { counter(math.equation).at(it.location()).first() } else { 0 }))";
    let main_arg = main_path.to_string_lossy().into_owned();
    let root_arg = ws.to_string_lossy().into_owned();
    let mut owned = vec![
        "eval".to_string(),
        expression.to_string(),
        "--in".to_string(),
        main_arg,
        "--root".to_string(),
        root_arg,
    ];
    let fonts = ws.join("fonts");
    if fonts.is_dir() {
        owned.push("--font-path".to_string());
        owned.push(fonts.to_string_lossy().into_owned());
    }
    let args: Vec<&str> = owned.iter().map(String::as_str).collect();
    // One short-lived query at a time alongside normal compile requests. This
    // avoids a burst of compiler processes if someone double-clicks repeatedly.
    let _permit = st.compile_gate.acquire().await.unwrap();
    let output = match run_cmd(&typst, &args, Some(&ws), Some(15_000)).await {
        Ok(output) => output,
        Err(error) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Could not query Typst: {error}")),
    };
    if output.killed {
        return json_err(StatusCode::GATEWAY_TIMEOUT, "Typst equation query timed out");
    }
    if output.code != Some(0) {
        let message = output.stderr.lines().find(|line| !line.trim().is_empty()).unwrap_or("Typst could not resolve equation positions");
        return json_err(StatusCode::UNPROCESSABLE_ENTITY, message);
    }
    match serde_json::from_str::<Value>(&output.stdout) {
        Ok(Value::Array(equations)) => Json(json!({ "equations": equations })).into_response(),
        _ => json_err(StatusCode::BAD_GATEWAY, "Typst returned an invalid equation map"),
    }
}

// ---------------------------------------------------------------------------
// Workspace file tree + files
// ---------------------------------------------------------------------------

// Entries no workspace walk should descend into: dotfiles (including .hilbert
// and .git), installed packages, and the code runner's scratch dir. Kept in one
// place so adding an exclusion cannot reach some walks and miss others.
fn is_hidden_entry(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules" || name == "sandbox"
}

// The same rule for walks that also skip built PDFs. The file tree deliberately
// does NOT use this: a PDF should stay visible there so it can be opened.
fn is_hidden_source_entry(name: &str) -> bool {
    is_hidden_entry(name) || name.ends_with(".pdf")
}

// A project folder often sits next to unrelated ones. Walking those in full is
// what makes the tree slow to build — one report had an 8 GB checkout beside the
// document — and their contents are not part of this project anyway. So the walk
// stops at anything that looks like a separate project, and at a total entry
// count, rather than reading every directory on the disk below the root. A
// directory left unread is marked `truncated` and its contents are fetched only
// if the user opens it.
// How many entries the walk will emit before it stops going any deeper. It
// never drops entries from a folder it has already started listing — a folder
// always shows all of its own contents — so what this bounds is descent.
const TREE_MAX_ENTRIES: usize = 6000;
const TREE_MAX_DEPTH: usize = 12;
// Backstop for a single pathological folder, so one directory holding hundreds
// of thousands of files cannot produce an unbounded response.
const TREE_MAX_PER_DIR: usize = 20000;

// A checkout of some other project. Its own tooling manages it; it is not part
// of the document being edited.
fn is_separate_project(dir: &Path) -> bool {
    ["/.git", "/.hg", "/.svn"]
        .iter()
        .any(|marker| dir.join(marker.trim_start_matches('/')).exists())
}

// Bulk output nobody browses in an editor. Dotted names and node_modules are
// already excluded by is_hidden_entry.
fn is_bulk_dir(name: &str) -> bool {
    matches!(name, "__pycache__" | "venv" | "site-packages")
}

// Descent stops `max_depth` levels below `dir`, and once `budget` entries have
// been emitted. usize::MAX for either lifts that limit, for callers that need the
// real contents of the project rather than something cheap to draw. The skips for
// separate checkouts and bulk directories always apply.
fn walk_tree(dir: &Path, ws: &Path, depth: usize, budget: &mut usize, max_depth: usize) -> Vec<Value> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else { return out };
    let mut items: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    items.sort();
    for item in items {
        if out.len() >= TREE_MAX_PER_DIR {
            break;
        }
        // PDFs (both the compiled out.pdf and any the user adds) stay visible
        // here so they can be opened and downloaded from the tree.
        if is_hidden_entry(&item) {
            continue;
        }
        *budget = budget.saturating_sub(1);
        let full = dir.join(&item);
        let Ok(kind) = fs::symlink_metadata(&full).map(|m| m.file_type()) else { continue };
        if kind.is_symlink() {
            continue;
        }
        let Ok(st) = fs::metadata(&full) else { continue };
        let rel = full.strip_prefix(ws).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        if st.is_dir() {
            // Not descended into: it holds a separate project, it is bulk
            // output, we are already deep, or the walk has emitted enough. Its
            // contents are fetched if the user opens it, on a fresh budget, so
            // they do arrive in full. A folder we did walk is complete and is
            // not marked, however much of the budget it used up.
            let stop = is_bulk_dir(&item)
                || is_separate_project(&full)
                || depth + 1 >= max_depth
                || *budget == 0;
            let children = if stop {
                Vec::new()
            } else {
                walk_tree(&full, ws, depth + 1, budget, max_depth)
            };
            let truncated = stop;
            out.push(json!({
                "type": "directory", "name": item, "path": rel,
                "children": children, "truncated": truncated,
            }));
        } else {
            let mtime = st.modified().map(epoch_ms).unwrap_or(0.0);
            out.push(json!({ "type": "file", "name": item, "path": rel, "size": st.len(), "mtime": mtime }));
        }
    }
    out
}

// Reading a folder tree is filesystem work, and the app asks for it after most
// edits. Run it on the blocking pool: doing it inline stalls every other request
// on this runtime, which is what made dragging the pane splitter stutter while a
// large folder was open.
async fn workspace_tree(State(st): St, Query(q): Q) -> Response {
    let ws = st.ws();
    // `full=1` lifts the limits that keep the displayed tree cheap. Sharing a
    // project has to enumerate every file it actually contains, and a folder the
    // sidebar has not read yet is still part of the project. Separate checkouts
    // and bulk directories stay excluded either way — those are not the user's
    // document and have no business being pushed through a session.
    let full = q.get("full").map(|v| v == "1" || v == "true").unwrap_or(false);
    let tree = tokio::task::spawn_blocking(move || {
        let mut budget = if full { usize::MAX } else { TREE_MAX_ENTRIES };
        let max_depth = if full { usize::MAX } else { TREE_MAX_DEPTH };
        walk_tree(&ws.clone(), &ws, 0, &mut budget, max_depth)
    })
    .await
    .unwrap_or_default();
    Json(tree).into_response()
}

// The children of one directory the main walk left unread, fetched when the user
// opens it.
//
// How far in depends on why it went unread. A folder the walk deliberately backs
// away from — another project's checkout, a virtualenv — gives up one level at a
// time, because descending into those is what made the tree crawl in the first
// place. A folder it merely ran out of budget before reaching is an ordinary part
// of this project and opens like any other, on a fresh budget.
async fn workspace_subtree(State(st): St, Query(q): Q) -> Response {
    let ws = st.ws();
    let Some(rel) = q.get("path").map(String::as_str).filter(|p| !p.is_empty()) else {
        return json_err(StatusCode::BAD_REQUEST, "Folder path required.");
    };
    let Some(dir) = safe_workspace_path(&ws, rel) else {
        return json_err(StatusCode::BAD_REQUEST, "Invalid folder path.");
    };
    if !dir.is_dir() {
        return json_err(StatusCode::NOT_FOUND, "Not a folder.");
    }
    let root = ws.clone();
    let children = tokio::task::spawn_blocking(move || {
        let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let avoided = is_separate_project(&dir) || is_bulk_dir(&name);
        let mut budget = TREE_MAX_ENTRIES;
        walk_tree(&dir, &root, 0, &mut budget, if avoided { 1 } else { TREE_MAX_DEPTH })
    })
    .await
    .unwrap_or_default();
    Json(children).into_response()
}

async fn workspace_root_get(State(st): St) -> Response {
    Json(json!({ "root": st.ws().to_string_lossy() })).into_response()
}

async fn workspace_root_post(State(st): St, body: Bytes) -> Response {
    if st.remote_mode() {
        return json_err(
            StatusCode::FORBIDDEN,
            "A hosted workspace is locked to the server's configured project folder.",
        );
    }
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
    // Join asks only for a parent location and lets the app make the destination
    // folder. create_dir is atomic: two simultaneous joins cannot both claim the
    // same empty name, and an old empty folder is never silently reused.
    if v.get("create").and_then(Value::as_bool).unwrap_or(false) {
        match fs::create_dir(&resolved) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return json_err(StatusCode::CONFLICT, "That shared-project folder already exists.");
            }
            Err(e) => {
                return json_err(
                    StatusCode::BAD_REQUEST,
                    format!("Could not create {}: {e}", resolved.display()),
                );
            }
        }
    }
    match fs::metadata(&resolved) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return json_err(StatusCode::BAD_REQUEST, format!("Not a folder: {}", resolved.display())),
        Err(_) => return json_err(StatusCode::BAD_REQUEST, format!("Not a folder: {}", resolved.display())),
    }
    if v.get("requireEmpty").and_then(Value::as_bool).unwrap_or(false) {
        let is_empty = fs::read_dir(&resolved)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !is_empty {
            return json_err(
                StatusCode::CONFLICT,
                "Choose a new or empty folder for the incoming shared project.",
            );
        }
    }
    let old_ws = st.ws();
    let stop_old_lsp = move_workspace_user(&old_ws, &resolved);
    *st.workspace.write().unwrap_or_else(|e| e.into_inner()) = resolved.clone();
    stop_preview_watcher(&st).await;
    // Tinymist is shared per workspace. Moving one of two windows away must not
    // interrupt completion/diagnostics in the window that stayed behind.
    if stop_old_lsp {
        stop_lsp_for(&old_ws).await;
    }
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
    match write_atomic(&full, &content) {
        Ok(_) => {
            st.note_write();
            // The hash of what we wrote, not of a read-back. Reading the file
            // again looks more careful and is in fact the bug: on Windows the
            // write lands through a rename, and with a filter driver in the way
            // — every antivirus is one — the read that follows can still return
            // the previous contents. The editor then remembers a hash for text
            // one keystroke old, so its next save fails its own precondition and
            // the app announces that the file "changed outside Hilbert" about a
            // change it made itself. From there nothing can be saved and nothing
            // reaches the preview, because every compile begins with that save.
            let written = String::from_utf8_lossy(&content);
            Json(json!({ "ok": true, "hash": format!("{:016x}", content_hash(&written)) })).into_response()
        }
        Err(_) => text_err(StatusCode::INTERNAL_SERVER_ERROR, "Error"),
    }
}

// Saving is not a private act: `typst watch` has the file open for changes, and
// hears about it the moment it is truncated — well before the new text lands.
// Whatever it manages to read at that instant is what gets compiled, which is
// how a preview comes back missing the last characters that were typed. The
// window is narrow on macOS and wide on Windows, where the change notification
// arrives immediately rather than being coalesced.
//
// Renaming into place closes it: a reader sees either the previous file or the
// complete new one, never a half-written one. If any of that fails we still
// write in place, because losing someone's work to protect them from a race is
// the worse trade.
fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let Some(parent) = path.parent() else { return fs::write(path, contents) };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = parent.join(format!(".{name}.{seq}.hilbert-tmp"));
    match fs::write(&tmp, contents).and_then(|_| fs::rename(&tmp, path)) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&tmp);
            fs::write(path, contents).map_err(|_| error)
        }
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
        Ok(_) => {
            st.note_write();
            "OK".into_response()
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            text_err(StatusCode::NOT_FOUND, "Not found")
        }
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
    match write_atomic(&full, &body) {
        Ok(_) => {
            st.note_write();
            "OK".into_response()
        }
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
    // Atomic, because `typst watch` is looking at this directory: a half-written
    // PNG is a compile error the user did nothing to cause.
    match write_atomic(&full, &bytes) {
        Ok(_) => {
            st.note_write();
            Json(json!({ "ok": true, "path": path })).into_response()
        }
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// Copy one workspace entry without ever opening an existing destination for
// writing. `fs::copy(src, src)` is not a harmless no-op on every platform: it
// may truncate the source before it starts reading. The UI can produce exactly
// that pair when Copy/Paste is used in the same folder, so exclusivity belongs
// here at the filesystem boundary, not only in a caller that may be bypassed.
//
// Directories are handled too because the file-tree advertises Duplicate and
// Copy for folders. Symlinks are rejected rather than followed; the workspace
// tree hides them for the same confinement reason.
fn copy_workspace_entry(src: &Path, dst: &Path) -> std::io::Result<u64> {
    use std::io::{Error, ErrorKind};

    if src == dst || dst.exists() {
        return Err(Error::new(ErrorKind::AlreadyExists, "Destination already exists"));
    }
    let metadata = fs::symlink_metadata(src)?;
    if metadata.file_type().is_symlink() {
        return Err(Error::new(ErrorKind::InvalidInput, "Symbolic links cannot be copied"));
    }

    if metadata.is_file() {
        use std::io::copy;
        let mut input = fs::File::open(src)?;
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(dst)?;
        let result = copy(&mut input, &mut output)
            .and_then(|bytes| {
                output.sync_all()?;
                fs::set_permissions(dst, metadata.permissions())?;
                Ok(bytes)
            });
        if result.is_err() {
            let _ = fs::remove_file(dst);
        }
        return result;
    }

    if !metadata.is_dir() {
        return Err(Error::new(ErrorKind::InvalidInput, "Unsupported file type"));
    }
    // A recursive copy into one of its own descendants would never finish.
    if dst.starts_with(src) {
        return Err(Error::new(ErrorKind::InvalidInput, "A folder cannot be copied inside itself"));
    }

    fs::create_dir(dst)?;
    let result = (|| {
        let mut total = 0u64;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            total = total.saturating_add(copy_workspace_entry(&entry.path(), &dst.join(entry.file_name()))?);
        }
        fs::set_permissions(dst, metadata.permissions())?;
        Ok(total)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(dst);
    }
    result
}

// Copy a file or folder within the workspace (e.g. duplicate a tree entry or
// promote a sandbox plot into images/). Large copies stay off Tokio's async
// workers, keeping the editor and preview responsive while the disk is busy.
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
    if src == dst || dst.exists() {
        return json_err(StatusCode::CONFLICT, "Destination already exists.");
    }
    if src.is_dir() && dst.starts_with(&src) {
        return json_err(StatusCode::BAD_REQUEST, "A folder cannot be copied inside itself.");
    }
    if let Some(parent) = dst.parent()
        && let Err(e) = fs::create_dir_all(parent)
    {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    let to = jstr(&v, "to").unwrap_or("").to_string();
    match tokio::task::spawn_blocking(move || copy_workspace_entry(&src, &dst)).await {
        Ok(Ok(_)) => {
            st.note_write();
            Json(json!({ "ok": true, "path": to })).into_response()
        }
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            json_err(StatusCode::CONFLICT, "Destination already exists.")
        }
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::InvalidInput => {
            json_err(StatusCode::BAD_REQUEST, e.to_string())
        }
        Ok(Err(e)) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
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
        Ok(_) => {
            st.note_write();
            Json(json!({ "ok": true, "path": jstr(&v, "to").unwrap_or("") })).into_response()
        }
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// Reveal a file or folder in the native OS file manager.
async fn workspace_reveal(State(st): St, body: Bytes) -> Response {
    if st.remote_mode() {
        return json_err(StatusCode::NOT_IMPLEMENTED, "Reveal is unavailable in a hosted browser session.");
    }
    let v = parse_json(&body);
    let ws = st.ws();
    let target = jstr(&v, "path").and_then(|p| safe_workspace_path(&ws, p)).unwrap_or_else(|| ws.clone());
    if !target.exists() {
        return json_err(StatusCode::NOT_FOUND, "Path not found");
    }
    reveal_in_file_manager(&target);
    Json(json!({ "ok": true })).into_response()
}

// --- Live collaboration relay ------------------------------------------------
//
// A per-room broadcast relay for Yjs sync + awareness. Clients (each a Hilbert
// window) connect to /collab/<room> and everything one sends is forwarded to the
// others in the same room; they run the CRDT sync handshake peer-to-peer through
// it. The relay never inspects or stores document data — it only shuttles the
// clients' AES-GCM encrypted frames, so it stays dumb and content-blind.
//
// The room id is the shared secret: only someone with the invite can join. This
// same handler backs both a peer hosting on the LAN and a Hilbert run purely as
// a sync server (see sync_server_main), so collaborators point at one address.
struct CollabRooms {
    rooms: HashMap<String, (tokio::sync::broadcast::Sender<(u64, Bytes)>, usize)>,
}
struct HostedClaim {
    claimed_at: Instant,
    active: bool,
}
static COLLAB: LazyLock<Mutex<CollabRooms>> =
    LazyLock::new(|| Mutex::new(CollabRooms { rooms: HashMap::new() }));
// Hosted browsers all open the same on-server workspace. Exactly one must seed
// its Yjs room; if two independently create the same path, Y.Map conflict
// resolution can leave one editor bound to an object that lost the map key.
// The short pre-connection lease recovers if a browser asks for host duty and
// crashes before opening its socket. Once any room socket arrives the claim is
// active until the last peer leaves.
static HOSTED_CLAIMS: LazyLock<Mutex<HashMap<String, HostedClaim>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static COLLAB_CLIENT: AtomicU64 = AtomicU64::new(1);

const COLLAB_MAX_ROOMS: usize = 256;
const COLLAB_MAX_PEERS_PER_ROOM: usize = 32;
const COLLAB_MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const COLLAB_MAX_BYTES_PER_SECOND: usize = 16 * 1024 * 1024;

#[derive(Clone, Default, serde::Serialize)]
struct EmbeddedCollabInfo {
    available: bool,
    port: Option<u16>,
    urls: Vec<String>,
}

static EMBEDDED_COLLAB: LazyLock<RwLock<EmbeddedCollabInfo>> =
    LazyLock::new(|| RwLock::new(EmbeddedCollabInfo::default()));

pub fn set_embedded_collab_server(port: u16, addresses: Vec<String>) {
    let urls = addresses
        .into_iter()
        .map(|address| {
            if address.contains(':') {
                format!("ws://[{address}]:{port}")
            } else {
                format!("ws://{address}:{port}")
            }
        })
        .collect();
    *EMBEDDED_COLLAB.write().unwrap() = EmbeddedCollabInfo {
        available: true,
        port: Some(port),
        urls,
    };
}

async fn collab_server_info(State(st): St, headers: HeaderMap) -> Response {
    let mut info = EMBEDDED_COLLAB.read().unwrap_or_else(|e| e.into_inner()).clone();
    // Hosted workspaces carry the relay on the same HTTP(S) port. Deriving the
    // suggestion from the already-validated same-origin Host makes it work both
    // directly and behind a TLS reverse proxy without another exposed port.
    if st.remote_mode()
        && let Some(host) = headers.get(header::HOST).and_then(|value| value.to_str().ok())
    {
        let tls = headers
            .get("x-forwarded-proto")
            .and_then(|value| value.to_str().ok())
            .map(|value| value.eq_ignore_ascii_case("https"))
            .unwrap_or(false);
        info.urls.insert(0, format!("{}://{host}", if tls { "wss" } else { "ws" }));
        info.urls.dedup();
        info.available = true;
    }
    Json(info).into_response()
}

async fn collab_health() -> Response {
    let rooms = COLLAB.lock().unwrap_or_else(|e| e.into_inner());
    let peers: usize = rooms.rooms.values().map(|(_, count)| *count).sum();
    Json(json!({
        "ok": true,
        "rooms": rooms.rooms.len(),
        "peers": peers,
        "maxRooms": COLLAB_MAX_ROOMS,
        "maxPeersPerRoom": COLLAB_MAX_PEERS_PER_ROOM,
    }))
    .into_response()
}

fn valid_collab_room(room: &str) -> bool {
    (16..=128).contains(&room.len())
        && room
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn collab_join(room: &str) -> Option<tokio::sync::broadcast::Sender<(u64, Bytes)>> {
    let mut g = COLLAB.lock().unwrap();
    if let Some((sender, peers)) = g.rooms.get_mut(room) {
        if *peers >= COLLAB_MAX_PEERS_PER_ROOM {
            return None;
        }
        *peers += 1;
        if let Some(claim) = HOSTED_CLAIMS.lock().unwrap_or_else(|e| e.into_inner()).get_mut(room) {
            claim.active = true;
        }
        return Some(sender.clone());
    }
    if g.rooms.len() >= COLLAB_MAX_ROOMS {
        return None;
    }
    let entry = g.rooms.entry(room.to_string()).or_insert_with(|| {
        // Clients re-request CRDT state on their periodic resync, so a lagged
        // peer recovers on its own. Keep the ring buffer small: it retains its
        // most recent entries either way, and at the 1 MiB frame limit a large
        // capacity would let one room pin hundreds of megabytes.
        (tokio::sync::broadcast::channel(128).0, 0)
    });
    entry.1 += 1;
    if let Some(claim) = HOSTED_CLAIMS.lock().unwrap_or_else(|e| e.into_inner()).get_mut(room) {
        claim.active = true;
    }
    Some(entry.0.clone())
}

fn collab_leave(room: &str) {
    let mut g = COLLAB.lock().unwrap();
    if let Some(entry) = g.rooms.get_mut(room) {
        entry.1 = entry.1.saturating_sub(1);
        if entry.1 == 0 {
            g.rooms.remove(room);
        }
    }
    let base = room.strip_suffix("-bin").unwrap_or(room);
    let binary = format!("{base}-bin");
    let any_hosted_socket = g.rooms.get(base).map(|(_, peers)| *peers > 0).unwrap_or(false)
        || g.rooms.get(&binary).map(|(_, peers)| *peers > 0).unwrap_or(false);
    if !any_hosted_socket {
        HOSTED_CLAIMS.lock().unwrap_or_else(|e| e.into_inner()).remove(base);
    }
}

fn activate_hosted_claim(room: &str) {
    HOSTED_CLAIMS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(room.to_string(), HostedClaim { claimed_at: Instant::now(), active: true });
}

fn collab_upgrade(ws: WebSocketUpgrade, room: String, hosted_room: Option<String>) -> Response {
    if !valid_collab_room(&room) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    ws.max_message_size(COLLAB_MAX_MESSAGE_BYTES)
        .max_frame_size(COLLAB_MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| collab_socket(socket, room, hosted_room))
}

async fn hosted_collab_ws(
    State(st): St,
    ws: WebSocketUpgrade,
    axum::extract::Path(room): axum::extract::Path<String>,
) -> Response {
    let hosted_room = st.remote_collab_room.as_ref().and_then(|hosted| {
        (room == *hosted || room == format!("{hosted}-bin")).then(|| hosted.clone())
    });
    collab_upgrade(ws, room, hosted_room)
}

async fn collab_ws(
    ws: WebSocketUpgrade,
    axum::extract::Path(room): axum::extract::Path<String>,
) -> Response {
    collab_upgrade(ws, room, None)
}

async fn collab_socket(mut socket: WebSocket, room: String, hosted_room: Option<String>) {
    let Some(tx) = collab_join(&room) else {
        return;
    };
    // The process may have restarted while browsers kept their pages open.
    // Their stable hosted-room socket is the evidence that a host already
    // exists. Rebuild the in-memory claim before a newly opened browser calls
    // /hosted/info, or that browser would also seed as a host and both Monaco
    // bindings could attach to different concurrently-created Y.Text objects.
    // A refused join must not do this: only collab_leave clears the claim, so a
    // claim with no peer behind it would send every later browser to join a
    // document nobody had seeded.
    if let Some(hosted_room) = hosted_room.as_deref() {
        activate_hosted_claim(hosted_room);
    }
    let mut rx = tx.subscribe();
    let id = COLLAB_CLIENT.fetch_add(1, Ordering::Relaxed);
    let mut rate_window = Instant::now();
    let mut bytes_in_window = 0usize;
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Binary(data))) => {
                    if rate_window.elapsed() >= Duration::from_secs(1) {
                        rate_window = Instant::now();
                        bytes_in_window = 0;
                    }
                    bytes_in_window = bytes_in_window.saturating_add(data.len());
                    if bytes_in_window > COLLAB_MAX_BYTES_PER_SECOND {
                        break;
                    }
                    let _ = tx.send((id, data));
                }
                // The Yjs transport is binary-only. Rejecting text avoids
                // ambiguous transcoding and keeps message accounting exact.
                Some(Ok(Message::Text(_))) => break,
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {} // ping/pong is handled by axum
            },
            relayed = rx.recv() => match relayed {
                Ok((from, data)) if from != id => {
                    if socket.send(Message::Binary(data)).await.is_err() { break; }
                }
                Ok(_) => {} // our own message echoed back — skip
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {} // peer resyncs from CRDT
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
        }
    }
    collab_leave(&room);
}

async fn app_new_window(State(st): St) -> Response {
    if st.remote_mode() {
        return json_err(StatusCode::NOT_IMPLEMENTED, "Open this hosted workspace in another browser tab instead.");
    }
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
        if is_hidden_source_entry(&name) {
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

// Preview bytes are deliberately smaller than the workspace upload limit. The
// file stays on disk and can still be edited/downloaded externally; only the
// disposable in-memory browser preview is refused.
const MAX_WORKSPACE_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PDF_PREVIEW_BYTES: u64 = 96 * 1024 * 1024;

fn read_file_limited(path: &Path, limit: u64) -> std::io::Result<Option<Vec<u8>>> {
    let file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    if len > limit { return Ok(None); }
    let mut bytes = Vec::with_capacity(len.min(limit) as usize);
    let mut limited = std::io::Read::take(file, limit + 1);
    std::io::Read::read_to_end(&mut limited, &mut bytes)?;
    if bytes.len() as u64 > limit { Ok(None) } else { Ok(Some(bytes)) }
}

// Serve a raw workspace file (e.g. image / file preview) with a guessed MIME type.
async fn workspace_raw(State(st): St, Query(q): Q) -> Response {
    let Some(full) = q.get("path").and_then(|p| safe_workspace_path(&st.ws(), p)) else {
        return text_err(StatusCode::BAD_REQUEST, "Invalid path");
    };
    match read_file_limited(&full, MAX_WORKSPACE_PREVIEW_BYTES) {
        Ok(Some(bytes)) => {
            let mime = mime_guess::from_path(&full).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], bytes).into_response()
        }
        Ok(None) => text_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Preview not loaded: this file is larger than Hilbert's 64 MiB preview limit. The file is unchanged on disk.",
        ),
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
                let mut f = fs::File::open(full).map_err(|e| e.to_string())?;
                zip.start_file(name, options).map_err(|e| e.to_string())?;
                std::io::copy(&mut f, &mut zip).map_err(|e| e.to_string())?;
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
                    let _ = events.send(PreviewEvent::new(cycle_generation, PreviewOutcome::Error(message)));
                    pending_error = false;
                    diagnostics.clear();
                    continue;
                }
            }
        } else {
            lines.recv().await
        };

        let Some(line) = next else {
            note("watch: output ended — the watcher is gone");
            if pending_error {
                let message = if diagnostics.is_empty() { "Compilation failed.".into() } else { diagnostics.join("\n") };
                let _ = events.send(PreviewEvent::new(cycle_generation, PreviewOutcome::Error(message)));
            } else {
                let generation = st.source_generation.load(Ordering::Acquire);
                let _ = events.send(PreviewEvent::new(generation, PreviewOutcome::Unavailable));
            }
            break;
        };
        let line = line.trim_end_matches('\r').to_string();

        if !line.trim().is_empty() { note!("watch: {line}"); }
        if line.contains("compiling ...") {
            cycle_generation = st.source_generation.load(Ordering::Acquire);
            pending_error = false;
            diagnostics.clear();
            // Announce the in-flight cycle so waiters can tell "still compiling"
            // apart from "no compile is coming for this generation".
            let _ = events.send(PreviewEvent::new(cycle_generation, PreviewOutcome::Waiting));
        } else if line.contains("compiled successfully") || line.contains("compiled with warnings") {
            let _ = events.send(PreviewEvent::new(cycle_generation, PreviewOutcome::Success));
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
        note("watch: stopping the watcher");
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
    if let Some(watcher) = guard.as_mut()
        && watcher.key == key && matches!(watcher.child.try_wait(), Ok(None))
    {
        return Ok(watcher.events.clone());
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
    // Typst knows exactly which files the document is built from; ask it to
    // write them down. Which files belong to the project is what tells the
    // editor whether a chapter should be read on its own or as part of the whole.
    cmd.arg("--deps").arg(main_deps_path(ws, main_path)).arg("--deps-format").arg("make");
    cmd.arg(main_path)
        .arg(output_path)
        .current_dir(ws)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    strip_appimage_env(&mut cmd);
    let mut child = cmd.spawn()?;
    note!("watch: started typst watch on {} (pid {:?})", main_path.display(), child.id());
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

    let initial = PreviewEvent::new(0, PreviewOutcome::Waiting);
    let (event_tx, event_rx) = tokio::sync::watch::channel(initial);
    tokio::spawn(collect_preview_events(st.clone(), line_rx, event_tx));
    *guard = Some(PreviewWatcher { key, child, events: event_rx.clone() });
    Ok(event_rx)
}

// How long to keep waiting on a cycle the watcher has announced but not
// finished. Long enough for a genuinely heavy document, short enough that a
// watcher which has stopped answering doesn't hold the preview hostage.
const IN_FLIGHT_BUDGET: Duration = Duration::from_secs(30);

// A direct compile is bounded too. Nothing here should ever need this long, but
// the request used to have no ceiling at all, and one typst that never exits
// took the compile slot with it — every later keystroke then queued behind a
// process that was never coming back, which is indistinguishable from the app
// having died.
const DIRECT_COMPILE_BUDGET_MS: u64 = 90_000;

enum WatchCompileResult {
    Pdf(Vec<u8>),
    CompileError(String),
    // Compile in this process, and leave the watcher running: it is healthy, it
    // just isn't going to produce a cycle for this particular edit.
    Direct,
    Fallback,
}

#[derive(Debug, PartialEq)]
enum WatchStep {
    // The watcher's answer covers this edit — hand it over.
    Serve,
    // A cycle is running; this is what's left of its budget.
    AwaitCycle(Duration),
    // Nothing is running yet. Give the watcher a moment to notice the write.
    AwaitStart(Duration),
}

// How long to give the watcher to react to a write before giving up on it for
// this edit. It notices one in about a hundred milliseconds, so silence past
// this means no cycle is coming and every further millisecond is one the
// preview spends behind the editor.
const START_GRACE: Duration = Duration::from_millis(500);

// Whether the watcher's latest word still decides this request.
//
// The subtlety is Waiting. typst watch announces "compiling ..." and then says
// how it went, and if that second line never arrives, the announcement used to
// stay its answer for good: every later keystroke then waited out the entire
// budget before falling back, so the preview sat on "Compiling…" for half a
// minute at a time with a typst process idling next to it doing nothing. Dating
// the announcement makes one lost cycle cost one wait instead of all of them,
// while a document that genuinely takes twenty seconds still gets its twenty.
fn watcher_step(event: &PreviewEvent, target_generation: u64, elapsed: Duration) -> WatchStep {
    if matches!(event.outcome, PreviewOutcome::Waiting) && elapsed < IN_FLIGHT_BUDGET {
        return WatchStep::AwaitCycle(IN_FLIGHT_BUDGET - elapsed);
    }
    if event.generation >= target_generation {
        return WatchStep::Serve;
    }
    WatchStep::AwaitStart(START_GRACE)
}

async fn compile_from_watcher(
    st: &Arc<AppState>,
    ws: &Path,
    main_path: &Path,
    output_path: &Path,
    target_generation: u64,
) -> WatchCompileResult {
    let Ok(mut events) = ensure_preview_watcher(st, ws, main_path, output_path).await else {
        note("compile: could not start typst watch — compiling directly instead");
        return WatchCompileResult::Fallback;
    };
    let finish = |outcome: PreviewOutcome| match outcome {
        PreviewOutcome::Success => match read_file_limited(output_path, MAX_PDF_PREVIEW_BYTES) {
            Ok(Some(bytes)) => WatchCompileResult::Pdf(bytes),
            Ok(None) => WatchCompileResult::CompileError(
                "The PDF compiled successfully but is larger than Hilbert's 96 MiB preview limit. The source and compiled file remain saved on disk.".into(),
            ),
            Err(_) => WatchCompileResult::Fallback,
        },
        PreviewOutcome::Error(message) => WatchCompileResult::CompileError(message),
        _ => WatchCompileResult::Fallback,
    };
    loop {
        let event = events.borrow().clone();
        let (in_flight, wait) = match watcher_step(&event, target_generation, event.since.elapsed()) {
            WatchStep::Serve => return finish(event.outcome),
            WatchStep::AwaitCycle(left) => (true, left),
            WatchStep::AwaitStart(grace) => (false, grace),
        };
        match tokio::time::timeout(wait, events.changed()).await {
            Ok(Ok(())) => continue,
            Ok(Err(_)) => {
                note("compile: the watcher's reader is gone — compiling directly instead");
                return WatchCompileResult::Fallback;
            }
            Err(_) if in_flight => {
                // A cycle that started and never reported back. Worth naming
                // loudly: it is the one shape of this that costs the full wait
                // on every keystroke, and from the outside it just looks hung.
                note!(
                    "compile: typst watch said it was compiling and never finished within {}s \
                     (waiting for generation {target_generation}, watcher last reported {}) \
                     — restarting it and compiling directly",
                    IN_FLIGHT_BUDGET.as_secs(),
                    events.borrow().generation,
                );
                return WatchCompileResult::Fallback;
            }
            // No cycle is coming. What sits in out.pdf was rendered from a read
            // that happened before this edit, and handing it back is what left
            // "wa" showing as "w" until the next keystroke dislodged it. Compile
            // directly instead: a couple of hundred milliseconds for an answer
            // that is actually current, and the watcher stays up for next time.
            Err(_) => return WatchCompileResult::Direct,
        }
    }
}

async fn compile_once(ws: &Path, main_path: &Path, output_path: &Path) -> Response {
    let mut compile_args: Vec<String> = vec!["compile".into(), "--root".into(), ws.to_string_lossy().into_owned()];
    if ws.join("fonts").is_dir() {
        compile_args.push("--font-path".into());
        compile_args.push("fonts".into());
    }
    compile_args.push("--deps".into());
    compile_args.push(main_deps_path(ws, main_path).to_string_lossy().into_owned());
    compile_args.push("--deps-format".into());
    compile_args.push("make".into());
    compile_args.push(main_path.to_string_lossy().into_owned());
    compile_args.push(output_path.to_string_lossy().into_owned());
    let compile_argv: Vec<&str> = compile_args.iter().map(String::as_str).collect();
    let started = Instant::now();
    let out = match run_cmd("typst", &compile_argv, Some(ws), Some(DIRECT_COMPILE_BUDGET_MS)).await {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return json_err(StatusCode::INTERNAL_SERVER_ERROR, TYPST_NOT_FOUND),
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Could not run typst: {e}")),
    };
    note!("compile: direct compile finished in {} ms (exit {:?})", started.elapsed().as_millis(), out.code);
    if out.killed {
        return json_err(
            StatusCode::GATEWAY_TIMEOUT,
            format!(
                "typst did not finish within {} seconds and was stopped. \
                 If it keeps happening, try compiling the same file from a terminal to see where it gets to.",
                DIRECT_COMPILE_BUDGET_MS / 1000
            ),
        );
    }
    if out.code != Some(0) {
        let msg = if out.stderr.is_empty() {
            format!("typst exited with code {}", out.code.map(|c| c.to_string()).unwrap_or_else(|| "null".into()))
        } else {
            out.stderr
        };
        return json_err(StatusCode::BAD_REQUEST, msg);
    }
    match read_file_limited(output_path, MAX_PDF_PREVIEW_BYTES) {
        Ok(Some(bytes)) => ([(header::CONTENT_TYPE, "application/pdf")], bytes).into_response(),
        Ok(None) => json_err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "The PDF compiled successfully but is larger than Hilbert's 96 MiB preview limit. The source and compiled file remain saved on disk.",
        ),
        Err(e) => json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn compile(State(st): St, Query(q): Q, body: Bytes) -> Response {
    let queued = Instant::now();
    let Ok(_permit) = st.compile_gate.acquire().await else {
        return json_err(StatusCode::SERVICE_UNAVAILABLE, "Compiler is shutting down.");
    };
    // Only one compile runs at a time, so a slow one shows up here as everyone
    // else's wait. Worth separating from the compile's own cost: they look the
    // same from the editor and have completely different causes.
    let waited = queued.elapsed().as_millis();
    if waited > 200 { note!("compile: waited {waited} ms for the compile slot"); }
    let ws = st.ws();
    let main_q = q.get("main").map(String::as_str).unwrap_or("main.typ");
    let Some(main_path) = safe_workspace_path(&ws, main_q) else {
        return json_err(StatusCode::BAD_REQUEST, "Invalid main path");
    };
    ensure_hilbert(&ws);
    let output_path = st.preview_path(&ws, false);
    let body_str = String::from_utf8_lossy(&body);
    if !body_str.trim().is_empty() && write_atomic(&main_path, body_str.as_bytes()).is_ok() {
        st.note_write();
    }
    let generation = st.source_generation.load(Ordering::Acquire);
    let outcome = compile_from_watcher(&st, &ws, &main_path, &output_path, generation).await;
    let response = match outcome {
        WatchCompileResult::Pdf(bytes) => {
            note!("compile: served the watcher's PDF ({} bytes) in {} ms", bytes.len(), queued.elapsed().as_millis());
            ([(header::CONTENT_TYPE, "application/pdf")], bytes).into_response()
        }
        WatchCompileResult::CompileError(message) => {
            note!("compile: typst reported errors after {} ms", queued.elapsed().as_millis());
            json_err(StatusCode::BAD_REQUEST, message)
        }
        // A separate output file, so this never races the watcher writing its own.
        WatchCompileResult::Direct => {
            compile_once(&ws, &main_path, &st.preview_path(&ws, true)).await
        }
        WatchCompileResult::Fallback => {
            stop_preview_watcher(&st).await;
            compile_once(&ws, &main_path, &output_path).await
        }
    };
    let total = queued.elapsed().as_millis();
    // Anything past a second is not what this is supposed to feel like, and it
    // is the number people are actually describing when they say it hangs.
    if total > 1000 { note!("compile: the whole request took {total} ms"); }
    response
}

// A scratch directory nothing else can be holding. The old names were
// `<tool>-<pid>-<name>`, which two requests for the same template share — and
// since each one starts by deleting the directory, the second wipes the first's
// work while it is still running.
fn unique_temp_dir(prefix: &str) -> std::io::Result<PathBuf> {
    // /tmp is shared, and on a multi-user box a predictable name is one someone
    // else can create first — as a symlink pointing wherever they like. The name
    // is random, and create_dir (not create_dir_all) fails if anything is already
    // there, so a directory we get back is one we made.
    let prefix: String = prefix.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')).collect();
    for _ in 0..8 {
        let mut bytes = [0u8; 12];
        getrandom::fill(&mut bytes).map_err(std::io::Error::other)?;
        let suffix = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
        let dir = std::env::temp_dir().join(format!("{prefix}-{suffix}"));
        match fs::create_dir(&dir) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
                }
                return Ok(dir);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other("could not create a scratch directory"))
}

// Move everything from one directory into another. A rename is one syscall and
// covers the usual case; when the scratch directory turns out to be on another
// filesystem it falls back to the copy the workspace already uses elsewhere,
// which refuses to overwrite and rejects symlinks for us.
fn move_dir_contents(from: &Path, to: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if fs::rename(&src, &dst).is_ok() { continue; }
        copy_workspace_entry(&src, &dst)?;
        let _ = if src.is_dir() { fs::remove_dir_all(&src) } else { fs::remove_file(&src) };
    }
    Ok(())
}

// The app's own scratch, and the file the Finder leaves lying around. Neither is
// the user's work, and neither should make a folder look occupied.
fn is_app_scratch(name: &std::ffi::OsStr) -> bool {
    matches!(name.to_string_lossy().as_ref(), ".hilbert" | ".DS_Store")
}

fn dir_entry_count(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|rd| rd.flatten().filter(|e| !is_app_scratch(&e.file_name())).count())
        .unwrap_or(0)
}

// Create a project from a Typst Universe template.
//
// This used to run `fs::remove_dir_all(&ws)` first, which deletes whatever the
// user currently has open — no confirmation, no undo, and in hosted mode it
// takes the shared project with it. Now the template is built in a scratch
// directory and only moved in once it compiles, and a workspace that already
// has files in it is refused unless the caller explicitly asks to replace it.
async fn init_template(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let Some(template) = jstr(&v, "template").filter(|t| !t.is_empty()) else {
        return json_err(StatusCode::BAD_REQUEST, "Template name required");
    };
    if template.starts_with('-') {
        return json_err(StatusCode::BAD_REQUEST, "Invalid template name");
    }
    let replace = v.get("replace").and_then(Value::as_bool).unwrap_or(false);
    let ws = st.ws();
    let _ = fs::create_dir_all(&ws);
    let existing = dir_entry_count(&ws);
    if existing > 0 && !replace {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "workspace-not-empty",
                "entries": existing,
                "workspace": ws.to_string_lossy(),
            })),
        )
            .into_response();
    }

    let staging = match unique_temp_dir("typst-tpl-init") {
        Ok(dir) => dir,
        Err(e) => return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Could not create a scratch directory: {e}")),
    };
    let target = staging.join("t");
    let cleanup = |dir: &Path| { let _ = fs::remove_dir_all(dir); };
    let out = match run_cmd("typst", &["init", template, &target.to_string_lossy()], None, Some(60_000)).await {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            cleanup(&staging);
            return json_err(StatusCode::INTERNAL_SERVER_ERROR, TYPST_NOT_FOUND);
        }
        Err(e) => {
            cleanup(&staging);
            return json_err(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    };
    if out.code != Some(0) {
        cleanup(&staging);
        return json_err(StatusCode::BAD_REQUEST, out.stderr);
    }

    // The template built. Only now is it safe to touch the workspace.
    if replace {
        if let Ok(rd) = fs::read_dir(&ws) {
            for entry in rd.flatten() {
                if is_app_scratch(&entry.file_name()) { continue; }
                let path = entry.path();
                let _ = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
            }
        }
    }
    if let Err(e) = move_dir_contents(&target, &ws) {
        cleanup(&staging);
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Could not write the template into the workspace: {e}"));
    }
    cleanup(&staging);
    st.note_write();

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
    match run_cmd("typst", &args, Some(ws), Some(EXPORT_TIMEOUT_MS)).await {
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
// Windows: Explorer reads everything after `/select,` itself rather than as an
// ordinary argument, so the argument has to arrive exactly as written. Rust's
// normal quoting wraps the whole thing in quotes the moment the path contains a
// space — and a real one does: a log from a Windows user shows a project at
// C:\Users\...\Documents\Hilbert\Sample holding a file called `main .typ`.
// Explorer does not recognise that form and opens the default folder instead.
// Not gated to Windows so it can be tested anywhere; only its use is.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn explorer_argument(target: &Path, is_dir: bool) -> String {
    let path = target.to_string_lossy().replace('/', "\\");
    // A folder is shown by opening it. Asking Explorer to *select* a folder
    // opens its parent with the folder highlighted, which for a workspace kept
    // directly under Documents looks exactly like "it always opens Documents" —
    // which is how it was reported.
    if is_dir { format!("\"{path}\"") } else { format!("/select,\"{path}\"") }
}

fn reveal_in_file_manager(target: &Path) {
    let is_dir = target.is_dir();
    #[cfg(target_os = "macos")]
    {
        // Same rule as the other two: show a folder by opening it, and a file by
        // revealing it in the folder that holds it.
        let mut cmd = std::process::Command::new("open");
        if !is_dir { cmd.arg("-R"); }
        let _ = cmd.arg(target).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer.exe")
            .raw_arg(explorer_argument(target, is_dir))
            .spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if is_dir { target.to_path_buf() } else { target.parent().map(Path::to_path_buf).unwrap_or_else(|| target.to_path_buf()) };
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
                    } else if kind.is_file()
                        && let Ok(rel) = path.strip_prefix(root)
                    {
                        files.push((rel.to_string_lossy().replace('\\', "/"), path));
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
        use zip::write::{SimpleFileOptions, ZipWriter};
        let f = fs::File::create(&target)?;
        let mut zip = ZipWriter::new(f);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut n = 0usize;
        for (rel, full) in &files {
            let Ok(mut f) = fs::File::open(full) else { continue };
            zip.start_file(rel.as_str(), opts)?;
            std::io::copy(&mut f, &mut zip)?;
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
    if let Some((at, idx)) = guard.as_ref()
        && at.elapsed() < UNIVERSE_TTL
    {
        return Some(idx.clone());
    }
    let mut raw: Option<String> = None;
    if let Ok(resp) = st.http.get(UNIVERSE_INDEX_URL).timeout(Duration::from_secs(15)).send().await
        && resp.status().is_success()
            && let Ok(text) = resp.text().await
        {
            let _ = fs::write(universe_cache_file(), &text);
            raw = Some(text);
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
        if is_hidden_source_entry(&name) {
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

// What counts as a figure a run produced. Vector formats are here too: Typst
// embeds SVG and PDF directly, and EPS — which it cannot embed — is still worth
// collecting, because it is what some journals ask for.
const IMAGE_EXT: [&str; 8] = [".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp", ".pdf", ".eps"];

// The format a run saves its figures in when the code does not name a file
// itself. Anything the caller sends that isn't one of these falls back to PNG,
// so a stale or hand-written request can't smuggle a filename fragment into the
// harness scripts below.
fn plot_format(v: &Value) -> &'static str {
    match jstr(v, "plotFormat").unwrap_or("") {
        "svg" => "svg",
        "pdf" => "pdf",
        "eps" => "eps",
        _ => "png",
    }
}

// Cross-platform `which`: walk PATH ourselves. On Windows the entries are
// separated by ';' and we try each PATHEXT extension so `which("python")`
// matches `python.exe`; on Unix it's ':' and a bare name.
pub(crate) fn which(name: &str) -> Option<String> {
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
            if cfg!(windows)
                && let Ok(rd) = fs::read_dir(home.join("AppData/Local/Programs/Python"))
            {
                for e in rd.flatten() {
                    cands.push(e.path().join("python.exe"));
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
    let refusal = st.exec_refusal();
    const RUNNABLE: [&str; 3] = ["python", "julia", "wolfram"];
    let confined_langs: Vec<&str> =
        RUNNABLE.into_iter().filter(|lang| sandbox::active().real() && sandbox::confines(lang)).collect();
    let screened_langs: Vec<&str> = RUNNABLE.into_iter().filter(|lang| screen_applies(lang)).collect();
    Json(json!({
        "execEnabled": st.allow_exec && refusal.is_none(),
        "execRefusal": refusal,
        "sandbox": {
            "kind": sandbox::active().name(),
            "confined": sandbox::active().real(),
            "network": sandbox::allow_network(),
            // Which languages the sandbox actually holds, and which are left to
            // the source screen. The panel reads this rather than repeating the
            // answer, so the two cannot disagree later.
            "confinedLanguages": confined_langs,
            "screenedLanguages": screened_langs,
            "detail": sandbox::describe(),
        },
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
    if lang == "python" {
        return format!("{}\nprint(equation_output({}))\n",
            include_str!("equation.py"), serde_json::to_string(code).unwrap());
    }
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

// Whether reading the source is still worth doing. Once the operating system
// holds the boundary the patterns below stop protecting anyone — they only
// reject ordinary code that happens to say `os.environ` — so the screen steps
// aside for the sandbox. `always` keeps both, `off` keeps neither.
fn screen_applies(lang: &str) -> bool {
    match std::env::var("HILBERT_CODE_SCREEN").ok().as_deref().map(str::trim) {
        Some("always") | Some("strict") => true,
        Some("off") | Some("none") => false,
        // Wolfram is not confined at all — see sandbox::confines — so the screen
        // is still the only thing guarding it and stays on.
        _ => !sandbox::active().real() || !sandbox::confines(lang),
    }
}

fn screen_code(lang: &str, code: &str) -> Option<String> {
    if !screen_applies(lang) {
        return None;
    }
    screen_source(lang, code)
}

fn screen_source(lang: &str, code: &str) -> Option<String> {
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
        if let Ok(meta) = entry.metadata()
            && let Ok(t) = meta.modified()
        {
            m.insert(name, epoch_ms(t));
        }
    }
    m
}

// Reserved per-workspace scratch dir. Compile output and code-exec scratch live
// here (hidden, since it's a dotfile), so they never clutter the user's files —
// and it's the future home for per-workspace settings and logs.
fn hilbert_dir(ws: &Path) -> PathBuf { ws.join(".hilbert") }
// Where typst writes the list of files the document is built from.
fn deps_path(ws: &Path) -> PathBuf { hilbert_dir(ws).join("deps.make") }

fn main_deps_path(ws: &Path, main: &Path) -> PathBuf {
    let main = main.strip_prefix(ws).unwrap_or(main);
    // Frontend paths use '/', including on Windows; disk paths may use '\\'.
    let key = main.components().map(|part| part.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
    let id = Sha256::digest(key.as_bytes());
    let id: String = id[..12].iter().map(|byte| format!("{byte:02x}")).collect();
    hilbert_dir(ws).join(format!("deps-{id}.make"))
}

async fn last_preview(State(st): St) -> Response {
    let ws = st.ws();
    let paths = [st.preview_path(&ws, false), st.preview_path(&ws, true)];
    let bytes = tokio::task::spawn_blocking(move || {
        let path = paths.into_iter().filter_map(|path| {
            let stamp = fs::metadata(&path).and_then(|m| m.modified()).ok()?;
            Some((stamp, path))
        }).max_by_key(|(stamp, _)| *stamp);
        path.and_then(|(_, path)| read_file_limited(&path, MAX_PDF_PREVIEW_BYTES).ok().flatten())
    }).await.unwrap_or(None);
    match bytes {
        Some(bytes) => ([(header::CONTENT_TYPE, "application/pdf")], bytes).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
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
// A figure name has to be a plain file sitting in the run directory. This
// matters because the notebook harness reports what it produced on stdout, and
// stdout is whatever the cell decided to print: a cell can read its own harness
// script, learn the sentinel, and then print a line naming any path on the
// machine. Without this check that line would move that file into assets/.
fn safe_image_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('.')
        && !name.contains(['/', '\\', '\0'])
        && Path::new(name).components().count() == 1
        &&
    {
        let lower = name.to_lowercase();
        IMAGE_EXT.iter().any(|ext| lower.ends_with(ext))
    }
}

fn promote_images(ws: &Path, run_dir: &Path, names: &[String]) -> Vec<String> {
    if names.is_empty() { return Vec::new(); }
    let assets = ws.join("assets");
    let _ = fs::create_dir_all(&assets);
    let mut out = Vec::new();
    for name in names.iter().filter(|name| safe_image_name(name)) {
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

// One run at a time, server-wide. On a shared workspace that means queueing
// behind somebody else's notebook, which is fine — waiting forever is not. The
// request holds a connection open the whole time and the person in front of it
// has no way to tell whether anything is happening, so give up and say so.
const EXEC_QUEUE_WAIT: Duration = Duration::from_secs(120);

async fn exec_permit(st: &AppState) -> Result<tokio::sync::SemaphorePermit<'_>, Response> {
    match tokio::time::timeout(EXEC_QUEUE_WAIT, st.exec_gate.acquire()).await {
        Ok(Ok(permit)) => Ok(permit),
        Ok(Err(_)) => Err(json_err(StatusCode::SERVICE_UNAVAILABLE, "Code runner is shutting down.")),
        Err(_) => Err(json_err(
            StatusCode::SERVICE_UNAVAILABLE,
            "Another run is still going and this one waited two minutes for its turn. Try again once it finishes.",
        )),
    }
}

async fn run_code(State(st): St, body: Bytes) -> Response {
    static CONNECTING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Connecting….*?\n").unwrap());
    if let Some(reason) = st.exec_refusal() {
        return json_err(StatusCode::FORBIDDEN, reason);
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
    let _permit = match exec_permit(&st).await {
        Ok(permit) => permit,
        Err(response) => return response,
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
    let out = match run_exec_cmd(&chosen.path, &args, &sandbox, Some(st.exec_timeout_ms), lang).await {
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
SEP = "__SEP__"; SENT = "__SENT__"; FMT = "__FMT__"
EXTS = (".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp", ".pdf", ".eps")
src = open("nb_cells.txt", encoding="utf-8").read()
cells = src.split("\n" + SEP + "\n") if src else []
g = {"__name__": "__main__"}
real = sys.__stdout__
def _pngs(): return {f: os.path.getmtime(f) for f in os.listdir(".") if f.lower().endswith(EXTS)}
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
            fig = plt.gcf()
            # Typst has no EPS reader, so an EPS run writes the PDF as well and
            # the document embeds that one; the EPS is there to hand to a journal.
            for ext in (("eps", "pdf") if FMT == "eps" else (FMT,)):
                p = "nb_cell%d.%s" % (i, ext)
                fig.savefig(p, dpi=130, bbox_inches="tight")
                imgs.append(p)
            plt.close("all")
    except Exception:
        pass
    after = _pngs()
    for f in sorted(after):
        if f not in imgs and (f not in before or after[f] != before[f]): imgs.append(f)
    real.write("%s\t%d\t%s\t%s\t%s\n" % (SENT, i, _b(buf.getvalue()), _b(err), ",".join(imgs))); real.flush()
"#;

const NB_JL: &str = r#"using Base64
SEP = "__SEP__"; SENT = "__SENT__"; FMT = "__FMT__"
EXTS = (".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp", ".pdf", ".eps")
MIMES = Dict("png" => "image/png", "svg" => "image/svg+xml", "pdf" => "application/pdf", "eps" => "image/eps")
src = read("nb_cells.txt", String)
cells = isempty(src) ? String[] : split(src, "\n" * SEP * "\n")
real = stdout
pngs() = Dict(f => mtime(f) for f in filter(x->any(e->endswith(lowercase(x), e), EXTS), readdir(".")))

# Write a displayable value — a plot — to `file` in the format `ext` names.
# Backends disagree about which MIME types they answer to, so ask for the MIME
# first and fall back to Plots' filename-driven savefig, which dispatches on the
# extension instead. invokelatest throughout for the same world-age reason as
# below. Returns whether anything actually landed on disk.
function write_figure(val, file, ext)
    mime = get(MIMES, ext, "image/png")
    try
        if Base.invokelatest(showable, mime, val)
            open(file, "w") do io
                Base.invokelatest(show, io, mime, val)
            end
            isfile(file) && filesize(file) > 0 && return true
        end
    catch
    end
    if isdefined(Main, :savefig)
        try
            Base.invokelatest(getfield(Main, :savefig), val, file)
            isfile(file) && filesize(file) > 0 && return true
        catch
        end
    end
    false
end

# `plot(x; fmt = :pdf)` is Plots asking for a format in the code itself, which is
# more specific than the app-wide setting, so it wins. Plots files that request
# under :html_output_format; anything else, or an unset :auto, leaves the
# setting in charge.
function wanted_format(val, fallback)
    try
        f = String(Base.invokelatest(get, getfield(val, :attr), :html_output_format, :auto))
        f in ("png", "svg", "pdf", "eps") && return f
    catch
    end
    fallback
end
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
                    # A displayable value (a plot) is written to a file so the
                    # notebook shows it as an image; anything else echoes as text.
                    # Typst has no EPS reader, so an EPS run writes the PDF as
                    # well and the document embeds that one; the EPS is there to
                    # hand to a journal. Whether the EPS appears at all is up to
                    # the backend — GR, which Plots uses by default, has no EPS
                    # writer, while PyPlot does.
                    if Base.invokelatest(showable, "image/png", val)
                        wrote = false
                        fmt = wanted_format(val, FMT)
                        for ext in (fmt == "eps" ? ("eps", "pdf") : (fmt,))
                            wrote |= write_figure(val, "nb_plot_$(i).$(ext)", ext)
                        end
                        # Whatever the backend can manage beats no figure at all.
                        wrote || write_figure(val, "nb_plot_$i.png", "png")
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
    if let Some(reason) = st.exec_refusal() {
        return json_err(StatusCode::FORBIDDEN, reason);
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
    let _permit = match exec_permit(&st).await {
        Ok(permit) => permit,
        Err(response) => return response,
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
    let script = harness
        .replace("__SEP__", &sep)
        .replace("__SENT__", &sent)
        .replace("__FMT__", plot_format(&v));
    if fs::write(sandbox.join(script_name), script).is_err() {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not write notebook harness.");
    }

    let args: Vec<&str> = match lang {
        "julia" => vec!["--startup-file=no", "-q", script_name],
        _ => vec![script_name],
    };
    // One process runs every cell, so give it room proportional to cell count.
    let timeout = st.exec_timeout_ms.saturating_mul(cells.len() as u64).min(600_000);
    let out = match run_exec_cmd(&chosen.path, &args, &sandbox, Some(timeout), lang).await {
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
    if cached.exists()
        && let Ok(bytes) = fs::read(&cached)
    {
        return ([(header::CONTENT_TYPE, "image/png")], bytes).into_response();
    }

    let Ok(dir) = unique_temp_dir(&format!("typst-tpl-{name}")) else {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not create a scratch directory.");
    };
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

    let Ok(dir) = unique_temp_dir(&format!("typst-editor-bp-{key}")) else {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not create a scratch directory.");
    };
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
    let Ok(dir) = unique_temp_dir(&format!("typst-pkg-{name}")) else {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not create a scratch directory.");
    };
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
    LazyLock::new(|| {
        use_ring();
        reqwest::Client::builder().no_proxy().build().unwrap()
    });

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

async fn desktop_open(State(st): St, body: Bytes) -> Response {
    // "Open this link" means the machine running the browser, not the machine
    // running the server. Honouring it in a hosted session would let anyone
    // signed in make the server fetch a URL of their choosing, or pop a window
    // on somebody's console; the browser opens its own links perfectly well.
    if st.remote_mode() {
        return json_err(StatusCode::NOT_IMPLEMENTED, "Opening links is unavailable in a hosted browser session.");
    }
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

fn login_page() -> Response {
    const PAGE: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hilbert server sign in</title><style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1117;color:#e6e9ef;font:15px/1.5 system-ui,sans-serif}.card{width:min(420px,calc(100vw - 32px));padding:28px;border:1px solid #303642;border-radius:12px;background:#171a22;box-shadow:0 18px 60px #0006}h1{margin:0 0 8px;font-size:21px}p{margin:0 0 20px;color:#aab2c0}label{display:block;margin-bottom:7px;font-weight:600}input{width:100%;padding:11px 12px;border:1px solid #3b4352;border-radius:7px;background:#0f1117;color:inherit;font:inherit}button{width:100%;margin-top:14px;padding:11px;border:0;border-radius:7px;background:#7c6df2;color:white;font:700 14px system-ui;cursor:pointer}small{display:block;margin-top:16px;color:#778092}
</style></head><body><main class="card"><h1>Hilbert hosted workspace</h1><p>Enter the access token configured on this server.</p><form method="post" action="/auth/login"><input name="username" value="hilbert" autocomplete="username" hidden><label for="token">Access token</label><input id="token" name="token" type="password" minlength="32" required autofocus autocomplete="current-password"><button type="submit">Open workspace</button></form><small>The token stays in this sign-in request. The browser receives a private session cookie.</small></main></body></html>"#;
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::CONTENT_SECURITY_POLICY, "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        PAGE,
    )
        .into_response()
}

async fn static_fallback(State(st): St, headers: HeaderMap, method: Method, uri: Uri) -> Response {
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
    // SPA fallback: any GET path without a dot serves the app shell. Hosted
    // mode never sends the application shell until the browser has signed in;
    // static hashed assets contain no workspace data and may remain cacheable.
    if !decoded.contains('.') {
        if st.remote_mode() && !valid_request_auth(&st, &headers) {
            return login_page();
        }
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

fn hostname_of(host: &str) -> &str {
    host.rsplit_once(':').map(|(name, _)| name).unwrap_or(host)
}

fn local_host(host: &str) -> bool {
    let hostname = hostname_of(host);
    hostname == "127.0.0.1" || hostname == "localhost"
}

// A hosted server normally accepts whatever name it was reached by, because it
// has no way to know which one the proxy in front of it publishes. Telling it
// (HILBERT_PUBLIC_HOST) closes the gap: a request arriving under some other name
// is one that was routed here by something other than the intended front door.
// Loopback stays allowed regardless, so health checks on the box keep working.
fn public_host_allowed(expected: Option<&str>, host: &str) -> bool {
    match expected {
        Some(expected) => hostname_of(host).eq_ignore_ascii_case(expected) || local_host(host),
        None => true,
    }
}

fn origin_allowed(host: &str, origin: &str) -> bool {
    origin == format!("http://{host}")
        || origin == format!("https://{host}")
        || (cfg!(debug_assertions) && DEV_ORIGIN_RE.is_match(origin))
}

// Defence beyond binding to loopback: reject requests whose Host header isn't
// local (DNS-rebinding — a hostile domain resolving to 127.0.0.1 to reach this
// server from a victim's browser) and any browser request carrying a foreign
// Origin (drive-by websites POSTing to localhost; browsers always attach
// Origin to cross-site POSTs, and "simple" ones skip the CORS preflight).
async fn request_guard(State(st): St, req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    let Some(host) = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()) else {
        return (StatusCode::FORBIDDEN, "Forbidden: missing Host").into_response();
    };
    if st.remote_mode() {
        if !public_host_allowed(st.public_host.as_deref(), host) {
            return (StatusCode::FORBIDDEN, "Forbidden: unexpected Host").into_response();
        }
    } else if !local_host(host) {
        return (StatusCode::FORBIDDEN, "Forbidden: non-local Host").into_response();
    }
    if let Some(origin) = req.headers().get(header::ORIGIN).and_then(|h| h.to_str().ok()) {
        // Chromium can give a no-script password form an opaque `null` origin
        // under a restrictive CSP. Permit that only for the hosted sign-in
        // endpoint; the 32+ character secret is still checked, and the session
        // cookie is SameSite=Strict. Every workspace/API request continues to
        // require an exact same-origin value.
        let opaque_hosted_login = st.remote_mode()
            && origin == "null"
            && req.uri().path() == "/auth/login";
        if !opaque_hosted_login && !origin_allowed(host, origin) {
            return (StatusCode::FORBIDDEN, "Forbidden: cross-site request").into_response();
        }
    }
    next.run(req).await
}

fn constant_time_eq(candidate: &str, expected: &str) -> bool {
    let candidate = candidate.as_bytes();
    let expected = expected.as_bytes();
    let mut difference = candidate.len() ^ expected.len();
    for i in 0..candidate.len().max(expected.len()) {
        difference |= usize::from(candidate.get(i).copied().unwrap_or(0) ^ expected.get(i).copied().unwrap_or(0));
    }
    difference == 0
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
}

fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| cookies.split(';').map(str::trim).find_map(|cookie| cookie.strip_prefix("hilbert_session=")))
}

// Two ways in, and they are not the same credential. The bearer token is the
// desktop shell and the local API talking to their own backend. The cookie is a
// browser that signed in to a hosted workspace, and it carries a signed session
// rather than the token itself.
fn valid_request_auth(st: &AppState, headers: &HeaderMap) -> bool {
    if let Some(candidate) = bearer_token(headers)
        && constant_time_eq(candidate, &st.api_token)
    {
        return true;
    }
    match (&st.sessions, session_cookie(headers)) {
        (Some(sessions), Some(candidate)) => sessions.verify(candidate),
        // Outside hosted mode the cookie is how the desktop webview carries the
        // same local token it would otherwise put in a header.
        (None, Some(candidate)) => constant_time_eq(candidate, &st.api_token),
        _ => false,
    }
}

async fn auth_guard(State(st): St, req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    if !valid_request_auth(&st, req.headers()) {
        return (StatusCode::UNAUTHORIZED, "Unauthorized").into_response();
    }
    next.run(req).await
}

// Guessing a 32-character secret over HTTP is not a realistic attack, but an
// endpoint that answers wrong passwords as fast as it can is an invitation to
// try. Each failure slows the next one down, server-wide — deliberately not
// per-IP, because the address a request claims to come from is a header a
// determined guesser would simply vary. There is no lockout: a wrong password
// must never be a way to stop the real user signing in.
static LOGIN_FAILURES: LazyLock<Mutex<(Instant, u32)>> =
    LazyLock::new(|| Mutex::new((Instant::now(), 0)));
const LOGIN_FAILURE_WINDOW: Duration = Duration::from_secs(300);
const LOGIN_MAX_DELAY: Duration = Duration::from_millis(2000);

fn record_login_failure() -> Duration {
    let mut state = LOGIN_FAILURES.lock().unwrap_or_else(|e| e.into_inner());
    if state.0.elapsed() > LOGIN_FAILURE_WINDOW {
        *state = (Instant::now(), 0);
    }
    state.1 = state.1.saturating_add(1);
    LOGIN_MAX_DELAY.min(Duration::from_millis(150) * state.1)
}

fn clear_login_failures() {
    let mut state = LOGIN_FAILURES.lock().unwrap_or_else(|e| e.into_inner());
    *state = (Instant::now(), 0);
}

async fn remote_login(State(st): St, headers: HeaderMap, body: Bytes) -> Response {
    let (Some(expected), Some(sessions)) = (st.remote_access_token.as_deref(), st.sessions.as_ref()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let encoded = String::from_utf8_lossy(&body);
    let candidate = encoded
        .split('&')
        .find_map(|field| field.strip_prefix("token="))
        .map(|value| percent_decode_str(&value.replace('+', " ")).decode_utf8_lossy().into_owned())
        .unwrap_or_default();
    if !constant_time_eq(&candidate, expected) {
        let delay = record_login_failure();
        note(format!("hosted sign-in rejected; next attempt delayed {} ms", delay.as_millis()));
        tokio::time::sleep(delay).await;
        return (StatusCode::UNAUTHORIZED, "Invalid access token").into_response();
    }
    clear_login_failures();
    (
        StatusCode::SEE_OTHER,
        [
            (header::SET_COOKIE, session_cookie_header(&st, sessions.issue(), Some(sessions.lifetime), &headers)),
            (header::LOCATION, "/".to_string()),
        ],
    )
        .into_response()
}

// One place decides what the cookie looks like, so signing out cannot
// accidentally write a differently-scoped cookie that the browser keeps
// alongside the real one instead of replacing it.
fn session_cookie_header(st: &AppState, value: String, max_age: Option<Duration>, headers: &HeaderMap) -> String {
    let _ = st;
    // Behind a proxy this is how the app learns the visitor arrived over TLS;
    // marking the cookie Secure on a plain-HTTP connection would make the
    // browser drop it and the sign-in would appear to do nothing.
    let secure = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.eq_ignore_ascii_case("https"))
        .unwrap_or(false);
    let age = match max_age {
        Some(age) => format!("; Max-Age={}", age.as_secs()),
        None => "; Max-Age=0".to_string(),
    };
    format!(
        "hilbert_session={value}; HttpOnly; SameSite=Strict; Path=/{age}{}",
        if secure { "; Secure" } else { "" },
    )
}

async fn remote_logout(State(st): St, headers: HeaderMap) -> Response {
    if st.sessions.is_none() {
        return StatusCode::NOT_FOUND.into_response();
    }
    (
        StatusCode::SEE_OTHER,
        [
            (header::SET_COOKIE, session_cookie_header(&st, String::new(), None, &headers)),
            (header::LOCATION, "/".to_string()),
        ],
    )
        .into_response()
}

// Sign everybody out — the answer to a laptop left on a train, when changing the
// server's token and telling everyone the new one is more disruption than the
// situation needs.
async fn remote_revoke_sessions(State(st): St, headers: HeaderMap) -> Response {
    let Some(sessions) = st.sessions.as_ref() else {
        return json_err(StatusCode::NOT_FOUND, "This server has no browser sessions to end.");
    };
    let generation = sessions.revoke_all();
    note(format!("hosted sessions revoked; generation is now {generation}"));
    // Including the caller, who gets a fresh one in the same response rather
    // than being bounced back to the sign-in page for using the button.
    (
        StatusCode::OK,
        [(header::SET_COOKIE, session_cookie_header(&st, sessions.issue(), Some(sessions.lifetime), &headers))],
        Json(json!({ "ok": true, "generation": generation })),
    )
        .into_response()
}

async fn hosted_info(State(st): St) -> Response {
    match (&st.remote_collab_room, &st.remote_collab_key) {
        (Some(room), Some(key)) => {
            let mut claims = HOSTED_CLAIMS.lock().unwrap_or_else(|e| e.into_inner());
            let expired = claims
                .get(room)
                .map(|claim| !claim.active && claim.claimed_at.elapsed() >= Duration::from_secs(15))
                .unwrap_or(true);
            let mode = if expired {
                claims.insert(room.clone(), HostedClaim { claimed_at: Instant::now(), active: false });
                "host"
            } else {
                "join"
            };
            Json(json!({
                "hosted": true,
                "mode": mode,
                "room": room,
                "key": key,
                "workspace": st.ws().file_name().map(|name| name.to_string_lossy().into_owned()),
            }))
            .into_response()
        }
        _ => Json(json!({ "hosted": false })).into_response(),
    }
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
    /// The file tinymist is treating as the document's entrypoint, if any.
    /// Kept so the command is only sent when the answer actually changes.
    pinned: Option<PathBuf>,
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

// winget keeps a portable package's real executable under Packages/, and puts a
// shim named after the command in Links/. The shim is a symlink, so it only gets
// made when the install had permission to create one — without Developer Mode
// and outside an elevated prompt it can be skipped, leaving a perfectly good
// tinymist that nothing on PATH can reach. It also keeps the name it was
// released under (tinymist-win32-x64.exe), so look for the package folder first
// and take whatever executable is inside.
// Split out from the lookup below so it can be tested anywhere: nothing about
// walking the folder is Windows-specific except where the folder lives.
#[cfg(any(windows, test))]
fn tinymist_under(packages: &Path) -> Option<PathBuf> {
    fs::read_dir(packages)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| dir_name(path).to_ascii_lowercase().contains("tinymist"))
        .flat_map(|path| fs::read_dir(path).into_iter().flatten().flatten())
        .map(|entry| entry.path())
        .find(|path| {
            let name = dir_name(path).to_ascii_lowercase();
            name.starts_with("tinymist") && name.ends_with(".exe") && path.is_file()
        })
}

#[cfg(windows)]
fn winget_tinymist() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    tinymist_under(&local.join("Microsoft").join("WinGet").join("Packages"))
}

#[cfg(not(windows))]
fn winget_tinymist() -> Option<PathBuf> {
    None
}

// Resolution order is deterministic: an explicit/bundled override, a binary
// managed under Hilbert's config directory, the user's PATH, and finally the
// place winget leaves one when it couldn't add it to PATH itself.
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
    if let Some(path) = which("tinymist") {
        return Some(TinymistBinary { path, source: "path" });
    }
    winget_tinymist().map(|path| TinymistBinary { path: path.to_string_lossy().into_owned(), source: "winget" })
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
        pinned: None,
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
    // The first ever start is far slower than the ones after it: tinymist has to
    // be paged in and scanned before it runs at all. A clean Windows runner with
    // nothing competing for the disk took 3.3 s to answer, against 40 ms once
    // warm, and a real machine with antivirus watching a freshly downloaded
    // binary has every reason to take longer still. The old five second budget
    // sat close enough to that to lose the race, and losing it killed the
    // process — so the next attempt started cold and lost in exactly the same
    // way, for good. Tinymist looked broken while running perfectly.
    //
    // Nothing waits on this but the request that triggered it, and diagnostics
    // arriving late is a great deal better than never arriving.
    let init = match tokio::time::timeout(Duration::from_secs(30), rx).await {
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

impl LspProxy {
    /// Tell tinymist which file is the document's entrypoint, or `None` to let
    /// it read each file on its own again.
    ///
    /// Without this, a chapter opened on its own is compiled on its own, and
    /// every `@label` and `@citation` living in another file of the same
    /// document is reported as missing. The chapter is fine; it is the question
    /// that was wrong.
    async fn pin_main(&mut self, main: Option<&Path>) {
        if self.pinned.as_deref() == main {
            return;
        }
        let argument = match main {
            Some(path) => json!(path.to_string_lossy()),
            None => Value::Null,
        };
        // Sent without waiting for the reply. Every request here is made while
        // the map of language servers is locked, and there is nothing in the
        // reply to act on anyway — a refusal comes back as the same null the
        // acceptance does.
        drop(
            self.begin_request("workspace/executeCommand", json!({
                "command": "tinymist.pinMain",
                "arguments": [argument],
            }))
            .await,
        );
        self.pinned = main.map(Path::to_path_buf);
    }
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
    let path = path_from_file_uri(uri)?;
    path.strip_prefix(ws)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
}

fn path_from_file_uri(uri: &str) -> Option<PathBuf> {
    let raw = uri.strip_prefix("file://")?;
    let decoded = percent_decode_str(raw).decode_utf8().ok()?;
    #[cfg(windows)]
    let path = decoded.strip_prefix('/').unwrap_or(decoded.as_ref());
    #[cfg(not(windows))]
    let path = decoded.as_ref();
    Some(PathBuf::from(path))
}

/// The files the compiled document is built from, as workspace-relative paths.
///
/// Typst writes them in Make's format — `out.pdf: a.typ b.bib` — where a space
/// inside a path is backslash-escaped and a `$` is doubled. Anything outside the
/// workspace (a package from the cache) is left out; the question this answers
/// is only ever about files the editor can open.
fn project_files(ws: &Path, main: &str) -> Arc<HashSet<String>> {
    // Asked on every diagnostics request, which is every pause in typing, and
    // the answer only changes when typst recompiles. Keyed on the file's write
    // time so a recompile is picked up and nothing else costs a read.
    static CACHE: LazyLock<Mutex<HashMap<PathBuf, (Option<SystemTime>, Arc<HashSet<String>>)>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    let path = if main.is_empty() { deps_path(ws) } else { main_deps_path(ws, Path::new(main)) };
    let stamp = fs::metadata(&path).and_then(|m| m.modified()).ok();
    if let Some(hit) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&path)
        && hit.0 == stamp
    {
        return hit.1.clone();
    }
    let files = Arc::new(read_project_files(ws, &path));
    CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(path, (stamp, files.clone()));
    files
}

fn read_project_files(ws: &Path, deps: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    let Ok(text) = fs::read_to_string(deps) else { return out };
    for (index, token) in make_tokens(&text).into_iter().enumerate() {
        // The first token is the target — the PDF — and carries the colon.
        if index == 0 && token.ends_with(':') {
            continue;
        }
        let path = PathBuf::from(&token);
        let relative = if path.is_absolute() {
            match path.strip_prefix(ws) {
                Ok(rest) => rest.to_path_buf(),
                Err(_) => continue, // a package, or something outside the project
            }
        } else {
            path
        };
        let name = relative.to_string_lossy().replace('\\', "/");
        if !name.is_empty() {
            out.insert(name);
        }
    }
    out
}

/// Split a Make dependency line into paths, honouring its escapes.
fn make_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            // A backslash escapes a space or another backslash; at the end of a
            // line it is Make's line continuation and the newline goes with it.
            '\\' => match chars.next() {
                Some('\n') => {}
                Some(next) => current.push(next),
                None => {}
            },
            // `$$` is how Make spells a literal dollar.
            '$' if chars.peek() == Some(&'$') => {
                chars.next();
                current.push('$');
            }
            c if c.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[cfg(test)]
mod label_graph_tests {
    use super::*;

    fn graph_of(source: &str) -> Value {
        let dir = unique_temp_dir("hilbert-labels-test").unwrap();
        let ws = dir.join("project");
        fs::create_dir_all(&ws).unwrap();
        fs::write(ws.join("main.typ"), source).unwrap();
        let graph = read_label_graph(&ws, "main.typ");
        let _ = fs::remove_dir_all(&dir);
        graph
    }
    fn ids(graph: &Value, key: &str) -> Vec<String> {
        graph[key].as_array().unwrap().iter()
            .map(|n| n["id"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn a_reference_belongs_to_the_section_it_appears_in() {
        // The obvious rule — attribute a reference to the nearest label above it
        // — is wrong, because a label is discussed in the paragraphs directly
        // beneath it and every reference then points at itself.
        let graph = graph_of("\
= First

$ a = b $ <eq:one>

As @eq:one shows, this follows.

= Second

And @eq:one again.
");
        let edges = graph["edges"].as_array().unwrap();
        assert_eq!(edges.len(), 2, "one edge per section that refers to it: {edges:?}");
        assert!(edges.iter().all(|e| e["to"] == "eq:one"));
        let sections: Vec<&str> = graph["nodes"].as_array().unwrap().iter()
            .filter(|n| n["kind"] == "section")
            .map(|n| n["title"].as_str().unwrap()).collect();
        assert!(sections.contains(&"First") && sections.contains(&"Second"), "got {sections:?}");

        let one = graph["nodes"].as_array().unwrap().iter()
            .find(|n| n["id"] == "eq:one").unwrap();
        assert_eq!(one["referenced"], 2);
    }

    #[test]
    fn punctuation_after_a_reference_is_not_part_of_the_name() {
        // `@eq:one.` ends a sentence; the full stop is not in the label.
        let graph = graph_of("= S\n\n$ a $ <eq:one>\n\nSee @eq:one. And @eq:one:\n");
        assert!(graph["missing"].as_array().unwrap().is_empty(),
            "nothing should look broken: {:?}", graph["missing"]);
        let one = graph["nodes"].as_array().unwrap().iter()
            .find(|n| n["id"] == "eq:one").unwrap();
        assert_eq!(one["referenced"], 2);
    }

    #[test]
    fn a_reference_to_nothing_is_reported() {
        let graph = graph_of("= S\n\nSee @eq:missing for details.\n");
        let missing = graph["missing"].as_array().unwrap();
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0]["id"], "eq:missing");
        assert_eq!(missing[0]["line"], 3);
    }

    #[test]
    fn code_comments_and_strings_are_not_prose() {
        // Every one of these looks like a label or a reference and is not one.
        let graph = graph_of("\
= S

#import \"@preview/cetz:0.3.0\"
// a comment mentioning @eq:ghost and <eq:phantom>
Inline `@eq:raw` and \"@eq:instring\" are code, not references.

$ a $ <eq:real>

But @eq:real is.
");
        assert_eq!(ids(&graph, "nodes").iter().filter(|id| id.starts_with("eq:")).count(), 1,
            "only the real label: {:?}", ids(&graph, "nodes"));
        assert!(graph["missing"].as_array().unwrap().is_empty(),
            "nothing invented: {:?}", graph["missing"]);
        let real = graph["nodes"].as_array().unwrap().iter()
            .find(|n| n["id"] == "eq:real").unwrap();
        assert_eq!(real["referenced"], 1);
    }

    #[test]
    fn the_same_reference_twice_is_one_edge_that_counts_two() {
        let graph = graph_of("= S\n\n$ a $ <eq:one>\n\n@eq:one and @eq:one again.\n");
        let edges = graph["edges"].as_array().unwrap();
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0]["uses"], 2);
    }

    #[test]
    fn a_label_defined_twice_is_counted_once_and_flagged() {
        let graph = graph_of("= S\n\n$ a $ <eq:one>\n\n$ b $ <eq:one>\n");
        let nodes: Vec<&Value> = graph["nodes"].as_array().unwrap().iter()
            .filter(|n| n["id"] == "eq:one").collect();
        assert_eq!(nodes.len(), 1, "drawn once");
        assert_eq!(nodes[0]["defined"], 2, "and known to be defined twice");
    }
}

#[cfg(test)]
mod dependency_list_tests {
    use super::*;

    #[tokio::test]
    async fn queued_proofreading_skips_superseded_text() {
        let dir = unique_temp_dir("hilbert-lint-queue-test").unwrap();
        let state = Arc::new(AppState::new(dir.clone(), None));
        let reached = |want: u64| {
            let state = state.clone();
            async move {
                tokio::time::timeout(Duration::from_secs(5), async {
                    while state.lint_generation.load(Ordering::Acquire) < want { tokio::task::yield_now().await; }
                }).await.unwrap();
            }
        };
        // Held so both passes below are still queued when the assertions run.
        let permit = LINT_GATE.clone().acquire_owned().await.unwrap();

        let old_state = state.clone();
        let old = tokio::spawn(async move {
            lint_text(State(old_state), Bytes::from_static(br#"{"text":"Outdated text."}"#)).await
        });
        reached(1).await;

        // Asking whether proofreading exists is not a newer piece of work. If it
        // counted as one, toggling the feature while a long document was queued
        // would answer that queued pass with a conflict, and the editor reads a
        // failed lint as "this build has no proofreading" and switches it off.
        let probe = lint_text(State(state.clone()), Bytes::from_static(br#"{"text":"   "}"#)).await;
        assert_eq!(probe.status(), StatusCode::OK);
        assert_eq!(state.lint_generation.load(Ordering::Acquire), 1, "a probe must not supersede queued work");

        let new_state = state.clone();
        let fresh = tokio::spawn(async move {
            lint_text(State(new_state), Bytes::from_static(br#"{"text":"Fresh text."}"#)).await
        });
        reached(2).await;

        drop(permit);
        assert_eq!(old.await.unwrap().status(), StatusCode::CONFLICT);
        assert_eq!(fresh.await.unwrap().status(), StatusCode::OK);
        release_workspace_user(&dir);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn window_previews_and_entry_dependencies_are_isolated() {
        let dir = unique_temp_dir("hilbert-window-preview-test").unwrap();
        let mut first = AppState::new(dir.clone(), None);
        first.session_file = dir.join("first-session.json");
        let mut second = AppState::new(dir.clone(), None);
        second.session_file = dir.join("second-session.json");
        assert_ne!(first.preview_path(&dir, false), second.preview_path(&dir, false));
        assert_ne!(first.preview_path(&dir, false), first.preview_path(&dir, true));
        assert_eq!(main_deps_path(&dir, &dir.join("main.typ")), main_deps_path(&dir, Path::new("main.typ")));
        assert_eq!(main_deps_path(&dir, &dir.join("chapters").join("one.typ")), main_deps_path(&dir, Path::new("chapters/one.typ")));
        fs::create_dir_all(hilbert_dir(&dir)).unwrap();
        fs::write(main_deps_path(&dir, Path::new("main.typ")), "preview.pdf: main.typ chapter.typ\n").unwrap();
        fs::write(main_deps_path(&dir, Path::new("slides.typ")), "preview.pdf: slides.typ figures.typ\n").unwrap();
        assert!(project_files(&dir, "main.typ").contains("chapter.typ"));
        assert!(!project_files(&dir, "main.typ").contains("figures.typ"));
        assert!(project_files(&dir, "slides.typ").contains("figures.typ"));
        release_workspace_user(&dir);
        release_workspace_user(&dir);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_the_paths_out_of_a_make_dependency_line() {
        let dir = unique_temp_dir("hilbert-deps-test").unwrap();
        let ws = dir.join("project");
        fs::create_dir_all(hilbert_dir(&ws)).unwrap();

        // What typst writes: the target first, carrying the colon, then the
        // files. A space in a path is escaped, a dollar is doubled, and a long
        // list is broken across lines with a trailing backslash.
        let line = format!(
            "out.pdf: main.typ chapters/one\\ two.typ \\\n  refs.bib money$$.typ {}\n",
            ws.join("assets/logo.svg").display(),
        );
        fs::write(deps_path(&ws), line).unwrap();

        let files = project_files(&ws, "");
        for expected in ["main.typ", "chapters/one two.typ", "refs.bib", "money$.typ", "assets/logo.svg"] {
            assert!(files.contains(expected), "missing {expected:?} in {files:?}");
        }
        // The PDF it produced is not one of the document's sources.
        assert!(!files.iter().any(|f| f.ends_with(".pdf")), "the target leaked in: {files:?}");
        assert_eq!(files.len(), 5, "unexpected extras: {files:?}");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_package_outside_the_workspace_is_not_a_project_file() {
        let dir = unique_temp_dir("hilbert-deps-outside").unwrap();
        let ws = dir.join("project");
        fs::create_dir_all(hilbert_dir(&ws)).unwrap();
        fs::write(
            deps_path(&ws),
            "out.pdf: main.typ /opt/typst-packages/preview/cetz/0.3.0/lib.typ\n",
        )
        .unwrap();

        let files = project_files(&ws, "");
        assert_eq!(*files, HashSet::from(["main.typ".to_string()]), "got {files:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_compile_yet_means_no_claims_about_the_project() {
        let dir = unique_temp_dir("hilbert-deps-empty").unwrap();
        assert!(project_files(&dir.join("project"), "").is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}

// Whether two file: URIs name the same file. tinymist doesn't echo back the URI
// it was given — it republishes under a form of its own, and only on Unix does
// that happen to be the string we sent. On Windows the two can differ by the
// case of the drive letter, by `\\?\`, or by `%3A` against a literal colon, any
// one of which turns an exact string lookup into a permanent miss: tinymist runs
// fine, answers every request, and the editor still shows nothing. Comparing the
// paths the URIs decode to costs nothing and doesn't care which form won.
fn same_file_uri(a: &str, b: &Path) -> bool {
    let Some(left) = path_from_file_uri(a) else { return false };
    if left == b {
        return true;
    }
    // Asking the filesystem settles every way the two spellings can differ at
    // once — drive letter case, `\\?\`, symlinked parents, `.` and `..` — and
    // both sides name a file that exists, so it nearly always answers.
    if let (Ok(left), Ok(right)) = (fs::canonicalize(&left), fs::canonicalize(b)) {
        return left == right;
    }
    if cfg!(windows) {
        left.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        false
    }
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

// `tinymist --version` leads with the bare name and puts the details on the
// lines after it, so taking the first line alone leaves the settings panel
// reading "tinymist ·" with an empty space where the version belongs. Some
// builds don't carry a version on that line at all; the Typst version they were
// built against is still worth showing, and is what tells two builds apart.
fn tinymist_version(output: &str) -> String {
    let mut lines = output.lines().map(str::trim).filter(|line| !line.is_empty());
    let first = lines.next().unwrap_or("").to_string();
    if first.chars().any(|c| c.is_ascii_digit()) {
        return first;
    }
    let typst = output
        .lines()
        .find_map(|line| line.trim().strip_prefix("Typst Version:"))
        .map(str::trim)
        .filter(|value| !value.is_empty());
    match typst {
        Some(typst) if first.is_empty() => format!("tinymist (Typst {typst})"),
        Some(typst) => format!("{first} (Typst {typst})"),
        None => first,
    }
}

// Everything someone would otherwise have to be talked through gathering over
// several messages, in one block they can paste into a bug report.
async fn diagnostics(State(st): St) -> Response {
    let mut lines = vec![
        format!("Hilbert {} on {}", env!("CARGO_PKG_VERSION"), std::env::consts::OS),
        format!("workspace: {}", st.ws().display()),
        format!("log file:  {} (times below are UTC)", log_path().display()),
    ];
    match run_cmd("typst", &["--version"], None, Some(10_000)).await {
        Ok(out) if out.code == Some(0) => lines.push(format!("typst:     {}", out.stdout.trim())),
        Ok(out) => lines.push(format!("typst:     ran but exited {:?} — {}", out.code, out.stderr.trim())),
        Err(e) => lines.push(format!("typst:     could not be run — {e}")),
    }
    match resolve_tinymist() {
        Some(binary) => lines.push(format!("tinymist:  {} (found via {})", binary.path, binary.source)),
        None => lines.push("tinymist:  not found".into()),
    }
    lines.push(format!("PATH:      {}", std::env::var("PATH").unwrap_or_default()));
    lines.push(String::new());
    lines.push(recent_log());
    ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], lines.join("\n")).into_response()
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
    let version = tinymist_version(&version_output);
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
    // A file that is part of the compiled document has to be read as part of it.
    // Anything else — a stray note, a snippet, a scratch file — is read on its
    // own, which is both correct and the only way it gets diagnostics at all,
    // since it belongs to no project for tinymist to compile. The entrypoint
    // counts as part of its own project: unpinning to look at it would make
    // tinymist throw the analysis away and build it again on the way back.
    let main = jstr(&v, "main").unwrap_or("");
    let pin = (!main.is_empty() && (main == file || project_files(&ws, main).contains(file)))
        .then(|| safe_workspace_path(&ws, main))
        .flatten()
        .filter(|path| path.is_file());
    let uri = file_uri(&full_path);
    let (target_version, changed, state, baseline) = {
        let mut guard = LSPS.lock().await;
        let Some(proxy) = guard.get_mut(&ws) else {
            return Json(json!({ "available": false, "diagnostics": [] })).into_response();
        };
        proxy.pin_main(pin.as_deref()).await;
        let state = proxy.diagnostics.clone();
        let baseline = state.lock().unwrap().revision;
        let (version, changed) = proxy.sync_file(&uri, &content).await;
        (version, changed, state, baseline)
    };

    let latest = || {
        let state = state.lock().unwrap();
        state.by_uri.get(&uri).cloned().or_else(|| {
            state.by_uri.iter()
                .find(|(key, _)| same_file_uri(key, &full_path))
                .map(|(_, value)| value.clone())
        })
    };
    let wait = async {
        loop {
            let published = latest();
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
    // tinymist only republishes when a file's diagnostics actually change, so on
    // an edit that neither introduces nor clears a problem — most of them — no
    // message is ever coming. Waiting two seconds for one meant every keystroke
    // in a clean document held a request open for two seconds, and the editor
    // retries once, so a burst of typing stalled for four. It answers in about
    // twenty milliseconds when it does have something to say; a short grace is
    // all that buys anything.
    let published = tokio::time::timeout(Duration::from_millis(400), wait).await.ok().flatten();
    // Silence means the previous set still stands, so report that rather than
    // reporting nothing and making the editor drop every marker it was showing.
    let published = published.or_else(latest);
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

// ---------------------------------------------------------------------------
// The label graph — what the document names, and what refers to what
// ---------------------------------------------------------------------------
// A paper's labels are its skeleton: an equation is derived from two others, a
// section leans on a figure. Typst knows all of it and shows none of it, so we
// read the sources for `<label>` definitions and `@label` references and hand
// the shape back for drawing.
//
// A reference is attributed to the section it appears in, so the graph answers
// the question a writer actually has: which parts of the paper lean on this
// equation. Attributing it to the nearest label above instead looked tempting
// and was wrong — a label is discussed in the paragraphs directly beneath it,
// so almost every reference came out pointing at itself.

static LABEL_DEF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<([A-Za-z0-9_][A-Za-z0-9_:.\-]*)>").unwrap());
static LABEL_REF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"@([A-Za-z][A-Za-z0-9_:.\-]*)").unwrap());
static HEADING_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(=+)\s+(.*?)\s*$").unwrap());

/// `@eq:mapdef.` at the end of a sentence names `eq:mapdef`; the full stop is
/// punctuation, and Typst reads it that way too. Same for a trailing colon or
/// dash left over from `@sec:results:`.
fn trim_label(name: &str) -> &str {
    name.trim_end_matches(['.', ':', '-'])
}

struct LabelSite {
    name: String,
    file: String,
    line: usize,
    section: String,
}

/// A heading, as a node the references from its prose can hang off.
struct SectionSite {
    id: String,
    title: String,
    file: String,
    line: usize,
}

/// Strip what a label or reference must never be read out of: line comments,
/// inline raw spans, and string literals (which is where `@preview/…` lives).
fn prose_only(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.char_indices().peekable();
    let mut in_string = false;
    let mut in_raw = false;
    while let Some((i, c)) = chars.next() {
        match c {
            '\\' if in_string => {
                out.push(' ');
                if chars.next().is_some() {
                    out.push(' ');
                }
            }
            '"' => {
                in_string = !in_string;
                out.push(' ');
            }
            '`' => {
                in_raw = !in_raw;
                out.push(' ');
            }
            '/' if !in_string && !in_raw && line[i..].starts_with("//") => break,
            _ if in_string || in_raw => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}

/// Everything the project's sources name and refer to.
fn read_label_graph(ws: &Path, main: &str) -> Value {
    let mut files: Vec<String> = project_files(ws, main)
        .iter()
        .filter(|f| f.ends_with(".typ"))
        .cloned()
        .collect();
    // Before the first compile there is no dependency list; fall back to every
    // Typst file in the workspace so the view is never empty for no good reason.
    if files.is_empty() {
        files = list_typ_files(ws);
    }
    if !main.is_empty() && !files.iter().any(|f| f == main) {
        files.push(main.to_string());
    }
    files.sort();

    let mut defs: Vec<LabelSite> = Vec::new();
    let mut sections: Vec<SectionSite> = Vec::new();
    let mut refs: Vec<(String, String, String, usize)> = Vec::new(); // from section, to label, file, line
    let mut fenced = false;

    for file in &files {
        let Some(path) = safe_workspace_path(ws, file) else { continue };
        let Ok(text) = fs::read_to_string(&path) else { continue };
        let mut section = String::new();
        // Anything referenced before the first heading belongs to the preamble,
        // which is a real place in the document and worth naming as one.
        let mut owner = format!("§{file}:0");
        sections.push(SectionSite {
            id: owner.clone(),
            title: format!("{file} — before the first heading"),
            file: file.clone(),
            line: 1,
        });
        for (index, raw) in text.lines().enumerate() {
            let line = index + 1;
            let trimmed = raw.trim_start();
            if trimmed.starts_with("```") {
                fenced = !fenced;
                continue;
            }
            if fenced {
                continue;
            }
            if let Some(head) = HEADING_RE.captures(raw) {
                section = head[2].trim().to_string();
                if let Some(cut) = section.find(" <") {
                    section.truncate(cut);
                }
                section = section.trim().to_string();
                // Sections are named by their own heading, and two headings can
                // read the same, so the id carries where it is.
                owner = format!("§{}:{line}", file);
                sections.push(SectionSite {
                    id: owner.clone(),
                    title: section.clone(),
                    file: file.clone(),
                    line,
                });
            }
            let clean = prose_only(raw);
            for found in LABEL_DEF_RE.captures_iter(&clean) {
                let name = trim_label(&found[1]).to_string();
                if name.is_empty() {
                    continue;
                }
                defs.push(LabelSite { name, file: file.clone(), line, section: section.clone() });
            }
            for found in LABEL_REF_RE.captures_iter(&clean) {
                let to = trim_label(&found[1]).to_string();
                // `@preview` is a package, not a label the writer can jump to.
                if to.is_empty() || to.starts_with("preview") {
                    continue;
                }
                refs.push((owner.clone(), to, file.clone(), line));
            }
        }
    }

    let defined: HashSet<&str> = defs.iter().map(|d| d.name.as_str()).collect();
    let mut incoming: HashMap<&str, usize> = HashMap::new();
    for (_, to, _, _) in &refs {
        *incoming.entry(to.as_str()).or_insert(0) += 1;
    }

    // A label defined twice is an error in the document; keep the first and say
    // how many there were rather than drawing the same node again.
    let mut times_defined: HashMap<&str, usize> = HashMap::new();
    for d in &defs {
        *times_defined.entry(d.name.as_str()).or_insert(0) += 1;
    }
    let mut drawn: HashSet<&str> = HashSet::new();
    let nodes: Vec<Value> = defs
        .iter()
        .filter(|d| drawn.insert(d.name.as_str()))
        .map(|d| {
            json!({
                "id": d.name,
                "kind": d.name.split_once(':').map(|(k, _)| k).unwrap_or(""),
                "file": d.file,
                "line": d.line,
                "section": d.section,
                "referenced": incoming.get(d.name.as_str()).copied().unwrap_or(0),
                "defined": times_defined.get(d.name.as_str()).copied().unwrap_or(1),
            })
        })
        .collect();

    // A reference to something no file defines is a broken cross-reference, and
    // worth saying so rather than drawing an edge into nothing.
    let missing: Vec<Value> = {
        let mut seen: HashMap<&str, (usize, &str, usize)> = HashMap::new();
        for (_, to, file, line) in &refs {
            if defined.contains(to.as_str()) {
                continue;
            }
            let entry = seen.entry(to.as_str()).or_insert((0, file.as_str(), *line));
            entry.0 += 1;
        }
        let mut list: Vec<Value> = seen
            .into_iter()
            .map(|(name, (count, file, line))| json!({ "id": name, "uses": count, "file": file, "line": line }))
            .collect();
        list.sort_by_key(|v| v.get("id").and_then(Value::as_str).unwrap_or("").to_string());
        list
    };

    // One edge per pair, however many times the pair occurs; the count travels
    // with it so a heavily used reference can be drawn heavier.
    let mut pairs: Vec<(String, String, String, usize, usize)> = Vec::new();
    for (from, to, file, line) in &refs {
        if from.is_empty() || from == to || !defined.contains(to.as_str()) {
            continue;
        }
        match pairs.iter_mut().find(|(f, t, _, _, _)| f == from && t == to) {
            Some(existing) => existing.4 += 1,
            None => pairs.push((from.clone(), to.clone(), file.clone(), *line, 1)),
        }
    }
    let edges: Vec<Value> = pairs
        .into_iter()
        .map(|(from, to, file, line, uses)| json!({ "from": from, "to": to, "file": file, "line": line, "uses": uses }))
        .collect();

    let used: HashSet<&str> = pairs_from(&edges);
    let section_nodes: Vec<Value> = sections
        .iter()
        .filter(|s| used.contains(s.id.as_str()))
        .map(|s| {
            json!({
                "id": s.id,
                "title": s.title,
                "kind": "section",
                "file": s.file,
                "line": s.line,
                "section": s.title,
                "referenced": 0,
                "defined": 1,
            })
        })
        .collect();

    json!({
        "nodes": nodes.into_iter().chain(section_nodes).collect::<Vec<Value>>(),
        "edges": edges,
        "missing": missing,
        "files": files,
    })
}

/// The section ids that actually have a reference hanging off them.
fn pairs_from(edges: &[Value]) -> HashSet<&str> {
    edges.iter().filter_map(|e| e.get("from").and_then(Value::as_str)).collect()
}

/// Every `.typ` in the workspace, for a project that has not been compiled yet.
fn list_typ_files(ws: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![ws.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            if path.is_dir() {
                if out.len() < 4000 {
                    stack.push(path);
                }
            } else if name.ends_with(".typ")
                && let Ok(rel) = path.strip_prefix(ws)
            {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    out
}

async fn label_graph(State(st): St, Query(q): Q) -> Response {
    let ws = st.ws();
    let main = q.get("main").cloned().unwrap_or_default();
    let graph = tokio::task::spawn_blocking(move || read_label_graph(&ws, &main))
        .await
        .unwrap_or_else(|_| json!({ "nodes": [], "edges": [], "missing": [], "files": [] }));
    Json(graph).into_response()
}

// Proofreading: spelling (spellbook / Nuspell-compatible) + grammar & style
// (harper-core with a Typst-aware parser). Runs on a blocking thread so the
// dictionary work never stalls the async runtime.
static LINT_GATE: LazyLock<Arc<tokio::sync::Semaphore>> = LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(1)));

async fn lint_text(State(st): St, body: Bytes) -> Response {
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
    // The document says what language it is in; `#set text(lang: "fr")` is read
    // by the client and passed through here.
    let how = crate::proofread::Reading::of(jstr(&v, "lang").unwrap_or("en"), jstr(&v, "region").unwrap_or(""));
    let reading = reading_json(&how);
    if text.trim().is_empty() {
        return Json(json!({ "issues": [], "reading": reading })).into_response();
    }
    // Counted only once there is something to proofread. The client also calls
    // this route with an empty body to ask whether proofreading exists at all,
    // and that question must not cancel a pass someone is waiting on.
    let generation = st.lint_generation.fetch_add(1, Ordering::AcqRel) + 1;
    let Ok(permit) = LINT_GATE.clone().acquire_owned().await else { return StatusCode::SERVICE_UNAVAILABLE.into_response() };
    if generation != st.lint_generation.load(Ordering::Acquire) {
        return json_err(StatusCode::CONFLICT, "A newer proofreading request superseded this one.");
    }
    let issues = tokio::task::spawn_blocking(move || {
        // Keep the permit in the worker even if the requesting window disconnects.
        let _permit = permit;
        crate::proofread::lint(&text, &how)
    }).await.unwrap_or_default();
    Json(json!({ "issues": issues, "reading": reading })).into_response()
}

/// What the checker can actually do with this document, so the panel can say so
/// rather than leaving the writer to guess why nothing is being flagged.
fn reading_json(how: &crate::proofread::Reading) -> Value {
    // A document that asks for British English and is read by the American
    // dictionary will be told that "colour" is a misspelling until somebody
    // explains why. Name the dictionary it wanted, so the panel can offer it.
    let wanted = (!how.region.is_empty())
        .then(|| format!("{}_{}", how.lang, how.region))
        .filter(|code| how.dictionary.as_deref() != Some(code.as_str()))
        .and_then(|code| crate::dict_catalog::CATALOG.iter().find(|c| c.code == code))
        .map(|c| json!({ "code": c.code, "name": c.name }));
    json!({
        "lang": how.lang,
        "dictionary": how.dictionary,
        "dictionaryName": how.dictionary.as_deref().and_then(dictionary_name),
        "languageName": language_name(&how.lang),
        "grammar": how.grammar.is_some(),
        "wanted": wanted,
    })
}

fn dictionary_name(code: &str) -> Option<&'static str> {
    crate::dict_catalog::CATALOG.iter().find(|c| c.code == code).map(|c| c.name)
}

/// The language's own name, for a message about a language we cannot check.
/// Taken from the catalog, whose names are already "French (France)" shaped.
fn language_name(lang: &str) -> Option<&'static str> {
    crate::dict_catalog::CATALOG
        .iter()
        .find(|c| c.code.split('_').next() == Some(lang))
        .map(|c| c.name.split(" (").next().unwrap_or(c.name))
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
    let how = crate::proofread::Reading::of(jstr(&v, "lang").unwrap_or("en"), jstr(&v, "region").unwrap_or(""));
    let Ok(permit) = LINT_GATE.clone().acquire_owned().await else { return StatusCode::SERVICE_UNAVAILABLE.into_response() };
    let pairs = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        crate::proofread::suggest_words(&words, &how)
    }).await.unwrap_or_default();
    let map: serde_json::Map<String, Value> = pairs.into_iter().map(|(w, s)| (w, json!(s))).collect();
    Json(json!({ "suggestions": map })).into_response()
}

async fn lint_ignore(body: Bytes) -> Response {
    let v = parse_json(&body);
    let word = jstr(&v, "word").unwrap_or("").to_string();
    let lang = jstr(&v, "lang").unwrap_or("en").to_string();
    if !word.trim().is_empty() {
        let _ = tokio::task::spawn_blocking(move || crate::proofread::add_ignored_word(&word, &lang)).await;
    }
    Json(json!({ "ok": true })).into_response()
}

// ---------------------------------------------------------------------------
// Spelling dictionaries — what is installed, and fetching the rest
// ---------------------------------------------------------------------------
// English is built into the binary. Every other language is a Hunspell pair
// downloaded once, on request, from the LibreOffice dictionary collection,
// together with the licence files it ships under.

async fn dictionaries_list() -> Response {
    let have = crate::proofread::installed();
    let list: Vec<Value> = crate::dict_catalog::CATALOG
        .iter()
        .map(|c| {
            json!({
                "code": c.code,
                "name": c.name,
                "kb": c.kb,
                "installed": have.iter().any(|h| h == c.code),
                "builtin": c.code == crate::proofread::BUILTIN,
            })
        })
        .collect();
    // A dictionary the writer dropped in themselves is real even though the
    // catalog has never heard of it.
    let extra: Vec<Value> = have
        .iter()
        .filter(|h| !crate::dict_catalog::CATALOG.iter().any(|c| c.code == h.as_str()))
        .map(|h| json!({ "code": h, "name": h, "kb": 0, "installed": true, "builtin": false }))
        .collect();
    Json(json!({
        "dictionaries": list.into_iter().chain(extra).collect::<Vec<Value>>(),
        "folder": crate::proofread::dict_dir().to_string_lossy(),
    }))
    .into_response()
}

async fn dictionaries_install(State(st): St, body: Bytes) -> Response {
    let v = parse_json(&body);
    let code = jstr(&v, "code").unwrap_or("");
    let Some(entry) = crate::dict_catalog::CATALOG.iter().find(|c| c.code == code) else {
        return json_err(StatusCode::BAD_REQUEST, "No dictionary with that language tag.");
    };
    let dir = crate::proofread::dict_dir();
    if let Err(e) = fs::create_dir_all(&dir) {
        return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Could not create {}: {e}", dir.display()));
    }

    // Fetch everything first, then write: a half-downloaded dictionary that
    // still parses would quietly mark good words wrong.
    let base = format!("{}{}", crate::dict_catalog::SOURCE, entry.path);
    let mut files: Vec<(PathBuf, Bytes)> = Vec::new();
    for ext in ["aff", "dic"] {
        match fetch_dictionary_file(&st.http, &format!("{base}.{ext}")).await {
            Ok(bytes) => files.push((dir.join(format!("{}.{ext}", entry.code)), bytes)),
            Err(e) => return json_err(StatusCode::BAD_GATEWAY, e),
        }
    }
    // Licence and readme files travel with the dictionary. Their absence is not
    // worth failing the install over, but their presence is worth keeping.
    let folder = entry.path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    for name in entry.extra {
        let url = format!("{}{folder}/{name}", crate::dict_catalog::SOURCE);
        if let Ok(bytes) = fetch_dictionary_file(&st.http, &url).await {
            files.push((dir.join(format!("{}.{name}", entry.code)), bytes));
        }
    }
    for (path, bytes) in files {
        if let Err(e) = write_atomic(&path, &bytes) {
            return json_err(StatusCode::INTERNAL_SERVER_ERROR, format!("Could not save {}: {e}", path.display()));
        }
    }
    crate::proofread::unload(entry.code);
    Json(json!({ "ok": true, "code": entry.code })).into_response()
}

// 60 MB is comfortably over the largest dictionary in the collection (Turkish,
// about 35 MB) and well under anything that would hurt to hold in memory.
const DICT_MAX_BYTES: u64 = 60 * 1024 * 1024;

async fn fetch_dictionary_file(http: &reqwest::Client, url: &str) -> Result<Bytes, String> {
    let res = http
        .get(url)
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| if e.is_timeout() { "The download timed out.".to_string() } else { e.to_string() })?;
    if !res.status().is_success() {
        return Err(format!("{} returned {}", url, res.status()));
    }
    if res.content_length().is_some_and(|n| n > DICT_MAX_BYTES) {
        return Err("That dictionary is implausibly large.".to_string());
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > DICT_MAX_BYTES {
        return Err("That dictionary is implausibly large.".to_string());
    }
    Ok(bytes)
}

async fn dictionaries_remove(body: Bytes) -> Response {
    let v = parse_json(&body);
    let code = jstr(&v, "code").unwrap_or("");
    if !crate::proofread::valid_code(code) || code == crate::proofread::BUILTIN {
        return json_err(StatusCode::BAD_REQUEST, "That dictionary cannot be removed.");
    }
    let dir = crate::proofread::dict_dir();
    let mut removed = 0;
    if let Ok(rd) = fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // `fr_FR.aff`, `fr_FR.dic`, `fr_FR.README_dict_fr.txt` — the files
            // this dictionary brought with it, and nothing else.
            if name == format!("{code}.aff") || name == format!("{code}.dic") || name.starts_with(&format!("{code}.")) {
                if entry.path().is_file() && fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                }
            }
        }
    }
    crate::proofread::unload(code);
    if removed == 0 {
        return json_err(StatusCode::NOT_FOUND, "That dictionary is not installed.");
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

// Where the app's own files live, whatever window is asking. Deliberately not
// derived from the session file: a second window is given a session of its own
// under the temp directory so it starts fresh instead of clobbering the first
// window's project, and hanging the settings and the log off that would put them
// in /tmp — a different set per window, and on a shared machine a path that may
// already belong to somebody else.
fn hilbert_config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(".config"))
        .join("hilbert")
}

fn session_file() -> PathBuf {
    // Overridable so headless/test runs don't touch the real user session file.
    if let Ok(p) = std::env::var("HILBERT_SESSION_FILE") {
        return PathBuf::from(p);
    }
    hilbert_config_dir().join("session.json")
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

// Settings, as opposed to the session. The session is what one window was in the
// middle of; these are the choices someone made about the app and expects to
// find again — font size, theme, how the panels are arranged.
//
// They used to live in the webview's localStorage, which is keyed to the origin,
// and the origin includes the port. The app asks for 3001 and takes any free
// port when something else already has it, so a second window, a stale process,
// or an unrelated program on 3001 was enough to hand the webview a different
// origin and an empty store — and the editor came back at 14pt as if it had
// never been told otherwise. On disk, and shared by every window.
fn settings_file() -> PathBuf {
    if let Ok(p) = std::env::var("HILBERT_SETTINGS_FILE") {
        return PathBuf::from(p);
    }
    hilbert_config_dir().join("settings.json")
}

async fn settings_get() -> Response {
    match fs::read_to_string(settings_file()) {
        Ok(s) if !s.trim().is_empty() => ([(header::CONTENT_TYPE, "application/json")], s).into_response(),
        _ => Json(json!({})).into_response(),
    }
}

async fn settings_post(body: Bytes) -> Response {
    if serde_json::from_slice::<Value>(&body).is_err() {
        return json_err(StatusCode::BAD_REQUEST, "Invalid settings JSON");
    }
    let path = settings_file();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    match write_atomic(&path, &body) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(_) => json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not save settings"),
    }
}

// One clipboard handle for the life of the process. On X11 the clipboard is a
// protocol rather than a place: whoever copied is asked for the text again each
// time someone pastes. Opening a handle per request and dropping it hands that
// ownership straight back, so the copy evaporates before anyone can use it.
static CLIPBOARD: LazyLock<Mutex<Option<arboard::Clipboard>>> =
    LazyLock::new(|| Mutex::new(None));

fn locked_clipboard() -> std::sync::MutexGuard<'static, Option<arboard::Clipboard>> {
    let mut held = CLIPBOARD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    // Clipboard initialization may fail temporarily while a Linux desktop is
    // still starting. Do not turn that one failure into a broken menu for the
    // rest of the process; retry on the next real clipboard operation.
    if held.is_none() {
        *held = arboard::Clipboard::new().ok();
    }
    held
}

async fn clipboard_get(State(st): St) -> Response {
    if st.remote_mode() {
        return json_err(
            StatusCode::NOT_IMPLEMENTED,
            "The hosted editor uses the browser device's clipboard.",
        );
    }
    let text = tokio::task::spawn_blocking(|| {
        let mut held = locked_clipboard();
        held.as_mut().and_then(|c| c.get_text().ok()).unwrap_or_default()
    })
    .await
    .unwrap_or_default();
    Json(json!({ "text": text })).into_response()
}

async fn clipboard_post(State(st): St, body: Bytes) -> Response {
    if st.remote_mode() {
        return json_err(
            StatusCode::NOT_IMPLEMENTED,
            "The hosted editor uses the browser device's clipboard.",
        );
    }
    let text = String::from_utf8_lossy(&body).into_owned();
    let ok = tokio::task::spawn_blocking(move || {
        let mut held = locked_clipboard();
        match held.as_mut() {
            Some(c) => c.set_text(text).is_ok(),
            None => false,
        }
    })
    .await
    .unwrap_or(false);
    if ok {
        Json(json!({ "ok": true })).into_response()
    } else {
        json_err(StatusCode::INTERNAL_SERVER_ERROR, "Could not reach the system clipboard")
    }
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
        .route("/workspace/subtree", get(workspace_subtree))
        .route("/workspace/root", get(workspace_root_get).post(workspace_root_post))
        .route("/workspace/clear", post(workspace_clear))
        .route("/workspace/file", get(workspace_file_get).post(workspace_file_post).delete(workspace_file_delete).layer(DefaultBodyLimit::max(16 * 1024 * 1024)))
        .route("/workspace/file/state", get(workspace_file_state))
        .route("/workspace/files/state", post(workspace_files_state))
        .route("/preview/last", get(last_preview))
        .route("/workspace/mkdir", post(workspace_mkdir))
        .route("/workspace/upload", post(workspace_upload).layer(DefaultBodyLimit::max(50 * 1024 * 1024)))
        .route("/workspace/save-image", post(workspace_save_image).layer(DefaultBodyLimit::max(50 * 1024 * 1024)))
        .route("/workspace/copy", post(workspace_copy))
        .route("/workspace/rename", post(workspace_rename))
        .route("/workspace/reveal", post(workspace_reveal))
        .route("/app/new-window", post(app_new_window))
        .route("/collab/info", get(collab_server_info))
        .route("/hosted/info", get(hosted_info))
        .route("/workspace/search", get(workspace_search))
        .route("/workspace/math-locations", get(workspace_math_locations))
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
        .route("/fonts", get(fonts_list))
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
        .route("/diagnostics", get(diagnostics))
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
        .route("/workspace/labels", get(label_graph))
        .route("/lint", post(lint_text))
        .route("/lint/suggest", post(lint_suggest))
        .route("/lint/ignore", post(lint_ignore))
        .route("/dictionaries", get(dictionaries_list))
        .route("/dictionaries/install", post(dictionaries_install))
        .route("/dictionaries/remove", post(dictionaries_remove))
        .route("/session", get(session_get).post(session_post))
        .route("/settings", get(settings_get).post(settings_post))
        .route("/clipboard", get(clipboard_get).post(clipboard_post).layer(DefaultBodyLimit::max(16 * 1024 * 1024)))
        .route("/auth/revoke-sessions", post(remote_revoke_sessions))
        .layer(axum::middleware::from_fn_with_state(state.clone(), auth_guard));

    let app = Router::new().merge(api);
    // Collaboration relay: outside the bearer-token guard, because a peer joining
    // from another window or machine has no copy of this backend's token — the
    // secret room id gates access instead.
    let app = app
        .route("/collab/{room}", get(hosted_collab_ws))
        .route("/healthz", get(collab_health))
        .route(
            "/auth/login",
            post(remote_login).layer(DefaultBodyLimit::max(4096)),
        )
        // Signing out only clears the browser's own cookie, so it needs no
        // credential of its own — and must still work when the session it is
        // trying to drop has already expired.
        .route("/auth/logout", post(remote_logout));
    #[cfg(debug_assertions)]
    let app = app.route("/auth/dev-token", get(dev_api_token));

    app
        .fallback(static_fallback)
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(cors)
        .layer(axum::middleware::from_fn_with_state(state.clone(), request_guard))
        .with_state(state)
}

// Kill the long-lived child processes (typst watch, tinymist). Called on app
// exit — a GUI quit doesn't signal children, so without this they would keep
// running (and recompiling on every file change) after Hilbert closes.
// Full shutdown at app exit: every watcher owner calls this and the last one
// also reaps every language server.
pub async fn shutdown_children(state: &Arc<AppState>) {
    shutdown_window(state).await;
    stop_all_lsps().await;
}

// One window closing: its preview watcher dies with it, but language servers
// are shared per-workspace across windows and stay for the survivors.
pub async fn shutdown_window(state: &Arc<AppState>) {
    stop_preview_watcher(state).await;
    if !state.workspace_released.swap(true, std::sync::atomic::Ordering::AcqRel) {
        let workspace = state.ws();
        if release_workspace_user(&workspace) {
            stop_lsp_for(&workspace).await;
        }
    }
    let _ = state.shutdown.send(true);
}

// A Hilbert run purely as a collaboration server: just the relay, bound to all
// interfaces so collaborators on the LAN (or a server on the campus/internet)
// can reach it by address. No workspace, no file API — only /collab/<room>.
pub async fn serve_sync_server(listener: std::net::TcpListener) {
    listener.set_nonblocking(true).expect("nonblocking");
    let listener = tokio::net::TcpListener::from_std(listener).expect("tokio listener");
    let app = Router::new()
        .route("/collab/{room}", get(collab_ws))
        .route("/healthz", get(collab_health));
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[hilbert-sync] server error: {e}");
    }
}

pub async fn serve(listener: std::net::TcpListener, state: Arc<AppState>) {
    listener.set_nonblocking(true).expect("nonblocking");
    let listener = tokio::net::TcpListener::from_std(listener).expect("tokio listener");
    let mut shutdown = state.shutdown.subscribe();
    let app = router(state);
    let wait_for_shutdown = async move {
        if *shutdown.borrow() {
            return;
        }
        while shutdown.changed().await.is_ok() {
            if *shutdown.borrow() {
                return;
            }
        }
    };
    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(wait_for_shutdown)
        .await
    {
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
    fn plot_format_only_accepts_the_four_it_can_produce() {
        for want in ["png", "svg", "pdf", "eps"] {
            assert_eq!(plot_format(&json!({ "plotFormat": want })), want);
        }
        // The value is substituted straight into the harness scripts, so
        // anything unrecognised — including an attempt to smuggle in code —
        // has to come back as the plain default.
        assert_eq!(plot_format(&json!({})), "png");
        assert_eq!(plot_format(&json!({ "plotFormat": "png\"; import os" })), "png");
        assert_eq!(plot_format(&json!({ "plotFormat": 7 })), "png");
    }

    #[test]
    fn a_cell_cannot_name_a_figure_outside_the_run_directory() {
        for good in ["nb_plot_0.png", "figure.PDF", "one_shot.svg", "a b c.jpeg"] {
            assert!(safe_image_name(good), "rejected {good}");
        }
        // The names come off the run's stdout, and a cell writes its own stdout.
        // Any of these would have moved a file from elsewhere on the machine
        // into assets/ and handed back a path pointing at it.
        for bad in [
            "../../../../etc/hosts.png",
            "..\\..\\secrets.png",
            "/etc/passwd.png",
            "sub/dir.png",
            ".hidden.png",
            "",
            "notes.txt",
            "script.py",
        ] {
            assert!(!safe_image_name(bad), "accepted {bad}");
        }
    }

    #[test]
    fn promote_images_drops_what_it_will_not_move() {
        let workspace = temp_workspace("promote-images");
        let run = workspace.join(".hilbert/run");
        fs::create_dir_all(&run).unwrap();
        fs::write(run.join("nb_plot_0.png"), b"png").unwrap();
        let outside = workspace.join("private.png");
        fs::write(&outside, b"secret").unwrap();

        let promoted = promote_images(
            &workspace,
            &run,
            &["nb_plot_0.png".to_string(), "../../private.png".to_string()],
        );
        assert_eq!(promoted, vec!["assets/nb_plot_0.png".to_string()]);
        assert!(outside.is_file(), "the file outside the run directory must not have moved");

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn notebook_harnesses_take_the_requested_format() {
        // A format that never reaches the script would leave the placeholder
        // behind and the harness would save to a file literally called __FMT__.
        for harness in [NB_PY, NB_JL] {
            assert!(harness.contains("__FMT__"));
            let filled = harness.replace("__FMT__", "pdf");
            assert!(!filled.contains("__FMT__"));
        }
    }

    #[test]
    fn workspace_paths_allow_nested_creates_and_reject_traversal() {
        let ws = temp_workspace("paths");
        fs::create_dir(ws.join("chapters")).unwrap();
        assert_eq!(safe_workspace_path(&ws, "chapters/new.typ"), Some(ws.join("chapters/new.typ")));
        assert!(safe_workspace_path(&ws, "../outside.typ").is_none());
        fs::remove_dir_all(ws).unwrap();
    }

    // Killing the process we spawned is not the same as killing what it started.
    // The shell here backgrounds a sleep that would touch a marker file: if only
    // the shell dies, the marker still appears.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_timeout_takes_the_childs_children_with_it() {
        let marker = std::env::temp_dir().join(format!("hilbert-killtree-{}.marker", std::process::id()));
        let _ = fs::remove_file(&marker);
        let script = format!("(sleep 2; touch '{}') & wait", marker.display());

        let out = run_cmd("sh", &["-c", &script], None, Some(300)).await.unwrap();
        assert!(out.killed, "the command should have hit its timeout");

        tokio::time::sleep(Duration::from_millis(2600)).await;
        let survived = marker.exists();
        let _ = fs::remove_file(&marker);
        assert!(!survived, "a grandchild outlived the timeout that killed its parent");
    }

    // Two requests for the same template used to be handed the same directory,
    // and each one began by deleting it.
    #[test]
    fn scratch_directories_are_unique_per_request() {
        let a = unique_temp_dir("typst-tpl-ieee").unwrap();
        let b = unique_temp_dir("typst-tpl-ieee").unwrap();
        assert_ne!(a, b, "two requests for one template must not share a directory");
        assert!(a.file_name().unwrap().to_string_lossy().starts_with("typst-tpl-ieee-"));
        assert!(a.is_dir() && b.is_dir(), "the directory is created, exclusively, by the helper");
        // Created exclusively: a second attempt on the same path must not succeed.
        assert!(fs::create_dir(&a).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&a).unwrap().permissions().mode() & 0o777, 0o700);
        }
        fs::remove_dir_all(a).unwrap();
        fs::remove_dir_all(b).unwrap();
    }

    // A template is built in a scratch directory and moved in afterwards, so the
    // move has to carry nested folders and survive a cross-filesystem rename.
    #[test]
    fn moving_a_built_template_carries_its_whole_tree() {
        let root = temp_workspace("move");
        let from = root.join("staged");
        let to = root.join("workspace");
        fs::create_dir_all(from.join("chapters")).unwrap();
        fs::create_dir_all(&to).unwrap();
        fs::write(from.join("main.typ"), "= Paper").unwrap();
        fs::write(from.join("chapters/one.typ"), "= One").unwrap();

        move_dir_contents(&from, &to).unwrap();

        assert_eq!(fs::read_to_string(to.join("main.typ")).unwrap(), "= Paper");
        assert_eq!(fs::read_to_string(to.join("chapters/one.typ")).unwrap(), "= One");
        assert_eq!(dir_entry_count(&from), 0, "the staging directory should be left empty");
        fs::remove_dir_all(root).unwrap();
    }

    // The app writes .hilbert into a project the first time it compiles one, so
    // counting it would make an empty folder ask "delete 1 item?" — and a user
    // who sees that on every new project learns to click through it.
    #[test]
    fn the_apps_own_scratch_does_not_make_a_folder_look_occupied() {
        let ws = temp_workspace("scratch");
        fs::create_dir_all(ws.join(".hilbert/run")).unwrap();
        fs::write(ws.join(".DS_Store"), "finder").unwrap();
        assert_eq!(dir_entry_count(&ws), 0, "an empty project is empty even after it has compiled");
        fs::write(ws.join("main.typ"), "= Real work").unwrap();
        assert_eq!(dir_entry_count(&ws), 1);
        fs::remove_dir_all(ws).unwrap();
    }

    // The count is what the handler refuses on: a workspace with anything in it
    // is somebody's project, and a template must not delete it unasked.
    #[test]
    fn a_workspace_with_files_in_it_is_not_empty() {
        let ws = temp_workspace("count");
        assert_eq!(dir_entry_count(&ws), 0);
        fs::write(ws.join("thesis.typ"), "years of work").unwrap();
        assert_eq!(dir_entry_count(&ws), 1);
        fs::create_dir(ws.join("figures")).unwrap();
        assert_eq!(dir_entry_count(&ws), 2);
        fs::remove_dir_all(ws).unwrap();
    }

    #[test]
    fn workspace_copy_is_exclusive_and_copies_directories() {
        let ws = temp_workspace("copy");
        let source = ws.join("source.typ");
        fs::write(&source, "irreplaceable").unwrap();

        let error = copy_workspace_entry(&source, &source).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&source).unwrap(), "irreplaceable");

        let occupied = ws.join("occupied.typ");
        fs::write(&occupied, "keep me").unwrap();
        let error = copy_workspace_entry(&source, &occupied).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read_to_string(&occupied).unwrap(), "keep me");

        let folder = ws.join("figures");
        fs::create_dir_all(folder.join("nested")).unwrap();
        fs::write(folder.join("one.txt"), "one").unwrap();
        fs::write(folder.join("nested/two.txt"), "two").unwrap();
        let copied = ws.join("figures_copy");
        copy_workspace_entry(&folder, &copied).unwrap();
        assert_eq!(fs::read_to_string(copied.join("one.txt")).unwrap(), "one");
        assert_eq!(fs::read_to_string(copied.join("nested/two.txt")).unwrap(), "two");

        let error = copy_workspace_entry(&folder, &folder.join("inside")).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        assert!(!folder.join("inside").exists());
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

        // Without a published name a hosted server has to take the Host it is
        // given; with one, anything else was routed here by something other than
        // the proxy it sits behind.
        assert!(public_host_allowed(None, "anything.example.org"));
        assert!(public_host_allowed(Some("hilbert.example.org"), "hilbert.example.org"));
        assert!(public_host_allowed(Some("hilbert.example.org"), "Hilbert.Example.ORG:443"));
        assert!(public_host_allowed(Some("hilbert.example.org"), "127.0.0.1:3001"));
        assert!(!public_host_allowed(Some("hilbert.example.org"), "evil.example.com"));
        assert!(!public_host_allowed(Some("hilbert.example.org"), "hilbert.example.org.evil.com"));
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
        let workspace = temp_workspace("bearer-token");
        let state = AppState::new(workspace.clone(), None);
        let token = state.api_token().to_string();

        let mut headers = HeaderMap::new();
        assert!(!valid_request_auth(&state, &headers));
        headers.insert(header::AUTHORIZATION, "Bearer wrong-token".parse().unwrap());
        assert!(!valid_request_auth(&state, &headers));
        headers.insert(header::AUTHORIZATION, format!("Bearer {token}extra").parse().unwrap());
        assert!(!valid_request_auth(&state, &headers));
        headers.insert(header::AUTHORIZATION, format!("Bearer {token}").parse().unwrap());
        assert!(valid_request_auth(&state, &headers));

        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn a_hosted_browser_session_is_signed_bounded_and_revocable() {
        let workspace = temp_workspace("hosted-sessions");
        let access = "hosted-access-token-0123456789abcdef";
        let state = AppState::new_remote(workspace.clone(), None, access.to_string());
        let sessions = state.sessions.as_ref().expect("hosted mode issues sessions");
        let cookie = sessions.issue();

        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            format!("theme=ink; hilbert_session={cookie}; another=value").parse().unwrap(),
        );
        assert!(valid_request_auth(&state, &headers));

        // None of the server's other secrets is a session. This is the part the
        // old scheme got wrong: the cookie used to be the API token itself.
        for wrong in [state.api_token().to_string(), access.to_string(), format!("{cookie}x")] {
            headers.insert(header::COOKIE, format!("hilbert_session={wrong}").parse().unwrap());
            assert!(!valid_request_auth(&state, &headers), "accepted {wrong}");
        }

        // An expiry is something the client sends back to us, so it only counts
        // when the MAC covering it still adds up.
        let far_future = unix_now() + 999_999;
        let stolen_tag = cookie.rsplit('.').next().unwrap();
        assert!(!sessions.verify(&format!("v1.{far_future}.0.{stolen_tag}")));

        // And a correctly signed session still stops working once it is past.
        let expired = unix_now() - 1;
        assert!(!sessions.verify(&format!("v1.{expired}.0.{}", sessions.tag(expired, 0))));

        // Revoking moves the generation on, which ends every cookie already out
        // there without changing the token anyone signs in with.
        assert!(sessions.verify(&cookie));
        sessions.revoke_all();
        assert!(!sessions.verify(&cookie));
        assert!(sessions.verify(&sessions.issue()));

        let _ = fs::remove_file(&sessions.generation_file);
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn hosted_secrets_survive_restart_but_are_domain_and_workspace_scoped() {
        let first_workspace = temp_workspace("hosted-secret-first");
        let second_workspace = temp_workspace("hosted-secret-second");
        let access = "hosted-access-token-0123456789abcdef";

        let session = hosted_secret("session", access, &first_workspace);
        assert_eq!(session, hosted_secret("session", access, &first_workspace));
        assert_ne!(session, hosted_secret("room", access, &first_workspace));
        assert_ne!(session, hosted_secret("session", "different-hosted-access-token", &first_workspace));
        assert_ne!(session, hosted_secret("session", access, &second_workspace));

        fs::remove_dir_all(first_workspace).unwrap();
        fs::remove_dir_all(second_workspace).unwrap();
    }

    #[test]
    fn workspace_reference_counts_keep_shared_language_servers_alive() {
        let first = temp_workspace("workspace-users-first");
        let second = temp_workspace("workspace-users-second");

        register_workspace_user(&first);
        register_workspace_user(&first);
        assert!(!release_workspace_user(&first));
        assert!(move_workspace_user(&first, &second));
        assert!(release_workspace_user(&second));

        fs::remove_dir_all(first).unwrap();
        fs::remove_dir_all(second).unwrap();
    }

    #[test]
    fn hosted_claim_survives_until_both_room_channels_disconnect() {
        let room = format!(
            "hostedclaim{}{}",
            std::process::id(),
            SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos()
        );
        HOSTED_CLAIMS.lock().unwrap_or_else(|e| e.into_inner()).insert(
            room.clone(),
            HostedClaim { claimed_at: Instant::now(), active: false },
        );

        let base = collab_join(&room).expect("base room should open");
        let binary_room = format!("{room}-bin");
        let binary = collab_join(&binary_room).expect("binary room should open");
        assert!(HOSTED_CLAIMS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&room)
            .is_some_and(|claim| claim.active));

        collab_leave(&room);
        assert!(HOSTED_CLAIMS.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&room));
        collab_leave(&binary_room);
        assert!(!HOSTED_CLAIMS.lock().unwrap_or_else(|e| e.into_inner()).contains_key(&room));
        drop(base);
        drop(binary);
    }

    #[test]
    fn hosted_socket_rebuilds_the_active_claim_after_a_process_restart() {
        let room = format!(
            "hostedreconnect{}{}",
            std::process::id(),
            SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos()
        );
        HOSTED_CLAIMS.lock().unwrap_or_else(|error| error.into_inner()).remove(&room);
        activate_hosted_claim(&room);
        assert!(HOSTED_CLAIMS
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&room)
            .is_some_and(|claim| claim.active));
        HOSTED_CLAIMS.lock().unwrap_or_else(|error| error.into_inner()).remove(&room);
    }

    #[test]
    fn collaboration_room_ids_are_bounded_and_path_safe() {
        assert!(valid_collab_room("0123456789abcdef"));
        assert!(valid_collab_room(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        ));
        assert!(!valid_collab_room("too-short"));
        assert!(!valid_collab_room("0123456789abcde/"));
        assert!(!valid_collab_room("0123456789abcde?"));
        assert!(!valid_collab_room(&"a".repeat(129)));
    }

    // The shape behind "it compiles the first few times and then sits on
    // Compiling… forever": typst watch announced a cycle and never said how it
    // went. The announcement must stop being the answer once it is old enough,
    // or every keystroke after it pays the full budget.
    // From a real Windows log: opening C:\Users\think\Documents\Hilbert\Sample
    // left the workspace recorded as \Users\think\Documents\Hilbert\Sample,
    // and every path built from it inherited the mistake.
    #[test]
    fn an_absolute_path_keeps_its_own_root() {
        let base = Path::new(if cfg!(windows) { r"C:\work" } else { "/work" });
        let absolute = if cfg!(windows) { r"C:\Users\think\Documents\Hilbert" } else { "/Users/think/Documents/Hilbert" };

        let resolved = lexical_resolve(base, absolute);
        assert_eq!(resolved, Path::new(absolute), "an absolute path must survive intact");
        assert!(resolved.is_absolute(), "and must still be absolute");

        // Relative paths still hang off the workspace, and traversal still climbs.
        assert_eq!(lexical_resolve(base, "chapters/one.typ"), base.join("chapters").join("one.typ"));
        assert_eq!(lexical_resolve(base, "chapters/../one.typ"), base.join("one.typ"));
    }

    #[test]
    fn a_cycle_that_never_reports_back_stops_being_believed() {
        let waiting = PreviewEvent::new(7, PreviewOutcome::Waiting);

        assert_eq!(
            watcher_step(&waiting, 8, Duration::from_millis(50)),
            WatchStep::AwaitCycle(IN_FLIGHT_BUDGET - Duration::from_millis(50)),
            "a cycle that just started deserves the wait"
        );
        assert_eq!(
            watcher_step(&waiting, 8, IN_FLIGHT_BUDGET + Duration::from_secs(1)),
            WatchStep::AwaitStart(START_GRACE),
            "once it is past the budget it must not hold up the next edit too"
        );

        let done = PreviewEvent::new(8, PreviewOutcome::Success);
        assert_eq!(
            watcher_step(&done, 8, Duration::from_secs(0)),
            WatchStep::Serve,
            "a finished cycle at or past the edit is the answer"
        );
        assert_eq!(
            watcher_step(&done, 9, Duration::from_secs(0)),
            WatchStep::AwaitStart(START_GRACE),
            "a finished cycle from before the edit is not"
        );
    }

    #[test]
    fn preview_reader_stops_at_its_memory_limit_without_changing_the_file() {
        let root = temp_workspace("preview-limit");
        let file = root.join("large.bin");
        fs::write(&file, b"123456789").unwrap();
        assert_eq!(read_file_limited(&file, 8).unwrap(), None);
        assert_eq!(fs::read(&file).unwrap(), b"123456789");
        assert_eq!(read_file_limited(&file, 9).unwrap(), Some(b"123456789".to_vec()));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn finds_tinymist_where_winget_leaves_it() {
        let root = temp_workspace("winget");
        assert_eq!(tinymist_under(&root), None, "nothing installed yet");

        // The names winget actually uses: the package folder carries the id and
        // source, and the executable keeps the name it was released under.
        let pkg = root.join("Myriad-Dreamin.Tinymist_Microsoft.Winget.Source_8wekyb3d8bbwe");
        fs::create_dir_all(&pkg).unwrap();
        assert_eq!(tinymist_under(&root), None, "folder alone is not an install");

        let exe = pkg.join("tinymist-win32-x64.exe");
        fs::write(&exe, b"").unwrap();
        assert_eq!(tinymist_under(&root), Some(exe));

        // A neighbouring package must not be mistaken for one.
        let other = temp_workspace("winget-other");
        let unrelated = other.join("Typst.Typst_Microsoft.Winget.Source_8wekyb3d8bbwe");
        fs::create_dir_all(&unrelated).unwrap();
        fs::write(unrelated.join("typst.exe"), b"").unwrap();
        assert_eq!(tinymist_under(&other), None);

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&other).ok();
    }
}

#[cfg(test)]
mod reveal_tests {
    use super::explorer_argument;
    use std::path::Path;

    // The path is a real one, from a Windows user's diagnostics log: a project
    // under Documents holding a file whose name contains a space. That space is
    // what made Rust quote the whole argument, which Explorer answers by opening
    // the default folder rather than the file.
    const FILE: &str = r"C:\Users\think\Documents\Hilbert\Sample\main .typ";
    const DIR: &str = r"C:\Users\think\Documents\Hilbert\Sample";

    #[test]
    fn a_file_is_selected_inside_its_folder() {
        let arg = explorer_argument(Path::new(FILE), false);
        assert_eq!(arg, "/select,\"C:\\Users\\think\\Documents\\Hilbert\\Sample\\main .typ\"");
        // Explorer parses the switch itself, so it must lead — nothing may be
        // wrapped around it.
        assert!(arg.starts_with("/select,\""));
        assert!(arg.ends_with('"'));
    }

    #[test]
    fn a_folder_is_opened_rather_than_selected() {
        // Selecting a folder opens its parent with the folder highlighted, and a
        // workspace under Documents then looks like "it always opens Documents".
        let arg = explorer_argument(Path::new(DIR), true);
        assert_eq!(arg, "\"C:\\Users\\think\\Documents\\Hilbert\\Sample\"");
        assert!(!arg.contains("/select"));
    }

    #[test]
    fn forward_slashes_become_the_separator_explorer_understands() {
        let arg = explorer_argument(Path::new("C:/Users/think/Documents/a b/main .typ"), false);
        assert!(!arg.contains('/') || arg.starts_with("/select,"));
        assert!(arg.contains(r"C:\Users\think\Documents\a b\main .typ"));
    }
}
