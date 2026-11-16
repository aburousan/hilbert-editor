// The ink2latex model in the page, on onnxruntime-web (WebAssembly, one thread:
// threads need a cross-origin-isolated page, which Hilbert's is not).
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

let runtime: Promise<any> | null = null;
function loadRuntime(): Promise<any> {
  runtime ??= (async () => {
    if (!window.ort) {
      const url = URL.createObjectURL(new Blob([await (await file('ort.wasm.min.js')).text()], { type: 'text/javascript' }));
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Could not start the handwriting runtime.'));
        document.head.appendChild(script);
      });
    }
    const ort = window.ort;
    const mjs = URL.createObjectURL(new Blob([await (await file('ort-wasm-simd-threaded.mjs')).text()], { type: 'text/javascript' }));
    const wasm = URL.createObjectURL(new Blob([await (await file('ort-wasm-simd-threaded.wasm')).arrayBuffer()], { type: 'application/wasm' }));
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = { mjs, wasm };
    return ort;
  })().catch(error => { runtime = null; throw error; });
  return runtime;
}

const MAX_TOKENS = 160;
const [START, END] = [1, 2];

export class InkReader {
  private closed = false;
  private ort: any;
  private encoder: any;
  private decoder: any;
  readonly vocab: string[];
  private constructor(ort: any, encoder: any, decoder: any, vocab: string[]) {
    this.ort = ort; this.encoder = encoder; this.decoder = decoder; this.vocab = vocab;
  }

  static async open(): Promise<InkReader> {
    const ort = await loadRuntime();
    const vocab: string[] = (await (await file('vocab.json')).json()).tokens;
    const session = async (name: string) =>
      ort.InferenceSession.create(new Uint8Array(await (await file(name)).arrayBuffer()), { executionProviders: ['wasm'] });
    const [encoder, decoder] = await Promise.all([session('encoder.onnx'), session('decoder.onnx')]);
    return new InkReader(ort, encoder, decoder, vocab);
  }

  // The model takes a lot of memory; let it go when the window closes.
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([this.encoder.release(), this.decoder.release()]).catch(() => {});
  }

  private async encode(strokes: Stroke[], tensors: any[]) {
    const rows = features(strokes);
    if (!rows.length) return null;
    const track = <T,>(t: T) => { tensors.push(t); return t; };
    const result = await this.encoder.run({
      points: track(new this.ort.Tensor('float32', Float32Array.from(rows.flat()), [1, rows.length, 8])),
      point_mask: track(new this.ort.Tensor('bool', new Uint8Array(rows.length).fill(1), [1, rows.length])),
    });
    return { memory: track(result.memory), mask: track(result.memory_mask) };
  }

  private async step(tokens: number[], memory: any, mask: any): Promise<Float32Array> {
    const previous = new this.ort.Tensor('int64', BigInt64Array.from(tokens, BigInt), [1, tokens.length]);
    try {
      const prediction = await this.decoder.run({ previous_tokens: previous, memory, memory_mask: mask });
      const logits = Float32Array.from(prediction.logits.data as Float32Array);
      prediction.logits.dispose();
      return logits;
    } finally { previous.dispose(); }
  }

  // One line of maths to model tokens, greedy, as the ink2latex demo reads.
  // Null when `stale()` says the ink changed meanwhile.
  private async readLine(strokes: Stroke[], stale: () => boolean): Promise<string[] | null> {
    const tensors: any[] = [];
    try {
      const encoded = await this.encode(strokes, tensors);
      if (!encoded) return [];
      const tokens = [START], out: string[] = [];
      for (let t = 0; t < MAX_TOKENS; t++) {
        if (stale() || this.closed) return null;
        const logits = await this.step(tokens, encoded.memory, encoded.mask);
        let next = END;
        for (let i = 3; i < logits.length; i++) if (logits[i] > logits[next]) next = i;
        if (next === END) break;
        out.push(this.vocab[next]);
        tokens.push(next);
      }
      return out;
    } finally {
      for (const t of tensors) t.dispose?.();
    }
  }

  // Separate lines (a system of equations) are read one by one.
  async read(strokes: Stroke[], stale: () => boolean = () => false): Promise<string[][] | null> {
    const lines: string[][] = [];
    for (const line of splitLines(strokes)) {
      const tokens = await this.readLine(line, stale);
      if (tokens === null) return null;
      lines.push(tokens);
    }
    return lines;
  }

  // For a single drawn symbol: the model's most likely first tokens, so a
  // picker can offer the near misses too (a ∫ read as S, Θ as θ).
  async rankSymbol(strokes: Stroke[], count = 6): Promise<{ token: string; p: number }[]> {
    const tensors: any[] = [];
    try {
      const encoded = await this.encode(strokes, tensors);
      if (!encoded || this.closed) return [];
      const logits = await this.step([START], encoded.memory, encoded.mask);
      const max = Math.max(...logits);
      const weights = Array.from(logits, v => Math.exp(v - max));
      const total = weights.reduce((a, b) => a + b, 0);
      return weights.map((w, i) => ({ token: this.vocab[i], p: w / total }))
        .filter((_, i) => i > END)
        .sort((a, b) => b.p - a.p)
        .slice(0, count);
    } finally {
      for (const t of tensors) t.dispose?.();
    }
  }
}
