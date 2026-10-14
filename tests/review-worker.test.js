import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { analyzeFile } from '../src/core.js';
import { calculateReviewSelection } from '../src/review.js';
import { demoProject } from '../src/demo.js';
import { demoReviewDiff } from '../src/review-demo.js';

const workerUrl = new URL('../src/review-worker.js', import.meta.url).href;
const file = (path, content = 'export const value = 2;\n') => analyzeFile({ path, content });
const diff = (path = 'root.ts') => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n`;

function startWorker(t) {
  // Exercise the production module and its cache; bridge only browser transport.
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: data => parentPort.postMessage(data) };
    import(${JSON.stringify(workerUrl)}).then(() => {
      parentPort.on('message', data => self.onmessage({ data }));
    });
  `, { eval: true });
  t.after(() => worker.terminate());
  let sequence = 0;
  return data => new Promise((resolve, reject) => {
    const requestId = ++sequence;
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off('message', onMessage);
      worker.off('error', onError);
    };
    const onMessage = result => { cleanup(); resolve(result); };
    const onError = error => { cleanup(); reject(error); };
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Review worker did not respond')); }, 5000);
    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.postMessage({ requestId, budget: Infinity, diff: diff(), ...data });
  });
}

test('review worker requires a project, then returns plans without imported source bodies', async t => {
  const request = startWorker(t);
  assert.equal((await request({})).error, true);
  const files = [file('root.ts', 'export const value = 2;\nimport "./dep";\n// PRIVATE_SOURCE_SENTINEL'),
    file('dep.ts', 'const password = "private-source-credential";\n'), file('unrelated.ts', 'UNRELATED_SOURCE_SENTINEL')];
  const response = await request({ files });
  assert.deepEqual(response.plan.selectedIds, ['root.ts', 'dep.ts']);
  assert.equal(response.plan.tokens, calculateReviewSelection(files, response.plan.selectedIds, response.plan).tokens);
  assert.deepEqual(response.plan.mismatched, []);
  assert.doesNotMatch(JSON.stringify(response), /PRIVATE_SOURCE_SENTINEL|private-source-credential|UNRELATED_SOURCE_SENTINEL/);
  assert.match(response.plan.changes[0].patch, /export const value = 2/);
});

test('review worker cached requests apply new budgets, options and patches', async t => {
  const request = startWorker(t);
  const files = [file('root.ts', 'export const value = 2;\nimport "./dep";\n'), file('dep.ts'),
    file('caller.ts', 'import "./root";\n'), file('root.test.ts', 'import "./root";\n')];
  const initial = await request({ files });
  assert.deepEqual(initial.plan.selectedIds, ['root.ts', 'dep.ts', 'caller.ts', 'root.test.ts']);
  const bounded = await request({ budget: initial.plan.mandatoryTokens, options: { includeCallers: false, includeTests: false } });
  assert.deepEqual(bounded.plan.selectedIds, ['root.ts']);
  assert.ok(bounded.plan.tokens <= initial.plan.mandatoryTokens);
  assert.equal(bounded.plan.overBudget, false);
  assert.deepEqual(bounded.plan.candidates.map(item => item.id), ['root.ts', 'dep.ts']);
  const different = await request({ diff: diff('dep.ts'), options: { includeCallers: false, includeTests: false } });
  assert.deepEqual(different.plan.selectedIds, ['dep.ts']);
  assert.equal(different.plan.changes[0].path, 'dep.ts');
});

test('review worker replacement resets dependencies and filter rules despite matching file IDs', async t => {
  const request = startWorker(t);
  const first = [file('root.ts', 'export const value = 2;\nimport "./previous"; import "./missing";\n'), file('previous.ts')];
  const initial = await request({ files: first, rules: { patterns: ['filtered.ts'] } });
  assert.equal(initial.plan.unresolved[0].specifier, './missing');
  const second = [file('root.ts', 'export const value = 2;\nimport "./current";\n'), file('current.ts'), file('filtered.ts')];
  const replacement = await request({ files: second });
  assert.deepEqual(replacement.plan.selectedIds, ['root.ts', 'current.ts']);
  assert.deepEqual(replacement.plan.unresolved, []);
  assert.doesNotMatch(JSON.stringify(replacement), /previous|\.\/missing/);
  const noOldRules = await request({ diff: diff('filtered.ts') });
  assert.deepEqual(noOldRules.plan.selectedIds, ['filtered.ts']);
});

test('review worker clears cached state on failure, leaks no error payload, and recovers with fresh files', async t => {
  const request = startWorker(t);
  await request({ files: [file('root.ts')] });
  const failed = await request({ diff: 'invalid patch PRIVATE_ERROR_SENTINEL' });
  assert.equal(failed.error, true);
  assert.equal(failed.code, 'INVALID_DIFF');
  assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_ERROR_SENTINEL|invalid patch/);
  assert.equal((await request({})).error, true);
  const recovered = await request({ files: [file('root.ts')] });
  assert.deepEqual(recovered.plan.selectedIds, ['root.ts']);
});

test('built-in Review demo matches its imported snapshot and produces related context in the real worker', async t => {
  const request = startWorker(t);
  const files = demoProject.files.map(analyzeFile);
  const result = await request({ files, diff: demoReviewDiff(), budget: 8000 });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.plan.missing, []);
  assert.deepEqual(result.plan.mismatched, []);
  assert.equal(result.plan.changes.length, 2);
  assert.ok(result.plan.selectedIds.includes('src/lib/storage.ts'));
  assert.ok(result.plan.selectedIds.includes('src/hooks/useNotes.ts'));
  assert.ok(result.plan.selectedIds.includes('tests/storage.test.ts'));
  assert.equal(result.plan.overBudget, false);
  assert.equal(result.plan.tokens, calculateReviewSelection(files, result.plan.selectedIds, result.plan).tokens);
});
