// Memory safety rails. Every item limited here can be recreated from the
// workspace, a fresh compile, or another run. Dirty editor buffers and the
// canonical collaboration document are deliberately outside these limits.
export const MAX_INACTIVE_EDITOR_MODELS = 12;
export const MAX_PDF_PAGE_WORD_INDEXES = 12;
export const MAX_RETAINED_RUN_TEXT = 256 * 1024;
export const MAX_RETAINED_NOTEBOOK_TEXT = 1024 * 1024;
export const WHITEBOARD_HISTORY_CHECKPOINT_CHANGES = 100;

type ModelCandidate = { path: string; lastUsed: number; dirty: boolean; active: boolean };

export function inactiveModelsToDiscard(
  models: ModelCandidate[],
  limit = MAX_INACTIVE_EDITOR_MODELS,
): string[] {
  const inactiveClean = models
    .filter(model => !model.active && !model.dirty)
    .sort((a, b) => b.lastUsed - a.lastUsed);
  return inactiveClean.slice(Math.max(0, limit)).map(model => model.path);
}

function safeStart(text: string, end: number): string {
  let at = Math.max(0, Math.min(text.length, end));
  if (at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at])) at--;
  return text.slice(0, at);
}

function safeEnd(text: string, start: number): string {
  let at = Math.max(0, Math.min(text.length, start));
  if (at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at])) at++;
  return text.slice(at);
}

export function limitRetainedText(text: string, limit: number, label = 'output'): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  if (limit <= 0) return { text: '', truncated: !!text };
  const notice = `\n[… ${label} truncated; run again to reproduce it …]\n`;
  if (notice.length >= limit) return { text: safeStart(notice, limit), truncated: true };
  const available = Math.max(0, limit - notice.length);
  const head = Math.ceil(available * 0.75);
  return {
    text: safeStart(text, head) + notice + safeEnd(text, text.length - (available - head)),
    truncated: true,
  };
}

export type RetainableRunResult = {
  stdout?: string;
  stderr?: string;
  error?: string;
  outputTruncated?: boolean;
  [key: string]: unknown;
};

export function limitRunResult<T extends RetainableRunResult>(
  result: T,
  totalLimit = MAX_RETAINED_RUN_TEXT,
): T {
  let remaining = Math.max(0, totalLimit);
  let truncated = !!result.outputTruncated;
  const next = { ...result } as T;
  for (const key of ['stdout', 'stderr', 'error'] as const) {
    const value = typeof result[key] === 'string' ? result[key] as string : '';
    const limited = limitRetainedText(value, remaining, key);
    if (key in result || value) (next as RetainableRunResult)[key] = limited.text;
    remaining = Math.max(0, remaining - limited.text.length);
    truncated ||= limited.truncated;
  }
  if (truncated) next.outputTruncated = true;
  return next;
}

export function limitNotebookResults<T extends RetainableRunResult>(results: T[]): T[] {
  let remaining = MAX_RETAINED_NOTEBOOK_TEXT;
  return results.map(result => {
    const limited = limitRunResult(result, remaining);
    remaining = Math.max(0, remaining
      - (typeof limited.stdout === 'string' ? limited.stdout.length : 0)
      - (typeof limited.stderr === 'string' ? limited.stderr.length : 0)
      - (typeof limited.error === 'string' ? limited.error.length : 0));
    return limited;
  });
}
