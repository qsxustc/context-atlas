import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFile, calculateSelection } from '../src/core.js';
import {
  MAX_RECIPE_BYTES, MAX_RECIPES, createRecipe, fingerprintContent,
  parseRecipe, resolveRecipe, serializeRecipe,
} from '../src/recipes.js';

const makeFile = (path, content = 'export const answer = 42;\n') => analyzeFile({ path, content });
const options = { name: 'Daily API work', projectName: 'Atlas', budget: 16000 };
const example = () => createRecipe([makeFile('src/app.js')], ['src/app.js'], options);
const parseValue = value => parseRecipe(JSON.stringify(value));

test('recipes store canonical explicit paths and metadata without source contents or secret values', () => {
  const secret = `ghp_${'ABcd1234'.repeat(4)}`;
  const files = [makeFile('src/server.js', `const token = "${secret}";`), makeFile('README.md', '# API')];
  const recipe = createRecipe(files, ['src/server.js', 'README.md', 'src/server.js', 'missing'], {
    ...options, name: '  Daily API work  ', projectName: '  Atlas  ',
  });
  assert.deepEqual(Object.keys(recipe), ['type', 'version', 'name', 'projectName', 'budget', 'format', 'files']);
  assert.equal(recipe.type, 'context-atlas-recipe');
  assert.equal(recipe.version, 1);
  assert.equal(recipe.name, 'Daily API work');
  assert.equal(recipe.projectName, 'Atlas');
  assert.equal(recipe.format, 'markdown');
  assert.deepEqual(recipe.files.map(file => file.path), ['README.md', 'src/server.js']);
  assert.ok(recipe.files.every(file => Object.keys(file).join(',') === 'path,fingerprint'));
  const text = serializeRecipe(recipe);
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes('const token'));
  assert.deepEqual(parseRecipe(text), recipe);
  assert.deepEqual(createRecipe(files, [...files].reverse().map(file => file.id), options), recipe);
});

test('FNV-1a fingerprints match published ASCII vectors and hash UTF-8 consistently', () => {
  assert.equal(fingerprintContent(''), 'fnv1a64:cbf29ce484222325');
  assert.equal(fingerprintContent('a'), 'fnv1a64:af63dc4c8601ec8c');
  assert.equal(fingerprintContent('foobar'), 'fnv1a64:85944171f73967e8');
  assert.equal(fingerprintContent('hello'), 'fnv1a64:a430d84680aabd0b');
  for (const text of ['你好😀', '\ud800', 'source\r\n', 'source\n', '\0'.repeat(20)]) {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(text)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    assert.equal(fingerprintContent(text), `fnv1a64:${hash.toString(16).padStart(16, '0')}`);
  }
  assert.notEqual(fingerprintContent('source\r\n'), fingerprintContent('source\n'));
});

test('apply matches explicit paths against current imported files and reports changes and missing files', () => {
  const original = [makeFile('a.js', 'old'), makeFile('b.js', 'same'), makeFile('c.js', 'deleted')];
  const recipe = createRecipe(original, original.map(file => file.id), options);
  const current = [makeFile('b.js', 'same'), makeFile('a.js', 'new'), makeFile('unrelated.js', 'not selected')];
  const result = resolveRecipe(recipe, current);
  assert.deepEqual(result.selectedIds, ['a.js', 'b.js']);
  assert.deepEqual(result.changed, ['a.js']);
  assert.deepEqual(result.unchanged, ['b.js']);
  assert.deepEqual(result.missing, ['c.js']);
  assert.equal(result.tokens, calculateSelection(current, ['a.js', 'b.js']).tokens);
  assert.equal(result.overBudget, false);
  assert.equal(recipe.files[0].fingerprint, fingerprintContent('old'), 'applying keeps the saved baseline');
  assert.deepEqual(resolveRecipe(recipe, []), {
    selectedIds: [], missing: ['a.js', 'b.js', 'c.js'], changed: [], unchanged: [], tokens: 0, overBudget: false,
  });
});

test('over-budget recipes preserve every match and use conservative export estimates', () => {
  const files = [makeFile('a.js', 'const password = "ab";\n'.repeat(300)), makeFile('b.js', '&'.repeat(500))];
  const recipe = createRecipe(files, files.map(file => file.id), { ...options, budget: 500, format: 'xml' });
  const result = resolveRecipe(recipe, files);
  assert.deepEqual(result.selectedIds, ['a.js', 'b.js']);
  assert.equal(result.overBudget, true);
  assert.equal(result.tokens, calculateSelection(files, result.selectedIds).tokens);
  assert.deepEqual(result.unchanged, ['a.js', 'b.js']);
  assert.deepEqual(result.changed, []);
  recipe.budget = result.tokens;
  assert.equal(resolveRecipe(recipe, files).overBudget, false, 'a selection at the exact budget is allowed');
});

test('cached content fingerprints invalidate when callers mutate a reused analyzed object', () => {
  const file = makeFile('a.js', 'abc');
  const recipe = createRecipe([file], [file.id], options);
  assert.deepEqual(resolveRecipe(recipe, [file]).unchanged, ['a.js']);
  file.content = 'xyz';
  assert.deepEqual(resolveRecipe(recipe, [file]).changed, ['a.js']);
  const updated = createRecipe([file], [file.id], options);
  assert.notEqual(updated.files[0].fingerprint, recipe.files[0].fingerprint);
  assert.deepEqual(resolveRecipe(updated, [file]).unchanged, ['a.js']);
});

test('creation rejects empty selections, duplicate paths, and files outside safety defaults', () => {
  const file = makeFile('a.js');
  assert.throws(() => createRecipe([], [], options), /between 1 and 5000/);
  assert.throws(() => createRecipe([file], ['missing'], options), /between 1 and 5000/);
  assert.throws(() => createRecipe([file, { ...file, id: 'alias' }], ['a.js', 'alias'], options), /Duplicate/);
  assert.throws(() => createRecipe([{ id: 'outside', path: '../outside', content: 'source' }], ['outside'], options), /repository/);
  for (const path of ['.env', '.env.production', '.ssh/config', '.aws/config', 'credentials.json', 'certs/private.pem', 'node_modules/lib.js', 'dist/app.js', 'image.png', 'yarn.lock']) {
    const blocked = makeFile(path);
    assert.throws(() => createRecipe([blocked], [blocked.id], options), /safety filters/, path);
    const payload = example();
    payload.files[0].path = path;
    assert.throws(() => parseValue(payload), /safety filters/, path);
  }
  assert.doesNotThrow(() => createRecipe([makeFile('.env.example')], ['.env.example'], options));
});

test('imports reject unknown fields, unsupported versions, invalid hashes and noncanonical paths', () => {
  for (const field of ['content', 'redact', 'command', '__proto__']) {
    assert.throws(() => parseValue({ ...example(), [field]: 'untrusted' }), /supported fields/, field);
    const nested = example();
    Object.defineProperty(nested.files[0], field, { value: 'untrusted', enumerable: true });
    assert.throws(() => parseValue(nested), /supported fields/, field);
  }
  for (const mutation of [
    value => { value.version = 2; },
    value => { value.version = '1'; },
    value => { value.type = 'another-tool'; },
    value => { delete value.name; },
    value => { value.files = null; },
    value => { value.files = []; },
    value => { value.files[0] = null; },
    value => { delete value.files[0].fingerprint; },
    value => { value.files[0].fingerprint = 'fnv1a64:AF63DC4C8601EC8C'; },
    value => { value.files[0].fingerprint = 'sha256:abc'; },
    value => { value.files[0].fingerprint = 'fnv1a64:' + '0'.repeat(17); },
    value => { value.files.push({ ...value.files[0] }); },
  ]) {
    const payload = example();
    mutation(payload);
    assert.throws(() => parseValue(payload));
    assert.throws(() => serializeRecipe(payload));
    assert.throws(() => resolveRecipe(payload, []));
  }
  for (const path of ['../outside.js', 'src/../outside.js', '/etc/passwd', 'C:\\Users\\file.js', '\\\\host\\share', 'src\\app.js', './src/app.js', 'src//app.js', 'src/a\n.js', '']) {
    const payload = example();
    payload.files[0].path = path;
    assert.throws(() => parseValue(payload), /path|repository|relative/i, path);
  }
  for (const text of ['null', '[]', '{}', '{broken', '"recipe"']) assert.throws(() => parseRecipe(text));
  assert.throws(() => parseRecipe(new Uint8Array()), /JSON text/);
});

test('metadata validates Unicode name lengths, controls, budget integers, and supported formats', () => {
  for (const budget of [499, 2_000_001, 500.5, NaN, Infinity, '16000', null]) {
    assert.throws(() => createRecipe([makeFile('a.js')], ['a.js'], { ...options, budget }), /budget/);
  }
  for (const format of ['html', '', null]) {
    assert.throws(() => createRecipe([makeFile('a.js')], ['a.js'], { ...options, format }), /format/);
  }
  for (const [field, maximum] of [['name', 80], ['projectName', 120]]) {
    for (const value of ['', '  ', 'bad\nlabel', 'bad\0label', '😀'.repeat(maximum + 1), null]) {
      assert.throws(() => createRecipe([makeFile('a.js')], ['a.js'], { ...options, [field]: value }), new RegExp(field));
    }
    const recipe = createRecipe([makeFile('a.js')], ['a.js'], { ...options, [field]: '😀'.repeat(maximum) });
    assert.equal(Array.from(recipe[field]).length, maximum);
  }
  for (const budget of [500, 2_000_000]) assert.equal(createRecipe([makeFile('a.js')], ['a.js'], { ...options, budget }).budget, budget);
});

test('JSON imports count UTF-8 bytes before parsing and permit the exact 1 MiB boundary', () => {
  assert.equal(MAX_RECIPE_BYTES, 1_048_576);
  assert.equal(MAX_RECIPES, 30);
  const text = serializeRecipe(example());
  assert.deepEqual(parseRecipe(text + ' '.repeat(MAX_RECIPE_BYTES - Buffer.byteLength(text))), example());
  assert.throws(() => parseRecipe(text + ' '.repeat(MAX_RECIPE_BYTES - Buffer.byteLength(text) + 1)), /1 MiB/);
  const unicode = JSON.stringify({ text: '界'.repeat(Math.ceil(MAX_RECIPE_BYTES / 3)) });
  assert.ok(unicode.length < MAX_RECIPE_BYTES);
  assert.throws(() => parseRecipe(unicode), /1 MiB/);
});

test('file count and path length limits are inclusive and oversized recipe output is rejected', () => {
  const files = Array.from({ length: 5000 }, (_, index) => makeFile(`src/file-${index}.js`, ''));
  assert.equal(createRecipe(files, files.map(file => file.id), options).files.length, 5000);
  const extra = makeFile('src/extra.js');
  assert.throws(() => createRecipe([...files, extra], [...files, extra].map(file => file.id), options), /5000/);
  const payload = example();
  payload.files = [...Array.from({ length: 5001 }, (_, index) => ({ path: `file-${index}.js`, fingerprint: fingerprintContent('') }))];
  assert.throws(() => parseValue(payload), /5000/);
  const maxPath = 'a'.repeat(4997) + '.js';
  assert.equal(createRecipe([makeFile(maxPath)], [maxPath], options).files[0].path.length, 5000);
  assert.throws(() => createRecipe([makeFile(maxPath + 'a')], [maxPath + 'a'], options), /5000 characters/);
  payload.files = Array.from({ length: 250 }, (_, index) => ({ path: `${String(index).padStart(3, '0')}/${'a'.repeat(4993)}.js`, fingerprint: fingerprintContent('') }));
  assert.throws(() => serializeRecipe(payload), /1 MiB/);
});

test('large compact imports roundtrip when pretty-printing would exceed the metadata limit', () => {
  const payload = example();
  payload.files = Array.from({ length: 5000 }, (_, index) => ({
    path: `src/${index}-${'a'.repeat(140)}.js`, fingerprint: fingerprintContent(''),
  }));
  const compact = JSON.stringify(payload);
  assert.ok(Buffer.byteLength(compact) < MAX_RECIPE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(payload, null, 2) + '\n') > MAX_RECIPE_BYTES);
  const recipe = parseRecipe(compact);
  const output = serializeRecipe(recipe);
  assert.ok(Buffer.byteLength(output) <= MAX_RECIPE_BYTES);
  assert.ok(output.startsWith('{"type":'));
  assert.ok(output.endsWith('\n'));
  assert.deepEqual(parseRecipe(output), recipe);
  const files = payload.files.map(file => makeFile(file.path, ''));
  assert.deepEqual(createRecipe(files, files.map(file => file.id), options), recipe);
});

test('canonical JSON at the exact byte limit omits its optional newline and remains portable', () => {
  const payload = example();
  payload.files = Array.from({ length: 250 }, (_, index) => ({
    path: `src/${index}-${'a'.repeat(4000)}.js`, fingerprint: fingerprintContent(''),
  }));
  const remaining = MAX_RECIPE_BYTES - Buffer.byteLength(JSON.stringify(payload));
  assert.ok(remaining > 0);
  for (let index = 0, extra = remaining; extra > 0; index += 1) {
    const available = 5000 - payload.files[index].path.length;
    const count = Math.min(extra, available);
    payload.files[index].path += 'a'.repeat(count);
    extra -= count;
  }
  const compact = JSON.stringify(payload);
  assert.equal(Buffer.byteLength(compact), MAX_RECIPE_BYTES);
  const recipe = parseRecipe(compact);
  const output = serializeRecipe(recipe);
  assert.equal(Buffer.byteLength(output), MAX_RECIPE_BYTES);
  assert.ok(!output.endsWith('\n'));
  assert.deepEqual(parseRecipe(output), recipe);
});

test('apply ignores invalid or unsafe current files and handles duplicate ids consistently with context export', () => {
  const recipe = createRecipe([makeFile('saved.js')], ['saved.js'], options);
  const alias = { ...makeFile('saved.js'), id: 'shared' };
  const files = [{ ...makeFile('unrelated.js'), id: 'shared' }, alias, { id: 'bad', path: '../outside', content: 'secret' }, makeFile('.env')];
  assert.deepEqual(resolveRecipe(recipe, files).missing, ['saved.js']);
  const result = resolveRecipe(recipe, [alias]);
  assert.deepEqual(result.selectedIds, ['shared']);
  assert.deepEqual(result.unchanged, ['saved.js']);
  assert.equal(result.tokens, calculateSelection([alias], ['shared']).tokens);
});
