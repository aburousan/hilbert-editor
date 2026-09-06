// Undo history for the diagram editors.
//
// A slider drag arrives as one change per tick and typing in a field as one per
// keystroke, but each is a single edit to the person making it. Passing a key
// with a change folds it into the entry taken before the run started, so undo
// steps back over the whole gesture rather than one tick of it. Changes with no
// key, or with a different one, always start a fresh entry.
export const GESTURE_WINDOW_MS = 700;

export type History<T> = {
  record(previous: T, key?: string, now?: number): void;
  undo(current: T): T | undefined;
  redo(current: T): T | undefined;
  canUndo(): boolean;
  canRedo(): boolean;
};

export function createHistory<T>(limit = 100): History<T> {
  const past: T[] = [];
  const future: T[] = [];
  let open: { key: string, at: number } | null = null;
  return {
    record(previous, key, now = Date.now()) {
      if (key && open && open.key === key && now - open.at < GESTURE_WINDOW_MS && past.length) {
        open = { key, at: now };
        future.length = 0;
        return;
      }
      past.push(previous);
      if (past.length > limit) past.shift();
      future.length = 0;
      open = key ? { key, at: now } : null;
    },
    // Stepping through history closes any open gesture, so a slider moved again
    // afterwards cannot fold onto an entry the user has already stepped past.
    undo(current) {
      const previous = past.pop();
      if (previous === undefined) return undefined;
      open = null;
      future.push(current);
      return previous;
    },
    redo(current) {
      const next = future.pop();
      if (next === undefined) return undefined;
      open = null;
      past.push(current);
      return next;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
  };
}
