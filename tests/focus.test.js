import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFile, buildContext, calculateSelection, estimateTokens } from '../src/core.js';
import { buildFocusPlan } from '../src/focus.js';

const file = (path, content = 'export const value = 1;\n') => analyzeFile({ path, content });
function makeGraph(files, edges = [], unresolved = []) {
  const graph = {
    dependencies: new Map(files.map(item => [item.id, new Set()])),
    dependents: new Map(files.map(item => [item.id, new Set()])),
    unresolved: new Map(unresolved), supported: new Set(files.map(item => item.id)),
  };
  for (const [source, target] of edges) {
    graph.dependencies.get(source).add(target);
    graph.dependents.get(target)?.add(source);
  }
  return graph;
}

test('focus walks cyclic dependencies breadth-first, keeps the root first and excludes unrelated files', () => {
  const files = ['src/root.ts', 'src/b.ts', 'src/a.ts', 'src/c.ts', 'src/unrelated.ts'].map(path => file(path));
  const edges = [['src/root.ts', 'src/b.ts'], ['src/root.ts', 'src/a.ts'], ['src/a.ts', 'src/c.ts'], ['src/c.ts', 'src/root.ts']];
  const graph = makeGraph(files, edges);
  const plan = buildFocusPlan(files, graph, 'src/root.ts', Infinity);
  assert.deepEqual(plan.selectedIds, ['src/root.ts', 'src/a.ts', 'src/b.ts', 'src/c.ts']);
  assert.deepEqual(plan.candidates.map(({ id, kind, via, depth }) => ({ id, kind, via, depth })), [
    { id: 'src/root.ts', kind: 'root', via: undefined, depth: 0 },
    { id: 'src/a.ts', kind: 'dependency', via: 'src/root.ts', depth: 1 },
    { id: 'src/b.ts', kind: 'dependency', via: 'src/root.ts', depth: 1 },
    { id: 'src/c.ts', kind: 'dependency', via: 'src/a.ts', depth: 2 },
  ]);
  assert.equal(plan.omittedCount, 0);
  assert.equal(plan.overBudget, false);
  assert.equal(plan.tokens, calculateSelection(files, plan.selectedIds).tokens);
  assert.deepEqual(buildFocusPlan([...files].reverse(), makeGraph(files, [...edges].reverse()), 'src/root.ts', Infinity), plan);
});

test('focus fits whole files at an inclusive conservative export budget and reports omissions', () => {
  const files = [file('src/root.ts', '"<&你好"'), file('src/a.ts', '`'.repeat(40)), file('src/b.ts', 'const api_key = "real-credential-value";')];
  const graph = makeGraph(files, [['src/root.ts', 'src/a.ts'], ['src/root.ts', 'src/b.ts']]);
  const fullTokens = calculateSelection(files, files.map(item => item.id)).tokens;
  const exact = buildFocusPlan(files, graph, 'src/root.ts', fullTokens);
  assert.equal(exact.tokens, fullTokens);
  assert.equal(exact.omittedCount, 0);
  for (const format of ['markdown', 'xml']) for (const redact of [true, false]) {
    assert.ok(estimateTokens(buildContext(files, exact.selectedIds, { format, redact })) <= exact.tokens);
  }
  const bounded = buildFocusPlan(files, graph, 'src/root.ts', fullTokens - 1);
  assert.ok(bounded.tokens <= fullTokens - 1);
  assert.equal(bounded.allTokens, fullTokens);
  assert.equal(bounded.omittedCount, 1);
  assert.equal(bounded.candidates.filter(item => !item.included).length, 1);
  const justRoot = buildFocusPlan(files, graph, 'src/root.ts', calculateSelection(files, ['src/root.ts']).tokens);
  assert.deepEqual(justRoot.selectedIds, ['src/root.ts']);
  assert.equal(justRoot.overBudget, false);
});

test('focus always keeps an oversized root and handles empty input and invalid budgets', () => {
  const files = [file('root.js'), file('dep.js')];
  const graph = makeGraph(files, [['root.js', 'dep.js']]);
  for (const budget of [0, -1, NaN, -Infinity, undefined, calculateSelection(files, ['root.js']).tokens - 1]) {
    const plan = buildFocusPlan(files, graph, 'root.js', budget);
    assert.deepEqual(plan.selectedIds, ['root.js']);
    assert.equal(plan.overBudget, true);
    assert.equal(plan.omittedCount, 1);
  }
  const empty = { selectedIds: [], candidates: [], unresolved: [], tokens: 0, allTokens: 0, overBudget: false, omittedCount: 0 };
  assert.deepEqual(buildFocusPlan([], makeGraph([]), 'missing.js', 0), empty);
  assert.deepEqual(buildFocusPlan(files, graph, 'missing.js', Infinity), empty);
  assert.deepEqual(buildFocusPlan(files, null, 'root.js', Infinity), empty);
  assert.deepEqual(buildFocusPlan(files, makeGraph([]), 'root.js', Infinity), empty);
});

test('focus adds only direct callers and related tests, with independent toggles', () => {
  const files = ['src/math.ts', 'src/helper.ts', 'src/useMath.ts', 'src/page.ts', 'src/callerOnly.ts', 'tests/math.test.ts', 'tests/helper.spec.ts', 'tests/unrelated.test.ts']
    .map(path => file(path));
  const graph = makeGraph(files, [
    ['src/math.ts', 'src/helper.ts'], ['src/useMath.ts', 'src/math.ts'],
    ['src/useMath.ts', 'src/callerOnly.ts'], ['src/page.ts', 'src/useMath.ts'],
    ['tests/math.test.ts', 'src/math.ts'], ['tests/helper.spec.ts', 'src/helper.ts'],
  ]);
  const plan = buildFocusPlan(files, graph, 'src/math.ts', Infinity);
  assert.deepEqual(plan.selectedIds, ['src/math.ts', 'src/helper.ts', 'src/useMath.ts', 'tests/math.test.ts', 'tests/helper.spec.ts']);
  assert.equal(plan.candidates.find(item => item.id === 'src/useMath.ts').kind, 'caller');
  assert.equal(plan.candidates.find(item => item.id === 'tests/math.test.ts').matchedBy, 'import');
  assert.deepEqual(buildFocusPlan(files, graph, 'src/math.ts', Infinity, { includeTests: false }).selectedIds,
    ['src/math.ts', 'src/helper.ts', 'src/useMath.ts']);
  assert.deepEqual(buildFocusPlan(files, graph, 'src/math.ts', Infinity, { includeCallers: false }).selectedIds,
    ['src/math.ts', 'src/helper.ts', 'tests/math.test.ts', 'tests/helper.spec.ts']);
  assert.deepEqual(buildFocusPlan(files, graph, 'src/math.ts', Infinity, { includeCallers: false, includeTests: false }).selectedIds,
    ['src/math.ts', 'src/helper.ts']);
});

test('filename-related tests support colocated, mirrored and __tests__ conventions without unrelated names', () => {
  const files = ['src/lib/math.ts', 'src/lib/math.spec.ts', 'src/lib/__tests__/math.ts', 'tests/lib/math.test.ts', 'test/math.test.ts', 'tests/unrelated.test.ts', 'src/lib/math.css']
    .map(path => file(path));
  const plan = buildFocusPlan(files, makeGraph(files), 'src/lib/math.ts', Infinity);
  assert.equal(plan.candidates.length, 5);
  for (const candidate of plan.candidates.slice(1)) {
    assert.equal(candidate.kind, 'test');
    assert.equal(candidate.matchedBy, 'filename');
    assert.equal(candidate.via, 'src/lib/math.ts');
  }
  assert.ok(!plan.selectedIds.includes('tests/unrelated.test.ts'));
  assert.ok(!plan.selectedIds.includes('src/lib/math.css'));
});

test('ambiguous filename tests stay scoped to the matching source directory', () => {
  const files = ['src/a/index.ts', 'src/b/index.ts', 'src/a/index.test.ts', 'src/b/index.test.ts', 'tests/a/index.spec.ts', 'tests/index.test.ts']
    .map(path => file(path));
  const plan = buildFocusPlan(files, makeGraph(files), 'src/a/index.ts', Infinity);
  assert.deepEqual(plan.selectedIds, ['src/a/index.ts', 'src/a/index.test.ts', 'tests/a/index.spec.ts']);
});

test('test files explicitly imported by the root remain required dependencies when optional tests are off', () => {
  const files = ['src/root.ts', 'tests/fixture.test.ts'].map(path => file(path));
  const plan = buildFocusPlan(files, makeGraph(files, [['src/root.ts', 'tests/fixture.test.ts']]), 'src/root.ts', Infinity, { includeTests: false });
  assert.deepEqual(plan.selectedIds, ['src/root.ts', 'tests/fixture.test.ts']);
  assert.equal(plan.candidates[1].kind, 'dependency');
  assert.deepEqual(buildFocusPlan(files, makeGraph(files), 'tests/fixture.test.ts', Infinity, { includeTests: false }).selectedIds,
    ['tests/fixture.test.ts']);
});

test('focus ignores absent graph files and unknown targets, preserving arbitrary IDs and all inputs', () => {
  const root = { ...file('src/root.ts'), id: 'root-id' };
  const dep = { ...file('src/dep.ts'), id: 'dep-id' };
  const extra = file('src/extra.ts');
  const files = [root, dep, extra];
  const graph = makeGraph([root, dep], [['root-id', 'dep-id'], ['root-id', 'unknown-id'], ['root-id', extra.id]]);
  const before = structuredClone({ files, graph });
  files.forEach(Object.freeze);
  Object.freeze(files);
  const plan = buildFocusPlan(files, graph, 'root-id', Infinity);
  assert.deepEqual(plan.selectedIds, ['root-id', 'dep-id']);
  assert.deepEqual({ files, graph }, before);
});

test('focus exposes stable, deduplicated missing-import diagnostics even for candidates omitted by budget', () => {
  const files = ['root.ts', 'dep.ts', 'unrelated.ts'].map(path => file(path));
  const graph = makeGraph(files, [['root.ts', 'dep.ts']], [
    ['root.ts', [{ specifier: './missing', reason: 'not-found' }, { specifier: './missing', reason: 'not-found' }]],
    ['dep.ts', [{ specifier: '../outside', reason: 'outside-root' }]],
    ['unrelated.ts', [{ specifier: './other', reason: 'not-found' }]],
  ]);
  const plan = buildFocusPlan(files, graph, 'root.ts', 0);
  assert.deepEqual(plan.unresolved, [
    { id: 'root.ts', specifier: './missing', reason: 'not-found' },
    { id: 'dep.ts', specifier: '../outside', reason: 'outside-root' },
  ]);
});

test('deep dependency chains do not recurse and respect the same full-plan estimate', () => {
  const files = Array.from({ length: 1000 }, (_, index) => file(`src/file-${String(index).padStart(4, '0')}.ts`));
  const graph = makeGraph(files, files.slice(1).map((item, index) => [files[index].id, item.id]));
  const plan = buildFocusPlan(files, graph, files[0].id, Infinity, { includeCallers: false, includeTests: false });
  assert.equal(plan.selectedIds.length, 1000);
  assert.equal(plan.candidates.at(-1).depth, 999);
  assert.equal(plan.tokens, plan.allTokens);
  assert.equal(plan.tokens, calculateSelection(files, files.map(item => item.id)).tokens);
});
