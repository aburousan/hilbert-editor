import { useEffect, useState } from 'react';

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

// A workspace asset as a URL an <img>, <embed> or PDF viewer can load.
//
// Pointing such an element straight at /workspace/raw does not work: the
// browser fetches those on its own, outside the wrapper above, so the request
// carries no Authorization header and the backend answers 401 — which is why
// opening an image showed the broken-image glyph. Reading the bytes here and
// handing back a blob URL also keeps the data same-origin, so a <canvas> drawn
// from it stays untainted and crop and rotate can still read the pixels back.
//
// Pass a revision that changes whenever the file's contents change (a
// collaborator's copy arriving, a crop being saved) to refetch it.
export function useWorkspaceAsset(path: string | null, revision: unknown = 0): { url: string | null; error: string | null } {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    setError(null);
    if (!path) {
      return;
    }
    let active = true;
    let objectUrl = '';
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${API}/workspace/raw?path=${encodeURIComponent(path)}`, { signal: controller.signal });
        if (!response.ok) {
          const detail = (await response.text()).trim();
          throw new Error(detail || `Preview failed (${response.status})`);
        }
        const blob = await response.blob();
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (cause) {
        if (active) {
          setUrl(null);
          setError(cause instanceof Error ? cause.message : 'Could not load this preview.');
        }
      }
    })();
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, revision]);
  return { url, error };
}
