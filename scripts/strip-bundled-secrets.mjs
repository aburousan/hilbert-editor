// Some dependencies (notably @excalidraw/excalidraw) ship their OWN public
// Firebase / Google web API keys inside their published npm package. Those keys
// get bundled into dist/ during `vite build`. They are third-party public client
// identifiers — not our secrets — but because the Tauri edition commits its built
// dist/, GitHub secret scanning would flag the `AIza…` string.
//
// This runs after the build and neutralizes any such key in the emitted bundle,
// so the committed UI never carries a third-party key. Safe: the app doesn't use
// Excalidraw's collaboration/cloud features (the whiteboard is fully local), so
// the key was dead weight anyway.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const distDir = join(process.cwd(), 'dist');
const BUNDLED_CREDENTIALS = [
  /AIza[0-9A-Za-z_-]{35}/g,
  /AKIA[0-9A-Z]{16}/g,
];
const FORBIDDEN_CREDENTIALS = [
  ...BUNDLED_CREDENTIALS,
  /ASIA[0-9A-Z]{16}/g,
  /github_pat_[0-9A-Za-z_]{20,}/g,
  /gh[pousr]_[0-9A-Za-z]{20,}/g,
  /sk-proj-[0-9A-Za-z_-]{20,}/g,
  /sk-[0-9A-Za-z]{40,}/g,
  /xox[baprs]-[0-9A-Za-z-]{10,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.map', '.mjs', '.svg', '.txt']);

const textFiles = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (TEXT_EXTENSIONS.has(extname(name))) textFiles.push(path);
  }
};

let files = 0;
try {
  walk(distDir);
  for (const path of textFiles) {
    const src = readFileSync(path, 'utf8');
    let scrubbed = src;
    for (const pattern of BUNDLED_CREDENTIALS) {
      scrubbed = scrubbed.replace(pattern, 'bundled-third-party-key-removed');
    }
    if (scrubbed !== src) {
      writeFileSync(path, scrubbed);
      files++;
    }
  }
} catch (e) {
  console.error('strip-bundled-secrets: failed —', e.message);
  process.exit(1);
}

const unsafe = [];
for (const path of textFiles) {
  const src = readFileSync(path, 'utf8');
  if (FORBIDDEN_CREDENTIALS.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(src);
  })) unsafe.push(relative(distDir, path));
}
if (unsafe.length) {
  console.error(`strip-bundled-secrets: credential-like value remains in ${unsafe.join(', ')}`);
  process.exit(1);
}

console.log(`strip-bundled-secrets: neutralized bundled third-party credentials in ${files} file(s).`);
