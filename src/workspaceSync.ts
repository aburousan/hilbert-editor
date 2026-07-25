// Shared model for whole-project collaboration. The single-file session in
// collab.ts syncs one Y.Text; this widens that to the entire workspace so a
// collaborator receives every file, keeps editing live, and compiles the real
// document on their own machine.
//
// Layout inside the Y.Doc:
//   files: Y.Map< path -> Y.Map {
//            kind:    'text' | 'binary'
//            text:    Y.Text        (text files only; the open file binds to it)
//            hash:    string        (binary files: content hash, fetched out of band)
//            size:    number        (binary files: byte length)
//            deleted: true          (tombstone; the entry stays so the delete propagates)
//          } >
//
// Text lives in the doc because it is small and merges cleanly. Binary bytes do
// NOT: a Yjs sync encodes the whole doc as one message, and a project full of
// images would make that message too large to survive the relay. Binaries carry
// only their hash and size here; the bytes travel through a separate chunked
// channel keyed by that hash.
import * as Y from 'yjs';

export type FileKind = 'text' | 'binary';

export type FileMeta = {
  path: string;
  kind: FileKind;
  deleted: boolean;
  hash?: string;
  size?: number;
};

export type WorkspaceChange = {
  path: string;
  meta: FileMeta;
  // 'removed' means the entry gained a tombstone; 'upserted' covers a new file
  // or any content/metadata change on an existing one.
  type: 'upserted' | 'removed';
};

const FILES_KEY = 'files';

// A workspace path is normalized to forward slashes with no leading slash and no
// traversal segment, so it can only ever name something inside the project. The
// receiver still routes every write through the path-guarded upload endpoint;
// this is a first line, not the only one.
export function normalizeWorkspacePath(raw: string): string | null {
  const cleaned = String(raw ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!cleaned) return null;
  const parts = cleaned.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return null;
  }
  return parts.join('/');
}

function readMeta(path: string, entry: Y.Map<any>): FileMeta {
  const kind: FileKind = entry.get('kind') === 'binary' ? 'binary' : 'text';
  const meta: FileMeta = { path, kind, deleted: entry.get('deleted') === true };
  if (kind === 'binary') {
    const hash = entry.get('hash');
    const size = entry.get('size');
    if (typeof hash === 'string') meta.hash = hash;
    if (typeof size === 'number') meta.size = size;
  }
  return meta;
}

export class WorkspaceModel {
  readonly doc: Y.Doc;
  private readonly files: Y.Map<Y.Map<any>>;
  // Deep-observer events identify their Yjs target object. Index those targets
  // once so a keystroke can resolve its file in O(1) instead of scanning every
  // workspace entry on every character.
  private readonly targetPaths = new WeakMap<object, string>();

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.files = doc.getMap(FILES_KEY);
    this.files.forEach((entry, path) => this.indexEntry(path, entry));
  }

  private entry(path: string): Y.Map<any> | undefined {
    return this.files.get(path);
  }

  // The Y.Text a Monaco binding attaches to for the open file. Creating it as a
  // text entry if absent lets a joiner bind before the first sync lands.
  textOf(path: string): Y.Text {
    const key = normalizeWorkspacePath(path);
    if (!key) throw new Error('Invalid workspace path');
    let entry = this.entry(key);
    if (!entry || entry.get('kind') !== 'text') {
      this.doc.transact(() => {
        entry = new Y.Map<any>();
        entry.set('kind', 'text');
        entry.set('text', new Y.Text());
        this.files.set(key, entry);
      });
      entry = this.entry(key)!;
    }
    this.indexEntry(key, entry!);
    return entry.get('text') as Y.Text;
  }

  // Replace a text file's contents wholesale. Used for files that are not the
  // focused editor (those merge through MonacoBinding instead). Clearing an
  // existing tombstone revives the path.
  setText(path: string, content: string): void {
    const key = normalizeWorkspacePath(path);
    if (!key) return;
    this.doc.transact(() => {
      let entry = this.entry(key);
      if (!entry || entry.get('kind') !== 'text') {
        entry = new Y.Map<any>();
        entry.set('kind', 'text');
        entry.set('text', new Y.Text());
        this.files.set(key, entry);
        entry = this.entry(key)!;
      }
      entry.delete('deleted');
      const ytext = entry.get('text') as Y.Text;
      if (ytext.toString() !== content) {
        replaceText(ytext, content);
      }
      this.indexEntry(key, entry);
    });
  }

  // Record a binary file by content hash and size. Bytes are transferred
  // separately; a change of hash is what tells peers to re-fetch.
  setBinary(path: string, hash: string, size: number): void {
    const key = normalizeWorkspacePath(path);
    if (!key) return;
    this.doc.transact(() => {
      let entry = this.entry(key);
      if (!entry || entry.get('kind') !== 'binary') {
        entry = new Y.Map<any>();
        entry.set('kind', 'binary');
        this.files.set(key, entry);
        entry = this.entry(key)!;
      }
      entry.delete('deleted');
      entry.set('hash', hash);
      entry.set('size', size);
      this.indexEntry(key, entry);
    });
  }

  // Tombstone a path. The entry is kept, not dropped, so the removal itself
  // propagates to peers that still hold the file.
  remove(path: string): void {
    const key = normalizeWorkspacePath(path);
    if (!key) return;
    const entry = this.entry(key);
    if (!entry) return;
    this.doc.transact(() => {
      entry.set('deleted', true);
      if (entry.get('kind') === 'text') {
        const ytext = entry.get('text') as Y.Text;
        if (ytext.length) ytext.delete(0, ytext.length);
      } else {
        entry.delete('hash');
        entry.delete('size');
      }
    });
  }

  readText(path: string): string | null {
    const key = normalizeWorkspacePath(path);
    if (!key) return null;
    const entry = this.entry(key);
    if (!entry || entry.get('kind') !== 'text' || entry.get('deleted') === true) return null;
    return (entry.get('text') as Y.Text).toString();
  }

  metaOf(path: string): FileMeta | null {
    const key = normalizeWorkspacePath(path);
    if (!key) return null;
    const entry = this.entry(key);
    return entry ? readMeta(key, entry) : null;
  }

  // Live files, tombstones excluded. Sorted for stable iteration.
  list(): FileMeta[] {
    const out: FileMeta[] = [];
    this.files.forEach((entry, path) => {
      const meta = readMeta(path, entry);
      if (!meta.deleted) out.push(meta);
    });
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  // Fire on every remote (or local) change to the file set. The callback gets
  // only the paths that changed in that transaction, each tagged upserted or
  // removed, plus the transaction origin so a consumer can skip echoing back
  // the very edits it just made locally.
  observe(callback: (changes: WorkspaceChange[], origin: any) => void): () => void {
    const handler = (events: Y.YEvent<any>[], transaction: Y.Transaction) => {
      const touched = new Map<string, WorkspaceChange>();
      for (const event of events) {
        // A change to files itself: keys added or removed at the top level.
        if (event.target === this.files) {
          for (const key of event.keys.keys()) {
            const entry = this.entry(key);
            if (!entry) continue;
            this.indexEntry(key, entry);
            const meta = readMeta(key, entry);
            touched.set(key, { path: key, meta, type: meta.deleted ? 'removed' : 'upserted' });
          }
          continue;
        }
        // A change inside one file entry (its text, hash, or deleted flag).
        const path = this.pathOfTarget(event.target);
        if (!path) continue;
        const entry = this.entry(path);
        if (!entry) continue;
        const meta = readMeta(path, entry);
        touched.set(path, { path, meta, type: meta.deleted ? 'removed' : 'upserted' });
      }
      if (touched.size) callback([...touched.values()], transaction ? transaction.origin : null);
    };
    this.files.observeDeep(handler);
    return () => this.files.unobserveDeep(handler);
  }

  private pathOfTarget(target: any): string | null {
    if (target && typeof target === 'object') {
      const indexed = this.targetPaths.get(target);
      if (indexed) return indexed;
    }
    // A document received in one remote update can expose a nested event before
    // its top-level map event is visited. Index once on that rare cold path.
    let found: string | null = null;
    this.files.forEach((entry, path) => {
      if (found) return;
      this.indexEntry(path, entry);
      if (entry === target || entry.get('text') === target) found = path;
    });
    return found;
  }

  private indexEntry(path: string, entry: Y.Map<any>): void {
    this.targetPaths.set(entry, path);
    const text = entry.get('text');
    if (text && typeof text === 'object') this.targetPaths.set(text, path);
  }
}

// Preserve the unchanged prefix and suffix when replacing a non-focused text
// file. Yjs keeps deleted structs for CRDT history, so delete-all/insert-all on
// every save would make a long session grow with file_size × save_count.
function replaceText(ytext: Y.Text, content: string): void {
  const current = ytext.toString();
  let prefix = 0;
  const maxPrefix = Math.min(current.length, content.length);
  while (prefix < maxPrefix && current.charCodeAt(prefix) === content.charCodeAt(prefix)) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(current.length - prefix, content.length - prefix);
  while (
    suffix < maxSuffix
    && current.charCodeAt(current.length - 1 - suffix) === content.charCodeAt(content.length - 1 - suffix)
  ) suffix++;

  const deleteLength = current.length - prefix - suffix;
  const insert = content.slice(prefix, content.length - suffix);
  if (deleteLength) ytext.delete(prefix, deleteLength);
  if (insert) ytext.insert(prefix, insert);
}
