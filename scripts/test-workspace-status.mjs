import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const source = await readFile(resolve('src/workspaceStatus.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { deriveWorkspaceStatus } = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);

const base = {
  backendReady: true,
  hasDirty: false,
  activeSaves: 0,
  recovery: 'idle',
  saveError: null,
  externalConflict: false,
  isCompiling: false,
  compileStalled: false,
  compileError: null,
  collaboration: null,
};
const status = overrides => deriveWorkspaceStatus({ ...base, ...overrides });

assert.equal(status({ backendReady: false }).label, 'Opening project…');
assert.equal(status({ externalConflict: true, isCompiling: true }).label, 'Save needs attention');
assert.equal(status({ hasDirty: true, recovery: 'failed' }).label, 'Local recovery unavailable');
assert.equal(status({ hasDirty: true, recovery: 'saved', activeSaves: 2 }).label, 'Saving to project…');
assert.equal(status({ hasDirty: true, recovery: 'saved', saveError: 'disk full' }).label, 'Save failed · recovery copy safe');
assert.equal(status({ hasDirty: true, recovery: 'saved' }).label, 'Changes safe on this device');
assert.equal(status({ hasDirty: true, recovery: 'saving' }).label, 'Saving recovery copy…');
assert.equal(status({ isCompiling: true }).label, 'Saved · compiling…');
assert.equal(status({ isCompiling: true, compileStalled: true }).label, 'Saved · still compiling…');
assert.equal(status({ compileError: 'Typst: unexpected token' }).label, 'Saved · preview has errors');
assert.equal(status({ compileError: "Couldn't reach Hilbert's document service." }).label, 'Saved locally · service offline');

const offline = status({ collaboration: { status: 'disconnected', peers: 1, transferring: 0 } });
assert.equal(offline.label, 'Collaboration offline · saved locally');
assert.equal(offline.action, 'collaboration');
assert.equal(status({ collaboration: { status: 'syncing', peers: 2, transferring: 0 } }).label, 'Syncing project…');
assert.equal(status({ collaboration: { status: 'synced', peers: 2, transferring: 0 } }).label, 'Synced with 1 collaborator');
assert.equal(status({ collaboration: { status: 'synced', peers: 3, transferring: 0 } }).label, 'Synced with 2 collaborators');
assert.equal(status({ collaboration: { status: 'connected', peers: 1, transferring: 3 } }).label, 'Receiving 3 files…');

// Local safety outranks background activity and stale compile diagnostics.
assert.equal(status({ hasDirty: true, recovery: 'failed', isCompiling: true, compileError: 'old error' }).tone, 'error');
assert.equal(status({ hasDirty: true, recovery: 'saved', collaboration: { status: 'error', peers: 1, transferring: 0 } }).label,
  'Offline · changes safe locally');
assert.equal(status({}).label, 'Saved locally');

console.log('workspace status precedence tests passed');
