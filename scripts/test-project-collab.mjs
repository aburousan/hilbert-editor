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

  // A host text edit lands on the joiner's disk. main.typ is the host's open
  // file, so its edits travel the way the Monaco binding makes them — through
  // the bound Y.Text — not as a whole-file push.
  const typeInto = (model, doc, path, content) => {
    const text = model.textOf(path);
    doc.transact(() => { text.delete(0, text.length); text.insert(0, content); });
  };
  await hostFs.writeText('main.typ', '= New Title\n');
  typeInto(hostModel, hostDoc, 'main.typ', '= New Title\n');
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
  typeInto(hostModel, hostDoc, 'main.typ', '= Edited While Open\n');
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

  // Binding the open editor to a path the session has not published yet must not
  // leave a shared empty Y.Text behind. Two peers each writing their own copy
  // into one empty Y.Text insert at 0 with nothing to delete, so the CRDT keeps
  // both and the file ends up holding each peer's version end to end — the
  // duplication a rejoin used to cause, because rejoining keeps the tabs open
  // and binds them the moment sync lands.
  {
    const HOST_TEXT = '= Shared notes\nWritten in session one.\n';
    const GUEST_TEXT = '= Shared notes\nEdited after the session ended.\n';
    for (const guestWinsRace of [false, true]) {
      const aDoc = new Y.Doc();
      const bDoc = new Y.Doc();
      const a = new WorkspaceModel(aDoc);
      const b = new WorkspaceModel(bDoc);

      // The rejoining peer binds its still-open tab before that path arrives.
      b.textOf('main.typ', GUEST_TEXT);
      Y.applyUpdate(aDoc, Y.encodeStateAsUpdate(bDoc));

      // Both sides then write their own full copy before hearing from the other.
      if (guestWinsRace) {
        a.setText('main.typ', HOST_TEXT);
        b.setText('main.typ', GUEST_TEXT);
      } else {
        b.setText('main.typ', GUEST_TEXT);
        a.setText('main.typ', HOST_TEXT);
      }
      const fromB = Y.encodeStateAsUpdate(bDoc, Y.encodeStateVector(aDoc));
      const fromA = Y.encodeStateAsUpdate(aDoc, Y.encodeStateVector(bDoc));
      Y.applyUpdate(aDoc, fromB);
      Y.applyUpdate(bDoc, fromA);

      const merged = a.textOf('main.typ').toString();
      assert.equal(merged, b.textOf('main.typ').toString(), 'peers did not converge');
      assert.equal(merged.split('= Shared notes').length - 1, 1,
        `both copies survived in one file (guestWinsRace=${guestWinsRace}): ${JSON.stringify(merged)}`);
      assert.ok(merged === HOST_TEXT || merged === GUEST_TEXT,
        `neither peer's version survived intact: ${JSON.stringify(merged)}`);
    }
  }

  // A binary nobody could serve fails once and then has nothing to retry from:
  // the model already names the file, so no further change event ever arrives.
  // A peer that turns up later has to be able to recover it.
  {
    const reachable = makeRelay();
    const unreachable = makeRelay();
    const fastFail = { ...tOpts, overallTimeoutMs: 300, requestRetryMs: 60 };

    const ownerDoc = new Y.Doc();
    const needyDoc = new Y.Doc();
    forward(ownerDoc, needyDoc);
    forward(needyDoc, ownerDoc);

    const plot = randomBytes(3000);
    const plotHash = await sha256(plot);
    const ownerModel = new WorkspaceModel(ownerDoc);
    const needyModel = new WorkspaceModel(needyDoc);
    const needyFs = makeFs();

    // The owner announces the file on a channel the needy peer cannot reach.
    const ownerTransfer = new BinaryTransfer(unreachable.join(), { ...fastFail, peerId: 'owner' });
    const owner = new ProjectSync({
      model: ownerModel, transfer: ownerTransfer,
      fs: makeFs({ 'img/plot.png': { bytes: plot } }), hashBytes: sha256,
    });
    const errors = [];
    const needyTransfer = new BinaryTransfer(reachable.join(), { ...fastFail, peerId: 'needy' });
    const needy = new ProjectSync({
      model: needyModel, transfer: needyTransfer, fs: needyFs, hashBytes: sha256,
      onError: message => errors.push(message),
    });
    try {
      owner.start();
      needy.start();
      await owner.onLocalBinary('img/plot.png');
      await needy.applyWorkspace();
      assert.ok(!needyFs.files.has('img/plot.png'), 'test setup: the bytes were reachable after all');
      assert.ok(errors.some(message => message.includes('img/plot.png')),
        'a binary that could not be fetched was not reported');

      // Someone able to serve those bytes joins the needy peer's channel.
      const helper = new BinaryTransfer(reachable.join(), { ...fastFail, peerId: 'helper' });
      helper.provide(plotHash, async () => plot);
      try {
        await needy.resyncMissingBinaries();
        assert.ok(needyFs.files.has('img/plot.png'),
          'resync did not recover a binary whose first fetch had failed');
        assert.equal(await sha256(needyFs.files.get('img/plot.png').bytes), plotHash,
          'the recovered binary does not match the original bytes');
      } finally {
        helper.close();
      }
    } finally {
      owner.stop(); needy.stop();
      ownerTransfer.close(); needyTransfer.close();
    }
  }

  // Binding a tab the session tombstoned must not blank the user's buffer.
  // remove() empties the entry's Y.Text, so attaching to it would setValue('')
  // in the editor and autosave would then write that emptiness to disk — data
  // loss even when the user answers "keep my copy". Binding revives instead,
  // and with a FRESH entry: the old Y.Text has shared history, so two peers
  // reviving it concurrently would otherwise double-insert.
  {
    const KEEP_A = '= Peer A kept these edits\n';
    const KEEP_B = '= Peer B kept different edits\n';

    const aDoc = new Y.Doc();
    const bDoc = new Y.Doc();
    const a = new WorkspaceModel(aDoc);
    const b = new WorkspaceModel(bDoc);
    a.setText('notes.typ', '= Old shared content\n');
    a.remove('notes.typ');
    Y.applyUpdate(bDoc, Y.encodeStateAsUpdate(aDoc));

    // Both peers rejoin with the deleted file still open, and bind concurrently.
    const textA = a.textOf('notes.typ', KEEP_A);
    b.textOf('notes.typ', KEEP_B);
    assert.equal(textA.toString(), KEEP_A, 'binding a tombstoned entry blanked the buffer');
    assert.equal(a.metaOf('notes.typ').deleted, false, 'binding did not revive the tombstoned entry');
    assert.equal(b.readText('notes.typ'), KEEP_B, 'revived entry is not readable as a live file');

    const fromB = Y.encodeStateAsUpdate(bDoc, Y.encodeStateVector(aDoc));
    const fromA = Y.encodeStateAsUpdate(aDoc, Y.encodeStateVector(bDoc));
    Y.applyUpdate(aDoc, fromB);
    Y.applyUpdate(bDoc, fromA);

    const merged = a.readText('notes.typ');
    assert.equal(merged, b.readText('notes.typ'), 'peers did not converge after concurrent revive');
    assert.ok(merged === KEEP_A || merged === KEEP_B,
      `concurrent revives merged into a corrupted file: ${JSON.stringify(merged)}`);
  }

  // A rejoin reuses a folder that already holds most binaries from last time.
  // applyWorkspace enqueues every advertised binary, so without the local-hash
  // short-circuit the whole asset set is pulled back through the transfer
  // channel on every rejoin. With it, bytes already on disk never hit the
  // network — proven here by making the network unable to serve them at all.
  {
    const img = randomBytes(4096);
    const imgHash = await sha256(img);
    const sessionDoc = new Y.Doc();
    const model = new WorkspaceModel(sessionDoc);
    model.setBinary('img/figure.png', imgHash, img.length);

    const errors = [];
    const deadTransfer = new BinaryTransfer(makeRelay().join(), {
      ...tOpts, overallTimeoutMs: 250, requestRetryMs: 60, peerId: 'rejoiner',
    });
    const fs = makeFs({ 'img/figure.png': { bytes: img } });
    const rejoiner = new ProjectSync({
      model, transfer: deadTransfer, fs, hashBytes: sha256,
      onError: message => errors.push(message),
    });
    try {
      rejoiner.start();
      await rejoiner.applyWorkspace();
      assert.deepEqual(errors, [],
        `a binary already on disk was fetched over the network: ${errors.join('; ')}`);
      assert.equal(await sha256(fs.files.get('img/figure.png').bytes), imgHash);
    } finally {
      rejoiner.stop();
      deadTransfer.close();
    }
  }

  // Binary fetches in one batch must run in parallel, and the applyingRemote
  // flag must stay raised until the LAST overlapping write finishes. The
  // provider here refuses to serve anything until all three binaries have been
  // asked for — a serial pipeline deadlocks on that barrier and times out, so
  // only genuine parallelism passes. A fourth advertised binary that nobody can
  // serve checks that one failure doesn't take down the rest of the batch.
  {
    const relay2 = makeRelay();
    const fast = { ...tOpts, overallTimeoutMs: 400, requestRetryMs: 50 };
    const blobs = new Map();
    for (const name of ['a.png', 'b.png', 'c.png']) {
      const bytes = randomBytes(2500);
      blobs.set(name, { bytes, hash: await sha256(bytes) });
    }

    const asked = new Set();
    let openBarrier;
    const allAsked = new Promise(resolve => { openBarrier = resolve; });
    const server = new BinaryTransfer(relay2.join(), { ...fast, peerId: 'server' });
    for (const [name, { bytes, hash }] of blobs) {
      server.provide(hash, async () => {
        asked.add(name);
        if (asked.size === blobs.size) openBarrier();
        await allAsked;
        return bytes;
      });
    }

    const model = new WorkspaceModel(new Y.Doc());
    for (const [name, { bytes, hash }] of blobs) model.setBinary('img/' + name, hash, bytes.length);
    model.setBinary('img/zz-missing.png', await sha256(randomBytes(64)), 64);

    const fs = makeFs();
    const flagDuringWrite = [];
    const baseWrite = fs.writeBinary.bind(fs);
    fs.writeBinary = async (path, bytes) => {
      await sleep(25);   // stretch the writes so they overlap
      flagDuringWrite.push(consumer.applyingRemote);
      return baseWrite(path, bytes);
    };
    const errors = [];
    const consumerTransfer = new BinaryTransfer(relay2.join(), { ...fast, peerId: 'consumer' });
    const consumer = new ProjectSync({
      model, transfer: consumerTransfer, fs, hashBytes: sha256,
      onError: message => errors.push(message),
    });
    try {
      consumer.start();
      await consumer.applyWorkspace();
      for (const [name, { hash }] of blobs) {
        assert.ok(fs.files.has('img/' + name), `parallel fetch did not deliver img/${name}`);
        assert.equal(await sha256(fs.files.get('img/' + name).bytes), hash);
      }
      assert.equal(errors.length, 1, `expected exactly the unservable binary to fail: ${errors.join('; ')}`);
      assert.ok(errors[0].includes('zz-missing'), `wrong failure reported: ${errors[0]}`);
      assert.ok(flagDuringWrite.length === 3 && flagDuringWrite.every(Boolean),
        'applyingRemote dropped while overlapping remote writes were still in flight');
      assert.equal(consumer.applyingRemote, false, 'applyingRemote stuck raised after the batch');
    } finally {
      consumer.stop();
      consumerTransfer.close();
      server.close();
    }
  }

  // A file the editor has bound belongs to its Y.Text. Remote edits reach the
  // buffer through that binding, which leaves the tab looking modified, so the
  // app's autosave used to offer the whole buffer back as a local change — and
  // that replaced the shared text with one peer's stale snapshot, wiping out
  // everything the others had typed. Focusing an image made it certain: the
  // editor unbinds for a non-text tab, so the file stopped counting as "open"
  // and every compile republished it.
  {
    const aDoc = new Y.Doc();
    const bDoc = new Y.Doc();
    const a = new WorkspaceModel(aDoc);
    const b = new WorkspaceModel(bDoc);
    const aFs = makeFs({ 'main.typ': { text: '' } });
    const bFs = makeFs({ 'main.typ': { text: '' } });
    const aTransfer = new BinaryTransfer(makeRelay().join(), { ...tOpts, peerId: 'clobber-a' });
    const bTransfer = new BinaryTransfer(makeRelay().join(), { ...tOpts, peerId: 'clobber-b' });
    const aSync = new ProjectSync({ model: a, transfer: aTransfer, fs: aFs, hashBytes: sha256 });
    const bSync = new ProjectSync({ model: b, transfer: bTransfer, fs: bFs, hashBytes: sha256 });
    try {
      a.setText('main.typ', 'line one\n');
      Y.applyUpdate(bDoc, Y.encodeStateAsUpdate(aDoc), 'remote');
      forward(aDoc, bDoc);
      forward(bDoc, aDoc);
      aSync.start();
      bSync.start();
      aSync.setOpenPath('main.typ');
      bSync.setOpenPath('main.typ');

      const aText = a.textOf('main.typ');
      const bText = b.textOf('main.typ');
      aText.insert(aText.length, 'A typed this\n');
      bText.insert(bText.length, 'B typed this\n');
      const merged = aText.toString();
      assert.equal(merged, bText.toString(), 'peers did not converge before the tab switch');
      assert.ok(merged.includes('A typed this') && merged.includes('B typed this'),
        `both edits should be present: ${JSON.stringify(merged)}`);

      // A focuses an image. The editor unbinds, so the app reports no open text
      // file, and A's autosave then pushes the buffer it still holds — which
      // predates B's last edit.
      aSync.setOpenPath('images/fig.png');
      assert.equal(aSync.applyingRemote, false);
      aSync.onLocalText('main.typ', 'line one\nA typed this\n');
      await sleep(20);

      assert.equal(bText.toString(), merged,
        `a stale buffer replaced the shared document: ${JSON.stringify(bText.toString())}`);
      assert.equal(aText.toString(), merged, 'peers diverged after the stale push');

      // A file the editor never bound is still shared by whole-file push — that
      // is how an external tool's or a code cell's output reaches the session.
      bSync.onLocalText('generated.typ', 'from a code run\n');
      await sleep(20);
      assert.equal(a.readText('generated.typ'), 'from a code run\n',
        'an unbound file stopped syncing');
    } finally {
      aSync.stop(); bSync.stop();
      aTransfer.close(); bTransfer.close();
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
