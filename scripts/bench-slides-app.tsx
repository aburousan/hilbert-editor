import { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import SlideStudio from '../src/components/SlideStudio';
import '../src/index.css';

// Throwaway harness for measuring Slide Studio render cost. Mounts the studio
// on a synthetic deck and records every React commit so a drag can be priced.

const SLIDES = Number(new URLSearchParams(location.search).get('slides') || 24);
let id = 1000;
const nid = () => id++;

const makeSlide = (n: number) => ({
  id: nid(),
  fill: n % 4 === 0 ? '#0f172a' : '#ffffff',
  els: [
    { id: nid(), type: 'text', x: 52, y: 34, w: 740, size: 32, color: '#111827', align: 'left', text: `= Section ${n}` },
    { id: nid(), type: 'text', x: 60, y: 120, w: 360, size: 20, color: '#334155', align: 'left', text: 'A line of body text\nand a second line\nand a third' },
    { id: nid(), type: 'math', x: 460, y: 130, size: 28, color: '#111827', tex: 'integral_0^oo e^(-x^2) dif x = sqrt(pi)/2' },
    { id: nid(), type: 'rect', x: 56, y: 250, w: 220, h: 160, fill: '#ede9fe', stroke: '#c4b5fd', sw: 1.2, radius: 12 },
    { id: nid(), type: 'ellipse', x: 300, y: 250, w: 180, h: 150, fill: '#dbeafe', stroke: '#93c5fd', sw: 1.2, radius: 0 },
    { id: nid(), type: 'image', x: 520, y: 250, w: 240, path: 'images/figure.png' },
    { id: nid(), type: 'conn', kind: 'arrow', x1: 290, y1: 330, x2: 500, y2: 330, color: '#111827', th: 1.6 },
    { id: nid(), type: 'hl', x: 60, y: 200, w: 300, h: 26, color: '#fde047' },
    { id: nid(), type: 'curve', pts: [{ x: 60, y: 430 }, { x: 240, y: 400 }, { x: 420, y: 440 }, { x: 620, y: 405 }], color: '#7c3aed', th: 2, closed: false, fill: 'none', arrows: 'end' },
    { id: nid(), type: 'typst', x: 600, y: 40, w: 200, code: '#table(columns: 2, [a], [b], [c], [d])' },
  ],
});

const deck = Array.from({ length: SLIDES }, (_, i) => makeSlide(i + 1));
const token = btoa(unescape(encodeURIComponent(JSON.stringify({ v: 1, slides: deck, imports: [] }))));

const commits: number[] = [];
(window as any).__commits = commits;
(window as any).__deckSize = { slides: SLIDES, els: SLIDES * deck[0].els.length };

createRoot(document.getElementById('root')!).render(
  <Profiler id="studio" onRender={(_id, _phase, actual) => { commits.push(actual); }}>
    <SlideStudio
      onClose={() => {}}
      onInsert={() => {}}
      workspaceImages={['images/figure.png', 'images/plot.png']}
      existing={token}
    />
  </Profiler>,
);
