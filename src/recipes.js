import { calculateSelection, isIgnored, normalizePath } from './core.js';

/** Recipes contain selection metadata only; their paths never trigger file reads. */
export const MAX_RECIPE_BYTES = 1024 * 1024;
export const MAX_RECIPES = 30;
const MAX_RECIPE_FILES = 5000;
const MAX_PATH_LENGTH = 5000;
const RECIPE_TYPE = 'context-atlas-recipe';
const RECIPE_FIELDS = ['type', 'version', 'name', 'projectName', 'budget', 'format', 'files'];
const FILE_FIELDS = ['path', 'fingerprint'];
const encoder = new TextEncoder();
const fingerprints = new WeakMap();

function exactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${label} must contain only the supported fields: ${fields.join(', ')}.`);
  }
}

function label(value, field, maximum) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`Recipe ${field} must be text without control characters.`);
  }
  const trimmed = value.trim();
  if (!trimmed || Array.from(trimmed).length > maximum) {
    throw new Error(`Recipe ${field} must contain between 1 and ${maximum} characters.`);
  }
  return trimmed;
}

function metadata({ name, projectName, budget, format }) {
  if (!Number.isInteger(budget) || budget < 500 || budget > 2_000_000) {
    throw new Error('Recipe budget must be an integer between 500 and 2000000 tokens.');
  }
  if (format !== 'markdown' && format !== 'xml') {
    throw new Error('Recipe format must be markdown or xml.');
  }
  return {
    name: label(name, 'name', 80),
    projectName: label(projectName, 'projectName', 120),
    budget,
    format,
  };
}

function safePath(value, { canonical = false } = {}) {
  const path = normalizePath(value);
  if (path.length > MAX_PATH_LENGTH || value.length > MAX_PATH_LENGTH) {
    throw new Error(`Recipe file paths must not exceed ${MAX_PATH_LENGTH} characters.`);
  }
  if (canonical && path !== value) throw new Error('Recipe file paths must use canonical relative paths with forward slashes.');
  if (isIgnored(path)) throw new Error(`Recipe file path is excluded by the default safety filters: ${path}`);
  return path;
}

function validateRecipe(value) {
  exactFields(value, RECIPE_FIELDS, 'Recipe');
  if (value.type !== RECIPE_TYPE || value.version !== 1) throw new Error('Unsupported Context Atlas recipe type or version.');
  const details = metadata(value);
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > MAX_RECIPE_FILES) {
    throw new Error(`Recipe must contain between 1 and ${MAX_RECIPE_FILES} file paths.`);
  }
  const seen = new Set();
  const files = value.files.map(entry => {
    exactFields(entry, FILE_FIELDS, 'Recipe file');
    const path = safePath(entry.path, { canonical: true });
    if (seen.has(path)) throw new Error(`Duplicate recipe file path: ${path}`);
    seen.add(path);
    if (typeof entry.fingerprint !== 'string' || !/^fnv1a64:[0-9a-f]{16}$/.test(entry.fingerprint)) {
      throw new Error('Recipe file fingerprint must be a supported fnv1a64 content fingerprint.');
    }
    return { path, fingerprint: entry.fingerprint };
  });
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { type: RECIPE_TYPE, version: 1, ...details, files };
}

function assertSize(text) {
  // UTF-8 cannot use fewer bytes than the number of UTF-16 code units here.
  if (text.length > MAX_RECIPE_BYTES || encoder.encode(text).length > MAX_RECIPE_BYTES) {
    throw new Error(`Recipe exceeds the ${MAX_RECIPE_BYTES}-byte limit (1 MiB).`);
  }
}

function serializeValidatedRecipe(recipe) {
  const pretty = JSON.stringify(recipe, null, 2) + '\n';
  if (pretty.length <= MAX_RECIPE_BYTES && encoder.encode(pretty).length <= MAX_RECIPE_BYTES) return pretty;
  // Large valid selections remain portable even when indentation would exceed the limit.
  const compact = JSON.stringify(recipe);
  assertSize(compact);
  return encoder.encode(compact).length < MAX_RECIPE_BYTES ? compact + '\n' : compact;
}

/** FNV-1a 64 is a stable change hint, not an integrity or authentication check. */
export function fingerprintContent(content) {
  const bytes = encoder.encode(String(content ?? ''));
  let high = 0xcbf29ce4, low = 0x84222325;
  for (const byte of bytes) {
    low = (low ^ byte) >>> 0;
    // Multiply by 0x100000001b3 using two 32-bit halves, avoiding per-byte BigInt.
    const product = low * 435;
    high = (Math.imul(high, 435) + Math.floor(product / 0x100000000) + (low << 8)) >>> 0;
    low = product >>> 0;
  }
  return `fnv1a64:${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}

function fileFingerprint(file) {
  const content = String(file.content ?? '');
  const previous = fingerprints.get(file);
  if (previous?.content === content) return previous.fingerprint;
  const fingerprint = fingerprintContent(content);
  fingerprints.set(file, { content, fingerprint });
  return fingerprint;
}

export function createRecipe(files, selectedIds, { name, projectName, budget, format = 'markdown' } = {}) {
  const details = metadata({ name, projectName, budget, format });
  const byId = new Map();
  for (const file of files ?? []) {
    if (file && typeof file.id === 'string' && !byId.has(file.id)) byId.set(file.id, file);
  }
  const seen = new Set();
  const selected = [];
  for (const id of selectedIds ?? []) {
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    const file = byId.get(id);
    selected.push({ path: safePath(file.path), file });
    if (selected.length > MAX_RECIPE_FILES) throw new Error(`Recipe must not exceed ${MAX_RECIPE_FILES} file paths.`);
  }
  const recipe = validateRecipe({
    type: RECIPE_TYPE, version: 1, ...details,
    files: selected.map(({ path, file }) => ({ path, fingerprint: fileFingerprint(file) })),
  });
  serializeValidatedRecipe(recipe);
  return recipe;
}

export function parseRecipe(text) {
  if (typeof text !== 'string') throw new TypeError('Recipe input must be JSON text.');
  assertSize(text);
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Recipe is not valid JSON.'); }
  const recipe = validateRecipe(value);
  // An accepted import must also fit a portable canonical export.
  serializeValidatedRecipe(recipe);
  return recipe;
}

export function serializeRecipe(recipe) {
  return serializeValidatedRecipe(validateRecipe(recipe));
}

/** Resolve against already imported files only, preserving an explicit selection over budget. */
export function resolveRecipe(recipe, files) {
  const validated = validateRecipe(recipe);
  const byPath = new Map();
  const seenIds = new Set();
  for (const file of files ?? []) {
    if (!file || typeof file.id !== 'string' || seenIds.has(file.id)) continue;
    // Match calculateSelection/buildContext's first-file-per-id behavior.
    seenIds.add(file.id);
    let path;
    try { path = safePath(file.path); } catch { continue; }
    if (!byPath.has(path)) byPath.set(path, file);
  }
  const selectedIds = [], missing = [], changed = [], unchanged = [];
  for (const entry of validated.files) {
    const file = byPath.get(entry.path);
    if (!file) { missing.push(entry.path); continue; }
    selectedIds.push(file.id);
    (fileFingerprint(file) === entry.fingerprint ? unchanged : changed).push(entry.path);
  }
  const tokens = calculateSelection(files, selectedIds).tokens;
  return { selectedIds, missing, changed, unchanged, tokens, overBudget: tokens > validated.budget };
}
