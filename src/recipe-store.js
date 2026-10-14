import { parseRecipe, serializeRecipe, MAX_RECIPES } from './recipes.js';

export const RECIPE_STORAGE_KEY = 'context-atlas.recipes.v1';
const MAX_LIBRARY_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

/** Storage failures never masquerade as a successful save or overwrite unreadable data. */
export function readRecipeLibrary(storage) {
  const raw = storage.getItem(RECIPE_STORAGE_KEY);
  if (raw === null) return [];
  if (raw.length > MAX_LIBRARY_BYTES || encoder.encode(raw).length > MAX_LIBRARY_BYTES) throw new Error('Recipe library is too large.');
  const data = JSON.parse(raw);
  if (!Array.isArray(data) || data.length > MAX_RECIPES) throw new Error('Invalid recipe library.');
  const ids = new Set();
  return data.map(entry => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !['id','recipe'].includes(key)) || typeof entry.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(entry.id) || ids.has(entry.id)) throw new Error('Invalid recipe library entry.');
    ids.add(entry.id);
    return { id: entry.id, recipe: parseRecipe(JSON.stringify(entry.recipe)) };
  });
}

export function writeRecipeLibrary(storage, entries) {
  if (!Array.isArray(entries) || entries.length > MAX_RECIPES) throw new Error('Recipe library limit reached.');
  const canonical = entries.map(entry => ({ id: entry.id, recipe: JSON.parse(serializeRecipe(entry.recipe)) }));
  const raw = JSON.stringify(canonical);
  // Reuse the reader to validate internal identifiers as well as portable recipes.
  readRecipeLibrary({ getItem: () => raw });
  storage.setItem(RECIPE_STORAGE_KEY, raw);
  return canonical;
}
