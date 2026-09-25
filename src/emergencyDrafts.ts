export type EmergencyDraft = {
  key: string;
  workspace: string;
  path: string;
  content: string;
  diskHash?: string;
  savedAt: number;
};

export type DraftDiskState = { content: string; hash?: string };
export type DraftDisposition = 'already-saved' | 'safe-to-replay' | 'conflict';

const DB_NAME = 'hilbert-recovery';
const DB_VERSION = 1;
const STORE = 'drafts';
const FALLBACK_PREFIX = 'hilbert_emergency_draft_v1:';

const draftKey = (workspace: string, path: string) => `${workspace}\u0000${path}`;

// Always later than the last one, even if the clock is set back meanwhile: the
// backend keeps whichever copy has the later time, so time must only go forward.
let lastSavedAt = 0;

export function createEmergencyDraft(
  workspace: string,
  path: string,
  content: string,
  diskHash?: string,
  savedAt = Math.max(Date.now(), lastSavedAt + 1),
): EmergencyDraft {
  lastSavedAt = Math.max(lastSavedAt, savedAt);
  return { key: draftKey(workspace, path), workspace, path, content, diskHash, savedAt };
}

export function classifyEmergencyDraft(draft: EmergencyDraft, disk: DraftDiskState): DraftDisposition {
  if (draft.content === disk.content) return 'already-saved';
  if (draft.diskHash === disk.hash) return 'safe-to-replay';
  return 'conflict';
}

function openDraftDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is unavailable.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('workspace', 'workspace', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open recovery storage.'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDraftDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Recovery storage operation failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Recovery storage transaction was aborted.'));
    });
  } finally {
    db.close();
  }
}

const fallbackKey = (key: string) => FALLBACK_PREFIX + encodeURIComponent(key);

function putFallback(draft: EmergencyDraft): void {
  localStorage.setItem(fallbackKey(draft.key), JSON.stringify(draft));
}

function removeFallback(key: string): void {
  localStorage.removeItem(fallbackKey(key));
}

function listFallback(workspace: string): EmergencyDraft[] {
  const drafts: EmergencyDraft[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(FALLBACK_PREFIX)) continue;
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      if (value?.workspace === workspace && typeof value.path === 'string' && typeof value.content === 'string') drafts.push(value);
    } catch {
      // A damaged fallback entry must not prevent every other draft from loading.
    }
  }
  return drafts;
}

// The desktop backend keeps copies on disk, where they are found again whatever
// port the next start is given. The browser's own storage is keyed to the port,
// so a copy written there by a window on 51234 is invisible to one on 3001 —
// which is how work that had been kept could not be recovered after a restart.
// A hosted server declines (one folder, many people), and so does anything
// that is not Hilbert's backend; the browser's storage is used then.
let diskStore: 'unknown' | 'yes' | 'no' = 'no';
let API = '';

/** Where the backend answers; until this is called the browser's storage is used. */
export function enableDiskRecovery(api: string): void {
  API = api;
  diskStore = 'unknown';
}

async function diskPut(draft: EmergencyDraft): Promise<boolean> {
  if (diskStore === 'no') return false;
  try {
    const response = await fetch(`${API}/recovery/drafts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
    });
    if (response.status === 404) { diskStore = 'no'; return false; }
    if (!response.ok) return false;
    diskStore = 'yes';
    return true;
  } catch {
    return false;
  }
}

async function diskList(workspace: string): Promise<EmergencyDraft[]> {
  if (diskStore === 'no') return [];
  try {
    const response = await fetch(`${API}/recovery/drafts?workspace=${encodeURIComponent(workspace)}`);
    if (response.status === 404) { diskStore = 'no'; return []; }
    if (!response.ok) return [];
    diskStore = 'yes';
    const drafts = await response.json();
    return Array.isArray(drafts)
      ? drafts.filter(d => typeof d?.path === 'string' && typeof d?.content === 'string')
        .map(d => ({ ...d, key: draftKey(workspace, d.path), savedAt: Number(d.savedAt) || 0 }))
      : [];
  } catch {
    return [];
  }
}

async function diskRemove(workspace: string, path: string, onlyIfContent?: string): Promise<void> {
  if (diskStore === 'no') return;
  try {
    await fetch(`${API}/recovery/remove`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace, path, onlyIfContent }),
    });
  } catch { /* the next start looks again */ }
}

/** For the moment the page is going away: a request the browser finishes even
 *  after the page has gone, so the last keystrokes are kept. Nothing is waited
 *  for, because by then there is nothing left to wait. */
// A request sent as the page goes may carry 64 KB at most, counting every other
// such request still in flight; anything over is refused outright. So they are
// budgeted, the same text is not sent twice (pagehide and beforeunload both
// fire), and whatever does not fit is written to the browser's storage, which
// happens on the spot and is read back at the next start.
const EXIT_BUDGET = 60 * 1024;
let exitSpent = 0;
const exitSent = new Map<string, string>();

export function putEmergencyDraftOnExit(draft: EmergencyDraft): void {
  if (exitSent.get(draft.key) === draft.content) return;
  exitSent.set(draft.key, draft.content);
  const body = JSON.stringify(draft);
  const size = new TextEncoder().encode(body).length;
  if (diskStore === 'no' || exitSpent + size > EXIT_BUDGET) {
    try { putFallback(draft); } catch { /* nothing more to try */ }
    return;
  }
  exitSpent += size;
  try {
    fetch(`${API}/recovery/drafts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true,
    }).then(response => { if (!response.ok) throw new Error(String(response.status)); }).catch(() => {
      // Refused after all: while the page is still here, keep it locally.
      try { putFallback(draft); } catch { /* the copy from a moment ago stands */ }
    }).finally(() => { exitSpent = Math.max(0, exitSpent - size); });
  } catch {
    try { putFallback(draft); } catch { /* the copy from a moment ago stands */ }
  }
}

// Files whose browser copies have been cleared since the disk took over. Once
// is enough: this runs a moment after every edit, and opening the browser's
// database each time to delete what is no longer there cost more than the copy.
const browserCleared = new Set<string>();

export async function putEmergencyDraft(draft: EmergencyDraft): Promise<void> {
  if (await diskPut(draft)) {
    if (browserCleared.has(draft.key)) return;
    // On disk now; an older copy left in the browser would only compete with
    // it. A newer one stays: the copy written as the page closes can go to the
    // browser while this older write is still on its way to disk.
    let newerKept = false;
    try {
      const held = await withStore<EmergencyDraft | undefined>('readonly', store => store.get(draft.key));
      if (held && held.savedAt > draft.savedAt) newerKept = true;
      else if (held) await withStore('readwrite', store => store.delete(draft.key));
    } catch { /* none there */ }
    try {
      const raw = localStorage.getItem(fallbackKey(draft.key));
      const held = raw ? JSON.parse(raw) as EmergencyDraft : null;
      if (held && held.savedAt > draft.savedAt) newerKept = true;
      else if (held) removeFallback(draft.key);
    } catch { /* storage unavailable */ }
    if (!newerKept) browserCleared.add(draft.key);
    return;
  }
  browserCleared.delete(draft.key);
  try {
    await withStore('readwrite', store => store.put(draft));
    removeFallback(draft.key);
  } catch (databaseError) {
    try {
      putFallback(draft);
    } catch {
      throw databaseError;
    }
  }
}

export async function listEmergencyDrafts(workspace: string): Promise<EmergencyDraft[]> {
  let databaseDrafts: EmergencyDraft[] = [];
  try {
    databaseDrafts = await withStore('readonly', store => store.index('workspace').getAll(workspace));
  } catch {
    // localStorage is the intentionally smaller fallback for private/locked-down browsers.
  }
  let fallbackDrafts: EmergencyDraft[] = [];
  try { fallbackDrafts = listFallback(workspace); } catch { /* storage unavailable */ }
  // Copies from before they moved to disk are still in the browser, and are
  // offered alongside; whichever copy of a file is newest wins.
  const diskDrafts = await diskList(workspace);
  const merged = new Map<string, EmergencyDraft>();
  for (const draft of [...diskDrafts, ...databaseDrafts, ...fallbackDrafts]) {
    const existing = merged.get(draft.key);
    if (!existing || draft.savedAt > existing.savedAt) merged.set(draft.key, draft);
  }
  return [...merged.values()].sort((a, b) => a.savedAt - b.savedAt);
}

export async function removeEmergencyDraft(workspace: string, path: string, onlyIfContent?: string): Promise<void> {
  const key = draftKey(workspace, path);
  // This follows every save. The backend compares the content itself before it
  // deletes anything, so there is no need to fetch every copy in the project —
  // each a whole document — to check the one. The browser holds none once the
  // disk copy has cleared it.
  if (diskStore === 'yes' && browserCleared.has(key)) {
    await diskRemove(workspace, path, onlyIfContent);
    return;
  }
  if (onlyIfContent !== undefined) {
    const current = (await listEmergencyDrafts(workspace)).find(draft => draft.key === key);
    if (current && current.content !== onlyIfContent) return;
  }
  await diskRemove(workspace, path, onlyIfContent);
  try { await withStore('readwrite', store => store.delete(key)); } catch { /* fallback may still hold it */ }
  try { removeFallback(key); } catch { /* storage unavailable */ }
}
