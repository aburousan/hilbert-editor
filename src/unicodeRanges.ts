const MARK = /^\p{Mark}$/u;

let segmenter: Intl.Segmenter | null | undefined;

function getSegmenter(): Intl.Segmenter | null {
  if (segmenter !== undefined) return segmenter;
  try {
    segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  } catch {
    segmenter = null;
  }
  return segmenter;
}

function isVariationSelector(codePoint: number): boolean {
  return (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
}

function isEmojiModifier(codePoint: number): boolean {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function fallbackBoundaries(text: string): number[] {
  const boundaries = [0];
  let offset = 0;
  let afterJoiner = false;
  let regionalRun = 0;

  for (const char of text) {
    const start = offset;
    const codePoint = char.codePointAt(0)!;
    offset += char.length;
    if (start === 0) {
      afterJoiner = char === '\u200d';
      regionalRun = isRegionalIndicator(codePoint) ? 1 : 0;
      continue;
    }

    const regional = isRegionalIndicator(codePoint);
    const extendsPrevious = MARK.test(char) || isVariationSelector(codePoint) ||
      isEmojiModifier(codePoint) || char === '\u200d' || afterJoiner ||
      (regional && regionalRun % 2 === 1);
    if (!extendsPrevious) boundaries.push(start);

    afterJoiner = char === '\u200d';
    regionalRun = regional ? regionalRun + 1 : 0;
  }
  if (boundaries[boundaries.length - 1] !== text.length) boundaries.push(text.length);
  return boundaries;
}

// Segmenting a large document costs far more than any lookup into it, and
// callers (proofread placement, selection snapping) ask about many offsets in
// the same text, so keep the boundaries of the most recent text around.
let cachedText: string | null = null;
let cachedBoundaries: number[] | null = null;

export function graphemeBoundaries(text: string): number[] {
  if (!text) return [0];
  if (cachedBoundaries && text === cachedText) return cachedBoundaries;
  const active = getSegmenter();
  const boundaries = active ? [0] : fallbackBoundaries(text);
  if (active) {
    for (const part of active.segment(text)) {
      if (part.index > 0) boundaries.push(part.index);
    }
  }
  if (boundaries[boundaries.length - 1] !== text.length) boundaries.push(text.length);
  cachedText = text;
  cachedBoundaries = boundaries;
  return boundaries;
}

function floorBoundary(boundaries: number[], offset: number): number {
  let low = 0;
  let high = boundaries.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (boundaries[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return boundaries[Math.max(0, high)];
}

function ceilBoundary(boundaries: number[], offset: number): number {
  let low = 0;
  let high = boundaries.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (boundaries[mid] < offset) low = mid + 1;
    else high = mid - 1;
  }
  return boundaries[Math.min(boundaries.length - 1, low)];
}

export function snapUtf16OffsetToGrapheme(text: string, offset: number, direction: 'backward' | 'forward'): number {
  const clamped = Math.max(0, Math.min(text.length, Math.trunc(offset)));
  const boundaries = graphemeBoundaries(text);
  return direction === 'backward' ? floorBoundary(boundaries, clamped) : ceilBoundary(boundaries, clamped);
}

export function snapUtf16RangeToGraphemes(text: string, start: number, end: number): { start: number; end: number } {
  const from = Math.max(0, Math.min(text.length, Math.trunc(Math.min(start, end))));
  const to = Math.max(0, Math.min(text.length, Math.trunc(Math.max(start, end))));
  const boundaries = graphemeBoundaries(text);
  return { start: floorBoundary(boundaries, from), end: ceilBoundary(boundaries, to) };
}
