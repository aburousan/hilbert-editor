# Builds the Linux desktop bundles (AppImage + .deb) in a container, since Tauri
# links against WebKitGTK and cannot cross-compile from macOS. The compiled
# src-tauri/target is written back to a mounted volume.
#
# IMPORTANT — build on the OLDEST distro we support (Ubuntu 22.04 = the base of
# Pop!_OS 22.04 and Ubuntu 22.04/Mint 21). The AppImage bundles the *build host's*
# libpango; if the host is newer than the target, that libpango references
# harfbuzz symbols the target's older system libharfbuzz.so.0 lacks — e.g. the
# crash on Pop!_OS 22.04:
#   symbol lookup error: .../libpango-1.0.so.0: undefined symbol:
#   hb_ot_layout_get_horizontal_baseline_tag_for_script
# (linuxdeploy bundles pango + harfbuzz-icu but excludes the main libharfbuzz.so.0
# as a "system" lib, so the bundled pango resolves it against the old target one.)
# The previous base was `rust:1-bookworm` (Debian 12) whose pango 1.50.12 needs a
# harfbuzz newer than 22.04 ships. Jammy's pango matches 22.04's harfbuzz and is
# forward-compatible with every newer distro.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    patchelf \
    file \
    desktop-file-utils \
    libssl-dev \
    pkg-config \
    curl \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# AppImage tooling needs FUSE at runtime; in a container we extract instead.
ENV APPIMAGE_EXTRACT_AND_RUN=1

# The Ubuntu base ships no Rust — install the stable toolchain via rustup.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

RUN cargo install tauri-cli --version "^2" --locked

WORKDIR /work
CMD ["bash", "/work/linux-build/build.sh"]
