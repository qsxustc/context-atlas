import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { analyzeFile, calculateSelection } from '../src/core.js';

const workerUrl = new URL('../src/focus-worker.js', import.meta.url).href;
const file = (path, content = 'export const value = 1;\n') => analyzeFile({ path, content });

function startWorker(t) {
  // Bridge only the browser worker transport. All parsing, planning and cached
  // state run in the actual production module in an isolated worker thread.
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
    const timeout = setTimeout(() => { cleanup(); reject(new Error('Focus worker did not respond')); }, 5000);
    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.postMessage({ requestId, budget: Infinity, ...data });
  });
}

test('focus worker requires a project and then handles real parsed dependencies without returning source content', async t => {
  const request = startWorker(t);
  assert.deepEqual(await request({ rootId: 'src/root.ts' }), { requestId: 1, error: true });
  const secret = 'never-return-this-credential-0987654321';
  const files = [
    file('src/root.ts', `import './dep';\nconst password = '${secret}';\n`),
    file('src/dep.ts'),
    file('src/unrelated.ts', 'UNRELATED_SOURCE_SENTINEL'),
  ];
  const response = await request({ files, rootId: 'src/root.ts' });
  assert.equal(response.requestId, 2);
  assert.deepEqual(response.plan.selectedIds, ['src/root.ts', 'src/dep.ts']);
  assert.equal(response.projectTokens, calculateSelection(files, files.map(item => item.id)).tokens);
  assert.equal(response.plan.tokens, calculateSelection(files, response.plan.selectedIds).tokens);
  assert.ok(!JSON.stringify(response).includes(secret));
  assert.ok(!JSON.stringify(response).includes('UNRELATED_SOURCE_SENTINEL'));
  assert.ok(!JSON.stringify(response).includes("import './dep'"));
});

test('focus worker cached requests apply fresh budgets and options without requiring a second file upload', async t => {
  const request = startWorker(t);
  const files = [
    file('root.ts', "import './dep';\n"), file('dep.ts'),
    file('caller.ts', "import './root';\n"), file('root.test.ts', "import './root';\n"),
  ];
  const original = await request({ files, rootId: 'root.ts' });
  assert.deepEqual(original.plan.selectedIds, ['root.ts', 'dep.ts', 'caller.ts', 'root.test.ts']);
  const rootBudget = calculateSelection(files, ['root.ts']).tokens;
  const limited = await request({ rootId: 'root.ts', budget: rootBudget, options: { includeCallers: false, includeTests: false } });
  assert.deepEqual(limited.plan.selectedIds, ['root.ts']);
  assert.equal(limited.plan.tokens, rootBudget);
  assert.equal(limited.plan.overBudget, false);
  assert.deepEqual(limited.plan.candidates.map(item => item.id), ['root.ts', 'dep.ts']);
  const rebuilt = await request({ rootId: 'root.ts', options: { includeCallers: true, includeTests: true } });
  assert.deepEqual(rebuilt.plan, original.plan);
  assert.equal(rebuilt.projectTokens, original.projectTokens);
  assert.equal(rebuilt.requestId, 3);
});

test('focus worker project replacement discards old dependencies, diagnostics and token totals even when root IDs match', async t => {
  const request = startWorker(t);
  const first = [
    file('root.ts', "import './previous-dependency'; import './previous-missing';\n"),
    file('previous-dependency.ts', 'FIRST_PROJECT_SOURCE'.repeat(300)),
  ];
  const firstResponse = await request({ files: first, rootId: 'root.ts' });
  assert.equal(firstResponse.plan.unresolved[0].specifier, './previous-missing');
  const second = [file('root.ts', "import './current-dependency';\n"), file('current-dependency.ts')];
  const replacement = await request({ files: second, rootId: 'root.ts' });
  assert.deepEqual(replacement.plan.selectedIds, ['root.ts', 'current-dependency.ts']);
  assert.deepEqual(replacement.plan.unresolved, []);
  assert.equal(replacement.projectTokens, calculateSelection(second, second.map(item => item.id)).tokens);
  assert.notEqual(replacement.projectTokens, firstResponse.projectTokens);
  assert.ok(!JSON.stringify(replacement).includes('previous-'));
  const cached = await request({ rootId: 'root.ts' });
  assert.deepEqual(cached.plan, replacement.plan);
  assert.equal(cached.projectTokens, replacement.projectTokens);
  const oldRoot = await request({ rootId: 'previous-dependency.ts' });
  assert.deepEqual(oldRoot.plan.selectedIds, []);
});

test('focus worker clears its cache after a failed project replacement and recovers on a fresh project', async t => {
  const request = startWorker(t);
  await request({ files: [file('root.ts', 'FIRST_PROJECT_SOURCE'.repeat(200))], rootId: 'root.ts' });
  const invalid = { ...file('invalid.ts'), path: '../outside.ts' };
  const failed = await request({ files: [file('root.ts'), invalid], rootId: 'root.ts' });
  assert.deepEqual(failed, { requestId: 2, error: true });
  assert.deepEqual(await request({ rootId: 'root.ts' }), { requestId: 3, error: true },
    'a cached request must not combine a partial new project with old project metadata');
  const fresh = [file('root.ts')];
  const recovered = await request({ files: fresh, rootId: 'root.ts' });
  assert.deepEqual(recovered.plan.selectedIds, ['root.ts']);
  assert.equal(recovered.projectTokens, calculateSelection(fresh, ['root.ts']).tokens);
});
