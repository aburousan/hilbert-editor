import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import ts from 'typescript';

const source = await readFile(resolve('src/binaryTransfer.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { BinaryTransfer, __test } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const sha256 = async bytes => createHash('sha256').update(bytes).digest('hex');

// An in-memory stand-in for the content-blind relay: a framed message from one
// peer reaches every other peer (and the sender too when echo is on). A drop
// predicate lets a test withhold specific frames on their first pass to force
// the retransmit path.
function makeRelay({ echo = false, drop = null } = {}) {
  const peers = new Set();
  const seen = new Map();
  const frames = [];
  return {
    frames,
    join(handler) {
      const peer = { handler };
      peers.add(peer);
      return {
        send(frame) {
          const copy = frame.slice();
          frames.push(copy);
          const key = dropKey(copy);
          const n = (seen.get(key) || 0) + 1;
          seen.set(key, n);
          if (drop && drop(copy, n)) return;   // withhold this delivery
          for (const p of peers) {
            if (p === peer && !echo) continue;
            setTimeout(() => p.handler(copy.slice()), 0);
          }
        },
        subscribe: cb => { peer.handler = cb; return () => peers.delete(peer); },
      };
    },
  };
}

function dropKey(frame) {
  // type + header json (seq/hash) identifies a logical frame across resends.
  const type = frame[0];
  const len = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1);
  const header = Buffer.from(frame.subarray(5, 5 + len)).toString('utf8');
  return type + ':' + header;
}

function pair(relay, opts = {}) {
  let hostSub, joinSub;
  const hostCh = relay.join(f => hostSub && hostSub(f));
  const joinCh = relay.join(f => joinSub && joinSub(f));
  hostCh.subscribe = cb => { hostSub = cb; return () => {}; };
  joinCh.subscribe = cb => { joinSub = cb; return () => {}; };
  const base = { chunkSize: 1024, windowSize: 8, ackTimeoutMs: 40, requestRetryMs: 70, overallTimeoutMs: 8000, hashBytes: sha256 };
  const host = new BinaryTransfer({ send: hostCh.send, subscribe: hostCh.subscribe }, { ...base, ...opts, peerId: 'host' });
  const join = new BinaryTransfer({ send: joinCh.send, subscribe: joinCh.subscribe }, { ...base, ...opts, peerId: 'join' });
  return { host, join };
}

async function transfer({ bytes, relayOpts = {} }) {
  const relay = makeRelay(relayOpts);
  const { host, join } = pair(relay);
  const hash = await sha256(bytes);
  host.provide(hash, async () => bytes);
  const got = await join.request(hash, bytes.length);
  host.close(); join.close();
  return { hash, got };
}

function frameInfo(frame) {
  const parsed = __test.decodeFrame(frame);
  return parsed ? { type: parsed.type, ...parsed.header, bodyLength: parsed.body.length } : null;
}

// 1. Clean multi-chunk transfer: bytes and hash both round-trip.
{
  const bytes = randomBytes(20 * 1024 + 137);   // not a chunk multiple
  const relay = makeRelay();
  const { host, join } = pair(relay);
  const hash = await sha256(bytes);
  host.provide(hash, async () => bytes);
  const got = await join.request(hash, bytes.length);
  assert.equal(got.length, bytes.length);
  assert.equal(await sha256(got), hash);
  assert.ok(Buffer.from(got).equals(bytes));
  const sentData = relay.frames.map(frameInfo).filter(f => f?.type === __test.T_DATA);
  assert.equal(sentData.length, Math.ceil(bytes.length / 1024),
    'acknowledging a chunk replayed other chunks in the active window');
  assert.equal(new Set(sentData.map(f => f.seq)).size, sentData.length);
  host.close(); join.close();
}

// 2. A file smaller than one chunk.
{
  const bytes = randomBytes(300);
  const { got } = await transfer({ bytes });
  assert.ok(Buffer.from(got).equals(bytes));
}

// 3. An empty file (only DONE signals completion).
{
  const bytes = new Uint8Array(0);
  const { got } = await transfer({ bytes });
  assert.equal(got.length, 0);
}

// 4. Lossy relay: withhold several chunks and the DONE on first pass; the
//    windowed resend must still deliver every byte intact.
{
  const bytes = randomBytes(30 * 1024);
  const drop = (frame, n) => {
    if (n > 1) return false;                 // only ever drop the first pass
    const key = dropKey(frame);
    return /"seq":(2|5|9|17)\b/.test(key) || key.startsWith('4:');  // some DATA + the DONE
  };
  const { hash, got } = await transfer({ bytes, relayOpts: { drop } });
  assert.equal(got.length, bytes.length);
  assert.equal(await sha256(got), hash);
  assert.ok(Buffer.from(got).equals(bytes));
}

// 5. Echoing relay: the sender hearing its own frames must not corrupt anything.
{
  const bytes = randomBytes(8 * 1024);
  const { hash, got } = await transfer({ bytes, relayOpts: { echo: true } });
  assert.equal(await sha256(got), hash);
}

// 6. A provider whose file changed after it advertised its hash refuses to
// serve stale bytes. Nothing unauthenticated reaches the requester.
{
  const relay = makeRelay();
  const { host, join } = pair(relay, { overallTimeoutMs: 180, requestRetryMs: 40 });
  const realHash = await sha256(randomBytes(4096));   // hash the requester wants
  host.provide(realHash, async () => randomBytes(4096));  // but serve different bytes
  await assert.rejects(join.request(realHash, 4096), /timed out/i);
  assert.equal(relay.frames.map(frameInfo).filter(f => f?.type === __test.T_DATA).length, 0);
  host.close(); join.close();
}

// 7. Leaving a session while an asset is still pending rejects the request
// immediately instead of leaving the project-import task hung forever.
{
  const relay = makeRelay();
  const { host, join } = pair(relay);
  const pending = join.request(await sha256(randomBytes(1024)), 1024);
  join.close();
  await assert.rejects(pending, /transfer closed/i);
  host.close();
}

// 8. Invalid requests fail before allocating timers or chunk maps.
{
  const relay = makeRelay();
  const { host, join } = pair(relay, { maxTransferBytes: 4096 });
  await assert.rejects(join.request('not-a-sha256', 1), /invalid.*hash/i);
  await assert.rejects(join.request('a'.repeat(64), -1), /transfer limit/i);
  await assert.rejects(join.request('a'.repeat(64), 4097), /transfer limit/i);
  host.close(); join.close();
}

// 9. Forged sequence numbers, totals and body lengths are ignored. They cannot
// grow the receiver's chunk map or trick it into completing early; a later
// valid provider still transfers the exact file.
{
  const relay = makeRelay();
  const { host, join } = pair(relay);
  const attacker = relay.join(() => {});
  const bytes = randomBytes(2500);
  const hash = await sha256(bytes);
  const pending = join.request(hash, bytes.length);
  attacker.send(__test.encodeFrame(__test.T_DATA, { hash, seq: -1, total: 3, from: 'evil' }, randomBytes(1024)));
  attacker.send(__test.encodeFrame(__test.T_DATA, { hash, seq: 999999, total: 3, from: 'evil' }, randomBytes(1024)));
  attacker.send(__test.encodeFrame(__test.T_DATA, { hash, seq: 0, total: 999999, from: 'evil' }, randomBytes(1024)));
  attacker.send(__test.encodeFrame(__test.T_DATA, { hash, seq: 0, total: 3, from: 'evil' }, randomBytes(2048)));
  attacker.send(__test.encodeFrame(__test.T_DONE, { hash, total: 999999, from: 'evil' }));
  host.provide(hash, async () => bytes);
  const got = await pending;
  assert.ok(Buffer.from(got).equals(bytes));
  host.close(); join.close();
}

// 10. Many simultaneous asset requests are served in bounded batches and
// eventually complete through requester retries; the provider does not need to
// hold every file in memory at once.
{
  const relay = makeRelay();
  const { host, join } = pair(relay, {
    maxTransferBytes: 4096,
    requestRetryMs: 30,
    overallTimeoutMs: 5000,
  });
  const assets = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const bytes = randomBytes(2800 + index);
    const hash = await sha256(bytes);
    host.provide(hash, async () => bytes);
    return { bytes, hash };
  }));
  const received = await Promise.all(assets.map(asset => join.request(asset.hash, asset.bytes.length)));
  for (let index = 0; index < assets.length; index++) {
    assert.ok(Buffer.from(received[index]).equals(assets[index].bytes));
  }
  host.close(); join.close();
}

// 11. The same hash cannot be allocated twice with contradictory size
// metadata, and non-object JSON headers are ignored without throwing.
{
  const relay = makeRelay();
  const { host, join } = pair(relay);
  const hash = await sha256(randomBytes(1500));
  const pending = join.request(hash, 1500);
  await assert.rejects(join.request(hash, 1499), /conflicting binary size/i);
  relay.join(() => {}).send(__test.encodeFrame(__test.T_WANT, null));
  join.close();
  await assert.rejects(pending, /transfer closed/i);
  host.close();
}

console.log('binary transfer tests passed');
