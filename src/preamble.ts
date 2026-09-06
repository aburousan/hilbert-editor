// Where a new preamble line can go without landing inside something.
//
// Imports and #set rules belong above the prose, so the search walks down from
// the top while the lines still look like preamble. What it must not do is
// judge that line by line: a rule written across several lines, which is how
// "#set page(...)" comes out of the page-setup dialog, has a first line that
// reads like preamble and a second that does not. Stopping there puts the new
// line between a function's opening bracket and its arguments, and typst says
// "the character '#' is not valid in code" about a line the writer never typed.
//
// So brackets are counted, and only a point where nothing is open counts as
// somewhere to insert.
function depthAfter(text: string, depth: number): number {
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === '"') quote = false;
      continue;
    }
    if (c === '"') { quote = true; continue; }
    if (c === '/' && text[i + 1] === '/') break; // the rest of the line is a comment
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
  }
  return depth;
}

const opensPreamble = (line: string) =>
  line === '' || line.startsWith('#import') || line.startsWith('#set') || line.startsWith('//');

/** The 1-based line number a preamble line should be inserted before. */
export function preambleInsertLine(lines: string[]): number {
  let line = 1;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    // Only a line that starts a statement gets a say; continuation lines are
    // whatever the statement above them needs them to be.
    if (depth === 0 && !opensPreamble(lines[i].trim())) break;
    depth = depthAfter(lines[i], depth);
    if (depth === 0) line = i + 2;
  }
  return line;
}
