import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeFile, calculateSelection, estimateTokens } from '../src/core.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectRoot, 'bin/context-atlas.js');
const fakeToken = `ghp_${'x'.repeat(36)}`;

async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'context-atlas-cli-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, 'project');
  await mkdir(path.join(directory, 'src'), { recursive: true });
  await mkdir(path.join(directory, 'node_modules'), { recursive: true });
  await mkdir(path.join(directory, 'private-notes'), { recursive: true });
  await writeFile(path.join(directory, 'README.md'), '# Demo\n这是中文说明。\n');
  await writeFile(path.join(directory, 'package.json'), '{"name":"demo","version":"1.0.0"}\n');
  await writeFile(path.join(directory, 'src/index.js'), 'export const label = "中文<&>";\n');
  await writeFile(path.join(directory, 'src/auth.js'), `export const token = "${fakeToken}";\n`);
  await writeFile(path.join(directory, 'large-notes.md'), `LARGE_NOTES_SENTINEL\n${'Long project notes. '.repeat(5000)}`);
  await writeFile(path.join(directory, '.gitignore'), 'private-notes/\n');
  await writeFile(path.join(directory, 'private-notes/private.txt'), 'CUSTOM_IGNORE_SENTINEL');
  await writeFile(path.join(directory, 'node_modules/dependency.js'), 'DEPENDENCY_SENTINEL');
  await writeFile(path.join(directory, '.env'), 'ENV_SENTINEL=hidden\n');
  await writeFile(path.join(directory, 'binary.txt'), Buffer.from([97, 0, 98]));
  await writeFile(path.join(directory, 'oversized.txt'), 'OVERSIZED_SENTINEL'.padEnd(1024 * 1024 + 1, ' '));
  return { temporary, directory };
}

function run(args, cwd = projectRoot, input) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, input, encoding: 'utf8', timeout: 10000, maxBuffer: 5 * 1024 * 1024 });
}

test('CLI exports UTF-8, applies root gitignore and limits, and redacts by default', async t => {
  const { directory } = await fixture(t);
  const result = run([directory]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /这是中文说明/);
  assert.match(result.stdout, /LARGE_NOTES_SENTINEL/);
  assert.ok(!result.stdout.includes(fakeToken), 'raw secret must not reach the export');
  for (const sentinel of ['CUSTOM_IGNORE_SENTINEL', 'DEPENDENCY_SENTINEL', 'ENV_SENTINEL', 'OVERSIZED_SENTINEL']) {
    assert.ok(!result.stdout.includes(sentinel), `${sentinel} must be excluded`);
  }
  assert.ok(!result.stdout.includes('\0'));
  assert.doesNotMatch(result.stdout, /Context Atlas: exported/);
  assert.match(result.stderr, /Context Atlas: exported/);
});

test('CLI writes XML to a file and honors explicit unredacted export', async t => {
  const { temporary, directory } = await fixture(t);
  const result = run([directory, '--output', 'context.xml', '--format', 'xml', '--no-redact'], temporary);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '', 'file exports must not also emit content or diagnostics on stdout');
  const output = await readFile(path.join(temporary, 'context.xml'), 'utf8');
  assert.ok(output.includes(fakeToken));
  assert.match(output, /中文/);
  assert.match(output, /&lt;/);
  assert.match(output, /&amp;/);
});

test('CLI selects files within the final exported token budget', async t => {
  const { directory } = await fixture(t);
  const budget = 1200;
  const result = run([directory, '--budget', String(budget)]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.length > 0);
  assert.ok(estimateTokens(result.stdout) <= budget);
  assert.match(result.stdout, /README\.md/);
  assert.ok(!result.stdout.includes('LARGE_NOTES_SENTINEL'));
});

test('CLI never follows file or directory symlinks outside its root', async t => {
  const { temporary, directory } = await fixture(t);
  const outside = path.join(temporary, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'hidden.js'), 'OUTSIDE_ROOT_SENTINEL');
  await symlink(path.join(outside, 'hidden.js'), path.join(directory, 'linked.js'));
  await symlink(outside, path.join(directory, 'linked-directory'), 'dir');
  const result = run([directory]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes('OUTSIDE_ROOT_SENTINEL'));
  await symlink(directory, path.join(temporary, 'root-link'), 'dir');
  const rootResult = run([path.join(temporary, 'root-link')]);
  assert.notEqual(rootResult.status, 0);
  assert.equal(rootResult.stdout, '');
});

test('CLI refuses output symlinks and leaves their destination unchanged', async t => {
  const { temporary, directory } = await fixture(t);
  const original = path.join(temporary, 'original.txt');
  const linked = path.join(temporary, 'linked.md');
  await writeFile(original, 'PRESERVE_ME');
  await symlink(original, linked);
  const result = run([directory, '--output', linked]);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(original, 'utf8'), 'PRESERVE_ME');
});

test('CLI excludes its previous output through a symlinked parent directory', async t => {
  const { temporary, directory } = await fixture(t);
  const alias = path.join(temporary, 'parent-alias');
  await symlink(directory, alias, 'dir');
  const output = path.join(alias, 'context.md');
  await writeFile(output, 'PREVIOUS_EXPORT_SENTINEL');
  const result = run([directory, '--output', output]);
  assert.equal(result.status, 0, result.stderr);
  const contents = await readFile(output, 'utf8');
  assert.ok(!contents.includes('PREVIOUS_EXPORT_SENTINEL'), 'previous exports must not be imported through an alias');
  assert.doesNotMatch(contents, /`context\.md`/, 'the old export must also be absent from the file map');
});

test('CLI distinguishes directory-only ignore rules and binary-looking directory names', async t => {
  const { directory } = await fixture(t);
  await writeFile(path.join(directory, '.gitignore'), 'private-notes/\ncache/\n');
  await writeFile(path.join(directory, 'cache'), 'REGULAR_CACHE_FILE_SENTINEL');
  await mkdir(path.join(directory, 'src', 'cache'));
  await writeFile(path.join(directory, 'src', 'cache', 'generated.js'), 'IGNORED_CACHE_DIRECTORY_SENTINEL');
  await mkdir(path.join(directory, 'icons.png'));
  await writeFile(path.join(directory, 'icons.png', 'index.js'), 'SOURCE_IN_PNG_DIRECTORY_SENTINEL');
  await writeFile(path.join(directory, 'image.png'), 'IGNORED_IMAGE_FILE_SENTINEL');
  const result = run([directory]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('REGULAR_CACHE_FILE_SENTINEL'), 'a directory-only rule must retain a same-named file');
  assert.ok(result.stdout.includes('SOURCE_IN_PNG_DIRECTORY_SENTINEL'), 'a binary-looking directory can contain source files');
  assert.ok(!result.stdout.includes('IGNORED_CACHE_DIRECTORY_SENTINEL'), 'the directory-only rule must still exclude directories');
  assert.ok(!result.stdout.includes('IGNORED_IMAGE_FILE_SENTINEL'), 'binary file extensions must still be excluded');
});

test('CLI help and argument failures have clean output', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.equal(help.stderr, '');
  for (const args of [[], ['.', '--budget', '0'], ['.', '--budget', 'wat'], ['.', '--format', 'json'], ['.', '--output'], ['.', '--focus'], ['.', '--no-callers'], ['.', '--no-tests'], ['.', '--focus', '../outside.js']]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Context Atlas:/);
  }
});

async function focusFixture(t) {
  const { temporary, directory } = await fixture(t);
  await mkdir(path.join(directory, 'tests'));
  const rootContent = `import { helper } from './helper.js';\nexport const value = helper();\nexport const credential = "${fakeToken}";\n// FOCUS_ROOT_SENTINEL\n`;
  await writeFile(path.join(directory, 'src/focus.js'), rootContent);
  await writeFile(path.join(directory, 'src/helper.js'), "import { type } from './types.js';\nexport const helper = () => type;\n// FOCUS_DEPENDENCY_SENTINEL\n");
  await writeFile(path.join(directory, 'src/types.js'), 'export const type = "FOCUS_TRANSITIVE_SENTINEL";\n');
  await writeFile(path.join(directory, 'src/consumer.js'), "import { value } from './focus.js';\n// FOCUS_CONSUMER_SENTINEL\n");
  await writeFile(path.join(directory, 'tests/focus.test.js'), "import { value } from '../src/focus.js';\n// FOCUS_TEST_SENTINEL\n");
  await writeFile(path.join(directory, 'tests/unrelated.test.js'), '// UNRELATED_TEST_SENTINEL\n');
  return { temporary, directory, rootContent };
}

test('CLI focus exports relevant imports, imported-by modules and tests without unrelated files', async t => {
  const { directory } = await focusFixture(t);
  const result = run([directory, '--focus', './src/focus.js']);
  assert.equal(result.status, 0, result.stderr);
  for (const sentinel of ['FOCUS_ROOT_SENTINEL', 'FOCUS_DEPENDENCY_SENTINEL', 'FOCUS_TRANSITIVE_SENTINEL', 'FOCUS_CONSUMER_SENTINEL', 'FOCUS_TEST_SENTINEL']) {
    assert.ok(result.stdout.includes(sentinel), sentinel);
  }
  assert.ok(!result.stdout.includes('UNRELATED_TEST_SENTINEL'));
  assert.ok(!result.stdout.includes('LARGE_NOTES_SENTINEL'));
  assert.ok(!result.stdout.includes(fakeToken), 'focus exports retain default redaction');
  assert.match(result.stderr, /focus includes/);
  assert.doesNotMatch(result.stdout, /Context Atlas: focus/);
});

test('CLI focus can independently exclude imported-by modules and related tests', async t => {
  const { directory } = await focusFixture(t);
  const withoutCallers = run([directory, '--focus=src/focus.js', '--no-callers']);
  assert.equal(withoutCallers.status, 0, withoutCallers.stderr);
  assert.ok(!withoutCallers.stdout.includes('FOCUS_CONSUMER_SENTINEL'));
  assert.ok(withoutCallers.stdout.includes('FOCUS_TEST_SENTINEL'));
  const withoutTests = run([directory, '--focus', 'src/focus.js', '--no-tests']);
  assert.equal(withoutTests.status, 0, withoutTests.stderr);
  assert.ok(withoutTests.stdout.includes('FOCUS_CONSUMER_SENTINEL'));
  assert.ok(!withoutTests.stdout.includes('FOCUS_TEST_SENTINEL'));
  const dependenciesOnly = run([directory, '--focus', 'src/focus.js', '--no-callers', '--no-tests']);
  assert.equal(dependenciesOnly.status, 0, dependenciesOnly.stderr);
  assert.ok(dependenciesOnly.stdout.includes('FOCUS_DEPENDENCY_SENTINEL'));
  assert.ok(!dependenciesOnly.stdout.includes('FOCUS_CONSUMER_SENTINEL'));
  assert.ok(!dependenciesOnly.stdout.includes('FOCUS_TEST_SENTINEL'));
});

test('CLI focus respects finite export budgets and reports omitted candidates', async t => {
  const { directory, rootContent } = await focusFixture(t);
  const rootFile = analyzeFile({ path: 'src/focus.js', content: rootContent });
  const budget = calculateSelection([rootFile], [rootFile.id]).tokens;
  const result = run([directory, '--focus', 'src/focus.js', '--budget', String(budget), '--format', 'xml']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('FOCUS_ROOT_SENTINEL'), 'root must never be dropped for smaller related files');
  assert.ok(estimateTokens(result.stdout) <= budget);
  assert.match(result.stderr, /related files omitted/);
  assert.ok(!result.stdout.includes(fakeToken));
});

test('CLI focus fails cleanly for missing roots and budgets smaller than the root', async t => {
  const { temporary, directory } = await focusFixture(t);
  const output = path.join(temporary, 'existing-context.md');
  await writeFile(output, 'PRESERVE_EXISTING_EXPORT');
  for (const args of [
    [directory, '--focus', 'src/missing.js'],
    [directory, '--focus', '.env'],
    [directory, '--focus', 'src/focus.js', '--budget', '1', '--output', output],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /focus/i);
  }
  assert.equal(await readFile(output, 'utf8'), 'PRESERVE_EXISTING_EXPORT');
});

test('CLI focus reports unresolved references without putting source details in diagnostics', async t => {
  const { directory } = await focusFixture(t);
  const privateSpecifier = './missing-internal-credential-location.js';
  await writeFile(path.join(directory, 'src/focus.js'), `import '${privateSpecifier}';\n// FOCUS_ROOT_SENTINEL\n`);
  const result = run([directory, '--focus', 'src/focus.js']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /unresolved references/);
  assert.ok(!result.stderr.includes(privateSpecifier));
  assert.ok(!result.stderr.includes('FOCUS_ROOT_SENTINEL'));
});

test('CLI focus reports unsupported root languages while retaining the chosen file', async t => {
  const { directory } = await focusFixture(t);
  await writeFile(path.join(directory, 'src/focus.py'), 'from helper import value\n# PYTHON_FOCUS_SENTINEL\n');
  const result = run([directory, '--focus', 'src/focus.py']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PYTHON_FOCUS_SENTINEL/);
  assert.match(result.stderr, /imports in this focus file were not analyzed/);
});

async function reviewFixture(t) {
  const result = await focusFixture(t);
  const patch = `diff --git a/src/focus.js b/src/focus.js
index 1111111..2222222 100644
--- a/src/focus.js
+++ b/src/focus.js
@@ -1,4 +1,4 @@
 import { helper } from './helper.js';
-export const value = oldHelper();
+export const value = helper();
 export const credential = "${fakeToken}";
 // FOCUS_ROOT_SENTINEL
diff --git a/.env b/.env
index 1111111..2222222 100644
--- a/.env
+++ b/.env
@@ -1 +1 @@
-IGNORED_OLD_DIFF_SENTINEL
+IGNORED_NEW_DIFF_SENTINEL
diff --git a/private-notes/private.txt b/private-notes/private.txt
index 1111111..2222222 100644
--- a/private-notes/private.txt
+++ b/private-notes/private.txt
@@ -1 +1 @@
-CUSTOM_IGNORE_OLD_DIFF_SENTINEL
+CUSTOM_IGNORE_NEW_DIFF_SENTINEL
`;
  const patchPath = path.join(result.temporary, 'changes.patch');
  await writeFile(patchPath, patch);
  return { ...result, patch, patchPath };
}

test('CLI review combines filtered diff, changed files and dependency context with default redaction', async t => {
  const { directory, patchPath } = await reviewFixture(t);
  const result = run([directory, '--diff', patchPath]);
  assert.equal(result.status, 0, result.stderr);
  for (const sentinel of ['oldHelper()', 'FOCUS_ROOT_SENTINEL', 'FOCUS_DEPENDENCY_SENTINEL', 'FOCUS_TRANSITIVE_SENTINEL', 'FOCUS_CONSUMER_SENTINEL', 'FOCUS_TEST_SENTINEL']) {
    assert.ok(result.stdout.includes(sentinel), sentinel);
  }
  for (const sentinel of [fakeToken, 'IGNORED_OLD_DIFF_SENTINEL', 'IGNORED_NEW_DIFF_SENTINEL', 'CUSTOM_IGNORE_OLD_DIFF_SENTINEL', 'CUSTOM_IGNORE_NEW_DIFF_SENTINEL', 'UNRELATED_TEST_SENTINEL', 'LARGE_NOTES_SENTINEL']) {
    assert.ok(!result.stdout.includes(sentinel), `${sentinel} must not reach the review pack`);
    assert.ok(!result.stderr.includes(sentinel), `${sentinel} must not reach diagnostics`);
  }
  assert.match(result.stderr, /review pack for 1 changed paths/);
  assert.match(result.stderr, /2 patch paths skipped/);
  assert.doesNotMatch(result.stderr, /do not match the patch/);
  assert.doesNotMatch(result.stdout, /Context Atlas: exported/);
});

test('CLI review accepts stdin and independently disables callers and tests', async t => {
  const { directory, patch } = await reviewFixture(t);
  const withoutCallers = run([directory, '--diff', '-', '--no-callers'], projectRoot, patch);
  assert.equal(withoutCallers.status, 0, withoutCallers.stderr);
  assert.ok(!withoutCallers.stdout.includes('FOCUS_CONSUMER_SENTINEL'));
  assert.ok(withoutCallers.stdout.includes('FOCUS_TEST_SENTINEL'));
  const withoutTests = run([directory, '--diff=-', '--no-tests'], projectRoot, patch);
  assert.equal(withoutTests.status, 0, withoutTests.stderr);
  assert.ok(withoutTests.stdout.includes('FOCUS_CONSUMER_SENTINEL'));
  assert.ok(!withoutTests.stdout.includes('FOCUS_TEST_SENTINEL'));
});

test('CLI review never rescans its raw patch through a symlinked parent', async t => {
  const { temporary, directory, patch } = await reviewFixture(t);
  await symlink(directory, path.join(temporary, 'project-alias'), 'dir');
  const patchPath = path.join(temporary, 'project-alias', 'raw.patch');
  await writeFile(patchPath, patch);
  const result = run([directory, '--diff', patchPath, '--no-redact']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(fakeToken), 'explicit no-redact still applies to eligible contents');
  assert.ok(!result.stdout.includes('IGNORED_NEW_DIFF_SENTINEL'), 'excluded sections must not reappear through the input patch file');
  assert.ok(!result.stdout.includes('CUSTOM_IGNORE_NEW_DIFF_SENTINEL'));
  assert.doesNotMatch(result.stdout, /raw\.patch/);
});

test('CLI review supports deletion-only patches without any current files', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'context-atlas-deleted-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const patch = 'diff --git a/removed.js b/removed.js\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/removed.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const old = "REMOVED_CONTENT_SENTINEL";\n';
  const result = run([temporary, '--diff', '-'], projectRoot, patch);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /REMOVED_CONTENT_SENTINEL/);
  assert.match(result.stderr, /0\/0 current files/);
  assert.doesNotMatch(result.stderr, /missing from the imported/);
});

test('CLI review warns on current-file mismatches and missing files without leaking source in diagnostics', async t => {
  const { directory, patchPath } = await reviewFixture(t);
  await writeFile(path.join(directory, 'src/focus.js'), '// STALE_CHECKOUT_SENTINEL\n');
  const stale = run([directory, '--diff', patchPath]);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stderr, /1 changed files do not match the patch new side/);
  assert.ok(!stale.stderr.includes('STALE_CHECKOUT_SENTINEL'));
  assert.ok(!stale.stderr.includes(fakeToken));
  await rm(path.join(directory, 'src/focus.js'));
  const missing = run([directory, '--diff', patchPath]);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stderr, /1 changed files are missing/);
  assert.match(missing.stdout, /oldHelper\(\)/);
});

test('CLI review honors final XML budgets and fails before replacing an export when mandatory context cannot fit', async t => {
  const { temporary, directory, patchPath } = await reviewFixture(t);
  // Make optional context large enough that it cannot fit the review budget.
  await writeFile(path.join(directory, 'src/helper.js'), '// OPTIONAL_LARGE_HELPER\n' + 'const longValue = "<&>";\n'.repeat(2000));
  const budget = 2400;
  const fitted = run([directory, '--diff', patchPath, '--format', 'xml', '--budget', String(budget)]);
  assert.equal(fitted.status, 0, fitted.stderr);
  assert.match(fitted.stdout, /FOCUS_ROOT_SENTINEL/);
  assert.ok(estimateTokens(fitted.stdout) <= budget);
  assert.doesNotMatch(fitted.stdout, /OPTIONAL_LARGE_HELPER/);
  assert.match(fitted.stderr, /related files omitted/);
  const output = path.join(temporary, 'existing-review.md');
  await writeFile(output, 'PRESERVE_EXISTING_REVIEW');
  const tooSmall = run([directory, '--diff', patchPath, '--budget', '1', '--output', output]);
  assert.notEqual(tooSmall.status, 0);
  assert.equal(tooSmall.stdout, '');
  assert.match(tooSmall.stderr, /patch and current changed files/);
  assert.equal(await readFile(output, 'utf8'), 'PRESERVE_EXISTING_REVIEW');
});

test('CLI review rejects invalid, oversized and symlink patch inputs before writing output', async t => {
  const { temporary, directory, patchPath } = await reviewFixture(t);
  const output = path.join(temporary, 'existing.md');
  await writeFile(output, 'PRESERVE_EXISTING_REVIEW');
  const badUtf8 = path.join(temporary, 'invalid.patch');
  await writeFile(badUtf8, Buffer.from([0xff, 0xfe, 0xfd]));
  const oversized = path.join(temporary, 'oversized.patch');
  await writeFile(oversized, 'x'.repeat(1024 * 1024 + 1));
  const linked = path.join(temporary, 'linked.patch');
  await symlink(patchPath, linked);
  for (const input of [badUtf8, oversized, linked, directory]) {
    const result = run([directory, '--diff', input, '--output', output]);
    assert.notEqual(result.status, 0, input);
    assert.equal(result.stdout, '');
  }
  for (const input of ['', 'not a diff', 'x'.repeat(1024 * 1024 + 1), Buffer.from([0xff])]) {
    const result = run([directory, '--diff', '-', '--output', output], projectRoot, input);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
  assert.equal(await readFile(output, 'utf8'), 'PRESERVE_EXISTING_REVIEW');
});

test('CLI review blocks patches under symlinks and fails closed when root ignore rules cannot be read safely', async t => {
  const { temporary, directory } = await reviewFixture(t);
  await symlink(temporary, path.join(directory, 'linked-directory'), 'dir');
  const patch = 'diff --git a/linked-directory/secret.js b/linked-directory/secret.js\n--- a/linked-directory/secret.js\n+++ b/linked-directory/secret.js\n@@ -1 +1 @@\n-BLOCKED_OLD_SENTINEL\n+BLOCKED_NEW_SENTINEL\n';
  const blocked = run([directory, '--diff', '-'], projectRoot, patch);
  assert.notEqual(blocked.status, 0);
  assert.equal(blocked.stdout, '');
  assert.ok(!blocked.stderr.includes('BLOCKED_NEW_SENTINEL'));
  await writeFile(path.join(directory, '.gitignore'), 'x'.repeat(1024 * 1024 + 1));
  const unknownRules = run([directory, '--diff', '-'], projectRoot, patch);
  assert.notEqual(unknownRules.status, 0);
  assert.equal(unknownRules.stdout, '');
  assert.match(unknownRules.stderr, /\.gitignore/);
});

test('CLI review argument errors are clean and terminal control characters cannot enter diagnostics', async t => {
  const { directory, patchPath } = await reviewFixture(t);
  for (const args of [
    [directory, '--focus', 'src/focus.js', '--diff', patchPath],
    [directory, '--diff'],
    [directory, '--unknown\u001b[31m\nINJECTED'],
    [directory, '--diff', path.join(directory, 'missing\u001b[31m\n.patch')],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.split('\n').length, 2, 'diagnostics must remain a single terminal line');
    assert.doesNotMatch(result.stderr, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
  }
});

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function get(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const connection = request({ host: '127.0.0.1', port, path: pathname, method }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    connection.on('error', reject);
    connection.end();
  });
}

async function startServer(t, script = path.join(projectRoot, 'scripts/serve.mjs')) {
  const port = await freePort();
  const child = spawn(process.execPath, [script, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGTERM'); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Static server did not become ready')), 5000);
    child.stdout.on('data', () => { clearTimeout(timeout); resolve(); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Static server exited with ${code}`)); });
  });
  return port;
}

test('static server rejects traversal and malformed URLs and serves safe headers', async t => {
  const port = await startServer(t);
  const source = await get(port, '/src/core.js');
  assert.equal(source.status, 200);
  assert.match(source.headers['content-type'], /javascript/);
  assert.equal(source.headers['x-content-type-options'], 'nosniff');
  assert.match(source.headers['cache-control'], /no-cache/);
  const favicon = await get(port, '/favicon.svg');
  assert.equal(favicon.status, 200, 'public assets should be available at the site root in dev');
  assert.equal(favicon.headers['content-type'], 'image/svg+xml');
  const head = await get(port, '/src/core.js', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  for (const pathname of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/%5c..%5cpackage.json', '/.git/config']) {
    assert.equal((await get(port, pathname)).status, 403, pathname);
  }
  assert.equal((await get(port, '/%ZZ')).status, 400);
  assert.equal((await get(port, '/', 'POST')).status, 405);
});

test('static server cannot expose hidden files through visible symlink aliases', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'context-atlas-server-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(path.join(temporary, 'scripts'));
  await mkdir(path.join(temporary, '.private'));
  await copyFile(path.join(projectRoot, 'scripts/serve.mjs'), path.join(temporary, 'scripts/serve.mjs'));
  await writeFile(path.join(temporary, '.env'), 'HIDDEN_ENV_SENTINEL');
  await writeFile(path.join(temporary, '.private', 'index.html'), 'HIDDEN_DIRECTORY_SENTINEL');
  await writeFile(path.join(temporary, 'safe.txt'), 'safe public content');
  await symlink(path.join(temporary, '.env'), path.join(temporary, 'visible.txt'));
  await symlink(path.join(temporary, '.private'), path.join(temporary, 'visible-directory'), 'dir');
  await symlink(path.join(temporary, 'safe.txt'), path.join(temporary, 'safe-alias.txt'));
  const port = await startServer(t, path.join(temporary, 'scripts/serve.mjs'));
  for (const pathname of ['/visible.txt', '/visible-directory/', '/visible-directory/index.html']) {
    const response = await get(port, pathname);
    assert.equal(response.status, 403, pathname);
    assert.doesNotMatch(response.body, /HIDDEN_/);
  }
  assert.equal((await get(port, '/safe-alias.txt')).body, 'safe public content');
});
