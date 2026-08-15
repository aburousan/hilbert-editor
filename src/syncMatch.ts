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

// Which of a word's repeats this is, and how many there are in the document it
// came from. Only useful when the other side has the same number.
export type WordRepeat = { index: number; count: number };

export type SyncPayload = {
  words: string[]; // normalized words around the focus, in reading order
  focus: number;   // index into `words` of the clicked / cursor word
  docFraction: number; // 0..1 position of the focus in its document (a prior)
  // PDF page coordinates in Typst/PDF points, measured from the top-left.
  // Present for reverse sync; lets the backend resolve formulas whose rendered
  // glyph has no useful text token (fraction bars, =, delimiters, drawings).
  documentPosition?: { page: number; x: number; y: number };
  // True when the clicked PDF span contains a mathematical glyph/operator.
  // Repeated formulas need their compiled coordinate to break text-match ties.
  mathHint?: boolean;
  // Which repeat of the focus word this is, counted through the source.
  repeat?: WordRepeat | null;
};

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}\p{M}_'’-]*/gu;

// Typst's PDF contains the glyph the reader sees, while the source contains a
// symbol name. It also uses Mathematical Alphanumeric Unicode for variables
// (`𝑥`, `𝜋`, …), and pdf.js may put several formula atoms in one text span.
// Keep this table intentionally small and semantic: these are stable Typst math
// spellings, not a second parser or a large symbol database in the main bundle.
const MATH_GLYPH_NAMES: Record<string, string> = {
  '∞': 'infinity', '∫': 'integral', '∬': 'integral double', '∭': 'integral triple',
  '∑': 'sum', '∏': 'product', '√': 'sqrt', '∂': 'partial', '∇': 'nabla',
  'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon',
  'ζ': 'zeta', 'η': 'eta', 'θ': 'theta', 'ι': 'iota', 'κ': 'kappa',
  'λ': 'lambda', 'μ': 'mu', 'ν': 'nu', 'ξ': 'xi', 'ο': 'omicron',
  'π': 'pi', 'ρ': 'rho', 'σ': 'sigma', 'τ': 'tau', 'υ': 'upsilon',
  'φ': 'phi', 'χ': 'chi', 'ψ': 'psi', 'ω': 'omega',
  'Γ': 'Gamma', 'Δ': 'Delta', 'Θ': 'Theta', 'Λ': 'Lambda', 'Ξ': 'Xi',
  'Π': 'Pi', 'Σ': 'Sigma', 'Υ': 'Upsilon', 'Φ': 'Phi', 'Ψ': 'Psi', 'Ω': 'Omega',
};

/**
 * Tokenize text extracted from a rendered PDF. NFKC turns mathematical italic
 * letters into their source letters; named glyph expansion lets a click on ∑,
 * π, √, etc. find `sum`, `pi`, `sqrt` in Typst. WORD_RE then splits compact
 * pdf.js spans such as `𝑘=1` or `𝑛(𝑛+1)` into the same atoms as the source.
 */
export function tokenizeRenderedText(text: string): string[] {
  let expanded = '';
  for (const char of text.normalize('NFKC')) {
    const name = MATH_GLYPH_NAMES[char];
    expanded += name ? ` ${name} ` : char;
  }
  const words: string[] = [];
  let match: RegExpExecArray | null;
  WORD_RE.lastIndex = 0;
  while ((match = WORD_RE.exec(expanded))) words.push(match[0].toLowerCase());
  return words;
}

/**
 * Tokenize a Typst math source fragment into the atoms the compiled PDF emits.
 * Source syntax joins names to scripts (`integral_0`) and coefficients to
 * variables (`2x`), while pdf.js exposes those as independent glyph runs.
 */
export function tokenizeTypstMathSource(text: string): string[] {
  const withoutComments = text.replace(/\/\/.*$/, '');
  const separated = withoutComments
    .replace(/[_^()[\]{}=+\-*/,$#]/g, ' ')
    .replace(/([\p{L}\p{M}])(?=\p{N})|([\p{N}])(?=[\p{L}\p{M}])/gu, '$1$2 ');
  return tokenizeRenderedText(separated);
}

/** Lowercase and strip edge punctuation, keeping intra-word marks (’, -, _). */
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
 * `priorIndex` (if given) breaks ties toward the geometrically-expected spot,
 * and `repeat` settles them outright when both sides hold the same word the
 * same number of times.
 * Returns null when the focus word doesn't occur in the haystack at all.
 */
export function bestMatch(
  hay: string[],
  phrase: string[],
  focus: number,
  priorIndex: number | null,
  repeat?: WordRepeat | null,
): MatchResult | null {
  const target = phrase[focus];
  if (!target) return null;

  const candidates: number[] = [];
  for (let i = 0; i < hay.length; i++) if (hay[i] === target) candidates.push(i);
  if (candidates.length === 0) return null;

  // The same word, the same number of times on both sides: then the nth one
  // here is the nth one there, and nothing else needs deciding. Repeated text
  // is exactly where the surrounding words stop telling the candidates apart —
  // `Hellow world` written twice scores the same both times — and where the
  // guess from how far down the document it sits lands on the wrong one.
  if (repeat && repeat.count === candidates.length && candidates[repeat.index] !== undefined) {
    const index = candidates[repeat.index];
    return { index, score: contextScore(hay, phrase, index, focus), ambiguous: false };
  }
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
