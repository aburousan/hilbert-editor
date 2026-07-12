#!/usr/bin/env bash
# Runs inside the container (see Dockerfile). Builds the Linux bundles from the
# mounted project and leaves them under src-tauri/target/release/bundle/.
set -euo pipefail

cd /work/src-tauri

# Keep the container's compiled artifacts separate from the host's macOS target
# dir (mounted at the same path) so they never clobber each other.
export CARGO_TARGET_DIR=/work/src-tauri/target-linux

cargo tauri build --bundles appimage deb

echo "== Linux bundles =="
find "$CARGO_TARGET_DIR" -type f \( -name '*.AppImage' -o -name '*.deb' \) -exec ls -lh {} \;
