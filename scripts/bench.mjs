// Reproducible backend benchmark for Hilbert.
//
//   node scripts/bench.mjs                 # uses the release binary
//   BIN=/path/to/typst-editor node scripts/bench.mjs
//
// Generates four workspaces of increasing size, runs the backend against each on
// its own port with its own workspace, and reports index/search/file-op latency,
// compile time, and RSS (start, and after hammering it). Writes bench-results.json.

import { spawn, execSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const BIN = process.env.BIN
  || join(process.cwd(), '../typst-editor-tauri/src-tauri/target/release/typst-editor');
const ROOT = join(tmpdir(), 'hilbert-bench');
const PORT = 3222;

const SIZES = [
  { name: 'Tiny',   chapters: 3,    refs: 5 },
  { name: 'Medium', chapters: 30,   refs: 100 },
  { name: 'Thesis', chapters: 200,  refs: 500 },
  { name: 'Huge',   chapters: 1000, refs: 2000 },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint()) / 1e6;

function makeWorkspace(dir, { chapters, refs }) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'chapters'), { recursive: true });
  const body = 'The degenerate core cools through a thin non-degenerate envelope, so '
    + 'the luminosity function encodes the star-formation history. ';
  for (let i = 1; i <= chapters; i++) {
    writeFileSync(join(dir, 'chapters', `ch${i}.typ`),
      `== Chapter ${i}\n${body.repeat(6)}\n\n$ integral_0^oo (x^3)/(e^x - 1) dif x = pi^4/15 $\n`);
  }
  const bib = Array.from({ length: refs }, (_, i) =>
    `@article{ref${i},\n  title={Paper ${i}},\n  author={Curie, Marie},\n  journal={J. Ex.},\n  year={20${10 + (i % 15)}},\n}\n`).join('');
  writeFileSync(join(dir, 'refs.bib'), bib);
  const includes = Array.from({ length: chapters }, (_, i) => `#include "chapters/ch${i + 1}.typ"`).join('\n');
  writeFileSync(join(dir, 'main.typ'),
    `#set page(paper: "a4", numbering: "1")\n= Benchmark Document\n${includes}\n#bibliography("refs.bib")\n`);
}

async function waitReady() {
  for (let i = 0; i < 600; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/workspace/root`); return; } catch { await sleep(20); }
  }
  throw new Error('backend never became ready');
}

const rssMB = pid => Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024;

async function timeIt(n, fn) {
  const ts = [];
  for (let i = 0; i < n; i++) { const t0 = now(); await fn(i); ts.push(now() - t0); }
  ts.sort((a, b) => a - b);
  return { avg: ts.reduce((a, b) => a + b, 0) / ts.length, worst: ts[ts.length - 1] };
}

const results = [];
for (const size of SIZES) {
  const ws = join(ROOT, size.name.toLowerCase());
  makeWorkspace(ws, size);

  const t0 = now();
  const proc = spawn(BIN, ['--headless'], {
    cwd: ws, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), TYPST_WORKSPACE: ws },
  });
  await waitReady();
  const startup = now() - t0;
  await sleep(300);
  const rssStart = rssMB(proc.pid);

  const tree = await timeIt(20, () => fetch(`http://127.0.0.1:${PORT}/workspace`).then(r => r.json()));
  const search = await timeIt(20, () =>
    fetch(`http://127.0.0.1:${PORT}/workspace/search?q=degenerate`).then(r => r.text()));

  const fileOps = await timeIt(10, async i => {
    const p = `bench_${i}.typ`;
    await fetch(`http://127.0.0.1:${PORT}/workspace/file?path=${p}`, { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } });
    await fetch(`http://127.0.0.1:${PORT}/workspace/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: p, to: `r_${p}` }) });
    await fetch(`http://127.0.0.1:${PORT}/workspace/file?path=r_${p}`, { method: 'DELETE' });
  });

  const compile = await timeIt(5, () =>
    fetch(`http://127.0.0.1:${PORT}/compile?main=main.typ`, { method: 'POST' }).then(r => r.arrayBuffer()));

  // hammer it to surface leaks
  for (let i = 0; i < 100; i++) {
    await fetch(`http://127.0.0.1:${PORT}/workspace`).then(r => r.json());
    await fetch(`http://127.0.0.1:${PORT}/workspace/search?q=degenerate`).then(r => r.text());
  }
  await sleep(500);
  const rssLoad = rssMB(proc.pid);

  results.push({
    workspace: size.name, files: size.chapters + 2, startupMs: startup,
    treeAvg: tree.avg, searchAvg: search.avg, searchWorst: search.worst,
    fileOpAvg: fileOps.avg, compileAvg: compile.avg,
    rssStart, rssLoad, rssGrowth: rssLoad - rssStart,
  });
  console.log(`${size.name.padEnd(7)} tree ${tree.avg.toFixed(1)}ms  search ${search.avg.toFixed(1)}ms (worst ${search.worst.toFixed(1)})  fileop ${fileOps.avg.toFixed(1)}ms  compile ${compile.avg.toFixed(0)}ms  RSS ${rssStart.toFixed(0)}→${rssLoad.toFixed(0)}MB`);

  proc.kill();
  await sleep(500);
}

writeFileSync('bench-results.json', JSON.stringify(results, null, 2));
console.log('\nwrote bench-results.json');
rmSync(ROOT, { recursive: true, force: true });
