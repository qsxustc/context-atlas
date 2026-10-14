import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildDependencyGraph} from '../src/dependencies.js';

const file = (path, content = '', id = path) => ({id, path, content});
const edges = (graph, path) => [...graph.dependencies.get(path)].sort();

test('local import, re-export, require, and literal dynamic import create forward and reverse edges', () => {
  const graph = buildDependencyGraph([
    file('src/main.ts', `
      import value, {named as renamed} from './value';
      import type {Shape} from './types';
      import './style.css';
      export {value} from './value';
      export type {Shape} from './types';
      export * as utils from './utils';
      const a = require('./cjs');
      const b = import('./async');
      const c = import('./data.json', {with: {type: 'json'}});
      const d = import('./computed/' + name);
      import react from 'react';
      const fs = require('node:fs');
    `),
    ...['value.ts', 'types.ts', 'style.css', 'utils/index.js', 'cjs.cjs', 'async.ts', 'data.json'].map(name => file('src/' + name)),
  ]);
  assert.deepEqual(edges(graph, 'src/main.ts'), ['src/async.ts', 'src/cjs.cjs', 'src/data.json', 'src/style.css', 'src/types.ts', 'src/utils/index.js', 'src/value.ts']);
  assert.deepEqual([...graph.dependents.get('src/value.ts')], ['src/main.ts']);
  assert.equal(graph.supported.has('src/main.ts'), true);
  assert.equal(graph.supported.has('src/style.css'), false);
  assert.equal(graph.supported.has('src/data.json'), false);
  assert.deepEqual(graph.unresolved.get('src/main.ts'), []);
});

test('comments, ordinary strings, regexes, templates, and property calls do not invent imports', () => {
  const content = [
    '// import ghost from "./ghost";',
    '/* export {ghost} from "./ghost"; require("./ghost"); */',
    'const a = \'import ghost from "./ghost"\';',
    'const b = "require(\\\"./ghost\\\")";',
    'const regex = /require\\(".\\/ghost"\\)/g;',
    'if (ready) /import(".\\/ghost")/.test(text);',
    'const template = `import "./ghost" ${`nested ${"}"} require("./ghost")`} text`;',
    'const omittedExpression = `${import("./ghost")}`;',
    'const computed = import(`./ghost`);',
    'const computedRequire = require("./ghost" + suffix);',
    'obj.import("./ghost"); obj.require("./ghost");',
    'const unicodeimport = "./ghost";',
    'const result = 4 / require("./real") / 2;',
  ].join('\n');
  const graph = buildDependencyGraph([file('main.js', content), file('ghost.js'), file('real.js')]);
  assert.deepEqual(edges(graph, 'main.js'), ['real.js']);
  assert.deepEqual(graph.unresolved.get('main.js'), []);
});

test('cycles and self imports are represented once without recursion', () => {
  const graph = buildDependencyGraph([
    file('a.js', 'import "./b"; import "./b"; import "./a";'),
    file('b.js', 'export * from "./a";'),
    file('README.md', 'import "./a";'),
  ]);
  assert.deepEqual(edges(graph, 'a.js'), ['a.js', 'b.js']);
  assert.deepEqual(edges(graph, 'b.js'), ['a.js']);
  assert.deepEqual(edges(graph, 'README.md'), []);
  assert.deepEqual([...graph.dependents.get('a.js')].sort(), ['a.js', 'b.js']);
});

test('division after object literals or increments does not swallow real dependency imports', () => {
  for (const expression of [
    '{} / 2', '{nested: {}} / 2', '{method() {}} / 2',
    'counter++ / 2', 'counter-- / 2', '++counter / 2', '--counter / 2',
    '{} / require("./dep") / 2', 'counter++ / require("./dep") / 2',
    '{nested: {} / require("./dep") / 2}',
    'ready ? 0 : {} / 2', 'ready ? {} / 2 : 0',
    'ready ? {nested: {}} : {} / 2', 'ready ? (nested ? 0 : 1) : {} / 2',
    '`value ${ {} / 2 }`', '`value ${ counter++ / 2 }`',
    '`value ${ ready ? 0 : {} / 2 }`',
  ]) {
    const graph = buildDependencyGraph([
      file('main.js', `let counter = 1; const value = ${expression}; import "./dep";`),
      file('dep.js'),
    ]);
    assert.deepEqual(edges(graph, 'main.js'), ['dep.js'], expression);
    assert.deepEqual(graph.unresolved.get('main.js'), [], expression);
    if (expression.includes('require(')) {
      const direct = buildDependencyGraph([file('main.js', `let counter = 1; const value = ${expression};`), file('dep.js')]);
      assert.deepEqual(edges(direct, 'main.js'), ['dep.js'], `direct require: ${expression}`);
    }
  }
});

test('regex literals after statement blocks remain skipped while following imports are scanned', () => {
  const graph = buildDependencyGraph([
    file('main.js', String.raw`
      if (ready) {} /require(".\/ghost")/.test(text);
      function run() {} /import(".\/ghost")/.test(text);
      { let count = 0; ++count; } /require(".\/ghost")/.test(text);
      label: {} /require(".\/ghost")/.test(text);
      switch (state) { case 1: {} /require(".\/ghost")/.test(text); }
      function returns() { return
        {} /require(".\/ghost")/.test(text); }
      function* yields() { yield
        {} /require(".\/ghost")/.test(text); }
      function commentedReturn() { return /*
        */ {} /require(".\/ghost")/.test(text); }
      import './dep';
    `),
    file('dep.js'), file('ghost.js'),
  ]);
  assert.deepEqual(edges(graph, 'main.js'), ['dep.js']);
});

test('named imports and re-exports may themselves be named from or use string export names', () => {
  const graph = buildDependencyGraph([
    file('main.ts', `import {from as source, "string-name" as stringName} from './a'; export {from, "string-name"} from './b'; import from from './c';`),
    file('a.ts'), file('b.ts'), file('c.ts'),
  ]);
  assert.deepEqual(edges(graph, 'main.ts'), ['a.ts', 'b.ts', 'c.ts']);
});

test('relative resolution normalizes parents, checks repository boundary, and diagnoses missing local files', () => {
  const graph = buildDependencyGraph([
    file('src/main.js', `import '../lib/./a'; import '../../outside'; import './missing'; import './a?raw'; import '/absolute'; import 'npm-package';`),
    file('lib/a.ts'),
    file('../outside.js'),
  ]);
  assert.deepEqual(edges(graph, 'src/main.js'), ['lib/a.ts']);
  assert.deepEqual(graph.unresolved.get('src/main.js'), [
    {specifier: '../../outside', reason: 'outside-root'},
    {specifier: './missing', reason: 'not-found'},
    {specifier: './a?raw', reason: 'unsupported-specifier'},
    {specifier: '/absolute', reason: 'unsupported-specifier'},
  ]);
  assert.equal(graph.dependencies.has('../outside.js'), false);
});

test('explicit JS extensions resolve TypeScript sources, including ESM and CommonJS variants', () => {
  const graph = buildDependencyGraph([
    file('main.mts', `import './a.js'; import './b.jsx'; import './c.mjs'; import './d.cjs'; import './exact.js'; import './declaration.js';`),
    file('a.ts'), file('b.tsx'), file('c.mts'), file('d.cts'), file('exact.ts'), file('exact.js'), file('declaration.d.ts'),
  ]);
  assert.deepEqual(edges(graph, 'main.mts'), ['a.ts', 'b.tsx', 'c.mts', 'd.cts', 'declaration.d.ts', 'exact.js']);
  assert.equal(graph.supported.has('d.cts'), true);
});

test('root directory imports, exact assets, and escaped literal specifiers resolve deterministically', () => {
  const graph = buildDependencyGraph([
    file('main.js', String.raw`import '.'; import './folder'; import './data.json'; import './\u0061'; import './\x62';`),
    file('index.ts'), file('folder/index.tsx'), file('folder.ts'), file('data.json'), file('a.js'), file('b.js'),
  ]);
  assert.deepEqual(edges(graph, 'main.js'), ['a.js', 'b.js', 'data.json', 'folder.ts', 'index.ts']);
});

test('JSONC root config resolves baseUrl and exact, wildcard, suffix and fallback path mappings', () => {
  const graph = buildDependencyGraph([
    file('tsconfig.json', `{
      // Comments and trailing commas are accepted.
      "compilerOptions": {
        "baseUrl": ".",
        "paths": {
          "@/*": ["src/*"],
          "@/special/*": ["special/*"],
          "@/exact": ["exact.ts"],
          "model/*.js": ["missing/*", "models/*"],
          "outside/*": ["../*"],
        },
      },
      "example": "https://example.test/a/*kept*/",
    }`),
    file('main.ts', `import '@/ordinary'; import '@/special/item'; import '@/exact'; import 'model/entry.js'; import '@/missing'; import 'outside/secret'; import 'local/by-base'; import 'unconfigured/missing'; import 'react';`),
    ...['src/ordinary.ts', 'src/special/item.ts', 'special/item.ts', 'exact.ts', 'src/exact.ts', 'models/entry.ts', 'local/by-base.ts'].map(path => file(path)),
  ]);
  assert.deepEqual(edges(graph, 'main.ts'), ['exact.ts', 'local/by-base.ts', 'models/entry.ts', 'special/item.ts', 'src/ordinary.ts']);
  assert.deepEqual(graph.unresolved.get('main.ts'), [
    {specifier: '@/missing', reason: 'not-found'},
    {specifier: 'outside/secret', reason: 'outside-root'},
  ]);
});

test('jsconfig mappings use a relative baseUrl, or repository root when baseUrl is absent', () => {
  for (const [options, target] of [
    [{baseUrl: './src', paths: {'@/*': ['*']}}, 'src/lib/index.ts'],
    [{paths: {'@/*': ['src/*']}}, 'src/lib/index.ts'],
  ]) {
    const graph = buildDependencyGraph([
      file('jsconfig.json', JSON.stringify({compilerOptions: options})),
      file('main.js', 'import "@/lib";'), file(target),
    ]);
    assert.deepEqual(edges(graph, 'main.js'), [target]);
  }
});

test('alias captures are literal path text, including dollar replacement syntax', () => {
  const graph = buildDependencyGraph([
    file('tsconfig.json', '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}'),
    file('main.ts', 'import "@/$&";'),
    file('src/$&.ts'),
  ]);
  assert.deepEqual(edges(graph, 'main.ts'), ['src/$&.ts']);
});

test('invalid config, config inheritance and nested configs never execute or infer aliases', () => {
  for (const content of ['{"compilerOptions":', 'null', '{"extends":"./base.json"}', '{"compilerOptions":{"baseUrl":"../../escape"}}']) {
    const graph = buildDependencyGraph([
      file('tsconfig.json', content),
      file('base.json', '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}'),
      file('src/tsconfig.json', '{"compilerOptions":{"paths":{"@/*":["*"]}}}'),
      file('src/main.ts', 'import "@/a"; import "./a";'), file('src/a.ts'),
    ]);
    assert.deepEqual(edges(graph, 'src/main.ts'), ['src/a.ts']);
    assert.deepEqual(graph.unresolved.get('src/main.ts'), [{specifier: '@/a', reason: 'unconfigured-alias'}]);
  }
});

test('obvious unconfigured aliases are reported while ordinary scoped packages remain external', () => {
  const graph = buildDependencyGraph([
    file('src/main.ts', `import '@/local'; import '~/local'; import '#internal'; import '@scope/package'; import 'package/subpath';`),
    file('src/local.ts'),
  ]);
  assert.deepEqual(edges(graph, 'src/main.ts'), []);
  assert.deepEqual(graph.unresolved.get('src/main.ts'), [
    {specifier: '@/local', reason: 'unconfigured-alias'},
    {specifier: '~/local', reason: 'unconfigured-alias'},
    {specifier: '#internal', reason: 'unconfigured-alias'},
  ]);
});

test('graph preserves IDs, normalizes file paths and rejects duplicate or unsafe records', () => {
  const graph = buildDependencyGraph([
    file('./src/main.ts', 'import "./child";', 'entry-id'),
    file('src/child.ts', '', 'child-id'),
    file('src/child.ts', 'import "./unwanted";', 'duplicate-id'),
    file('/outside.ts', '', 'outside-id'),
    file('src/unused.ts', '', 'entry-id'),
  ]);
  assert.deepEqual(edges(graph, 'entry-id'), ['child-id']);
  assert.deepEqual([...graph.dependencies.keys()], ['entry-id', 'child-id']);
  assert.deepEqual([...graph.dependents.get('child-id')], ['entry-id']);
});

test('oversized source and import counts are bounded and disclose partial analysis', () => {
  const graph = buildDependencyGraph([
    file('large.js', '/*' + ' '.repeat(1024 * 1024) + '*/ import "./after";'),
    file('many.js', Array.from({length: 2050}, (_, index) => `import './missing${index}';`).join('\n')),
    file('after.js'),
  ]);
  assert.deepEqual(edges(graph, 'large.js'), []);
  assert.deepEqual(graph.unresolved.get('large.js'), [{specifier: '', reason: 'analysis-limit'}]);
  const diagnostics = graph.unresolved.get('many.js');
  assert.equal(diagnostics.length, 2049);
  assert.deepEqual(diagnostics.at(-1), {specifier: '', reason: 'analysis-limit'});
  assert.equal(diagnostics.every(item => Object.keys(item).length === 2), true);
});

test('hostile malformed unicode escapes and deeply nested templates terminate without edges', () => {
  const graph = buildDependencyGraph([
    file('escapes.js', 'const text = "' + '\\u{'.repeat(30000) + '"; import "./good";'),
    file('templates.js', 'const x = ' + '`x${'.repeat(150) + 'import "./ghost";' + '}`'.repeat(150)),
    file('good.js'), file('ghost.js'),
  ]);
  assert.deepEqual(edges(graph, 'escapes.js'), ['good.js']);
  assert.deepEqual(edges(graph, 'templates.js'), []);
});
