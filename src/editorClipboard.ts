import { readClipboard, writeClipboard } from './clipboard';

export interface EditorRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

interface EditorSelection extends EditorRange {
  isEmpty(): boolean;
}

interface EditorModel {
  getLineCount(): number;
  getLineContent(line: number): string;
  getLineMaxColumn(line: number): number;
  getValueInRange(range: EditorRange): string;
}

export interface ClipboardEditor {
  getModel(): EditorModel | null;
  getSelections(): EditorSelection[] | null;
  executeEdits(source: string, edits: { range: EditorRange; text: string; forceMoveMarkers: boolean }[]): void;
  pushUndoStop(): boolean;
  focus(): void;
}

export interface EditorSelectionPayload {
  text: string;
  ranges: EditorRange[];
}

// Match Monaco's useful no-selection behaviour: Cut and Copy take the whole
// current line. Multiple cursors on the same line still copy that line once.
export function editorSelectionPayload(editor: ClipboardEditor): EditorSelectionPayload {
  const model = editor.getModel();
  const selections = editor.getSelections() || [];
  if (!model || selections.length === 0) return { text: '', ranges: [] };

  if (selections.every(selection => selection.isEmpty())) {
    const lines = [...new Set(selections.map(selection => selection.startLineNumber))].sort((a, b) => a - b);
    const ranges = lines.map<EditorRange>(line => (
      line < model.getLineCount()
        ? { startLineNumber: line, startColumn: 1, endLineNumber: line + 1, endColumn: 1 }
        : { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) }
    ));
    return { text: lines.map(line => model.getLineContent(line)).join('\n') + '\n', ranges };
  }

  const ordered = [...selections].sort((a, b) =>
    a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn);
  return {
    text: ordered.map(selection => model.getValueInRange(selection)).join('\n'),
    ranges: ordered,
  };
}

export async function copyEditorSelection(
  editor: ClipboardEditor,
  write: (text: string) => Promise<boolean> = writeClipboard,
): Promise<boolean> {
  const { text } = editorSelectionPayload(editor);
  return !!text && write(text);
}

export async function cutEditorSelection(
  editor: ClipboardEditor,
  write: (text: string) => Promise<boolean> = writeClipboard,
): Promise<boolean> {
  const { text, ranges } = editorSelectionPayload(editor);
  if (!text || !await write(text)) return false;

  // A mouse Cut/Paste must be one undo step, just like its keyboard equivalent.
  // Without both stops Monaco can merge it into the typing immediately before
  // or after it, so Undo unexpectedly removes more than the menu action did.
  editor.pushUndoStop();
  editor.executeEdits('hilbert.cut', ranges.map(range => ({ range, text: '', forceMoveMarkers: true })));
  editor.pushUndoStop();
  editor.focus();
  return true;
}

export async function pasteEditorClipboard(
  editor: ClipboardEditor,
  read: () => Promise<string> = readClipboard,
): Promise<boolean> {
  const text = await read();
  if (!text) return false;
  const selections = editor.getSelections() || [];
  if (selections.length === 0) return false;

  editor.pushUndoStop();
  editor.executeEdits('hilbert.paste', selections.map(range => ({ range, text, forceMoveMarkers: true })));
  editor.pushUndoStop();
  editor.focus();
  return true;
}
