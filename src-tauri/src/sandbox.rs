// Confinement for the code a document runs.
//
// The regex screen in server.rs reads the source and refuses what looks
// dangerous. That catches accidents, not intent: any program can spell
// `subprocess` in a way a pattern does not recognise, and a notebook that
// wanted to could always have found a way out. This module asks the operating
// system to draw the boundary instead, so what a cell may touch stops depending
// on how it was written.
//
// Two rules are enforced everywhere a sandbox exists at all:
//
//   * the run directory is the only place the code can write, and
//   * there is no network.
//
// Linux gets those from bubblewrap, which also gives the cell its own PID, IPC
// and UTS namespaces. macOS gets them from Seatbelt via sandbox-exec, which
// cannot restrict reads as tightly — the machine's files are still readable
// apart from a denied list of credential stores — but does hold the two rules
// above. Windows has no equivalent worth relying on, so there the answer is
// honestly "none", and the policy below decides whether that is acceptable.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    // Each of these is only ever constructed on the one platform that has it,
    // but every arm handling them is compiled everywhere: the shape of this
    // module should not change depending on where it is built.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Bubblewrap,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Seatbelt,
    None,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Bubblewrap => "bubblewrap",
            Kind::Seatbelt => "seatbelt",
            Kind::None => "none",
        }
    }

    pub fn real(self) -> bool {
        self != Kind::None
    }
}

// What to do when the machine cannot provide one. `Auto` runs the code anyway
// and leaves the regex screen as the only guard — right for a desktop, where
// the code and the person running it are the same. `Require` refuses to run
// anything at all, which is what a server open to more than one person wants.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Policy {
    Auto,
    Require,
    Off,
}

pub fn parse_policy(raw: Option<&str>, hosted: bool) -> Policy {
    match raw.map(str::trim).unwrap_or("") {
        "off" | "0" | "none" => Policy::Off,
        "require" | "required" | "strict" => Policy::Require,
        "auto" | "1" | "on" => Policy::Auto,
        // A hosted workspace runs code written by whoever holds the token, and
        // the operator is not in the room to see it happen. Nothing is a real
        // enough answer there, so refuse rather than pretend.
        _ => {
            if hosted {
                Policy::Require
            } else {
                Policy::Auto
            }
        }
    }
}

// Set once, at startup, because only main knows whether this process is a
// hosted workspace. Everything downstream reads it back rather than being
// handed it through six call sites that have no other use for it.
static POLICY: std::sync::OnceLock<Policy> = std::sync::OnceLock::new();

pub fn set_policy(policy: Policy) {
    let _ = POLICY.set(policy);
}

pub fn policy() -> Policy {
    *POLICY.get_or_init(|| parse_policy(std::env::var("HILBERT_SANDBOX").ok().as_deref(), false))
}

// What this process will actually apply: detection, with the operator's veto.
pub fn active() -> Kind {
    if policy() == Policy::Off {
        Kind::None
    } else {
        detected()
    }
}

// The reason code cannot be run right now, if there is one.
pub fn refusal() -> Option<&'static str> {
    (policy() == Policy::Require && !detected().real()).then_some(
        "Code execution is refused: this server is configured to require an operating-system \
         sandbox and this machine has none. Install bubblewrap (Linux) or, to accept the risk \
         and run code unconfined, start the server with HILBERT_SANDBOX=off.",
    )
}

pub fn allow_network() -> bool {
    matches!(std::env::var("HILBERT_SANDBOX_NET").ok().as_deref(), Some("1") | Some("true"))
}

// Detection costs one process spawn, so it happens once. A sandbox that exists
// is not necessarily a sandbox that works: unprivileged user namespaces are
// switched off on some distributions and inside many containers, and bubblewrap
// can do nothing for us there. Ask it to do the real thing on /bin/true rather
// than trusting the binary's presence.
static DETECTED: LazyLock<Kind> = LazyLock::new(detect);

pub fn detected() -> Kind {
    *DETECTED
}

fn probe(program: &str, args: &[&str]) -> bool {
    std::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn true_binary() -> Option<&'static str> {
    ["/bin/true", "/usr/bin/true"].into_iter().find(|p| Path::new(p).is_file())
}

#[cfg(target_os = "linux")]
fn detect() -> Kind {
    let Some(truth) = true_binary() else { return Kind::None };
    let bwrap = crate::server::which("bwrap")
        .or_else(|| Path::new("/usr/bin/bwrap").is_file().then(|| "/usr/bin/bwrap".to_string()));
    let Some(bwrap) = bwrap else { return Kind::None };
    if probe(&bwrap, &["--ro-bind", "/", "/", "--unshare-all", "--die-with-parent", "--", truth]) {
        Kind::Bubblewrap
    } else {
        Kind::None
    }
}

#[cfg(target_os = "macos")]
fn detect() -> Kind {
    let Some(truth) = true_binary() else { return Kind::None };
    if !Path::new(SANDBOX_EXEC).is_file() {
        return Kind::None;
    }
    if probe(SANDBOX_EXEC, &["-p", "(version 1)(allow default)", truth]) {
        Kind::Seatbelt
    } else {
        Kind::None
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn detect() -> Kind {
    let _ = (probe as fn(&str, &[&str]) -> bool, true_binary as fn() -> Option<&'static str>);
    Kind::None
}

#[cfg(target_os = "macos")]
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

// The command to run instead of the interpreter, plus the environment the
// confined process needs so its caches land somewhere it can write.
pub struct Confined {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

// Credential stores. On macOS these are removed from what the code can read; on
// Linux an empty tmpfs is mounted over each so the same paths come back bare.
// Not a complete list of everything worth protecting — nothing could be — but
// these are the files that turn "read some of the disk" into "be you elsewhere".
fn secret_dirs(home: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = [".ssh", ".gnupg", ".aws", ".kube", ".docker", ".config/gh", ".config/gcloud"]
        .iter()
        .map(|name| home.join(name))
        .collect();
    if cfg!(target_os = "macos") {
        dirs.push(home.join("Library/Keychains"));
    }
    dirs
}

fn secret_files(home: &Path) -> Vec<PathBuf> {
    [".netrc", ".pgpass", ".git-credentials"].iter().map(|name| home.join(name)).collect()
}

// Julia writes its precompiled caches into the depot, and refuses to start a
// package it cannot compile. Only those three directories are opened up; the
// rest of the depot — the package sources themselves — stays read-only.
fn julia_writable(home: &Path) -> Vec<PathBuf> {
    let depot = std::env::var("JULIA_DEPOT_PATH")
        .ok()
        .and_then(|raw| {
            let sep = if cfg!(windows) { ';' } else { ':' };
            raw.split(sep).find(|part| !part.is_empty()).map(PathBuf::from)
        })
        .unwrap_or_else(|| home.join(".julia"));
    ["compiled", "scratchspaces", "logs"]
        .iter()
        .map(|name| depot.join(name))
        .inspect(|dir| {
            let _ = std::fs::create_dir_all(dir);
        })
        .collect()
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

// Caches that would otherwise be written outside the run directory. Left to
// themselves, matplotlib rebuilds its font cache on every single run and
// fontconfig prints three paragraphs of complaint; pointing them inside the
// sandbox makes both quiet and persistent.
fn confined_env(run_dir: &Path, lang: &str) -> Vec<(String, String)> {
    let cache = run_dir.join(".cache");
    let tmp = run_dir.join(".tmp");
    let _ = std::fs::create_dir_all(&cache);
    let _ = std::fs::create_dir_all(&tmp);
    let mut env = vec![
        ("XDG_CACHE_HOME".to_string(), cache.to_string_lossy().into_owned()),
        ("TMPDIR".to_string(), tmp.to_string_lossy().into_owned()),
    ];
    match lang {
        "python" => {
            let _ = std::fs::create_dir_all(cache.join("matplotlib"));
            env.push(("MPLCONFIGDIR".to_string(), cache.join("matplotlib").to_string_lossy().into_owned()));
            env.push(("PYTHONPYCACHEPREFIX".to_string(), cache.join("pycache").to_string_lossy().into_owned()));
        }
        "julia" => {
            // GR's default is to open a plot window, which without a network
            // means a failed connection to its own helper and four lines of
            // noise in front of a figure that saved perfectly well anyway.
            env.push(("GKSwstype".to_string(), "nul".to_string()));
            env.push(("JULIA_HISTORY".to_string(), cache.join("julia_history").to_string_lossy().into_owned()));
        }
        _ => {}
    }
    env
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

// Mathematica is the one language this cannot hold, and the reason is worth
// writing down so nobody spends an afternoon rediscovering it.
//
// `wolframscript` is a launcher: it starts a separate WolframKernel and talks to
// it over WSTP, a loopback socket whose link files live in /tmp, and it works out
// which kernel to start from state under ~/Library. Deny the network and the
// kernel never comes up at all — no output, no error, exit 255. Give it loopback
// and /tmp and it starts, but silently picks a DIFFERENT kernel: on this machine
// Wolfram Engine 14.2 in place of Wolfram 15.0. Opening ~/Library/Caches/Wolfram
// as well gets it working, though still on the other kernel, and by then the box
// has grown a shared /tmp and a cache directory and is holding very little.
//
// Running somebody's algebra on a quietly different version of Mathematica is a
// worse outcome than not confining it. So Wolfram runs unconfined, and keeps the
// source screen — DENY_WOLFRAM, which refuses Run, RunProcess, URLFetch, Import
// of a URL and the rest — as its guard. That is what it had before any of this:
// nothing about Wolfram has got worse, it simply has not got better.
pub fn confines(lang: &str) -> bool {
    lang != "wolfram"
}

// Everything the confined process may write to: the run directory, and the depot
// directories Julia compiles into.
fn writable(run_dir: &Path, lang: &str) -> Vec<PathBuf> {
    let mut paths = vec![canonical(run_dir)];
    if lang == "julia" {
        paths.extend(julia_writable(&home_dir()).iter().map(|p| canonical(p)));
    }
    paths
}

pub fn bwrap_args(
    run_dir: &Path,
    writable: &[PathBuf],
    hidden_dirs: &[PathBuf],
    hidden_files: &[PathBuf],
    network: bool,
    program: &str,
    args: &[&str],
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |value: &str| out.push(value.to_string());
    // Order matters: every mount is applied in the order given, so the
    // read-only view of the filesystem has to be laid down before anything is
    // punched through it.
    push("--ro-bind");
    push("/");
    push("/");
    push("--dev");
    push("/dev");
    push("--proc");
    push("/proc");
    push("--tmpfs");
    push("/tmp");
    for dir in hidden_dirs {
        push("--tmpfs");
        push(&dir.to_string_lossy());
    }
    for file in hidden_files {
        push("--ro-bind");
        push("/dev/null");
        push(&file.to_string_lossy());
    }
    for dir in writable {
        push("--bind");
        push(&dir.to_string_lossy());
        push(&dir.to_string_lossy());
    }
    push("--chdir");
    push(&run_dir.to_string_lossy());
    for flag in ["--unshare-user-try", "--unshare-ipc", "--unshare-pid", "--unshare-uts", "--unshare-cgroup-try"] {
        push(flag);
    }
    if !network {
        push("--unshare-net");
    }
    // Without --die-with-parent a killed request leaves the cell running; without
    // --new-session the child shares our terminal and could push characters back
    // into it.
    push("--die-with-parent");
    push("--new-session");
    push("--");
    push(program);
    for arg in args {
        push(arg);
    }
    out
}

fn sb_quote(path: &Path) -> String {
    let text = path.to_string_lossy();
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for ch in text.chars() {
        if ch == '"' || ch == '\\' {
            quoted.push('\\');
        }
        quoted.push(ch);
    }
    quoted.push('"');
    quoted
}

// Seatbelt applies the last rule that matches, so this reads as: allow the
// interpreter to do its job, then take back the network and every write that
// is not in the run directory, then take back reads of the credential stores.
pub fn seatbelt_profile(
    writable: &[PathBuf],
    unreadable: &[PathBuf],
    network: bool,
) -> String {
    let mut profile = String::from("(version 1)\n(allow default)\n");
    if !network {
        profile.push_str("(deny network*)\n");
    }
    profile.push_str("(deny file-write*)\n(allow file-write*\n");
    for path in writable {
        profile.push_str(&format!("  (subpath {})\n", sb_quote(path)));
    }
    // Character devices a normal program expects to be able to write to. Without
    // these an interpreter cannot even discard output.
    profile.push_str(
        "  (literal \"/dev/null\") (literal \"/dev/zero\") (literal \"/dev/random\") (literal \"/dev/urandom\")\n  \
         (literal \"/dev/dtracehelper\") (literal \"/dev/tty\") (regex #\"^/dev/ttys[0-9]*$\"))\n",
    );
    if !unreadable.is_empty() {
        profile.push_str("(deny file-read*\n");
        for path in unreadable {
            profile.push_str(&format!("  (subpath {})\n", sb_quote(path)));
        }
        profile.push_str(")\n");
    }
    profile
}

// Rewrite an interpreter invocation into a confined one. `None` means this
// machine has no sandbox to offer; the caller decides what that is worth.
pub fn confine(program: &str, args: &[&str], run_dir: &Path, lang: &str) -> Option<Confined> {
    let kind = active();
    if !kind.real() || !confines(lang) {
        return None;
    }
    let run = canonical(run_dir);
    let home = canonical(&home_dir());
    let writable = writable(&run, lang);
    let network = allow_network();
    let env = confined_env(run_dir, lang);
    match kind {
        Kind::Bubblewrap => {
            let hidden_dirs: Vec<PathBuf> = secret_dirs(&home).into_iter().filter(|p| p.is_dir()).collect();
            let hidden_files: Vec<PathBuf> = secret_files(&home).into_iter().filter(|p| p.is_file()).collect();
            let bwrap = crate::server::which("bwrap").unwrap_or_else(|| "/usr/bin/bwrap".to_string());
            Some(Confined {
                args: bwrap_args(&run, &writable, &hidden_dirs, &hidden_files, network, program, args),
                program: bwrap,
                env,
            })
        }
        Kind::Seatbelt => {
            let mut unreadable = secret_dirs(&home);
            unreadable.extend(secret_files(&home));
            let unreadable: Vec<PathBuf> = unreadable.into_iter().filter(|p| p.exists()).collect();
            let profile = seatbelt_profile(&writable, &unreadable, network);
            let mut full = vec!["-p".to_string(), profile, program.to_string()];
            full.extend(args.iter().map(|a| a.to_string()));
            Some(Confined {
                #[cfg(target_os = "macos")]
                program: SANDBOX_EXEC.to_string(),
                #[cfg(not(target_os = "macos"))]
                program: "/usr/bin/sandbox-exec".to_string(),
                args: full,
                env,
            })
        }
        Kind::None => None,
    }
}

// One line for the startup banner and the settings panel.
pub fn describe() -> String {
    match (policy(), detected()) {
        (Policy::Off, _) => "disabled by HILBERT_SANDBOX=off — code runs with no OS confinement".into(),
        (_, Kind::Bubblewrap) => {
            format!("bubblewrap — writes confined to the run directory{}", net_suffix())
        }
        (_, Kind::Seatbelt) => {
            format!("seatbelt — writes confined to the run directory{}", net_suffix())
        }
        (Policy::Require, Kind::None) => "unavailable on this machine — code execution is refused".into(),
        (Policy::Auto, Kind::None) => "unavailable on this machine — only the source screen applies".into(),
    }
}

fn net_suffix() -> &'static str {
    if allow_network() {
        ", network allowed (HILBERT_SANDBOX_NET=1)"
    } else {
        ", no network"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosted_mode_requires_a_sandbox_unless_told_otherwise() {
        assert_eq!(parse_policy(None, true), Policy::Require);
        assert_eq!(parse_policy(None, false), Policy::Auto);
        assert_eq!(parse_policy(Some("off"), true), Policy::Off);
        assert_eq!(parse_policy(Some("auto"), true), Policy::Auto);
        assert_eq!(parse_policy(Some("require"), false), Policy::Require);
        // An unreadable value must not quietly become "off".
        assert_eq!(parse_policy(Some("yes please"), true), Policy::Require);
        assert_eq!(parse_policy(Some(""), false), Policy::Auto);
    }

    #[test]
    fn bubblewrap_writes_only_where_it_is_told() {
        let run = PathBuf::from("/ws/.hilbert/run");
        let depot = PathBuf::from("/home/u/.julia/compiled");
        let args = bwrap_args(
            &run,
            &[run.clone(), depot.clone()],
            &[PathBuf::from("/home/u/.ssh")],
            &[PathBuf::from("/home/u/.netrc")],
            false,
            "julia",
            &["-q", "_nb.jl"],
        );
        let line = args.join(" ");
        assert!(line.starts_with("--ro-bind / /"), "{line}");
        assert!(line.contains("--bind /ws/.hilbert/run /ws/.hilbert/run"));
        assert!(line.contains("--bind /home/u/.julia/compiled /home/u/.julia/compiled"));
        assert!(line.contains("--tmpfs /home/u/.ssh"));
        assert!(line.contains("--ro-bind /dev/null /home/u/.netrc"));
        assert!(line.contains("--unshare-net"));
        assert!(line.contains("--die-with-parent"));
        // The interpreter and its arguments have to come after the separator, or
        // bwrap reads them as its own options.
        let sep = args.iter().position(|a| a == "--").expect("separator");
        assert_eq!(&args[sep + 1..], &["julia", "-q", "_nb.jl"]);
    }

    #[test]
    fn bubblewrap_keeps_the_network_when_asked() {
        let run = PathBuf::from("/ws/run");
        let args = bwrap_args(&run, &[run.clone()], &[], &[], true, "python3", &[]);
        assert!(!args.iter().any(|a| a == "--unshare-net"));
        // Everything else still applies.
        assert!(args.iter().any(|a| a == "--unshare-pid"));
    }

    #[test]
    fn wolfram_is_left_alone_because_confining_it_changes_which_kernel_runs() {
        assert!(confines("python") && confines("julia"));
        assert!(!confines("wolfram"));
        // And it must not be handed a half-built box either: no confinement at
        // all is the whole point, since the source screen is what guards it.
        assert!(confine("wolframscript", &["-file", "_run.wls"], Path::new("."), "wolfram").is_none());
    }

    #[test]
    fn seatbelt_denies_writes_before_allowing_the_run_directory() {
        let run = PathBuf::from("/ws/.hilbert/run");
        let profile = seatbelt_profile(&[run.clone()], &[PathBuf::from("/home/u/.ssh")], false);
        let deny_writes = profile.find("(deny file-write*)").expect("deny");
        let allow_run = profile.find("/ws/.hilbert/run").expect("run dir");
        assert!(deny_writes < allow_run, "the allow has to come last to win:\n{profile}");
        assert!(profile.contains("(deny network*)"));
        assert!(profile.contains("(deny file-read*"));
        assert!(profile.starts_with("(version 1)"));
    }

    #[test]
    fn seatbelt_profile_survives_a_quote_in_a_path() {
        // A folder called `my "work"` is legal on macOS, and an unescaped quote
        // would end the string early and turn the rest of the path into
        // profile syntax.
        let odd = PathBuf::from("/Users/u/my \"work\"/run");
        let profile = seatbelt_profile(&[odd], &[], false);
        assert!(profile.contains(r#"(subpath "/Users/u/my \"work\"/run")"#), "{profile}");
    }

    #[test]
    fn a_missing_sandbox_confines_nothing() {
        if active().real() {
            let confined = confine("python3", &["_nb.py"], Path::new("."), "python").expect("confined");
            assert!(confined.args.iter().any(|a| a == "_nb.py"));
            assert!(confined.env.iter().any(|(k, _)| k == "TMPDIR"));
        } else {
            assert!(confine("python3", &["_nb.py"], Path::new("."), "python").is_none());
        }
    }
}
