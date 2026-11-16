// Pen strokes to the model's input, and separate lines of maths.
//
// From ink2latex by Kazi Abu Rousan (demo/features.js and demo/photo.js), kept
// in step with ink2latex/features.py: the model was trained on exactly this.
// Those two files are also offered under the MIT licence, so this port is MIT
// like the rest of Hilbert. The model weights are not: see README, License.

export type Point = [number, number] | [number, number, number];
export type Stroke = Point[];

export const MAX_POINTS = 1600;
const STEP = 0.05;

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lo = Math.floor(index), hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

function resample(xy: number[][]): number[][] {
  const positions = [xy[0]], distances = [0];
  let length = 0;
  for (let i = 1; i < xy.length; i++) {
    const delta = Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
    length += delta;
    if (delta > 0) {
      positions.push(xy[i]);
      distances.push(length);
    }
  }
  if (length < STEP) return [xy[0]];
  const targets: number[] = [];
  for (let i = 0; i * STEP < length; i++) targets.push(i * STEP);
  targets.push(length);
  let segment = 1;
  return targets.map(target => {
    while (segment < distances.length - 1 && distances[segment] < target) segment++;
    const ratio = (target - distances[segment - 1]) / (distances[segment] - distances[segment - 1]);
    return [0, 1].map(k => positions[segment - 1][k] + ratio * (positions[segment][k] - positions[segment - 1][k]));
  });
}

// Eight numbers per point: position, step to the next point, first and last
// point of a stroke, and the way to the stroke's centre.
export function features(input: Stroke[]): number[][] {
  const strokes = input.filter(s => s.length).map(s => s.map(p => [p[0], p[1]]));
  if (!strokes.length) return [];
  const all = strokes.flat();
  if (all.some(p => p.some(v => !Number.isFinite(v)))) throw new Error('Ink coordinates must be finite');
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  const minX = xs.reduce((a, b) => Math.min(a, b), Infinity);
  const minY = ys.reduce((a, b) => Math.min(a, b), Infinity);
  const height = percentile(ys, .95) - percentile(ys, .05);
  const width = percentile(xs, .95) - percentile(xs, .05);
  const scale = Math.max(height >= 1e-6 ? height : width, 1e-6);
  let rows: number[][] = [];
  for (const stroke of strokes) {
    const xy = resample(stroke.map(([x, y]) => [(x - minX) / scale, (y - minY) / scale]));
    const center = xy.reduce((sum, p) => [sum[0] + p[0], sum[1] + p[1]], [0, 0]).map(v => v / xy.length);
    for (let i = 0; i < xy.length; i++) {
      const [x, y] = xy[i], next = xy[i + 1] || xy[i];
      rows.push([x, y, next[0] - x, next[1] - y, +(i === 0), +(i === xy.length - 1), center[0] - x, center[1] - y].map(Math.fround));
    }
  }
  if (rows.length > MAX_POINTS) {
    const original = rows;
    rows = Array.from({ length: MAX_POINTS }, (_, i) => original[Math.floor(i * (original.length - 1) / (MAX_POINTS - 1) + .5)]);
  }
  return rows;
}

type Box = [number, number, number, number];

function bands(ids: number[], boxes: Box[], axis: 0 | 1): number[][] {
  const lo = axis ? 1 : 0, hi = axis ? 3 : 2;
  let groups: [number, number, number[]][] = [];
  const sorted = [...ids].sort((a, b) => boxes[a][lo] - boxes[b][lo] || boxes[a][1 - axis] - boxes[b][1 - axis] || a - b);
  for (const i of sorted) {
    const a0 = boxes[i][lo], a1 = boxes[i][hi];
    const joins = (g: [number, number, number[]]) => axis ? a0 <= g[1] && a1 >= g[0] : Math.min(a1, g[1]) - Math.max(a0, g[0]) > .5 * Math.min(a1 - a0, g[1] - g[0]);
    const group: [number, number, number[]] = [a0, a1, [i]];
    for (const g of groups.filter(joins)) { group[0] = Math.min(group[0], g[0]); group[1] = Math.max(group[1], g[1]); group[2].push(...g[2]); }
    groups = groups.filter(g => !joins(g)); groups.push(group);
  }
  return groups.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(g => g[2]);
}

// Separate lines of maths (a system of equations): rows with nothing joining
// them, each of 3 strokes or more, wide (half the ink's width), of similar
// height (0.6 of the tallest) with a clear gap (0.15 of the tallest) between.
// A fraction's bar, lim over x->3, or an i's dot are never lines of their own.
export function splitLines(strokes: Stroke[]): Stroke[][] {
  if (strokes.length < 2) return [strokes];
  const boxes: Box[] = strokes.map(s => s.reduce<Box>((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]));
  const rows = bands(strokes.map((_, i) => i), boxes, 1);
  if (rows.length < 2) return [strokes];
  const box = (ids: number[]) => ids.reduce<Box>((b, i) => [Math.min(b[0], boxes[i][0]), Math.min(b[1], boxes[i][1]), Math.max(b[2], boxes[i][2]), Math.max(b[3], boxes[i][3])], [Infinity, Infinity, -Infinity, -Infinity]);
  const all = box(strokes.map((_, i) => i)), width = all[2] - all[0];
  // A long flat stroke is a fraction bar (touching its denominator, it looked like a line break): one formula.
  if (boxes.some(b => b[2] - b[0] >= .4 * width && b[3] - b[1] <= .15 * (b[2] - b[0]))) return [strokes];
  const rb = rows.map(box), tallest = Math.max(...rb.map(b => b[3] - b[1]));
  const lines = rb.every((b, k) => rows[k].length >= 3 && b[2] - b[0] >= .5 * width && b[3] - b[1] >= .6 * tallest) &&
    rb.slice(1).every((b, k) => b[1] - rb[k][3] >= .15 * tallest);
  return lines ? rows.map(ids => [...ids].sort((a, b) => a - b).map(i => strokes[i])) : [strokes];
}
