// Base URL for the backend. When the page is served by the backend itself
// (production build, desktop app), relative URLs reach the right server no
// matter which port it bound — the desktop app picks a free one if 3001 is
// taken. Only `vite dev` serves the UI from its own port (5173), with the
// backend on the standard 3001.
export const API = window.location.port === '5173' ? 'http://localhost:3001' : '';
