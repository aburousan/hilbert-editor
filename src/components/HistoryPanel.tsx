import { useEffect, useMemo, useRef, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';

export type HistoryVersion = {
  id: string;
  timestamp: number;
  path: string;
  content: string;
  kind?: 'save' | 'auto' | 'before-restore';
};

type Props = {
  path: string;
  versions: HistoryVersion[];
  /** The file as it is now, which each version is compared against. */
  current: string;
  theme: string;
  saveKeys: string;
  onRestore: (version: HistoryVersion) => void;
  onClose: () => void;
};

const how = (version: HistoryVersion, saveKeys: string) =>
  version.kind === 'auto' ? 'kept automatically'
    : version.kind === 'before-restore' ? 'kept before a restore'
      : `saved with ${saveKeys}`;

// A version is chosen by looking at it first: what it holds, set against the
// file as it stands, with the unchanged stretches folded away. Restoring used to
// be a click on a timestamp and a yes to "are you sure?", which is a question
// nobody can answer without seeing what they would get.
export default function HistoryPanel({ path, versions, current, theme, saveKeys, onRestore, onClose }: Props) {
  const newestFirst = useMemo(() => [...versions].reverse(), [versions]);
  const [chosenId, setChosenId] = useState(newestFirst[0]?.id ?? '');
  const chosen = newestFirst.find(v => v.id === chosenId) ?? newestFirst[0];
  const [counts, setCounts] = useState<{ added: number; removed: number } | null>(null);
  const diffRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1100);

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 1100);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      // Up and down walk the list while the diff is on screen.
      const index = newestFirst.findIndex(v => v.id === chosen?.id);
      const next = newestFirst[index + (e.key === 'ArrowDown' ? 1 : -1)];
      if (next) { e.preventDefault(); setChosenId(next.id); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [newestFirst, chosen, onClose]);

  useEffect(() => { setCounts(null); }, [chosen?.id, current]);

  const measure = () => {
    const changes = diffRef.current?.getLineChanges();
    if (!changes) return;
    let added = 0, removed = 0;
    for (const change of changes) {
      // An end of 0 means no lines on that side: a pure insertion or deletion.
      if (change.modifiedEndLineNumber) added += change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
      if (change.originalEndLineNumber) removed += change.originalEndLineNumber - change.originalStartLineNumber + 1;
    }
    setCounts({ added, removed });
  };

  const same = chosen ? chosen.content === current : false;
  const language = path.endsWith('.typ') ? 'typst' : 'plaintext';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content history-panel" onClick={e => e.stopPropagation()}
        style={{ width: 'min(1180px, 94vw)', maxWidth: '94vw', height: 'min(760px, 88vh)', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header">
          <h2>File History</h2>
          <button className="tab-close" style={{ fontSize: '24px', cursor: 'pointer' }} onClick={onClose}>×</button>
        </div>
        {!chosen ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '13px', textAlign: 'center', padding: '40px 10px' }}>
            No history for {path} yet.<br />Save the file ({saveKeys}) to keep a version.
          </div>
        ) : (
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <div className="history-list" style={{ width: 230, flexShrink: 0, overflowY: 'auto', borderRight: '1px solid var(--border-color)' }}>
              {newestFirst.map(version => (
                <div key={version.id} className="history-item" onClick={() => setChosenId(version.id)}
                  style={{
                    padding: '10px 12px', borderBottom: '1px solid var(--border-color)', cursor: 'pointer',
                    background: version.id === chosen.id ? 'var(--hover-color)' : undefined,
                    borderLeft: `3px solid ${version.id === chosen.id ? 'var(--accent)' : 'transparent'}`,
                  }}>
                  <div style={{ fontSize: '13px' }}>{new Date(version.timestamp).toLocaleString()}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2 }}>{how(version, saveKeys)}</div>
                </div>
              ))}
            </div>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: '1px solid var(--border-color)', fontSize: '12px' }}>
                <span style={{ color: 'var(--text-muted)', flex: 1, minWidth: 0 }}>
                  {narrow ? 'This version against the file now' : 'Left: this version. Right: the file now.'}
                  {same ? ' — identical.' : counts && (
                    <> — <span style={{ color: '#3fb950' }}>{counts.added} line{counts.added === 1 ? '' : 's'} added</span>,{' '}
                      <span style={{ color: '#f85149' }}>{counts.removed} removed</span> since then.</>
                  )}
                </span>
                <button className="btn-primary" disabled={same} onClick={() => onRestore(chosen)}
                  title="The file as it is now is kept as a version first, so this can be undone from here.">
                  Restore this version
                </button>
              </div>
              <div style={{ flex: 1, minHeight: 0 }}>
                <DiffEditor
                  original={chosen.content}
                  modified={current}
                  language={language}
                  theme={theme}
                  // Their own models, so nothing here touches the file's editor.
                  originalModelPath={`inmemory://history/original/${path}`}
                  modifiedModelPath={`inmemory://history/current/${path}`}
                  onMount={diffEditor => {
                    diffRef.current = diffEditor;
                    diffEditor.onDidUpdateDiff(measure);
                  }}
                  options={{
                    readOnly: true,
                    originalEditable: false,
                    renderSideBySide: !narrow,
                    automaticLayout: true,
                    minimap: { enabled: false },
                    wordWrap: 'on',
                    diffWordWrap: 'on',
                    scrollBeyondLastLine: false,
                    hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5 },
                    fontSize: 13,
                  }}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
