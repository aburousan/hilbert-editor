import { API } from './api';

// The editor's clipboard runs through the app's backend rather than the
// browser's clipboard API.
//
// Monaco's Cut/Copy/Paste menu entries call document.execCommand, which a
// webview will not do on a page's behalf. Paste is the worst of it: the
// service behind the menu item returns nothing at all outside VS Code's own
// shell, so the entry sits in the menu and does nothing when clicked. Cut is
// worse than useless on macOS — WebKit refuses the copy half and the delete
// half still runs, so the text is gone and never reached the clipboard.
//
// The backend can talk to the real system clipboard, so both directions go
// there and behave identically on Linux, macOS and Windows. The browser's own
// clipboard is kept as a fallback for the case where the backend cannot reach
// one (a headless session, a Wayland compositor without the data-control
// protocol), which is also the only case where the old behaviour was all there
// ever was.

export async function readClipboard(): Promise<string> {
  try {
    const response = await fetch(`${API}/clipboard`);
    if (response.ok) {
      const body = await response.json();
      if (typeof body.text === 'string') return body.text;
    }
  } catch {
    // backend unreachable — try the browser below
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    const response = await fetch(`${API}/clipboard`, { method: 'POST', body: text });
    if (response.ok) return true;
  } catch {
    // backend unreachable — try the browser below
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
