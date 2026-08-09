import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relativePath = 'src/editorClipboard.ts';
const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  fileName: relativePath,
}).outputText;
const module = { exports: {} };
Function('exports', 'module', 'require', output)(module.exports, module, specifier => {
  if (specifier === './clipboard') {
    return {
      readClipboard: async () => '',
      writeClipboard: async () => false,
    };
  }
  throw new Error(`Unexpected import: ${specifier}`);
});

const {
  editorSelectionPayload,
  copyEditorSelection,
  cutEditorSelection,
  pasteEditorClipboard,
} = module.exports;

const lines = ['alpha', 'beta', 'gamma'];
const valueInRange = range => {
  const before = lines.slice(0, range.startLineNumber - 1).join('\n');
  const start = (before ? before.length + 1 : 0) + range.startColumn - 1;
  const beforeEnd = lines.slice(0, range.endLineNumber - 1).join('\n');
  const end = (beforeEnd ? beforeEnd.length + 1 : 0) + range.endColumn - 1;
  return lines.join('\n').slice(start, end);
};
const selection = (startLineNumber, startColumn, endLineNumber = startLineNumber, endColumn = startColumn) => ({
  startLineNumber, startColumn, endLineNumber, endColumn,
  isEmpty: () => startLineNumber === endLineNumber && startColumn === endColumn,
});
const makeEditor = selections => {
  const calls = { edits: [], undoStops: 0, focus: 0 };
  return {
    calls,
    getModel: () => ({
      getLineCount: () => lines.length,
      getLineContent: line => lines[line - 1],
      getLineMaxColumn: line => lines[line - 1].length + 1,
      getValueInRange: valueInRange,
    }),
    getSelections: () => selections,
    executeEdits: (sourceName, edits) => calls.edits.push({ sourceName, edits }),
    pushUndoStop: () => { calls.undoStops++; return true; },
    focus: () => { calls.focus++; },
  };
};

// Empty cursors copy complete lines in document order and de-duplicate two
// cursors on the same line.
const lineEditor = makeEditor([selection(2, 3), selection(1, 2), selection(2, 1)]);
assert.deepEqual(editorSelectionPayload(lineEditor), {
  text: 'alpha\nbeta\n',
  ranges: [
    { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 },
    { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 },
  ],
});

// Real selections are copied in document order even when Monaco reports its
// multi-cursors in the opposite order.
const selectedEditor = makeEditor([selection(3, 1, 3, 6), selection(1, 2, 1, 5)]);
assert.equal(editorSelectionPayload(selectedEditor).text, 'lph\ngamma');
let copied = '';
assert.equal(await copyEditorSelection(selectedEditor, async text => { copied = text; return true; }), true);
assert.equal(copied, 'lph\ngamma');

// A failed native/browser clipboard write must never delete the selection.
assert.equal(await cutEditorSelection(selectedEditor, async () => false), false);
assert.equal(selectedEditor.calls.edits.length, 0);
assert.equal(selectedEditor.calls.undoStops, 0);

// Successful Cut and Paste are isolated undo steps and restore editor focus.
assert.equal(await cutEditorSelection(selectedEditor, async () => true), true);
assert.equal(selectedEditor.calls.edits[0].sourceName, 'hilbert.cut');
assert.equal(selectedEditor.calls.undoStops, 2);
assert.equal(selectedEditor.calls.focus, 1);

const pasteEditor = makeEditor([selection(1, 1), selection(3, 6)]);
assert.equal(await pasteEditorClipboard(pasteEditor, async () => 'inserted'), true);
assert.equal(pasteEditor.calls.edits[0].sourceName, 'hilbert.paste');
assert.equal(pasteEditor.calls.edits[0].edits.length, 2);
assert.equal(pasteEditor.calls.undoStops, 2);
assert.equal(pasteEditor.calls.focus, 1);

const emptyPasteEditor = makeEditor([selection(1, 1)]);
assert.equal(await pasteEditorClipboard(emptyPasteEditor, async () => ''), false);
assert.equal(emptyPasteEditor.calls.edits.length, 0);
assert.equal(emptyPasteEditor.calls.undoStops, 0);

console.log('editor clipboard tests passed');
