import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFile, estimateTokens } from '../src/core.js';
import { buildDependencyGraph } from '../src/dependencies.js';
import { parseGitDiff } from '../src/review-diff.js';
import { buildReviewPlan, buildReviewContext, calculateReviewSelection } from '../src/review.js';

const file = (path, content = 'export const value = 2;\n') => analyzeFile({ path, content });
const modified = (path, before = 'export const value = 1;', after = 'export const value = 2;') =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
const change = (path, options = {}) => ({ path, oldPath: path, status: 'modified', additions: 1, deletions: 1,
  patch: modified(path), hunks: [{ newStart: 1, newCount: 1, newLines: ['export const value = 2;'] }], ...options });
function makeGraph(files, edges = [], unresolved = []) {
  const graph = { dependencies: new Map(files.map(item => [item.id, new Set()])),
    dependents: new Map(files.map(item => [item.id, new Set()])), unresolved: new Map(unresolved), supported: new Set() };
  for (const [source, target] of edges) {
    graph.dependencies.get(source)?.add(target);
    graph.dependents.get(target)?.add(source);
  }
  return graph;
}

test('multi-root review prioritizes every changed source before shared dependencies, callers and tests', () => {
  const files = ['src/a.ts', 'src/b.ts', 'src/shared.ts', 'src/nested.ts', 'src/page.ts', 'src/parent.ts', 'tests/a.test.ts', 'tests/shared.test.ts', 'unrelated.ts'].map(path => file(path));
  const edges = [['src/a.ts', 'src/shared.ts'], ['src/b.ts', 'src/shared.ts'], ['src/shared.ts', 'src/nested.ts'],
    ['src/nested.ts', 'src/a.ts'], ['src/page.ts', 'src/a.ts'], ['src/page.ts', 'src/b.ts'], ['src/parent.ts', 'src/page.ts'],
    ['tests/a.test.ts', 'src/a.ts'], ['tests/shared.test.ts', 'src/shared.ts']];
  const parsed = { changes: [change('src/b.ts'), change('src/a.ts')], skipped: [] };
  const plan = buildReviewPlan(files, makeGraph(files, edges), parsed, Infinity);
  assert.deepEqual(plan.selectedIds, ['src/a.ts', 'src/b.ts', 'src/shared.ts', 'src/nested.ts', 'src/page.ts', 'tests/a.test.ts', 'tests/shared.test.ts']);
  assert.deepEqual(plan.candidates.map(item => item.kind), ['changed', 'changed', 'dependency', 'dependency', 'caller', 'test', 'test']);
  assert.deepEqual(plan.mismatched, []);
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.tokens, calculateReviewSelection(files, plan.selectedIds, plan).tokens);
  assert.equal(plan.allTokens, plan.tokens);
  assert.deepEqual(buildReviewPlan([...files].reverse(), makeGraph(files, [...edges].reverse()), parsed, Infinity), plan);
});

test('budget reserves patch and notes, retains all changed sources, and fits optional files inclusively', () => {
  const files = [file('a.ts'), file('b.ts', 'export const value = 2;\n' + '/* oversized change */'.repeat(100)), file('dep.ts')];
  const graph = makeGraph(files, [['a.ts', 'dep.ts']]);
  const parsed = { changes: [change('a.ts'), change('b.ts')], skipped: [] };
  const full = buildReviewPlan(files, graph, parsed, Infinity);
  const exact = buildReviewPlan(files, graph, parsed, full.tokens);
  assert.deepEqual(exact.selectedIds, full.selectedIds);
  assert.equal(exact.overBudget, false);
  const bounded = buildReviewPlan(files, graph, parsed, full.tokens - 1);
  assert.deepEqual(bounded.selectedIds, ['a.ts', 'b.ts']);
  assert.equal(bounded.omittedCount, 1);
  assert.equal(bounded.tokens, bounded.mandatoryTokens);
  assert.ok(bounded.tokens < full.tokens);
  assert.equal(bounded.tokens, calculateReviewSelection(files, bounded.selectedIds, bounded).tokens);
  for (const budget of [0, -1, NaN, -Infinity, undefined, bounded.mandatoryTokens - 1]) {
    const small = buildReviewPlan(files, graph, parsed, budget);
    assert.deepEqual(small.selectedIds, ['a.ts', 'b.ts']);
    assert.equal(small.overBudget, true);
  }
});

test('callers and tests can be disabled independently and changed tests stay mandatory', () => {
  const files = ['a.ts', 'dep.ts', 'caller.ts', 'a.test.ts', 'dep.test.ts'].map(path => file(path));
  const graph = makeGraph(files, [['a.ts', 'dep.ts'], ['caller.ts', 'a.ts'], ['a.test.ts', 'a.ts']]);
  const parsed = { changes: [change('a.ts'), change('a.test.ts')], skipped: [] };
  assert.deepEqual(buildReviewPlan(files, graph, parsed, Infinity, { includeTests: false }).selectedIds,
    ['a.test.ts', 'a.ts', 'dep.ts', 'caller.ts']);
  assert.deepEqual(buildReviewPlan(files, graph, parsed, Infinity, { includeCallers: false }).selectedIds,
    ['a.test.ts', 'a.ts', 'dep.ts', 'dep.test.ts']);
  assert.deepEqual(buildReviewPlan(files, graph, parsed, Infinity, { includeCallers: false, includeTests: false }).selectedIds,
    ['a.test.ts', 'a.ts', 'dep.ts']);
});

test('snapshot checks flag missing, mismatched and unexpectedly present deleted files with diff-only support', () => {
  const files = [file('modified.ts', 'wrong line\n'), file('deleted.ts'), file('renamed.ts', 'unchanged\n')];
  const parsed = { changes: [change('missing.ts'), change('modified.ts'), change('deleted.ts', { status: 'deleted', hunks: [] }),
    change('renamed.ts', { oldPath: 'old.ts', status: 'renamed', hunks: [] })], skipped: [{ path: '.env', reason: 'ignored' }] };
  const plan = buildReviewPlan(files, null, parsed, Infinity);
  assert.deepEqual(plan.selectedIds, ['modified.ts', 'renamed.ts']);
  assert.deepEqual(plan.missing, ['missing.ts']);
  assert.deepEqual(plan.mismatched, ['deleted.ts', 'modified.ts']);
  const output = buildReviewContext(files, plan.selectedIds, plan);
  assert.match(output, /Missing current source: "missing\.ts"/);
  assert.match(output, /Snapshot mismatch: "deleted\.ts"/);
  assert.match(output, /Snapshot mismatch: "modified\.ts"/);
  assert.match(output, /renamed: "renamed\.ts" \(from "old\.ts"\)/);
  assert.match(output, /"\.env": "ignored"/);
  assert.match(output, /diff --git a\/missing\.ts/);
});

test('deletion-only packs export a useful patch and instructions without any current source', () => {
  const patch = 'diff --git a/removed.js b/removed.js\ndeleted file mode 100644\n--- a/removed.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const removed = true;\n';
  const parsed = parseGitDiff(patch);
  const plan = buildReviewPlan([], makeGraph([]), parsed, Infinity);
  assert.deepEqual(plan.selectedIds, []);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.mismatched, []);
  assert.ok(plan.tokens > 0);
  assert.equal(plan.reviewTokens, plan.tokens);
  assert.equal(calculateReviewSelection([], [], plan).count, 0);
  assert.match(buildReviewContext([], [], plan), /export const removed = true/);
  assert.match(buildReviewContext([], [], plan), /Find concrete bugs/);
  assert.equal(buildReviewPlan([], makeGraph([]), parsed, plan.tokens - 1).overBudget, true);
});

test('snapshot checks honor hunk offsets, new-side context, empty lines and CRLF source exactly', () => {
  const content = 'first\r\nnew\r\n\r\nlast\r\n';
  const patch = 'diff --git a/crlf.ts b/crlf.ts\n--- a/crlf.ts\n+++ b/crlf.ts\n@@ -2,2 +2,2 @@\n-old\r\n+new\r\n \r\n';
  const parsed = parseGitDiff(patch);
  const files = [file('crlf.ts', content)];
  assert.deepEqual(buildReviewPlan(files, null, parsed, Infinity).mismatched, []);
  assert.deepEqual(buildReviewPlan([file('crlf.ts', content.replace('last', 'elsewhere'))], null, parsed, Infinity).mismatched, []);
  assert.deepEqual(buildReviewPlan([file('crlf.ts', content.replace('new', 'old'))], null, parsed, Infinity).mismatched, ['crlf.ts']);
  assert.deepEqual(buildReviewPlan([file('crlf.ts', 'first\r\n')], null, parsed, Infinity).mismatched, ['crlf.ts']);
});

test('snapshot checks distinguish a terminal newline from an added blank source line', () => {
  const appendedBlank = parseGitDiff('diff --git a/main.js b/main.js\n--- a/main.js\n+++ b/main.js\n@@ -1 +1,2 @@\n first\n+\n');
  assert.deepEqual(buildReviewPlan([file('main.js', 'first\n')], null, appendedBlank, Infinity).mismatched, ['main.js']);
  assert.deepEqual(buildReviewPlan([file('main.js', 'first\n\n')], null, appendedBlank, Infinity).mismatched, []);
  const addedBlank = parseGitDiff('diff --git a/blank.js b/blank.js\nnew file mode 100644\n--- /dev/null\n+++ b/blank.js\n@@ -0,0 +1 @@\n+\n');
  assert.deepEqual(buildReviewPlan([file('blank.js', '')], null, addedBlank, Infinity).mismatched, ['blank.js']);
  assert.deepEqual(buildReviewPlan([file('blank.js', '\n')], null, addedBlank, Infinity).mismatched, []);
});

test('manual selection updates coverage and statistics without discarding the patch or warnings', () => {
  const files = [file('root.ts'), file('dep.ts'), file('extra.ts')];
  const plan = buildReviewPlan(files, makeGraph(files, [['root.ts', 'dep.ts']]), { changes: [change('root.ts')], skipped: [] }, Infinity);
  const customized = ['extra.ts'];
  const output = buildReviewContext(files, customized, plan);
  assert.match(output, /\[omitted \] changed: "root\.ts"/);
  assert.match(output, /\[omitted \] dependency: "dep\.ts"/);
  assert.match(output, /### `extra\.ts`/);
  assert.doesNotMatch(output, /### `root\.ts`/);
  assert.match(output, /diff --git a\/root\.ts/);
  assert.equal(calculateReviewSelection(files, customized, plan).count, 1);
  assert.ok(calculateReviewSelection(files, customized, plan).tokens < plan.tokens);
  const noSources = calculateReviewSelection(files, [], plan);
  assert.equal(noSources.tokens, plan.reviewTokens);
  assert.equal(noSources.count, 0);
});

test('exports redact secrets in both diff sides including partial private-key blocks and current sources', () => {
  const secret = 'not-a-placeholder-sensitive-secret';
  const patch = `diff --git a/key.ts b/key.ts\n--- a/key.ts\n+++ b/key.ts\n@@ -1,3 +1,3 @@\n-const password = "${secret}";\n+const password = "other-sensitive-secret";\n -----BEGIN PRIVATE KEY-----\n-privatekeyoldbody\n+privatekeynewbody\n`;
  const parsed = parseGitDiff(patch);
  const files = [file('key.ts', 'const password = "other-sensitive-secret";\n-----BEGIN PRIVATE KEY-----\nprivatekeynewbody\n')];
  const plan = buildReviewPlan(files, buildDependencyGraph(files), parsed, Infinity);
  for (const format of ['markdown', 'xml']) {
    const safe = buildReviewContext(files, plan.selectedIds, plan, { format });
    assert.doesNotMatch(safe, /not-a-placeholder-sensitive-secret|other-sensitive-secret|privatekeyoldbody|privatekeynewbody/);
    assert.match(safe, /REDACTED/);
    const raw = buildReviewContext(files, plan.selectedIds, plan, { format, redact: false });
    assert.match(raw, /privatekeyoldbody/);
    assert.match(raw, /privatekeynewbody/);
    assert.ok(estimateTokens(safe) <= plan.tokens);
    assert.ok(estimateTokens(raw) <= plan.tokens);
  }
});

test('risk statistics flag semantic diff secrets that ordinary source scanning misses', () => {
  const patch = 'diff --git a/config.js b/config.js\n--- a/config.js\n+++ b/config.js\n@@ -1,2 +1,2 @@\n const password =\n-  "previous-sensitive-credential";\n+  process.env.PASSWORD;\n';
  assert.equal(file('changes.diff', patch).risks.length, 0, 'diff prefixes interrupt the multiline assignment');
  const files = [file('config.js', 'const password =\n  process.env.PASSWORD;\n'),
    file('extra.js', 'const token = "other-sensitive-credential";\n')];
  const plan = buildReviewPlan(files, null, parseGitDiff(patch), Infinity);
  assert.equal(calculateReviewSelection(files, plan.selectedIds, plan).risks, 1);
  assert.equal(calculateReviewSelection(files, [...plan.selectedIds, 'extra.js'], plan).risks, 2);
  assert.doesNotMatch(buildReviewContext(files, plan.selectedIds, plan), /previous-sensitive-credential/);
  assert.match(buildReviewContext(files, plan.selectedIds, plan, { redact: false }), /previous-sensitive-credential/);
});

test('all export formats and manual selection variants stay within conservative estimates', () => {
  const path = 'src/<你好>&`file`.ts';
  const files = [file(path, 'export const value = 2;\n' + '`'.repeat(90) + '<>&你好\npassword="x"'), file('dep.ts', '"'.repeat(100))];
  const plan = buildReviewPlan(files, makeGraph(files, [[path, 'dep.ts']]), { changes: [change(path)], skipped: [] }, Infinity);
  for (const selected of [plan.selectedIds, [path], ['dep.ts'], []]) {
    const stats = calculateReviewSelection(files, selected, plan);
    for (const format of ['markdown', 'xml']) for (const redact of [true, false]) {
      const output = buildReviewContext(files, selected, plan, { format, redact, projectName: '<&你好>'.repeat(100) });
      assert.ok(estimateTokens(output) <= stats.tokens, `${format}, redact=${redact}`);
      if (format === 'xml') assert.doesNotMatch(output, /path="src\/<你好>/);
    }
  }
});

test('generated paths and IDs cannot collide with imported files and plan does not expose source bodies', () => {
  const root = { ...file('root.ts', 'export const value = 2;\n// PRIVATE_SOURCE_SENTINEL_OUTSIDE_DIFF\n'), id: '__context_atlas_review_2__/review.md' };
  const files = [root, file('__context_atlas_review__/review.md', 'real repository review notes')];
  const before = structuredClone(files);
  const plan = buildReviewPlan(files, makeGraph(files), { changes: [change('root.ts')], skipped: [] }, Infinity);
  assert.deepEqual(plan.selectedIds, [root.id]);
  assert.doesNotMatch(JSON.stringify(plan), /PRIVATE_SOURCE_SENTINEL_OUTSIDE_DIFF/);
  const output = buildReviewContext(files, [root.id, files[1].id], plan);
  assert.match(output, /__context_atlas_review_3__\/review\.md/);
  assert.match(output, /real repository review notes/);
  assert.match(output, /PRIVATE_SOURCE_SENTINEL_OUTSIDE_DIFF/);
  assert.deepEqual(files, before);
});

test('unresolved diagnostics are deterministic, deduplicated and retained even for omitted candidates', () => {
  const files = [file('root.ts'), file('dep.ts')];
  const graph = makeGraph(files, [['root.ts', 'dep.ts']], [['dep.ts', [{ specifier: './missing', reason: 'not-found' },
    { specifier: './missing', reason: 'not-found' }, { specifier: '', reason: 'analysis-limit' }]]]);
  const parsed = { changes: [change('root.ts')], skipped: [] };
  const plan = buildReviewPlan(files, graph, parsed, 0);
  assert.deepEqual(plan.unresolved, [{ id: 'dep.ts', specifier: '', reason: 'analysis-limit' }, { id: 'dep.ts', specifier: './missing', reason: 'not-found' }]);
  assert.match(buildReviewContext(files, plan.selectedIds, plan), /analysis-limit/);
  assert.match(buildReviewContext(files, plan.selectedIds, plan), /not-found/);
});

test('multi-root traversal handles deep cyclic graphs without repeated per-root traversal', () => {
  const files = Array.from({ length: 1000 }, (_, index) => file(`src/file-${String(index).padStart(4, '0')}.ts`));
  const edges = files.map((item, index) => [item.id, files[(index + 1) % files.length].id]);
  const parsed = { changes: files.slice(0, 100).map(item => change(item.path)), skipped: [] };
  const plan = buildReviewPlan(files, makeGraph(files, edges), parsed, Infinity, { includeCallers: false, includeTests: false });
  assert.equal(plan.selectedIds.length, 1000);
  assert.ok(plan.candidates.slice(0, 100).every(item => item.kind === 'changed'));
  assert.equal(plan.tokens, calculateReviewSelection(files, plan.selectedIds, plan).tokens);
});
