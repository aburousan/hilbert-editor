import React, { useState, useEffect } from 'react';
import './PackageInstaller.css';

import { API } from './api';
import { notify } from './notify';

interface Package { name: string; version: string; description: string; authors: string[]; }
interface PackageInstallerProps { onInsert: (pkg: Package) => void; onClose: () => void; }

export function PackageInstaller({ onInsert, onClose }: PackageInstallerProps) {
  const [tab, setTab] = useState<'installed' | 'search'>('installed');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Package[]>([]);
  const [installed, setInstalled] = useState<Package[]>([]);
  const [installedKeys, setInstalledKeys] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // "name:version" being downloaded
  const [filter, setFilter] = useState('');

  const key = (p: Package) => `${p.name}:${p.version}`;

  const loadInstalled = async () => {
    try {
      const res = await fetch(`${API}/packages/installed`);
      if (res.ok) {
        const data: Package[] = await res.json();
        setInstalled(data);
        setInstalledKeys(new Set(data.map(key)));
      }
    } catch { /* ignore */ }
  };
  useEffect(() => { loadInstalled(); }, []);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/packages?q=${encodeURIComponent(query)}`);
      if (res.ok) setResults(await res.json());
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const download = async (pkg: Package) => {
    setBusy(key(pkg));
    try {
      const res = await fetch(`${API}/packages/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: pkg.name, version: pkg.version }) });
      if (res.ok) await loadInstalled();
      else notify((await res.json().catch(() => ({}))).error || 'Download failed.');
    } catch { notify('Could not reach the local server.'); } finally { setBusy(null); }
  };

  const remove = async (pkg: Package) => {
    if (!confirm(`Remove @${pkg.name}:${pkg.version} from the local cache?`)) return;
    setBusy(key(pkg));
    try {
      const res = await fetch(`${API}/packages/remove`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: pkg.name, version: pkg.version }) });
      if (res.ok) await loadInstalled();
      else notify((await res.json().catch(() => ({}))).error || 'Remove failed.');
    } catch { notify('Could not reach the local server.'); } finally { setBusy(null); }
  };

  const shownInstalled = filter.trim()
    ? installed.filter(p => (p.name + ' ' + p.description).toLowerCase().includes(filter.toLowerCase()))
    : installed;

  const card = (pkg: Package, isInstalled: boolean) => (
    <div key={key(pkg)} className="package-card">
      <div className="pkg-header">
        <h3>@{pkg.name}</h3>
        <span className="pkg-version">v{pkg.version}</span>
      </div>
      {pkg.description && <p className="pkg-desc">{pkg.description}</p>}
      <div className="pkg-footer">
        <span className="pkg-authors">{pkg.authors?.length ? 'By: ' + pkg.authors.join(', ') : ''}</span>
        {isInstalled ? (
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="insert-btn" disabled={busy === key(pkg)} onClick={() => remove(pkg)} style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', borderColor: 'rgba(239,68,68,0.3)' }}>
              {busy === key(pkg) ? '…' : 'Remove'}
            </button>
            <button className="insert-btn" onClick={() => onInsert(pkg)}>Import</button>
          </span>
        ) : (
          <button className="insert-btn" disabled={busy === key(pkg)} onClick={() => download(pkg)}>
            {busy === key(pkg) ? 'Downloading…' : '⬇ Download'}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '560px', height: '78vh' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Typst Packages</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <div style={{ padding: '12px 20px 0' }}>
          <div className="seg">
            <button className={tab === 'installed' ? 'active' : ''} onClick={() => setTab('installed')}>Installed ({installed.length})</button>
            <button className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}>Search &amp; Download</button>
          </div>
        </div>

        {tab === 'installed' ? (
          <>
            <div className="search-form" style={{ borderTop: 'none' }}>
              <input type="text" placeholder="Filter installed packages…" value={filter} onChange={e => setFilter(e.target.value)} autoFocus />
            </div>
            <div className="results-list">
              {shownInstalled.length === 0 && <div className="empty-state">No installed packages{filter ? ' match your filter' : ''}.</div>}
              {shownInstalled.map(p => card(p, true))}
            </div>
          </>
        ) : (
          <>
            <form className="search-form" onSubmit={handleSearch}>
              <input type="text" placeholder="Search Typst Universe (e.g. table, chart, cetz)…" value={query} onChange={e => setQuery(e.target.value)} autoFocus />
              <button type="submit" disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
            </form>
            <div className="results-list">
              {results.length === 0 && !loading && <div className="empty-state">Search Typst Universe to find and download packages.</div>}
              {results.map(p => card(p, installedKeys.has(key(p))))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
