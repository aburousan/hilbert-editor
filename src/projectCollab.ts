// Orchestrates whole-project collaboration by joining three pieces: the shared
// Yjs model (file tree + text), the out-of-band binary transfer, and the local
// workspace on disk. It is deliberately transport- and filesystem-agnostic:
// callers inject a ProjectFs (the workspace endpoints in the app, an in-memory
// map in tests) and hand it a model already syncing over some provider and a
// transfer already bound to a channel. That keeps the whole sync flow testable
// end to end without a network or a running editor.
import { WorkspaceModel, normalizeWorkspacePath, type WorkspaceChange } from './workspaceSync';
import { BinaryTransfer } from './binaryTransfer';
import { isProjectTextPath } from './projectFileTypes';

export { BinaryTransfer } from './binaryTransfer';

export interface ProjectFs {
  list(): Promise<Array<{ path: string }>>;
  readText(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  writeText(path: string, content: string): Promise<void>;
  writeBinary(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

// A private origin tag for every model edit this orchestrator makes locally, so
// its own observe handler can tell those apart from edits arriving over the
// network and avoid writing them straight back to disk.
const LOCAL = { local: true };

export type ProjectSyncOptions = {
  model: WorkspaceModel;
  transfer: BinaryTransfer;
  fs: ProjectFs;
  hashBytes: (bytes: Uint8Array) => Promise<string>;
  isTextPath?: (path: string) => boolean;
  onError?: (message: string) => void;
  onApplied?: (change: WorkspaceChange) => void;
  onApplyIdle?: () => void;
  onBinaryTransfer?: (pending: number, path: string | null) => void;
};

export class ProjectSync {
  private readonly model: WorkspaceModel;
  private readonly transfer: BinaryTransfer;
  private readonly fs: ProjectFs;
  private readonly hashBytes: (bytes: Uint8Array) => Promise<string>;
  private readonly isText: (path: string) => boolean;
  private readonly onError: (message: string) => void;
  private readonly onApplied: (change: WorkspaceChange) => void;
  private readonly onApplyIdle: () => void;
  private readonly onBinaryTransfer: (pending: number, path: string | null) => void;
  // Content hash of each binary we currently hold on disk: skips re-fetching
  // unchanged bytes and records what we are able to serve to other peers.
  private readonly diskHash = new Map<string, string>();
  // More than one path can contain identical bytes. Keep reference sets so
  // deleting one copy does not withdraw the provider needed for the others.
  private readonly hashPaths = new Map<string, Set<string>>();
  private off: (() => void) | null = null;
  private applyQueue: Promise<void> = Promise.resolve();
  private applyEpoch = 0;
  private appliedRevision = 0;
  private pendingBinary = 0;
  // The file currently open in the editor. Its Y.Text is bound to Monaco, so
  // remote edits already reach the buffer through that binding and autosave
  // persists them. ProjectSync must NOT also write this path to disk: the open
  // file's edits arrive on observe with the binding as origin (not LOCAL), and
  // writing on every keystroke would race autosave and the external-change
  // detector. Each peer skips only its OWN open file.
  private openPath: string | null = null;
  // Every text path the editor has bound during this session. Their Y.Text is
  // the authority: the binding carries each keystroke into the document, so a
  // whole-file push for one of them can only ever be a stale echo. See
  // onLocalText for why that echo used to destroy the session.
  private readonly boundPaths = new Set<string>();
  // Raised while writing a network change to disk, so an app that watches files
  // does not mistake that write for a local edit and echo it back. Counter-
  // backed because binary fetches in one batch apply in parallel: with a plain
  // boolean, the first write to finish would lower the flag while its siblings
  // are still writing.
  private applyingDepth = 0;
  get applyingRemote(): boolean { return this.applyingDepth > 0; }

  constructor(opts: ProjectSyncOptions) {
    this.model = opts.model;
    this.transfer = opts.transfer;
    this.fs = opts.fs;
    this.hashBytes = opts.hashBytes;
    this.isText = opts.isTextPath ?? isProjectTextPath;
    this.onError = opts.onError ?? (() => {});
    this.onApplied = opts.onApplied ?? (() => {});
    this.onApplyIdle = opts.onApplyIdle ?? (() => {});
    this.onBinaryTransfer = opts.onBinaryTransfer ?? (() => {});
  }

  private get doc() { return this.model.doc; }

  // React to changes arriving over the network. Both host and joiner call this;
  // each ignores the edits it made itself.
  start(): void {
    if (this.off) return;
    this.off = this.model.observe((changes, origin) => {
      if (origin === LOCAL) return;
      void this.enqueueApply(changes);
    });
  }

  stop(): void {
    this.off?.();
    this.off = null;
  }

  // Tell the sync which file is open in the editor so it leaves that file's disk
  // state to the Monaco binding and autosave. Call on session start and on every
  // file switch. Pass null when no file is focused.
  // Pass only a path the editor actually binds — a text file. Focusing an image
  // or a PDF is "no text file open", not "that asset is open": naming an asset
  // here would exempt it from the rejoin publish and pin a stale openPath while
  // the real document is left unprotected.
  setOpenPath(path: string | null): void {
    const key = path ? normalizeWorkspacePath(path) : null;
    this.openPath = key && this.isText(key) ? key : null;
    if (this.openPath) this.boundPaths.add(this.openPath);
  }

  // Populate a newly selected empty workspace from the model already received
  // during the Yjs handshake. Later model changes share the same serialized
  // queue, so an edit arriving during the import cannot race an older write.
  applyWorkspace(): Promise<void> {
    const changes: WorkspaceChange[] = this.model.list().map(meta => ({
      path: meta.path,
      meta,
      type: 'upserted',
    }));
    return this.enqueueApply(changes);
  }

  // Rejoin support. A folder reused from an earlier session holds three kinds of
  // file: ones the session also has (applyWorkspace already overwrote those with
  // the session's version, which is the merged state of everyone still
  // connected), ones only this peer has, and ones the session deleted while this
  // peer was away. Local-only files are published so they are not stranded here.
  // Deleted-elsewhere files are only reported: removing a file is the user's
  // call, so the app asks before touching them. Returns those paths.
  //
  // Nothing here reads a timestamp, because the model carries none — a file
  // edited locally while disconnected loses to the session's copy. Call this
  // after applyWorkspace so the session's writes have already landed.
  async reconcileLocalWorkspace(): Promise<string[]> {
    const tombstoned: string[] = [];
    const files = await this.fs.list();
    for (const { path } of files) {
      const key = normalizeWorkspacePath(path);
      if (!key) continue;
      const meta = this.model.metaOf(key);
      if (meta?.deleted) { tombstoned.push(key); continue; }
      if (meta) continue;   // the session owns this path; it is already current
      try {
        if (this.isText(key)) {
          if (this.openPath === key) continue;   // the Monaco binding owns this one
          const content = await this.fs.readText(key);
          this.doc.transact(() => this.model.setText(key, content), LOCAL);
        } else {
          await this.mirrorLocalBinary(key);
        }
      } catch (e) {
        this.onError(`Could not share ${key}: ${errText(e)}`);
      }
    }
    return tombstoned;
  }

  // Delete this peer's copy of paths the session already tombstoned. The model
  // is left alone: it holds the tombstone that named these files in the first
  // place, so there is nothing to announce.
  async removeLocalCopies(paths: string[]): Promise<void> {
    for (const path of paths) {
      const key = normalizeWorkspacePath(path);
      if (!key) continue;
      this.unregisterBinary(key);
      this.applyingDepth++;
      try {
        await this.fs.remove(key);
      } catch (e) {
        this.onError(`Could not remove ${key}: ${errText(e)}`);
      } finally {
        this.applyingDepth--;
      }
    }
  }

  // Re-request the binaries this peer is meant to have but does not hold. A
  // fetch that fails — the only peer with those bytes dropped mid-transfer, or
  // the request timed out — is otherwise lost for the rest of the session: the
  // model already names the file, so no further change event ever arrives to
  // drive a second attempt, and the image simply stays missing. Cheap to call
  // when nothing is outstanding, so the app can run it whenever a peer arrives
  // and might be the one able to serve them.
  resyncMissingBinaries(): Promise<void> {
    const changes: WorkspaceChange[] = this.model.list()
      .filter(meta => meta.kind === 'binary' && !!meta.hash && this.diskHash.get(meta.path) !== meta.hash)
      .map(meta => ({ path: meta.path, meta, type: 'upserted' }));
    return changes.length ? this.enqueueApply(changes) : Promise.resolve();
  }

  // Host action: put the entire current workspace into the shared model so a
  // joiner receives it. Text goes into the doc; binaries are advertised by hash
  // and offered for fetch.
  async publishWorkspace(): Promise<void> {
    const files = await this.fs.list();
    for (const { path } of files) {
      const key = normalizeWorkspacePath(path);
      if (!key) continue;
      try {
        if (this.isText(key)) {
          if (this.openPath === key && this.model.metaOf(key)?.kind === 'text') continue;
          const content = await this.fs.readText(key);
          this.doc.transact(() => this.model.setText(key, content), LOCAL);
        } else {
          await this.mirrorLocalBinary(key);
        }
      } catch (e) {
        this.onError(`Could not share ${key}: ${errText(e)}`);
      }
    }
  }

  // ---- local edit hooks, called by the app when the user changes something ----

  // A text file changed on disk (a non-focused file; the open editor merges
  // through its own Monaco binding and must not also be pushed here).
  onLocalText(path: string, content: string): void {
    if (this.applyingRemote) return;
    const key = normalizeWorkspacePath(path);
    if (!key) return;
    // Never replace a bound file wholesale. Remote edits reach the editor
    // through the Monaco binding, which leaves the buffer looking modified, so
    // the app's autosave offers it back here as though the user had written it.
    // Replacing the Y.Text with that buffer discards every keystroke the other
    // peers made since it was last in sync — and because autosave keeps firing,
    // it does so again and again. The session stays connected while each side
    // watches the other's typing disappear.
    if (this.boundPaths.has(key)) return;
    this.doc.transact(() => this.model.setText(key, content), LOCAL);
  }

  // A binary file was added or replaced on disk.
  async onLocalBinary(path: string): Promise<void> {
    if (this.applyingRemote) return;
    const key = normalizeWorkspacePath(path);
    if (!key) return;
    try {
      await this.mirrorLocalBinary(key);
    } catch (e) {
      this.onError(`Could not share ${key}: ${errText(e)}`);
    }
  }

  // A file was deleted on disk.
  onLocalRemove(path: string): void {
    if (this.applyingRemote) return;
    const key = normalizeWorkspacePath(path);
    if (!key) return;
    this.unregisterBinary(key);
    this.doc.transact(() => this.model.remove(key), LOCAL);
  }

  private async mirrorLocalBinary(key: string): Promise<void> {
    const bytes = await this.fs.readBinary(key);
    const hash = await this.hashBytes(bytes);
    if (this.diskHash.get(key) === hash) return;   // unchanged
    this.registerBinary(key, hash);
    this.doc.transact(() => this.model.setBinary(key, hash, bytes.length), LOCAL);
  }

  // How many binary fetches run at once. Matches the provider's concurrent-load
  // cap in BinaryTransfer so parallel requests are served, not dropped.
  private static readonly BINARY_FETCH_CONCURRENCY = 3;

  private async applyRemote(changes: WorkspaceChange[]): Promise<void> {
    // Text and removals first, in order — they are quick local writes and get
    // the compilable sources onto disk before any assets stream in. Binary
    // fetches then run through a small pool: each one pays a request round
    // trip, two hashes, and chunked streaming, so a project full of images
    // joins several times faster interleaved than strictly one at a time. Each
    // path appears at most once per batch (the observer de-duplicates), and the
    // outer queue still serializes batch against batch, so nothing here can
    // reorder two writes to the same file.
    const binaries: WorkspaceChange[] = [];
    const applyOne = async (change: WorkspaceChange) => {
      try {
        await this.applyOne(change);
      } catch (e) {
        this.onError(`Could not apply ${change.path}: ${errText(e)}`);
      }
    };
    for (const change of changes) {
      if (change.type === 'upserted' && change.meta.kind === 'binary') {
        binaries.push(change);
        continue;
      }
      await applyOne(change);
    }
    if (!binaries.length) return;
    let index = 0;
    const worker = async () => {
      while (index < binaries.length) await applyOne(binaries[index++]);
    };
    const width = Math.min(ProjectSync.BINARY_FETCH_CONCURRENCY, binaries.length);
    await Promise.all(Array.from({ length: width }, worker));
  }

  private enqueueApply(changes: WorkspaceChange[]): Promise<void> {
    const epoch = ++this.applyEpoch;
    const revisionBefore = this.appliedRevision;
    const run = this.applyQueue.then(() => this.applyRemote(changes));
    this.applyQueue = run.catch(() => {});
    void this.applyQueue.then(() => {
      if (this.off && epoch === this.applyEpoch && this.appliedRevision !== revisionBefore) {
        try {
          this.onApplyIdle();
        } catch (e) {
          this.onError(`Could not finish applying remote changes: ${errText(e)}`);
        }
      }
    });
    return run;
  }

  private emitApplied(change: WorkspaceChange): void {
    this.appliedRevision++;
    this.onApplied(change);
  }

  private async applyOne(change: WorkspaceChange): Promise<void> {
    const { path, meta, type } = change;
    if (type === 'removed') {
      this.unregisterBinary(path);
      this.applyingDepth++;
      try { await this.fs.remove(path); } finally { this.applyingDepth--; }
      this.emitApplied(change);
      return;
    }
    if (meta.kind === 'text') {
      // The open file is owned by the Monaco binding + autosave; skip it here.
      if (this.openPath && path === this.openPath) return;
      const content = this.model.readText(path);
      if (content == null) return;
      this.applyingDepth++;
      try { await this.fs.writeText(path, content); } finally { this.applyingDepth--; }
      this.emitApplied(change);
      return;
    }
    // Binary: fetch the bytes by hash unless we already hold that exact content.
    const hash = meta.hash;
    if (!hash) return;
    if (this.diskHash.get(path) === hash) return;
    // First sight of this path in this session. A rejoin reuses a folder that
    // usually already holds the right bytes from last time, and applyWorkspace
    // enqueues every advertised binary — hashing the local copy is far cheaper
    // than pulling the whole asset set back through the transfer channel.
    // Registering also makes this peer able to serve those bytes to others.
    if (!this.diskHash.has(path)) {
      try {
        const local = await this.fs.readBinary(path);
        this.registerBinary(path, await this.hashBytes(local));
        if (this.diskHash.get(path) === hash) return;
      } catch { /* nothing usable on disk; fetch it */ }
    }
    this.pendingBinary++;
    this.onBinaryTransfer(this.pendingBinary, path);
    let bytes: Uint8Array;
    try {
      bytes = await this.transfer.request(hash, meta.size ?? 0);
    } finally {
      this.pendingBinary = Math.max(0, this.pendingBinary - 1);
      this.onBinaryTransfer(this.pendingBinary, this.pendingBinary ? path : null);
    }
    this.applyingDepth++;
    try { await this.fs.writeBinary(path, bytes); } finally { this.applyingDepth--; }
    // Now that we hold it, offer to serve it onward to other peers.
    this.registerBinary(path, hash);
    this.emitApplied(change);
  }

  private registerBinary(path: string, hash: string): void {
    const previous = this.diskHash.get(path);
    if (previous && previous !== hash) this.unregisterBinary(path);
    this.diskHash.set(path, hash);
    let paths = this.hashPaths.get(hash);
    if (!paths) {
      paths = new Set();
      this.hashPaths.set(hash, paths);
    }
    paths.add(path);
    // Resolve a live path at request time rather than capturing whichever copy
    // happened to register first.
    this.transfer.provide(hash, async () => {
      const current = this.hashPaths.get(hash);
      if (!current?.size) throw new Error('Binary content is no longer available');
      let lastError: unknown = null;
      for (const candidate of current) {
        try {
          return await this.fs.readBinary(candidate);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error('Binary content is no longer available');
    });
  }

  private unregisterBinary(path: string): void {
    const hash = this.diskHash.get(path);
    if (!hash) return;
    this.diskHash.delete(path);
    const paths = this.hashPaths.get(hash);
    paths?.delete(path);
    if (!paths?.size) {
      this.hashPaths.delete(hash);
      this.transfer.unprovide(hash);
    }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
