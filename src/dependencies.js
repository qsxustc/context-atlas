/**
 * Best-effort local JavaScript/TypeScript dependencies, without executing source.
 * This intentionally is not a compiler: template expressions, computed imports,
 * package exports, config inheritance, and bundler-specific syntax are omitted.
 */
import {normalizePath} from './core.js';

const SOURCE_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']);
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json', '.d.ts'];
const MAX_SOURCE_LENGTH = 1024 * 1024;
const MAX_TOKENS = 100000;
const MAX_IMPORTS = 2048;
const MAX_SPECIFIER_LENGTH = 2048;
const MAX_CONFIG_LENGTH = 128 * 1024;
const MAX_ALIASES = 128;
const MAX_ALIAS_TARGETS = 16;

const isWord = character => character !== undefined && /[\w$\u0080-\uffff]/.test(character);
const isSpace = character => character !== undefined && /\s/.test(character);

// Decode only JavaScript string escapes. Never evaluate an imported expression.
function readString(source, start) {
  const quote = source[start];
  let value = '', valid = true, index = start + 1;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === quote) return {end: index + 1, value: valid ? value : null};
    if (character === '\n' || character === '\r') return {end: index, value: null};
    if (character !== '\\') {
      if (value.length < MAX_SPECIFIER_LENGTH + 1) value += character;
      else valid = false;
      continue;
    }
    index += 1;
    const escaped = source[index];
    if (escaped === '\r' || escaped === '\n') {
      if (escaped === '\r' && source[index + 1] === '\n') index += 1;
      continue;
    }
    if (escaped === 'x' || escaped === 'u') {
      const braced = escaped === 'u' && source[index + 1] === '{';
      const digitsStart = index + (braced ? 2 : 1);
      const braceOffset = braced ? source.slice(digitsStart, digitsStart + 7).indexOf('}') : -1;
      const digitsEnd = braced ? (braceOffset < 0 ? -1 : digitsStart + braceOffset) : digitsStart + (escaped === 'x' ? 2 : 4);
      const digits = digitsEnd >= digitsStart && digitsEnd - digitsStart <= 6 ? source.slice(digitsStart, digitsEnd) : '';
      const code = /^[\da-f]+$/i.test(digits) ? Number.parseInt(digits, 16) : -1;
      if (code >= 0 && code <= 0x10ffff) value += String.fromCodePoint(code);
      else valid = false;
      if (digitsEnd >= digitsStart && digitsEnd - digitsStart <= 6) index = digitsEnd - (braced ? 0 : 1);
    } else {
      const escapes = {n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0'};
      if (escaped === undefined || /[1-9]/.test(escaped)) valid = false;
      else value += escapes[escaped] ?? escaped;
    }
    if (value.length > MAX_SPECIFIER_LENGTH) valid = false;
  }
  return {end: index, value: null};
}

function skipRegex(source, start) {
  let inClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\n' || character === '\r') return start + 1;
    if (character === '\\') { index += 1; continue; }
    if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (character === '/' && !inClass) {
      index += 1;
      while (isWord(source[index])) index += 1;
      return index;
    }
  }
  return start + 1;
}

function regexMayFollow(token) {
  if (!token || token.control) return true;
  if (token.kind === 'word') return /^(return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|else|do)$/.test(token.value);
  return token.kind === 'punctuation' && '=([{,:;!?&|+*%^~<>-}'.includes(token.value);
}

// Skip templates together with their expressions, including nested templates.
// Imports inside interpolation are deliberately omitted, rather than treating
// template text as executable code. Depth is bounded for adversarial source.
function skipTemplate(source, start) {
  const stack = [{template: true}];
  let index = start + 1;
  while (index < source.length && stack.length) {
    if (stack.length > 128) return source.length;
    const mode = stack.at(-1), character = source[index];
    if (mode.template) {
      if (character === '\\') index += 2;
      else if (character === '`') { stack.pop(); index += 1; }
      else if (character === '$' && source[index + 1] === '{') {
        stack.push({template: false, depth: 1, previous: null}); index += 2;
      } else index += 1;
      continue;
    }
    if (isSpace(character)) { index += 1; continue; }
    if (character === '"' || character === "'") {
      index = readString(source, index).end;
      mode.previous = {kind: 'string'};
    } else if (character === '`') {
      stack.push({template: true}); index += 1;
      mode.previous = {kind: 'string'};
    } else if (character === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index + 2); index = end < 0 ? source.length : end;
    } else if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2); index = end < 0 ? source.length : end + 2;
    } else if (character === '/' && regexMayFollow(mode.previous)) {
      index = skipRegex(source, index); mode.previous = {kind: 'regex'};
    } else if (isWord(character)) {
      const begin = index++;
      while (isWord(source[index])) index += 1;
      mode.previous = {kind: 'word', value: source.slice(begin, index)};
    } else {
      if (character === '{') mode.depth += 1;
      if (character === '}' && --mode.depth === 0) stack.pop();
      mode.previous = {kind: 'punctuation', value: character}; index += 1;
    }
  }
  return index;
}

function tokenize(source) {
  const tokens = [], parentheses = [];
  let index = 0, previous = null;
  while (index < source.length && tokens.length < MAX_TOKENS) {
    const character = source[index];
    if (isSpace(character)) { index += 1; continue; }
    if ((index === 0 && source.startsWith('#!')) || (character === '/' && source[index + 1] === '/')) {
      const end = source.indexOf('\n', index + 2); index = end < 0 ? source.length : end; continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2); index = end < 0 ? source.length : end + 2; continue;
    }
    let token;
    if (character === '"' || character === "'") {
      const string = readString(source, index); index = string.end;
      token = {kind: 'string', value: string.value};
    } else if (character === '`') {
      index = skipTemplate(source, index); token = {kind: 'template'};
    } else if (character === '/' && regexMayFollow(previous)) {
      const end = skipRegex(source, index);
      token = {kind: end > index + 1 ? 'regex' : 'punctuation', value: '/'}; index = end;
    } else if (isWord(character)) {
      const begin = index++;
      while (isWord(source[index])) index += 1;
      token = {kind: 'word', value: source.slice(begin, index)};
    } else {
      token = {kind: 'punctuation', value: character}; index += 1;
      if (character === '(') parentheses.push(previous?.kind === 'word' && /^(if|while|for|with|switch|catch)$/.test(previous.value));
      if (character === ')') token.control = parentheses.pop() ?? false;
    }
    tokens.push(token); previous = token;
  }
  return {tokens, limited: index < source.length};
}

function importSpecifiers(content) {
  const source = content.slice(0, MAX_SOURCE_LENGTH);
  const lexed = tokenize(source), specifiers = new Set();
  let limited = lexed.limited || source.length < content.length;
  const tokens = lexed.tokens;
  const add = token => {
    if (token?.kind !== 'string' || token.value === null) return;
    if (!token.value || token.value.length > MAX_SPECIFIER_LENGTH) return;
    if (specifiers.size < MAX_IMPORTS) specifiers.add(token.value);
    else limited = true;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== 'word' || !['import', 'export', 'require'].includes(token.value)) continue;
    if (tokens[index - 1]?.value === '.' || tokens[index - 1]?.value === '#') continue;
    const next = tokens[index + 1];
    if (token.value !== 'export' && next?.value === '(') {
      if (tokens[index + 3]?.value === ')' || (token.value === 'import' && tokens[index + 3]?.value === ',')) add(tokens[index + 2]);
      continue;
    }
    if (token.value === 'require') continue;
    if (token.value === 'import' && next?.kind === 'string') { add(next); continue; }
    let cursor = index + 1;
    if (tokens[cursor]?.value === 'type') cursor += 1;
    if (token.value === 'export' && !['{', '*'].includes(tokens[cursor]?.value)) continue;
    // A bounded lookahead covers multiline import/export clauses. Stop before
    // other statements so arbitrary later string literals cannot become edges.
    let braces = 0;
    for (let steps = 0; cursor < tokens.length && steps < 256; cursor += 1, steps += 1) {
      const current = tokens[cursor];
      if (current.value === '{') braces += 1;
      if (current.value === '}') braces -= 1;
      if (braces === 0 && current.value === 'from' && tokens[cursor + 1]?.kind === 'string') { add(tokens[cursor + 1]); break; }
      if (braces === 0 && (current.kind === 'string' || [';', '=', '(', ')', 'import', 'export', 'const', 'let', 'function', 'class'].includes(current.value))) break;
      if (steps === 255) limited = true;
    }
  }
  return {specifiers, limited};
}

function resolveSegments(base, path) {
  if (typeof path !== 'string' || !path || path.length > MAX_SPECIFIER_LENGTH || /[\u0000-\u001f\u007f\\?#]/.test(path) || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return null;
  const segments = base ? base.split('/') : [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return null;
      segments.pop();
    } else segments.push(segment);
  }
  return segments.join('/');
}

function resolveFile(path, filesByPath) {
  if (filesByPath.has(path)) return filesByPath.get(path);
  const substitutions = {'.js': ['.ts', '.tsx', '.d.ts'], '.jsx': ['.tsx', '.d.ts'], '.mjs': ['.mts', '.d.mts'], '.cjs': ['.cts', '.d.cts']};
  const extension = path.slice(path.lastIndexOf('.'));
  for (const replacement of substitutions[extension] ?? []) {
    const candidate = filesByPath.get(path.slice(0, -extension.length) + replacement);
    if (candidate) return candidate;
  }
  for (const suffix of RESOLVE_EXTENSIONS) {
    const candidate = filesByPath.get(path + suffix);
    if (candidate) return candidate;
  }
  for (const suffix of RESOLVE_EXTENSIONS) {
    const candidate = filesByPath.get(`${path ? path + '/' : ''}index${suffix}`);
    if (candidate) return candidate;
  }
  return null;
}

// JSONC without execution: remove comments/trailing commas outside strings only.
function parseConfig(content) {
  if (content.length > MAX_CONFIG_LENGTH) return null;
  let stripped = '', index = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < content.length) {
    const character = content[index];
    if (character === '"') {
      const start = index++;
      while (index < content.length) {
        if (content[index] === '\\') index += 2;
        else if (content[index++] === '"') break;
      }
      stripped += content.slice(start, index);
    } else if (character === '/' && content[index + 1] === '/') {
      const end = content.indexOf('\n', index + 2); index = end < 0 ? content.length : end;
      stripped += ' ';
    } else if (character === '/' && content[index + 1] === '*') {
      const end = content.indexOf('*/', index + 2);
      if (end < 0) return null;
      index = end + 2; stripped += ' ';
    } else { stripped += character; index += 1; }
  }
  let json = '';
  for (index = 0; index < stripped.length; index += 1) {
    if (stripped[index] === '"') {
      const start = index++;
      while (index < stripped.length) {
        if (stripped[index] === '\\') index += 2;
        else if (stripped[index++] === '"') break;
      }
      json += stripped.slice(start, index); index -= 1;
    } else if (stripped[index] === ',') {
      let next = index + 1;
      while (isSpace(stripped[next])) next += 1;
      if (!['}', ']'].includes(stripped[next])) json += ',';
    } else json += stripped[index];
  }
  try {
    const config = JSON.parse(json);
    return config && typeof config === 'object' && !Array.isArray(config) ? config : null;
  } catch { return null; }
}

function readAliases(filesByPath) {
  const file = filesByPath.get('tsconfig.json') ?? filesByPath.get('jsconfig.json');
  if (!file) return {aliases: [], base: null};
  const config = parseConfig(String(file.content ?? ''));
  const options = config?.compilerOptions;
  if (!options || typeof options !== 'object' || Array.isArray(options)) return {aliases: [], base: null};
  const base = typeof options.baseUrl === 'string' ? resolveSegments('', options.baseUrl) : '';
  if (base === null) return {aliases: [], base: null};
  const aliases = [];
  if (options.paths && typeof options.paths === 'object' && !Array.isArray(options.paths)) {
    for (const [pattern, rawTargets] of Object.entries(options.paths).slice(0, MAX_ALIASES)) {
      if (!pattern || pattern.length > MAX_SPECIFIER_LENGTH || !Array.isArray(rawTargets)) continue;
      const wildcard = pattern.indexOf('*');
      if (wildcard !== -1 && pattern.indexOf('*', wildcard + 1) !== -1) continue;
      const targets = rawTargets.slice(0, MAX_ALIAS_TARGETS).filter(target => typeof target === 'string' && target.length <= MAX_SPECIFIER_LENGTH && target.indexOf('*') === target.lastIndexOf('*'));
      aliases.push({pattern, prefix: wildcard < 0 ? pattern : pattern.slice(0, wildcard), suffix: wildcard < 0 ? '' : pattern.slice(wildcard + 1), wildcard, targets});
    }
  }
  // TypeScript selects an exact match, then the longest matching wildcard prefix.
  aliases.sort((a, b) => (a.wildcard < 0 && b.wildcard < 0 ? 0 : a.wildcard < 0 ? -1 : b.wildcard < 0 ? 1 : b.prefix.length - a.prefix.length));
  return {aliases, base, hasBaseUrl: typeof options.baseUrl === 'string'};
}

function resolveImport(specifier, from, filesByPath, configuration) {
  if (specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')) {
    if (/[\u0000-\u001f\u007f\\?#]/.test(specifier)) return {reason: 'unsupported-specifier'};
    const path = resolveSegments(from.path.split('/').slice(0, -1).join('/'), specifier);
    return path === null ? {reason: 'outside-root'} : {file: resolveFile(path, filesByPath), reason: 'not-found'};
  }
  if (specifier.startsWith('/')) return {reason: 'unsupported-specifier'};
  for (const alias of configuration.aliases) {
    const matches = alias.wildcard < 0 ? specifier === alias.pattern : specifier.startsWith(alias.prefix) && specifier.endsWith(alias.suffix) && specifier.length >= alias.prefix.length + alias.suffix.length;
    if (!matches) continue;
    const captured = alias.wildcard < 0 ? '' : specifier.slice(alias.prefix.length, specifier.length - alias.suffix.length);
    let insideRoot = false;
    for (const target of alias.targets) {
      const path = resolveSegments(configuration.base, target.replace('*', () => captured));
      if (path === null) continue;
      insideRoot = true;
      const file = resolveFile(path, filesByPath);
      if (file) return {file};
    }
    return {reason: insideRoot ? 'not-found' : 'outside-root'};
  }
  if (configuration.hasBaseUrl) {
    const path = resolveSegments(configuration.base, specifier);
    const file = path === null ? null : resolveFile(path, filesByPath);
    if (file) return {file};
  }
  // Common local alias conventions are distinguishable from ordinary packages.
  // Surface these as incomplete analysis without inventing a filesystem target.
  if (specifier.startsWith('@/') || specifier.startsWith('~/') || specifier.startsWith('#')) return {reason: 'unconfigured-alias'};
  // npm, scoped npm packages, node:, and URLs are not repository dependencies.
  return {};
}

/**
 * Build direct edges between imported file IDs. Every accepted file has a map
 * entry; `supported` identifies source files whose imports were scanned.
 * Diagnostics include import specifiers and stable reason codes, never snippets.
 */
export function buildDependencyGraph(files) {
  const dependencies = new Map(), dependents = new Map(), unresolved = new Map(), supported = new Set();
  const filesByPath = new Map();
  for (const file of files ?? []) {
    if (!file || typeof file.path !== 'string' || file.id === undefined) continue;
    let path;
    try { path = normalizePath(file.path); } catch { continue; }
    if (filesByPath.has(path) || dependencies.has(file.id)) continue;
    filesByPath.set(path, {...file, path});
    dependencies.set(file.id, new Set()); dependents.set(file.id, new Set()); unresolved.set(file.id, []);
  }
  const configuration = readAliases(filesByPath);
  for (const file of filesByPath.values()) {
    const extension = file.path.split('.').at(-1).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(extension)) continue;
    supported.add(file.id);
    const scan = importSpecifiers(String(file.content ?? ''));
    for (const specifier of scan.specifiers) {
      const result = resolveImport(specifier, file, filesByPath, configuration);
      if (result.file) {
        dependencies.get(file.id).add(result.file.id);
        dependents.get(result.file.id).add(file.id);
      } else if (result.reason) unresolved.get(file.id).push({specifier, reason: result.reason});
    }
    if (scan.limited) unresolved.get(file.id).push({specifier: '', reason: 'analysis-limit'});
  }
  return {dependencies, dependents, unresolved, supported};
}
