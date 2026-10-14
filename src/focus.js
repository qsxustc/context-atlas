import { calculateSelection } from './core.js';

const SCRIPT_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const TEST_SUFFIX = /\.(?:test|spec)$/i;
const TEST_DIRECTORY = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)/;

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const stem = path => path.split('/').at(-1).replace(SCRIPT_EXTENSION, '').replace(TEST_SUFFIX, '');
const isTest = path => SCRIPT_EXTENSION.test(path)
  && (TEST_DIRECTORY.test(path) || TEST_SUFFIX.test(path.replace(SCRIPT_EXTENSION, '')));

function comparableDirectory(path) {
  const parts = path.split('/').slice(0, -1).filter(part => !/^(?:tests?|__tests__)$/.test(part));
  // Conventional source and test roots can mirror one another.
  if (parts[0] === 'src') parts.shift();
  return parts.join('/');
}

/**
 * A deterministic context plan around one imported file. Dependency traversal is
 * breadth-first; optional callers are only the root's direct incoming edges.
 * Related tests directly import the root/dependencies or match their filename.
 * Filename-only matches are conservative when several source files share a name.
 *
 * The root always stays selected, even when it exceeds the budget. Other files
 * are included whole, using the same conservative export costs as the main UI.
 * Missing imports are reported for every candidate, including omitted files.
 */
export function buildFocusPlan(files, graph, rootId, budget, { includeCallers = true, includeTests = true } = {}) {
  const empty = {
    selectedIds: [], candidates: [], unresolved: [], tokens: 0, allTokens: 0,
    overBudget: false, omittedCount: 0,
  };
  if (!(graph?.dependencies instanceof Map)) return empty;
  const byId = new Map();
  for (const file of files ?? []) {
    if (!file || typeof file.id !== 'string' || typeof file.path !== 'string'
      || byId.has(file.id) || !graph.dependencies.has(file.id)) continue;
    byId.set(file.id, file);
  }
  if (!byId.has(rootId)) return empty;

  const compareIds = (a, b) => compare(byId.get(a).path, byId.get(b).path) || compare(a, b);
  const validIds = ids => [...(ids ?? [])].filter(id => byId.has(id)).sort(compareIds);
  const candidates = [{ id: rootId, kind: 'root', depth: 0, included: false }];
  const known = new Set([rootId]);
  // An indexed queue avoids recursion and repeated array shifting on deep graphs.
  for (let index = 0; index < candidates.length; index += 1) {
    const parent = candidates[index];
    for (const id of validIds(graph.dependencies.get(parent.id))) {
      if (known.has(id)) continue;
      known.add(id);
      candidates.push({ id, kind: 'dependency', via: parent.id, depth: parent.depth + 1, included: false });
    }
  }
  const dependencyCandidates = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const compareRelated = (a, b) => dependencyCandidates.get(a).depth - dependencyCandidates.get(b).depth || compareIds(a, b);

  if (includeCallers) {
    for (const id of validIds(graph.dependents?.get(rootId))) {
      // Tests belong to the separate option, even though they are incoming edges.
      if (known.has(id) || isTest(byId.get(id).path)) continue;
      known.add(id);
      candidates.push({ id, kind: 'caller', via: rootId, depth: 1, included: false });
    }
  }

  if (includeTests) {
    const sourcesByStem = new Map();
    for (const file of byId.values()) {
      if (!SCRIPT_EXTENSION.test(file.path) || isTest(file.path)) continue;
      const name = stem(file.path);
      if (!sourcesByStem.has(name)) sourcesByStem.set(name, []);
      sourcesByStem.get(name).push(file.id);
    }
    const relatedTests = [];
    for (const id of validIds(byId.keys())) {
      const file = byId.get(id);
      if (known.has(id) || !isTest(file.path)) continue;
      const imports = [...(graph.dependencies.get(id) ?? [])]
        .filter(target => dependencyCandidates.has(target)).sort(compareRelated);
      let via = imports[0];
      let matchedBy = 'import';
      if (via === undefined) {
        const sameName = sourcesByStem.get(stem(file.path)) ?? [];
        const directory = comparableDirectory(file.path);
        via = sameName.filter(target => dependencyCandidates.has(target)
          && (sameName.length === 1 || comparableDirectory(byId.get(target).path) === directory))
          .sort(compareRelated)[0];
        matchedBy = 'filename';
      }
      if (via === undefined) continue;
      relatedTests.push({ id, kind: 'test', via, matchedBy, depth: dependencyCandidates.get(via).depth + 1, included: false });
    }
    relatedTests.sort((a, b) => a.depth - b.depth
      || (a.matchedBy === b.matchedBy ? 0 : a.matchedBy === 'import' ? -1 : 1)
      || compareIds(a.id, b.id));
    candidates.push(...relatedTests);
  }

  const cap = budget === Infinity ? Infinity : Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
  const root = byId.get(rootId);
  const rootTokens = calculateSelection([root], [rootId]).tokens;
  let used = rootTokens;
  const selectedIds = [rootId];
  candidates[0].included = true;
  for (const candidate of candidates.slice(1)) {
    const file = byId.get(candidate.id);
    // Core export costs are additive per file plus one shared header. Comparing
    // two files to the root avoids duplicating that private header constant and
    // keeps planning linear rather than recalculating a growing selection.
    const cost = calculateSelection([root, file], [rootId, candidate.id]).tokens - rootTokens;
    if (used + cost > cap) continue;
    candidate.included = true;
    selectedIds.push(candidate.id);
    used += cost;
  }

  const unresolved = [];
  for (const candidate of candidates) {
    const seen = new Set();
    const imports = [...(graph.unresolved?.get(candidate.id) ?? [])]
      .filter(item => item && typeof item.specifier === 'string' && typeof item.reason === 'string')
      .sort((a, b) => compare(a.specifier, b.specifier) || compare(a.reason, b.reason));
    for (const item of imports) {
      const key = JSON.stringify([item.specifier, item.reason]);
      if (seen.has(key)) continue;
      seen.add(key);
      unresolved.push({ id: candidate.id, specifier: item.specifier, reason: item.reason });
    }
  }
  const importedFiles = [...byId.values()];
  const tokens = calculateSelection(importedFiles, selectedIds).tokens;
  return {
    selectedIds, candidates, unresolved, tokens,
    allTokens: calculateSelection(importedFiles, candidates.map(candidate => candidate.id)).tokens,
    overBudget: tokens > cap,
    omittedCount: candidates.length - selectedIds.length,
  };
}
