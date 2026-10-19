// The name a document is exported under: chapters/My Notes.typ gives My_Notes.
export const exportStem = (path: string) =>
  (path.split(/[/\\]/).pop() || '').replace(/\.typ$/i, '').trim().replace(/\s+/g, '_');
