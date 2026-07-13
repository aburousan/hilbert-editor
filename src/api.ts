// Base URL for the backend. When the page is served by the backend itself
// (production build, desktop app), relative URLs reach the right server no
// matter which port it bound — the desktop app picks a free one if 3001 is
// taken. Only `vite dev` serves the UI from its own port (5173), with the
// backend on the standard 3001.
export const API = window.location.port === '5173' ? 'http://localhost:3001' : '';

declare global {
  interface Window {
    __HILBERT_API_TOKEN__?: string;
  }
}

const originalFetch = window.fetch.bind(window);
const backendOrigin = new URL(API || window.location.origin, window.location.origin).origin;
const tokenPromise: Promise<string> = window.__HILBERT_API_TOKEN__
  ? Promise.resolve(window.__HILBERT_API_TOKEN__)
  : window.location.port === '5173'
    ? originalFetch(`${API}/auth/dev-token`).then(async response => {
        if (!response.ok) throw new Error('Hilbert development API authentication failed');
        const body = await response.json();
        return typeof body.token === 'string' ? body.token : '';
      })
    : Promise.resolve('');

window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const rawUrl = input instanceof Request ? input.url : input.toString();
  const url = new URL(rawUrl, window.location.href);
  if (url.origin !== backendOrigin) {
    return originalFetch(input, init);
  }

  const token = await tokenPromise;
  if (!token) {
    return originalFetch(input, init);
  }

  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set('Authorization', `Bearer ${token}`);
  return originalFetch(input, { ...init, headers });
};
