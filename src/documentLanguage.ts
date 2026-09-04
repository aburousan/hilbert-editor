// Which language a Typst document says it is written in.
//
// Its own module because it is the one piece of the proofreading client with
// rules worth testing on their own, and a test that has to boot React to ask
// what language a string is in will not get written.

/**
 * The language a Typst document declares, from `#set text(lang: "fr")`.
 * Scans for the `#set text(` calls and reads their arguments, so a `lang:`
 * belonging to some other function or sitting inside a string is not mistaken
 * for the document's language. The first one wins; Typst applies set rules in
 * order, and a document that changes language halfway is asking a question this
 * whole-document checker cannot answer anyway.
 */
export function documentLanguage(text: string): { lang: string; region: string } {
  let lang = '';
  let region = '';
  const call = /#set\s+text\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(text))) {
    // Walk to the matching close paren, skipping over strings and nesting.
    let depth = 1;
    let i = m.index + m[0].length;
    let quote = '';
    for (; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = '';
      } else if (c === '"') quote = '"';
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    // `i - 1` is the closing paren when we found one. Half-typed calls are the
    // normal state of a document being written, so a call that simply runs off
    // the end still has its arguments read.
    const args = text.slice(m.index + m[0].length, depth === 0 ? i - 1 : i);
    const l = /(?:^|[,(\s])lang\s*:\s*"([A-Za-z]{2,3})"/.exec(args);
    const r = /(?:^|[,(\s])region\s*:\s*"([A-Za-z]{2})"/.exec(args);
    if (l && !lang) lang = l[1].toLowerCase();
    if (r && !region) region = r[1].toUpperCase();
    if (lang) break;
    call.lastIndex = i;
  }
  return { lang: lang || 'en', region };
}
