import type { PDFPageProxy } from 'pdfjs-dist';
type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;
type DocumentText = { getPage(page: number): Promise<{ getTextContent(): Promise<TextContent> }> };

export function createPdfTextCache() {
  const documents = new WeakMap<DocumentText, {
    counts: Map<number, number>;
    pending: Map<number, Promise<TextContent>>;
  }>();
  const stateFor = (doc: DocumentText) => {
    let state = documents.get(doc);
    if (!state) {
      state = { counts: new Map(), pending: new Map() };
      documents.set(doc, state);
    }
    return state;
  };
  const read = (doc: DocumentText, page: number): Promise<TextContent> => {
    const state = stateFor(doc);
    const existing = state.pending.get(page);
    if (existing) return existing;
    const task = doc.getPage(page).then(page => page.getTextContent()).then(content => {
      let text = '';
      for (const item of content.items) {
        if ('str' in item) {
          text += item.str;
          if (item.hasEOL) text += '\n';
        }
      }
      state.counts.set(page, (text.match(/\S+/g) || []).length);
      return content;
    }).finally(() => state.pending.delete(page));
    state.pending.set(page, task);
    return task;
  };
  return {
    read,
    async count(doc: DocumentText, page: number) {
      const state = stateFor(doc);
      if (!state.counts.has(page)) await read(doc, page);
      return state.counts.get(page)!;
    },
  };
}
