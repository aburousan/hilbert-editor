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
  stop: () => void;
  onPeers: (callback: (count: number) => void) => void;
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
  let stopped = false;
  let ready = false;
  let errorMessage = '';
  let currentStatus: CollabStatus = 'connecting';
  let peersCallback: ((count: number) => void) | null = null;
  let statusCallback: ((status: CollabStatus) => void) | null = null;
  let readyCallback: (() => void) | null = null;
  let errorCallback: ((message: string) => void) | null = null;

  const style = document.createElement('style');
  document.head.appendChild(style);

  const attachBinding = () => {
    if (!bindingTarget || stopped || (opts.mode === 'join' && !ready)) return;
    binding?.destroy();
    const { path, model, editor } = bindingTarget;
    binding = new MonacoBinding(workspace.textOf(path), model, new Set([editor]), provider.awareness);
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
    if (ready || stopped) return;
    ready = true;
    window.clearTimeout(connectTimer);
    readyCallback?.();
  };
  const emitError = (message: string) => {
    if (stopped || errorMessage) return;
    errorMessage = message;
    emitStatus('error');
    errorCallback?.(message);
    dispose(false);
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

  const emitPeers = () => peersCallback?.(provider.awareness.getStates().size);
  const onAwareness = ({ added = [] }: { added?: number[] } = {}) => {
    emitPeers();
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
  const connectTimer = window.setTimeout(() => {
    emitError(
      opts.mode === 'host'
        ? 'Could not reach the collaboration listener. Check the advertised address and firewall.'
        : 'The host was reached but no document synchronized. Check the invitation or ask the host to restart the session.',
    );
  }, timeoutMs);
  provider.connect();

  return {
    url: opts.invite.url,
    room: opts.invite.room,
    ticket: makeCollabTicket(opts.invite.url, opts.invite.room, opts.invite.key),
    workspace,
    bindFile: (path, model, editor) => {
      if (!path || !model || !editor) {
        bindingTarget = null;
        binding?.destroy();
        binding = null;
        return;
      }
      bindingTarget = { path, model, editor };
      attachBinding();
    },
    stop: () => dispose(true),
    onPeers: callback => {
      peersCallback = callback;
      emitPeers();
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
