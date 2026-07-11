import { memo, forwardRef, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { TextLayer } from 'pdfjs-dist';
import { normalizeWord, bestMatch, type SyncPayload } from '../syncMatch';

export type PdfHandle = { revealSource(p: SyncPayload): boolean };

type Slot = { div: HTMLDivElement; textDiv: HTMLDivElement; rendered: boolean };

// Walk a text-layer subtree (a page, or the whole document) into a flat list of
// normalized words in reading order, each paired with the span that holds it.
function collectSpanWords(root: ParentNode): { words: string[]; spans: HTMLElement[] } {
  const words: string[] = [];
  const spans: HTMLElement[] = [];
  root.querySelectorAll('.textLayer span').forEach((el) => {
    const txt = el.textContent || '';
    for (const raw of txt.split(/\s+/)) {
      const w = normalizeWord(raw);
      if (w) { words.push(w); spans.push(el as HTMLElement); }
    }
  });
  return { words, spans };
}

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;

const DPR = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
const PRESETS = [50, 75, 90, 100, 110, 125, 150, 200, 300];

// Named paper sizes, in PDF points (1pt = 1/72"). Typst's built-in papers plus
// the common US ones, matched orientation-independently so a landscape page
// still resolves to its name.
const PAPERS: Array<[string, number, number]> = [
  ['A6', 297.64, 419.53],
  ['A5', 419.53, 595.28],
  ['A4', 595.28, 841.89],
  ['A3', 841.89, 1190.55],
  ['B5', 498.9, 708.66],
  ['B4', 708.66, 1000.63],
  ['US Letter', 612, 792],
  ['US Legal', 612, 1008],
  ['US Tabloid', 792, 1224],
  ['Presentation 16:9', 841.89, 473.56],
  ['Presentation 4:3', 841.89, 631.42],
];

// Resolve a page's point dimensions to a human paper-size label. Falls back to
// millimetres when the size isn't a standard one (e.g. a custom `#set page`).
function paperLabel(w: number, h: number): string {
  const lo = Math.min(w, h), hi = Math.max(w, h);
  const landscape = w > h;
  for (const [name, pw, ph] of PAPERS) {
    if (Math.abs(lo - pw) <= 3 && Math.abs(hi - ph) <= 3) {
      const isSquareish = name.startsWith('Presentation');
      return landscape && !isSquareish ? `${name} · landscape` : name;
    }
  }
  const mm = (pt: number) => Math.round((pt * 25.4) / 72);
  return `${mm(w)} × ${mm(h)} mm`;
}

// memo: the app re-renders on every keystroke; the preview only cares about `url`
// (and onWordClick is a stable useCallback), so skip those renders entirely.
function PdfPreview(
  { url, onReverseSync, onWordCount, downloadName }: { url: string, onReverseSync: (p: SyncPayload) => void, onWordCount?: (n: number) => void, downloadName?: string },
  ref: Ref<PdfHandle>,
) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const renderTokenRef = useRef(0);
  const docCache = useRef<{ url: string | null; doc: any; naturalW: number }>({ url: null, doc: null, naturalW: 595 });
  const liveWRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ioRef = useRef<IntersectionObserver | null>(null);
  const slotsRef = useRef<Slot[]>([]);
  const scaleRef = useRef({ dScale: 1, renderScale: DPR });
  const aspectRef = useRef(1.414);

  // zoomFactor is relative to fit-width: 1 = fit, 1.2 = 120% of fit. Mirrored in a
  // ref so the (once-created) ResizeObserver reads the live value, not the zoom
  // captured when the effect first ran.
  const [zoomFactor, setZoomFactor] = useState(1);
  const zoomFactorRef = useRef(1);
  const [rasterTick, setRasterTick] = useState(0);
  const [dark, setDark] = useState(false);
  const [pageInfo, setPageInfo] = useState<{ w: number; h: number } | null>(null);

  const displayScale = (w: number, z: number) => Math.max(0.15, Math.min(((w - 28) / docCache.current.naturalW) * z, 8));

  // Instantly resize the already-rendered pages via CSS width (layout stays
  // correct, the crisp bitmap just scales) — no re-rasterisation, so it's snappy.
  const applyWidths = (w: number, z: number) => {
    const pages = pagesRef.current;
    if (!pages || !docCache.current.naturalW) return;
    const displayW = docCache.current.naturalW * displayScale(w, z);
    for (const el of Array.from(pages.children) as HTMLElement[]) el.style.width = `${displayW}px`;
  };

  const scheduleRaster = () => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setRasterTick(t => t + 1), 160);
  };

  // Draw (or redraw) one page's bitmap. The new canvas is rendered off-screen and
  // only swapped in once it's ready, so a resize/zoom re-raster never blanks the
  // page — this is what removes the flicker. `force` re-rasterises a page that's
  // already drawn so it stays crisp at the new scale.
  const drawPage = async (i: number, token: number, force = false) => {
    const slot = slotsRef.current[i - 1];
    const doc = docCache.current.doc;
    if (!slot || !doc || token !== renderTokenRef.current) return;
    if (slot.rendered && !force) return;
    slot.rendered = true;
    let page;
    try { page = await doc.getPage(i); } catch { slot.rendered = false; return; }
    if (token !== renderTokenRef.current) return;
    const rvp = page.getViewport({ scale: scaleRef.current.renderScale });
    const canvas = document.createElement('canvas');
    canvas.width = rvp.width; canvas.height = rvp.height;
    canvas.style.width = '100%'; canvas.style.height = 'auto';
    try { await page.render({ canvasContext: canvas.getContext('2d')!, viewport: rvp }).promise; }
    catch { slot.rendered = false; return; }
    if (token !== renderTokenRef.current) return;
    const old = slot.div.querySelector('canvas');
    slot.div.insertBefore(canvas, slot.div.firstChild);   // add new first…
    if (old) old.remove();                                 // …then drop the old one
    slot.div.style.height = '';   // real bitmap now dictates the height
  };

  // (Re)build the transparent text layers at the current scale so cursor↔PDF sync
  // can locate words even on pages whose bitmap isn't drawn yet.
  const renderTextLayers = async (token: number) => {
    const doc = docCache.current.doc, slots = slotsRef.current;
    if (!doc) return;
    const dScale = scaleRef.current.dScale;
    for (let i = 1; i <= slots.length; i++) {
      const page = await doc.getPage(i);
      if (token !== renderTokenRef.current) return;
      const td = slots[i - 1].textDiv;
      td.replaceChildren();
      td.style.setProperty('--scale-factor', String(dScale));
      const tl = new TextLayer({ textContentSource: page.streamTextContent(), container: td, viewport: page.getViewport({ scale: dScale }) });
      await tl.render();
    }
  };

  // Track pane width: apply instant CSS width, debounce the crisp re-render.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0].contentRect.width;
      if (Math.abs(w - liveWRef.current) < 1) return;
      liveWRef.current = w;
      applyWidths(w, zoomFactorRef.current);
      scheduleRaster();
    });
    ro.observe(el);
    liveWRef.current = el.clientWidth;
    return () => { clearTimeout(debounceRef.current); ro.disconnect(); };
  }, []);

  const setZoom = (z: number) => { setZoomFactor(z); zoomFactorRef.current = z; applyWidths(liveWRef.current, z); scheduleRaster(); };

  // Only pages within ~one screen of the viewport hold a bitmap; the rest stay as
  // placeholders. This observer draws them as they scroll near. Reused across both
  // the in-place refresh and the full rebuild, keyed on the current render token.
  const attachObserver = (tok: number, scrollEl: HTMLDivElement) => {
    ioRef.current?.disconnect();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const idx = slotsRef.current.findIndex(s => s.div === e.target);
          if (idx >= 0) drawPage(idx + 1, tok);
        }
      }
    }, { root: scrollEl, rootMargin: '800px 0px' });
    ioRef.current = io;
    for (const s of slotsRef.current) io.observe(s.div);
  };

  // Load a compiled document into the preview. While you type, each recompile
  // hands us a new blob url — but almost always with the SAME page count. In that
  // case we keep the existing page divs and just swap each page's bitmap in place
  // as the fresh one finishes painting (drawPage removes the old canvas only after
  // the new one is ready), so nothing ever blanks: the preview updates without the
  // flash you'd get from rebuilding the DOM. A full teardown (replaceChildren)
  // happens only when the structure really changes — first load, a different page
  // count, or a new page size. Resize/zoom never comes through here at all.
  useEffect(() => {
    const pagesEl = pagesRef.current, scrollEl = scrollRef.current;
    if (!url || !pagesEl || !scrollEl) return;
    const token = ++renderTokenRef.current;
    const prevScroll = scrollEl.scrollTop;

    (async () => {
      const prevSlots = slotsRef.current;
      const prevNaturalW = docCache.current.naturalW;

      let cache = docCache.current;
      if (cache.url !== url || !cache.doc) {
        let loaded;
        try { loaded = await pdfjsLib.getDocument(url).promise; } catch { return; }
        if (token !== renderTokenRef.current) { try { loaded.destroy(); } catch {} return; }
        const prevDoc = docCache.current.doc;
        const pg = await loaded.getPage(1);
        const vp1 = pg.getViewport({ scale: 1 });
        docCache.current = { url, doc: loaded, naturalW: vp1.width };
        setPageInfo({ w: vp1.width, h: vp1.height });
        // Free the previously-loaded PDF (parsed data + its worker transport) —
        // the document recompiles on every edit, so without this each compile
        // orphans a whole pdf.js document and the memory climbs steadily.
        if (prevDoc && prevDoc !== loaded) { try { prevDoc.destroy(); } catch {} }
        cache = docCache.current;
      }
      const doc = cache.doc;
      const w = liveWRef.current || scrollEl.clientWidth || cache.naturalW;
      const dScale = displayScale(w, zoomFactorRef.current);
      scaleRef.current = { dScale, renderScale: Math.min(dScale * DPR, 5) };
      const displayW = cache.naturalW * dScale;

      // Page-1 aspect sizes the placeholders (Typst pages are usually uniform; a
      // page's true height replaces the estimate once it actually rasterises).
      const aspVp = (await doc.getPage(1)).getViewport({ scale: 1 });
      if (token !== renderTokenRef.current) return;
      const aspect = aspVp.height / aspVp.width;
      aspectRef.current = aspect;

      // Refresh in place when the shape is unchanged (same page count and page
      // width) — the common case as you type. The old bitmaps stay on screen while
      // each new one rasterises, so there's no blank frame and scroll doesn't move.
      const reusable =
        prevSlots.length === doc.numPages &&
        pagesEl.children.length === doc.numPages &&
        Math.abs(prevNaturalW - cache.naturalW) < 1;

      if (reusable) {
        for (const slot of prevSlots) {
          slot.div.style.width = `${displayW}px`;
          if (!slot.rendered) slot.div.style.height = `${displayW * aspect}px`;
        }
        attachObserver(token, scrollEl);
        // Redraw the pages that already hold a bitmap; the rest refresh lazily
        // through the observer as they scroll into view.
        for (let i = 0; i < prevSlots.length; i++) {
          if (prevSlots[i].rendered) drawPage(i + 1, token, true);
        }
        await renderTextLayers(token);
        return;
      }

      // Structural change: rebuild the page column, preserving scroll position.
      const slots: Slot[] = [];
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= doc.numPages; i++) {
        const pageDiv = document.createElement('div');
        pageDiv.className = 'pdf-page';
        pageDiv.style.width = `${displayW}px`;
        pageDiv.style.height = `${displayW * aspect}px`;   // placeholder until drawn
        const textDiv = document.createElement('div');
        textDiv.className = 'textLayer';
        textDiv.style.setProperty('--scale-factor', String(dScale));
        pageDiv.appendChild(textDiv);
        frag.appendChild(pageDiv);
        slots.push({ div: pageDiv, textDiv, rendered: false });
      }
      pagesEl.replaceChildren(frag);
      slotsRef.current = slots;
      scrollEl.scrollTop = prevScroll;

      attachObserver(token, scrollEl);
      await renderTextLayers(token);
    })();

    return () => { ioRef.current?.disconnect(); };
  }, [url]);

  // Re-rasterise in place on resize-settle / zoom: no teardown. Update every
  // page's width and text-layer scale, then redraw the already-drawn bitmaps
  // crisply — each new canvas swaps in only when ready, so nothing blanks.
  useEffect(() => {
    const slots = slotsRef.current, w = liveWRef.current;
    if (!slots.length || !docCache.current.doc || !w) return;
    const token = renderTokenRef.current;
    const dScale = displayScale(w, zoomFactorRef.current);
    scaleRef.current = { dScale, renderScale: Math.min(dScale * DPR, 5) };
    const displayW = docCache.current.naturalW * dScale;
    for (const slot of slots) {
      slot.div.style.width = `${displayW}px`;
      if (!slot.rendered) slot.div.style.height = `${displayW * aspectRef.current}px`;
    }
    for (let i = 0; i < slots.length; i++) if (slots[i].rendered) drawPage(i + 1, token, true);
    renderTextLayers(token);
  }, [rasterTick, zoomFactor]);

  // Word count from the RENDERED document (the PDF's text), not the Typst source —
  // so `#set`, `#import`, function names and markup syntax don't inflate it. Runs
  // once per compile (keyed on url), independent of zoom/resize re-rasterisation.
  useEffect(() => {
    if (!url || !onWordCount) return;
    let cancelled = false;
    (async () => {
      let doc: any = null, temp = false;
      try {
        if (docCache.current.url === url && docCache.current.doc) {
          doc = docCache.current.doc;                       // reuse the shared doc
        } else {
          doc = await pdfjsLib.getDocument(url).promise;    // our own copy…
          temp = true;                                      // …so we must destroy it
        }
        let text = '';
        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) break;
          const tc = await doc.getPage(i).then((p: any) => p.getTextContent());
          for (const it of tc.items) {
            if ('str' in it) text += it.str;
            // pdf.js emits spacing as its own runs; add a break on end-of-line.
            if (it.hasEOL) text += '\n';
          }
          text += '\n';
        }
        if (!cancelled) onWordCount((text.match(/[^\s]+/g) || []).length);
      } catch { /* leave the last known count in place */ }
      finally { if (temp && doc) { try { await doc.destroy(); } catch {} } }
    })();
    return () => { cancelled = true; };
  }, [url, onWordCount]);

  // Destroy the last-held PDF document when the preview unmounts (workspace
  // switch, app close) so it doesn't linger with its worker transport.
  useEffect(() => () => {
    const d = docCache.current.doc;
    docCache.current = { url: null, doc: null, naturalW: docCache.current.naturalW };
    if (d) { try { d.destroy(); } catch {} }
  }, []);

  // Highlight a span for ~1.4s (forward-sync landing flash).
  const flashSpan = (span: HTMLElement) => {
    document.querySelectorAll('.sync-flash-pdf').forEach((e) => e.classList.remove('sync-flash-pdf'));
    span.classList.add('sync-flash-pdf');
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => span.classList.remove('sync-flash-pdf'), 1400);
  };

  // Where, 0..1 down the whole rendered document, does this span sit? Used as a
  // positional prior when the same word appears many times in the source.
  const docFractionOf = (span: HTMLElement): number => {
    const pages = pagesRef.current;
    if (!pages || !pages.offsetHeight) return 0;
    const sr = span.getBoundingClientRect();
    const pr = pages.getBoundingClientRect();
    const y = sr.top - pr.top + sr.height / 2;
    return Math.max(0, Math.min(1, y / pages.offsetHeight));
  };

  // Forward sync (source → PDF): find the cursor-line phrase in the rendered
  // text, scroll it into view and flash it. Returns false if it couldn't be
  // located (so the caller can stay quiet rather than jump somewhere wrong).
  useImperativeHandle(ref, (): PdfHandle => ({
    revealSource(p: SyncPayload): boolean {
      const pages = pagesRef.current;
      if (!pages) return false;
      const { words, spans } = collectSpanWords(pages);
      if (!words.length) return false;
      const prior = Math.round(p.docFraction * words.length);
      const res = bestMatch(words, p.words, p.focus, prior);
      if (!res) return false;
      const span = spans[res.index];
      if (!span) return false;
      span.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      flashSpan(span);
      return true;
    },
  }), []);

  // Reverse sync (PDF → source): a double-click selects a word; gather a window
  // of neighbouring words (in reading order) plus a positional prior, and let
  // the editor resolve the exact source location.
  const handleDblClick = () => {
    const sel = window.getSelection();
    const selWord = normalizeWord((sel?.toString() ?? '').trim());
    if (!selWord) return;
    const node = sel?.anchorNode;
    const clickedSpan = (node && (node.nodeType === 3 ? node.parentElement : (node as HTMLElement))) as HTMLElement | null;
    const layer = clickedSpan?.closest('.textLayer');
    if (!clickedSpan || !layer) return;

    const { words, spans } = collectSpanWords(layer);
    let focus = spans.findIndex((s, i) => s === clickedSpan && words[i] === selWord);
    if (focus < 0) focus = spans.findIndex((s) => s === clickedSpan);
    if (focus < 0) return;

    const from = Math.max(0, focus - 8);
    const to = Math.min(words.length, focus + 9);
    onReverseSync({ words: words.slice(from, to), focus: focus - from, docFraction: docFractionOf(clickedSpan) });
  };

  // Save the currently shown PDF to disk. Works for both the compile preview
  // (a blob: URL) and an opened workspace PDF (an http: URL).
  const downloadPdf = async () => {
    try {
      const a = document.createElement('a');
      a.download = downloadName || 'document.pdf';
      if (url.startsWith('blob:')) {
        // Compile preview: already an in-memory object URL — download it as-is
        // rather than fetching it back into a second blob.
        a.href = url;
        document.body.appendChild(a); a.click(); a.remove();
      } else {
        // Opened workspace PDF (http): copy into a blob first — WKWebView won't
        // honour the download attribute on a plain same-origin link.
        const blob = await (await fetch(url)).blob();
        const objUrl = URL.createObjectURL(blob);
        a.href = objUrl;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
      }
    } catch { /* ignore — nothing to download if the compile hasn't produced a PDF */ }
  };

  const isFit = Math.abs(zoomFactor - 1) < 0.001;
  const curPct = Math.round(zoomFactor * 100);
  const selValue = isFit ? 'fit' : String(curPct);

  return (
    <div className={`pdf-wrap ${dark ? 'pdf-dark' : ''}`}>
      <div className="pdf-toolbar">
        {pageInfo && (
          <span className="pdf-pagesize" title={`Page size of the rendered PDF · ${Math.round(pageInfo.w)} × ${Math.round(pageInfo.h)} pt`}>
            {paperLabel(pageInfo.w, pageInfo.h)}
          </span>
        )}
        <button className={`pdf-btn ${dark ? 'active' : ''}`} onClick={() => setDark(d => !d)} title="Toggle dark PDF" style={{ marginRight: 'auto' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
        </button>
        <button className="pdf-btn" onClick={() => setZoom(Math.max(zoomFactor / 1.15, 0.25))} title="Zoom out">−</button>
        <select className="pdf-zoom-select" value={selValue} title="Zoom (100% = fit width)"
          onChange={e => setZoom(e.target.value === 'fit' ? 1 : Number(e.target.value) / 100)}>
          <option value="fit">Fit</option>
          {!PRESETS.includes(curPct) && !isFit && <option value={String(curPct)}>{curPct}%</option>}
          {PRESETS.map(p => <option key={p} value={String(p)}>{p}%</option>)}
        </select>
        <button className="pdf-btn" onClick={() => setZoom(Math.min(zoomFactor * 1.15, 8))} title="Zoom in">+</button>
        <button className={`pdf-btn pdf-btn-icon ${isFit ? 'active' : ''}`} onClick={() => setZoom(1)} title="Fit to page width">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9V5a1 1 0 0 1 1-1h4"></path><path d="M20 9V5a1 1 0 0 0-1-1h-4"></path><path d="M4 15v4a1 1 0 0 0 1 1h4"></path><path d="M20 15v4a1 1 0 0 1-1 1h-4"></path></svg>
        </button>
        <button className="pdf-btn pdf-btn-icon" onClick={downloadPdf} title="Download PDF">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        </button>
      </div>
      <div className="pdf-scroll" ref={scrollRef} onDoubleClick={handleDblClick} title="Double-click a word to jump to it in the source">
        <div className="pdf-pages" ref={pagesRef} />
      </div>
    </div>
  );
}

export default memo(forwardRef(PdfPreview));
