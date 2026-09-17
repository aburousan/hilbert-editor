// Where the label graph puts each label, and how long it takes to decide.
//
// The push-and-pull used to compare every label with every other one, which a
// paper with hundreds of cross-references felt as a pause when the window
// opened. It now looks only at the neighbours within reach along the page.
// This checks the picture is the same one, and that it stays quick.
//
//   node scripts/test-label-layout.mjs
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const { HEIGHT, layout, settle, widthFor } = await import(pathToFileURL(join(root, 'src/labelLayout.ts')).href);

let failures = 0;
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

// A document of `n` labels, referring to each other the way a paper does.
const paper = n => ({
  nodes: Array.from({ length: n }, (_, i) => ({
    id: `eq:${i}`, kind: i % 7 === 0 ? 'fig' : 'eq', file: 'main.typ', line: i * 3,
    section: `Section ${Math.floor(i / 12)}`, referenced: i % 4, defined: 1,
  })),
  edges: Array.from({ length: Math.round(n * 1.8) }, (_, i) => ({
    from: `eq:${i % n}`, to: `eq:${(i * 7 + 3) % n}`, file: 'main.typ', line: i, uses: 1 + (i % 3),
  })),
  missing: [], files: ['main.typ'],
});

// The way it used to be worked out: every label against every other.
const settleEveryPair = (nodes, edges, rounds = 320) => {
  const at = new Map(nodes.map((n, i) => [n.id, i]));
  for (let round = 0; round < rounds; round++) {
    const cooling = 1 - round / rounds;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      if (a.pinned) continue;
      let push = 0;
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 > 90000 || d2 < 0.01) continue;
        push += (dy / Math.sqrt(d2)) * (44000 / d2);
      }
      a.vy += push;
    }
    for (const edge of edges) {
      const i = at.get(edge.from), j = at.get(edge.to);
      if (i === undefined || j === undefined) continue;
      const a = nodes[i], b = nodes[j], pull = (a.y - b.y) * 0.012;
      if (!a.pinned) a.vy -= pull;
      if (!b.pinned) b.vy += pull;
    }
    for (const node of nodes) {
      if (node.pinned) continue;
      node.vy += (HEIGHT / 2 - node.y) * 0.004;
      node.x += (node.home - node.x) * 0.25;
      node.vy *= 0.82 * cooling + 0.1;
      node.y = Math.max(40, Math.min(HEIGHT - 40, node.y + node.vy));
    }
  }
};

for (const size of [40, 150, 400]) {
  const graph = paper(size);
  const mine = layout(graph);
  const reference = layout(graph);
  const started = performance.now();
  settle(mine, graph.edges);
  const quick = performance.now() - started;
  const slowStarted = performance.now();
  settleEveryPair(reference, graph.edges);
  const slow = performance.now() - slowStarted;
  const drift = Math.max(...mine.map((p, i) => Math.abs(p.y - reference[i].y)));
  check(`${size} labels land in the same places`, drift < 1e-6, `worst difference ${drift.toFixed(9)} pt`);
  check(`${size} labels settle quickly`, quick <= Math.max(60, slow), `${quick.toFixed(0)} ms, every-pair takes ${slow.toFixed(0)} ms`);
}

// A crowded paper is the case that used to hurt: it must stay well under a
// second, or the window visibly waits before it draws anything.
const big = paper(1200);
const placed = layout(big);
const started = performance.now();
settle(placed, big.edges);
const took = performance.now() - started;
check('a paper with 1200 labels settles without a pause', took < 700, `${took.toFixed(0)} ms`);

// Document order left to right, and enough room that labels are not on top of
// each other.
const ordered = layout(paper(200));
const rising = ordered.every((p, i) => i === 0 || p.home >= ordered[i - 1].home);
check('labels keep document order across the page', rising);
const gaps = ordered.slice(1).map((p, i) => p.home - ordered[i].home);
check('and are spaced out rather than stacked', Math.min(...gaps) > 20, `closest pair ${Math.min(...gaps).toFixed(1)} pt apart`);
check('the page grows with the document', widthFor(1000) > widthFor(50), `${widthFor(50)} → ${widthFor(1000)}`);
check('every label stays on the page', placed.every(p => p.y >= 40 && p.y <= HEIGHT - 40));

console.log(failures ? `\nlabel layout: ${failures} check(s) failed` : '\nlabel layout: the same picture, far quicker');
process.exit(failures ? 1 : 0);
