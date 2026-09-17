// Where the labels sit: document order across the page, and a push-and-pull
// that settles their heights. Kept apart from the drawing so it can be checked
// on its own.
import type { Edge, Graph, Node } from './components/labelGraphTypes';

export type Placed = Node & { x: number; y: number; vy: number; home: number; pinned: boolean };

// A paper with a handful of labels fits the window; one with hundreds needs
// room, or they land on top of each other and nothing can be read. About 26
// points each keeps them apart, and the view can be dragged sideways.
export const WIDTH = 1600;
export const widthFor = (count: number) => Math.max(WIDTH, 180 + count * 26);
export const HEIGHT = 1150;

export function layout(graph: Graph): Placed[] {
  const order = [...graph.nodes].sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line);
  const span = Math.max(1, order.length - 1);
  const width = widthFor(order.length);
  return order.map((node, at) => {
    const home = 90 + (at / span) * (width - 260);
    return {
      ...node,
      home,
      x: home,
      // A repeatable starting spread: the same document always opens the same
      // way, which matters more here than an interesting one.
      y: HEIGHT / 2 + Math.sin(at * 2.399) * HEIGHT * 0.32,
      vy: 0,
      pinned: false,
    };
  });
}

// A few hundred rounds of push and pull. Small enough to run in one go for the
// dozens of labels a paper has, and it settles the same way every time.
// Labels only push each other apart within 300 points, and they sit in
// document order along the page, so each one needs to look no further than the
// neighbours either side of it — not at every other label in the paper.
export function settle(nodes: Placed[], edges: Edge[], rounds = 320) {
  const at = new Map(nodes.map((n, i) => [n.id, i]));
  // Document order to begin with, and barely disturbed afterwards, so one pass
  // of insertion sort keeps it in order each round.
  const order = nodes.map((_, i) => i);
  for (let round = 0; round < rounds; round++) {
    const cooling = 1 - round / rounds;
    for (let k = 1; k < order.length; k++) {
      const moving = order[k];
      let m = k - 1;
      while (m >= 0 && nodes[order[m]].x > nodes[moving].x) { order[m + 1] = order[m]; m--; }
      order[m + 1] = moving;
    }
    for (let k = 0; k < order.length; k++) {
      const a = nodes[order[k]];
      if (a.pinned) continue;
      let push = 0;
      for (let m = k - 1; m >= 0; m--) {
        const b = nodes[order[m]];
        const dx = a.x - b.x;
        if (dx > 300) break;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 90000 || d2 < 0.01) continue;
        push += (dy / Math.sqrt(d2)) * (44000 / d2);
      }
      for (let m = k + 1; m < order.length; m++) {
        const b = nodes[order[m]];
        const dx = b.x - a.x;
        if (dx > 300) break;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > 90000 || d2 < 0.01) continue;
        push += (dy / Math.sqrt(d2)) * (44000 / d2);
      }
      a.vy += push;
    }
    for (const edge of edges) {
      const i = at.get(edge.from);
      const j = at.get(edge.to);
      if (i === undefined || j === undefined) continue;
      const a = nodes[i];
      const b = nodes[j];
      const pull = (a.y - b.y) * 0.012;
      if (!a.pinned) a.vy -= pull;
      if (!b.pinned) b.vy += pull;
    }
    for (const node of nodes) {
      if (node.pinned) continue;
      node.vy += (HEIGHT / 2 - node.y) * 0.004;   // keep it on the page
      node.x += (node.home - node.x) * 0.25;       // hold document order
      node.vy *= 0.82 * cooling + 0.1;
      node.y = Math.max(40, Math.min(HEIGHT - 40, node.y + node.vy));
    }
  }
}

