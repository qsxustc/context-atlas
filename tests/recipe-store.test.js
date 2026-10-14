import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFile } from '../src/core.js';
import { createRecipe } from '../src/recipes.js';
import { readRecipeLibrary, writeRecipeLibrary, RECIPE_STORAGE_KEY } from '../src/recipe-store.js';

function storage() {
  const values = new Map();
  return { getItem:key=>values.get(key)??null, setItem:(key,value)=>values.set(key,value) };
}
function entry(id = 'test-1') {
  const files = [analyzeFile({path:'src/app.js',content:'const privateSource = 1;\n'})];
  return {id,recipe:createRecipe(files,['src/app.js'],{name:'Daily debugging',projectName:'example',budget:8000,format:'xml'})};
}
test('recipe library roundtrips metadata without source contents',()=>{
  const local = storage();
  assert.deepEqual(readRecipeLibrary(local),[]);
  const entries = [entry()];
  assert.deepEqual(writeRecipeLibrary(local,entries),entries);
  assert.deepEqual(readRecipeLibrary(local),entries);
  assert.ok(!local.getItem(RECIPE_STORAGE_KEY).includes('privateSource'));
});
test('corrupt persisted recipes fail without overwriting data',()=>{
  const local = storage();
  local.setItem(RECIPE_STORAGE_KEY,'{broken');
  assert.throws(()=>readRecipeLibrary(local));
  assert.equal(local.getItem(RECIPE_STORAGE_KEY),'{broken');
});
test('failed writes leave the prior library intact',()=>{
  const local = storage();
  writeRecipeLibrary(local,[entry()]);
  const before = local.getItem(RECIPE_STORAGE_KEY);
  const full = {getItem:local.getItem,setItem:()=>{throw new Error('QuotaExceededError');}};
  assert.throws(()=>writeRecipeLibrary(full,[entry('test-2')]));
  assert.equal(local.getItem(RECIPE_STORAGE_KEY),before);
  assert.deepEqual(readRecipeLibrary(local),[entry()]);
});
test('duplicate ids, unsupported wrappers and excess recipes are rejected before persistence',()=>{
  const local = storage();
  assert.throws(()=>writeRecipeLibrary(local,[entry(),entry()]));
  assert.throws(()=>writeRecipeLibrary(local,Array.from({length:31},(_,i)=>entry(`test-${i}`))));
  local.setItem(RECIPE_STORAGE_KEY,JSON.stringify([{...entry(),content:'not allowed'}]));
  assert.throws(()=>readRecipeLibrary(local));
});
test('unavailable storage and excessive library size are reported',()=>{
  assert.throws(()=>readRecipeLibrary({getItem:()=>{throw new Error('SecurityError');}}));
  assert.throws(()=>readRecipeLibrary({getItem:()=> ' '.repeat(4*1024*1024+1)}));
});
