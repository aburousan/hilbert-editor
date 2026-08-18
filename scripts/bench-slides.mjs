// What a drag in Slide Studio costs, as the deck gets longer.
//
//   node scripts/bench-slides.mjs            # 6, 24, 60 and 120 slides
//   node scripts/bench-slides.mjs 24 240     # whichever sizes you want
//
// Starts its own Vite on a spare port, mounts the studio on a synthetic deck,
// grabs an element and walks the pointer across sixty frames. The number that
// matters is Chrome's own task time per frame — script, style, layout and paint
// together — because that is what a dropped frame is made of. React's Profiler
// only sees its own render phase and will happily tell you a slower version is
// faster; both are reported so the difference stays visible.

import { spawn } from 'child_process';
import puppeteer from 'puppeteer';

const SIZES = process.argv.slice(2).map(Number).filter(n => n > 0);
const DECKS = SIZES.length ? SIZES : [6, 24, 60, 120];
const PORT = 5197;
const FRAMES = 60;

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const stop = () => { try { vite.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(1); });

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('vite did not start')), 60000);
  vite.stdout.on('data', chunk => {
    if (String(chunk).includes('ready in')) { clearTimeout(timer); resolve(); }
  });
});

const browser = await puppeteer.launch({ headless: 'new' });
const rows = [];

for (const slides of DECKS) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 950 });
  await page.goto(`http://localhost:${PORT}/scripts/bench-slides.html?slides=${slides}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.slide-canvas', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1500));   // let the debounced preview pass settle

  const before = await page.metrics();
  const react = await page.evaluate(async (frames) => {
    const canvas = document.querySelector('.slide-canvas');
    const box = canvas.getBoundingClientRect();
    const k = box.width / 841.89;
    const at = (x, y, type, buttons = 1) => canvas.dispatchEvent(new MouseEvent(type, {
      clientX: box.left + x * k, clientY: box.top + y * k, buttons, bubbles: true, cancelable: true,
    }));
    at(360, 320, 'mousedown');
    await new Promise(r => requestAnimationFrame(r));
    window.__commits.length = 0;
    for (let i = 0; i < frames; i++) {
      at(360 + i, 320 + (i % 12), 'mousemove');
      await new Promise(r => requestAnimationFrame(r));
    }
    at(420, 330, 'mouseup', 0);
    const c = [...window.__commits];
    return { render: c.reduce((a, b) => a + b, 0) / frames, worst: Math.max(...c) };
  }, FRAMES);
  const after = await page.metrics();

  rows.push({
    slides,
    task: (after.TaskDuration - before.TaskDuration) * 1000 / FRAMES,
    render: react.render,
    worst: react.worst,
    nodes: after.Nodes,
  });
  await page.close();
}

await browser.close();
stop();

console.log('slides   task/frame   react render   worst commit   DOM nodes');
for (const r of rows) {
  console.log(
    String(r.slides).padStart(6),
    `${r.task.toFixed(2)} ms`.padStart(12),
    `${r.render.toFixed(2)} ms`.padStart(14),
    `${r.worst.toFixed(2)} ms`.padStart(14),
    String(r.nodes).padStart(11),
  );
}
