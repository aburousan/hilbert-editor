import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const load = async name => {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  Function('exports', 'module', code)(module.exports, module);
  return module.exports;
};
const { createLatestTask } = await load('latestTask');
const { createPdfTextCache } = await load('pdfTextCache');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const started = [];
let release;
const queue = createLatestTask(async value => {
  started.push(value);
  if (value === 'first') await new Promise(resolve => { release = resolve; });
});
const first = queue.request('first');
queue.request('obsolete');
const final = queue.request('latest');
assert.deepEqual(started, ['first']);
release();
await final;
await first;
assert.deepEqual(started, ['first', 'latest']);

const isolated = [];
const other = createLatestTask(async value => { isolated.push(value); });
await other.request('other window');
assert.deepEqual(started, ['first', 'latest']);
assert.deepEqual(isolated, ['other window']);
const held = queue.request('first');
queue.request('cancelled');
queue.cancelPending();
release();
await held;
assert.ok(!started.includes('cancelled'));
const errors = createLatestTask(async value => { if (value === 'fail') throw Error('expected'); });
await assert.rejects(errors.request('fail'), /expected/);
await errors.request('recover');

const cache = createPdfTextCache();
let reads = 0;
let releaseText;
const doc = { getPage: async () => ({ getTextContent: async () => {
  reads++;
  await new Promise(resolve => { releaseText = resolve; });
  return { items: [{ str: 'Hello ', hasEOL: false }, { str: 'world', hasEOL: true }, { str: 'again' }] };
} }) };
const text = cache.read(doc, 1);
const count = cache.count(doc, 1);
await tick();
assert.equal(reads, 1, 'Concurrent rendering/counting share text extraction');
releaseText();
await text;
assert.equal(await count, 3);
assert.equal(await cache.count(doc, 1), 3);
assert.equal(reads, 1, 'Counting an extracted page does not read it again');
const secondDoc = { getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'Different' }] }) }) };
assert.equal(await cache.count(secondDoc, 1), 1, 'Document identities do not share page counts');
let failed = true;
const retryDoc = { getPage: async () => ({ getTextContent: async () => {
  if (failed) { failed = false; throw Error('retry'); }
  return { items: [] };
} }) };
await assert.rejects(cache.count(retryDoc, 1), /retry/);
assert.equal(await cache.count(retryDoc, 1), 0);
console.log('Background work: latest-only queues, isolation, cancellation, recovery and PDF text reuse passed.');
