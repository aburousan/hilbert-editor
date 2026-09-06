// Everything to do with writing right-to-left: the editor's own text
// direction, the marks that fix a line the bidi algorithm gets wrong, and the
// lang/dir arguments of the document's `#set text(…)` rule.

// How the editor lays out a line. "auto" gives each line its own base
// direction from the first strong character in it, which is what you want
// nearly always; the other two are for the lines that heuristic gets wrong.
export type TextDirection = 'auto' | 'ltr' | 'rtl';

export const TEXT_DIRECTIONS: { id: TextDirection, label: string, note: string }[] = [
  { id: 'auto', label: 'Automatic', note: 'each line follows the script you typed it in' },
  { id: 'ltr', label: 'Left-to-right', note: 'always, even for Hebrew or Arabic' },
  { id: 'rtl', label: 'Right-to-left', note: 'always, even for English' },
];

export function isTextDirection(value: unknown): value is TextDirection {
  return value === 'auto' || value === 'ltr' || value === 'rtl';
}

// The invisible characters that push the bidi algorithm around. Marks are a
// single strong character; isolates open a run that the surrounding text
// cannot reorder, and have to be closed with a pop.
export const BIDI_MARKS = [
  { id: 'rlm', char: '\u200f', label: 'Right-to-left mark', note: 'RLM — one invisible strong RTL character' },
  { id: 'lrm', char: '\u200e', label: 'Left-to-right mark', note: 'LRM — one invisible strong LTR character' },
  { id: 'alm', char: '\u061c', label: 'Arabic letter mark', note: 'ALM — like RLM, for Arabic digits' },
  { id: 'rli', char: '\u2067', label: 'Right-to-left isolate', note: 'RLI — opens an RTL run' },
  { id: 'lri', char: '\u2066', label: 'Left-to-right isolate', note: 'LRI — opens an LTR run' },
  { id: 'fsi', char: '\u2068', label: 'First-strong isolate', note: 'FSI — opens a run that picks its own side' },
  { id: 'pdi', char: '\u2069', label: 'Pop directional isolate', note: 'PDI — closes an isolate' },
] as const;

// Wrapping a run in an isolate is the usual fix for a phrase in the other
// script landing in the wrong place, so it is worth having as one action.
export function isolateMarks(side: 'rtl' | 'ltr' | 'auto' = 'auto'): [string, string] {
  return [side === 'rtl' ? '\u2067' : side === 'ltr' ? '\u2066' : '\u2068', '\u2069'];
}

// Characters that occupy no width and yet change what a line looks like: the
// directional marks above, the older embedding codes, and the control
// characters that have no business being in a document at all. The editor
// draws a hairline where one sits, because a file that reorders itself around
// something you cannot see is a file you cannot fix.
//
// Written as escapes on purpose. Typed literally these are invisible in the
// source too, and a stray one is then impossible to spot in review.
const INVISIBLE_NAMES: Record<string, string> = {
  '\u200e': 'Left-to-right mark',
  '\u200f': 'Right-to-left mark',
  '\u061c': 'Arabic letter mark',
  '\u202a': 'Left-to-right embedding',
  '\u202b': 'Right-to-left embedding',
  '\u202c': 'Pop directional formatting',
  '\u202d': 'Left-to-right override',
  '\u202e': 'Right-to-left override',
  '\u2066': 'Left-to-right isolate',
  '\u2067': 'Right-to-left isolate',
  '\u2068': 'First-strong isolate',
  '\u2069': 'Pop directional isolate',
};

// Matching control characters is the whole point here: they are what has to
// be found and drawn, rather than left to shove the text about unseen.
// eslint-disable-next-line no-control-regex
export const INVISIBLE = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export const INVISIBLE_ALL = new RegExp(INVISIBLE.source, 'g');

export function invisibleName(char: string): string {
  const hex = (char.codePointAt(0) || 0).toString(16).toUpperCase().padStart(4, '0');
  return `${INVISIBLE_NAMES[char] || 'Control character'} (U+${hex})`;
}

// The first strong character in a line decides which way that line runs —
// rule P2/P3 of the bidi algorithm, and the same heuristic Katvan applies.
// The isolates and marks count as strong, which is what makes dropping an RLM
// at the start of a line a way to flip it by hand.
const STRONG_RTL = /[\u200F\u061C\u2067\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}]/u;
const STRONG_LTR = /[\u200E\u2066\p{Letter}]/u;

// Cheap enough to run over a whole document: a file with no RTL in it at all
// can be answered without looking at a single line.
export const HAS_RTL = /[\u200F\u061C\u2067\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}]/u;

// Where the Typst in a line stops being prose. Maths, raw blocks and code are
// written in Latin whatever language the document is in, so a line like
// `#emph[שלום]` would be called left-to-right by the first-strong rule alone —
// the first letter it meets is the `e` of `emph`. Skipping those runs is what
// makes the heuristic syntax-aware rather than merely literal.
//
// This is a scanner, not a parser: it knows the shapes that matter and leaves
// the rest as prose. Getting an unusual line wrong costs a line laid out the
// wrong way round, which the manual flip fixes.
export type Segment = { start: number, end: number, code: boolean };

const IDENT_START = /[\p{Letter}_]/u;
const IDENT_REST = /[\p{Letter}\p{Number}_-]/u;
const LABEL_CHAR = /[\p{Letter}\p{Number}_.:-]/u;
// After these, the rest of the line is an expression rather than content.
const STATEMENTS = new Set(['let', 'set', 'show', 'import', 'include', 'return']);

export function segmentLine(line: string): Segment[] {
  const segments: Segment[] = [];
  const mark = (start: number, end: number, code: boolean) => {
    if (end <= start) return;
    const last = segments[segments.length - 1];
    if (last && last.code === code && last.end === start) last.end = end;
    else segments.push({ start, end, code });
  };

  const identEnd = (from: number) => {
    let i = from;
    if (i < line.length && IDENT_START.test(line[i])) {
      i++;
      while (i < line.length && IDENT_REST.test(line[i])) i++;
    }
    return i;
  };

  // Runs to the matching close, so a bracket inside the expression does not
  // end it early. Strings are skipped whole for the same reason.
  const balancedEnd = (from: number, open: string, close: string) => {
    let depth = 0;
    let quote = '';
    for (let i = from; i < line.length; i++) {
      const char = line[i];
      if (quote) {
        if (char === '\\') i++;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"') { quote = char; continue; }
      if (char === open) depth++;
      else if (char === close && --depth === 0) return i + 1;
    }
    return line.length;
  };

  let i = 0;
  let contentFrom = 0;
  const closeContent = (at: number) => { mark(contentFrom, at, false); };

  while (i < line.length) {
    const char = line[i];

    // An escaped character is content, whatever it is.
    if (char === '\\') { i += 2; continue; }

    // Raw: `x` or ```lang … ```, closed by a run of the same length.
    if (char === '`') {
      let ticks = 0;
      while (line[i + ticks] === '`') ticks++;
      const fence = '`'.repeat(ticks);
      const close = line.indexOf(fence, i + ticks);
      const end = close < 0 ? line.length : close + ticks;
      closeContent(i);
      mark(i, end, true);
      i = end;
      contentFrom = i;
      continue;
    }

    // Maths, inline or on its own line.
    if (char === '$') {
      let end = line.length;
      for (let j = i + 1; j < line.length; j++) {
        if (line[j] === '\\') { j++; continue; }
        if (line[j] === '$') { end = j + 1; break; }
      }
      closeContent(i);
      mark(i, end, true);
      i = end;
      contentFrom = i;
      continue;
    }

    // A label, <sec:intro>, and a reference to one, @sec:intro. Both allow
    // more than a bare identifier, so they get their own character class.
    if ((char === '<' || char === '@') && IDENT_START.test(line[i + 1] || '')) {
      let end = i + 1;
      while (end < line.length && LABEL_CHAR.test(line[end])) end++;
      if (char === '<') end = line[end] === '>' ? end + 1 : i + 1;
      if (end > i + 1) {
        closeContent(i);
        mark(i, end, true);
        i = end;
        contentFrom = i;
        continue;
      }
    }

    // Code. The hash and what it names are code; a content block hanging off
    // the end of it, as in #emph[…], is prose again and stays for the caller.
    if (char === '#') {
      let end = identEnd(i + 1);
      const name = line.slice(i + 1, end);
      if (STATEMENTS.has(name)) {
        // `#let x = 1`, `#set text(…)` — code until a content block or the end.
        const block = line.indexOf('[', end);
        end = block < 0 ? line.length : block;
      } else {
        // A call, a chain of them, or a bare `#(…)` / `#{…}`.
        for (;;) {
          if (line[end] === '(') end = balancedEnd(end, '(', ')');
          else if (line[end] === '{') end = balancedEnd(end, '{', '}');
          else if (line[end] === '.' && IDENT_START.test(line[end + 1] || '')) end = identEnd(end + 1);
          else break;
        }
      }
      if (end > i) {
        closeContent(i);
        mark(i, end, true);
        i = end;
        contentFrom = i;
        continue;
      }
    }

    i++;
  }
  closeContent(line.length);
  return segments;
}

// Two Typst blocks outlive the line that opens them: a fenced raw block and a
// display formula. segmentLine works one line at a time and so calls the middle
// of either one prose, which turns a line round the moment a Hebrew string
// appears inside a formula or a code sample. This carries just enough state
// between lines to know when we are inside one — the two shapes that span
// lines, not a second parser.
export type OpenBlock = null | { kind: 'raw', ticks: number } | { kind: 'math' };

export function blockAfter(line: string, open: OpenBlock): OpenBlock {
  if (open && open.kind === 'raw') {
    return line.includes('`'.repeat(open.ticks)) ? null : open;
  }
  let math = open !== null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\') { i++; continue; }
    // A dollar in a comment or a string is a dollar sign. Getting this wrong is
    // not a small error: one stray `// costs $5` would leave every line below
    // it looking like the inside of a formula.
    if (char === '/' && line[i + 1] === '/') break;
    if (char === '"') {
      const close = line.indexOf('"', i + 1);
      // Only a quote that closes on this line is a string. An open one is far
      // more likely to be punctuation — Hebrew writes its own gershayim that
      // way, as in התשפ"ו — and swallowing the rest of the line for it would
      // hide whatever came after.
      if (close > i) { i = close; continue; }
    }
    if (char === '$') { math = !math; continue; }
    if (char !== '`' || math) continue;
    let ticks = 0;
    while (line[i + ticks] === '`') ticks++;
    const close = line.indexOf('`'.repeat(ticks), i + ticks);
    // Inline raw closes on its own line or not at all; only a fence of three
    // or more carries on to the next one.
    if (close >= 0) { i = close + ticks - 1; continue; }
    if (ticks >= 3) return { kind: 'raw', ticks };
    i += ticks - 1;
  }
  return math ? { kind: 'math' } : null;
}

export function lineDirection(line: string): 'rtl' | 'ltr' {
  // A line with no right-to-left character in it cannot come out right-to-left,
  // and in an ordinary document that is every line. Answering those with one
  // regex instead of segmenting them is the difference between 1.2 ms and
  // 0.07 ms over five thousand lines.
  if (!HAS_RTL.test(line)) return 'ltr';
  for (const segment of segmentLine(line)) {
    if (segment.code) continue;
    for (const char of line.slice(segment.start, segment.end)) {
      // Arabic digits and vowel marks are not strong direction characters.
      if (/[\p{Number}\p{Mark}]/u.test(char)) continue;
      if (STRONG_RTL.test(char)) return 'rtl';
      if (STRONG_LTR.test(char)) return 'ltr';
    }
  }
  return 'ltr';
}

// Which languages Typst lays out right-to-left. Measured against typst 0.15.1
// rather than taken from the docs: `dv ps sd ug yi ks pa` are RTL there too,
// and `ku` is not.
const RTL_LANGUAGES = new Set(['ar', 'dv', 'fa', 'he', 'ks', 'pa', 'ps', 'sd', 'ug', 'ur', 'yi']);

export function isRtlLanguage(code: string): boolean {
  return RTL_LANGUAGES.has(code.trim().toLowerCase().split(/[-_]/)[0]);
}

// Offered in the Document Settings picker. Typst accepts any ISO 639-1 code,
// so this is a shortlist and not a limit — the field takes anything.
export const DOCUMENT_LANGUAGES: { code: string, label: string }[] = [
  { code: 'ar', label: 'Arabic — العربية' },
  { code: 'bn', label: 'Bengali — বাংলা' },
  { code: 'zh', label: 'Chinese — 中文' },
  { code: 'nl', label: 'Dutch' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'he', label: 'Hebrew — עברית' },
  { code: 'hi', label: 'Hindi — हिन्दी' },
  { code: 'it', label: 'Italian' },
  { code: 'ja', label: 'Japanese — 日本語' },
  { code: 'dv', label: 'Maldivian — ދިވެހި' },
  { code: 'ps', label: 'Pashto — پښتو' },
  { code: 'fa', label: 'Persian — فارسی' },
  { code: 'pl', label: 'Polish' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian — русский' },
  { code: 'sd', label: 'Sindhi — سنڌي' },
  { code: 'es', label: 'Spanish' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ur', label: 'Urdu — اردو' },
  { code: 'ug', label: 'Uyghur — ئۇيغۇرچە' },
  { code: 'yi', label: 'Yiddish — ייִדיש' },
];

// Typst's own default: the direction follows from the language unless the
// document says otherwise.
export type DocumentDirection = 'auto' | 'ltr' | 'rtl';

export type TextRule = {
  start: number;
  end: number;
  body: string;
};

// Every `#set text(…)` in the source, with the span of the whole call and the
// argument list inside the parentheses. Brackets and strings are tracked so a
// nested call or a parenthesis inside a string cannot end the rule early.
export function findTextRules(source: string): TextRule[] {
  const rules: TextRule[] = [];
  const pattern = /#set\s+text\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    const open = match.index + match[0].lastIndexOf('(');
    let depth = 1;
    let quote = '';
    let escaped = false;

    for (let i = open + 1; i < source.length; i++) {
      const char = source[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '(') depth++;
      if (char === ')' && --depth === 0) {
        rules.push({ start: match.index, end: i + 1, body: source.slice(open + 1, i) });
        pattern.lastIndex = i + 1;
        break;
      }
    }
  }
  return rules;
}

function splitArguments(body: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let quote = '';
  let escaped = false;

  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') round++;
    else if (char === ')') round--;
    else if (char === '[') square++;
    else if (char === ']') square--;
    else if (char === '{') curly++;
    else if (char === '}') curly--;
    else if (char === ',' && round === 0 && square === 0 && curly === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

export function namedArgument(body: string, name: string): string | null {
  const part = splitArguments(body).find(arg => new RegExp(`^\\s*${name}\\s*:`).test(arg));
  return part ? part.replace(new RegExp(`^\\s*${name}\\s*:\\s*`), '').trim() : null;
}

// Passing null takes the argument out again, which is how "Automatic" gets
// back to Typst's own behaviour instead of pinning dir to what it happened to
// be at the time.
export function setNamedArgument(body: string, name: string, value: string | null): string {
  const parts = splitArguments(body);
  const index = parts.findIndex(arg => new RegExp(`^\\s*${name}\\s*:`).test(arg));

  if (value === null) {
    if (index < 0) return body;
    parts.splice(index, 1);
    // Dropping the only argument would otherwise leave the whitespace that
    // used to surround it, and `#set text( )` reads like something is missing.
    return parts.length === 1 && !parts[0].trim() ? '' : parts.join(',');
  }

  if (index >= 0) {
    const leading = parts[index].match(/^\s*/)?.[0] || '';
    const trailing = parts[index].match(/\s*$/)?.[0] || '';
    parts[index] = `${leading}${name}: ${value}${trailing}`;
    return parts.join(',');
  }

  const trailing = body.match(/\s*$/)?.[0] || '';
  const content = body.slice(0, body.length - trailing.length);
  // A rule written over several lines usually ends with a comma already, and
  // adding a second one is a syntax error rather than a cosmetic slip.
  const separator = !content.trim() ? '' : content.endsWith(',') ? ' ' : ', ';
  return `${content}${separator}${name}: ${value}${trailing}`;
}

export function escapeTypstString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function unquoteTypstString(value: string | null): string | null {
  const match = value?.match(/^"((?:\\.|[^"\\])*)"$/);
  return match ? match[1].replace(/\\([\\"])/g, '$1') : null;
}

// What the document currently says. Later rules win, the same way they do when
// Typst runs the file.
export function detectedDirection(source: string): { lang: string, dir: DocumentDirection } {
  let lang: string | null = null;
  let dir: DocumentDirection | null = null;
  for (const rule of findTextRules(source)) {
    lang = unquoteTypstString(namedArgument(rule.body, 'lang')) ?? lang;
    const raw = namedArgument(rule.body, 'dir');
    if (raw === 'ltr' || raw === 'rtl' || raw === 'auto') dir = raw;
  }
  return { lang: lang || 'en', dir: dir || 'auto' };
}
