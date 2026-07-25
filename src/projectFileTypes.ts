// Text sources merge inside the Yjs document. Everything else is treated as an
// asset and travels through the hash-verified binary channel. SVG and
// Excalidraw files intentionally stay out of the document because drawings can
// be large and are edited through dedicated tools rather than as source text.
const TEXT_EXTENSIONS = new Set([
  'typ', 'bib', 'md', 'markdown', 'txt', 'tex', 'sty', 'cls',
  'json', 'yaml', 'yml', 'toml', 'csv', 'xml', 'html', 'css',
  'js', 'ts', 'py', 'jl', 'wls',
]);

export function isProjectTextPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return true;
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}
