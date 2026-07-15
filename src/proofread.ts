// Proofreading client for the editor: talks to the Tauri backend's `/lint`
// endpoint (spellbook spell checking + Harper grammar/style, Typst-aware),
// paints Monaco squiggles, feeds the quick-fix lightbulb, and drives the
// Proofread side panel.
//
// The endpoint only exists in the Tauri edition. Under Electron there is no
// `/lint` route, so the first call 404s and the whole feature quietly disables
// itself — the shared UI stays identical either way.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { API } from './api';
import { snapUtf16RangeToGraphemes } from './unicodeRanges';

export type ProofKind = 'spelling' | 'grammar' | 'style';

interface ProofIssue {
  start: number;          // char offset (Unicode scalar index) into the source
  end: number;
  text: string;
  message: string;
  kind: ProofKind;
  rule: string;
  suggestions: string[];  // replacement strings for [start, end); '' == delete
}

// An issue with its resolved Monaco range attached.
export interface PlacedIssue extends ProofIssue {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
}

const MARKER_OWNER = 'hilbert-proofread';

// Map scalar offsets from Rust to absolute UTF-16 offsets used by Monaco.
function computeUtf16Offsets(text: string, offsets: number[]): Map<number, number> {
  const sorted = Array.from(new Set(offsets)).filter((offset) => Number.isInteger(offset) && offset >= 0).sort((a, b) => a - b);
  const res = new Map<number, number>();
  let cp = 0;
  let utf16 = 0;
  let ptr = 0;
  const record = () => {
    while (ptr < sorted.length && sorted[ptr] === cp) {
      res.set(sorted[ptr], utf16);
      ptr++;
    }
  };
  record();
  for (const ch of text) {
    if (ptr >= sorted.length) break;
    utf16 += ch.length;
    cp++;
    record();
  }
  while (ptr < sorted.length) {
    res.set(sorted[ptr], utf16);
    ptr++;
  }
  return res;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function positionAt(starts: number[], offset: number): { lineNumber: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (starts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  const lineIndex = Math.max(0, high);
  return { lineNumber: lineIndex + 1, column: offset - starts[lineIndex] + 1 };
}

function placeIssues(text: string, issues: ProofIssue[]): PlacedIssue[] {
  const offsets: number[] = [];
  for (const i of issues) offsets.push(i.start, i.end);
  const utf16 = computeUtf16Offsets(text, offsets);
  const starts = lineStarts(text);
  const out: PlacedIssue[] = [];
  for (const i of issues) {
    const rawStart = utf16.get(i.start);
    const rawEnd = utf16.get(i.end);
    if (rawStart === undefined || rawEnd === undefined || rawEnd <= rawStart) continue;
    const safe = snapUtf16RangeToGraphemes(text, rawStart, rawEnd);
    const s = positionAt(starts, safe.start);
    const e = positionAt(starts, safe.end);
    out.push({
      ...i,
      text: text.slice(safe.start, safe.end),
      range: { startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column },
    });
  }
  return out;
}

// The code-action provider needs the current issues; keep them in a ref-like
// module cell keyed by the model URI it was computed for.
const placedByUri = new Map<string, PlacedIssue[]>();
let providerRegistered = false;

function severityFor(monaco: any, kind: ProofKind): number {
  const S = monaco.MarkerSeverity;
  if (kind === 'style') return S.Info;
  return S.Warning; // spelling + grammar
}

function labelFor(replacement: string): string {
  return replacement === '' ? 'Delete' : `Change to “${replacement}”`;
}

// Register a quick-fix provider once. It offers each suggestion as a plain edit
// (no command plumbing), so the lightbulb "just works" in the Tauri build.
function ensureProvider(monaco: any) {
  if (providerRegistered) return;
  providerRegistered = true;
  const provide = (model: any, range: any) => {
    const placed = placedByUri.get(model.uri.toString()) || [];
    const actions: any[] = [];
    for (const issue of placed) {
      const r = issue.range;
      // Only offer fixes for issues overlapping the requested range.
      const overlaps =
        r.startLineNumber <= range.endLineNumber &&
        r.endLineNumber >= range.startLineNumber;
      if (!overlaps) continue;
      for (const s of issue.suggestions) {
        actions.push({
          title: labelFor(s),
          kind: 'quickfix',
          diagnostics: [],
          edit: {
            edits: [
              {
                resource: model.uri,
                textEdit: { range: r, text: s },
                versionId: model.getVersionId(),
              },
            ],
          },
        });
      }
    }
    return { actions, dispose() {} };
  };
  monaco.languages.registerCodeActionProvider('typst', { provideCodeActions: provide });
  monaco.languages.registerCodeActionProvider('plaintext', { provideCodeActions: provide });
}

async function requestLint(text: string): Promise<ProofIssue[]> {
  const res = await fetch(`${API}/lint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`lint ${res.status}`);
  const data = await res.json();
  return (data.issues || []) as ProofIssue[];
}

// Spelling suggestions are computed lazily by the backend (each is a
// dictionary-wide search), so lint stays fast regardless of misspelling count.
// We fetch them for the words on screen and cache per word for the session.
const suggestCache = new Map<string, string[]>();

async function fetchSuggestions(words: string[]): Promise<void> {
  const missing = Array.from(new Set(words)).filter((w) => !suggestCache.has(w));
  if (!missing.length) return;
  try {
    const res = await fetch(`${API}/lint/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: missing }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const map = (data.suggestions || {}) as Record<string, string[]>;
    for (const w of missing) suggestCache.set(w, map[w] || []);
  } catch { /* leave uncached; a later pass retries */ }
}

// Fill in cached spelling suggestions on a freshly-placed issue list.
function withSuggestions(placed: PlacedIssue[]): PlacedIssue[] {
  return placed.map((i) =>
    i.kind === 'spelling' && i.suggestions.length === 0 && suggestCache.has(i.text)
      ? { ...i, suggestions: suggestCache.get(i.text)! }
      : i,
  );
}

interface UseProofread {
  available: boolean;   // backend supports /lint (Tauri edition)
  issues: PlacedIssue[];
  busy: boolean;
  jumpTo(issue: PlacedIssue): void;
  applySuggestion(issue: PlacedIssue, replacement: string): void;
  ignoreWord(issue: PlacedIssue): void;
  revalidate(): void;
}

/**
 * Live proofreading for the active editor tab. Debounced; only runs on `.typ`
 * files while `enabled`. Paints markers and returns the issue list for a panel.
 */
export function useProofread(
  monaco: any,
  editorRef: MutableRefObject<any>,
  activeTabPath: string | undefined,
  activeTabContent: string | undefined,
  enabled: boolean,
): UseProofread {
  const [issues, setIssues] = useState<PlacedIssue[]>([]);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const isTyp = !!activeTabPath && activeTabPath.endsWith('.typ');
  const active = enabled && available && isTyp;

  // Probe once the feature is enabled: an empty-text lint is answered instantly by
  // the Tauri backend and 404s under Electron, so it tells us whether to show the
  // feature. Skipped while disabled so a held-back feature makes no backend calls.
  useEffect(() => {
    if (!enabled) return;
    let cancel = false;
    fetch(`${API}/lint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    })
      .then((r) => { if (!cancel) setAvailable(r.ok); })
      .catch(() => { if (!cancel) setAvailable(false); });
    return () => { cancel = true; };
  }, [enabled]);

  const clearMarkers = useCallback(() => {
    if (!monaco) return;
    const model = editorRef.current?.getModel?.();
    if (model) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
  }, [monaco, editorRef]);

  const run = useCallback(async () => {
    if (!monaco || !editorRef.current) return;
    const model = editorRef.current.getModel?.();
    if (!model) return;
    const uri = model.uri.toString();
    const text = model.getValue();
    const mine = ++seq.current;
    setBusy(true);

    // Publish a placed issue list: markers + panel state + code-action source.
    const apply = (placed: PlacedIssue[]) => {
      placedByUri.set(uri, placed);
      ensureProvider(monaco);
      monaco.editor.setModelMarkers(
        model,
        MARKER_OWNER,
        placed.map((i) => ({
          severity: severityFor(monaco, i.kind),
          message: `${i.message}${i.suggestions.length ? `\nSuggestions: ${i.suggestions.slice(0, 5).join(', ')}` : ''}`,
          source: `Hilbert · ${i.kind}`,
          startLineNumber: i.range.startLineNumber,
          startColumn: i.range.startColumn,
          endLineNumber: i.range.endLineNumber,
          endColumn: i.range.endColumn,
        })),
      );
      setIssues(placed);
    };

    try {
      const raw = await requestLint(text);
      if (mine !== seq.current) return; // superseded by a newer run
      const placed = placeIssues(text, raw);
      apply(withSuggestions(placed)); // show squiggles + any already-cached fixes now
      setBusy(false);

      // Lazily enrich spelling fixes (off the hot path), then re-publish.
      const spellingWords = placed.filter((i) => i.kind === 'spelling').map((i) => i.text);
      if (spellingWords.some((w) => !suggestCache.has(w))) {
        await fetchSuggestions(spellingWords);
        if (mine === seq.current) apply(withSuggestions(placed));
      }
    } catch {
      if (mine === seq.current) {
        setAvailable(false); // no /lint route (Electron) — disable silently
        setIssues([]);
        clearMarkers();
        setBusy(false);
      }
    }
  }, [monaco, editorRef, clearMarkers]);

  // Debounced re-lint whenever the active content changes.
  useEffect(() => {
    if (!active) {
      setIssues([]);
      clearMarkers();
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(run, 700);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active, activeTabContent, activeTabPath, run, clearMarkers]);

  const jumpTo = useCallback(
    (issue: PlacedIssue) => {
      const ed = editorRef.current;
      if (!ed) return;
      ed.revealRangeInCenter(issue.range);
      ed.setPosition({ lineNumber: issue.range.startLineNumber, column: issue.range.startColumn });
      ed.focus();
    },
    [editorRef],
  );

  const applySuggestion = useCallback(
    (issue: PlacedIssue, replacement: string) => {
      const ed = editorRef.current;
      if (!ed) return;
      ed.executeEdits('proofread', [{ range: issue.range, text: replacement, forceMoveMarkers: true }]);
      ed.focus();
      run();
    },
    [editorRef, run],
  );

  const ignoreWord = useCallback(
    (issue: PlacedIssue) => {
      fetch(`${API}/lint/ignore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ word: issue.text }),
      })
        .then(() => run())
        .catch(() => {});
    },
    [run],
  );

  return { available, issues, busy, jumpTo, applySuggestion, ignoreWord, revalidate: run };
}
