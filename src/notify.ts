// Lightweight app-wide toast. Any module can call notify() without prop-drilling;
// the <Toaster/> mounted in App listens for these events and renders the stack.
export type NoticeKind = 'error' | 'info' | 'success';

export function notify(message: string, kind: NoticeKind = 'error') {
  window.dispatchEvent(new CustomEvent('app-notice', { detail: { message, kind } }));
}
