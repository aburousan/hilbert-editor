// Paths written in Typst source, so the editor can open them (issue #50): `#include "chapters/intro.typ"`,
// `#import "lib.typ": *`, and the files read by `image`, `read`, `json`, `yaml`, `toml`, `csv`, `xml`,
// `cbor`, `bibliography` and `plugin`. A package import (`@preview/cetz:0.4.2`) is told apart, so it can
// point at its Typst Universe page instead.
//
// No editor in here: plain text in, plain data out, so it can be tested on its own.

export type TypstPathLink =
  | { kind: 'file'; raw: string; startColumn: number; endColumn: number }
  | { kind: 'package'; raw: string; namespace: string; name: string; version: string; startColumn: number; endColumn: number };

// `include`/`import` take the string directly; the reading functions take it as their first argument.
// Either may be written with `#` in markup or without it inside code.
const PATH_RE = /(?<![\w.-])(?:(include|import)\s+|(image|read|json|yaml|toml|csv|xml|cbor|bibliography|plugin)\(\s*)"((?:[^"\\\n]|\\.)*)"/g;
const PACKAGE_RE = /^@([a-z0-9_-]+)\/([a-z0-9_-]+):(\d+\.\d+\.\d+)$/i;

/** Every path string on one line of Typst. Columns are Monaco's: 1-based, end exclusive, inside the quotes. */
export function typstPathLinks(line: string): TypstPathLink[] {
  const out: TypstPathLink[] = [];
  // A `//` comment ends the code on that line, unless it sits inside a string ("https://...").
  const cut = commentStart(line);
  for (const match of line.slice(0, cut).matchAll(PATH_RE)) {
    const raw = match[3].replace(/\\(.)/g, '$1');
    if (!raw) continue;
    // Without a `#` right before it the word may be prose ("we include "this""), not code: then only a
    // string that looks like a file name (a package spec, or a last part with an extension) counts.
    const hashed = match.index! > 0 && line[match.index! - 1] === '#';
    if (!hashed && !PACKAGE_RE.test(raw) && !/\.[A-Za-z0-9]+$/.test(raw.split('/').pop() || '')) continue;
    const startColumn = match.index! + match[0].length - match[3].length;   // 1-based: the first char inside
    const endColumn = startColumn + match[3].length;
    const pkg = PACKAGE_RE.exec(raw);
    if (pkg) {
      if (match[1] !== 'import' && match[1] !== 'include') continue;
      out.push({ kind: 'package', raw, namespace: pkg[1], name: pkg[2], version: pkg[3], startColumn, endColumn });
    } else if (!raw.startsWith('@') && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      out.push({ kind: 'file', raw, startColumn, endColumn });
    }
  }
  return out;
}

/** The path string under (or touching) a 1-based column, or null. */
export function typstPathAt(line: string, column: number): TypstPathLink | null {
  return typstPathLinks(line).find(link => column >= link.startColumn - 1 && column <= link.endColumn + 1) ?? null;
}

/**
 * Where a path written in `fromFile` points, as a project path. Typst reads a path relative to the file it
 * is written in, and a leading `/` from the project root. Null when it climbs out of the project.
 */
export function resolveTypstPath(fromFile: string, raw: string): string | null {
  const parts = raw.startsWith('/') ? [] : fromFile.split('/').slice(0, -1);
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

/** The package's page on Typst Universe; only `@preview` packages are published there. */
export function universeUrl(link: Extract<TypstPathLink, { kind: 'package' }>): string | null {
  if (link.namespace !== 'preview') return null;
  return `https://typst.app/universe/package/${encodeURIComponent(link.name)}/${encodeURIComponent(link.version)}`;
}

function commentStart(line: string): number {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '/' && line[i + 1] === '/') return i;
  }
  return line.length;
}

// A folder name close to `name` among `candidates` (another folder at the same place), for a path with a
// typo: `ch3` when the project has `ch-3`. Names that differ only in case or punctuation count as the
// same; otherwise a small edit distance, scaled with the name's length. Names with different numbers are
// different folders (ch-2 is a new chapter, not a typo for ch-1).
export function similarName(name: string, candidates: string[]): string | null {
  const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const distance = (a: string, b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[b.length];
  };
  let best: string | null = null, bestD = Infinity;
  const digits = (s: string) => s.replace(/\D/g, '');
  for (const c of candidates) {
    if (c === name || digits(c) !== digits(name)) continue;
    const d = squash(c) && squash(c) === squash(name) ? 0 : distance(c.toLowerCase(), name.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  return best !== null && bestD <= Math.max(1, Math.floor(name.length / 3)) ? best : null;
}
