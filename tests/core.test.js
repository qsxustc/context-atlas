import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  normalizePath, isIgnored, estimateTokens, analyzeFile, redactSecrets,
  suggestSelection, calculateSelection, buildContext,
} from '../src/core.js';

const makeFile = (path, content = 'export const answer = 42;\n') => analyzeFile({ path, content });
const githubToken = `ghp_${'aB3'.repeat(12)}`;
const awsKey = 'AKIAQWERTYUIOPASDFGH';

test('paths normalize across platforms while rejecting repository escapes and line injection', () => {
  assert.equal(normalizePath('./src//./app.ts'), 'src/app.ts');
  assert.equal(normalizePath('src\\lib\\main.py'), 'src/lib/main.py');
  assert.equal(normalizePath('项目/你好.ts'), '项目/你好.ts');
  for (const path of ['../secret', 'src/../secret', '/etc/passwd', 'C:\\Users\\secret', '\\\\host\\share', '.', '', 'a\nfile', 'a\0file']) {
    assert.throws(() => normalizePath(path), { message: /path|repository/i }, path);
    assert.equal(isIgnored(path), true);
  }
});

test('default filters omit dependency, generated, binary, system, lock and environment files', () => {
  for (const path of ['.git/config', 'web/node_modules/a/index.js', 'dist/index.js', 'build/app.js', 'Cargo.lock', 'pnpm-lock.yaml', 'package-lock.json', '.env', 'api/.env.production', 'photo.PNG', '.DS_Store', 'data.sqlite', 'src/a.pyc']) {
    assert.equal(isIgnored(path), true, path);
  }
  for (const path of ['.env.example', 'api/.env.example', 'src/index.ts', 'docs/schema.svg', 'public/logo.svg', 'build-tools/main.js', 'assets/data.json']) {
    assert.equal(isIgnored(path), false, path);
  }
  assert.equal(isIgnored('.env', ['!.env']), true, 'custom negation cannot override the default environment filter');
});

test('custom patterns handle directory, glob, root, double-star and ordered negation semantics', () => {
  assert.equal(isIgnored('docs/guide.md', ['docs/']), true);
  assert.equal(isIgnored('src/generated/types.ts', ['**/generated/**']), true);
  assert.equal(isIgnored('notes.md', ['*.md']), true);
  assert.equal(isIgnored('docs/notes.md', ['*.md', '!docs/notes.md']), false);
  assert.equal(isIgnored('src/private/a.ts', ['/private/']), false);
  assert.equal(isIgnored('private/a.ts', ['/private/']), true);
  assert.equal(isIgnored('src/a.test.ts', '# ignored comment\n**/*.test.?s'), true);
  assert.equal(isIgnored('README.md', ['[abc].md']), false, 'regex characters remain literal');
});

test('directory checks distinguish file extensions and directory-only ignore rules', () => {
  assert.equal(isIgnored('assets.png'), true, 'a PNG file is excluded by default');
  assert.equal(isIgnored('assets.png', [], { directory: true }), false, 'a directory can have a binary-looking extension');
  assert.equal(isIgnored('assets.png/readme.md'), false);
  assert.equal(isIgnored('node_modules', [], { directory: true }), true);
  assert.equal(isIgnored('assets.png', ['*.png'], { directory: true }), true, 'custom patterns still apply to directories');
  assert.equal(isIgnored('scratch', ['scratch/']), false, 'a directory-only rule does not match a file of the same name');
  assert.equal(isIgnored('scratch', ['scratch/'], { directory: true }), true);
  assert.equal(isIgnored('scratch/note.md', ['scratch/']), true, 'directory rules still exclude descendants');
  assert.equal(isIgnored('src/scratch', ['scratch/']), false);
  assert.equal(isIgnored('src/scratch', ['scratch/'], { directory: true }), true);
  assert.equal(isIgnored('src/scratch', ['/scratch/'], { directory: true }), false);
  assert.equal(isIgnored('src/generated', ['/src/generated/'], { directory: true }), true);
  assert.equal(isIgnored('src/generated/main.ts', ['/src/generated/']), true);
});

test('common credential stores and private key files are excluded before content scanning', () => {
  for (const path of ['.ssh/config', '.aws/config', '.gnupg/trustdb.gpg', '.azure/config', '.kube/config', '.netrc', '.npmrc', 'config/credentials', 'credentials.json', 'keys/id_rsa', 'id_ed25519', 'cert/server.pem', 'config/auth.key', 'backup/client.p12', 'client.pfx', 'android/release.keystore']) {
    assert.equal(isIgnored(path), true, path);
    assert.equal(isIgnored(path, [`!${path}`]), true, 'custom rules cannot restore credential files');
  }
  for (const path of ['credentials.example', '.env.example', 'keys/id_rsa.pub', 'src/credentials.ts', 'docs/keyboard.md', 'service/public.crt']) {
    assert.equal(isIgnored(path), false, path);
  }
});

test('untrusted repeated-star patterns match without backtracking and rule limits bound work', () => {
  const path = 'a'.repeat(80);
  assert.equal(isIgnored(path, ['*a'.repeat(40) + 'b']), false);
  assert.equal(isIgnored(path + 'b', ['*a'.repeat(40) + 'b']), true);
  assert.equal(isIgnored('deep/path/file.ts', ['**/file.ts']), true);
  assert.equal(isIgnored('file.ts', ['**/file.ts']), true);
  assert.equal(isIgnored('afile.ts', ['**/file.ts']), false, '**/ consumes a directory boundary or nothing');
  assert.equal(isIgnored('README.md', ['*'.repeat(2049)]), false, 'oversized rules are skipped');
  const rules = Array.from({ length: 4096 }, (_, i) => `unrelated-${i}`);
  assert.equal(isIgnored('README.md', [...rules, 'README.md']), false, 'only the first 4096 non-comment rules apply');
  assert.equal(isIgnored('README.md', ['# comment', '', ...rules.slice(0, 4095), 'README.md']), true, 'comments and empty lines do not consume the rule limit');
});

test('token heuristic counts multilingual text and UTF-8 file sizes separately', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens('😀'), 2);
  const file = makeFile('src/你好.ts', '你好😀');
  assert.equal(file.bytes, 10);
  assert.equal(file.tokens, 4);
  assert.equal(file.language, 'typescript');
  assert.equal(file.id, 'src/你好.ts');
  assert.equal(file.name, '你好.ts');
  for (const [extension, language] of [['js', 'javascript'], ['css', 'css'], ['html', 'html'], ['json', 'json'], ['md', 'markdown'], ['py', 'python'], ['go', 'go'], ['rs', 'rust']]) {
    assert.equal(makeFile(`file.${extension}`).language, language);
  }
  const large = 'const example = "hello";\n'.repeat(45_000);
  assert.equal(estimateTokens(large), Math.ceil(large.length / 4));
});

test('secret redaction retains assignment syntax, comments, bearer prefix and accurate line numbers', () => {
  const input = [
    '// Keep this useful comment',
    `const api_key = "${githubToken}"; // configuration`,
    `AWS_ACCESS_KEY_ID = '${awsKey}'`,
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    'const password = "hunter2";',
    'const clientSecret = "a-real-secret-value";',
    'config',
    '  .password = "another-real-password";',
  ].join('\n');
  const output = redactSecrets(input);
  assert.ok(output.includes('// Keep this useful comment'));
  assert.ok(output.includes('const api_key = "[REDACTED]"; // configuration'));
  assert.ok(output.includes("AWS_ACCESS_KEY_ID = '[REDACTED]'"));
  assert.ok(output.includes('Authorization: Bearer [REDACTED]'));
  assert.ok(output.includes('const password = "[REDACTED]";'));
  assert.ok(!output.includes(githubToken));
  assert.ok(!output.includes(awsKey));
  const file = makeFile('config.ts', input);
  assert.deepEqual(file.risks.map(risk => risk.line), [2, 3, 4, 5, 6, 8]);
  assert.ok(output.includes('  .password = "[REDACTED]";'));
  assert.equal(file.risks[0].kind, 'github-token');
  assert.equal(file.risks[1].kind, 'aws-access-key');
  assert.ok(file.risks.every(risk => risk.match === '[REDACTED]'));
  assert.equal(redactSecrets(output), output, 'redaction is idempotent');
});

test('private key redaction preserves markers and surrounding documentation, including truncated keys', () => {
  const input = '// setup\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc123fakebase64\nabcdefghi\n-----END RSA PRIVATE KEY-----\n// footer';
  const output = redactSecrets(input);
  assert.equal(output, '// setup\n-----BEGIN RSA PRIVATE KEY-----\n[REDACTED]\n-----END RSA PRIVATE KEY-----\n// footer');
  assert.equal(makeFile('key.txt', input).risks[0].line, 2);
  assert.equal(redactSecrets('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADArealkey'), '-----BEGIN PRIVATE KEY-----\n[REDACTED]');
});

test('quoted JSON keys and embedded opposite quotes redact only their values', () => {
  const input = `{"api_key": "${githubToken}", "password": "hunter's real password", "token": "realEXAMPLEcredential"}`;
  assert.equal(redactSecrets(input), '{"api_key": "[REDACTED]", "password": "[REDACTED]", "token": "[REDACTED]"}');
  assert.equal(makeFile('config.json', input).risks.length, 3);
});

test('large or malformed private-key bodies do not repeatedly scan overlapping content', () => {
  const header = '-----BEGIN PRIVATE KEY-----';
  const whitespace = ' '.repeat(250_000);
  assert.equal(redactSecrets(`${header}\n${whitespace}A`), `${header}\n${whitespace}[REDACTED]`);
  const nested = `${header}\n`.repeat(10_000) + 'MIIEvQIBADAnestedvalue';
  assert.equal(redactSecrets(nested), `${header}\n[REDACTED]`);
  assert.equal(makeFile('malformed-key.txt', nested).risks.length, 1);
});

test('long punctuation-separated identifiers do not repeatedly rescan credential candidates', () => {
  // Run adversarial synchronous work in a child so a regression cannot block
  // the test runner's event loop and prevent its own timeout from firing.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { analyzeFile, redactSecrets } from ${JSON.stringify(new URL('../src/core.js', import.meta.url).href)};
    const prefix = 'identifier-'.repeat(90_000);
    const input = prefix + '\\nconst $token = "a-real-value";\\nconfig.client.secret = "another-real-value";';
    assert.equal(redactSecrets(input), prefix + '\\nconst $token = "[REDACTED]";\\nconfig.client.secret = "[REDACTED]";');
    assert.deepEqual(analyzeFile({ path: 'large-config.ts', content: input }).risks.map(risk => risk.line), [2, 3]);
  `], { timeout: 5000, stdio: 'pipe' });
});

test('example placeholders and normal strings are not flagged as credentials', () => {
  const input = [
    'const api_key = "YOUR_API_KEY";',
    'const token = "<paste-token-here>";',
    'const password = "changeme";',
    'const secret = "example-secret";',
    'const token = "${ACCESS_TOKEN}";',
    'const apiKey = "process.env.API_KEY";',
    'const title = "Some secret message";',
    'AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";',
  ].join('\n');
  assert.equal(redactSecrets(input), input);
  assert.equal(makeFile('example.ts', input).risks.length, 0);
});

test('selection deduplicates ids, counts overhead, and ignores missing ids', () => {
  const files = [makeFile('src/main.ts', `const token = "${githubToken}";`), makeFile('README.md', '# Example')];
  const stats = calculateSelection(files, ['src/main.ts', 'src/main.ts', 'unknown']);
  assert.equal(stats.count, 1);
  assert.equal(stats.bytes, files[0].bytes);
  assert.equal(stats.risks, 1);
  assert.ok(stats.tokens > files[0].tokens);
  assert.deepEqual(calculateSelection(files, []), { count: 0, tokens: 0, bytes: 0, risks: 0 });
  assert.equal(buildContext(files, []), '');
});

test('smart selection prioritizes guidance and entry points, remaining within inclusive budget', () => {
  const files = [makeFile('src/util.ts'), makeFile('README.md'), makeFile('src/main.ts'), makeFile('package.json')];
  const firstCost = calculateSelection(files, ['README.md']).tokens;
  assert.deepEqual(suggestSelection(files, firstCost), ['README.md']);
  assert.deepEqual(suggestSelection(files, firstCost - 1), []);
  assert.deepEqual(suggestSelection(files, 0), []);
  assert.deepEqual(suggestSelection(files, NaN), []);
  for (let budget = 1; budget < 1800; budget += 7) {
    const ids = suggestSelection(files, budget);
    assert.ok(calculateSelection(files, ids).tokens <= budget, `budget=${budget}`);
    const markdown = buildContext(files, ids, { redact: false });
    const xml = buildContext(files, ids, { format: 'xml', redact: false });
    assert.ok(estimateTokens(markdown) <= budget);
    assert.ok(estimateTokens(xml) <= budget);
  }
  assert.deepEqual(suggestSelection(files, 10_000), ['README.md', 'package.json', 'src/main.ts', 'src/util.ts']);
});

test('budget accounts for XML escape expansion and markdown fence growth', () => {
  const files = [makeFile('src/<&>.ts', '<&>"\''.repeat(800)), makeFile('docs/fence.md', '`'.repeat(800))];
  const ids = files.map(file => file.id);
  const stats = calculateSelection(files, ids);
  for (const format of ['xml', 'markdown']) {
    const exported = buildContext(files, ids, { format, redact: false, projectName: '项目😀'.repeat(80) });
    assert.ok(stats.tokens >= estimateTokens(exported), format);
  }
  assert.ok(calculateSelection(files, suggestSelection(files, stats.tokens - 1)).tokens <= stats.tokens - 1);
});

test('budget also covers short credentials that grow when redacted and long project labels', () => {
  const files = [makeFile('a.ts', 'const password = "ab";\n'.repeat(200))];
  const ids = ['a.ts'];
  const budget = calculateSelection(files, ids).tokens;
  for (const format of ['xml', 'markdown']) {
    for (const projectName of ['😀'.repeat(120), '中'.repeat(120), "'".repeat(120)]) {
      assert.ok(estimateTokens(buildContext(files, ids, { format, projectName })) <= budget);
    }
  }
  const empty = [makeFile('a', '')];
  for (const format of ['xml', 'markdown']) {
    assert.ok(estimateTokens(buildContext(empty, ['a'], { format, projectName: '😀'.repeat(120) })) <= calculateSelection(empty, ['a']).tokens);
  }
});

test('markdown safely exports nested fences, unusual paths, project labels, and default redaction', () => {
  const files = [makeFile('docs/a`b.md', `# Demo\n\n\`\`\`js\nconst token = "${githubToken}";\n\`\`\``)];
  const output = buildContext(files, ['docs/a`b.md'], { projectName: '<script>alert(1)</script>' });
  assert.ok(output.includes('````markdown\n'));
  assert.ok(output.includes('``docs/a`b.md``'));
  assert.ok(output.includes('\\<script\\>'));
  assert.ok(!output.includes(githubToken));
  assert.ok(output.includes('[REDACTED]'));
  assert.ok(output.includes('untrusted context'));
  assert.ok(buildContext(files, ['docs/a`b.md'], { redact: false }).includes(githubToken));
  assert.throws(() => buildContext(files, files.map(file => file.id), { format: 'html' }), /format/);
});

test('XML escapes content and metadata rather than allowing element or attribute injection', () => {
  const files = [makeFile('src/a"&b.ts', '<file>\n</files><evil a="x">&\0\'')];
  const output = buildContext(files, [files[0].id], { format: 'xml', projectName: '"><evil>&', redact: false });
  assert.ok(output.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(output.includes('project="&quot;&gt;&lt;evil&gt;&amp;"'));
  assert.ok(output.includes('path="src/a&quot;&amp;b.ts"'));
  assert.ok(output.includes('&lt;/files&gt;&lt;evil a=&quot;x&quot;&gt;&amp;\ufffd&apos;'));
  assert.ok(!output.includes('\0'));
  assert.ok(!output.includes('<evil'));
});

test('export rejects malicious file objects even if callers bypass analyzeFile', () => {
  const files = [{ id: 'a', path: '../outside', content: 'secret' }];
  assert.throws(() => buildContext(files, ['a']), /repository/);
  assert.throws(() => calculateSelection(files, ['a']), /repository/);
});

test('reused file objects invalidate export cost after content, path or language mutations', () => {
  const file = makeFile('a.ts', 'const answer = 42;');
  const files = [file], ids = [file.id];
  const original = calculateSelection(files, ids).tokens;
  assert.equal(calculateSelection(files, ids).tokens, original, 'reusing an unchanged object preserves its estimate');
  file.content = 'const password = "ab";\n'.repeat(100);
  const changedContent = calculateSelection(files, ids).tokens;
  assert.ok(changedContent > original);
  assert.ok(estimateTokens(buildContext(files, ids)) <= changedContent);
  assert.deepEqual(suggestSelection(files, original), [], 'automatic fitting must not reuse the old small-content cost');
  file.path = `docs/${'a&'.repeat(100)}.ts`;
  const changedPath = calculateSelection(files, ids).tokens;
  assert.ok(changedPath > changedContent);
  file.language = 'a'.repeat(1000);
  const changedLanguage = calculateSelection(files, ids).tokens;
  assert.ok(changedLanguage > changedPath);
  assert.ok(estimateTokens(buildContext(files, ids, { format: 'xml' })) <= changedLanguage);
  file.path = '../outside';
  assert.throws(() => calculateSelection(files, ids), /repository/, 'cached files still undergo path validation');
});
