import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

async function loadTypeScriptModule(path) {
  const source = await readFile(resolve(path), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: path,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
}

const toolbar = await loadTypeScriptModule('src/toolbarPreferences.ts');
assert.equal(toolbar.TOOLBAR_TOOL_IDS.length, 28);
assert.deepEqual(toolbar.normalizeHiddenToolbarTools(null), []);
assert.deepEqual(toolbar.normalizeHiddenToolbarTools(['bold', 'unknown', 'bold', 4, 'save']), ['bold', 'save']);
assert.equal(new Set(toolbar.TOOLBAR_TOOL_IDS).size, toolbar.TOOLBAR_TOOL_IDS.length, 'toolbar tool ids must be unique');

const recovery = await loadTypeScriptModule('src/emergencyDrafts.ts');
const draft = recovery.createEmergencyDraft('/srv/project', 'main.typ', 'local edit', 'base-hash', 1234);
assert.equal(draft.workspace, '/srv/project');
assert.equal(draft.path, 'main.typ');
assert.equal(draft.savedAt, 1234);
assert.equal(recovery.classifyEmergencyDraft(draft, { content: 'local edit', hash: 'new-hash' }), 'already-saved');
assert.equal(recovery.classifyEmergencyDraft(draft, { content: 'old server', hash: 'base-hash' }), 'safe-to-replay');
assert.equal(recovery.classifyEmergencyDraft(draft, { content: 'other edit', hash: 'other-hash' }), 'conflict');
assert.equal(
  recovery.classifyEmergencyDraft(
    recovery.createEmergencyDraft('/srv/project', 'new.typ', 'new file', undefined, 1234),
    { content: '', hash: undefined },
  ),
  'safe-to-replay',
);

console.log('toolbar preference and emergency recovery tests passed');
