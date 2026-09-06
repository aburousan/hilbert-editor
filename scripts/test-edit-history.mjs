// One drag of a slider must be one undo.
//
// The Feynman builder's side panel sends a change per slider tick and per
// keystroke, and each one used to push its own history entry. Dragging Bend
// from one end to the other filled forty of the hundred available slots, so
// undoing that single drag meant pressing the key forty times and most of the
// earlier work fell off the bottom of the stack in the process.
//
// The drags below are the real ranges from the panel. A gesture is one entry
// and undo lands on the state from before it; anything else is the bug back.
//
//   node scripts/test-edit-history.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadTypeScriptModule(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
    fileName: relativePath,
  }).outputText;
  const module = { exports: {} };
  Function('exports', 'module', 'require', output)(module.exports, module, () => {
    throw new Error(`${relativePath} unexpectedly imported another module`);
  });
  return module.exports;
}

const { createHistory, GESTURE_WINDOW_MS } = loadTypeScriptModule('src/editHistory.ts');

// A stand-in for the editor: state is a value, and every change records the
// state that came before it exactly as commit() does in the component.
function editor(initial, limit) {
  const history = createHistory(limit);
  let state = initial;
  let clock = 1000;
  return {
    get state() { return state; },
    get canUndo() { return history.canUndo(); },
    get canRedo() { return history.canRedo(); },
    wait(ms) { clock += ms; },
    change(next, key) { history.record(state, key, (clock += 16)); state = next; },
    undo() { const p = history.undo(state); if (p !== undefined) state = p; },
    redo() { const n = history.redo(state); if (n !== undefined) state = n; },
  };
}

let failures = 0;
const check = (name, run) => {
  try { run(); console.log(`  ok   ${name}`); }
  catch (error) { failures++; console.log(`  FAIL ${name}\n       ${error.message}`); }
};

check('one drag of the bend slider is one undo', () => {
  const e = editor({ bend: 0 }, 100);
  e.change({ bend: 40 }, '7:thickness');      // an earlier, unrelated edit
  const before = e.state;
  for (let bend = -100; bend <= 100; bend += 5) e.change({ bend }, '7:bend');
  assert.equal(e.state.bend, 100, 'the drag should have moved the value');
  e.undo();
  assert.deepEqual(e.state, before, 'one undo should step back over the whole drag');
});

check('a drag does not consume the history behind it', () => {
  const e = editor({ bend: 0, radius: 12 }, 100);
  for (let i = 0; i < 90; i++) e.change({ bend: 0, radius: 12, step: i });
  const deep = e.state;
  for (let radius = 12; radius <= 120; radius += 2) e.change({ ...deep, radius }, '3:radius');
  e.undo();
  assert.deepEqual(e.state, deep, 'undo should return to the state before the drag');
  // 54 ticks folded into one entry, so all 90 earlier edits must still be there.
  for (let i = 0; i < 90; i++) e.undo();
  assert.equal(e.canUndo, false, 'the earlier edits should have survived the drag');
});

check('typing a label is one undo, not one per keystroke', () => {
  const e = editor({ label: '' }, 100);
  const word = 'gamma';
  const before = e.state;
  for (let i = 1; i <= word.length; i++) e.change({ label: word.slice(0, i) }, '2:label');
  assert.equal(e.state.label, 'gamma');
  e.undo();
  assert.deepEqual(e.state, before);
});

check('a different property starts its own entry', () => {
  const e = editor({ bend: 0, thickness: 1 }, 100);
  e.change({ bend: 50, thickness: 1 }, '1:bend');
  e.change({ bend: 50, thickness: 2 }, '1:thickness');
  e.undo();
  assert.deepEqual(e.state, { bend: 50, thickness: 1 }, 'thickness should undo on its own');
  e.undo();
  assert.deepEqual(e.state, { bend: 0, thickness: 1 }, 'then bend should undo on its own');
});

check('the same property on a different element starts its own entry', () => {
  const e = editor({ a: 0, b: 0 }, 100);
  e.change({ a: 50, b: 0 }, '1:bend');
  e.change({ a: 50, b: 50 }, '2:bend');
  e.undo();
  assert.deepEqual(e.state, { a: 50, b: 0 });
});

check('a pause splits one gesture into two', () => {
  const e = editor({ bend: 0 }, 100);
  e.change({ bend: 20 }, '1:bend');
  e.wait(GESTURE_WINDOW_MS + 50);
  e.change({ bend: 40 }, '1:bend');
  e.undo();
  assert.deepEqual(e.state, { bend: 20 }, 'the pause should have closed the first gesture');
});

check('changes with no key never fold together', () => {
  const e = editor([], 100);
  e.change(['a']);
  e.change(['a', 'b']);
  e.undo();
  assert.deepEqual(e.state, ['a']);
});

check('undo then dragging again does not fold onto a stepped-past entry', () => {
  const e = editor({ bend: 0 }, 100);
  e.change({ bend: 10 }, '1:bend');
  e.undo();
  assert.deepEqual(e.state, { bend: 0 });
  e.change({ bend: 30 }, '1:bend');
  e.undo();
  assert.deepEqual(e.state, { bend: 0 }, 'the second drag needs an entry of its own');
});

check('redo replays a folded gesture as one step', () => {
  const e = editor({ bend: 0 }, 100);
  const before = e.state;
  for (let bend = 0; bend <= 100; bend += 5) e.change({ bend }, '1:bend');
  e.undo();
  assert.deepEqual(e.state, before);
  e.redo();
  assert.deepEqual(e.state, { bend: 100 }, 'one redo should replay the whole drag');
});

check('the stack still honours its limit', () => {
  const e = editor(0, 10);
  for (let i = 1; i <= 25; i++) e.change(i);
  let steps = 0;
  while (e.canUndo) { e.undo(); steps++; }
  assert.equal(steps, 10, 'the oldest entries beyond the limit should be dropped');
});

console.log(failures ? `\n${failures} failed` : '\nall edit-history checks passed');
process.exit(failures ? 1 : 0);
