import { useEffect, useState } from 'react';

import { API } from '../api';
const BIB = 'refs.bib';

// ---------------------------------------------------------------------------
// Citation / bibliography manager. Look a paper up by DOI or arXiv id, get its
// BibTeX, store it in the workspace refs.bib, and insert @key citations. Also
// lists what's already in refs.bib and can drop in the #bibliography call.
// ---------------------------------------------------------------------------

type Entry = { key: string; title: string; author: string; year: string };

function parseBib(text: string): Entry[] {
  const out: Entry[] = [];
  for (const m of text.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,([\s\S]*?)\n\}/g)) {
    const key = m[1];
    const body = m[2];
    const field = (name: string) => {
      const f = body.match(new RegExp(name + '\\s*=\\s*[{"]([\\s\\S]*?)["}]\\s*,?\\s*\\n', 'i'));
      return f ? f[1].replace(/\s+/g, ' ').trim() : '';
    };
    out.push({ key, title: field('title'), author: field('author'), year: field('year') });
  }
  return out;
}

export default function BibManager({ onClose, onCite, onEnsureBib, onChanged }: {
  onClose: () => void;
  onCite: (key: string) => void;
  onEnsureBib: () => void;
  onChanged?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<{ key: string; bibtex: string } | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [savedMsg, setSavedMsg] = useState('');

  const loadBib = async () => {
    try {
      const res = await fetch(`${API}/workspace/file?path=${BIB}`);
      setEntries(res.ok ? parseBib(await res.text()) : []);
    } catch { setEntries([]); }
  };
  useEffect(() => { loadBib(); }, []);

  const fetchEntry = async () => {
    if (!query.trim()) return;
    setLoading(true); setError(''); setDraft(null);
    try {
      const res = await fetch(`${API}/bib/fetch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: query }) });
      const data = await res.json();
      if (!res.ok) setError(data.error || 'Lookup failed.');
      else setDraft({ key: data.key, bibtex: data.bibtex });
    } catch { setError('Could not reach the local server.'); } finally { setLoading(false); }
  };

  const save = async () => {
    if (!draft) return;
    setError(''); setSavedMsg('');
    try {
      const cur = await fetch(`${API}/workspace/file?path=${BIB}`);
      const existing = cur.ok ? await cur.text() : '';
      if (new RegExp(`@\\w+\\s*\\{\\s*${draft.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,`).test(existing)) {
        setError(`"${draft.key}" is already in ${BIB}.`);
        return;
      }
      const next = (existing.trim() ? existing.trimEnd() + '\n\n' : '') + draft.bibtex.trim() + '\n';
      await fetch(`${API}/workspace/file?path=${BIB}`, { method: 'POST', body: next, headers: { 'Content-Type': 'text/plain' } });
      onEnsureBib();
      await loadBib();
      onChanged?.();
      setSavedMsg(`Added "${draft.key}" to ${BIB}.`);
      setDraft(null); setQuery('');
    } catch { setError('Could not write refs.bib.'); }
  };

  const remove = async (key: string) => {
    if (!confirm(`Remove "${key}" from ${BIB}?`)) return;
    try {
      const cur = await fetch(`${API}/workspace/file?path=${BIB}`);
      if (!cur.ok) return;
      const text = await cur.text();
      const stripped = text.replace(new RegExp(`@\\w+\\s*\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,[\\s\\S]*?\\n\\}\\s*`, 'g'), '');
      await fetch(`${API}/workspace/file?path=${BIB}`, { method: 'POST', body: stripped, headers: { 'Content-Type': 'text/plain' } });
      await loadBib();
      onChanged?.();
    } catch { /* ignore */ }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '620px', maxHeight: '88vh' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Citations &amp; Bibliography</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ overflowY: 'auto' }}>
          <div className="form-hint">Look up a paper by <b>DOI</b> (e.g. 10.1103/PhysRev.47.777) or <b>arXiv id</b> (e.g. 2101.12345). It's saved to <code>{BIB}</code> and cited with <code>@key</code>. Needs an internet connection for the lookup only.</div>
          <div className="form-row" style={{ alignItems: 'flex-end' }}>
            <label className="form-field" style={{ flex: 1 }}><span>DOI / arXiv id / URL</span>
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="10.1103/PhysRev.47.777  ·  arXiv:2101.12345"
                onKeyDown={e => { if (e.key === 'Enter') fetchEntry(); }} autoFocus />
            </label>
            <button className="btn-primary" onClick={fetchEntry} disabled={loading} style={{ height: 38 }}>{loading ? 'Looking up…' : 'Look up'}</button>
          </div>
          {error && <div className="form-hint" style={{ color: '#fca5a5' }}>{error}</div>}
          {savedMsg && <div className="form-hint" style={{ color: '#4ade80' }}>{savedMsg}</div>}

          {draft && (
            <div style={{ background: 'var(--bg-color)', borderRadius: 8, padding: 12, margin: '4px 0 8px' }}>
              <label className="form-field"><span>Citation key</span>
                <input value={draft.key} onChange={e => setDraft({ ...draft, key: e.target.value.replace(/\s/g, '') , bibtex: draft.bibtex })} />
              </label>
              <label className="form-field"><span>BibTeX (editable)</span>
                <textarea value={draft.bibtex} onChange={e => setDraft({ ...draft, bibtex: e.target.value })} spellCheck={false} style={{ minHeight: 130, fontSize: '0.8rem' }} />
              </label>
              <button className="btn-primary" onClick={save}>Add to {BIB}</button>
            </div>
          )}

          <div className="form-field" style={{ marginBottom: 4, marginTop: 6 }}>
            <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>In {BIB} ({entries.length})</span>
              {entries.length > 0 && <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={onEnsureBib} title={`Insert #bibliography("${BIB}") at the end of the document`}>Insert bibliography section</button>}
            </span>
          </div>
          {entries.length === 0 ? (
            <div className="form-hint">Nothing yet — look a paper up above, or paste BibTeX into a <code>{BIB}</code> file.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {entries.map(e => (
                <div key={e.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: 'var(--bg-color)', borderRadius: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.title || e.key}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <code>@{e.key}</code>{e.author ? ' · ' + e.author.split(' and ')[0] + (e.author.includes(' and ') ? ' et al.' : '') : ''}{e.year ? ' · ' + e.year : ''}
                    </div>
                  </div>
                  <button className="btn-primary" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => { onCite(e.key); onClose(); }} title={`Insert @${e.key}`}>Cite</button>
                  <button className="btn-ghost" style={{ padding: '4px 8px', fontSize: 12, color: '#f87171', borderColor: 'rgba(239,68,68,0.3)' }} onClick={() => remove(e.key)}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
