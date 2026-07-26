// Moves binary file bytes (images, whiteboards, fonts) between collaborators.
// These do not belong in the Yjs document: a sync encodes the whole doc as one
// message, and images would make it too large for the relay. Instead a peer
// advertises a file in the shared model by content hash, and whoever needs the
// bytes fetches them here, by that hash, in small acknowledged chunks.
//
// The channel underneath is the same content-blind broadcast the relay already
// provides: every framed message reaches all other peers (and possibly echoes
// back to the sender). That primitive silently drops for any receiver that
// falls too far behind, so transfers are windowed and acknowledged, and unacked
// chunks are resent — never a fire-hose. The transport is abstracted so this is
// exercised against an in-memory relay in tests and the encrypted socket in the
// app.

export type Frame = Uint8Array;

export type TransferChannel = {
  send: (frame: Frame) => void;
  subscribe: (handler: (frame: Frame) => void) => () => void;
};

export type TransferOptions = {
  // Bytes per chunk. Kept well under any plausible relay message ceiling.
  chunkSize?: number;
  // Chunks allowed in flight before waiting for acknowledgements.
  windowSize?: number;
  // How long to wait for an ack before resending a chunk (ms).
  ackTimeoutMs?: number;
  // How long a requester waits, with no progress, before re-asking (ms).
  requestRetryMs?: number;
  // How long a whole request may run before it gives up (ms).
  overallTimeoutMs?: number;
  // Hard cap for one asset. This bounds both provider reads and the receiver's
  // in-memory chunk map even when a peer sends forged metadata.
  maxTransferBytes?: number;
  // Content hash of the assembled bytes, used to verify what arrived. Injected
  // so this module stays free of any particular crypto implementation.
  hashBytes: (bytes: Uint8Array) => Promise<string>;
  // Unique id for this peer; used to ignore a peer's own echoed frames.
  peerId: string;
};

const T_WANT = 1;
const T_DATA = 2;
const T_ACK = 3;
const T_DONE = 4;
const DEFAULT_MAX_TRANSFER_BYTES = 50 * 1024 * 1024;
const MAX_HEADER_BYTES = 4096;
const MAX_SEND_ATTEMPTS = 20;
const SHA256_HEX = /^[a-f0-9]{64}$/;

const enc = new TextEncoder();
const dec = new TextDecoder();

function encodeFrame(type: number, header: object, body?: Uint8Array): Frame {
  const headerBytes = enc.encode(JSON.stringify(header));
  const bodyLen = body ? body.length : 0;
  const out = new Uint8Array(5 + headerBytes.length + bodyLen);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, headerBytes.length);
  out.set(headerBytes, 5);
  if (body) out.set(body, 5 + headerBytes.length);
  return out;
}

function decodeFrame(frame: Frame): { type: number; header: any; body: Uint8Array } | null {
  if (frame.length < 5) return null;
  const type = frame[0];
  const headerLen = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1);
  if (headerLen > MAX_HEADER_BYTES || 5 + headerLen > frame.length) return null;
  let header: any;
  try {
    header = JSON.parse(dec.decode(frame.subarray(5, 5 + headerLen)));
  } catch {
    return null;
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
  return { type, header, body: frame.subarray(5 + headerLen) };
}

type Incoming = {
  hash: string;
  size: number;
  total: number | null;
  chunks: Map<number, Uint8Array>;
  resolve: (bytes: Uint8Array) => void;
  reject: (err: Error) => void;
  retryTimer: any;
  overallTimer: any;
  settled: boolean;
};

type Outgoing = {
  hash: string;
  bytes: Uint8Array;
  total: number;
  acked: Set<number>;
  next: number;               // next chunk index not yet sent in this pass
  timer: any;
  attempts: Map<number, number>;
};

export class BinaryTransfer {
  private readonly ch: TransferChannel;
  private readonly opt: Required<Omit<TransferOptions, 'hashBytes' | 'peerId'>> & Pick<TransferOptions, 'hashBytes' | 'peerId'>;
  private readonly providers = new Map<string, () => Promise<Uint8Array>>();
  private readonly incoming = new Map<string, Incoming>();
  private readonly outgoing = new Map<string, Outgoing>();
  private readonly loading = new Set<string>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(channel: TransferChannel, options: TransferOptions) {
    this.ch = channel;
    this.opt = {
      chunkSize: options.chunkSize ?? 16 * 1024,
      windowSize: options.windowSize ?? 8,
      ackTimeoutMs: options.ackTimeoutMs ?? 1500,
      // A WANT frame is ~100 bytes, so re-asking is nearly free; what it buys
      // is a shorter stall when the provider was at its concurrency cap (busy
      // serving other peers) and silently dropped the first ask.
      requestRetryMs: options.requestRetryMs ?? 1000,
      overallTimeoutMs: options.overallTimeoutMs ?? 60000,
      maxTransferBytes: options.maxTransferBytes ?? DEFAULT_MAX_TRANSFER_BYTES,
      hashBytes: options.hashBytes,
      peerId: options.peerId,
    };
    if (!Number.isInteger(this.opt.chunkSize) || this.opt.chunkSize <= 0) throw new Error('Invalid binary chunk size');
    if (!Number.isInteger(this.opt.windowSize) || this.opt.windowSize <= 0) throw new Error('Invalid binary window size');
    if (
      !Number.isInteger(this.opt.ackTimeoutMs) || this.opt.ackTimeoutMs <= 0
      || !Number.isInteger(this.opt.requestRetryMs) || this.opt.requestRetryMs <= 0
      || !Number.isInteger(this.opt.overallTimeoutMs) || this.opt.overallTimeoutMs <= 0
    ) throw new Error('Invalid binary transfer timeout');
    if (!Number.isSafeInteger(this.opt.maxTransferBytes) || this.opt.maxTransferBytes < 0) {
      throw new Error('Invalid binary transfer size limit');
    }
    if (!options.peerId || options.peerId.length > 128) throw new Error('Invalid binary peer id');
    this.unsubscribe = channel.subscribe(frame => this.onFrame(frame));
  }

  // Offer to serve a file's bytes to any peer that asks for this hash. The
  // getter is lazy so bytes are only read from disk when actually requested.
  provide(hash: string, getBytes: () => Promise<Uint8Array>): void {
    if (!validHash(hash)) return;
    this.providers.set(hash, getBytes);
  }

  unprovide(hash: string): void {
    this.providers.delete(hash);
  }

  // Fetch the bytes for a hash from whichever peer has them. Resolves only once
  // the assembled bytes hash back to the value asked for.
  request(hash: string, size: number): Promise<Uint8Array> {
    if (!validHash(hash)) return Promise.reject(new Error('Invalid binary content hash'));
    if (!Number.isSafeInteger(size) || size < 0 || size > this.opt.maxTransferBytes) {
      return Promise.reject(new Error(`Binary exceeds the ${this.opt.maxTransferBytes}-byte transfer limit`));
    }
    const existing = this.incoming.get(hash);
    if (existing) {
      if (existing.size !== size) return Promise.reject(new Error('Conflicting binary size for the same content hash'));
      return new Promise((res, rej) => { const prev = existing.resolve; existing.resolve = b => { prev(b); res(b); }; const prevR = existing.reject; existing.reject = e => { prevR(e); rej(e); }; });
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const rec: Incoming = {
        hash, size, total: expectedTotal(size, this.opt.chunkSize), chunks: new Map(),
        resolve, reject, retryTimer: null, overallTimer: null, settled: false,
      };
      rec.overallTimer = setTimeout(() => this.failIncoming(hash, new Error(`Timed out fetching ${hash.slice(0, 12)}`)), this.opt.overallTimeoutMs);
      this.incoming.set(hash, rec);
      this.sendWant(hash);
      rec.retryTimer = setInterval(() => { if (!rec.settled) this.sendWant(hash); }, this.opt.requestRetryMs);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const rec of this.incoming.values()) {
      clearInterval(rec.retryTimer);
      clearTimeout(rec.overallTimer);
      if (!rec.settled) {
        rec.settled = true;
        rec.reject(new Error('Binary transfer closed'));
      }
    }
    for (const out of this.outgoing.values()) clearTimeout(out.timer);
    this.incoming.clear();
    this.outgoing.clear();
    this.loading.clear();
    this.providers.clear();
  }

  private sendWant(hash: string): void {
    this.ch.send(encodeFrame(T_WANT, { hash, from: this.opt.peerId }));
  }

  private onFrame(frame: Frame): void {
    if (this.closed) return;
    const parsed = decodeFrame(frame);
    if (!parsed) return;
    const { type, header, body } = parsed;
    if (header?.from === this.opt.peerId) return;   // ignore our own echoed frames
    switch (type) {
      case T_WANT: return void this.onWant(String(header.hash || ''));
      case T_DATA: return this.onData(header, body);
      case T_ACK: return this.onAck(String(header.hash || ''), Number(header.seq));
      case T_DONE: return this.onDone(String(header.hash || ''), Number(header.total));
    }
  }

  private async onWant(hash: string): Promise<void> {
    // Up to three loads at once so a requester fetching its pool of binaries in
    // parallel (see ProjectSync) is served rather than told to retry. Memory
    // stays bounded: three in-flight reads at most, and the aggregate outgoing
    // check below still refuses to hold more than maxTransferBytes of active
    // sends.
    if (
      !validHash(hash) || this.outgoing.has(hash) || this.loading.has(hash)
      || this.loading.size >= 3 || this.outgoing.size >= 4
    ) return;
    const getter = this.providers.get(hash);
    if (!getter) return;
    this.loading.add(hash);
    let bytes: Uint8Array;
    try {
      bytes = await getter();
      if (!(bytes instanceof Uint8Array) || bytes.length > this.opt.maxTransferBytes) return;
      if (await this.opt.hashBytes(bytes) !== hash) return;
    } catch {
      return;
    } finally {
      this.loading.delete(hash);
    }
    if (this.closed || this.outgoing.has(hash)) return;
    const activeBytes = [...this.outgoing.values()].reduce((sum, item) => sum + item.bytes.length, 0);
    if (this.outgoing.size && activeBytes + bytes.length > this.opt.maxTransferBytes) return;
    const total = Math.ceil(bytes.length / this.opt.chunkSize);
    if (total === 0) { this.ch.send(encodeFrame(T_DONE, { hash, total: 0, from: this.opt.peerId })); return; }
    const out: Outgoing = { hash, bytes, total, acked: new Set(), next: 0, timer: null, attempts: new Map() };
    this.outgoing.set(hash, out);
    this.pump(out);
  }

  // Send as many unacked chunks as the window allows, then arm a resend timer.
  private pump(out: Outgoing): void {
    if (this.closed || this.outgoing.get(out.hash) !== out) return;
    // onAck refuses seq >= next, so every acked chunk is below next and the
    // in-flight count is just the difference — no need to scan the set.
    let inFlight = out.next - out.acked.size;
    while (out.next < out.total && inFlight < this.opt.windowSize) {
      this.sendChunk(out, out.next);
      out.next++;
      inFlight++;
    }
    this.armResend(out);
  }

  private armResend(out: Outgoing): void {
    clearTimeout(out.timer);
    out.timer = setTimeout(() => {
      if (this.closed || this.outgoing.get(out.hash) !== out) return;
      // Only resend the current in-flight window. Acknowledging one chunk then
      // sends one new chunk; it does not replay the rest of the window.
      for (let seq = 0; seq < out.next; seq++) {
        if (out.acked.has(seq)) continue;
        if ((out.attempts.get(seq) ?? 0) >= MAX_SEND_ATTEMPTS) {
          this.outgoing.delete(out.hash);
          clearTimeout(out.timer);
          return;
        }
        this.sendChunk(out, seq);
      }
      this.armResend(out);
    }, this.opt.ackTimeoutMs);
  }

  private sendChunk(out: Outgoing, seq: number): void {
    const start = seq * this.opt.chunkSize;
    const chunk = out.bytes.subarray(start, start + this.opt.chunkSize);
    out.attempts.set(seq, (out.attempts.get(seq) || 0) + 1);
    this.ch.send(encodeFrame(T_DATA, { hash: out.hash, seq, total: out.total, from: this.opt.peerId }, chunk));
  }

  private onAck(hash: string, seq: number): void {
    const out = this.outgoing.get(hash);
    if (!out || !Number.isInteger(seq) || seq < 0 || seq >= out.next || seq >= out.total) return;
    out.acked.add(seq);
    if (out.acked.size >= out.total) {
      clearTimeout(out.timer);
      this.ch.send(encodeFrame(T_DONE, { hash, total: out.total, from: this.opt.peerId }));
      this.outgoing.delete(hash);
      return;
    }
    this.pump(out);
  }

  private onData(header: any, body: Uint8Array): void {
    const hash = String(header.hash || '');
    const rec = this.incoming.get(hash);
    if (!rec || rec.settled) return;
    const seq = Number(header.seq);
    const total = Number(header.total);
    const wantedTotal = expectedTotal(rec.size, this.opt.chunkSize);
    if (
      !Number.isInteger(seq) || seq < 0 || seq >= wantedTotal
      || !Number.isInteger(total) || total !== wantedTotal
      || body.length !== expectedChunkLength(rec.size, seq, this.opt.chunkSize)
    ) return;
    rec.total = total;
    if (!rec.chunks.has(seq)) rec.chunks.set(seq, body.slice());
    this.ch.send(encodeFrame(T_ACK, { hash, seq, from: this.opt.peerId }));
    this.maybeComplete(rec);
  }

  private onDone(hash: string, total: number): void {
    const rec = this.incoming.get(hash);
    if (!rec || rec.settled) return;
    const wantedTotal = expectedTotal(rec.size, this.opt.chunkSize);
    if (!Number.isInteger(total) || total !== wantedTotal) return;
    rec.total = total;
    this.maybeComplete(rec);
  }

  private async maybeComplete(rec: Incoming): Promise<void> {
    if (rec.settled || rec.total === null || rec.chunks.size < rec.total) return;
    const total = rec.total;
    const assembled = new Uint8Array(rec.size);
    let offset = 0;
    for (let seq = 0; seq < total; seq++) {
      const part = rec.chunks.get(seq);
      if (!part) return;   // a gap remains; wait for the resend
      assembled.set(part, offset);
      offset += part.length;
    }
    rec.settled = true;
    clearInterval(rec.retryTimer);
    clearTimeout(rec.overallTimer);
    rec.chunks.clear();
    let ok = false;
    try {
      ok = (await this.opt.hashBytes(assembled)) === rec.hash;
    } catch {
      ok = false;
    }
    this.incoming.delete(rec.hash);
    if (ok) rec.resolve(assembled);
    else rec.reject(new Error(`Content hash mismatch for ${rec.hash.slice(0, 12)}`));
  }

  private failIncoming(hash: string, err: Error): void {
    const rec = this.incoming.get(hash);
    if (!rec || rec.settled) return;
    rec.settled = true;
    clearInterval(rec.retryTimer);
    clearTimeout(rec.overallTimer);
    this.incoming.delete(hash);
    rec.reject(err);
  }
}

function validHash(hash: string): boolean {
  return SHA256_HEX.test(hash);
}

function expectedTotal(size: number, chunkSize: number): number {
  return Math.ceil(size / chunkSize);
}

function expectedChunkLength(size: number, seq: number, chunkSize: number): number {
  return Math.min(chunkSize, size - seq * chunkSize);
}

export const __test = {
  encodeFrame,
  decodeFrame,
  T_WANT,
  T_DATA,
  T_ACK,
  T_DONE,
  DEFAULT_MAX_TRANSFER_BYTES,
};
