# ==========================================
# Stage 1: Build Frontend, Backend, and Fetch CLI Tools
# ==========================================
FROM ubuntu:24.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install System Dependencies, Node.js, and Rust (added xz-utils for tar -xJ)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    build-essential \
    pkg-config \
    libssl-dev \
    libgtk-3-dev \
    webkit2gtk-4.1-dev \
    libjavascriptcoregtk-4.1-dev \
    libsoup-3.0-dev \
    unzip \
    xz-utils \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.cargo/bin:${PATH}"

# Install Typst using the direct fetch & extract method
ARG TYPST=0.15.1
ENV TYPST_VERSION=${TYPST}

RUN curl -fsSL \
        https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-x86_64-unknown-linux-musl.tar.xz \
    | tar -xJ \
    && mv typst-x86_64-unknown-linux-musl/typst /usr/local/bin/typst \
    && rm -rf typst-x86_64-unknown-linux-musl

# Download and extract pre-built Tinymist binary to the same bin directory
RUN mkdir -p /tmp/tinymist_ext \
    && curl -fsSL -o /tmp/tinymist.tar.gz "https://github.com/Myriad-Dreamin/tinymist/releases/download/v0.15.2/tinymist-x86_64-unknown-linux-gnu.tar.gz" \
    && tar -xzf /tmp/tinymist.tar.gz -C /tmp/tinymist_ext \
    && find /tmp/tinymist_ext -type f -name "tinymist" -exec mv {} /usr/local/bin/ \; \
    && chmod +x /usr/local/bin/typst /usr/local/bin/tinymist \
    && rm -rf /tmp/tinymist_ext /tmp/tinymist.tar.gz

WORKDIR /app

# Build the Vite frontend static files
COPY package.json package-lock.json* ./
RUN npm ci --legacy-peer-deps

COPY . .
RUN npm run build

# Patch the Rust source code to forcefully map workspaces to our Docker container's /app/data path
WORKDIR /app/src-tauri
RUN sed -i 's|/Users/think/Documents/Hilbert|/app/data|g' src/server.rs && \
    sed -i 's|dirs::home_dir().unwrap_or_default().join("Documents").join("Hilbert")|std::path::PathBuf::from("/app/data")|g' src/main.rs || true

# Build the Tauri Rust backend binary
RUN cargo build --release

# Dynamically locate and extract the compiled binary
RUN BIN_PATH=$(find /app -type f -maxdepth 4 -path "*/target/release/*" ! -name "*.*" ! -name "build" ! -name "deps" | head -n 1) && \
    if [ -n "$BIN_PATH" ]; then \
        cp "$BIN_PATH" /tmp/hilbert-backend; \
    else \
        echo "Binary not found!" && exit 1; \
    fi

# ==========================================
# Stage 2: Production Runtime Environment
# ==========================================
FROM ubuntu:24.04 AS runner

ENV DEBIAN_FRONTEND=noninteractive

# Install runtime libraries, Nginx, Supervisor, and Python (with data science libs)
RUN apt-get update && apt-get install -y --no-install-recommends \
    nginx \
    supervisor \
    ca-certificates \
    libssl3 \
    libgtk-3-0 \
    webkit2gtk-4.1-0 \
    libsoup-3.0-0 \
    python3 \
    python3-numpy \
    python3-matplotlib \
    python3-sympy \
    && rm -rf /var/lib/apt/lists/*

# Copy built web assets and backend executable
COPY --from=builder /app/dist /var/www/html
COPY --from=builder /tmp/hilbert-backend /usr/local/bin/hilbert-backend

# Copy external CLI dependencies required for PDF compilation and language features (now from /usr/local/bin)
COPY --from=builder /usr/local/bin/typst /usr/local/bin/typst
COPY --from=builder /usr/local/bin/tinymist /usr/local/bin/tinymist

# Create a dedicated isolated working directory and grant full privileges to www-data
RUN mkdir -p /app/data /var/log/supervisor /var/run /var/log/nginx /var/lib/nginx \
    && chown -R www-data:www-data /app/data /var/www/html /var/log/supervisor /var/run /var/log/nginx /var/lib/nginx \
    && chmod -R 777 /app/data

# Configure Nginx for SPA routing and API reverse-proxying with CORS & Auth fixes

RUN echo 'server { \
    listen 80; \
    server_name localhost; \
    root /var/www/html; \
    index index.html; \
    \
    # Tell Nginx how to handle file extensions, explicitly adding .mjs \
    include /etc/nginx/mime.types; \
    types { \
        application/javascript mjs; \
    } \
    \
    location / { \
        try_files $uri $uri/ /index.html; \
    } \
    location ~ ^/(workspace|lsp|api|compile|settings|session|status|recovery|run|packages)(/|$) { \
        proxy_pass http://127.0.0.1:3001; \
        proxy_http_version 1.1; \
        proxy_set_header X-API-Token "hilbert_production_secret_token_123456789"; \
        proxy_set_header Authorization "Bearer hilbert_production_secret_token_123456789"; \
        proxy_set_header Host 127.0.0.1:3001; \
        proxy_set_header Origin "http://127.0.0.1:3001"; \
        proxy_set_header X-Real-IP $remote_addr; \
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; \
        proxy_set_header Upgrade $http_upgrade; \
        proxy_set_header Connection "upgrade"; \
    } \
}' > /etc/nginx/sites-available/default


# Configure Supervisor (HILBERT_SANDBOX="off" prevents bubblewrap crashes in unprivileged containers)
RUN echo '[supervisord]\n\
nodaemon=true\n\
user=root\n\
\n\
[program:nginx]\n\
command=nginx -g "daemon off;"\n\
autostart=true\n\
autorestart=true\n\
\n\
[program:tauri-backend]\n\
command=/usr/local/bin/hilbert-backend --headless --token hilbert_production_secret_token_123456789 --allow-origin "*"\n\
directory=/app/data\n\
user=www-data\n\
environment=HOME="/app/data",HILBERT_API_TOKEN="hilbert_production_secret_token_123456789",HILBERT_SANDBOX="off"\n\
autostart=true\n\
autorestart=true\n\
' > /etc/supervisor/conf.d/supervisord.conf

EXPOSE 80

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
