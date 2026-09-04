import { useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { API } from './api';

export type ProblemSeverity = 'error' | 'warning' | 'info' | 'hint';

export type EditorProblem = {
  severity: ProblemSeverity;
  message: string;
  file?: string;
  line?: number;
  col?: number;
  source?: string;
};

type LspPosition = { line: number; character: number };
type LspDiagnostic = {
  range?: { start?: LspPosition; end?: LspPosition };
  severity?: number;
  message?: string;
  source?: string;
  code?: string | number | { value?: string | number };
};

type DiagnosticsResponse = {
  available?: boolean;
  diagnostics?: LspDiagnostic[];
  pending?: boolean;
};

const MARKER_OWNER = 'tinymist';

function problemSeverity(value?: number): ProblemSeverity {
  if (value === 2) return 'warning';
  if (value === 3) return 'info';
  if (value === 4) return 'hint';
  return 'error';
}

function markerSeverity(monaco: any, severity: ProblemSeverity): number {
  if (severity === 'warning') return monaco.MarkerSeverity.Warning;
  if (severity === 'info') return monaco.MarkerSeverity.Info;
  if (severity === 'hint') return monaco.MarkerSeverity.Hint;
  return monaco.MarkerSeverity.Error;
}

function codeLabel(code: LspDiagnostic['code']): string {
  if (typeof code === 'string' || typeof code === 'number') return String(code);
  if (code && (typeof code.value === 'string' || typeof code.value === 'number')) return String(code.value);
  return '';
}

export function useTinymistDiagnostics(
  monaco: any,
  editorRef: MutableRefObject<any>,
  activeTabPath: string | undefined,
  activeTabContent: string | undefined,
  mainFile: string | undefined,
) {
  const [problems, setProblems] = useState<EditorProblem[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [restartRevision, setRestartRevision] = useState(0);
  const seq = useRef(0);
  const markedModel = useRef<any>(null);

  useEffect(() => {
    const handleRestart = () => setRestartRevision(value => value + 1);
    window.addEventListener('hilbert:tinymist-restarted', handleRestart);
    return () => window.removeEventListener('hilbert:tinymist-restarted', handleRestart);
  }, []);

  useEffect(() => {
    const isTypst = !!activeTabPath && activeTabPath.toLowerCase().endsWith('.typ');
    const clear = () => {
      if (monaco && markedModel.current && !markedModel.current.isDisposed?.()) {
        monaco.editor.setModelMarkers(markedModel.current, MARKER_OWNER, []);
      }
      markedModel.current = null;
      setProblems([]);
    };

    if (!monaco || !isTypst || activeTabContent === undefined) {
      clear();
      setBusy(false);
      return;
    }

    const mine = ++seq.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setBusy(true);
      try {
        let data: DiagnosticsResponse = {};
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = await fetch(`${API}/lsp/diagnostics`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Which file the preview compiles. A chapter has to be checked as
            // part of its document, or every cross-file reference in it reads
            // as missing.
            body: JSON.stringify({ file: activeTabPath, content: activeTabContent, main: mainFile }),
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Tinymist diagnostics ${response.status}`);
          data = await response.json();
          if (!data.pending) break;
        }
        if (mine !== seq.current) return;
        setAvailable(data.available !== false);
        if (data.available === false || data.pending) {
          clear();
          return;
        }

        const model = editorRef.current?.getModel?.();
        if (!model || editorRef.current?.getValue?.() !== activeTabContent) return;
        if (markedModel.current && markedModel.current !== model && !markedModel.current.isDisposed?.()) {
          monaco.editor.setModelMarkers(markedModel.current, MARKER_OWNER, []);
        }
        markedModel.current = model;

        const placed = (Array.isArray(data.diagnostics) ? data.diagnostics : []).flatMap((diagnostic) => {
          const start = diagnostic.range?.start;
          const end = diagnostic.range?.end;
          if (!start || !end || !diagnostic.message) return [];
          const severity = problemSeverity(diagnostic.severity);
          const line = Math.max(1, start.line + 1);
          const col = Math.max(1, start.character + 1);
          const endLine = Math.max(line, end.line + 1);
          const endColumn = Math.max(endLine === line ? col + 1 : 1, end.character + 1);
          const code = codeLabel(diagnostic.code);
          return [{
            severity,
            message: diagnostic.message,
            file: activeTabPath,
            line,
            col,
            source: diagnostic.source || (code ? `Tinymist (${code})` : 'Tinymist'),
            marker: {
              severity: markerSeverity(monaco, severity),
              message: diagnostic.message,
              source: diagnostic.source || 'Tinymist',
              code: code || undefined,
              startLineNumber: line,
              startColumn: col,
              endLineNumber: endLine,
              endColumn,
            },
          }];
        });
        monaco.editor.setModelMarkers(model, MARKER_OWNER, placed.map(item => item.marker));
        setProblems(placed.map(({ marker: _marker, ...problem }) => problem));
      } catch {
        if (mine !== seq.current || controller.signal.aborted) return;
        setAvailable(false);
        clear();
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [monaco, editorRef, activeTabPath, activeTabContent, restartRevision, mainFile]);

  return { available, problems, busy };
}
