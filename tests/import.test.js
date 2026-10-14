import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareImport, scopedIgnorePatterns, folderRelativePath, collectDroppedEntries, readIgnoreRules} from '../src/import-utils.js';
import {isIgnored} from '../src/core.js';
test('large dependency folders cannot displace source files at the import limit',()=>{
 const files=Array.from({length:6000},(_,i)=>({path:`node_modules/pkg/f${i}.js`}));files.push({path:'README.md'},{path:'src/app.js'},{path:'nested/.gitignore'});
 const result=prepareImport(files,2);assert.deepEqual(result.entries.map(f=>f.path),['README.md','src/app.js']);assert.equal(result.skipped,6001);assert.equal(result.ignoreFiles[0].path,'nested/.gitignore');
});
test('nested ignore rules are scoped and match recursive directory names with negation',()=>{
 const patterns=scopedIgnorePatterns('src/.gitignore','temp/\n*.log\n/local.txt\n!keep.log\n');
 assert.ok(isIgnored('src/deep/temp/cache.js',patterns));assert.ok(isIgnored('src/deep/error.log',patterns));assert.ok(isIgnored('src/local.txt',patterns));assert.equal(isIgnored('src/deep/local.txt',patterns),false);assert.equal(isIgnored('other/temp/cache.js',patterns),false);assert.equal(isIgnored('src/deep/keep.log',patterns),false);
});
test('folder paths remove only their root component, including regex-like folder names',()=>{
 assert.equal(folderRelativePath({webkitRelativePath:'repo[1]+/src/app.js',name:'app.js'}),'src/app.js');assert.equal(folderRelativePath({name:'README.md'}),'README.md');
});

test('custom ignored files and duplicate normalized paths do not consume the file cap',()=>{
 const source=Array.from({length:6000},(_,i)=>({path:`generated/f${i}.txt`}));
 source.push({path:'./README.md'},{path:'README.md'},{path:'src/app.js'},{path:'.gitignore'});
 const prepared=prepareImport(source,2,['generated/']);
 assert.deepEqual(prepared.entries.map(entry=>entry.path),['README.md','src/app.js']);
 assert.equal(prepared.skipped,6002);
 assert.deepEqual(prepared.ignoreFiles.map(entry=>entry.path),['.gitignore']);
});

test('folder imports cannot reinclude a file until every excluded parent is reopened',()=>{
 const files=[{path:'blocked/allowed.txt'},{path:'blocked/deep/allowed.txt'},{path:'README.md'}];
 assert.deepEqual(prepareImport(files,5000,['blocked/','!blocked/allowed.txt']).entries.map(entry=>entry.path),['README.md']);
 assert.deepEqual(prepareImport(files,5000,['blocked/','!blocked/','blocked/*','!blocked/allowed.txt']).entries.map(entry=>entry.path),['blocked/allowed.txt','README.md']);
 assert.deepEqual(prepareImport(files,5000,['blocked/','!blocked/','blocked/*','!blocked/deep/allowed.txt']).entries.map(entry=>entry.path),['README.md']);
 assert.deepEqual(prepareImport(files,5000,['blocked/','!blocked/','blocked/*','!blocked/deep/','!blocked/deep/allowed.txt']).entries.map(entry=>entry.path),['blocked/deep/allowed.txt','README.md']);
});

test('folder ignore rules skip excluded subtrees but still read ignored .gitignore files',async()=>{
 let forbiddenReads=0;
 const ignores=[
  {path:'private/.gitignore',file:{size:9,text:async()=>{forbiddenReads++;return '!memo.txt';}}},
  {path:'src/.gitignore',file:new Blob(['*.log'])},
  {path:'.gitignore',file:new Blob(['private/\n.gitignore'])},
 ];
 const {patterns,truncated}=await readIgnoreRules(ignores);
 assert.equal(forbiddenReads,0);assert.equal(truncated,false);
 assert.equal(isIgnored('private/memo.txt',patterns),true);
 assert.equal(isIgnored('src/debug.log',patterns),true);
 assert.equal(isIgnored('other/debug.log',patterns),false);
});

test('folder ignore reading bounds aggregate bytes and reports unreadable rules',async()=>{
 const limited=await readIgnoreRules([
  {path:'.gitignore',file:new Blob(['*.log'])},
  {path:'src/.gitignore',file:new Blob(['*.txt'])},
 ],{maxBytes:5});
 assert.deepEqual(limited.patterns,['*.log']);assert.equal(limited.truncated,true);assert.deepEqual(limited.blockedDirectories,['src']);
 const eligible=prepareImport([{path:'src/secret.txt'},{path:'README.md'}],5000,limited.patterns,limited);
 assert.deepEqual(eligible.entries.map(entry=>entry.path),['README.md']);
 const failed=await readIgnoreRules([{path:'.gitignore',file:{size:1,text:async()=>{throw new Error('unreadable');}}}]);
 assert.deepEqual(failed.patterns,[]);assert.equal(failed.truncated,true);assert.deepEqual(failed.blockedDirectories,['']);
 assert.equal(prepareImport([{path:'secret.txt'}],5000,failed.patterns,failed).entries.length,0);
 const oversizedRoot=await readIgnoreRules([{path:'.gitignore',file:new Blob(['secret/'])}],{maxBytes:1});
 assert.deepEqual(oversizedRoot.blockedDirectories,['']);
 const unreadableNested=await readIgnoreRules([{path:'private/.gitignore',file:{size:1,text:async()=>{throw new Error('unreadable');}}}]);
 assert.deepEqual(unreadableNested.blockedDirectories,['private']);
});

function fileEntry(name,content='',onRead=()=>{}) {
 const file={name,size:new TextEncoder().encode(content).length,text:async()=>content};
 return {name,isFile:true,isDirectory:false,file(resolve){onRead();resolve(file);}};
}
function directoryEntry(name,children,batchSize=100) {
 return {name,isFile:false,isDirectory:true,createReader(){
  let cursor=0;
  return {readEntries(resolve){const batch=children.slice(cursor,cursor+batchSize);cursor+=batchSize;resolve(batch);}};
 }};
}

test('dropped folders read a late-batch .gitignore before applying the eligible-file cap',async()=>{
 const generated=Array.from({length:5000},(_,i)=>fileEntry(`f${i}.generated.js`));
 const root=directoryEntry('repo[1]+',[...generated,fileEntry('README.md'),fileEntry('.gitignore','*.generated.js')]);
 const collected=await collectDroppedEntries([root],{maxFiles:2});
 assert.equal(collected.name,'repo[1]+');
 assert.deepEqual(collected.result.map(entry=>entry.path),['README.md','.gitignore']);
 assert.equal(collected.skipped,5000);
 assert.equal(collected.truncated,false);
});

test('dropped nested ignore rules stay inside their subtree and ignored folders are not read',async()=>{
 let forbiddenReads=0;
 const root=directoryEntry('repo',[
  directoryEntry('private',[fileEntry('.gitignore','!memo.txt',()=>forbiddenReads++),fileEntry('memo.txt','',()=>forbiddenReads++)]),
  directoryEntry('src',[fileEntry('keep.log'),fileEntry('drop.log'),fileEntry('.gitignore','!keep.log')]),
  directoryEntry('other',[fileEntry('keep.log'),fileEntry('main.js')]),
  fileEntry('.gitignore','private/\n*.log'),
 ]);
 const collected=await collectDroppedEntries([root]);
 assert.deepEqual(collected.result.map(entry=>entry.path),['src/keep.log','src/.gitignore','other/main.js','.gitignore']);
 assert.equal(forbiddenReads,0);
 assert.equal(collected.truncated,false);
});

test('dropped file globs do not prune unrelated directories and ignored .gitignore files still apply',async()=>{
 const root=directoryEntry('repo',[
  directoryEntry('src',[fileEntry('app.js'),fileEntry('readme.txt')]),
  directoryEntry('assets.png',[fileEntry('module.js')]),
  fileEntry('.gitignore','*.txt\n.*'),
 ]);
 const collected=await collectDroppedEntries([root]);
 assert.deepEqual(collected.result.map(entry=>entry.path),['src/app.js','assets.png/module.js']);
});

test('drop collection reports entry and eligible-file truncation explicitly',async()=>{
 const root=directoryEntry('repo',Array.from({length:5},(_,i)=>fileEntry(`file${i}.js`)),2);
 const limitedEntries=await collectDroppedEntries([root],{maxEntries:3});
 assert.equal(limitedEntries.result.length,0);assert.equal(limitedEntries.truncated,true);
 const knownRules=directoryEntry('repo',[fileEntry('.gitignore','*.log'),...Array.from({length:5},(_,i)=>fileEntry(`file${i}.js`))],2);
 const partialWithRules=await collectDroppedEntries([knownRules],{maxEntries:3});
 assert.equal(partialWithRules.result.length,3);assert.equal(partialWithRules.truncated,true);
 const limitedFiles=await collectDroppedEntries([root],{maxFiles:2});
 assert.equal(limitedFiles.result.length,2);assert.equal(limitedFiles.truncated,true);
 const complete=await collectDroppedEntries([root]);
 assert.equal(complete.result.length,5);assert.equal(complete.truncated,false);
});

test('dropped directories with oversized or unreadable ignore files never contribute files',async()=>{
 const oversized=directoryEntry('private',[fileEntry('secret.txt'),fileEntry('.gitignore','secret.txt')]);
 const unreadableIgnore={name:'.gitignore',isFile:true,file(resolve){resolve({size:1,text:async()=>{throw new Error('unreadable');}});}};
 const unreadable=directoryEntry('private',[fileEntry('secret.txt'),unreadableIgnore]);
 for(const privateDirectory of [oversized,unreadable]) {
  const rootFailure=await collectDroppedEntries([privateDirectory],{maxIgnoreBytes:2});
  assert.deepEqual(rootFailure.result,[]);assert.equal(rootFailure.truncated,true);
  const nestedFailure=await collectDroppedEntries([directoryEntry('repo',[privateDirectory,fileEntry('README.md')])],{maxIgnoreBytes:2});
  assert.deepEqual(nestedFailure.result.map(entry=>entry.path),['README.md']);assert.equal(nestedFailure.truncated,true);
 }
 const lateRules=directoryEntry('repo',[fileEntry('secret.txt'),fileEntry('another.txt'),fileEntry('.gitignore','*.txt')],1);
 const missingLateRules=await collectDroppedEntries([lateRules],{maxEntries:2});
 assert.deepEqual(missingLateRules.result,[]);assert.equal(missingLateRules.truncated,true);
});

test('drop collection skips unreadable entries and deduplicates overlapping files',async()=>{
 const broken={name:'broken.js',isFile:true,file(resolve,reject){reject(new Error('unreadable'));}};
 const collected=await collectDroppedEntries([broken,fileEntry('README.md'),fileEntry('README.md'),fileEntry('src.js')],{maxFiles:2});
 assert.deepEqual(collected.result.map(entry=>entry.path),['README.md','src.js']);
 assert.equal(collected.skipped,2);assert.equal(collected.truncated,false);
});
