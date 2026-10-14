import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseGitDiff, redactDiff } from '../src/review-diff.js';

const modified = (name='src/main.js', old='old', next='new') => `diff --git a/${name} b/${name}\nindex 1234567..abcdef0 100644\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-${old}\n+${next}\n`;
const added = name => `diff --git a/${name} b/${name}\nnew file mode 100644\nindex 0000000..abcdef0\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,2 @@\n+first\n+second\n`;
const deleted = name => `diff --git a/${name} b/${name}\ndeleted file mode 100644\nindex abcdef0..0000000\n--- a/${name}\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-first\n-second\n`;
const moved = (old,next) => `diff --git a/${old} b/${next}\nsimilarity index 100%\nrename from ${old}\nrename to ${next}\n`;
const rejects = (patch, code='INVALID_DIFF') => assert.throws(()=>parseGitDiff(patch),{code});

test('Git diff parses modifications, additions, deletions, rename-only and multiple hunks',()=>{
  const patch=modified()+added('src/new.js')+deleted('old.js')+moved('docs/old.md','docs/new.md');
  const {changes,skipped}=parseGitDiff(patch);
  assert.deepEqual(changes.map(({path,status,additions,deletions})=>({path,status,additions,deletions})),[
    {path:'src/main.js',status:'modified',additions:1,deletions:1},
    {path:'src/new.js',status:'added',additions:2,deletions:0},
    {path:'old.js',status:'deleted',additions:0,deletions:2},
    {path:'docs/new.md',status:'renamed',additions:0,deletions:0},
  ]);
  assert.equal(changes[1].oldPath,null);
  assert.equal(changes[3].oldPath,'docs/old.md');
  assert.deepEqual(changes[1].hunks,[{newStart:1,newCount:2,newLines:['first','second']}]);
  assert.deepEqual(skipped,[]);
  assert.equal(changes.map(change=>change.patch).join(''),patch);
  const many=modified().replace('@@ -1 +1 @@','@@ -1,2 +1,2 @@').replace('-old\n+new',' before\n-old\n+new')+'@@ -10 +10 @@\n-a\n+b\n';
  assert.deepEqual(parseGitDiff(many).changes[0].hunks.map(h=>h.newLines),[['before','new'],['b']]);
});

test('no-newline markers preserve exact new side without becoming content',()=>{
  const patch=modified().replace('-old\n+new\n','-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
  assert.deepEqual(parseGitDiff(patch).changes[0].hunks[0].newLines,['new']);
  rejects(patch+'\\ No newline at end of file\n');
  assert.equal(parseGitDiff(modified().trimEnd()).changes.length,1);
});

test('EOF markers prohibit later content on their semantic side within and across hunks',()=>{
  const contextEOF=modified().replace('@@ -1 +1 @@\n-old\n+new',
    '@@ -1,2 +1,2 @@\n first\n\\ No newline at end of file\n-second\n+changed');
  rejects(contextEOF);
  const deletionEOF=modified().replace('@@ -1 +1 @@\n-old\n+new',
    '@@ -1,2 +1 @@\n-first\n\\ No newline at end of file\n-second\n+new');
  rejects(deletionEOF);
  const additionEOF=modified().replace('@@ -1 +1 @@\n-old\n+new',
    '@@ -1 +1,2 @@\n-old\n+first\n\\ No newline at end of file\n+second');
  rejects(additionEOF);
  rejects(modified()+'\\ No newline at end of file\n@@ -10 +10 @@\n-old\n+new\n');
  // The other side may continue: old EOF precedes its replacement new lines.
  const valid=modified().replace('@@ -1 +1 @@\n-old\n+new',
    '@@ -1 +1,2 @@\n-old\n\\ No newline at end of file\n+first\n+second');
  assert.deepEqual(parseGitDiff(valid).changes[0].hunks[0].newLines,['first','second']);
});

test('whole-file deletions require one contiguous hunk beginning at old line one',()=>{
  rejects(deleted('deleted.js').replace('@@ -1,2 +0,0 @@','@@ -20,2 +0,0 @@'));
  rejects(deleted('deleted.js').replace('@@ -1,2 +0,0 @@\n-first\n-second',
    '@@ -1 +0,0 @@\n-first\n@@ -20 +0,0 @@\n-second'));
  assert.equal(parseGitDiff(deleted('deleted.js')).changes[0].deletions,2);
});

test('space and Git-quoted octal UTF-8 paths decode without interpreting source',()=>{
  assert.equal(parseGitDiff(modified('src/my file.js')).changes[0].path,'src/my file.js');
  const name='src/项目.js';
  const escaped='src/\\351\\241\\271\\347\\233\\256.js';
  const patch=modified(name).replaceAll(`a/${name}`,`"a/${escaped}"`).replaceAll(`b/${name}`,`"b/${escaped}"`);
  assert.equal(parseGitDiff(patch).changes[0].path,name);
  assert.equal(parseGitDiff(modified('src/😀.js')).changes[0].path,'src/😀.js');
  const quote='src/a"b.js';
  const quoted=modified(quote).replaceAll(`a/${quote}`,`"a/src/a\\"b.js"`).replaceAll(`b/${quote}`,`"b/src/a\\"b.js"`);
  assert.equal(parseGitDiff(quoted).changes[0].path,quote);
});

test('unsafe paths and invalid quoted byte encodings fail without disclosing source',()=>{
  for(const name of ['../secret','/absolute','src/../secret','src//file','src/./file','C:/secret','src\\file','src/file\tname']) {
    assert.throws(()=>parseGitDiff(modified(name)),error=>['INVALID_DIFF','UNSAFE_DIFF_PATH'].includes(error.code),name);
  }
  for(const escaped of ['a/\\377.js','a/\\400.js','a/\\012.js','a/\\q.js']) {
    assert.throws(()=>parseGitDiff(modified().replace('a/src/main.js',`"${escaped}"`)),error=>['INVALID_DIFF','UNSAFE_DIFF_PATH'].includes(error.code));
  }
  const secret='PASSWORD_NEVER_IN_ERROR';
  assert.throws(()=>parseGitDiff(modified('../'+secret)),error=>!error.message.includes(secret));
});

test('credential and generated paths are filtered before returned changes include their bodies',()=>{
  const patch=modified('src/ok.js')+added('.env')+modified('keys/id_rsa')+deleted('.aws/config')+modified('node_modules/x/a.js')+moved('.env.production','public.txt');
  const result=parseGitDiff(patch);
  assert.deepEqual(result.changes.map(c=>c.path),['src/ok.js']);
  assert.equal(result.skipped.length,5);
  assert.ok(result.skipped.every(item=>item.reason==='ignored'));
  assert.ok(result.skipped.every(item=>Object.keys(item).sort().join(',')==='path,reason'));
  rejects(added('.env'),'NO_ELIGIBLE_CHANGES');
});

test('custom ignores include ignored ancestors and blocked folders, with both rename paths checked',()=>{
  const patch=modified('src/ok.js')+modified('private/note.js')+modified('blocked/note.js')+moved('old/a.js','src/a.js')+modified('assets.png/readme.md');
  const result=parseGitDiff(patch,{patterns:['private/','!private/note.js','old/'],blockedDirectories:['blocked']});
  assert.deepEqual(result.changes.map(c=>c.path),['src/ok.js','assets.png/readme.md']);
  assert.deepEqual(result.skipped.map(s=>s.reason),['ignored','blocked','ignored']);
  rejects(modified()+modified(), 'DUPLICATE_DIFF_PATH');
  assert.throws(()=>parseGitDiff(modified(),{blockedDirectories:['']}),{code:'NO_ELIGIBLE_CHANGES'});
  assert.throws(()=>parseGitDiff(modified(),{blockedDirectories:['../unsafe']}),{code:'INVALID_DIFF_FILTER'});
});

test('binary patches are skipped, including git binary blocks',()=>{
  const binary=`diff --git a/data.dat b/data.dat\nindex 1234567..abcdef0 100644\nBinary files a/data.dat and b/data.dat differ\n`;
  const encoded=`diff --git a/data2.dat b/data2.dat\nindex 1234567..abcdef0 100644\nGIT binary patch\nliteral 4\nLc${'x'.repeat(20)}\n\n`;
  const result=parseGitDiff(modified()+binary+encoded);
  assert.deepEqual(result.skipped,[{path:'data.dat',reason:'binary'},{path:'data2.dat',reason:'binary'}]);
  assert.equal(result.changes.length,1);
});

test('empty file creation/deletion and mode changes are complete zero-hunk changes',()=>{
  const patch=`diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29\n`+
    `diff --git a/old.txt b/old.txt\ndeleted file mode 100644\nindex e69de29..0000000\n`+
    `diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n`;
  const {changes}=parseGitDiff(patch);
  assert.deepEqual(changes.map(c=>c.status),['added','deleted','modified']);
  assert.ok(changes.every(c=>c.hunks.length===0));
});

test('truncated new/deleted patches cannot be mistaken for empty files',()=>{
  rejects(added('new.js').split('--- /dev/null')[0]);
  rejects(deleted('old.js').split('--- a/old.js')[0]);
  const sha256='diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..473a0f4\n';
  assert.equal(parseGitDiff(sha256).changes[0].status,'added');
});

test('truncated, malformed, overlapping and excess hunk lines reject the complete patch',()=>{
  for(const patch of [
    modified().replace('+new\n',''),modified()+'+extra\n',modified().replace('@@ -1 +1 @@','@@ -1,2 +1 @@'),
    modified().replace('@@ -1 +1 @@','@@ -0 +1 @@'),modified().replace('@@ -1 +1 @@','@@ -1,0 +1,0 @@'),
    modified()+'@@ -1 +1 @@\n-x\n+y\n',modified().replace('@@ -1 +1 @@','@@ -99999999999999999999 +1 @@'),
    modified().replace('--- a/src/main.js','--- a/other.js'),modified().replace('+++ b/src/main.js','+++ /dev/null'),
    modified().replace('@@ -1 +1 @@','@@@ -1 -1 +1 @@@'),modified()+'garbage\n',
    '--- a/src/main.js\n+++ b/src/main.js\n@@ -1 +1 @@\n-a\n+b\n',
    added('new.js').replace('@@ -0,0 +1,2 @@','@@ -1,1 +1,2 @@').replace('+first',' old\n+first'),
  ]) {
    rejects(patch);
  }
  rejects('diff --cc src/main.js\n@@@ -1 -1 +1 @@@\n');
  rejects(modified()+'diff --combined file.js\n');
  rejects(modified()+'diff --git a/incomplete b/incomplete\n');
  rejects(modified().replace('index 1234567..abcdef0 100644','copy from src/a.js'));
});

test('size, file count and empty input limits reject before returning partial results',()=>{
  rejects('', 'EMPTY_DIFF');rejects('  \n','EMPTY_DIFF');
  rejects('x'.repeat(1024*1024+1),'DIFF_TOO_LARGE');
  rejects('中'.repeat(400000),'DIFF_TOO_LARGE');
  rejects(Array.from({length:501},(_,i)=>modified(`src/f${i}.js`)).join(''),'TOO_MANY_DIFF_FILES');
  rejects(modified().replace('+new','+new\0'));
});

test('source CRLF is retained while uniformly transported CRLF is supported',()=>{
  const source=modified().replace('-old\n+new\n','-old\r\n+new\r\n');
  assert.deepEqual(parseGitDiff(source).changes[0].hunks[0].newLines,['new\r']);
  assert.deepEqual(parseGitDiff(modified().replaceAll('\n','\r\n')).changes[0].hunks[0].newLines,['new']);
});

test('diff redaction removes secrets on both semantic sides and preserves prefixes/counts',()=>{
  const old='const password = "old-sensitive-credential";',next='const password = "new-sensitive-credential";';
  const patch=modified('src/config.js',old,next), redacted=redactDiff(patch);
  assert.ok(!redacted.includes('old-sensitive'));assert.ok(!redacted.includes('new-sensitive'));
  assert.match(redacted,/-const password = "\[REDACTED\]";/);
  assert.match(redacted,/\+const password = "\[REDACTED\]";/);
  assert.equal(redacted.split('\n').length,patch.split('\n').length);
  assert.equal(parseGitDiff(redacted).changes[0].additions,1);
  const multiline=modified().replace('@@ -1 +1 @@\n-old\n+new','@@ -1,2 +1,2 @@\n password =\n-"old-multiline-credential"\n+"new-multiline-credential"');
  assert.ok(!redactDiff(multiline).includes('multiline-credential'));
});

test('multiline private keys, shared context and unterminated removed keys redact without collapsing lines',()=>{
  const patch=`diff --git a/src/config.js b/src/config.js\nindex 1234567..abcdef0 100644\n--- a/src/config.js\n+++ b/src/config.js\n@@ -1,4 +1,4 @@\n -----BEGIN RSA PRIVATE KEY-----\n-OLD_PRIVATE_MATERIAL_A\n-OLD_PRIVATE_MATERIAL_B\n+NEW_PRIVATE_MATERIAL_A\n+NEW_PRIVATE_MATERIAL_B\n -----END RSA PRIVATE KEY-----\n`;
  const redacted=redactDiff(patch);
  for(const secret of ['OLD_PRIVATE','NEW_PRIVATE']) assert.ok(!redacted.includes(secret));
  assert.equal(redacted.split('\n').length,patch.split('\n').length);
  assert.equal(parseGitDiff(redacted).changes[0].hunks[0].newLines.length,4);
  const truncatedKey=modified().replace('@@ -1 +1 @@\n-old\n+new','@@ -1,2 +1 @@\n------BEGIN PRIVATE KEY-----\n-PRIVATE_MATERIAL_WITHOUT_FOOTER\n+removed');
  assert.ok(!redactDiff(truncatedKey).includes('PRIVATE_MATERIAL_WITHOUT_FOOTER'));
  assert.match(redactDiff(truncatedKey),/\+removed/);
});

test('redaction resets private-key state between files and catches token patterns in hunk headers',()=>{
  const first=modified().replace('@@ -1 +1 @@\n-old\n+new','@@ -1,2 +1 @@\n------BEGIN PRIVATE KEY-----\n-body\n+gone');
  const second=modified('src/other.js','clean','also clean');
  assert.match(redactDiff(first+second),/\+also clean/);
  const token=`ghp_${'aB3'.repeat(12)}`;
  assert.ok(!redactDiff(modified().replace('@@ -1 +1 @@',`@@ -1 +1 @@ ${token}`)).includes(token));
});

test('real Git output covers quoted Unicode, whitespace, additions, deletion and rename',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'atlas-review-diff-'));
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  try {
    git('init','-q');git('config','user.email','test@example.com');git('config','user.name','Test');
    await mkdir(path.join(root,'src'));
    await writeFile(path.join(root,'src/项目 file.js'),'before\n');
    await writeFile(path.join(root,'old.md'),'rename me\n');
    await writeFile(path.join(root,'delete.txt'),'delete me\n');
    git('add','.');git('commit','-qm','base');
    await writeFile(path.join(root,'src/项目 file.js'),'after\n');
    await rename(path.join(root,'old.md'),path.join(root,'new name.md'));
    await rm(path.join(root,'delete.txt'));
    await writeFile(path.join(root,'added.txt'),'added\n');git('add','.');
    const patch=git('diff','--no-ext-diff','--no-textconv','HEAD');
    const result=parseGitDiff(patch);
    assert.equal(result.changes.length,4);
    assert.equal(result.changes.find(c=>c.path==='src/项目 file.js').hunks[0].newLines[0],'after');
    assert.equal(result.changes.find(c=>c.path==='new name.md').status,'renamed');
    assert.equal(result.changes.find(c=>c.path==='delete.txt').status,'deleted');
    assert.equal(result.changes.find(c=>c.path==='added.txt').status,'added');
  } finally { await rm(root,{recursive:true,force:true}); }
});
