// Commenting out lines, done by hand rather than through Monaco's own action.
//
// Monaco takes the comment syntax from the language configuration, and every
// file that isn't .typ is opened as plaintext, which has none — so its built-in
// action silently does nothing in a .py, .bib or .toml buffer. Working it out
// here means one path that behaves the same in any file, and one that can be
// tested without an editor.

// Line-comment syntax per file extension.
export const COMMENT_TOKENS: Record<string, string> = {
  typ: '//', js: '//', jsx: '//', ts: '//', tsx: '//', rs: '//', c: '//', h: '//',
  cpp: '//', hpp: '//', java: '//', go: '//', swift: '//', kt: '//', scss: '//',
  py: '#', jl: '#', sh: '#', bash: '#', zsh: '#', toml: '#', yml: '#', yaml: '#',
  r: '#', rb: '#', pl: '#', cfg: '#', ini: '#', conf: '#',
  bib: '%', tex: '%', sty: '%', cls: '%', m: '%',
  lua: '--', sql: '--', hs: '--', vim: '"', lisp: ';', el: ';', clj: ';',
};

export function commentTokenFor(path: string): string {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return COMMENT_TOKENS[ext] || '//';
}

export interface CommentEdit {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  text: string;
}

// `texts` holds the lines the selection covers, `firstLine` is the 1-based
// number of the first of them. Returns the edits that toggle the block, or an
// empty list when there is nothing to act on.
export function commentEdits(texts: string[], firstLine: number, token: string): CommentEdit[] {
  return commentEditsForBlocks([{ firstLine, texts }], token);
}

// Several cursors or selections (issue #51): `ranges` are their 1-based line spans, in any order and
// possibly overlapping, `lineText` reads a line. Every line any of them touches is toggled, as one block
// selection would be; lines next to each other merge into one block.
export function commentEditsForRanges(
  ranges: { first: number; last: number }[], lineText: (n: number) => string, token: string,
): CommentEdit[] {
  const sorted = ranges.filter(r => r.last >= r.first).map(r => ({ ...r })).sort((a, b) => a.first - b.first);
  const merged: { first: number; last: number }[] = [];
  for (const r of sorted) {
    const tail = merged[merged.length - 1];
    if (tail && r.first <= tail.last + 1) tail.last = Math.max(tail.last, r.last);
    else merged.push(r);
  }
  return commentEditsForBlocks(merged.map(r => ({
    firstLine: r.first,
    texts: Array.from({ length: r.last - r.first + 1 }, (_, i) => lineText(r.first + i)),
  })), token);
}

// The decision is made over all the blocks together: they are uncommented only when every non-blank
// line in all of them already is, so one key press never comments some and uncomments others. Each block
// is lined up at its own shallowest indent, so separate places in a file each stay tidy.
function commentEditsForBlocks(blocks: { firstLine: number; texts: string[] }[], token: string): CommentEdit[] {
  // Blank lines take whatever the rest of the block does, so they get no say in
  // whether this is a comment or an uncomment — and no edit of their own.
  const groups = blocks.map(({ firstLine, texts }) => {
    const lines: { n: number; text: string; indent: number }[] = [];
    texts.forEach((text, i) => {
      if (!text.trim()) return;
      lines.push({ n: firstLine + i, text, indent: text.length - text.trimStart().length });
    });
    return lines;
  }).filter(lines => lines.length);
  const all = groups.flat();
  if (!all.length) return [];

  if (all.every(l => l.text.trimStart().startsWith(token))) {
    return all.map(l => {
      const at = l.indent + 1;
      // Take the single space back out too, if we were the ones who put it in.
      const pad = l.text.slice(l.indent + token.length).startsWith(' ') ? 1 : 0;
      return {
        range: { startLineNumber: l.n, startColumn: at, endLineNumber: l.n, endColumn: at + token.length + pad },
        text: '',
      };
    });
  }

  // Comment from the shallowest indent in the block so it stays lined up.
  return groups.flatMap(lines => {
    const col = Math.min(...lines.map(l => l.indent)) + 1;
    return lines.map(l => ({
      range: { startLineNumber: l.n, startColumn: col, endLineNumber: l.n, endColumn: col },
      text: token + ' ',
    }));
  });
}
