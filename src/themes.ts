// The list of themes, in one place. Each id is used three ways and they have to
// agree: as the Monaco theme name, as the value of data-theme on <html> (minus
// the `typst-` prefix, which is where the CSS palette hangs off), and as what
// gets written to the settings file.

export type ThemeId =
  | 'typst-dark'
  | 'typst-light'
  | 'typst-sepia'
  | 'typst-midnight'
  | 'typst-contrast';

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  // What it is for, shown in Settings — a name alone doesn't say why you'd pick
  // Midnight over Ink.
  note: string;
  dark: boolean;
}

export const THEMES: ThemeInfo[] = [
  { id: 'typst-dark', label: 'Ink', note: 'The default: charcoal and violet', dark: true },
  { id: 'typst-light', label: 'Paper', note: 'Daylight, cool greys', dark: false },
  { id: 'typst-sepia', label: 'Sepia', note: 'Warm and low-blue, for long sessions', dark: false },
  { id: 'typst-midnight', label: 'Midnight', note: 'Near-black, for dark rooms and OLED', dark: true },
  { id: 'typst-contrast', label: 'High Contrast', note: 'Maximum legibility over subtlety', dark: true },
];

export const DEFAULT_THEME: ThemeId = 'typst-dark';

export const isThemeId = (value: unknown): value is ThemeId =>
  typeof value === 'string' && THEMES.some(t => t.id === value);

export const themeInfo = (id: ThemeId): ThemeInfo =>
  THEMES.find(t => t.id === id) || THEMES[0];

// What data-theme becomes. The dark palette is the one in :root, so it needs no
// attribute of its own and the others are named by their suffix.
export const themeAttribute = (id: ThemeId): string => id.replace(/^typst-/, '');

// The header button steps through the list in order and wraps. An unknown id —
// a settings file from a newer build, say — starts again from the beginning
// rather than sticking.
export const nextTheme = (id: ThemeId): ThemeId => {
  const index = THEMES.findIndex(t => t.id === id);
  return THEMES[(index + 1) % THEMES.length].id;
};
