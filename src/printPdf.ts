// Ctrl/Cmd+P prints the PDF preview, not the app window (issue #48).
//
// The webview can only print a page, so the PDF's pages are drawn as images into a layer that is hidden on
// screen and is the only thing shown when printing. The desktop app then asks its window to print through
// the backend (WKWebView on macOS ignores window.print()); in a browser, window.print() does it.
import * as pdfjsLib from 'pdfjs-dist';
import { API } from './api';

const ROOT_ID = 'hilbert-print';
// Sharp text on paper without huge images: 200 dpi, held under 16 million pixels a page (WebKit's canvas
// limit is about 16.7 million).
const DPI = 200;
const MAX_PIXELS = 16_000_000;

let cleanup: (() => void) | null = null;

function clear() {
  cleanup?.();
  cleanup = null;
}

/** Draws every page of the PDF at `url` into the print layer and opens the print dialog. */
export async function printPdf(url: string, onProgress?: (done: number, total: number) => void): Promise<void> {
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;
  }
  clear();
  const pdf = await pdfjsLib.getDocument({ url }).promise;
  const urls: string[] = [];
  const root = document.createElement('div');
  root.id = ROOT_ID;
  const style = document.createElement('style');
  let firstSize = '';
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const size = page.getViewport({ scale: 1 });           // PDF points
      const scale = Math.min(DPI / 72, Math.sqrt(MAX_PIXELS / (size.width * size.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('This window cannot draw the pages for printing.');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, 'image/png'));
      canvas.width = canvas.height = 0;                       // give the memory back now
      page.cleanup();
      if (!blob) throw new Error('A page could not be drawn for printing.');
      const src = URL.createObjectURL(blob);
      urls.push(src);
      const img = document.createElement('img');
      img.src = src;
      img.alt = `Page ${n}`;
      img.style.width = `${size.width}pt`;
      img.style.height = `${size.height}pt`;
      root.appendChild(img);
      if (n === 1) firstSize = `${size.width}pt ${size.height}pt`;
      onProgress?.(n, pdf.numPages);
    }
  } finally {
    void pdf.destroy();
  }
  style.textContent = `
@media screen { #${ROOT_ID} { display: none !important; } }
@media print {
  @page { size: ${firstSize}; margin: 0; }
  html, body { background: #fff !important; height: auto !important; overflow: visible !important; }
  body > *:not(#${ROOT_ID}) { display: none !important; }
  #${ROOT_ID} { display: block !important; }
  #${ROOT_ID} img { display: block; break-after: page; page-break-after: always; }
  #${ROOT_ID} img:last-child { break-after: auto; page-break-after: auto; }
}`;
  document.head.appendChild(style);
  document.body.appendChild(root);
  await Promise.all([...root.querySelectorAll('img')].map(img => img.decode().catch(() => {})));
  // Kept until the next print, or until printing is over: the desktop print dialog may still be reading the
  // layer after this returns.
  cleanup = () => {
    root.remove();
    style.remove();
    for (const src of urls) URL.revokeObjectURL(src);
  };
  window.addEventListener('afterprint', clear, { once: true });

  let printedByWindow = false;
  try {
    const response = await fetch(`${API}/desktop/print`, { method: 'POST' });
    if (response.ok) printedByWindow = (await response.json().catch(() => ({}))).ok === true;
    else throw new Error((await response.json().catch(() => ({}))).error || 'Could not print.');
  } catch (error) {
    if (error instanceof Error && /Could not print/.test(error.message)) throw error;
  }
  if (!printedByWindow) window.print();
}
