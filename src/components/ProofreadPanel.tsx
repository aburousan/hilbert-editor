// Sidebar panel listing proofreading issues (spelling / grammar / style) from
// the Tauri backend. Click a row to jump; click a suggestion chip to apply it;
// "Ignore" puts an issue aside for this session, "+ Dictionary" for good.
//
// The same complaint about the same word tends to arrive several times over —
// a word used five times is flagged five times — so identical issues are shown
// as one row with a count, and acting on the row acts on all of them.
import { useState } from 'react';
import type { PlacedIssue, ProofKind, Reading } from '../proofread';
import { dismissKey } from '../proofread';

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

interface Group {
  key: string;
  head: PlacedIssue;
  all: PlacedIssue[];
}

// Identical issues, in the order they appear in the document. The key is the
// one "Ignore" uses, so what the row shows and what the button hides are the
// same set of things.
function group(issues: PlacedIssue[]): Group[] {
  const byKey = new Map<string, Group>();
  for (const issue of issues) {
    const key = dismissKey(issue);
    const seen = byKey.get(key);
    if (seen) seen.all.push(issue);
    else byKey.set(key, { key, head: issue, all: [issue] });
  }
  return Array.from(byKey.values());
}

interface Props {
  issues: PlacedIssue[];
  busy: boolean;
  checked: boolean;
  reading: Reading | null;
  dismissedCount: number;
  onJump(i: PlacedIssue): void;
  onApply(i: PlacedIssue, replacement: string): void;
  onApplyAll(issues: PlacedIssue[], replacement: string): void;
  onIgnore(i: PlacedIssue): void;
  onDismiss(i: PlacedIssue): void;
  onRestore(): void;
  onManageDictionaries(search?: string): void;
}

export default function ProofreadPanel({
  issues, busy, checked, reading, dismissedCount,
  onJump, onApply, onApplyAll, onIgnore, onDismiss, onRestore, onManageDictionaries,
}: Props) {
  // Which occurrence of a repeated issue the next click should go to.
  const [cursor, setCursor] = useState<Record<string, number>>({});

  const counts = issues.reduce(
    (acc, i) => { acc[i.kind]++; return acc; },
    { spelling: 0, grammar: 0, style: 0 } as Record<ProofKind, number>,
  );
  const groups = group(issues);

  const chip: React.CSSProperties = {
    fontSize: '0.72rem', padding: '1px 8px', borderRadius: 10, cursor: 'pointer',
    border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--text-color)',
  };
  const faintChip: React.CSSProperties = {
    ...chip, border: '1px dashed var(--border-color)', color: 'var(--text-muted)',
  };

  const getStyle: React.CSSProperties = { ...chip, padding: '0 7px', marginLeft: 2 };

  const step = (g: Group) => {
    const at = (cursor[g.key] || 0) % g.all.length;
    onJump(g.all[at]);
    setCursor((c) => ({ ...c, [g.key]: (at + 1) % g.all.length }));
  };
  const focused = (g: Group) => g.all[(cursor[g.key] || 0) % g.all.length];

  // Nothing installed can read this document's language, so no word in it has
  // been looked at. Say so — silence here reads as "your spelling is perfect".
  const noDictionary = reading && !reading.dictionary;
  const languageName = reading?.languageName || reading?.lang;

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
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {dismissedCount > 0 && (
            <button
              onClick={onRestore}
              title="Bring back everything you have ignored in this session"
              style={{
                background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                font: 'inherit', color: 'var(--text-muted)', textTransform: 'none', letterSpacing: 0,
                textDecoration: 'underline', textUnderlineOffset: 2, whiteSpace: 'nowrap',
              }}
            >
              {dismissedCount} ignored
            </button>
          )}
          {(['spelling', 'grammar', 'style'] as ProofKind[]).map((k) =>
            counts[k] > 0 ? (
              <span key={k} title={KIND_LABEL[k]} style={{
                fontSize: '0.62rem', fontWeight: 700, color: KIND_COLOR[k],
                border: `1px solid ${KIND_COLOR[k]}`, borderRadius: 8, padding: '0 6px', lineHeight: '15px',
              }}>{counts[k]}</span>
            ) : null,
          )}
        </span>
      </div>

      {reading && (noDictionary || reading.wanted || !reading.grammar) && (
        <div style={{
          padding: '7px 12px', fontSize: '0.74rem', lineHeight: 1.45, color: 'var(--text-muted)',
          borderBottom: '1px solid var(--border-color)', background: 'var(--panel-bg)',
        }}>
          {noDictionary ? (
            <>
              No {languageName} dictionary, so spelling is not being checked.{' '}
              <button onClick={() => onManageDictionaries(languageName || '')} style={getStyle}>Get one</button>
            </>
          ) : reading.wanted ? (
            <>
              Reading this as {reading.dictionaryName}; the document asks for {reading.wanted.name}.{' '}
              <button onClick={() => onManageDictionaries(reading.wanted!.code)} style={getStyle}>Get it</button>
            </>
          ) : (
            <>Checking {languageName} spelling. Grammar and style are English only.</>
          )}
        </div>
      )}

      <div className="proofread-list" style={{ overflowY: 'auto', padding: '6px' }}>
        {groups.length === 0 ? (
          // With no dictionary the notice above has already said what is going
          // on; a second line underneath it would only repeat itself.
          noDictionary ? null : (
            <div style={{ padding: '10px 12px', fontSize: '0.78rem', color: 'var(--text-muted)', opacity: 0.8 }}>
              {busy ? 'Checking…' : checked ? 'No issues — reads clean.' : 'Not checked yet.'}
            </div>
          )
        ) : (
          groups.map((g) => {
            const i = g.head;
            const here = focused(g);
            const many = g.all.length > 1;
            return (
              <div
                key={g.key}
                className="proofread-item"
                style={{ padding: '7px 9px', borderRadius: 6, marginBottom: 4, cursor: 'pointer', background: 'var(--panel-bg)' }}
                onClick={() => step(g)}
                title={many
                  ? `${g.all.length} places — click to visit each in turn`
                  : `Line ${i.range.startLineNumber} — click to jump`}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: KIND_COLOR[i.kind], flex: 'none', transform: 'translateY(1px)' }} />
                  <span style={{ fontSize: '0.8rem', lineHeight: 1.35, color: 'var(--text-color)', flex: 1 }}>{i.message}</span>
                  {many && (
                    <span
                      title={`Appears ${g.all.length} times`}
                      style={{
                        fontSize: '0.66rem', fontWeight: 700, color: 'var(--text-muted)',
                        border: '1px solid var(--border-color)', borderRadius: 8, padding: '0 5px', flex: 'none',
                      }}
                    >
                      ×{g.all.length}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6, marginLeft: 14 }}>
                  {i.suggestions.map((s, si) => (
                    <button
                      key={si}
                      className="proofread-fix"
                      onClick={(e) => { e.stopPropagation(); onApply(here, s); }}
                      title={many ? `Change this one (line ${here.range.startLineNumber})` : undefined}
                      style={chip}
                    >
                      {s === '' ? 'Delete' : s}
                    </button>
                  ))}
                  {many && i.suggestions.length > 0 && (
                    <button
                      className="proofread-fix"
                      onClick={(e) => { e.stopPropagation(); onApplyAll(g.all, i.suggestions[0]); }}
                      title={`Change all ${g.all.length}`}
                      style={chip}
                    >
                      {i.suggestions[0] === '' ? `Delete all ${g.all.length}` : `All → ${i.suggestions[0]}`}
                    </button>
                  )}
                  <button
                    className="proofread-ignore"
                    onClick={(e) => { e.stopPropagation(); onDismiss(i); }}
                    title={many ? `Hide all ${g.all.length} for this session` : 'Hide this for this session'}
                    style={faintChip}
                  >
                    Ignore
                  </button>
                  {i.kind === 'spelling' && (
                    <button
                      className="proofread-ignore"
                      onClick={(e) => { e.stopPropagation(); onIgnore(i); }}
                      title="Add to your personal dictionary, for good"
                      style={faintChip}
                    >
                      + Dictionary
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
