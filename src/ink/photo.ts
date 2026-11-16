// A photo or screenshot of maths to pen strokes, so the model can read it.
//
// From ink2latex by Kazi Abu Rousan (demo/photo.js, also offered under MIT),
// kept in step with ink2latex/photo.py: integer rounding, neighbour order and
// tie-breaking all match, and the r3-photo model was trained on exactly these
// traced strokes. The picture never leaves the computer.
import { bands, type Box } from './features';

type Line = number[][];

function resize(gray: Uint8Array[]) {
  const h = gray.length, w = gray[0].length, scale = Math.min(1, 1200 / Math.max(h, w));
  const nh = Math.max(1, Math.floor(h * scale)), nw = Math.max(1, Math.floor(w * scale));
  if (nh === h && nw === w) return { gray: Uint8Array.from(gray.flatMap(row => Array.from(row, v => Math.floor(v + .5)))), w, h, scale: [1, 1] };
  const horizontal = new Float64Array(h * nw), output = new Uint8Array(nh * nw);
  for (let x = 0; x < nw; x++) {
    const a = x * w, b = (x + 1) * w;
    for (let j = Math.floor(a / nw); j <= Math.floor((b - 1) / nw); j++) {
      const weight = Math.min(b, (j + 1) * nw) - Math.max(a, j * nw);
      for (let y = 0; y < h; y++) horizontal[y * nw + x] += Math.floor(gray[y][j] + .5) * weight;
    }
  }
  for (let y = 0; y < nh; y++) {
    const a = y * h, b = (y + 1) * h, sums = new Float64Array(nw);
    for (let j = Math.floor(a / nh); j <= Math.floor((b - 1) / nh); j++) {
      const weight = Math.min(b, (j + 1) * nh) - Math.max(a, j * nh);
      for (let x = 0; x < nw; x++) sums[x] += weight * horizontal[j * nw + x];
    }
    for (let x = 0; x < nw; x++) output[y * nw + x] = Math.floor((sums[x] + Math.floor(h * w / 2)) / (h * w));
  }
  return { gray: output, w: nw, h: nh, scale: [w / nw, h / nh] };
}

function threshold(gray: Uint8Array, w: number, h: number): Uint8Array {
  const r = Math.max(1, Math.floor(Math.min(h, w) / 20)), stride = w + 1;
  const integral = new Float64Array((h + 1) * stride), flat = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integral[(y + 1) * stride + x + 1] = row + integral[y * stride + x + 1];
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const ya = Math.max(0, y - r), yb = Math.min(h, y + r + 1), xa = Math.max(0, x - r), xb = Math.min(w, x + r + 1);
    const total = integral[yb * stride + xb] - integral[ya * stride + xb] - integral[yb * stride + xa] + integral[ya * stride + xa];
    flat[y * w + x] = Math.min(255, Math.floor((gray[y * w + x] * 255 * (yb - ya) * (xb - xa) + Math.floor(total / 2)) / Math.max(1, total)));
  }
  return otsu(flat);
}

function otsu(gray: Uint8Array): Uint8Array {
  const hist = new Float64Array(256), size = gray.length;
  for (const v of gray) hist[v]++;
  let full = 0, count = 0, weighted = 0, best = -1, cut = 0;
  for (let i = 0; i < 256; i++) full += i * hist[i];
  for (let i = 0; i < 256; i++) {
    count += hist[i]; weighted += i * hist[i];
    if (!count || count === size) continue;
    const score = (full * count - weighted * size) ** 2 / (count * (size - count));
    if (score > best) { best = score; cut = i; }
  }
  return gray.map(v => +(best >= 0 && v <= cut));
}

function neighbors(p: number, w: number, h: number): number[] {
  const x = p % w, y = Math.floor(p / w), result: number[] = [];
  for (let yy = Math.max(0, y - 1); yy < Math.min(h, y + 2); yy++)
    for (let xx = Math.max(0, x - 1); xx < Math.min(w, x + 2); xx++)
      if (xx !== x || yy !== y) result.push(yy * w + xx);
  return result;
}

function components(mask: Uint8Array, w: number, h: number): number[][] {
  const seen = new Uint8Array(mask.length), groups: number[][] = [];
  for (let first = 0; first < mask.length; first++) {
    if (!mask[first] || seen[first]) continue;
    const group = [first]; seen[first] = 1;
    for (let i = 0; i < group.length; i++) for (const q of neighbors(group[i], w, h)) {
      if (mask[q] && !seen[q]) { seen[q] = 1; group.push(q); }
    }
    groups.push(group);
  }
  return groups;
}

// Zhang–Suen thinning to a one-pixel skeleton.
function thin(mask: Uint8Array, w: number, h: number): Uint8Array {
  const stride = w + 2, a = new Uint8Array((h + 2) * stride);
  for (let y = 0; y < h; y++) a.set(mask.subarray(y * w, (y + 1) * w), (y + 1) * stride + 1);
  const offsets = [-stride, -stride + 1, 1, stride + 1, stride, stride - 1, -1, -stride - 1];
  for (;;) {
    let changed = false;
    for (let phase = 0; phase < 2; phase++) {
      const remove: number[] = [];
      for (let y = 1; y <= h; y++) for (let x = 1; x <= w; x++) {
        const i = y * stride + x;
        if (!a[i]) continue;
        const p = offsets.map(o => a[i + o]), count = p.reduce((s, v) => s + v, 0);
        let transitions = 0;
        for (let j = 0; j < 8; j++) if (!p[j] && p[(j + 1) % 8]) transitions++;
        const products = phase === 0 ? [p[0] * p[2] * p[4], p[2] * p[4] * p[6]] : [p[0] * p[2] * p[6], p[0] * p[4] * p[6]];
        if (count >= 2 && count <= 6 && transitions === 1 && products.every(v => v === 0)) remove.push(i);
      }
      for (const i of remove) a[i] = 0;
      if (remove.length) changed = true;
    }
    if (!changed) break;
  }
  const result = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) result.set(a.subarray((y + 1) * stride + 1, (y + 1) * stride + w + 1), y * w);
  return result;
}

function length(line: Line): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return total;
}

function trace(skeleton: Uint8Array, w: number, h: number, width: number): Line[] {
  const pixels: number[] = [], adjacent = new Map<number, number[]>(), visited = new Set<number>(), lines: Line[] = [];
  for (let p = 0; p < skeleton.length; p++) if (skeleton[p]) pixels.push(p);
  for (const p of pixels) adjacent.set(p, neighbors(p, w, h).filter(q => skeleton[q]));
  for (const group of components(skeleton, w, h)) if (group.length <= 1.5 * width) {
    const first = group.reduce((a, b) => Math.min(a, b));
    lines.push([[first % w, Math.floor(first / w)]]);
    for (const p of group) visited.add(p);
  }
  for (const start of [...pixels.filter(p => adjacent.get(p)!.length === 1), ...pixels]) {
    if (visited.has(start)) continue;
    const path: Line = [];
    let p = start, previous: number | null = null;
    for (;;) {
      path.push([p % w, Math.floor(p / w)]); visited.add(p);
      const choices = adjacent.get(p)!.filter(q => !visited.has(q));
      if (!choices.length) break; // through junctions, as photo.py
      if (previous !== null) {
        const dx = p % w - previous % w, dy = Math.floor(p / w) - Math.floor(previous / w);
        const straight = (q: number) => {
          const qx = q % w - p % w, qy = Math.floor(q / w) - Math.floor(p / w);
          return (dx * qx + dy * qy) / Math.hypot(qx, qy);
        };
        choices.sort((a, b) => straight(b) - straight(a));
      }
      previous = p; p = choices[0];
    }
    if (length(path) >= 1.5 * width) lines.push(path);
  }
  return lines;
}

function merge(lines: Line[], width: number): Line[] {
  const cosine = Math.cos(40 * Math.PI / 180);
  for (;;) {
    let best: [number, number, number, Line] | null = null;
    for (let i = 0; i < lines.length; i++) {
      const a = lines[i];
      if (a.length < 2) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const b = lines[j];
        if (b.length < 2) continue;
        for (const ra of [false, true]) for (const rb of [false, true]) {
          const aa = ra ? [...a].reverse() : a, bb = rb ? [...b].reverse() : b;
          const end = aa[aa.length - 1];
          const distance = Math.hypot(end[0] - bb[0][0], end[1] - bb[0][1]);
          if (distance > 1.5 * width) continue;
          const k = Math.min(aa.length - 1, Math.max(1, Math.floor(width))), l = Math.min(bb.length - 1, Math.max(1, Math.floor(width)));
          const back = aa[aa.length - 1 - k];
          const u = [end[0] - back[0], end[1] - back[1]];
          const v = [bb[l][0] - bb[0][0], bb[l][1] - bb[0][1]], norm = Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]);
          if (norm && (u[0] * v[0] + u[1] * v[1]) / norm > cosine && (!best || distance < best[0])) best = [distance, i, j, [...aa, ...bb]];
        }
      }
    }
    if (!best) return lines;
    lines[best[1]] = best[3]; lines.splice(best[2], 1);
  }
}

// Douglas–Peucker with a quarter-pixel tolerance.
function simplify(line: Line): Line {
  if (line.length <= 2) return line;
  const keep = new Set([0, line.length - 1]), stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!, dx = line[b][0] - line[a][0], dy = line[b][1] - line[a][1], norm = dx * dx + dy * dy;
    let maximum = .25, index: number | null = null;
    for (let i = a + 1; i < b; i++) {
      const x = line[i][0] - line[a][0], y = line[i][1] - line[a][1];
      const t = norm ? Math.max(0, Math.min(1, (x * dx + y * dy) / norm)) : 0;
      const distance = (x - t * dx) ** 2 + (y - t * dy) ** 2;
      if (distance > maximum) { maximum = distance; index = i; }
    }
    if (index !== null) { keep.add(index); stack.push([a, index], [index, b]); }
  }
  return [...keep].sort((a, b) => a - b).map(i => line[i]);
}

// Writing order: rows, then columns inside a row, then stacked parts inside a column, and so on (photo.py _arrange).
function arrange(ids: number[], boxes: Box[], dots: Set<number>, rows = true, depth = 0): number[] {
  if (ids.length <= 1 || depth > 12) return [...ids];
  let parts = bands(ids, boxes, rows ? 1 : 0);
  if (parts.length === 1) {
    rows = !rows;
    parts = bands(ids, boxes, rows ? 1 : 0);
    if (parts.length === 1) return [...ids].sort((a, b) => boxes[a][0] - boxes[b][0] || boxes[a][1] - boxes[b][1] || a - b);
  }
  if (rows) for (let k = 0; k < parts.length - 1; k++) {
    if (parts[k].every(i => dots.has(i))) { [parts[k], parts[k + 1]] = [parts[k + 1], parts[k]]; k++; }
  }
  return parts.flatMap(part => arrange(part, boxes, dots, !rows, depth + 1));
}

function order(lines: Line[], width: number): Line[] {
  const boxes: Box[] = lines.map(s => s.reduce<Box>((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]));
  const dots = new Set(lines.flatMap((s, i) => (s.length === 1 ? [i] : [])));
  // A dot far from all other ink is a speck, not an i's dot or a \cdot.
  const heights = boxes.flatMap((b, i) => (dots.has(i) ? [] : [b[3] - b[1]])).sort((a, b) => a - b);
  const specks = new Set<number>();
  if (heights.length) {
    const reach = Math.max(3 * width, .6 * heights[Math.floor(heights.length / 2)]);
    const gap = (i: number, j: number) => Math.max(boxes[j][0] - boxes[i][2], boxes[i][0] - boxes[j][2], boxes[j][1] - boxes[i][3], boxes[i][1] - boxes[j][3], 0);
    for (const i of dots) if (boxes.every((_, j) => dots.has(j) || gap(i, j) > reach)) specks.add(i);
  }
  const keep = lines.map((_, i) => i).filter(i => !specks.has(i));
  return arrange(keep, boxes, dots).map(i => {
    const line = lines[i], last = line[line.length - 1], dx = last[0] - line[0][0], dy = last[1] - line[0][1];
    const vertical = Math.abs(dx) <= width && Math.abs(dy) > Math.abs(dx);
    return (vertical && dy < 0) || (!vertical && dx < -width) ? [...line].reverse() : line;
  });
}

// A grey picture (rows of 0..255) to strokes [x, y, t] in its own pixels.
export function imageToStrokes(input: Uint8Array[]): [number, number, number][][] {
  if (!input.length) return [];
  const columns = input[0].length;
  if (input.some(row => row.length !== columns)) throw new Error('Expected a 2D grey image');
  if (!columns) return [];
  const resized = resize(input), { w, h, scale } = resized;
  let gray = resized.gray;
  if (otsu(gray).reduce((a, b) => a + b, 0) > gray.length / 2) gray = gray.map(v => 255 - v);
  let ink = threshold(gray, w, h);
  if (ink.reduce((a, b) => a + b, 0) > ink.length / 2) ink = threshold(gray.map(v => 255 - v), w, h);
  for (const group of components(ink, w, h)) if (group.length < ink.length * .0002) for (const p of group) ink[p] = 0;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let p = 0; p < ink.length; p++) if (ink[p]) {
    x0 = Math.min(x0, p % w); x1 = Math.max(x1, p % w); y0 = Math.min(y0, Math.floor(p / w)); y1 = Math.max(y1, Math.floor(p / w));
  }
  if (x1 < 0) return [];
  x0 = Math.max(0, x0 - 4); y0 = Math.max(0, y0 - 4); x1 = Math.min(w, x1 + 5); y1 = Math.min(h, y1 + 5);
  const cw = x1 - x0, ch = y1 - y0, crop = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) crop.set(ink.subarray((y + y0) * w + x0, (y + y0) * w + x1), y * cw);
  const skeleton = thin(crop, cw, ch), count = skeleton.reduce((a, b) => a + b, 0);
  if (!count) return [];
  const width = 2 * crop.reduce((a, b) => a + b, 0) / count;
  let time = 0;
  return order(merge(trace(skeleton, cw, ch, width), width).map(simplify), width)
    .map(line => line.map(([x, y]) => [(x + x0) * scale[0], (y + y0) * scale[1], time++] as [number, number, number]));
}

// An image file (photo, screenshot, scan) to strokes, drawn on white so a
// transparent PNG reads as dark ink on paper.
export async function fileToStrokes(file: Blob): Promise<[number, number, number][][]> {
  const url = URL.createObjectURL(file);
  try {
    const picture = new Image();
    picture.src = url;
    await picture.decode();
    const canvas = document.createElement('canvas');
    canvas.width = picture.naturalWidth; canvas.height = picture.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(picture, 0, 0);
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const gray = Array.from({ length: canvas.height }, (_, y) => Uint8Array.from({ length: canvas.width }, (_, x) => {
      const i = 4 * (y * canvas.width + x);
      return Math.floor((299 * rgba[i] + 587 * rgba[i + 1] + 114 * rgba[i + 2] + 500) / 1000);
    }));
    return imageToStrokes(gray);
  } finally {
    URL.revokeObjectURL(url);
  }
}
