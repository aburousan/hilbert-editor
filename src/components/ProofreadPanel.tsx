// Sidebar panel listing proofreading issues (spelling / grammar / style) from
// the Tauri backend. Click a row to jump; click a suggestion chip to apply it;
// "Ignore" adds a misspelling to the personal dictionary.
import type { PlacedIssue, ProofKind } from '../proofread';

const KIND_COLOR: Record<ProofKind, string> = {
  spelling: '#f87171', // red
  grammar: '#fbbf24',  // amber
  style: '#60a5fa',    // blue
};

const KIND_LABEL: Record<ProofKind, string> = {
  spelling: 'Spelling',
  grammar: 'Grammar',
  style: 'Style',
};

interface Props {
  issues: PlacedIssue[];
  busy: boolean;
  onJump(i: PlacedIssue): void;
  onApply(i: PlacedIssue, replacement: string): void;
  onIgnore(i: PlacedIssue): void;
}

export default function ProofreadPanel({ issues, busy, onJump, onApply, onIgnore }: Props) {
  const counts = issues.reduce(
    (acc, i) => { acc[i.kind]++; return acc; },
    { spelling: 0, grammar: 0, style: 0 } as Record<ProofKind, number>,
  );

  return (
    <div
      className="sidebar-section proofread-section"
      style={{ flex: 'none', maxHeight: '42%', display: 'flex', flexDirection: 'column', borderTop: '1px solid var(--border-color)' }}
    >
      <div
        className="sidebar-header"
        style={{
          padding: '6px 14px', background: 'var(--panel-bg)', fontSize: '0.68rem', fontWeight: 600,
          letterSpacing: '0.07em', textTransform: 'uppercase', opacity: 0.85, color: 'var(--text-muted)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Proofread
          {busy && <span className="status-dot compiling" title="Checking…" style={{ width: 7, height: 7 }} />}
        </span>
        {issues.length > 0 && (
          <span style={{ display: 'flex', gap: 6 }}>
            {(['spelling', 'grammar', 'style'] as ProofKind[]).map((k) =>
              counts[k] > 0 ? (
                <span key={k} title={KIND_LABEL[k]} style={{
                  fontSize: '0.62rem', fontWeight: 700, color: KIND_COLOR[k],
                  border: `1px solid ${KIND_COLOR[k]}`, borderRadius: 8, padding: '0 6px', lineHeight: '15px',
                }}>{counts[k]}</span>
              ) : null,
            )}
          </span>
        )}
      </div>

      <div className="proofread-list" style={{ overflowY: 'auto', padding: '6px' }}>
        {issues.length === 0 ? (
          <div style={{ padding: '10px 12px', fontSize: '0.78rem', color: 'var(--text-muted)', opacity: 0.8 }}>
            {busy ? 'Checking…' : 'No issues — reads clean.'}
          </div>
        ) : (
          issues.map((i, idx) => (
            <div
              key={idx}
              className="proofread-item"
              style={{ padding: '7px 9px', borderRadius: 6, marginBottom: 4, cursor: 'pointer', background: 'var(--panel-bg)' }}
              onClick={() => onJump(i)}
              title={`Line ${i.range.startLineNumber} — click to jump`}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: KIND_COLOR[i.kind], flex: 'none', transform: 'translateY(1px)' }} />
                <span style={{ fontSize: '0.8rem', lineHeight: 1.35, color: 'var(--text-color)' }}>{i.message}</span>
              </div>
              {(i.suggestions.length > 0 || i.kind === 'spelling') && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6, marginLeft: 14 }}>
                  {i.suggestions.map((s, si) => (
                    <button
                      key={si}
                      className="proofread-fix"
                      onClick={(e) => { e.stopPropagation(); onApply(i, s); }}
                      style={{
                        fontSize: '0.72rem', padding: '1px 8px', borderRadius: 10, cursor: 'pointer',
                        border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-color)',
                      }}
                    >
                      {s === '' ? 'Delete' : s}
                    </button>
                  ))}
                  {i.kind === 'spelling' && (
                    <button
                      className="proofread-ignore"
                      onClick={(e) => { e.stopPropagation(); onIgnore(i); }}
                      title="Add to your personal dictionary"
                      style={{
                        fontSize: '0.72rem', padding: '1px 8px', borderRadius: 10, cursor: 'pointer',
                        border: '1px dashed var(--border-color)', background: 'transparent', color: 'var(--text-muted)',
                      }}
                    >
                      + Dictionary
                    </button>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
