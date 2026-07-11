// Shared phrase matcher for bidirectional PDF ↔ source sync.
//
// Both directions boil down to the same problem: we have a short run of words
// taken from one side (the "phrase", with a designated focus word that was
// clicked / under the cursor) and a long list of words from the other side
// (the "haystack"). We want the haystack position that aligns with the focus
// word, disambiguated by how much of the surrounding phrase also lines up.
//
// Matching a multi-word phrase — not a single word — is what makes this robust:
// a lone "the" occurs everywhere, but "the the cat sat" almost never does. When
// the phrase can't be pinned down we say so (low score) rather than guess.

export type SyncPayload = {
  words: string[]; // normalized words around the focus, in reading order
  focus: number;   // index into `words` of the clicked / cursor word
  docFraction: number; // 0..1 position of the focus in its document (a prior)
};

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}_'’-]*/gu;

/** Lowercase and strip edge punctuation, keeping intra-word marks (’, -, _). */
export function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** Split a line of text into normalized words, keeping each word's 0-based offset. */
export function tokenizeLine(text: string): { w: string; offset: number }[] {
  const out: { w: string; offset: number }[] = [];
  let m: RegExpExecArray | null;
  WORD_RE.lastIndex = 0;
  while ((m = WORD_RE.exec(text))) out.push({ w: m[0].toLowerCase(), offset: m.index });
  return out;
}

interface MatchResult {
  index: number;   // haystack index aligned to phrase[focus]
  score: number;   // matched neighbours (0 = only the focus word lined up)
  ambiguous: boolean; // true when several equally-good candidates remain
}

// How far to look on each side, and how many non-matching haystack tokens we'll
// step over (inline markup like `#emph[...]` injects extra source tokens).
const REACH = 8;
const SKIP_BUDGET = 4;

function sideScore(hay: string[], phrase: string[], hayStart: number, phraseStart: number, dir: -1 | 1): number {
  let hp = hayStart;
  let pp = phraseStart;
  let skips = 0;
  let score = 0;
  let steps = 0;
  while (pp >= 0 && pp < phrase.length && hp >= 0 && hp < hay.length && steps < REACH + SKIP_BUDGET) {
    steps++;
    if (hay[hp] === phrase[pp]) {
      score++;
      hp += dir;
      pp += dir;
    } else if (skips < SKIP_BUDGET) {
      skips++;
      hp += dir; // step over an unmatched haystack token (markup, hyphenation…)
    } else {
      break;
    }
  }
  return score;
}

/**
 * Find the haystack index that best aligns with `phrase[focus]`.
 * `priorIndex` (if given) breaks ties toward the geometrically-expected spot.
 * Returns null when the focus word doesn't occur in the haystack at all.
 */
export function bestMatch(
  hay: string[],
  phrase: string[],
  focus: number,
  priorIndex: number | null,
): MatchResult | null {
  const target = phrase[focus];
  if (!target) return null;

  const candidates: number[] = [];
  for (let i = 0; i < hay.length; i++) if (hay[i] === target) candidates.push(i);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { index: candidates[0], score: contextScore(hay, phrase, candidates[0], focus), ambiguous: false };

  let best = candidates[0];
  let bestScore = -1;
  let bestTies = 0;
  for (const i of candidates) {
    const score = contextScore(hay, phrase, i, focus);
    const better =
      score > bestScore ||
      (score === bestScore && priorIndex != null && Math.abs(i - priorIndex) < Math.abs(best - priorIndex));
    if (score > bestScore) bestTies = 1;
    else if (score === bestScore) bestTies++;
    if (better) {
      best = i;
      bestScore = score;
    }
  }
  // Ambiguous when the winner earned no context and several candidates tied on
  // that empty score — the phrase simply didn't disambiguate anything.
  const ambiguous = bestScore === 0 && bestTies > 1;
  return { index: best, score: bestScore, ambiguous };
}

function contextScore(hay: string[], phrase: string[], hayFocus: number, focus: number): number {
  return sideScore(hay, phrase, hayFocus - 1, focus - 1, -1) + sideScore(hay, phrase, hayFocus + 1, focus + 1, 1);
}
