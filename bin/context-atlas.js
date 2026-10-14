#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  analyzeFile,
  buildContext,
  calculateSelection,
  estimateTokens,
  isIgnored,
  suggestSelection,
} from '../src/core.js';

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
  --output <file>       Write the context to a file. Default: stdout.
                       Use --output - to explicitly write to stdout.
  --format <format>     markdown (default) or xml.
  --no-redact           Export original content without secret redaction.
  --help, -h            Show this help.

Example:
  node bin/context-atlas.js ./my-app --budget 32000 --output context.md

Files stay local. Symlinks, ignored paths, binary files, and files over
1 MiB are skipped. The total eligible text limit is 50 MiB. Diagnostics
go to stderr, so stdout can be piped directly to another command.
`;

function parseArguments(args) {
  const options = { directory: undefined, budget: undefined, output: undefined, format: 'markdown', redact: true };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (argument === '--no-redact') {
      options.redact = false;
      continue;
    }
    if (argument.startsWith('--')) {
      const separator = argument.indexOf('=');
      const name = separator === -1 ? argument : argument.slice(0, separator);
      if (!['--budget', '--output', '--format'].includes(name)) throw new Error(`Unknown option: ${name}`);
      const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
      if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${name} requires a value.`);
      options[name.slice(2)] = value;
      continue;
    }
    if (argument.startsWith('-') || options.directory !== undefined) throw new Error(`Unexpected argument: ${argument}`);
    options.directory = argument;
  }
  if (!options.directory) throw new Error('A directory is required. Run with --help for usage.');
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

async function rootIgnorePatterns(root) {
  const filename = path.join(root, '.gitignore');
  try {
    const metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_FILE_BYTES) return [];
    const contents = decoder.decode(await readFile(filename));
    return contents.split(/\r?\n/).filter(line => line.trim() !== '' && !line.startsWith('#'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Unable to read .gitignore: ${error.message}`);
  }
}

async function scanRepository(directory, output) {
  const requestedRoot = path.resolve(directory);
  const metadata = await lstat(requestedRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('The input must be a directory, not a symlink.');
  const root = await realpath(requestedRoot);
  const ignored = await rootIgnorePatterns(root);
  let outputPath;
  if (output && output !== '-') {
    const requestedOutput = path.resolve(output);
    // Resolve the parent even when the output does not exist yet. The scanner
    // uses a real root, so lexical aliases (such as macOS /tmp) must match it.
    outputPath = path.join(await realpath(path.dirname(requestedOutput)), path.basename(requestedOutput));
  }
  const skipped = { ignored: 0, symlink: 0, binary: 0, large: 0, output: 0 };
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
        continue;
      }
      if (isIgnored(relative, ignored, { directory: information.isDirectory() })) {
        skipped.ignored++;
        continue;
      }
      if (!isWithin(root, await realpath(absolute))) {
        skipped.symlink++;
        continue;
      }
      if (information.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!information.isFile()) continue;
      if (absolute === outputPath) {
        skipped.output++;
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
  return { root, files, skipped };
}

async function writeOutput(filename, content) {
  if (!filename || filename === '-') {
    process.stdout.write(content);
    return;
  }
  const destination = path.resolve(filename);
  try {
    if ((await lstat(destination)).isSymbolicLink()) throw new Error('The output path must not be a symlink.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help);
    return;
  }
  const { root, files, skipped } = await scanRepository(options.directory, options.output);
  if (files.length === 0) throw new Error('No eligible text files were found in this directory.');
  const selected = options.budget === undefined ? files.map(file => file.id) : suggestSelection(files, options.budget);
  const exportOptions = { format: options.format, redact: options.redact, projectName: path.basename(root) };
  let content = buildContext(files, selected, exportOptions);
  // Check the final format too: XML escaping and filenames consume context space.
  while (options.budget !== undefined && estimateTokens(content) > options.budget && selected.length > 0) {
    selected.pop();
    content = buildContext(files, selected, exportOptions);
  }
  if (selected.length === 0) throw new Error('No files fit the requested token budget. Increase --budget.');
  await writeOutput(options.output, content);
  const summary = calculateSelection(files, selected);
  const skippedTotal = Object.values(skipped).reduce((total, count) => total + count, 0);
  const destination = options.output && options.output !== '-' ? ` to ${options.output}` : '';
  process.stderr.write(`Context Atlas: exported ${summary.count}/${files.length} files, ${estimateTokens(content)} estimated tokens${destination}. Skipped ${skippedTotal} paths.\n`);
}

main().catch(error => {
  process.stderr.write(`Context Atlas: ${error.message}\n`);
  process.exitCode = 1;
});
