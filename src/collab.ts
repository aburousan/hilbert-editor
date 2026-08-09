// Real-time collaboration on one open file. Yjs is the shared source of truth,
// MonacoBinding applies CRDT edits in both directions, and awareness carries
// live cursors. Network frames are encrypted before reaching the relay.
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { MonacoBinding } from 'y-monaco';
import {
  encryptedWebSocketClass,
  makeCollabTicket,
  type CollabInvite,
} from './collabProtocol';
import { WorkspaceModel } from './workspaceSync';

export type { CollabInvite } from './collabProtocol';
export {
  makeCollabTicket,
  newCollabSession,
  normalizeCollabServerUrl,
  parseCollabTicket,
} from './collabProtocol';

export type CollabUser = { name: string; color: string };
export type CollabStatus = 'connecting' | 'connected' | 'syncing' | 'synced' | 'disconnected' | 'error';

export type CollabHandle = {
  url: string;
  room: string;
  ticket: string;
  workspace: WorkspaceModel;
  bindFile: (path: string | null, model?: any, editor?: any) => void;
  reconnect: () => void;
  stop: () => void;
  onPeers: (callback: (count: number) => void) => void;
  onUsers: (callback: (users: CollabUser[]) => void) => void;
  onStatus: (callback: (status: CollabStatus) => void) => void;
  onReady: (callback: () => void) => void;
  onError: (callback: (message: string) => void) => void;
};

export function startCollab(opts: {
  invite: CollabInvite;
  mode: 'host' | 'join';
  user: CollabUser;
  initialFile?: {
    path: string;
    model: any;
    editor: any;
    content: string;
  };
  timeoutMs?: number;
}): CollabHandle {
  const ydoc = new Y.Doc();
  const workspace = new WorkspaceModel(ydoc);
  if (opts.mode === 'host' && opts.initialFile) {
    workspace.setText(opts.initialFile.path, opts.initialFile.content);
  }

  const base = opts.invite.url.replace(/\/+$/, '') + '/collab';
  const provider = new WebsocketProvider(base, opts.invite.room, ydoc, {
    // Register lifecycle handlers and the timeout before opening the socket.
    // A loopback listener can connect during this function's initialization.
    connect: false,
    WebSocketPolyfill: encryptedWebSocketClass(opts.invite.key),
    // The relay may drop frames under pressure and never answers a sync
    // request itself, so ask the room for a fresh sync step periodically —
    // this heals a lost update and a joiner that raced a host reconnect. Kept
    // short so a burst of edits or deletes that outran the relay's buffer
    // reconciles within a few seconds rather than lingering out of sync.
    resyncInterval: 5000,
    // Keep every byte on the encrypted socket; the same-origin
    // BroadcastChannel side path would bypass the AES-GCM wrapper.
    disableBc: true,
  });
  provider.awareness.setLocalStateField('user', opts.user);

  let binding: MonacoBinding | null = null;
  let bindingTarget: { path: string; model: any; editor: any } | null = opts.initialFile
    ? { path: opts.initialFile.path, model: opts.initialFile.model, editor: opts.initialFile.editor }
    : null;
  // Where the caret sits, anchored to the shared text rather than to a line
  // number. Looking at an image or a PDF tears the editor down and throws the
  // buffer away, so coming back builds a new one — and by then collaborators
  // have moved the text, which makes the line the caret used to be on the wrong
  // line to return to. A position anchored to the characters themselves is
  // still right however much was written above it in the meantime.
  let parkedCaret: { text: Y.Text; at: Y.RelativePosition } | null = null;
  let caretWatcher: { dispose: () => void } | null = null;
  let stopped = false;
  let ready = false;
  let errorMessage = '';
  let currentStatus: CollabStatus = 'connecting';
  let peersCallback: ((count: number) => void) | null = null;
  let usersCallback: ((users: CollabUser[]) => void) | null = null;
  let statusCallback: ((status: CollabStatus) => void) | null = null;
  let readyCallback: (() => void) | null = null;
  let errorCallback: ((message: string) => void) | null = null;

  const style = document.createElement('style');
  document.head.appendChild(style);

  // Bring a buffer up to the shared text by editing only the stretch that
  // actually differs.
  //
  // MonacoBinding does this for us, but it does it by replacing the buffer whole
  // — and Monaco treats a wholesale replacement as a flush, which throws away
  // its cursors and starts a new one at line 1. That is the caret jumping to the
  // top of the file, and it happens on every rebind: switching tabs, coming back
  // from an image, a session reconnecting. An ordinary edit instead carries the
  // caret along the way any other edit does, and leaves the binding with nothing
  // to replace.
  const reconcile = (model: any, text: string) => {
    const current = model.getValue();
    if (current === text) return;
    const shorter = Math.min(current.length, text.length);
    let head = 0;
    while (head < shorter && current[head] === text[head]) head++;
    let tail = 0;
    while (tail < shorter - head
      && current[current.length - 1 - tail] === text[text.length - 1 - tail]) tail++;
    const from = model.getPositionAt(head);
    const to = model.getPositionAt(current.length - tail);
    model.applyEdits([{
      range: {
        startLineNumber: from.lineNumber,
        startColumn: from.column,
        endLineNumber: to.lineNumber,
        endColumn: to.column,
      },
      text: text.slice(head, text.length - tail),
    }]);
  };

  const attachBinding = () => {
    if (!bindingTarget || stopped || (opts.mode === 'join' && !ready)) return;
    binding?.destroy();
    const { path, model, editor } = bindingTarget;
    // Seed from the buffer being bound: if the session has not got this path yet
    // — a file only this peer holds, or one whose publish is still in flight —
    // binding to an empty placeholder would both blank the editor and leave a
    // shared empty Y.Text for two peers to fill at once. See WorkspaceModel.textOf.
    const shared = workspace.textOf(path, model.getValue());
    reconcile(model, shared.toString());
    binding = new MonacoBinding(shared, model, new Set([editor]), provider.awareness);

    // Put the caret back where its text ended up. Only for the file it was
    // parked in: binding a different one leaves that file's caret alone until
    // we come back to it.
    if (parkedCaret?.text === shared) {
      const at = Y.createAbsolutePositionFromRelativePosition(parkedCaret.at, ydoc);
      if (at && at.type === shared) {
        const position = model.getPositionAt(at.index);
        editor.setPosition(position);
        editor.revealPositionInCenterIfOutsideViewport(position);
      }
    }
    caretWatcher?.dispose();
    caretWatcher = editor.onDidChangeCursorPosition(() => {
      if (editor.getModel() !== model) return;
      parkedCaret = {
        text: shared,
        at: Y.createRelativePositionFromTypeIndex(shared, model.getOffsetAt(editor.getPosition())),
      };
    });
  };

  // A host owns the initial document and can bind immediately. A joiner must
  // wait for a real Yjs sync response; binding an empty Y.Text sooner would
  // replace the user's open document with an empty string.
  if (opts.mode === 'host') attachBinding();

  const emitStatus = (status: CollabStatus) => {
    currentStatus = status;
    statusCallback?.(status);
  };
  const emitReady = () => {
    if (stopped) return;
    window.clearTimeout(connectTimer);
    if (ready) return;
    ready = true;
    readyCallback?.();
  };
  const emitError = (message: string) => {
    if (stopped) return;
    errorMessage = message;
    emitStatus('error');
    errorCallback?.(message);
  };

  const paintCursors = () => {
    let css = '';
    provider.awareness.getStates().forEach((state: any, id: number) => {
      if (id === ydoc.clientID || !state?.user) return;
      const claimedColor = String(state.user.color || '');
      const color = /^#[0-9a-f]{6}$/i.test(claimedColor) ? claimedColor : '#f59e0b';
      const name = String(state.user.name || 'Guest')
        .replace(/["\\<>{};\r\n]/g, '')
        .slice(0, 48);
      css += `.yRemoteSelection-${id}{background-color:${color}55;}` +
        `.yRemoteSelectionHead-${id}{position:relative;border-left:${color} solid 2px;box-sizing:border-box;}` +
        `.yRemoteSelectionHead-${id}::after{content:"${name}";position:absolute;top:-1.15em;left:-2px;` +
        `font:600 11px/1 system-ui,sans-serif;white-space:nowrap;padding:1px 4px;border-radius:3px;` +
        `background:${color};color:#fff;z-index:20;pointer-events:none;}`;
    });
    style.textContent = css;
  };

  const currentUsers = (): CollabUser[] => {
    const users: CollabUser[] = [];
    provider.awareness.getStates().forEach((state: any) => {
      if (!state?.user || users.length >= 32) return;
      const name = String(state.user.name || 'Guest').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48) || 'Guest';
      const claimed = String(state.user.color || '');
      const color = /^#[0-9a-f]{6}$/i.test(claimed) ? claimed : '#f59e0b';
      users.push({ name, color });
    });
    return users;
  };
  const emitPresence = () => {
    peersCallback?.(provider.awareness.getStates().size);
    usersCallback?.(currentUsers());
  };
  const onAwareness = ({ added = [] }: { added?: number[] } = {}) => {
    emitPresence();
    paintCursors();
    // The content-blind relay retains no awareness state. Everyone replies
    // once when a collaborator appears, so a newcomer sees every existing
    // cursor immediately instead of waiting for the periodic presence
    // refresh. A reply arrives at the newcomer as an update, not another
    // addition, so the exchange settles after one round.
    if (added.some(id => id !== ydoc.clientID)) {
      provider.awareness.setLocalStateField('user', opts.user);
    }
  };
  let downgradeTimer = 0;
  const onStatus = (event: { status: 'connecting' | 'connected' | 'disconnected' }) => {
    if (stopped) return;
    if (event.status === 'connected') {
      errorMessage = '';
      if (ready || opts.mode === 'host') window.clearTimeout(connectTimer);
      window.clearTimeout(downgradeTimer);
      emitStatus(opts.mode === 'host' ? 'connected' : 'syncing');
      if (opts.mode === 'host') emitReady();
    } else if (ready && (currentStatus === 'connected' || currentStatus === 'synced')) {
      // A peer alone in a room receives nothing through the relay, so
      // y-websocket drops and reopens the socket every 30 s as a liveness
      // check. That reconnect completes in well under a second; only report
      // a downgrade that persists.
      window.clearTimeout(downgradeTimer);
      downgradeTimer = window.setTimeout(() => {
        if (!stopped) emitStatus(event.status);
      }, 3000);
    } else {
      emitStatus(event.status);
    }
  };
  const onSync = (synced: boolean) => {
    if (!synced || stopped || opts.mode !== 'join') return;
    // Mark the joiner ready before attaching: attachBinding deliberately
    // refuses to bind an empty pre-sync document.
    emitReady();
    attachBinding();
    emitStatus('synced');
  };
  const onConnectionError = () => {
    if (!stopped && currentStatus !== 'connecting') emitStatus('connecting');
  };

  provider.awareness.on('change', onAwareness);
  provider.on('status', onStatus);
  provider.on('sync', onSync);
  provider.on('connection-error', onConnectionError);
  paintCursors();

  const dispose = (announceDisconnected: boolean) => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(connectTimer);
    window.clearTimeout(downgradeTimer);
    provider.awareness.off('change', onAwareness);
    provider.off('status', onStatus);
    provider.off('sync', onSync);
    provider.off('connection-error', onConnectionError);
    // Announce the departure so peers drop this cursor now rather than after
    // the 30 s awareness timeout; the socket wrapper flushes queued frames
    // before the connection closes underneath it.
    try { provider.awareness.setLocalState(null); } catch { /* already closed */ }
    caretWatcher?.dispose();
    caretWatcher = null;
    binding?.destroy();
    provider.destroy();
    ydoc.destroy();
    style.remove();
    if (announceDisconnected) {
      currentStatus = 'disconnected';
      statusCallback?.('disconnected');
    }
  };

  const timeoutMs = opts.timeoutMs ?? (opts.mode === 'host' ? 8000 : 12000);
  let connectTimer = 0;
  const armConnectTimer = () => {
    window.clearTimeout(connectTimer);
    connectTimer = window.setTimeout(() => {
      emitError(
        ready
          ? 'The collaboration connection is still unavailable. Hilbert will keep trying; you can also retry now.'
          : opts.mode === 'host'
            ? 'Could not reach the collaboration listener. Check the advertised address and firewall, then retry.'
            : 'The server was reached but no project synchronized. Check the invitation or ask the host, then retry.',
      );
    }, timeoutMs);
  };
  armConnectTimer();
  provider.connect();

  return {
    url: opts.invite.url,
    room: opts.invite.room,
    ticket: makeCollabTicket(opts.invite.url, opts.invite.room, opts.invite.key),
    workspace,
    bindFile: (path, model, editor) => {
      if (!path || !model || !editor) {
        bindingTarget = null;
        // parkedCaret deliberately survives: it is what puts the caret back when
        // this file comes into view again.
        caretWatcher?.dispose();
        caretWatcher = null;
        binding?.destroy();
        binding = null;
        return;
      }
      bindingTarget = { path, model, editor };
      attachBinding();
    },
    reconnect: () => {
      if (stopped) return;
      errorMessage = '';
      emitStatus('connecting');
      armConnectTimer();
      provider.disconnect();
      provider.connect();
    },
    stop: () => dispose(true),
    onPeers: callback => {
      peersCallback = callback;
      emitPresence();
    },
    onUsers: callback => {
      usersCallback = callback;
      callback(currentUsers());
    },
    onStatus: callback => {
      statusCallback = callback;
      callback(currentStatus);
    },
    onReady: callback => {
      readyCallback = callback;
      if (ready) callback();
    },
    onError: callback => {
      errorCallback = callback;
      if (errorMessage) callback(errorMessage);
    },
  };
}
