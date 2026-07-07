import React, { useState, useEffect } from 'react';
import './PackageInstaller.css';

interface Template { name: string; version: string; description: string; authors: string[]; }
interface TemplateInstallerProps { onInsert: (result: { code: string; entrypoint?: string }) => void; onClose: () => void; }

import { API } from './api';

export function TemplateInstaller({ onInsert, onClose }: TemplateInstallerProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Template[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [selected, setSelected] = useState<Template | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'error'>('idle');

  useEffect(() => { fetchPackages('paper'); }, []);

  const fetchPackages = async (searchQuery: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/packages?q=${encodeURIComponent(searchQuery)}`);
      if (res.ok) setResults(await res.json());
    } catch { /* ignore */ } finally {
      setLoading(false); setInitialLoading(false);
    }
  };

  // Render a one-page preview when a template is selected.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setPreviewState('loading'); setPreviewUrl(null);
    (async () => {
      try {
        const res = await fetch(`${API}/template/preview?name=${encodeURIComponent(selected.name)}&version=${encodeURIComponent(selected.version)}`);
        if (cancelled) return;
        if (!res.ok) { setPreviewState('error'); return; }
        const blob = await res.blob();
        if (cancelled) return;
        setPreviewUrl(URL.createObjectURL(blob));
        setPreviewState('idle');
      } catch { if (!cancelled) setPreviewState('error'); }
    })();
    return () => { cancelled = true; };
  }, [selected]);

  // Revoke the previous preview blob URL when it changes or the modal closes —
  // the cleanup captures the prior value, so browsing templates doesn't pile up
  // orphaned object URLs (each holds its PNG in memory).
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const handleSearch = (e: React.FormEvent) => { e.preventDefault(); if (query.trim()) fetchPackages(query); };

  const handleInitTemplate = async (pkg: Template) => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/init-template`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: `@preview/${pkg.name}:${pkg.version}` })
      });
      if (res.ok) onInsert(await res.json());
      else alert('Failed to initialize template. It may contain complex multi-file dependencies.');
    } catch { alert('Network error initializing template'); } finally { setLoading(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '860px', maxWidth: '94vw', height: '80vh' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Create from Template</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        <form className="search-form" onSubmit={handleSearch}>
          <input type="text" placeholder="Search templates (e.g. ieee, paper, letter)..." value={query} onChange={e => setQuery(e.target.value)} autoFocus />
          <button type="submit" disabled={loading}>{loading ? '...' : 'Search'}</button>
        </form>
        <div className="form-hint" style={{ padding: '0 20px 8px' }}>Previews are cached; a template you use is downloaded once and then works offline.</div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          <div className="results-list" style={{ flex: '0 0 48%', borderRight: '1px solid var(--border-color)' }}>
            {initialLoading ? (
              <div className="empty-state">Loading popular templates...</div>
            ) : results.length === 0 ? (
              <div className="empty-state">No templates found.</div>
            ) : results.map((pkg, i) => (
              <div key={i} className={`package-card ${selected?.name === pkg.name ? 'selected' : ''}`} onClick={() => setSelected(pkg)} style={{ cursor: 'pointer' }}>
                <div className="pkg-header">
                  <h3>{pkg.name}</h3>
                  <span className="pkg-version">v{pkg.version}</span>
                </div>
                <p className="pkg-desc">{pkg.description}</p>
                <div className="pkg-footer">
                  <span className="pkg-authors">By: {pkg.authors?.join(', ')}</span>
                  <button className="insert-btn" onClick={(e) => { e.stopPropagation(); handleInitTemplate(pkg); }} disabled={loading}>Use Template</button>
                </div>
              </div>
            ))}
          </div>

          <div className="template-preview">
            {!selected ? (
              <div className="empty-state" style={{ margin: 'auto' }}>Select a template to preview it.</div>
            ) : previewState === 'loading' ? (
              <div className="empty-state" style={{ margin: 'auto' }}>
                <div className="spinner" /> Rendering preview…
                <div style={{ fontSize: 11, marginTop: 6, opacity: 0.7 }}>(first time downloads the template)</div>
              </div>
            ) : previewState === 'error' ? (
              <div className="empty-state" style={{ margin: 'auto', textAlign: 'center' }}>
                No preview (this template needs extra files or fonts).
                <div style={{ marginTop: 12 }}>
                  <button className="btn-primary" onClick={() => handleInitTemplate(selected)} disabled={loading}>Use “{selected.name}” anyway</button>
                </div>
              </div>
            ) : previewUrl ? (
              <>
                <img src={previewUrl} alt={`${selected.name} preview`} className="template-thumb" />
                <button className="btn-primary" style={{ margin: '12px auto 0' }} onClick={() => handleInitTemplate(selected)} disabled={loading}>Use “{selected.name}”</button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
