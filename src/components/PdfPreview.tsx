import { memo, forwardRef, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { TextLayer } from 'pdfjs-dist';
import { bestMatch, tokenizeRenderedText, type SyncPayload } from '../syncMatch';
import { MAX_PDF_PAGE_WORD_INDEXES } from '../performanceLimits';

export type PdfHandle = {
  revealSource(p: SyncPayload): Promise<boolean>;
  revealPosition(position: NonNullable<SyncPayload['documentPosition']>): Promise<boolean>;
};
export type PdfViewState = {
  page: number;
  fraction: number;
  horizontal: number;
  zoom: number;
  dark: boolean;
};

type Slot = { div: HTMLDivElement; textDiv: HTMLDivElement; rendered: boolean; textRendered: boolean };
type WordIndex = { words: string[]; spans: HTMLElement[] };

// Walk a text-layer subtree (a page, or the whole document) into a flat list of
// normalized words in reading order, each paired with the span that holds it.
function collectSpanWords(root: ParentNode): { words: string[]; spans: HTMLElement[] } {
  const words: string[] = [];
  const spans: HTMLElement[] = [];
  root.querySelectorAll('.textLayer span').forEach((el) => {
    const txt = el.textContent || '';
    for (const word of tokenizeRenderedText(txt)) {
      words.push(word);
      spans.push(el as HTMLElement);
    }
  });
  return { words, spans };
}

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;

const DPR = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
const PRESETS = [50, 75, 90, 100, 110, 125, 150, 200, 300];
const MAX_CACHED_SYNC_WORDS = 120_000;

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
  { url, onReverseSync, onWordCount, downloadName, initialViewState, onViewStateChange }: {
    url: string,
    onReverseSync: (p: SyncPayload) => void,
    onWordCount?: (n: number) => void,
    downloadName?: string,
    initialViewState?: PdfViewState,
    onViewStateChange?: (state: PdfViewState) => void,
  },
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
  const reportViewStateRef = useRef<() => void>(() => {});
  const setZoomRef = useRef<(zoom: number) => void>(() => {});
  const documentWordIndexRef = useRef<{ pass: number; root: ParentNode; index: WordIndex } | null>(null);
  // A small LRU. Page indexes are rebuilt from the text layer on demand, so
  // retaining every page of a book only wastes memory.
  const pageWordIndexesRef = useRef(new Map<ParentNode, { pass: number; index: WordIndex }>());

  // zoomFactor is relative to fit-width: 1 = fit, 1.2 = 120% of fit. Mirrored in a
  // ref so the (once-created) ResizeObserver reads the live value, not the zoom
  // captured when the effect first ran.
  const initialZoom = Number.isFinite(initialViewState?.zoom) && initialViewState!.zoom >= 0.25 && initialViewState!.zoom <= 8
    ? initialViewState!.zoom
    : 1;
  const [zoomFactor, setZoomFactor] = useState(initialZoom);
  const zoomFactorRef = useRef(initialZoom);
  const [rasterTick, setRasterTick] = useState(0);
  const [dark, setDark] = useState(!!initialViewState?.dark);
  const darkRef = useRef(!!initialViewState?.dark);
  const initialViewRef = useRef(initialViewState);
  const initialViewRestoredRef = useRef(false);
  const [pageInfo, setPageInfo] = useState<{ w: number; h: number } | null>(null);
  const pageInfoRef = useRef<{ w: number; h: number } | null>(null);

  const displayScale = (w: number, z: number) => Math.max(0.15, Math.min(((w - 28) / docCache.current.naturalW) * z, 8));

  // Instantly resize the already-rendered pages via CSS width (layout stays
  // correct, the crisp bitmap just scales) — no re-rasterisation, so it's snappy.
  const applyWidths = (w: number, z: number) => {
    const pages = pagesRef.current;
    if (!pages || !docCache.current.naturalW) return;
    const displayW = docCache.current.naturalW * displayScale(w, z);
    for (const el of Array.from(pages.children) as HTMLElement[]) el.style.width = `${displayW}px`;
    // A drawn page takes its height from the bitmap and follows the width on its
    // own; one still waiting has an explicit placeholder height that doesn't.
    // Leaving those behind means the document only partly changes size now and
    // lurches a second time when the re-raster settles — and on a long document
    // almost every page is a placeholder, so that second jump is the big one.
    for (const slot of slotsRef.current) {
      if (!slot.rendered) slot.div.style.height = `${displayW * aspectRef.current}px`;
    }
  };

  // Where the top of the pane sits in the document, as a page and how far into
  // it. A pixel offset can't survive a width change: the gaps between pages are
  // a fixed size, so the document's height doesn't scale with its width, and
  // scaling the offset to match leaves the reader drifting further the further
  // down they were. A page and a fraction of it means nothing to get wrong.
  const captureAnchor = () => {
    const scroll = scrollRef.current, slots = slotsRef.current;
    if (!scroll || !slots.length) return null;
    const top = scroll.scrollTop;
    let index = 0;
    for (let i = 0; i < slots.length; i++) if (slots[i].div.offsetTop <= top + 1) index = i;
    const div = slots[index].div;
    return { index, frac: div.offsetHeight ? (top - div.offsetTop) / div.offsetHeight : 0 };
  };

  // False when the anchored page is gone, which only a rebuild can do — the
  // caller then still has its old offset to fall back on.
  const restoreAnchor = (anchor: { index: number; frac: number } | null) => {
    const scroll = scrollRef.current;
    const div = anchor && slotsRef.current[anchor.index]?.div;
    if (!scroll || !div) return false;
    scroll.scrollTop = div.offsetTop + anchor.frac * div.offsetHeight;
    return true;
  };

  const captureViewState = (): PdfViewState | null => {
    const scroll = scrollRef.current;
    const anchor = captureAnchor();
    if (!scroll || !anchor) return null;
    const maxHorizontal = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
    return {
      page: anchor.index,
      fraction: Math.max(0, Math.min(1, anchor.frac)),
      horizontal: maxHorizontal ? Math.max(0, Math.min(1, scroll.scrollLeft / maxHorizontal)) : 0,
      zoom: zoomFactorRef.current,
      dark: darkRef.current,
    };
  };

  const reportViewState = () => {
    if (!initialViewRestoredRef.current) return;
    const state = captureViewState();
    if (state) onViewStateChange?.(state);
  };
  reportViewStateRef.current = reportViewState;

  // Apply the saved page-relative position once, after the first PDF has page
  // boxes. A raw scrollTop is not durable: changing pane width changes every
  // page height above it. Page + fraction survives window and monitor changes.
  const restoreInitialView = () => {
    if (initialViewRestoredRef.current) return false;
    initialViewRestoredRef.current = true;
    const saved = initialViewRef.current;
    const scroll = scrollRef.current;
    if (!saved || !scroll || !Number.isFinite(saved.page) || !Number.isFinite(saved.fraction)) return false;
    const restored = restoreAnchor({
      index: Math.max(0, Math.floor(saved.page)),
      frac: Math.max(0, Math.min(1, saved.fraction)),
    });
    if (restored && Number.isFinite(saved.horizontal)) {
      const maxHorizontal = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
      scroll.scrollLeft = Math.max(0, Math.min(1, saved.horizontal)) * maxHorizontal;
    }
    return restored;
  };

  // Scroll events are frequent; collapse them into one small session update
  // after the gesture settles rather than making React render or writing on
  // every trackpad tick.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => reportViewStateRef.current(), 140);
    };
    scroll.addEventListener('scroll', changed, { passive: true });
    return () => {
      clearTimeout(timer);
      scroll.removeEventListener('scroll', changed);
    };
  }, []);

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

  // Each zoom step starts a fresh pass while the previous one may still be
  // walking the pages, so passes are numbered and a superseded one stops: without
  // that, an older pass finishing last leaves layers built for the old scale, and
  // then double-click-to-source lands on the wrong word.
  const textPassRef = useRef(0);

  // Build one page's transparent text layer at the current scale. This is what
  // cursor↔PDF sync reads, and what lets a word be selected off the page.
  //
  // It used to run for every page of the document on every recompile, to keep
  // sync working on pages whose bitmap hadn't been drawn. On a 228-page document
  // that measured eight and a half seconds of main-thread work per compile —
  // typed while the compile itself took one and a half — so the editor spent most
  // of its time rebuilding text for pages nobody was looking at. Now a page gets
  // its layer when it comes into view, alongside its bitmap, and the two places
  // that need text from a page that isn't on screen ask for it directly.
  const buildTextLayer = async (i: number, token: number, pass: number) => {
    const doc = docCache.current.doc;
    const slot = slotsRef.current[i - 1];
    if (!doc || !slot) return;
    let page;
    try { page = await doc.getPage(i); } catch { return; }
    if (token !== renderTokenRef.current || pass !== textPassRef.current) return;
    const td = slot.textDiv;
    pageWordIndexesRef.current.delete(td);
    documentWordIndexRef.current = null;
    td.replaceChildren();
    td.style.setProperty('--scale-factor', String(scaleRef.current.dScale));
    const tl = new TextLayer({
      textContentSource: page.streamTextContent(),
      container: td,
      viewport: page.getViewport({ scale: scaleRef.current.dScale }),
    });
    await tl.render();
    if (token !== renderTokenRef.current || pass !== textPassRef.current) return;
    // pdf.js writes a pixel width/height onto the container. Drop them so the
    // stylesheet's inset:0 keeps the layer exactly on its page — an oversized
    // one is invisible but still widens the scroll area.
    td.style.width = '';
    td.style.height = '';
    slot.textRendered = true;
  };

  const ensureTextLayer = async (i: number, token: number) => {
    const slot = slotsRef.current[i - 1];
    if (!slot || slot.textRendered) return;
    await buildTextLayer(i, token, textPassRef.current);
  };

  // Every page's text, for the one caller that has to search the whole document:
  // forward sync, which is looking for a phrase that may be anywhere. Only the
  // pages still missing a layer are built, so after the first search it costs
  // nothing until the next compile or zoom.
  const ensureAllTextLayers = async (token: number) => {
    const pass = textPassRef.current;
    for (let i = 1; i <= slotsRef.current.length; i++) {
      if (token !== renderTokenRef.current || pass !== textPassRef.current) return;
      if (slotsRef.current[i - 1]?.textRendered) continue;
      await buildTextLayer(i, token, pass);
    }
  };

  // A new document or a new scale invalidates every layer. Empty them all —
  // stale spans left on an off-screen page would give sync the wrong answer —
  // and let the observer put back the ones actually in view.
  const invalidateTextLayers = () => {
    textPassRef.current++;
    documentWordIndexRef.current = null;
    pageWordIndexesRef.current.clear();
    for (const slot of slotsRef.current) {
      slot.textRendered = false;
      slot.textDiv.replaceChildren();
    }
  };

  // Redraw the layers that exist, at the scale that now applies. Pages without
  // one stay without one until they scroll into view.
  const refreshTextLayers = async (token: number) => {
    const built: number[] = [];
    slotsRef.current.forEach((slot, i) => { if (slot.textRendered) built.push(i + 1); });
    invalidateTextLayers();
    const pass = textPassRef.current;
    for (const i of built) {
      if (token !== renderTokenRef.current || pass !== textPassRef.current) return;
      await buildTextLayer(i, token, pass);
    }
  };

  // Tokenizing every transparent PDF span on every navigation is unnecessary
  // work on long documents. The text pass is the revision: zoom/recompile starts
  // a new pass and therefore invalidates both whole-document and page indexes.
  const wordIndexFor = (root: ParentNode): WordIndex => {
    const pass = textPassRef.current;
    if (root === pagesRef.current) {
      const cached = documentWordIndexRef.current;
      if (cached && cached.pass === pass && cached.root === root) return cached.index;
      const index = collectSpanWords(root);
      // Typical papers benefit from instant repeated navigation. Avoid pinning
      // another large pair of arrays for book-sized/generated PDFs; those still
      // work, but their uncommon navigation calls rebuild a transient index.
      if (index.words.length <= MAX_CACHED_SYNC_WORDS) documentWordIndexRef.current = { pass, root, index };
      return index;
    }
    const cached = pageWordIndexesRef.current.get(root);
    if (cached?.pass === pass) {
      pageWordIndexesRef.current.delete(root);
      pageWordIndexesRef.current.set(root, cached);
      return cached.index;
    }
    const index = collectSpanWords(root);
    pageWordIndexesRef.current.delete(root);
    pageWordIndexesRef.current.set(root, { pass, index });
    while (pageWordIndexesRef.current.size > MAX_PDF_PAGE_WORD_INDEXES) {
      const oldest = pageWordIndexesRef.current.keys().next().value;
      if (!oldest) break;
      pageWordIndexesRef.current.delete(oldest);
    }
    return index;
  };

  // Track pane width: apply instant CSS width, debounce the crisp re-render.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0].contentRect.width;
      if (Math.abs(w - liveWRef.current) < 1) return;
      liveWRef.current = w;
      // Pages are laid out at a width taken from the pane, so a narrower pane
      // shortens every page above the viewport too and the old scrollTop points
      // somewhere else entirely — half a document away on a long one, which is
      // what threw the reader's place away every time the window was dragged.
      const anchor = captureAnchor();
      applyWidths(w, zoomFactorRef.current);
      restoreAnchor(anchor);
      scheduleRaster();
    });
    ro.observe(el);
    liveWRef.current = el.clientWidth;
    return () => { clearTimeout(debounceRef.current); ro.disconnect(); };
  }, []);

  // Zooming from the toolbar keeps the top of the pane where it was. The wheel
  // handler below wants the point under the pointer instead, and sets its own
  // offsets straight after this returns.
  const setZoom = (z: number) => {
    setZoomFactor(z);
    zoomFactorRef.current = z;
    const anchor = captureAnchor();
    applyWidths(liveWRef.current, z);
    restoreAnchor(anchor);
    scheduleRaster();
    requestAnimationFrame(() => reportViewStateRef.current());
  };
  setZoomRef.current = setZoom;

  // Ctrl/⌘ + wheel zooms instead of scrolling, the way every PDF viewer does —
  // and a trackpad pinch reaches the page as exactly that event, so both
  // gestures land here. The listener must be non-passive: preventDefault is what
  // stops the browser zooming the whole app instead.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      // deltaMode 1 counts lines rather than pixels. Scaling exponentially keeps
      // a pinch smooth while one wheel notch still moves about as much as the
      // toolbar's +/- buttons.
      const perUnit = ev.deltaMode === 1 ? 30 : 1;
      const prev = zoomFactorRef.current;
      const next = Math.min(Math.max(prev * Math.exp(-ev.deltaY * perUnit * 0.0015), 0.25), 8);
      if (Math.abs(next - prev) < 0.0005) return;
      // Keep whatever is under the pointer under the pointer: pages grow from
      // the top-left, so both scroll offsets scale by the same ratio.
      const rect = el.getBoundingClientRect();
      const ox = ev.clientX - rect.left, oy = ev.clientY - rect.top;
      const x = el.scrollLeft + ox, y = el.scrollTop + oy;
      setZoomRef.current(next);
      const ratio = next / prev;
      el.scrollLeft = x * ratio - ox;
      el.scrollTop = y * ratio - oy;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Only pages within ~one screen of the viewport hold a bitmap; the rest stay as
  // placeholders. This observer draws them as they scroll near. Reused across both
  // the in-place refresh and the full rebuild, keyed on the current render token.
  const attachObserver = (tok: number, scrollEl: HTMLDivElement) => {
    ioRef.current?.disconnect();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          const idx = slotsRef.current.findIndex(s => s.div === e.target);
          if (idx >= 0) { drawPage(idx + 1, tok); ensureTextLayer(idx + 1, tok); }
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
    const prevAnchor = captureAnchor();

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
        pageInfoRef.current = { w: vp1.width, h: vp1.height };
        setPageInfo(pageInfoRef.current);
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
        // The text on these pages belongs to the document we just replaced, so
        // it goes before the observer is attached; attaching one fires it for
        // everything already on screen, which puts the visible layers straight
        // back.
        invalidateTextLayers();
        attachObserver(token, scrollEl);
        // Redraw the pages that already hold a bitmap; the rest refresh lazily
        // through the observer as they scroll into view.
        for (let i = 0; i < prevSlots.length; i++) {
          if (prevSlots[i].rendered) drawPage(i + 1, token, true);
        }
        if (restoreInitialView()) requestAnimationFrame(() => reportViewStateRef.current());
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
        slots.push({ div: pageDiv, textDiv, rendered: false, textRendered: false });
      }
      pagesEl.replaceChildren(frag);
      slotsRef.current = slots;
      // A rebuild also happens when the page size changes, and then every page
      // is a different height and the old offset means nothing — the same
      // problem a resize has. Prefer the anchor; the offset is what's left when
      // the document got shorter than the page we were on.
      if (!restoreInitialView() && !restoreAnchor(prevAnchor)) scrollEl.scrollTop = prevScroll;

      invalidateTextLayers();
      attachObserver(token, scrollEl);
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
    // This rewrites every page's box, so hold the reading position across it for
    // the same reason the resize itself does.
    const anchor = captureAnchor();
    for (const slot of slots) {
      slot.div.style.width = `${displayW}px`;
      if (!slot.rendered) slot.div.style.height = `${displayW * aspectRef.current}px`;
    }
    restoreAnchor(anchor);
    for (let i = 0; i < slots.length; i++) if (slots[i].rendered) drawPage(i + 1, token, true);
    refreshTextLayers(token);
  }, [rasterTick, zoomFactor]);

  // Word count from the RENDERED document (the PDF's text), not the Typst source —
  // so `#set`, `#import`, function names and markup syntax don't inflate it.
  //
  // Reading every page's text is the most expensive thing this component does —
  // eight and a half seconds on a 228-page document — and it produces one number
  // in a corner of the toolbar. Running it on each compile meant every keystroke
  // paid for it. So it waits for a pause in the typing, and then for a moment
  // when the browser has nothing better to do; a count that arrives a second
  // late is worth nobody's editing being slow. Each new compile cancels the
  // one waiting, so a long stretch of typing does the work once, at the end.
  useEffect(() => {
    if (!url || !onWordCount) return;
    let cancelled = false;
    let idle = 0;
    const timer = setTimeout(() => {
      const start = () => { if (!cancelled) void count(); };
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
      if (ric) idle = ric(start, { timeout: 3000 });
      else start();
    }, 1200);
    const count = async () => {
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
    };
    return () => {
      cancelled = true;
      clearTimeout(timer);
      const cancelIdle = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
      if (idle && cancelIdle) cancelIdle(idle);
    };
  }, [url, onWordCount]);

  // Building a page's text costs about as much as drawing it, so none of it
  // happens while you type. But forward sync has to search the whole document,
  // and making it build all of that on the spot turned a jump that used to be
  // instant into a four-second wait on this machine and nearly ten on a slower
  // one. So the pages nobody has looked at are filled in quietly instead: after
  // the typing stops, one page per idle slice, abandoned the moment the next
  // compile arrives. Sync stays instant, and the work happens when the editor
  // has nothing else to do.
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let idle = 0;
    const ric = (window as unknown as { requestIdleCallback?: (cb: (d: { timeRemaining(): number }) => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const cancelIdle = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
    const fill = async () => {
      if (cancelled) return;
      const token = renderTokenRef.current;
      const pass = textPassRef.current;
      for (let i = 1; i <= slotsRef.current.length; i++) {
        if (cancelled || token !== renderTokenRef.current || pass !== textPassRef.current) return;
        if (slotsRef.current[i - 1]?.textRendered) continue;
        await buildTextLayer(i, token, pass);
        // Back to the queue between pages: a keystroke, a scroll or the next
        // compile all get to go first.
        await new Promise<void>(resolve => {
          if (ric) ric(() => resolve(), { timeout: 500 });
          else setTimeout(resolve, 0);
        });
      }
    };
    const timer = setTimeout(() => {
      if (ric) idle = ric(() => { void fill(); }, { timeout: 5000 });
      else void fill();
    }, 2500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (idle && cancelIdle) cancelIdle(idle);
    };
  }, [url]);

  // Destroy the last-held PDF document when the preview unmounts (workspace
  // switch, app close) so it doesn't linger with its worker transport.
  useEffect(() => () => {
    const d = docCache.current.doc;
    docCache.current = { url: null, doc: null, naturalW: docCache.current.naturalW };
    documentWordIndexRef.current = null;
    pageWordIndexesRef.current.clear();
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
    async revealSource(p: SyncPayload): Promise<boolean> {
      const pages = pagesRef.current;
      if (!pages) return false;
      // The phrase can be on any page, including one that has never been on
      // screen, so this is the caller that pays for the whole document's text —
      // once per compile, and only if sync is actually used.
      await ensureAllTextLayers(renderTokenRef.current);
      if (!pagesRef.current) return false;
      const { words, spans } = wordIndexFor(pages);
      if (!words.length) return false;
      const prior = Math.round(p.docFraction * words.length);
      const res = bestMatch(words, p.words, p.focus, prior, p.repeat);
      if (!res) return false;
      const span = spans[res.index];
      if (!span) return false;
      span.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      flashSpan(span);
      return true;
    },
    async revealPosition(position): Promise<boolean> {
      const slot = slotsRef.current[position.page - 1];
      const dimensions = pageInfoRef.current;
      if (!slot || !dimensions) return false;
      // One known page — build just that one if it hasn't been on screen.
      await ensureTextLayer(position.page, renderTokenRef.current);
      const pageRect = slot.div.getBoundingClientRect();
      let nearest: { span: HTMLElement; score: number; vertical: number } | null = null;
      for (const span of Array.from(slot.textDiv.querySelectorAll<HTMLElement>('span'))) {
        const rect = span.getBoundingClientRect();
        if (!rect.width && !rect.height) continue;
        const x = (rect.left - pageRect.left + rect.width / 2) / pageRect.width * dimensions.w;
        const y = (rect.top - pageRect.top + rect.height / 2) / pageRect.height * dimensions.h;
        const vertical = Math.abs(y - position.y);
        // Block equation locations use the containing block's left edge rather
        // than the centred glyph x, so vertical distance is authoritative.
        const score = vertical + Math.abs(x - position.x) * 0.04;
        if (!nearest || score < nearest.score) nearest = { span, score, vertical };
      }
      if (nearest && nearest.vertical <= 56) {
        nearest.span.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        flashSpan(nearest.span);
      } else {
        slot.div.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      }
      return true;
    },
  }), []);

  // Reverse sync (PDF → source): a double-click selects a word; gather a window
  // of neighbouring words (in reading order) plus a positional prior, and let
  // the editor resolve the exact source location.
  const handleDblClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const sel = window.getSelection();
    const selectedWords = tokenizeRenderedText((sel?.toString() ?? '').trim());
    // The event target is more dependable than selection.anchorNode for a math
    // glyph. WebKit and Chromium can anchor a double-click selection on the text
    // layer container even though the pointer was over a child span.
    const target = event.target instanceof Element ? event.target : null;
    const node = sel?.anchorNode;
    const selectionElement = node && (node.nodeType === 3 ? node.parentElement : node as HTMLElement);
    // pdf.js positions many transparent text runs independently. Browser word
    // selection can bridge two of those runs (especially diagram labels), which
    // paints what looks like a blue page-sized rectangle. We have already read
    // the selected word and anchor; discard the native selection on the next
    // frame while retaining Hilbert's short source-location flash.
    requestAnimationFrame(() => {
      const current = window.getSelection();
      if (current?.anchorNode && pagesRef.current?.contains(current.anchorNode)) current.removeAllRanges();
    });
    const clickedSpan = (target?.closest('.textLayer span') || selectionElement?.closest?.('.textLayer span')) as HTMLElement | null;
    const clickedText = clickedSpan?.textContent || '';
    const mathHint = /[=+−*/^_<>∞∫∬∭∑∏√∂∇α-ωΑ-Ω\u{1D400}-\u{1D7FF}]/u.test(clickedText);
    const layer = (clickedSpan?.closest('.textLayer') || target?.closest('.textLayer')) as HTMLElement | null;
    const pageElement = (clickedSpan?.closest('.pdf-page') || target?.closest('.pdf-page')) as HTMLElement | null;
    const pageIndex = pageElement ? slotsRef.current.findIndex(slot => slot.div === pageElement) : -1;
    const pageRect = pageElement?.getBoundingClientRect();
    const documentPosition = pageInfo && pageRect && pageRect.width > 0 && pageRect.height > 0 && pageIndex >= 0
      ? {
          page: pageIndex + 1,
          x: Math.max(0, Math.min(pageInfo.w, (event.clientX - pageRect.left) / pageRect.width * pageInfo.w)),
          y: Math.max(0, Math.min(pageInfo.h, (event.clientY - pageRect.top) / pageRect.height * pageInfo.h)),
        }
      : undefined;
    // The number Typst prints beside a block equation: the last thing on the
    // formula's line, out at the margin. It has to be the last one — digits
    // inside the formula itself look exactly like it, and picking `8` out of
    // `58.8` sends the jump to whichever equation happens to be eighth.
    const equationNumber = (() => {
      if (!clickedSpan || !layer) return null;
      const rect = clickedSpan.getBoundingClientRect();
      const line = Array.from(layer.querySelectorAll<HTMLElement>('span'))
        .map(span => ({ span, box: span.getBoundingClientRect() }))
        .filter(({ span, box }) => box.width > 0 && span.textContent?.trim()
          && Math.abs(box.top - rect.top) <= rect.height * 0.9)
        .sort((a, b) => a.box.left - b.box.left);
      const last = line[line.length - 1];
      if (!last || last.box.left < rect.right - 1) return null;
      const digits = /^\(?(\d{1,4})\)?$/.exec(last.span.textContent?.trim() || '');
      return digits ? Number(digits[1]) : null;
    })();

    const pagesRect = pagesRef.current?.getBoundingClientRect();
    const clickedFraction = pagesRect?.height
      ? Math.max(0, Math.min(1, (event.clientY - pagesRect.top) / pagesRect.height))
      : 0;
    if (!clickedSpan || !layer) {
      if (documentPosition) onReverseSync({ words: [], focus: 0, docFraction: clickedFraction, documentPosition, mathHint, equationNumber });
      return;
    }

    const { words, spans } = wordIndexFor(layer);
    const spanIndexes = spans.map((span, index) => span === clickedSpan ? index : -1).filter(index => index >= 0);
    // Operators and fraction/radical geometry may have no word token at all.
    // The compiled equation-location resolver can still map their coordinates.
    if (!spanIndexes.length) {
      if (documentPosition) onReverseSync({ words: [], focus: 0, docFraction: docFractionOf(clickedSpan), documentPosition, mathHint, equationNumber });
      return;
    }
    const selectedWord = selectedWords.find(word => spanIndexes.some(index => words[index] === word)) || selectedWords[0];
    let focus = selectedWord ? spanIndexes.find(index => words[index] === selectedWord) ?? -1 : -1;
    // One pdf.js span can contain several formula atoms. If selection did not
    // identify one (notably for operators), use the pointer's horizontal place
    // inside the span instead of always choosing its first atom.
    if (focus < 0) {
      const rect = clickedSpan.getBoundingClientRect();
      const ratio = rect.width > 0 ? Math.max(0, Math.min(0.999, (event.clientX - rect.left) / rect.width)) : 0;
      focus = spanIndexes[Math.floor(ratio * spanIndexes.length)];
    }
    if (focus < 0) return;
    const from = Math.max(0, focus - 8);
    const to = Math.min(words.length, focus + 9);
    // A double-click can isolate `𝑥` from a span whose full PDF text is `d𝑥`.
    // Preserve the surrounding span tokens but make the selected atom the focus
    // so it aligns with `x` rather than the synthetic combined token `dx`. This
    // edits the outgoing copy: `words` is the retained index for this revision,
    // and writing through it would leave every later click matching against a
    // word this one click happened to select.
    const context = words.slice(from, to);
    if (selectedWord) context[focus - from] = selectedWord;
    onReverseSync({ words: context, focus: focus - from, docFraction: docFractionOf(clickedSpan), documentPosition, mathHint, equationNumber });
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
        <button className={`pdf-btn ${dark ? 'active' : ''}`} onClick={() => setDark(d => {
          const next = !d;
          darkRef.current = next;
          requestAnimationFrame(() => reportViewStateRef.current());
          return next;
        })} title="Toggle dark PDF" style={{ marginRight: 'auto' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
        </button>
        <button className="pdf-btn" onClick={() => setZoom(Math.max(zoomFactor / 1.15, 0.25))} title="Zoom out">−</button>
        <select className="pdf-zoom-select" value={selValue} title="Zoom (100% = fit width) — Ctrl/⌘ + scroll over the page also zooms"
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
      <div className="pdf-scroll" ref={scrollRef} onDoubleClick={handleDblClick} title="Double-click a word to jump to it in the source · Ctrl/⌘ + scroll to zoom">
        <div className="pdf-pages" ref={pagesRef} />
      </div>
    </div>
  );
}

export default memo(forwardRef(PdfPreview));
