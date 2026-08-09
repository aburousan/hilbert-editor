export type WorkspaceStatusTone = 'neutral' | 'progress' | 'success' | 'warning' | 'error';
export type WorkspaceStatusAction = 'problems' | 'collaboration';

export type WorkspaceStatus = {
  label: string;
  detail: string;
  tone: WorkspaceStatusTone;
  busy: boolean;
  action?: WorkspaceStatusAction;
};

export type WorkspaceStatusInput = {
  backendReady: boolean;
  hasDirty: boolean;
  activeSaves: number;
  recovery: 'idle' | 'saving' | 'saved' | 'failed';
  saveError?: string | null;
  externalConflict: boolean;
  isCompiling: boolean;
  compileStalled: boolean;
  compileError?: string | null;
  collaboration?: {
    status: 'connecting' | 'connected' | 'syncing' | 'synced' | 'disconnected' | 'error';
    peers: number;
    transferring: number;
  } | null;
};

const serviceFailure = (message?: string | null) =>
  !!message && /couldn.t reach|failed to fetch|networkerror|load failed|connection/i.test(message);

const collaboratorLabel = (peers: number) => {
  const others = Math.max(0, peers - 1);
  if (!others) return 'waiting for collaborators';
  return `${others} collaborator${others === 1 ? '' : 's'}`;
};

// One precedence table for every place that reports project safety. The first
// matching state wins, keeping a harmless compiler error from obscuring an
// unsaved buffer or a failed recovery copy.
export function deriveWorkspaceStatus(input: WorkspaceStatusInput): WorkspaceStatus {
  const collab = input.collaboration;
  if (!input.backendReady) return {
    label: 'Opening project…',
    detail: 'Hilbert is restoring the project and connecting to its document service.',
    tone: 'progress',
    busy: true,
  };
  if (input.externalConflict) return {
    label: 'Save needs attention',
    detail: 'This file also changed on disk. Choose which version to keep before Hilbert saves again.',
    tone: 'error',
    busy: false,
  };
  if (input.hasDirty && input.recovery === 'failed') return {
    label: 'Local recovery unavailable',
    detail: 'Changes remain in the editor, but Hilbert could not create its independent recovery copy. Keep this window open.',
    tone: 'error',
    busy: false,
  };
  if (input.activeSaves > 0) return {
    label: 'Saving to project…',
    detail: input.recovery === 'saved'
      ? 'Writing project changes to disk. An independent recovery copy is already stored on this device.'
      : 'Writing project changes to disk. The current text remains in the editor while the write completes.',
    tone: 'progress',
    busy: true,
  };
  if (input.hasDirty && input.saveError) return {
    label: input.recovery === 'saved' ? 'Save failed · recovery copy safe' : 'Save failed · changes pending',
    detail: input.saveError,
    tone: 'error',
    busy: false,
  };
  if (collab && (collab.status === 'disconnected' || collab.status === 'error')) return {
    label: input.hasDirty && input.recovery === 'saved'
      ? 'Offline · changes safe locally'
      : `Collaboration offline · ${input.hasDirty ? 'changes pending' : 'saved locally'}`,
    detail: 'The shared connection is unavailable. Local editing and saving continue, and Hilbert will keep trying to reconnect.',
    tone: 'warning',
    busy: false,
    action: 'collaboration',
  };
  if (collab?.transferring) return {
    label: `Receiving ${collab.transferring} ${collab.transferring === 1 ? 'file' : 'files'}…`,
    detail: `Synchronizing project files with ${collaboratorLabel(collab.peers)}.`,
    tone: 'progress',
    busy: true,
    action: 'collaboration',
  };
  if (collab?.status === 'connecting') return {
    label: 'Connecting collaboration…',
    detail: 'Local editing remains available while Hilbert connects to the shared session.',
    tone: 'progress',
    busy: true,
    action: 'collaboration',
  };
  if (collab?.status === 'syncing') return {
    label: 'Syncing project…',
    detail: `Bringing this local project up to date with ${collaboratorLabel(collab.peers)}.`,
    tone: 'progress',
    busy: true,
    action: 'collaboration',
  };
  if (input.hasDirty) {
    if (input.recovery === 'saving') return {
      label: 'Saving recovery copy…',
      detail: 'Changes are still in the editor while Hilbert stores an independent copy on this device.',
      tone: 'progress',
      busy: true,
    };
    if (input.recovery === 'saved') return {
      label: 'Changes safe on this device',
      detail: 'The project save is pending, and an independent recovery copy is stored locally.',
      tone: 'warning',
      busy: false,
    };
    return {
      label: 'Unsaved changes',
      detail: 'Changes are in the editor and are waiting to be saved to the project.',
      tone: 'warning',
      busy: false,
    };
  }
  if (input.isCompiling) return input.compileStalled ? {
    label: 'Saved · still compiling…',
    detail: 'Files are saved, but Typst is taking longer than expected. Editing and saving still work.',
    tone: 'warning',
    busy: true,
  } : {
    label: 'Saved · compiling…',
    detail: 'Project files are saved. Hilbert is updating the PDF preview.',
    tone: 'progress',
    busy: true,
  };
  if (input.compileError) return {
    label: serviceFailure(input.compileError) ? 'Saved locally · service offline' : 'Saved · preview has errors',
    detail: serviceFailure(input.compileError)
      ? 'Project files are saved locally, but the document service is unavailable. Hilbert will retry automatically.'
      : 'Project files are saved. The latest Typst compile has errors; the last good preview remains available.',
    tone: 'warning',
    busy: false,
    action: 'problems',
  };
  if (collab && (collab.status === 'connected' || collab.status === 'synced')) return {
    label: collab.peers > 1 ? `Synced with ${collaboratorLabel(collab.peers)}` : 'Saved · waiting for collaborators',
    detail: 'Project files are saved locally and the encrypted collaboration session is connected.',
    tone: 'success',
    busy: false,
    action: 'collaboration',
  };
  return {
    label: 'Saved locally',
    detail: 'All editor changes are saved in the project on this device.',
    tone: 'success',
    busy: false,
  };
}
