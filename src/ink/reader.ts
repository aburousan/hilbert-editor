// The ink2latex model on onnxruntime-web (WebAssembly, one thread: threads
// need a cross-origin-isolated page, which Hilbert's is not), in a worker.
//
// Nothing here is part of Hilbert's own files: the model and its runtime are
// downloaded only when the person asks (see /ink/install in the backend), and
// read back through the app's own authorised fetch. The runtime script and its
// WebAssembly are then handed over as blob URLs and the models as bytes, so no
// <script> or import ever has to sign in by itself.
import { API } from '../api';
import { features, splitLines, type Stroke } from './features';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global { interface Window { ort?: any } }

export type InkStatus = {
  installed: boolean; downloadBytes: number; canInstall: boolean;
  model: string; weightsLicense: string; source: string;
};

export async function inkStatus(): Promise<InkStatus | null> {
  try {
    const response = await fetch(`${API}/ink/status`);
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

export async function installInk(): Promise<void> {
  const response = await fetch(`${API}/ink/install`, { method: 'POST' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || 'Could not download the handwriting model.');
}

async function file(name: string): Promise<Response> {
  const response = await fetch(`${API}/ink/file/${name}`);
  if (!response.ok) throw new Error('The handwriting model is not installed.');
  return response;
}

// The runtime's three files as blob URLs, fetched once through the app.
type RuntimeUrls = { script: string; mjs: string; wasm: string };
let runtimeUrls: Promise<RuntimeUrls> | null = null;
function loadRuntimeUrls(): Promise<RuntimeUrls> {
  runtimeUrls ??= (async () => {
    const blob = async (name: string, type: string, binary = false) => {
      const response = await file(name);
      return URL.createObjectURL(new Blob([binary ? await response.arrayBuffer() : await response.text()], { type }));
    };
    const [script, mjs, wasm] = await Promise.all([
      blob('ort.wasm.min.js', 'text/javascript'), blob('ort-wasm-simd-threaded.mjs', 'text/javascript'),
      blob('ort-wasm-simd-threaded.wasm', 'application/wasm', true)]);
    return { script, mjs, wasm };
  })().catch(error => { runtimeUrls = null; throw error; });
  return runtimeUrls;
}

let pageRuntime: Promise<any> | null = null;
function loadPageRuntime(): Promise<any> {
  pageRuntime ??= (async () => {
    const urls = await loadRuntimeUrls();
    if (!window.ort) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = urls.script;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Could not start the handwriting runtime.'));
        document.head.appendChild(script);
      });
    }
    window.ort.env.wasm.numThreads = 1;
    window.ort.env.wasm.wasmPaths = { mjs: urls.mjs, wasm: urls.wasm };
    return window.ort;
  })().catch(error => { pageRuntime = null; throw error; });
  return pageRuntime;
}

const MAX_TOKENS = 160;

// The model itself: encode a line's points, then greedy decoding, as the
// ink2latex demo reads. It runs in a worker (see WorkerModel), so writing on
// the pad never waits for it: on the page's own thread every decoding step
// held up the pen, and a long formula made the ink choppy (issue #45). Its
// source is copied into the worker, so it must use nothing from outside.
function engine(ort: any) {
  const START = 1, END = 2;
  let encoder: any = null, decoder: any = null;
  async function encode(rows: Float32Array, tensors: any[]) {
    const n = rows.length / 8;
    const track = (t: any) => { tensors.push(t); return t; };
    const result = await encoder.run({
      points: track(new ort.Tensor('float32', rows, [1, n, 8])),
      point_mask: track(new ort.Tensor('bool', new Uint8Array(n).fill(1), [1, n])),
    });
    return { memory: track(result.memory), mask: track(result.memory_mask) };
  }
  async function step(tokens: number[], memory: any, mask: any): Promise<Float32Array> {
    const previous = new ort.Tensor('int64', BigInt64Array.from(tokens, BigInt), [1, tokens.length]);
    try {
      const prediction = await decoder.run({ previous_tokens: previous, memory, memory_mask: mask });
      const logits = Float32Array.from(prediction.logits.data as Float32Array);
      prediction.logits.dispose();
      return logits;
    } finally { previous.dispose(); }
  }
  return {
    async open(encoderBytes: ArrayBuffer, decoderBytes: ArrayBuffer) {
      const session = (bytes: ArrayBuffer) => ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'] });
      [encoder, decoder] = await Promise.all([session(encoderBytes), session(decoderBytes)]);
    },
    async close() {
      await Promise.all([encoder?.release(), decoder?.release()]).catch(() => {});
      encoder = decoder = null;
    },
    // One line's points to token ids; null when `stale()` says to stop.
    async read(rows: Float32Array, maxTokens: number, stale: () => boolean): Promise<number[] | null> {
      if (!rows.length) return [];
      const tensors: any[] = [];
      try {
        const { memory, mask } = await encode(rows, tensors);
        const tokens = [START];
        for (let t = 0; t < maxTokens; t++) {
          if (stale()) return null;
          const logits = await step(tokens, memory, mask);
          let next = END;
          for (let i = 3; i < logits.length; i++) if (logits[i] > logits[next]) next = i;
          if (next === END) break;
          tokens.push(next);
        }
        return tokens.slice(1);
      } finally { for (const t of tensors) t.dispose?.(); }
    },
    // The first step's scores: for one symbol on its own, the model's near
    // misses (a ∫ read as S, Θ as θ), offered to pick from.
    async first(rows: Float32Array): Promise<Float32Array> {
      const tensors: any[] = [];
      try {
        const { memory, mask } = await encode(rows, tensors);
        return await step([START], memory, mask);
      } finally { for (const t of tensors) t.dispose?.(); }
    },
  };
}

interface Model {
  read(lines: Float32Array[], stale: () => boolean): Promise<number[][] | null>;
  first(rows: Float32Array): Promise<Float32Array>;
  close(): Promise<void>;
}

// The model in a worker of its own. Requests run one at a time; a read the
// ink has moved past is told to stop at its next step.
class WorkerModel implements Model {
  private next = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private worker: Worker;
  private constructor(worker: Worker) {
    this.worker = worker;
    worker.onmessage = ({ data }) => {
      const w = this.waiting.get(data.id);
      if (!w) return;
      this.waiting.delete(data.id);
      if (data.ok) w.resolve(data.result); else w.reject(new Error(data.error || 'The handwriting model failed.'));
    };
    worker.onerror = event => {
      event.preventDefault();
      for (const w of this.waiting.values()) w.reject(new Error(event.message || 'The handwriting model stopped.'));
      this.waiting.clear();
    };
  }
  private ask<T>(message: Record<string, unknown>, transfer: Transferable[] = []): { id: number; done: Promise<T> } {
    const id = ++this.next;
    const done = new Promise<T>((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    this.worker.postMessage({ ...message, id }, transfer);
    return { id, done };
  }

  static async start(encoder: ArrayBuffer, decoder: ArrayBuffer): Promise<WorkerModel> {
    const urls = await loadRuntimeUrls();
    const source = `const engine = ${engine.toString()};
let model = null, chain = Promise.resolve();
const cancelled = new Set();
self.onmessage = ({ data: m }) => {
  if (m.type === 'cancel') { cancelled.add(m.id); return; }
  chain = chain.then(() => handle(m));
};
async function handle(m) {
  try {
    let result = null;
    if (m.type === 'open') {
      importScripts(m.script);
      self.ort.env.wasm.numThreads = 1;
      self.ort.env.wasm.wasmPaths = { mjs: m.mjs, wasm: m.wasm };
      model = engine(self.ort);
      await model.open(m.encoder, m.decoder);
    } else if (m.type === 'read') {
      result = [];
      for (const rows of m.lines) {
        const tokens = await model.read(rows, ${MAX_TOKENS}, () => cancelled.has(m.id));
        if (tokens === null) { result = null; break; }
        result.push(tokens);
      }
    } else if (m.type === 'first') {
      result = await model.first(m.rows);
    } else if (m.type === 'close') {
      await model?.close();
    }
    self.postMessage({ id: m.id, ok: true, result });
  } catch (error) {
    self.postMessage({ id: m.id, ok: false, error: String(error && error.message || error) });
  } finally { cancelled.delete(m.id); }
}`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url, { name: 'hilbert-ink2latex' });
    URL.revokeObjectURL(url);
    const model = new WorkerModel(worker);
    try {
      await model.ask({ type: 'open', ...urls, encoder, decoder }, [encoder, decoder]).done;
    } catch (error) { worker.terminate(); throw error; }
    return model;
  }

  async read(lines: Float32Array[], stale: () => boolean): Promise<number[][] | null> {
    const { id, done } = this.ask<number[][] | null>({ type: 'read', lines });
    // The ink changed meanwhile: stop the worker at its next step and answer at once.
    const stop = new Promise<null>(resolve => {
      const timer = window.setInterval(() => {
        if (!this.waiting.has(id)) { clearInterval(timer); return; }
        if (stale()) { clearInterval(timer); this.worker.postMessage({ type: 'cancel', id }); resolve(null); }
      }, 30);
    });
    return Promise.race([done, stop]);
  }
  first(rows: Float32Array): Promise<Float32Array> { return this.ask<Float32Array>({ type: 'first', rows }).done; }
  async close(): Promise<void> {
    await this.ask({ type: 'close' }).done.catch(() => {});
    this.worker.terminate();
  }
}

// Where a worker cannot start, the same model on the page's own thread.
class PageModel implements Model {
  private model: ReturnType<typeof engine>;
  private constructor(model: ReturnType<typeof engine>) { this.model = model; }
  static async start(encoder: ArrayBuffer, decoder: ArrayBuffer): Promise<PageModel> {
    const model = engine(await loadPageRuntime());
    await model.open(encoder, decoder);
    return new PageModel(model);
  }
  async read(lines: Float32Array[], stale: () => boolean): Promise<number[][] | null> {
    const out: number[][] = [];
    for (const rows of lines) {
      const tokens = await this.model.read(rows, MAX_TOKENS, stale);
      if (tokens === null) return null;
      out.push(tokens);
    }
    return out;
  }
  first(rows: Float32Array) { return this.model.first(rows); }
  close() { return this.model.close(); }
}

export class InkReader {
  private closed = false;
  readonly vocab: string[];
  /** Where the model runs, for the tests: 'worker' normally, 'page' if a worker could not start. */
  readonly where: 'worker' | 'page';
  private model: Model;
  private constructor(model: Model, vocab: string[], where: 'worker' | 'page') {
    this.model = model; this.vocab = vocab; this.where = where;
  }

  // (`where` = 'page' only for the tests, to check the fallback reads the same.)
  static async open(where: 'worker' | 'page' = 'worker'): Promise<InkReader> {
    const vocab: string[] = (await (await file('vocab.json')).json()).tokens;
    const bytes = () => Promise.all([file('encoder.onnx'), file('decoder.onnx')].map(async r => (await r).arrayBuffer()));
    try {
      if (where === 'page') throw new Error('asked to run on the page');
      const [encoder, decoder] = await bytes();
      return new InkReader(await WorkerModel.start(encoder, decoder), vocab, 'worker');
    } catch (error) {
      if (where !== 'page') console.warn('Handwriting: the model could not start in a worker, so it runs on the page.', error);
      // (The worker was handed the bytes: they are fetched again.)
      const [encoder, decoder] = await bytes();
      return new InkReader(await PageModel.start(encoder, decoder), vocab, 'page');
    }
  }

  // The model takes a lot of memory; let it go when the window closes.
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.model.close();
  }

  // Separate lines (a system of equations) are read one by one. Null when
  // `stale()` says the ink changed meanwhile.
  async read(strokes: Stroke[], stale: () => boolean = () => false): Promise<string[][] | null> {
    if (this.closed) return null;
    const lines = splitLines(strokes).map(line => Float32Array.from(features(line).flat()));
    const ids = await this.model.read(lines, () => this.closed || stale());
    return ids && ids.map(line => line.map(i => this.vocab[i]));
  }

  // For one symbol on its own: the model's likeliest first tokens, best first.
  async guesses(strokes: Stroke[], count = 6): Promise<{ token: string; p: number }[]> {
    const rows = Float32Array.from(features(strokes).flat());
    if (!rows.length || this.closed) return [];
    const logits = await this.model.first(rows);
    const max = Math.max(...logits);
    const weights = Array.from(logits, v => Math.exp(v - max));
    const total = weights.reduce((a, b) => a + b, 0);
    // (0 to 2 are padding, start and end.)
    return weights.map((w, i) => ({ token: this.vocab[i], p: w / total }))
      .filter((_, i) => i > 2)
      .sort((a, b) => b.p - a.p)
      .slice(0, count);
  }
}
