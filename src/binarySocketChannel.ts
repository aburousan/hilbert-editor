import { encryptedWebSocketClass, type CollabInvite } from './collabProtocol';
import type { Frame, TransferChannel } from './binaryTransfer';

export type SocketTransferChannel = TransferChannel & {
  close: () => void;
};

export function createBinarySocketChannel(invite: CollabInvite): SocketTransferChannel {
  const Socket = encryptedWebSocketClass(invite.key);
  const url = `${invite.url.replace(/\/+$/, '')}/collab/${invite.room}-bin`;

  const subscribers = new Set<(frame: Frame) => void>();
  const queued: Uint8Array[] = [];
  const maxQueuedFrames = 256;
  const maxQueuedBytes = 4 * 1024 * 1024;
  let queuedBytes = 0;
  let closed = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  const sendNow = (target: WebSocket, frame: Uint8Array) => {
    const bytes = frame.slice();
    target.send(bytes.buffer);
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    const delay = Math.min(8000, 250 * 2 ** Math.min(reconnectAttempt++, 5));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    if (closed) return;
    const next = new Socket(url);
    socket = next;
    next.binaryType = 'arraybuffer';
    next.onopen = () => {
      if (closed || socket !== next) return;
      reconnectAttempt = 0;
      while (queued.length && next.readyState === WebSocket.OPEN) {
        const frame = queued.shift()!;
        queuedBytes -= frame.length;
        sendNow(next, frame);
      }
    };
    next.onmessage = event => {
      if (closed || socket !== next) return;
      const emit = (buffer: ArrayBuffer) => {
        if (closed || socket !== next) return;
        const frame = new Uint8Array(buffer);
        for (const subscriber of subscribers) subscriber(frame);
      };
      if (event.data instanceof ArrayBuffer) emit(event.data);
      else if (event.data instanceof Blob) void event.data.arrayBuffer().then(emit);
    };
    next.onerror = () => {
      if (!closed && socket === next && next.readyState < WebSocket.CLOSING) next.close();
    };
    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      scheduleReconnect();
    };
  };
  connect();

  const enqueue = (frame: Frame) => {
    if (frame.length > maxQueuedBytes) return;
    const copy = frame.slice();
    while (queued.length && (queued.length >= maxQueuedFrames || queuedBytes + copy.length > maxQueuedBytes)) {
      queuedBytes -= queued.shift()!.length;
    }
    queued.push(copy);
    queuedBytes += copy.length;
  };

  return {
    send(frame) {
      if (closed) return;
      if (socket?.readyState === WebSocket.OPEN) sendNow(socket, frame);
      else enqueue(frame);
    },
    subscribe(handler) {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    close() {
      if (closed) return;
      closed = true;
      queued.length = 0;
      queuedBytes = 0;
      subscribers.clear();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      socket?.close();
      socket = null;
    },
  };
}
