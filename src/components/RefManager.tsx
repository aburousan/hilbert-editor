import { useMemo } from 'react';

// ---------------------------------------------------------------------------
// Reference & label manager: lists every <label> and @reference in the current
// file, flags undefined references, duplicate labels and unused labels, and
// jumps to any of them. Pure view over the active document's text.
// ---------------------------------------------------------------------------

type Loc = { name: string; line: number };

function scan(content: string) {
  const labels: Loc[] = [];
  const refs: Loc[] = [];
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    // Ignore comment lines so example snippets don't create phantom entries.
    const code = line.replace(/\/\/.*$/, '');
    for (const m of code.matchAll(/<([a-zA-Z_][\w:.\-]*)>/g)) labels.push({ name: m[1], line: i + 1 });
    // Import/include lines carry "@preview/…" package specs, not references.
    const trimmed = code.trim();
    if (trimmed.startsWith('#import') || trimmed.startsWith('#include')) return;
    // A reference is @name — not an email (foo@bar) and not a package path
    // ("@preview/…"), so exclude a preceding word char/dot/quote/slash and a
    // trailing slash.
    for (const m of code.matchAll(/(^|[^\w.@/"])@([a-zA-Z_][\w:.\-]*)/g)) {
      if (code[(m.index ?? 0) + m[0].length] === '/') continue;
      refs.push({ name: m[2], line: i + 1 });
    }
  });
  return { labels, refs };
}

export default function RefManager({ content, onClose, onJump, onInsertRef }: {
  content: string;
  onClose: () => void;
  onJump: (line: number) => void;
  onInsertRef: (name: string) => void;
}) {
  const { labels, refs } = useMemo(() => scan(content), [content]);

  const labelNames = useMemo(() => new Set(labels.map(l => l.name)), [labels]);
  const refCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of refs) m.set(r.name, (m.get(r.name) || 0) + 1);
    return m;
  }, [refs]);
  const labelCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of labels) m.set(l.name, (m.get(l.name) || 0) + 1);
    return m;
  }, [labels]);

  const undefinedRefs = refs.filter(r => !labelNames.has(r.name));
  const duplicateLabels = labels.filter(l => (labelCount.get(l.name) || 0) > 1);
  const unusedLabels = labels.filter(l => !refCount.has(l.name) && !/^(sec|chap|part|app):/.test(l.name));

  const jump = (line: number) => { onJump(line); onClose(); };

  const warn = (label: string, items: Loc[], color: string) => items.length > 0 && (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color, marginBottom: 4 }}>{label} ({items.length})</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {items.map((it, i) => (
          <button key={i} className="btn-ghost" style={{ padding: '3px 8px', fontSize: 12, borderColor: color, color }} onClick={() => jump(it.line)} title={`Go to line ${it.line}`}>
            {it.name} <span style={{ opacity: 0.6 }}>:{it.line}</span>
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ width: '560px', maxHeight: '85vh' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>References &amp; Labels</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body" style={{ overflowY: 'auto' }}>
          {undefinedRefs.length === 0 && duplicateLabels.length === 0 && unusedLabels.length === 0 ? (
            <div className="form-hint" style={{ color: '#4ade80' }}>✓ No issues — every reference resolves and every label is unique.</div>
          ) : (
            <div style={{ background: 'var(--bg-color)', borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
              {warn('⚠ Undefined references (no matching label)', undefinedRefs, '#f87171')}
              {warn('⚠ Duplicate labels', duplicateLabels, '#fbbf24')}
              {warn('○ Unused labels (never referenced)', unusedLabels, '#94a3b8')}
            </div>
          )}

          <div className="form-field" style={{ marginBottom: 4 }}><span>Labels ({labels.length})</span></div>
          {labels.length === 0 ? <div className="form-hint">No labels in this file yet.</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 14 }}>
              {labels.map((l, i) => {
                const n = refCount.get(l.name) || 0;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 4, fontSize: 13 }} className="ref-row">
                    <code style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>&lt;{l.name}&gt;</code>
                    <span style={{ fontSize: 11, color: n ? '#4ade80' : '#94a3b8' }}>{n} ref{n === 1 ? '' : 's'}</span>
                    <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => jump(l.line)}>:{l.line}</button>
                    <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => { onInsertRef(l.name); onClose(); }} title="Insert @reference to this label">@ cite</button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="form-field" style={{ marginBottom: 4 }}><span>References ({refs.length})</span></div>
          {refs.length === 0 ? <div className="form-hint">No @references in this file yet.</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {refs.map((r, i) => {
                const ok = labelNames.has(r.name);
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 4, fontSize: 13 }} className="ref-row">
                    <code style={{ flex: 1, minWidth: 0, color: ok ? undefined : '#f87171' }}>@{r.name}</code>
                    {!ok && <span style={{ fontSize: 11, color: '#f87171' }}>undefined</span>}
                    <button className="btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => jump(r.line)}>:{r.line}</button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
