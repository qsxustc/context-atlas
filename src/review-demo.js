import { demoProject } from './demo.js';

// This synthetic patch's new side matches the built-in project exactly.
export function demoReviewDiff() {
  const source=path=>demoProject.files.find(file=>file.path===path).content.split('\n');
  const storage=source('src/lib/storage.ts');
  const start=storage.indexOf('    const raw = localStorage.getItem(STORAGE_KEY);');
  const hook=source('src/hooks/useNotes.ts');
  const hookStart=hook.findIndex(line=>line.includes('useState<Note[]>(readNotes)'));
  return [
    'diff --git a/src/lib/storage.ts b/src/lib/storage.ts',
    '--- a/src/lib/storage.ts','+++ b/src/lib/storage.ts',
    `@@ -${start+1},4 +${start+1},6 @@`,
    ' '+storage[start],' '+storage[start+1],
    '-    return JSON.parse(raw) as Note[];',
    '+'+storage[start+2],'+'+storage[start+3],'+'+storage[start+4],
    ' '+storage[start+5],
    'diff --git a/src/hooks/useNotes.ts b/src/hooks/useNotes.ts',
    '--- a/src/hooks/useNotes.ts','+++ b/src/hooks/useNotes.ts',
    `@@ -${hookStart+1},2 +${hookStart+1},2 @@`,
    '-  const [notes, setNotes] = useState<Note[]>(readNotes());',
    '+'+hook[hookStart],' '+hook[hookStart+1],''
  ].join('\n');
}
