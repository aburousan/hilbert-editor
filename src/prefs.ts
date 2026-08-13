// Which interpreter the user picked for each language.
//
// This used to be nothing but localStorage, and localStorage is keyed to the
// webview's origin — which carries the port. The app asks for 3001 and takes
// whatever is free when something else already has it, so a second window or a
// stale process was enough to hand it a different origin and an empty store,
// and the carefully chosen conda env quietly reverted to whichever python the
// backend happened to find first.
//
// It still reads from localStorage, because that is synchronous and every
// caller wants an answer immediately. The difference is that App.tsx mirrors
// the whole set into the settings file and puts it back at startup, and a write
// here announces itself so that mirroring actually happens.

export const INTERPRETER_LANGS = ['python', 'julia', 'wolfram'] as const;

export const PREFS_CHANGED = 'hilbert:prefs-changed';

const key = (lang: string) => `interp_${lang}`;

export const getInterpreter = (lang: string): string => localStorage.getItem(key(lang)) || '';

export function setInterpreter(lang: string, path: string) {
  if (getInterpreter(lang) === path) return;
  localStorage.setItem(key(lang), path);
  window.dispatchEvent(new Event(PREFS_CHANGED));
}

// What a run should save its figures as. PNG is the safe default; SVG and PDF
// keep the plot as vectors so it stays sharp at any zoom and prints properly.
// EPS is for journals that still demand it — Typst cannot embed EPS, so an EPS
// run also writes a PDF twin and the document points at that (see the notebook
// harnesses in server.rs).
export const PLOT_FORMATS = ['png', 'svg', 'pdf', 'eps'] as const;
export type PlotFormat = (typeof PLOT_FORMATS)[number];

const PLOT_FORMAT_KEY = 'plot_format';

export const getPlotFormat = (): PlotFormat => {
  const saved = localStorage.getItem(PLOT_FORMAT_KEY);
  return (PLOT_FORMATS as readonly string[]).includes(saved || '') ? (saved as PlotFormat) : 'png';
};

export function setPlotFormat(format: PlotFormat) {
  if (getPlotFormat() === format) return;
  localStorage.setItem(PLOT_FORMAT_KEY, format);
  window.dispatchEvent(new Event(PREFS_CHANGED));
}

export function applyPlotFormat(saved: unknown) {
  if (typeof saved === 'string' && (PLOT_FORMATS as readonly string[]).includes(saved)) {
    localStorage.setItem(PLOT_FORMAT_KEY, saved);
  }
}

// Typst embeds raster and PDF images; EPS and PostScript it cannot read at all.
// Anything this rejects is still saved into the project, just referenced by name
// instead of drawn into the document.
export const embeddableInTypst = (path: string): boolean =>
  /\.(png|jpe?g|gif|svg|webp|pdf)$/i.test(path);

// The whole set, for writing to the settings file. Languages with no choice
// recorded are left out rather than stored as empty strings, so "no preference"
// and "preference for nothing" don't get confused on the way back.
export function allInterpreters(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const lang of INTERPRETER_LANGS) {
    const path = getInterpreter(lang);
    if (path) out[lang] = path;
  }
  return out;
}

// Put a saved set back. Silent on purpose: this runs during startup restore, and
// announcing it would ask for a save of what was just read.
export function applyInterpreters(saved: unknown) {
  if (!saved || typeof saved !== 'object') return;
  for (const [lang, path] of Object.entries(saved as Record<string, unknown>)) {
    if (typeof path === 'string' && path && (INTERPRETER_LANGS as readonly string[]).includes(lang)) {
      localStorage.setItem(key(lang), path);
    }
  }
}
