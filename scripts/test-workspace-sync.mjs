import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import * as Y from 'yjs';

const source = await readFile(resolve('src/workspaceSync.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
// The module bare-imports yjs; rewrite that to reuse this test's instance so
// both sides share one Yjs (Y.Text created here must be recognised there).
globalThis.__Y__ = Y;
const body = output.replace("import * as Y from 'yjs';", 'const Y = globalThis.__Y__;');
const mod = await import(`data:text/javascript;base64,${Buffer.from(body).toString('base64')}`);
const { WorkspaceModel, normalizeWorkspacePath } = mod;

// Path normalization refuses anything that could escape the project.
assert.equal(normalizeWorkspacePath('a/b.typ'), 'a/b.typ');
assert.equal(normalizeWorkspacePath('/a/b.typ'), 'a/b.typ');
assert.equal(normalizeWorkspacePath('a\\b.typ'), 'a/b.typ');
assert.equal(normalizeWorkspacePath('../secret'), null);
assert.equal(normalizeWorkspacePath('a/../../x'), null);
assert.equal(normalizeWorkspacePath('a/./b'), null);
assert.equal(normalizeWorkspacePath(''), null);

// Two peers, updates relayed both ways. The 'remote' origin tag stops an
// applied update from being echoed back into a loop.
const host = new WorkspaceModel(new Y.Doc());
const joiner = new WorkspaceModel(new Y.Doc());
const link = (from, to) => from.doc.on('update', (u, origin) => {
  if (origin === 'remote') return;
  Y.applyUpdate(to.doc, u, 'remote');
});
link(host, joiner);
link(joiner, host);

// Host seeds a small project.
host.setText('main.typ', '#import "chapters/intro.typ"\n= Title\n');
host.setText('chapters/intro.typ', 'Intro paragraph.\n');
host.setBinary('img/fig.png', 'hash-aaa', 1024);

// Joiner received the whole project.
assert.deepEqual(
  joiner.list().map(f => `${f.kind}:${f.path}`),
  ['text:chapters/intro.typ', 'binary:img/fig.png', 'text:main.typ'],
);
assert.equal(joiner.readText('main.typ'), '#import "chapters/intro.typ"\n= Title\n');
assert.equal(joiner.metaOf('img/fig.png').hash, 'hash-aaa');
assert.equal(joiner.metaOf('img/fig.png').size, 1024);

// Concurrent edits to the same open file converge (CRDT, not last-write).
host.textOf('main.typ').insert(0, 'HOST ');
joiner.textOf('main.typ').insert(joiner.textOf('main.typ').length, ' JOIN');
assert.equal(host.readText('main.typ'), joiner.readText('main.typ'));
assert.ok(host.readText('main.typ').includes('HOST '));
assert.ok(host.readText('main.typ').includes(' JOIN'));

// A remote delete propagates as a tombstone and leaves the file list.
const removals = [];
const off = joiner.observe(changes => {
  for (const c of changes) if (c.type === 'removed') removals.push(c.path);
});
host.remove('chapters/intro.typ');
assert.equal(joiner.readText('chapters/intro.typ'), null);
assert.ok(!joiner.list().some(f => f.path === 'chapters/intro.typ'));
assert.deepEqual(removals, ['chapters/intro.typ']);
off();

// A new hash on a binary reaches the peer so it knows to re-fetch the bytes.
host.setBinary('img/fig.png', 'hash-bbb', 2048);
assert.equal(joiner.metaOf('img/fig.png').hash, 'hash-bbb');
assert.equal(joiner.metaOf('img/fig.png').size, 2048);

// A joiner that connects late gets the current state in one sync, tombstone
// included (the removed file must not reappear on their disk).
const late = new WorkspaceModel(new Y.Doc());
Y.applyUpdate(late.doc, Y.encodeStateAsUpdate(host.doc), 'remote');
assert.ok(!late.list().some(f => f.path === 'chapters/intro.typ'));
assert.equal(late.readText('main.typ'), host.readText('main.typ'));
assert.equal(late.metaOf('img/fig.png').hash, 'hash-bbb');

// Updating one character in a large non-focused file must not retain a full
// delete-and-reinsert copy on every save. This guards long collaboration
// sessions against file_size × save_count Yjs growth.
{
  const stress = new WorkspaceModel(new Y.Doc());
  const prefix = 'x'.repeat(128 * 1024);
  stress.setText('large.typ', prefix + '0');
  for (let i = 1; i <= 200; i++) stress.setText('large.typ', prefix + String(i % 10));
  const encodedBytes = Y.encodeStateAsUpdate(stress.doc).byteLength;
  assert.ok(encodedBytes < 1024 * 1024, `incremental text history grew to ${encodedBytes} bytes`);
  assert.equal(stress.readText('large.typ'), prefix + '0');
  stress.doc.destroy();
}

// Deep events continue to resolve the right path after a large workspace is
// indexed; the common keystroke path uses the target index rather than a scan.
{
  const many = new WorkspaceModel(new Y.Doc());
  for (let i = 0; i < 1500; i++) many.setText(`chapters/${i}.typ`, `chapter ${i}`);
  const touched = [];
  const stop = many.observe(changes => touched.push(...changes.map(c => c.path)));
  many.textOf('chapters/1499.typ').insert(0, 'updated ');
  stop();
  assert.deepEqual(touched, ['chapters/1499.typ']);
  many.doc.destroy();
}

console.log('workspace sync model tests passed');
