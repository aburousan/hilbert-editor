import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { TextLayer } from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;

export default function PdfPreview({ url, onWordClick }: { url: string, onWordClick: (word: string) => void }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const renderTokenRef = useRef(0);
  const docCache = useRef<{ url: string | null; doc: any; naturalW: number }>({ url: null, doc: null, naturalW: 595 });

  const [containerW, setContainerW] = useState(0);
  // zoomFactor is relative to fit-width: 1 = fit, 1.2 = 120% of fit, etc.
  // Because the effective scale is always (fitScale * zoomFactor), the page stays
  // responsive to pane resizing at every zoom level.
  const [zoomFactor, setZoomFactor] = useState(1);

  // Width the pages were last rasterised at — used to CSS-scale them instantly
  // while resizing, then re-rasterise (crisply) once the drag settles.
  const rasterWRef = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(entries => {
      const w = entries[0].contentRect.width;
      // Instant, cheap visual response: scale the already-rendered pages.
      const pages = pagesRef.current;
      if (pages && rasterWRef.current > 0 && Math.abs(w - rasterWRef.current) > 1) {
        const s = (w - 28) / (rasterWRef.current - 28);
        pages.style.transformOrigin = 'top center';
        pages.style.transform = s < 1 ? `scale(${s.toFixed(4)})` : 'none';
      }
      // Re-rasterise only after resizing stops.
      clearTimeout(t);
      t = setTimeout(() => setContainerW(w), 200);
    });
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => { clearTimeout(t); ro.disconnect(); };
  }, []);

  useEffect(() => {
    const pagesEl = pagesRef.current;
    const scrollEl = scrollRef.current;
    if (!url || !pagesEl || !scrollEl || !containerW) return;
    const token = ++renderTokenRef.current;
    const prevScroll = scrollEl.scrollTop;

    (async () => {
      let cache = docCache.current;
      if (cache.url !== url || !cache.doc) {
        let loaded;
        try { loaded = await pdfjsLib.getDocument(url).promise; } catch { return; }
        if (token !== renderTokenRef.current) return;
        const pg = await loaded.getPage(1);
        docCache.current = { url, doc: loaded, naturalW: pg.getViewport({ scale: 1 }).width };
        cache = docCache.current;
      }
      const scale = Math.max(0.2, Math.min(((containerW - 28) / cache.naturalW) * zoomFactor, 8));

      const frag = document.createDocumentFragment();
      for (let i = 1; i <= cache.doc.numPages; i++) {
        const page = await cache.doc.getPage(i);
        if (token !== renderTokenRef.current) return;
        const viewport = page.getViewport({ scale });

        const pageDiv = document.createElement('div');
        pageDiv.className = 'pdf-page';
        pageDiv.style.width = `${viewport.width}px`;
        pageDiv.style.height = `${viewport.height}px`;

        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        pageDiv.appendChild(canvas);

        const textDiv = document.createElement('div');
        textDiv.className = 'textLayer';
        textDiv.style.setProperty('--scale-factor', String(scale));
        pageDiv.appendChild(textDiv);

        frag.appendChild(pageDiv);
        await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
        if (token !== renderTokenRef.current) return;
        const tl = new TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport });
        await tl.render();
      }
      if (token !== renderTokenRef.current) return;
      pagesEl.style.transform = 'none';       // drop the interim resize scale
      pagesEl.replaceChildren(frag);
      rasterWRef.current = containerW;         // pages are now crisp at this width
      scrollEl.scrollTop = prevScroll;
    })();
  }, [url, containerW, zoomFactor]);

  const handleDblClick = () => {
    const word = (window.getSelection()?.toString() ?? '').trim();
    if (word) onWordClick(word);
  };

  const isFit = Math.abs(zoomFactor - 1) < 0.001;
  const curPct = Math.round(zoomFactor * 100);
  const PRESETS = [50, 75, 100, 125, 150, 200, 300];
  const selValue = isFit ? 'fit' : String(curPct);

  return (
    <div className="pdf-wrap">
      <div className="pdf-toolbar">
        <button className="pdf-btn" onClick={() => setZoomFactor(z => Math.max(z / 1.2, 0.25))} title="Zoom out">−</button>
        <select className="pdf-zoom-select" value={selValue} title="Zoom (100% = fit width)"
          onChange={e => setZoomFactor(e.target.value === 'fit' ? 1 : Number(e.target.value) / 100)}>
          <option value="fit">Fit</option>
          {!PRESETS.includes(curPct) && !isFit && <option value={String(curPct)}>{curPct}%</option>}
          {PRESETS.map(p => <option key={p} value={String(p)}>{p}%</option>)}
        </select>
        <button className="pdf-btn" onClick={() => setZoomFactor(z => Math.min(z * 1.2, 8))} title="Zoom in">+</button>
        <button className={`pdf-btn ${isFit ? 'active' : ''}`} onClick={() => setZoomFactor(1)} title="Fit page width">Fit</button>
      </div>
      <div className="pdf-scroll" ref={scrollRef} onDoubleClick={handleDblClick} title="Double-click a word to jump to it in the editor">
        <div className="pdf-pages" ref={pagesRef} />
      </div>
    </div>
  );
}
