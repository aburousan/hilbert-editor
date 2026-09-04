// Windows and Linux keyboards have no ⌘, ⇧ or ⌥ key. A menu that shows them
// there is telling the reader to press something their machine does not have,
// which is how "⌘K" ended up in a bug report from a Windows tester.
export const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// Write shortcuts the Mac way and let this translate them: '⌘⇧M' reads as
// Ctrl+Shift+M everywhere else.
export function keys(mac: string): string {
  if (IS_MAC) return mac;
  return mac
    .replace(/⌘/g, 'Ctrl+')
    .replace(/⇧/g, 'Shift+')
    .replace(/⌥/g, 'Alt+')
    .replace(/⌫/g, 'Backspace')
    .replace(/\+\s+/g, '+')
    .replace(/\+{2,}/g, '+');
}
