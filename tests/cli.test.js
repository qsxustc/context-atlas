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
import { estimateTokens } from '../src/core.js';

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

function run(args, cwd = projectRoot) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 5 * 1024 * 1024 });
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
  for (const args of [[], ['.', '--budget', '0'], ['.', '--budget', 'wat'], ['.', '--format', 'json'], ['.', '--output']]) {
    const result = run(args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Context Atlas:/);
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
