import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = await mkdtemp(join(tmpdir(), 'hilbert-icons-'));
try {
  const result = spawnSync('cargo', ['tauri', 'icon', 'build/icon.svg', '--output', output], {
    cwd: root, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Icon generation failed (${result.status}).`);
  // Hilbert ships desktop targets; mobile assets are not part of this build.
  for (const entry of await readdir(output, { withFileTypes: true })) {
    if (entry.isFile() && /\.(png|ico|icns)$/.test(entry.name)) {
      await copyFile(join(output, entry.name), join(root, 'src-tauri/icons', entry.name));
    }
  }
  await copyFile(join(root, 'build/icon.svg'), join(root, 'public/favicon.svg'));
  console.log('Desktop icons and favicon generated from build/icon.svg.');
} finally {
  await rm(output, { recursive: true, force: true });
}
