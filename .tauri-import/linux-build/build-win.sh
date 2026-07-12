#!/usr/bin/env bash
# Runs inside the Windows cross-build container (Dockerfile.win). Produces the
# NSIS .exe installer for x86_64 Windows.
set -euo pipefail

cd /work/src-tauri
export CARGO_TARGET_DIR=/work/src-tauri/target-win

# cargo-xwin fetches the MSVC CRT/SDK headers on first use.
cargo tauri build \
  --runner cargo-xwin \
  --target x86_64-pc-windows-msvc \
  --bundles nsis

echo "== Windows bundles =="
find "$CARGO_TARGET_DIR" -type f \( -name '*.exe' -o -name '*.msi' \) -exec ls -lh {} \;
