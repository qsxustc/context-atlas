import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareImport, scopedIgnorePatterns, folderRelativePath} from '../src/import-utils.js';
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
