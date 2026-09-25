use std::hash::{Hash, Hasher};
use std::path::Path;
use std::process::Command;

fn main() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    println!("cargo::rustc-check-cfg=cfg(hilbert_embedded_ui)");
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-changed=ui-dist/index.html");

    // Where the built interface comes from when the binary has to carry it.
    // The crate on crates.io ships it in ui-dist/, and `cargo install` of that
    // crate needs nothing else. A git checkout builds it with npm, when asked to
    // with --features embed-ui. An ordinary build embeds nothing: the app
    // bundle puts the interface beside the binary instead.
    let packaged = manifest.join("ui-dist");
    let repo_dist = manifest.join("../dist");
    let ui = if packaged.join("index.html").is_file() {
        Some(packaged)
    } else if std::env::var_os("CARGO_FEATURE_EMBED_UI").is_some() {
        if !repo_dist.join("index.html").is_file() {
            build_interface(&manifest.join(".."));
        }
        Some(repo_dist.clone())
    } else {
        None
    };
    if let Some(ui) = ui {
        let ui = ui.canonicalize().expect("the built interface folder");
        let index = std::fs::read(ui.join("index.html")).expect("the built interface has an index.html");
        // index.html names every asset by its content hash, so this changes
        // whenever the interface does; the binary unpacks it under this name.
        let mut stamp = std::collections::hash_map::DefaultHasher::new();
        index.hash(&mut stamp);
        println!("cargo::rustc-cfg=hilbert_embedded_ui");
        println!("cargo::rustc-env=HILBERT_UI_DIST={}", ui.display());
        println!("cargo::rustc-env=HILBERT_UI_STAMP={:016x}", stamp.finish());
    }

    // Outside the repository (the published crate) there is no ../dist to
    // bundle beside the app, and the snapshot of Typst packages is left out to
    // keep the crate under crates.io's size limit; Typst fetches packages on
    // first use anyway. Tauri copies bundle resources at build time and would
    // stop at the missing paths, so they are taken out of its config here.
    let mut dropped = Vec::new();
    if !repo_dist.exists() {
        dropped.push("\"../dist\":null");
    }
    if !manifest.join("resources/typst-packages").exists() {
        dropped.push("\"resources/typst-packages\":null");
    }
    if !dropped.is_empty() && std::env::var_os("TAURI_CONFIG").is_none() {
        let patch = format!("{{\"bundle\":{{\"resources\":{{{}}}}}}}", dropped.join(","));
        // SAFETY: the build script is single-threaded at this point.
        unsafe { std::env::set_var("TAURI_CONFIG", patch) };
    }

    tauri_build::build()
}

// `npm ci` then `npm run build` at the repository root: the same build the
// release uses, including the step that strips a third-party key out of the
// bundle.
fn build_interface(root: &Path) {
    for args in [&["ci", "--no-audit", "--no-fund"][..], &["run", "build"][..]] {
        let mut command = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "npm"]);
            c
        } else {
            Command::new("npm")
        };
        let status = command.args(args).current_dir(root).status().unwrap_or_else(|error| {
            panic!(
                "Building Hilbert's interface needs Node.js and npm ({error}). Install Node.js, \
                 or install the published crate with `cargo install hilbert-editor`, which already \
                 carries the interface."
            )
        });
        assert!(status.success(), "`npm {}` failed while building Hilbert's interface", args.join(" "));
    }
}
