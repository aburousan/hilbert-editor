import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import ts from 'typescript';
import * as Y from 'yjs';

// Transpile the three source modules into a temp dir at the repo root so their
// relative imports resolve to each other and their bare `yjs` import resolves to
// the same instance this test uses (Node caches modules by resolved path).
const OUT = resolve('.sync-build-tmp');
async function build(name) {
  const src = await readFile(resolve('src', name + '.ts'), 'utf8');
  let js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  js = js.replace(/from '(\.\/[A-Za-z0-9_]+)'/g, "from '$1.mjs'");
  await writeFile(resolve(OUT, name + '.mjs'), js);
}
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const n of ['workspaceSync', 'binaryTransfer', 'projectFileTypes', 'projectCollab']) await build(n);

const { WorkspaceModel } = await import(resolve(OUT, 'workspaceSync.mjs'));
const { BinaryTransfer } = await import(resolve(OUT, 'binaryTransfer.mjs'));
const { ProjectSync } = await import(resolve(OUT, 'projectCollab.mjs'));

const sha256 = async b => createHash('sha256').update(b).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitUntil(cond, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) { if (await cond()) return true; await sleep(20); }
  return false;
}

// A minimal workspace on disk, in memory.
function makeFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    async list() { return [...files.keys()].map(path => ({ path })); },
    async readText(p) { const f = files.get(p); if (!f || f.text == null) throw new Error('no text ' + p); return f.text; },
    async readBinary(p) { const f = files.get(p); if (!f || !f.bytes) throw new Error('no bytes ' + p); return f.bytes; },
    async writeText(p, c) { files.set(p, { text: c }); },
    async writeBinary(p, b) { files.set(p, { bytes: Uint8Array.from(b) }); },
    async remove(p) { files.delete(p); },
  };
}

// The content-blind broadcast relay, in memory (no echo, lossless).
function makeRelay() {
  const peers = new Set();
  return {
    join() {
      const peer = { handler: null };
      peers.add(peer);
      return {
        send(frame) {
          const copy = frame.slice();
          for (const p of peers) if (p !== peer && p.handler) setTimeout(() => p.handler(copy.slice()), 0);
        },
        subscribe(cb) { peer.handler = cb; return () => peers.delete(peer); },
      };
    },
  };
}

const img = randomBytes(30 * 1024 + 11);   // multi-chunk binary
const board = randomBytes(5000);           // an svg-as-asset
const boardSource = Buffer.from('{"type":"excalidraw","version":2,"elements":[]}');
const hostFs = makeFs({
  'main.typ': { text: '#import "chapters/intro.typ"\n= Title\n' },
  'chapters/intro.typ': { text: 'Intro paragraph.\n' },
  'img/fig.png': { bytes: img },
  'board.svg': { bytes: board },
  'board.excalidraw': { bytes: boardSource },
});
const joinFs = makeFs();

const hostDoc = new Y.Doc();
const joinDoc = new Y.Doc();
const forward = (from, to) => from.on('update', (u, origin) => { if (origin === 'remote') return; Y.applyUpdate(to, u, 'remote'); });
forward(hostDoc, joinDoc);
forward(joinDoc, hostDoc);

const relay = makeRelay();
const tOpts = { chunkSize: 1024, windowSize: 8, ackTimeoutMs: 40, requestRetryMs: 70, overallTimeoutMs: 8000, hashBytes: sha256 };
const hostCh = relay.join();
const joinCh = relay.join();
const hostTransfer = new BinaryTransfer(hostCh, { ...tOpts, peerId: 'host' });
const joinTransfer = new BinaryTransfer(joinCh, { ...tOpts, peerId: 'join' });

const joinModel = new WorkspaceModel(joinDoc);
const hostModel = new WorkspaceModel(hostDoc);
const host = new ProjectSync({ model: hostModel, transfer: hostTransfer, fs: hostFs, hashBytes: sha256 });
let joinApplyIdle = 0;
const join = new ProjectSync({
  model: joinModel,
  transfer: joinTransfer,
  fs: joinFs,
  hashBytes: sha256,
  onApplyIdle: () => { joinApplyIdle++; },
});
let late = null;
let lateTransfer = null;

let failed = false;
try {
  // The active editor may contain unsaved work. It is seeded into the model
  // before publishWorkspace runs, so publishing disk files must not replace it.
  hostModel.setText('main.typ', '= Unsaved host buffer\n');
  host.setOpenPath('main.typ');
  host.start();
  join.start();
  await host.publishWorkspace();
  await join.applyWorkspace();
  assert.equal(hostModel.readText('main.typ'), '= Unsaved host buffer\n');

  // The whole project reaches the joiner: text verbatim, binaries by hash.
  const gotAll = await waitUntil(async () =>
    joinFs.files.has('main.typ') && joinFs.files.has('chapters/intro.typ') &&
    joinFs.files.has('img/fig.png') && joinFs.files.has('board.svg') &&
    joinFs.files.has('board.excalidraw'));
  assert.ok(gotAll, 'joiner did not receive the whole project');
  assert.equal((await joinFs.readText('main.typ')), '= Unsaved host buffer\n');
  assert.equal((await joinFs.readText('chapters/intro.typ')), 'Intro paragraph.\n');
  assert.equal(await sha256(await joinFs.readBinary('img/fig.png')), await sha256(img));
  assert.equal(await sha256(await joinFs.readBinary('board.svg')), await sha256(board));
  assert.equal(await sha256(await joinFs.readBinary('board.excalidraw')), await sha256(boardSource));
  assert.equal(joinApplyIdle, 1, 'initial multi-file import did not settle as one apply batch');

  // The app's real join flow receives the Yjs document before ProjectSync is
  // constructed, then imports that already-present model into a new empty
  // workspace. applyWorkspace covers that late-listener path, including assets.
  const lateDoc = new Y.Doc();
  Y.applyUpdate(lateDoc, Y.encodeStateAsUpdate(hostDoc), 'remote');
  const lateFs = makeFs();
  lateTransfer = new BinaryTransfer(relay.join(), { ...tOpts, peerId: 'late' });
  late = new ProjectSync({
    model: new WorkspaceModel(lateDoc),
    transfer: lateTransfer,
    fs: lateFs,
    hashBytes: sha256,
  });
  late.start();
  await late.applyWorkspace();
  assert.equal(await lateFs.readText('main.typ'), '= Unsaved host buffer\n');
  assert.equal(await sha256(await lateFs.readBinary('img/fig.png')), await sha256(img));
  assert.equal(await sha256(await lateFs.readBinary('board.svg')), await sha256(board));

  // A host text edit lands on the joiner's disk.
  await hostFs.writeText('main.typ', '= New Title\n');
  host.onLocalText('main.typ', '= New Title\n');
  assert.ok(await waitUntil(async () => (await joinFs.readText('main.typ').catch(() => '')) === '= New Title\n'),
    'text edit did not propagate');

  // A generated plot promoted into assets/ is fetched by the joiner.
  const img2 = randomBytes(12 * 1024);
  await hostFs.writeBinary('assets/generated.png', img2);
  await host.onLocalBinary('assets/generated.png');
  assert.ok(await waitUntil(async () => joinFs.files.has('assets/generated.png') &&
    (await sha256(await joinFs.readBinary('assets/generated.png'))) === (await sha256(img2))),
    'generated plot did not arrive');

  // Replacing an existing binary's content (new hash) re-syncs it.
  const img3 = randomBytes(9 * 1024);
  await hostFs.writeBinary('img/fig.png', img3);
  await host.onLocalBinary('img/fig.png');
  assert.ok(await waitUntil(async () => (await sha256(await joinFs.readBinary('img/fig.png'))) === (await sha256(img3))),
    'replaced binary did not re-sync');

  // Excalidraw files are binary-channel assets even while open. Saving on one
  // peer must replace the other peer's local scene file; the app then remounts
  // its open canvas from these received bytes.
  join.setOpenPath('board.excalidraw');
  const boardSource2 = Buffer.from('{"type":"excalidraw","version":2,"elements":[{"id":"remote"}]}');
  await hostFs.writeBinary('board.excalidraw', boardSource2);
  await host.onLocalBinary('board.excalidraw');
  assert.ok(await waitUntil(async () =>
    (await sha256(await joinFs.readBinary('board.excalidraw'))) === (await sha256(boardSource2))),
    'open whiteboard file did not re-sync');

  // A host delete removes the file on the joiner. The app deletes from disk
  // first and then announces it, so do both here.
  await hostFs.remove('chapters/intro.typ');
  host.onLocalRemove('chapters/intro.typ');
  assert.ok(await waitUntil(async () => !joinFs.files.has('chapters/intro.typ')), 'delete did not propagate');

  // Sync is two-way: a file the joiner creates reaches the host.
  await joinFs.writeText('notes.md', 'hello from joiner');
  join.onLocalText('notes.md', 'hello from joiner');
  assert.ok(await waitUntil(async () => (await hostFs.readText('notes.md').catch(() => '')) === 'hello from joiner'),
    'joiner -> host edit did not propagate');

  // Open-file ownership: a peer must NOT write its own open file to disk from
  // the model (Monaco binding + autosave own it). With main.typ set as the
  // joiner's open file, a host edit to main.typ must not overwrite joinFs, while
  // a non-open file still syncs normally.
  join.setOpenPath('main.typ');
  await hostFs.writeText('main.typ', '= Edited While Open\n');
  host.onLocalText('main.typ', '= Edited While Open\n');
  await hostFs.writeText('sidebar.typ', 'sidebar body');
  host.onLocalText('sidebar.typ', 'sidebar body');
  // The non-open file lands; give the open-file change the same window to (not) land.
  assert.ok(await waitUntil(async () => (await joinFs.readText('sidebar.typ').catch(() => '')) === 'sidebar body'),
    'non-open file did not sync');
  assert.notEqual(await joinFs.readText('main.typ').catch(() => ''), '= Edited While Open\n',
    'open file was overwritten on disk by ProjectSync (should be left to the binding/autosave)');
  // The model still carries the latest text (the binding would surface it live).
  assert.equal(joinModel.readText('main.typ'), '= Edited While Open\n');

  // Identical bytes at multiple paths share one provider. Removing one path
  // must not withdraw the hash while another copy remains available.
  {
    const duplicate = randomBytes(2048);
    const duplicateHash = await sha256(duplicate);
    const duplicateFs = makeFs({
      'assets/one.bin': { bytes: duplicate },
      'assets/two.bin': { bytes: duplicate },
    });
    const providers = new Map();
    const fakeTransfer = {
      provide(hash, getter) { providers.set(hash, getter); },
      unprovide(hash) { providers.delete(hash); },
      request() { throw new Error('not used'); },
    };
    const isolated = new ProjectSync({
      model: new WorkspaceModel(new Y.Doc()),
      transfer: fakeTransfer,
      fs: duplicateFs,
      hashBytes: sha256,
    });
    await isolated.publishWorkspace();
    assert.ok(providers.has(duplicateHash));
    await duplicateFs.remove('assets/one.bin');
    isolated.onLocalRemove('assets/one.bin');
    assert.ok(providers.has(duplicateHash), 'deleting one duplicate withdrew the remaining provider');
    assert.ok(Buffer.from(await providers.get(duplicateHash)()).equals(duplicate));
    await duplicateFs.remove('assets/two.bin');
    isolated.onLocalRemove('assets/two.bin');
    assert.ok(!providers.has(duplicateHash), 'last duplicate did not withdraw its provider');
  }

  // Rejoining a folder kept from an earlier session. The returning peer starts
  // with a stale copy of the project plus one file only it has, and the session
  // meanwhile deleted a file that peer still holds on disk.
  {
    const rejoinFs = makeFs({
      'main.typ': { text: '= Stale local copy\n' },
      'chapters/intro.typ': { text: 'Intro paragraph.\n' },   // deleted in the session above
      'my-notes.md': { text: 'only on this machine' },        // never shared
    });
    // A real rejoin gets the session state on connect and then stays two-way.
    const rejoinDoc = new Y.Doc();
    Y.applyUpdate(rejoinDoc, Y.encodeStateAsUpdate(hostDoc), 'remote');
    forward(rejoinDoc, hostDoc);
    forward(hostDoc, rejoinDoc);
    const rejoinModel = new WorkspaceModel(rejoinDoc);
    const rejoinTransfer = new BinaryTransfer(relay.join(), { ...tOpts, peerId: 'rejoin' });
    const rejoin = new ProjectSync({
      model: rejoinModel,
      transfer: rejoinTransfer,
      fs: rejoinFs,
      hashBytes: sha256,
    });
    try {
      rejoin.start();
      await rejoin.applyWorkspace();
      // The session's version wins over the stale local one.
      assert.equal(await rejoinFs.readText('main.typ'), '= Edited While Open\n',
        'rejoin did not take the session version of a file it already had');

      const tombstoned = await rejoin.reconcileLocalWorkspace();
      assert.deepEqual(tombstoned, ['chapters/intro.typ'],
        'rejoin did not report exactly the file deleted while this peer was away');
      // A local-only file is published rather than stranded...
      assert.ok(await waitUntil(async () =>
        (await hostFs.readText('my-notes.md').catch(() => '')) === 'only on this machine'),
        'local-only file was not shared on rejoin');
      // ...while the deleted one is NOT resurrected for everyone else.
      assert.ok(!hostFs.files.has('chapters/intro.typ'),
        'rejoin resurrected a file the session had deleted');

      // Only once the user agrees does the local copy go.
      await rejoin.removeLocalCopies(tombstoned);
      assert.ok(!rejoinFs.files.has('chapters/intro.typ'), 'confirmed removal did not delete the local copy');
      assert.ok(rejoinFs.files.has('my-notes.md'), 'removal touched a file it should not have');
    } finally {
      rejoin.stop();
      rejoinTransfer.close();
    }
  }

  console.log('project collab integration tests passed');
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  host.stop(); join.stop();
  late?.stop();
  hostTransfer.close(); joinTransfer.close();
  lateTransfer?.close();
  await rm(OUT, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
