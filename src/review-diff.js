import { isIgnored, normalizePath, redactSecrets } from './core.js';

const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 500;
const MAX_PATH_LENGTH = 4096;
const EMPTY_BLOBS = ['e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', '473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813'];
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
const invalid = () => fail('INVALID_DIFF', 'The patch is not a complete supported Git unified diff.');

function decodePath(value) {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) invalid();
  const bytes = [];
  for (let i = 1; i < value.length - 1; i++) {
    const char = value[i];
    if (char === '"') invalid();
    if (char !== '\\') {
      const point = value.codePointAt(i);
      if (point >= 0xd800 && point <= 0xdfff) invalid();
      bytes.push(...encoder.encode(String.fromCodePoint(point)));
      if (point > 0xffff) i++;
      continue;
    }
    const next = value[++i];
    if (next === '"' || next === '\\') bytes.push(next.charCodeAt(0));
    else if (/[0-7]/.test(next || '')) {
      const octal = value.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(octal) || parseInt(octal, 8) > 255) invalid();
      bytes.push(parseInt(octal, 8));i += 2;
    } else {
      const escapes = { a:7, b:8, t:9, n:10, v:11, f:12, r:13 };
      if (!(next in escapes)) invalid();
      bytes.push(escapes[next]);
    }
  }
  try { return decoder.decode(new Uint8Array(bytes)); } catch { invalid(); }
}

function safePath(value, prefix = '') {
  const decoded = decodePath(value);
  if (prefix && !decoded.startsWith(prefix)) invalid();
  const path = decoded.slice(prefix.length);
  try {
    if (path.length > MAX_PATH_LENGTH || normalizePath(path) !== path || /[\uD800-\uDFFF]/u.test(path)) invalid();
  } catch { fail('UNSAFE_DIFF_PATH', 'The patch contains an unsafe or unsupported file path.'); }
  return path;
}

function quotedEnd(text) {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\') { i++;continue; }
    if (text[i] === '"') return i + 1;
  }
  invalid();
}

function headerPaths(line) {
  const rest = line.slice('diff --git '.length);
  let pairs;
  if (rest.startsWith('"')) {
    const end = quotedEnd(rest);
    if (rest[end] !== ' ') invalid();
    pairs = [[rest.slice(0, end), rest.slice(end + 1)]];
  } else {
    const boundaries = [];
    for (let i = 0; i < rest.length; i++) if (rest[i] === ' '
      && i <= MAX_PATH_LENGTH + 2 && ((rest.startsWith('b/', i + 1) && rest.length - i - 1 <= MAX_PATH_LENGTH + 2)
        || rest.startsWith('"b/', i + 1))) boundaries.push(i);
    if (!boundaries.length) invalid();
    pairs = boundaries.map(index => [rest.slice(0, index), rest.slice(index + 1)]);
  }
  // Git leaves spaces unquoted, so " b/" may also occur inside a filename.
  // Keep every split until the file labels or rename metadata identify it.
  const paths = [];
  for (const [old, next] of pairs) {
    try { paths.push([safePath(old, 'a/'), safePath(next, 'b/')]); }
    catch (error) { if (pairs.length === 1) throw error; }
  }
  if (!paths.length) invalid();
  return paths;
}

function excluded(path, patterns, blockedDirectories) {
  if (blockedDirectories.some(directory => directory === '' || directory === '.'
    || path === directory || path.startsWith(`${directory}/`))) return 'blocked';
  const pieces = path.split('/');
  for (let i = 1; i < pieces.length; i++) {
    if (isIgnored(pieces.slice(0, i).join('/'), patterns, { directory: true })) return 'ignored';
  }
  return isIgnored(path, patterns) ? 'ignored' : null;
}

function readHunk(lines, start, previous) {
  const match = HUNK.exec(lines[start]);
  if (!match) invalid();
  const [oldStart, oldCount, newStart, newCount] = [match[1], match[2] ?? '1', match[3], match[4] ?? '1'].map(Number);
  if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)
    || (oldCount && !oldStart) || (newCount && !newStart)
    || oldStart + oldCount > Number.MAX_SAFE_INTEGER || newStart + newCount > Number.MAX_SAFE_INTEGER
    || (previous && (oldStart < previous.oldEnd || newStart < previous.newEnd))) invalid();
  let oldRead = 0, newRead = 0, index = start + 1, additions = 0, deletions = 0, hadLine = false, marker = false, lastPrefix;
  let oldEOF=Boolean(previous?.oldEOF), newEOF=Boolean(previous?.newEOF);
  const newLines = [];
  while (index < lines.length) {
    const line = lines[index];
    if (line === '\\ No newline at end of file') {
      if (!hadLine || marker) invalid();
      if (lastPrefix !== '+') oldEOF=true;
      if (lastPrefix !== '-') newEOF=true;
      marker = true;index++;continue;
    }
    if (oldRead === oldCount && newRead === newCount) break;
    if (!line || ![' ', '+', '-'].includes(line[0])
      || (oldEOF && line[0] !== '+') || (newEOF && line[0] !== '-')) invalid();
    marker = false;hadLine = true;lastPrefix=line[0];
    if (line[0] !== '+') oldRead++;
    if (line[0] !== '-') { newRead++;newLines.push(line.slice(1)); }
    if (line[0] === '+') additions++;
    if (line[0] === '-') deletions++;
    if (oldRead > oldCount || newRead > newCount) invalid();
    index++;
  }
  if (oldRead !== oldCount || newRead !== newCount || (!oldCount && !newCount)) invalid();
  return { index, additions, deletions, oldEnd:oldStart + oldCount, newEnd:newStart + newCount,
    oldStart, oldCount, newStart, newCount, newLines, oldEOF, newEOF };
}

function parseSection(lines, patterns, blockedDirectories) {
  const headerCandidates = headerPaths(lines[0]);
  let added = false, deleted = false, renameFrom, renameTo, oldMode, newMode;
  let oldPath, newPath, sawPaths = false, binary = false, meaningful = false, indexSeen = false, indexOld, indexNew;
  const hunks = [];
  let additions = 0, deletions = 0, previous;
  const seen = new Set();
  for (let i = 1; i < lines.length;) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      if (!sawPaths || binary) invalid();
      const hunk = readHunk(lines, i, previous);
      if ((added && (hunk.oldStart !== 0 || hunk.oldCount !== 0 || hunk.newStart !== 1))
        || (deleted && (hunk.newStart !== 0 || hunk.newCount !== 0 || hunk.oldStart !== 1 || previous))) invalid();
      hunks.push({newStart:hunk.newStart,newCount:hunk.newCount,newLines:hunk.newLines});
      additions += hunk.additions;deletions += hunk.deletions;previous=hunk;i=hunk.index;meaningful=true;
      continue;
    }
    if (hunks.length) invalid();
    if (line.startsWith('--- ')) {
      if (sawPaths || !lines[i + 1]?.startsWith('+++ ')) invalid();
      // Git appends a tab to path labels containing whitespace, even when quoted.
      const old = line.slice(4).replace(/\t$/, ''), next = lines[i + 1].slice(4).replace(/\t$/, '');
      oldPath = old === '/dev/null' ? null : safePath(old, 'a/');
      newPath = next === '/dev/null' ? null : safePath(next, 'b/');
      if (oldPath === null && newPath === null) invalid();
      sawPaths = true;i += 2;continue;
    }
    if (line === 'GIT binary patch' || (line.startsWith('Binary files ') && line.endsWith(' differ') && line.includes(' and '))) { binary=true;break; }
    let key, value;
    if (/^index [0-9a-f]{1,64}\.\.[0-9a-f]{1,64}(?: [0-7]{6})?$/.test(line)) {
      key='index';indexSeen=true;
      [indexOld,indexNew]=line.slice(6).split(' ')[0].split('..');
    }
    else if (/^new file mode [0-7]{6}$/.test(line)) { key='new';added=true;meaningful=true; }
    else if (/^deleted file mode [0-7]{6}$/.test(line)) { key='deleted';deleted=true;meaningful=true; }
    else if (/^old mode [0-7]{6}$/.test(line)) { key='old-mode';oldMode=line.slice(9);meaningful=true; }
    else if (/^new mode [0-7]{6}$/.test(line)) { key='new-mode';newMode=line.slice(9);meaningful=true; }
    else if (/^(?:dis)?similarity index (?:100|[1-9]?\d)%$/.test(line)) key=line.split(' ')[0];
    else if (line.startsWith('rename from ')) { key='rename-from';value=safePath(line.slice(12));renameFrom=value;meaningful=true; }
    else if (line.startsWith('rename to ')) { key='rename-to';value=safePath(line.slice(10));renameTo=value;meaningful=true; }
    else invalid();
    if (seen.has(key) || sawPaths) invalid();
    seen.add(key);i++;
  }
  const renamed = renameFrom !== undefined || renameTo !== undefined;
  const headers = headerCandidates.filter(([old, next]) =>
    (renamed ? renameFrom === old && renameTo === next : old === next)
    && (!sawPaths || (oldPath === (added ? null : old) && newPath === (deleted ? null : next))));
  if (headers.length !== 1) invalid();
  const [headerOld, headerNew] = headers[0];
  if (added && deleted || renamed && (added || deleted) || Boolean(oldMode) !== Boolean(newMode)
    || (renamed && (renameFrom !== headerOld || renameTo !== headerNew || renameFrom === renameTo))
    || (!renamed && headerOld !== headerNew)) invalid();
  if (sawPaths && (oldPath !== (added ? null : headerOld) || newPath !== (deleted ? null : headerNew))) invalid();
  if (!binary && (!meaningful || (sawPaths && !hunks.length)
    || (!hunks.length && !renamed && !oldMode && !indexSeen))) invalid();
  if (!binary && !hunks.length && (added || deleted)) {
    const absent = added ? indexOld : indexNew, present = added ? indexNew : indexOld;
    if (!absent || !/^0+$/.test(absent) || !present || present.length < 4
      || !EMPTY_BLOBS.some(hash=>hash.startsWith(present))) invalid();
  }
  if (added && hunks.some((hunk, i) => i > 0 || hunk.newStart !== 1)) invalid();
  if (deleted && hunks.some(hunk => hunk.newCount !== 0)) invalid();
  const path = deleted ? headerOld : headerNew;
  const reason = excluded(headerOld, patterns, blockedDirectories) || excluded(headerNew, patterns, blockedDirectories)
    || (binary ? 'binary' : null);
  if (reason) return {skipped:{path,reason}};
  return {change:{path,oldPath:added ? null : headerOld,status:added?'added':deleted?'deleted':renamed?'renamed':'modified',
    additions,deletions,patch:lines.join('\n')+'\n',hunks}};
}

/** Parse complete Git patches without reading files or executing repository code. */
export function parseGitDiff(text, { patterns = [], blockedDirectories = [] } = {}) {
  if (typeof text !== 'string') invalid();
  if (text.length > MAX_BYTES || encoder.encode(text).length > MAX_BYTES) fail('DIFF_TOO_LARGE', 'The patch exceeds the 1 MiB input limit.');
  if (!text.trim()) fail('EMPTY_DIFF', 'The patch contains no Git changes.');
  if (text.includes('\0')) invalid();
  // A pasted patch can have transport CRLF; real Git output with CRLF source
  // retains CR only on source lines, which must remain part of the snapshot.
  if (!/(?:^|[^\r])\n/.test(text) && text.includes('\r\n')) text=text.replaceAll('\r\n','\n');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines[0].startsWith('diff --git ') || lines.some(line => /^diff --(?:cc|combined) /.test(line))) invalid();
  const starts=[];
  for (let i=0;i<lines.length;i++) if (lines[i].startsWith('diff --git ')) starts.push(i);
  if (starts.length > MAX_FILES) fail('TOO_MANY_DIFF_FILES', 'The patch exceeds the 500-file limit.');
  const blocked = [...blockedDirectories].map(directory => {
    if (directory === '' || directory === '.') return '';
    try { return normalizePath(directory); } catch { fail('INVALID_DIFF_FILTER', 'The patch filters contain an invalid directory.'); }
  });
  const changes=[], skipped=[], paths=new Set();
  for (let i=0;i<starts.length;i++) {
    const section = lines.slice(starts[i], starts[i+1] ?? lines.length);
    const result = parseSection(section, patterns, blocked);
    const path = result.change?.path ?? result.skipped.path;
    if (paths.has(path)) fail('DUPLICATE_DIFF_PATH', 'The patch contains duplicate changed file paths.');
    paths.add(path);
    if (result.change) changes.push(result.change);else skipped.push(result.skipped);
  }
  if (!changes.length) fail('NO_ELIGIBLE_CHANGES', 'The patch contains no eligible text changes after filtering.');
  return {changes,skipped};
}

function privateKeyLines(entries) {
  let active = null;
  return entries.map(({text}) => {
    let secret = active !== null;
    for (const match of text.matchAll(/-----(BEGIN|END) ((?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY)-----/g)) {
      secret=true;
      if (match[1] === 'BEGIN') active=match[2];
      else if (active === match[2]) active=null;
    }
    return secret ? '[REDACTED PRIVATE KEY]' : text;
  });
}

/** Redact each semantic side, preserving diff line prefixes and hunk lengths. */
export function redactDiff(patch) {
  const lines=String(patch ?? '').split('\n'), output=[...lines];
  let old=[], next=[];
  const flush=()=>{
    for (const entries of [old,next]) {
      // Private-key blocks are masked per line first, so redactSecrets cannot
      // collapse their newline spans and invalidate line-to-diff mapping.
      const redacted=redactSecrets(privateKeyLines(entries).join('\n')).split('\n');
      entries.forEach((entry,i)=>{
        if (redacted[i] === entry.text) return;
        const replacement=entry.prefix+(redacted[i] ?? '[REDACTED]');
        if (output[entry.index] !== lines[entry.index] && output[entry.index] !== replacement)
          output[entry.index]=entry.prefix+'[REDACTED]';
        else output[entry.index]=replacement;
      });
    }
    old=[];next=[];
  };
  let oldLeft=0,newLeft=0;
  for (let i=0;i<lines.length;i++) {
    const line=lines[i];
    if (line.startsWith('diff --git ')) { flush();oldLeft=newLeft=0; }
    const hunk=HUNK.exec(line);
    if (hunk) { oldLeft=Number(hunk[2]??1);newLeft=Number(hunk[4]??1); }
    else if ((oldLeft||newLeft) && [' ','+','-'].includes(line[0])) {
      const entry={index:i,prefix:line[0],text:line.slice(1)};
      if (line[0] !== '+') { old.push(entry);oldLeft--; }
      if (line[0] !== '-') { next.push(entry);newLeft--; }
      continue;
    }
    output[i]=redactSecrets(line);
  }
  flush();return output.join('\n');
}
