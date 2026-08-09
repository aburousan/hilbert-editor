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

export function createEmergencyDraft(
  workspace: string,
  path: string,
  content: string,
  diskHash?: string,
  savedAt = Date.now(),
): EmergencyDraft {
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

export async function putEmergencyDraft(draft: EmergencyDraft): Promise<void> {
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
  const merged = new Map<string, EmergencyDraft>();
  for (const draft of [...databaseDrafts, ...fallbackDrafts]) {
    const existing = merged.get(draft.key);
    if (!existing || draft.savedAt > existing.savedAt) merged.set(draft.key, draft);
  }
  return [...merged.values()].sort((a, b) => a.savedAt - b.savedAt);
}

export async function removeEmergencyDraft(workspace: string, path: string, onlyIfContent?: string): Promise<void> {
  const key = draftKey(workspace, path);
  if (onlyIfContent !== undefined) {
    const current = (await listEmergencyDrafts(workspace)).find(draft => draft.key === key);
    if (current && current.content !== onlyIfContent) return;
  }
  try { await withStore('readwrite', store => store.delete(key)); } catch { /* fallback may still hold it */ }
  try { removeFallback(key); } catch { /* storage unavailable */ }
}
