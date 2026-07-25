import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const source = await readFile(resolve('src/collabProtocol.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const protocol = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

assert.equal(protocol.normalizeCollabServerUrl('10.20.30.40:3020'), 'ws://10.20.30.40:3020');
assert.equal(protocol.normalizeCollabServerUrl('wss://sync.example.edu/base/'), 'wss://sync.example.edu/base');
assert.equal(protocol.normalizeCollabServerUrl('https://sync.example.edu'), null);
assert.equal(protocol.normalizeCollabServerUrl('ws://user:pass@example.edu'), null);
assert.equal(protocol.normalizeCollabServerUrl('ws://example.edu/?token=secret'), null);

const first = protocol.newCollabSession();
const second = protocol.newCollabSession();
assert.match(first.room, /^[0-9a-f]{64}$/);
assert.match(first.key, /^[A-Za-z0-9_-]{43}$/);
assert.notEqual(first.room, second.room);
assert.notEqual(first.key, second.key);

const ticket = protocol.makeCollabTicket('ws://10.20.30.40:3020', first.room, first.key);
assert.deepEqual(protocol.parseCollabTicket(ticket), {
  url: 'ws://10.20.30.40:3020',
  room: first.room,
  key: first.key,
});
assert.equal(protocol.parseCollabTicket('hilbert-collab://old-room@ws://10.0.0.1:3020'), null);
assert.equal(protocol.parseCollabTicket(ticket.replace(first.key, 'short')), null);
assert.throws(() => protocol.encryptedWebSocketClass('short'), /Invalid collaboration key/);

// The Rust relay deliberately caps a WebSocket message at 1 MiB. Large Yjs
// state syncs are encrypted and fragmented below that ceiling, then rebuilt
// byte-for-byte before the provider sees them.
{
  const nativePackets = [];
  class LoopbackWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    extensions = '';
    protocol = '';
    binaryType = 'arraybuffer';
    onopen = null;
    onclose = null;
    onerror = null;
    onmessage = null;
    constructor(url) {
      this.url = String(url);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.(new Event('open'));
      });
    }
    send(packet) {
      nativePackets.push(packet);
      queueMicrotask(() => this.onmessage?.(new MessageEvent('message', { data: packet })));
    }
    close() {
      this.readyState = 3;
      queueMicrotask(() => this.onclose?.(new Event('close')));
    }
  }
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = LoopbackWebSocket;
  try {
    const EncryptedSocket = protocol.encryptedWebSocketClass(first.key);
    const socket = new EncryptedSocket('ws://loopback.test/collab/test');
    await new Promise(resolve => { socket.onopen = resolve; });
    const sourceBytes = new Uint8Array(2 * 1024 * 1024 + 777);
    for (let i = 0; i < sourceBytes.length; i++) sourceBytes[i] = (i * 31 + 17) & 255;
    const received = new Promise(resolve => { socket.onmessage = event => resolve(new Uint8Array(event.data)); });
    socket.send(sourceBytes);
    const roundTrip = await received;
    assert.deepEqual(roundTrip, sourceBytes);
    assert.ok(nativePackets.length > 2, 'large frame was not fragmented');
    assert.ok(nativePackets.every(packet => packet.byteLength < 1024 * 1024),
      'encrypted fragment exceeded the relay message limit');
    socket.close();
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
}

console.log('collaboration protocol tests passed');
