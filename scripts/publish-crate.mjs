// Publishes Hilbert to crates.io, so `cargo install hilbert-editor` works.
//
// A crate is built on its own, far from this repository, so it has to carry
// the built interface with it: this builds the interface the way a release
// does, copies it into src-tauri/ui-dist (never committed), checks it holds no
// key that should not be there, and hands the lot to cargo.
//
//   node scripts/publish-crate.mjs            dry run: package and check only
//   node scripts/publish-crate.mjs --publish  and publish
import { execFileSync } from 'node:child_process';
import { cpSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const tauri = join(root, 'src-tauri');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

run('npm', ['run', 'build']);
const ui = join(tauri, 'ui-dist');
rmSync(ui, { recursive: true, force: true });
cpSync(join(root, 'dist'), ui, { recursive: true });

// The same check the release relies on: a Google API key, a GitHub token or a
// private key must never reach a published artefact.
const leak = /AIza[0-9A-Za-z_-]{35}|ghp_[A-Za-z0-9]{36}|BEGIN[ A-Z]*PRIVATE KEY/;
const walk = dir => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const leaked = walk(ui).filter(file => leak.test(readFileSync(file, 'latin1')));
if (leaked.length) {
  console.error('Refusing to publish, secrets found in:\n  ' + leaked.join('\n  '));
  process.exit(1);
}

// ui-dist is ignored by git on purpose, hence --allow-dirty.
run('cargo', ['package', '--allow-dirty', '--no-verify'], tauri);
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const crate = join(tauri, 'target/package', `hilbert-editor-${version}.crate`);
const size = statSync(crate).size;
console.log(`crate: ${(size / 1048576).toFixed(1)} MB (crates.io accepts up to 10 MB)`);
if (size > 10 * 1048576) process.exit(1);

if (process.argv.includes('--publish')) run('cargo', ['publish', '--allow-dirty'], tauri);
