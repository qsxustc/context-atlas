#!/usr/bin/env node
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  analyzeFile,
  buildContext,
  calculateSelection,
  estimateTokens,
  isIgnored,
  normalizePath,
  suggestSelection,
} from '../src/core.js';
import { buildDependencyGraph } from '../src/dependencies.js';
import { buildFocusPlan } from '../src/focus.js';
import { parseGitDiff } from '../src/review-diff.js';
import { buildReviewPlan, buildReviewContext, calculateReviewSelection } from '../src/review.js';
import { createRecipe, parseRecipe, resolveRecipe, serializeRecipe } from '../src/recipes.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_REPOSITORY_BYTES = 50 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

const help = `Context Atlas — build AI context from a local code directory.

Usage:
  context-atlas <directory> [options]
  node bin/context-atlas.js <directory> [options]

Options:
  --budget <tokens>     Select useful files within an estimated token budget.
                       Without this option, include every eligible text file.
  --focus <path>        Build context around a repository-relative file path.
                       Includes local dependencies, imported-by modules, and tests.
                       Without --budget, include all related candidates.
  --diff <file|->       Build a review pack from a Git unified diff (1 MiB max).
                       Use - to read stdin. Cannot be combined with --focus.
                       Includes the patch, current changed files, and context.
  --recipe <file>       Replay saved paths using their current local content.
                       Uses the saved budget/format unless explicitly overridden.
                       Cannot be combined with --focus, --diff, --no-callers,
                       or --no-tests. Recipe inputs are limited to 1 MiB.
  --save-recipe <file>  Save selected paths and fingerprints for repeated exports.
                       Saves files only, including when exporting a review pack.
                       Recipes contain no source content or patch.
  --recipe-name <name>  Name the saved recipe. Requires --save-recipe.
  --no-callers         With --focus/--diff, exclude imported-by modules.
  --no-tests           With --focus/--diff, exclude related test candidates.
  --output <file>       Write the context to a file. Default: stdout.
                       Use --output - to explicitly write to stdout.
  --format <format>     markdown (default) or xml.
  --no-redact           Export original content without secret redaction.
  --help, -h            Show this help.

Example:
  node bin/context-atlas.js ./my-app --budget 32000 --output context.md
  node bin/context-atlas.js ./my-app --focus src/lib/storage.ts --budget 8000
  git diff --no-ext-diff --no-textconv HEAD | node bin/context-atlas.js . --diff - --budget 16000
  node bin/context-atlas.js . --focus src/storage.js --save-recipe storage.recipe.json
  node bin/context-atlas.js . --recipe storage.recipe.json --output context.md

Files stay local. Symlinks, ignored paths, binary files, and files over
1 MiB are skipped. The total eligible text limit is 50 MiB. Diagnostics
go to stderr, so stdout can be piped directly to another command.
`;

function parseArguments(args) {
  const options = { directory: undefined, budget: undefined, output: undefined, focus: undefined, diff: undefined, recipe: undefined, saveRecipe: undefined, recipeName: undefined, format: 'markdown', formatExplicit: false, redact: true, includeCallers: true, includeTests: true };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--no-redact') {
      options.redact = false;
      continue;
    }
    if (argument === '--no-callers' || argument === '--no-tests') {
      options[argument === '--no-callers' ? 'includeCallers' : 'includeTests'] = false;
      continue;
    }
    if (argument.startsWith('--')) {
      const separator = argument.indexOf('=');
      const name = separator === -1 ? argument : argument.slice(0, separator);
      if (!['--budget', '--output', '--format', '--focus', '--diff', '--recipe', '--save-recipe', '--recipe-name'].includes(name)) throw new Error(`Unknown option: ${name}`);
      const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${name} requires a value.`);
      const key = name === '--save-recipe' ? 'saveRecipe' : name === '--recipe-name' ? 'recipeName' : name.slice(2);
      options[key] = value;
      if (name === '--format') options.formatExplicit = true;
      continue;
    }
    if (argument.startsWith('-') || options.directory !== undefined) throw new Error(`Unexpected argument: ${argument}`);
    options.directory = argument;
  }
  if (!options.directory) throw new Error('A directory is required. Run with --help for usage.');
  if (options.focus !== undefined && options.diff !== undefined) throw new Error('--focus and --diff cannot be combined.');
  if (options.recipe !== undefined && (options.focus !== undefined || options.diff !== undefined)) throw new Error('--recipe cannot be combined with --focus or --diff.');
  if (options.recipe !== undefined && (!options.includeCallers || !options.includeTests)) throw new Error('--no-callers and --no-tests cannot be combined with --recipe; saved paths are replayed exactly.');
  if (!options.focus && options.diff === undefined && (!options.includeCallers || !options.includeTests)) throw new Error('--no-callers and --no-tests require --focus or --diff.');
  if (options.recipeName !== undefined && options.saveRecipe === undefined) throw new Error('--recipe-name requires --save-recipe.');
  if (options.recipe === '-' || options.saveRecipe === '-') throw new Error('--recipe and --save-recipe require file paths; stdin/stdout are not supported for recipes.');
  if (options.focus !== undefined) options.focus = normalizePath(options.focus);
  if (!['markdown', 'xml'].includes(options.format)) throw new Error('--format must be markdown or xml.');
  if (options.budget !== undefined) {
    if (!/^\d+$/.test(options.budget) || !Number.isSafeInteger(Number(options.budget)) || Number(options.budget) < 1) {
      throw new Error('--budget must be a positive integer.');
    }
    options.budget = Number(options.budget);
  }
  return options;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function diagnosticText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

async function readPatch(filename) {
  if (filename === '-') {
    const chunks = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.byteLength;
      if (length > MAX_FILE_BYTES) throw new Error('The diff exceeds the 1 MiB input limit.');
      chunks.push(chunk);
    }
    try {
      return { text: decoder.decode(Buffer.concat(chunks, length)) };
    } catch {
      throw new Error('The diff must contain valid UTF-8 text.');
    }
  }
  return readRegularText(filename, 'diff');
}

async function canonicalFilename(filename) {
  const requestedPath = path.resolve(filename);
  return path.join(await realpath(path.dirname(requestedPath)), path.basename(requestedPath));
}

async function readRegularText(filename, label) {
  const requestedPath = path.resolve(filename);
  const metadata = await lstat(requestedPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`The ${label} input must be a regular file, not a symlink.`);
  if (metadata.size > MAX_FILE_BYTES) throw new Error(`The ${label} exceeds the 1 MiB input limit.`);
  const canonicalPath = await canonicalFilename(filename);
  const handle = await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const current = await handle.stat();
    if (!current.isFile()) throw new Error(`The ${label} input must be a regular file.`);
    if (current.size > MAX_FILE_BYTES) throw new Error(`The ${label} exceeds the 1 MiB input limit.`);
    // A growing input cannot make this read allocate beyond the stated limit.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw new Error(`The ${label} exceeds the 1 MiB input limit.`);
    bytes = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new Error(`The ${label} must contain valid UTF-8 text.`);
  }
  return { text, canonicalPath };
}

async function rootIgnorePatterns(root) {
  const filename = path.join(root, '.gitignore');
  try {
    const metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('The root .gitignore must be a regular file, not a symlink.');
    if (metadata.size > MAX_FILE_BYTES) throw new Error('The root .gitignore exceeds the 1 MiB input limit.');
    const contents = decoder.decode(await readFile(filename));
    return contents.split(/\r?\n/).filter(line => line.trim() !== '' && !line.startsWith('#'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Unable to read .gitignore: ${error.message}`);
  }
}

async function scanRepository(directory, excludedPaths) {
  const requestedRoot = path.resolve(directory);
  const metadata = await lstat(requestedRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('The input must be a directory, not a symlink.');
  const root = await realpath(requestedRoot);
  const ignored = await rootIgnorePatterns(root);
  const skipped = { ignored: 0, symlink: 0, binary: 0, large: 0, output: 0, patch: 0, recipe: 0 };
  const blockedDirectories = [];
  const files = [];
  let totalBytes = 0;

  async function visit(folder) {
    const entries = await readdir(folder, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolute = path.join(folder, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      // Never traverse directory symlinks or read file symlinks.
      const information = await lstat(absolute);
      if (information.isSymbolicLink()) {
        skipped.symlink++;
        // The parser also blocks descendants; no need to follow a link to
        // discover whether its target is a file or directory.
        blockedDirectories.push(relative);
        continue;
      }
      if (isIgnored(relative, ignored, { directory: information.isDirectory() })) {
        skipped.ignored++;
        if (information.isDirectory()) blockedDirectories.push(relative);
        continue;
      }
      if (!isWithin(root, await realpath(absolute))) {
        skipped.symlink++;
        blockedDirectories.push(relative);
        continue;
      }
      if (information.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!information.isFile()) continue;
      if (excludedPaths.has(absolute)) {
        skipped[excludedPaths.get(absolute)]++;
        continue;
      }
      if (information.size > MAX_FILE_BYTES) {
        skipped.large++;
        continue;
      }
      // O_NOFOLLOW also closes the lstat/read symlink race on supported systems.
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let bytes;
      try {
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      if (bytes.byteLength > MAX_FILE_BYTES) {
        skipped.large++;
        continue;
      }
      if (bytes.includes(0)) {
        skipped.binary++;
        continue;
      }
      let content;
      try {
        content = decoder.decode(bytes);
      } catch {
        skipped.binary++;
        continue;
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_REPOSITORY_BYTES) {
        throw new Error('The repository exceeds the 50 MiB eligible text limit. Narrow the directory or add .gitignore rules.');
      }
      files.push(analyzeFile({ path: relative, content }));
    }
  }

  await visit(root);
  return { root, files, skipped, patterns: ignored, blockedDirectories };
}

async function preparePaths(options, patch, recipeInput) {
  const paths = new Map();
  const excludedPaths = new Map();
  for (const [kind, filename] of [['output', options.output], ['saveRecipe', options.saveRecipe]]) {
    if (!filename || filename === '-') continue;
    const destination = await canonicalFilename(filename);
    paths.set(kind, destination);
    excludedPaths.set(destination, kind === 'saveRecipe' ? 'recipe' : 'output');
    try {
      const metadata = await lstat(destination);
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`The ${kind === 'saveRecipe' ? 'recipe destination' : 'output path'} must be a regular file, not a symlink.`);
      if (kind === 'saveRecipe') {
        try {
          parseRecipe((await readRegularText(destination, 'recipe destination')).text);
        } catch {
          throw new Error('The recipe destination already exists and is not a valid recipe; refusing to overwrite a source file.');
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const inputs = [['diff', patch?.canonicalPath], ['recipe', recipeInput?.canonicalPath]];
  const seen = new Map();
  for (const [kind, filename] of [...paths, ...inputs]) {
    if (!filename) continue;
    if (seen.has(filename)) throw new Error(`The ${kind} path must not be the same as the ${seen.get(filename)} path.`);
    seen.set(filename, kind);
    if (kind === 'diff') excludedPaths.set(filename, 'patch');
    if (kind === 'recipe') excludedPaths.set(filename, 'recipe');
  }
  return { paths, excludedPaths };
}

async function writeExport(options, paths, files, selectedIds, root, content, originalRecipe) {
  const outputs = [];
  if (paths.has('output')) outputs.push({ destination: paths.get('output'), content });
  let savedRecipe;
  if (paths.has('saveRecipe')) {
    // Review recipes preserve the selected source files, never the old patch or
    // analysis. A replay must fit both the conservative and final-format costs.
    const sourceContent = buildContext(files, selectedIds, { format: options.format, redact: options.redact, projectName: path.basename(root) });
    const defaultBudget = Math.max(16000, calculateSelection(files, selectedIds).tokens, estimateTokens(sourceContent));
    savedRecipe = createRecipe(files, selectedIds, {
      name: options.recipeName ?? originalRecipe?.name ?? Array.from(`${path.basename(root)} context`).slice(0, 80).join(''),
      projectName: originalRecipe?.projectName ?? Array.from(path.basename(root)).slice(0, 120).join(''),
      budget: options.budget ?? defaultBudget,
      format: options.format,
    });
    outputs.push({ destination: paths.get('saveRecipe'), content: serializeRecipe(savedRecipe) });
  }
  // Stage every file before replacing any destination. Argument, recipe, and
  // write-permission failures leave existing exports and recipes untouched.
  const staged = [];
  try {
    for (const output of outputs) {
      const temporary = path.join(path.dirname(output.destination), `.context-atlas-${randomUUID()}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      staged.push({ temporary, destination: output.destination });
      try {
        await handle.writeFile(output.content, 'utf8');
      } finally {
        await handle.close();
      }
    }
    for (const output of staged) await rename(output.temporary, output.destination);
  } finally {
    await Promise.all(staged.map(output => unlink(output.temporary).catch(error => { if (error.code !== 'ENOENT') throw error; })));
  }
  if (!paths.has('output')) process.stdout.write(content);
  if (savedRecipe) process.stderr.write(`Context Atlas: saved recipe with ${savedRecipe.files.length} file paths to ${diagnosticText(options.saveRecipe)}. Recipes store paths and fingerprints only.\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help);
    return;
  }
  const patch = options.diff === undefined ? undefined : await readPatch(options.diff);
  const recipeInput = options.recipe === undefined ? undefined : await readRegularText(options.recipe, 'recipe');
  const recipe = recipeInput ? parseRecipe(recipeInput.text) : undefined;
  if (recipe) {
    options.budget ??= recipe.budget;
    if (!options.formatExplicit) options.format = recipe.format;
  }
  const { paths, excludedPaths } = await preparePaths(options, patch, recipeInput);
  const { root, files, skipped, patterns, blockedDirectories } = await scanRepository(options.directory, excludedPaths);
  if (files.length === 0 && !patch) throw new Error('No eligible text files were found in this directory.');
  if (recipe) {
    const resolution = resolveRecipe(recipe, files);
    if (resolution.missing.length) throw new Error(`The recipe has ${resolution.missing.length} missing or ineligible file paths. Restore them or update the recipe before exporting.`);
    if (!resolution.selectedIds.length) throw new Error('No saved recipe paths match eligible files.');
    if (resolution.tokens > options.budget) throw new Error('The current recipe files exceed the requested token budget. Increase --budget or update the recipe.');
    const content = buildContext(files, resolution.selectedIds, { format: options.format, redact: options.redact, projectName: recipe.projectName });
    if (estimateTokens(content) > options.budget) throw new Error('The current recipe files exceed the requested token budget. Increase --budget or update the recipe.');
    await writeExport(options, paths, files, resolution.selectedIds, root, content, recipe);
    const destination = options.output && options.output !== '-' ? ` to ${diagnosticText(options.output)}` : '';
    process.stderr.write(`Context Atlas: replayed recipe with ${resolution.selectedIds.length}/${files.length} files, ${estimateTokens(content)} estimated tokens${destination}.\n`);
    if (resolution.changed.length) process.stderr.write(`Context Atlas: ${resolution.changed.length} recipe files changed since saving; exported their current content.\n`);
    return;
  }
  if (patch) {
    const parsed = parseGitDiff(patch.text, { patterns, blockedDirectories });
    const plan = buildReviewPlan(files, buildDependencyGraph(files), parsed, options.budget ?? Infinity, {
      includeCallers: options.includeCallers,
      includeTests: options.includeTests,
    });
    if (plan.overBudget) throw new Error('The patch and current changed files do not fit the requested token budget. Increase --budget.');
    const selected = [...plan.selectedIds];
    const exportOptions = { format: options.format, redact: options.redact, projectName: path.basename(root) };
    let content = buildReviewContext(files, selected, plan, exportOptions);
    // Keep the patch and every available changed file. Only optional context
    // may be removed if the final format needs more space than the estimate.
    const mandatory = new Set(plan.candidates.filter(candidate => candidate.kind === 'changed').map(candidate => candidate.id));
    while (options.budget !== undefined && estimateTokens(content) > options.budget) {
      const removable = selected.findLastIndex(id => !mandatory.has(id));
      if (removable < 0) throw new Error('The patch and current changed files do not fit the requested token budget. Increase --budget.');
      selected.splice(removable, 1);
      content = buildReviewContext(files, selected, plan, exportOptions);
    }
    await writeExport(options, paths, files, selected, root, content);
    const summary = calculateReviewSelection(files, selected, plan);
    const destination = options.output && options.output !== '-' ? ` to ${diagnosticText(options.output)}` : '';
    const omittedCount = plan.candidates.length - selected.length;
    process.stderr.write(`Context Atlas: exported review pack for ${plan.changes.length} changed paths with ${summary.count}/${files.length} current files, ${estimateTokens(content)} estimated tokens${destination}.\n`);
    if (plan.skipped.length) process.stderr.write(`Context Atlas: ${plan.skipped.length} patch paths skipped by input filters.\n`);
    if (plan.missing.length) process.stderr.write(`Context Atlas: ${plan.missing.length} changed files are missing from the imported directory; their patch is included without current file content.\n`);
    if (plan.mismatched.length) process.stderr.write(`Context Atlas: ${plan.mismatched.length} changed files do not match the patch new side; import the matching working tree before relying on this review pack.\n`);
    if (omittedCount) process.stderr.write(`Context Atlas: ${omittedCount} related files omitted to fit the budget; review the selection before sharing.\n`);
    if (plan.unresolved.length) process.stderr.write(`Context Atlas: ${plan.unresolved.length} unresolved references or analysis limits; dependency context may be incomplete.\n`);
    return;
  }
  let focusPlan, focusImportsSupported = true;
  if (options.focus !== undefined) {
    const focusFile = files.find(file => file.path === options.focus);
    if (!focusFile) throw new Error('The focus path was not found among eligible files. Use a file path relative to the input directory.');
    const graph = buildDependencyGraph(files);
    focusImportsSupported = graph.supported.has(focusFile.id);
    focusPlan = buildFocusPlan(files, graph, focusFile.id, options.budget ?? Infinity, {
      includeCallers: options.includeCallers,
      includeTests: options.includeTests,
    });
    if (focusPlan.overBudget) throw new Error('The focus file does not fit the requested token budget. Increase --budget.');
  }
  const selected = focusPlan ? [...focusPlan.selectedIds] : options.budget === undefined ? files.map(file => file.id) : suggestSelection(files, options.budget);
  const exportOptions = { format: options.format, redact: options.redact, projectName: path.basename(root) };
  let content = buildContext(files, selected, exportOptions);
  // Check the final format too: XML escaping and filenames consume context space.
  while (options.budget !== undefined && estimateTokens(content) > options.budget && selected.length > 0) {
    if (focusPlan) {
      const removable = selected.findLastIndex(id => id !== options.focus);
      if (removable < 0) throw new Error('The focus file does not fit the requested token budget. Increase --budget.');
      selected.splice(removable, 1);
    } else selected.pop();
    content = buildContext(files, selected, exportOptions);
  }
  if (selected.length === 0) throw new Error('No files fit the requested token budget. Increase --budget.');
  await writeExport(options, paths, files, selected, root, content);
  const summary = calculateSelection(files, selected);
  const skippedTotal = Object.values(skipped).reduce((total, count) => total + count, 0);
  const destination = options.output && options.output !== '-' ? ` to ${diagnosticText(options.output)}` : '';
  process.stderr.write(`Context Atlas: exported ${summary.count}/${files.length} files, ${estimateTokens(content)} estimated tokens${destination}. Skipped ${skippedTotal} paths.\n`);
  if (focusPlan) {
    const omittedCount = focusPlan.candidates.length - selected.length;
    process.stderr.write(`Context Atlas: focus includes ${selected.length}/${focusPlan.candidates.length} related files.\n`);
    if (!focusImportsSupported) process.stderr.write('Context Atlas: import analysis supports JavaScript and TypeScript; imports in this focus file were not analyzed.\n');
    if (omittedCount) process.stderr.write(`Context Atlas: ${omittedCount} related files omitted to fit the budget; review the selection before sharing.\n`);
    if (focusPlan.unresolved.length) process.stderr.write(`Context Atlas: ${focusPlan.unresolved.length} unresolved references or analysis limits; dependency context may be incomplete.\n`);
  }
}

main().catch(error => {
  process.stderr.write(`Context Atlas: ${diagnosticText(error.message)}\n`);
  process.exitCode = 1;
});
