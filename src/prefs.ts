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
export type InterpreterLang = (typeof INTERPRETER_LANGS)[number];

export const PREFS_CHANGED = 'hilbert:prefs-changed';

const key = (lang: string) => `interp_${lang}`;

export const getInterpreter = (lang: string): string => localStorage.getItem(key(lang)) || '';

export function setInterpreter(lang: string, path: string) {
  if (getInterpreter(lang) === path) return;
  localStorage.setItem(key(lang), path);
  window.dispatchEvent(new Event(PREFS_CHANGED));
}

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
