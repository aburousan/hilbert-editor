export type CollabInvite = {
  url: string;
  room: string;
  key: string;
};

const ROOM_RE = /^[0-9a-f]{64}$/i;
const KEY_BYTES = 32;
const FRAME_VERSION = 1;
const CHUNK_FRAME_VERSION = 2;
const IV_BYTES = 12;
const CHUNK_ID_BYTES = 12;
const CHUNK_HEADER_BYTES = CHUNK_ID_BYTES + 12;
const CHUNK_PLAINTEXT_BYTES = 256 * 1024;
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const MAX_REASSEMBLIES = 8;
const REASSEMBLY_TIMEOUT_MS = 30000;
const SEND_HIGH_WATER_BYTES = 2 * 1024 * 1024;
const SEND_LOW_WATER_BYTES = 512 * 1024;
const SEND_RATE_BYTES_PER_SECOND = 12 * 1024 * 1024;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export function normalizeCollabServerUrl(value: string): string | null {
  let candidate = value.trim();
  if (!candidate) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `ws://${candidate}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return null;
  }
}

export function newCollabSession(): { room: string; key: string } {
  const roomBytes = new Uint8Array(32);
  const keyBytes = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(roomBytes);
  crypto.getRandomValues(keyBytes);
  return {
    room: Array.from(roomBytes, byte => byte.toString(16).padStart(2, '0')).join(''),
    key: bytesToBase64Url(keyBytes),
  };
}

export function makeCollabTicket(url: string, room: string, key: string): string {
  const normalized = normalizeCollabServerUrl(url);
  const decodedKey = base64UrlToBytes(key);
  if (!normalized || !ROOM_RE.test(room) || decodedKey?.length !== KEY_BYTES) {
    throw new Error('Invalid collaboration invitation parameters.');
  }
  const params = new URLSearchParams({ server: normalized, room: room.toLowerCase(), key });
  return `hilbert-collab://join?${params.toString()}`;
}

export function parseCollabTicket(ticket: string): CollabInvite | null {
  try {
    const parsed = new URL(ticket.trim());
    if (parsed.protocol !== 'hilbert-collab:' || parsed.hostname !== 'join') return null;
    const url = normalizeCollabServerUrl(parsed.searchParams.get('server') || '');
    const room = parsed.searchParams.get('room') || '';
    const key = parsed.searchParams.get('key') || '';
    const decodedKey = base64UrlToBytes(key);
    if (!url || !ROOM_RE.test(room) || decodedKey?.length !== KEY_BYTES) return null;
    return { url, room: room.toLowerCase(), key };
  } catch {
    return null;
  }
}

function encryptedFrame(key: CryptoKey, data: ArrayBuffer, version = FRAME_VERSION): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const algorithm: AesGcmParams = version === FRAME_VERSION
    ? { name: 'AES-GCM', iv }
    : { name: 'AES-GCM', iv, additionalData: new Uint8Array([version]) };
  return crypto.subtle.encrypt(algorithm, key, data).then(ciphertext => {
    const packet = new Uint8Array(1 + IV_BYTES + ciphertext.byteLength);
    packet[0] = version;
    packet.set(iv, 1);
    packet.set(new Uint8Array(ciphertext), 1 + IV_BYTES);
    return packet.buffer;
  });
}

async function decryptedFrame(key: CryptoKey, packet: ArrayBuffer): Promise<{ version: number; plaintext: ArrayBuffer }> {
  const bytes = new Uint8Array(packet);
  // The smallest authentic frame is version + IV + a bare 16-byte GCM tag.
  const version = bytes[0];
  if (
    bytes.length < 1 + IV_BYTES + 16
    || (version !== FRAME_VERSION && version !== CHUNK_FRAME_VERSION)
  ) {
    throw new Error('Invalid encrypted collaboration frame.');
  }
  const iv = bytes.slice(1, 1 + IV_BYTES);
  const ciphertext = bytes.slice(1 + IV_BYTES);
  const algorithm: AesGcmParams = version === FRAME_VERSION
    ? { name: 'AES-GCM', iv }
    : { name: 'AES-GCM', iv, additionalData: new Uint8Array([version]) };
  const plaintext = await crypto.subtle.decrypt(algorithm, key, ciphertext);
  return { version, plaintext };
}

// y-websocket accepts a WebSocket constructor. This adapter encrypts every
// network frame before the relay sees it and decrypts it before Yjs receives it.
// The relay therefore needs no document key and can remain content-blind.
export function encryptedWebSocketClass(encodedKey: string): typeof WebSocket {
  const rawKey = base64UrlToBytes(encodedKey);
  if (!rawKey || rawKey.length !== KEY_BYTES) throw new Error('Invalid collaboration key.');
  const keyMaterial = rawKey.slice().buffer as ArrayBuffer;
  const keyPromise = crypto.subtle.importKey('raw', keyMaterial, 'AES-GCM', false, ['encrypt', 'decrypt']);

  class EncryptedWebSocket {
    static readonly CONNECTING = WebSocket.CONNECTING;
    static readonly OPEN = WebSocket.OPEN;
    static readonly CLOSING = WebSocket.CLOSING;
    static readonly CLOSED = WebSocket.CLOSED;
    readonly CONNECTING = WebSocket.CONNECTING;
    readonly OPEN = WebSocket.OPEN;
    readonly CLOSING = WebSocket.CLOSING;
    readonly CLOSED = WebSocket.CLOSED;

    private readonly socket: WebSocket;
    private sendChain: Promise<void> = Promise.resolve();
    private receiveChain: Promise<void> = Promise.resolve();
    private sendWindowStarted = performance.now();
    private sendWindowBytes = 0;
    private readonly reassemblies = new Map<string, {
      total: number;
      size: number;
      chunks: Map<number, Uint8Array>;
      received: number;
      timer: ReturnType<typeof setTimeout>;
    }>();
    private reassemblyBytes = 0;
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;

    constructor(url: string | URL, protocols?: string | string[]) {
      this.socket = new WebSocket(url, protocols);
      this.socket.binaryType = 'arraybuffer';
      this.socket.onopen = event => {
        void keyPromise.then(() => {
          if (this.socket.readyState === WebSocket.OPEN) this.onopen?.(event);
        }).catch(() => this.fail());
      };
      this.socket.onclose = event => {
        this.clearReassemblies();
        this.onclose?.(event);
      };
      this.socket.onerror = event => this.onerror?.(event);
      this.socket.onmessage = event => {
        this.receiveChain = this.receiveChain.then(async () => {
          const packet = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
          if (!(packet instanceof ArrayBuffer)) throw new Error('Expected a binary collaboration frame.');
          const decoded = await decryptedFrame(await keyPromise, packet);
          if (decoded.version === FRAME_VERSION) {
            this.onmessage?.(new MessageEvent('message', { data: decoded.plaintext }));
          } else {
            this.receiveChunk(decoded.plaintext);
          }
        // A relay can receive probes or a client with the wrong invitation key.
        // Ignore frames that do not authenticate instead of letting that client
        // disconnect valid collaborators.
        }).catch(() => {});
      };
    }

    get readyState() { return this.socket.readyState; }
    get bufferedAmount() { return this.socket.bufferedAmount; }
    get extensions() { return this.socket.extensions; }
    get protocol() { return this.socket.protocol; }
    get url() { return this.socket.url; }
    get binaryType() { return this.socket.binaryType; }
    set binaryType(value: BinaryType) { this.socket.binaryType = value; }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      this.sendChain = this.sendChain.then(async () => {
        if (this.socket.readyState !== WebSocket.OPEN) return;
        let plaintext: ArrayBuffer;
        if (data instanceof ArrayBuffer) plaintext = data;
        else if (ArrayBuffer.isView(data)) {
          plaintext = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        } else if (data instanceof Blob) plaintext = await data.arrayBuffer();
        else throw new Error('Text collaboration frames are not supported.');
        if (plaintext.byteLength > MAX_REASSEMBLED_BYTES) {
          throw new Error('Collaboration frame exceeds the reassembly limit.');
        }
        const key = await keyPromise;
        if (plaintext.byteLength <= CHUNK_PLAINTEXT_BYTES) {
          await this.sendPacket(await encryptedFrame(key, plaintext));
          return;
        }
        const id = crypto.getRandomValues(new Uint8Array(CHUNK_ID_BYTES));
        const total = Math.ceil(plaintext.byteLength / CHUNK_PLAINTEXT_BYTES);
        for (let seq = 0; seq < total; seq++) {
          if (this.socket.readyState !== WebSocket.OPEN) return;
          const start = seq * CHUNK_PLAINTEXT_BYTES;
          const body = new Uint8Array(plaintext, start, Math.min(CHUNK_PLAINTEXT_BYTES, plaintext.byteLength - start));
          const chunk = new Uint8Array(CHUNK_HEADER_BYTES + body.length);
          chunk.set(id, 0);
          const view = new DataView(chunk.buffer);
          view.setUint32(CHUNK_ID_BYTES, seq);
          view.setUint32(CHUNK_ID_BYTES + 4, total);
          view.setUint32(CHUNK_ID_BYTES + 8, plaintext.byteLength);
          chunk.set(body, CHUNK_HEADER_BYTES);
          await this.sendPacket(await encryptedFrame(key, chunk.buffer, CHUNK_FRAME_VERSION));
        }
      }).catch(() => this.fail());
    }

    close(code?: number, reason?: string) {
      // Let frames still in the encryption queue (such as the awareness
      // departure announcement) reach the socket before it closes.
      void this.sendChain.finally(() => this.socket.close(code, reason));
    }

    private fail() {
      this.onerror?.(new Event('error'));
      if (this.socket.readyState < WebSocket.CLOSING) {
        this.socket.close(1008, 'Encrypted collaboration frame rejected');
      }
    }

    private async waitForDrain(): Promise<void> {
      while (
        this.socket.readyState === WebSocket.OPEN
        && this.socket.bufferedAmount > SEND_HIGH_WATER_BYTES
      ) {
        await new Promise(resolve => setTimeout(resolve, 10));
        if (this.socket.bufferedAmount <= SEND_LOW_WATER_BYTES) break;
      }
    }

    private async sendPacket(packet: ArrayBuffer): Promise<void> {
      let elapsed = performance.now() - this.sendWindowStarted;
      if (elapsed >= 1000) {
        this.sendWindowStarted = performance.now();
        this.sendWindowBytes = 0;
        elapsed = 0;
      }
      if (this.sendWindowBytes + packet.byteLength > SEND_RATE_BYTES_PER_SECOND) {
        await new Promise(resolve => setTimeout(resolve, Math.max(1, 1000 - elapsed)));
        this.sendWindowStarted = performance.now();
        this.sendWindowBytes = 0;
      }
      await this.waitForDrain();
      if (this.socket.readyState !== WebSocket.OPEN) return;
      this.socket.send(packet);
      this.sendWindowBytes += packet.byteLength;
    }

    private receiveChunk(buffer: ArrayBuffer): void {
      const bytes = new Uint8Array(buffer);
      if (bytes.length < CHUNK_HEADER_BYTES) return;
      const id = bytesToHex(bytes.subarray(0, CHUNK_ID_BYTES));
      const view = new DataView(buffer);
      const seq = view.getUint32(CHUNK_ID_BYTES);
      const total = view.getUint32(CHUNK_ID_BYTES + 4);
      const size = view.getUint32(CHUNK_ID_BYTES + 8);
      const expectedTotal = Math.ceil(size / CHUNK_PLAINTEXT_BYTES);
      const expectedLength = Math.min(CHUNK_PLAINTEXT_BYTES, size - seq * CHUNK_PLAINTEXT_BYTES);
      if (
        size <= CHUNK_PLAINTEXT_BYTES || size > MAX_REASSEMBLED_BYTES
        || total !== expectedTotal || total < 2
        || seq >= total || bytes.length - CHUNK_HEADER_BYTES !== expectedLength
      ) return;

      let record = this.reassemblies.get(id);
      if (!record) {
        if (this.reassemblies.size >= MAX_REASSEMBLIES || this.reassemblyBytes + size > MAX_REASSEMBLED_BYTES) return;
        const timer = setTimeout(() => this.dropReassembly(id), REASSEMBLY_TIMEOUT_MS);
        record = { total, size, chunks: new Map(), received: 0, timer };
        this.reassemblies.set(id, record);
        this.reassemblyBytes += size;
      }
      if (record.total !== total || record.size !== size || record.chunks.has(seq)) return;
      record.chunks.set(seq, bytes.slice(CHUNK_HEADER_BYTES));
      record.received++;
      if (record.received !== total) return;

      const assembled = new Uint8Array(size);
      let offset = 0;
      for (let index = 0; index < total; index++) {
        const part = record.chunks.get(index);
        if (!part) return;
        assembled.set(part, offset);
        offset += part.length;
      }
      this.dropReassembly(id);
      this.onmessage?.(new MessageEvent('message', { data: assembled.buffer }));
    }

    private dropReassembly(id: string): void {
      const record = this.reassemblies.get(id);
      if (!record) return;
      clearTimeout(record.timer);
      this.reassemblyBytes = Math.max(0, this.reassemblyBytes - record.size);
      this.reassemblies.delete(id);
    }

    private clearReassemblies(): void {
      for (const record of this.reassemblies.values()) clearTimeout(record.timer);
      this.reassemblies.clear();
      this.reassemblyBytes = 0;
    }
  }

  return EncryptedWebSocket as unknown as typeof WebSocket;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
