import { useEffect } from 'react';
import type { DraftDiskState, EmergencyDraft } from '../emergencyDrafts';

export type RecoveryConflict = { draft: EmergencyDraft; disk: DraftDiskState };

type Props = {
  conflicts: RecoveryConflict[];
  onRecover: (conflict: RecoveryConflict) => void;
  onUseServer: (conflict: RecoveryConflict) => void;
  onClose: () => void;
};

export default function RecoveryDraftModal({ conflicts, onRecover, onUseServer, onClose }: Props) {
  const conflict = conflicts[0];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!conflict) return null;
  const { draft } = conflict;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <section className="modal-content recovery-draft-modal" role="dialog" aria-modal="true" aria-labelledby="recovery-draft-title" onClick={event => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2 id="recovery-draft-title">Local Recovery Copy Found</h2>
            <p>{conflicts.length > 1 ? `${conflicts.length} files need review` : 'The server copy changed separately'}</p>
          </div>
          <button type="button" className="tab-close" aria-label="Decide later" onClick={onClose}>×</button>
        </div>
        <div className="recovery-draft-body">
          <strong>{draft.path}</strong>
          <p>
            Hilbert kept edits from {new Date(draft.savedAt).toLocaleString()} on this device,
            but the server now has a different version. Nothing has been overwritten.
          </p>
          <div className="recovery-draft-stats">
            <span>Local recovery: {draft.content.length.toLocaleString()} characters</span>
            <span>Server: {conflict.disk.content.length.toLocaleString()} characters</span>
          </div>
        </div>
        <div className="recovery-draft-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>Decide later</button>
          <button type="button" className="btn-ghost" onClick={() => onUseServer(conflict)}>Use server copy</button>
          <button type="button" className="btn-primary" onClick={() => onRecover(conflict)}>Open recovered edits</button>
        </div>
      </section>
    </div>
  );
}
