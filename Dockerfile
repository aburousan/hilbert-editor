# Hilbert in a container, for people who would rather not install anything.
#
# The same binary that runs the desktop app also has a hosted mode: it serves
# the built UI, signs visitors in against a token, keeps one server-side
# project, and runs the compiler and the collaboration relay on that one port.
# That is what this image starts — see the hosted-workspace section of
# docs/COLLABORATION.md for what the mode does and does not promise.

# ==========================================
# Stage 1: build the UI and the server binary
# ==========================================
FROM ubuntu:24.04 AS builder

ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
ENV PUPPETEER_SKIP_DOWNLOAD=true

RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        libgtk-3-dev \
        libjavascriptcoregtk-4.1-dev \
        libsoup-3.0-dev \
        libssl-dev \
        pkg-config \
        webkit2gtk-4.1-dev \
        xz-utils \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.cargo/bin:${PATH}"

# Hilbert shells out to typst and tinymist and finds them on PATH. Both publish
# prebuilt binaries, so take those rather than compiling two more Rust projects.
ARG TYPST_VERSION=0.15.1
ARG TINYMIST_VERSION=0.15.2
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
        amd64) arch=x86_64 ;; \
        arm64) arch=aarch64 ;; \
        *) echo "no prebuilt typst for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${arch}-unknown-linux-musl.tar.xz" \
        | tar -xJ -C /tmp; \
    mv "/tmp/typst-${arch}-unknown-linux-musl/typst" /usr/local/bin/typst; \
    curl -fsSL "https://github.com/Myriad-Dreamin/tinymist/releases/download/v${TINYMIST_VERSION}/tinymist-${arch}-unknown-linux-gnu.tar.gz" \
        | tar -xz -C /tmp; \
    find /tmp -type f -name tinymist -exec mv {} /usr/local/bin/tinymist \; ; \
    chmod +x /usr/local/bin/typst /usr/local/bin/tinymist; \
    typst --version; \
    tinymist --version

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run build

WORKDIR /app/src-tauri
RUN cargo build --release --locked

# ==========================================
# Stage 2: runtime
# ==========================================
FROM ubuntu:24.04 AS runner

ENV DEBIAN_FRONTEND=noninteractive

# bubblewrap is what normally confines code cells, and hosted mode refuses to
# run any code without it. It cannot work in an ordinary container: it needs to
# unmount the old root after pivot_root, and an unprivileged container's root is
# locked against that. Only --privileged makes it work, which gives away more
# than it protects. So the container itself is the boundary here, and the
# sandbox is switched off below rather than left to fail confusingly. It stays
# installed so `-e HILBERT_SANDBOX=auto --privileged` remains an option.
RUN apt-get update && apt-get install -y --no-install-recommends \
        bubblewrap \
        ca-certificates \
        libgtk-3-0 \
        libjavascriptcoregtk-4.1-0 \
        libsoup-3.0-0 \
        libssl3 \
        libwebkit2gtk-4.1-0 \
        python3 \
        python3-matplotlib \
        python3-numpy \
        python3-sympy \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/src-tauri/target/release/typst-editor /usr/local/bin/hilbert
COPY --from=builder /app/dist /usr/local/share/hilbert/dist
COPY --from=builder /usr/local/bin/typst /usr/local/bin/typst
COPY --from=builder /usr/local/bin/tinymist /usr/local/bin/tinymist
COPY docker/entrypoint.sh /usr/local/bin/hilbert-entrypoint

# uid 1000 is `ubuntu` in this base image and the first login user on most Linux
# desktops, so a bind-mounted folder usually lands with the right owner.
RUN mkdir -p /app/data /app/home \
    && chown -R 1000:1000 /app \
    && chmod +x /usr/local/bin/hilbert-entrypoint

ENV HOME=/app/home \
    TYPST_DIST=/usr/local/share/hilbert/dist \
    TYPST_WORKSPACE=/app/data \
    HILBERT_BIND=0.0.0.0 \
    HILBERT_PORT=3001 \
    HILBERT_SANDBOX=off

USER 1000:1000
WORKDIR /app/data
EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/hilbert-entrypoint"]
