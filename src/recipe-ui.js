import { createRecipe, parseRecipe, serializeRecipe, resolveRecipe, MAX_RECIPE_BYTES, MAX_RECIPES } from './recipes.js';
import { readRecipeLibrary, writeRecipeLibrary } from './recipe-store.js';
import { calculateSelection } from './core.js';

const $ = id => document.getElementById(id);
const messages = {
  en: {
    title:'Context recipes', pitch:'Keep the context you come back to.', detail:'Save a file selection once. Reuse it with the latest code.',
    open:'My recipes · {n}', save:'Save selection', heading:'Your reusable contexts.', name:'Recipe name', placeholder:'e.g. Storage debugging',
    current:'Current selection: {n} files · ~{tokens} tokens · {format}', saveLocal:'Save locally', downloadCurrent:'Download selection as JSON',
    privacy:'Recipes persist in this browser. They contain names, paths, change fingerprints, budget and format — no source code or patch. JSON downloads contain the same metadata.',
    filesOnly:'Focus and Review selections are saved as a fixed file list. Reusing a recipe uses current file contents; import a fresh diff for a new Review Pack.',
    library:'SAVED RECIPES', import:'Import JSON', empty:'No recipes yet. Save the files you use for a recurring task.',
    apply:'Use recipe', update:'Update from selection', download:'JSON ↗', remove:'Delete', undo:'Undo delete', deleted:'Recipe deleted.',
    meta:'{project} · {n} files · {budget} token budget · {format}', coverage:'{matched}/{total} paths available · {changed} changed · {missing} missing',
    paths:'Saved file paths', changedLabel:'Changed since saved', missingLabel:'Missing or excluded',
    saved:'Recipe saved locally.', updated:'Recipe updated with the current selection.', imported:'Recipe imported. Load its project, then use the recipe.',
    failed:'Could not save locally. Browser storage may be unavailable or full. You can download the selection as JSON.',
    unreadable:'Saved recipes could not be read. Existing storage was preserved. Download the current selection to keep it.',
    invalid:'Invalid recipe: {reason}', limit:'You can save up to {n} recipes. Delete one or download JSON.',
    nothing:'Select at least one file to save a recipe.', noMatch:'No saved paths exist in this project. Load the matching project first. Your selection was preserved.',
    active:'Using “{name}” · {n}/{total} files · {changed} changed · {missing} missing. Export uses current file contents.',
    modified:'Selection changed. Update this recipe from the selection to save the new file list.', over:'Selection exceeds the current budget. Increase the budget or adjust the files before exporting.',
    different:'Project name differs from “{project}”; paths are matched relative to the imported folder.', busy:'Wait for import or analysis to finish.',
    exportMissing:'This recipe has {n} missing or excluded paths. This export contains only the available selected files; review the recipe before sharing.',
    exportChanged:'{n} recipe files have changed since saving. This export uses their current content.',
    tooLarge:'Recipe files must be no larger than 1 MiB.', downloaded:'Recipe JSON downloaded.', inspect:'Inspect {path}', close:'Close recipes',
  },
  zh: {
    title:'上下文配方', pitch:'留下你会反复使用的上下文。', detail:'保存一次文件选择，下次用最新代码继续。',
    open:'我的配方 · {n}', save:'保存当前选择', heading:'可重复使用的上下文。', name:'配方名称', placeholder:'例如：存储模块调试',
    current:'当前选择：{n} 个文件 · 约 {tokens} tokens · {format}', saveLocal:'保存到本地', downloadCurrent:'将当前选择下载为 JSON',
    privacy:'配方保存在此浏览器中，只包含名称、路径、变更指纹、预算与格式，不包含源码或补丁。下载的 JSON 也包含这些元数据。',
    filesOnly:'聚焦与审查的选择会保存为固定文件列表。复用时读取当前文件内容；新的审查包仍需导入新的 diff。',
    library:'已保存的配方', import:'导入 JSON', empty:'还没有配方。把重复任务常用的文件保存下来。',
    apply:'使用配方', update:'用当前选择更新', download:'JSON ↗', remove:'删除', undo:'撤销删除', deleted:'配方已删除。',
    meta:'{project} · {n} 个文件 · {budget} token 预算 · {format}', coverage:'可用路径 {matched}/{total} · 已变更 {changed} · 缺失 {missing}',
    paths:'已保存的文件路径', changedLabel:'保存后已变更', missingLabel:'缺失或被排除',
    saved:'配方已保存到本地。', updated:'配方已更新为当前文件选择。', imported:'配方已导入。载入对应项目后即可使用。',
    failed:'未能保存到本地，浏览器存储可能不可用或已满。你仍可把当前选择下载为 JSON。',
    unreadable:'未能读取已保存的配方，原存储已保留。可下载当前选择以保留配方。',
    invalid:'配方无效：{reason}', limit:'最多保存 {n} 个配方。请先删除一个，或下载 JSON。',
    nothing:'请至少选择一个文件后再保存配方。', noMatch:'当前项目没有匹配的路径，请先载入对应项目。原选择已保留。',
    active:'正在使用「{name}」· 文件 {n}/{total} · 已变更 {changed} · 缺失 {missing}。导出读取当前文件内容。',
    modified:'文件选择已变化，可用当前选择更新配方以保存新的文件列表。', over:'当前选择超出预算，请提高预算或调整文件后再导出。',
    different:'项目名称与「{project}」不同，路径按导入文件夹的相对路径匹配。', busy:'请等待导入或分析完成。',
    exportMissing:'此配方有 {n} 个路径缺失或被排除。此次仅导出当前可用且选中的文件，请在分享前检查配方。',
    exportChanged:'配方中有 {n} 个文件在保存后发生变化，此次导出读取它们的当前内容。',
    tooLarge:'配方文件不能超过 1 MiB。', downloaded:'配方 JSON 已下载。', inspect:'查看 {path}', close:'关闭配方',
  },
};

export function createRecipeUI({ getFiles, getSelection, getBudget, getFormat, getProjectName, getLocale, isBusy, applyRecipe, inspectFile, toast }) {
  let entries = [], storageFailed = false, active = null, deleted = null;
  const t = (key, values = {}) => {
    let text = messages[getLocale() === 'zh' ? 'zh' : 'en'][key];
    for (const [name,value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  };
  const number = value => value.toLocaleString(getLocale() === 'zh' ? 'zh-CN' : 'en-US');
  const projectLabel = () => Array.from(getProjectName().replace(/[\u0000-\u001f\u007f]/g,' ').trim()).slice(0,120).join('') || 'my-project';
  function read() {
    try {
      entries = readRecipeLibrary(window.localStorage); storageFailed = false;
      if (active) {
        const existing = entries.find(entry=>entry.id===active.id);
        active = existing ? {...existing,resolution:resolveRecipe(existing.recipe,getFiles())} : null;
      }
    }
    catch { entries = []; storageFailed = true; active = null; }
  }
  function write(next) {
    try { entries = writeRecipeLibrary(window.localStorage, next); return true; }
    catch { showError(t('failed')); return false; }
  }
  function showError(text) { $('recipe-error').textContent = text; $('recipe-error').hidden = false; }
  function download(recipe) {
    const url = URL.createObjectURL(new Blob([serializeRecipe(recipe)], {type:'application/json;charset=utf-8'}));
    const link = document.createElement('a'); link.href = url;
    link.download = `${recipe.name.replace(/[^\p{L}\p{N}._-]/gu,'-') || 'context'}.atlas-recipe.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast(t('downloaded'));
  }
  function current(name = $('recipe-name').value) {
    if (isBusy()) throw new Error(t('busy'));
    if (!getSelection().size) throw new Error(t('nothing'));
    return createRecipe(getFiles(), getSelection(), {name, projectName:projectLabel(), budget:getBudget(), format:getFormat()});
  }
  function open(save = false) {
    if (isBusy()) return toast(t('busy'));
    read(); $('recipe-error').hidden = true; deleted = null;
    $('recipe-name').value = active?.recipe.name || Array.from(`${projectLabel()} context`).slice(0,80).join('');
    render(true); $('recipe-dialog').showModal(); $('recipe-dialog').scrollTop = 0;
    if (save) $('recipe-name').focus();
  }
  function save() {
    if (isBusy()) return toast(t('busy'));
    if (storageFailed) return showError(t('unreadable'));
    // Refresh before mutations to preserve recipes saved in another tab.
    read(); if (storageFailed) return showError(t('unreadable'));
    if (entries.length >= MAX_RECIPES) return showError(t('limit',{n:MAX_RECIPES}));
    try {
      const recipe = current();
      if (!write([...entries,{id:crypto.randomUUID(),recipe}])) return;
      $('recipe-error').hidden = true; render(); toast(t('saved'));
    } catch (error) { showError(error.message); }
  }
  function use(entry) {
    if (isBusy()) return toast(t('busy'));
    const resolution = resolveRecipe(entry.recipe, getFiles());
    if (!resolution.selectedIds.length) return showError(t('noMatch'));
    active = { ...entry, resolution };
    applyRecipe(entry.recipe, resolution.selectedIds);
    $('recipe-dialog').close(); render();
    $('recipe-status').scrollIntoView({block:'nearest',behavior:'instant'});
  }
  function mutate(id, action) {
    if (isBusy()) return toast(t('busy'));
    read(); if (storageFailed) return showError(t('unreadable'));
    const entry = entries.find(item => item.id === id);
    if (!entry) return render();
    if (action === 'delete') {
      if (!write(entries.filter(item => item.id !== id))) return;
      deleted = entry; if (active?.id === id) active = null;
      render(); toast(t('deleted')); return;
    }
    try {
      const recipe = current(entry.recipe.name);
      if (!write(entries.map(item => item.id === id ? {id,recipe} : item))) return;
      if (active?.id === id) active = {id,recipe,resolution:resolveRecipe(recipe,getFiles())};
      $('recipe-error').hidden = true; render(); toast(t('updated'));
    } catch (error) { showError(error.message); }
  }
  async function importRecipe(event) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    try {
      if (file.size > MAX_RECIPE_BYTES) throw new Error(t('tooLarge'));
      const recipe = parseRecipe(new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer()));
      if (isBusy()) return showError(t('busy'));
      read(); if (storageFailed) return showError(t('unreadable'));
      if (entries.length >= MAX_RECIPES) return showError(t('limit',{n:MAX_RECIPES}));
      if (!write([...entries,{id:crypto.randomUUID(),recipe}])) return;
      $('recipe-error').hidden = true; render(); toast(t('imported'));
    } catch (error) { showError(t('invalid',{reason:error.message})); }
  }
  function button(label, handler, disabled = false) {
    const node = document.createElement('button'); node.type = 'button'; node.className = 'secondary-button';
    node.textContent = label; node.disabled = disabled; node.addEventListener('click',handler); return node;
  }
  function renderStatus() {
    $('recipe-status').hidden = !active;
    if (!active) return;
    const {recipe,resolution} = active, selection = getSelection();
    const notes = [t('active',{name:recipe.name,n:resolution.selectedIds.length,total:recipe.files.length,changed:resolution.changed.length,missing:resolution.missing.length})];
    if (selection.size !== resolution.selectedIds.length || resolution.selectedIds.some(id => !selection.has(id))) notes.push(t('modified'));
    if (projectLabel() !== recipe.projectName) notes.push(t('different',{project:recipe.projectName}));
    // Keep the user's current budget in view after they adjust it.
    if (calculateSelection(getFiles(),selection).tokens > getBudget()) notes.push(t('over'));
    $('recipe-status-text').textContent = notes.join(' ');
    $('recipe-status-details').hidden = !resolution.changed.length && !resolution.missing.length;
    $('recipe-status-details-label').textContent = t('paths');
    const paths = document.createDocumentFragment();
    for (const [key,list] of [['changedLabel',resolution.changed],['missingLabel',resolution.missing]]) for (const path of list) {
      const li = document.createElement('li'); li.textContent = `${t(key)}: ${path}`; paths.append(li);
    }
    $('recipe-status-paths').replaceChildren(paths);
  }
  function refresh() {
    const busy = isBusy(), hasFiles = getSelection().size > 0;
    $('recipe-open').disabled = busy; $('recipe-save-open').disabled = busy || !hasFiles;
    $('recipe-save').disabled = busy || !hasFiles || storageFailed;
    $('recipe-download-current').disabled = busy || !hasFiles;
    $('recipe-import').disabled = busy || storageFailed;
    $('recipe-current').textContent = t('current',{n:getSelection().size,tokens:number(calculateSelection(getFiles(),getSelection()).tokens),format:getFormat()==='xml'?'XML':'Markdown'});
    renderStatus();
  }
  function render(forceLibrary = false) {
    for (const [id,key] of Object.entries({'recipe-title':'title','recipe-pitch':'pitch','recipe-detail':'detail','recipe-save-open':'save','recipe-dialog-title':'heading','recipe-name-label':'name','recipe-save':'saveLocal','recipe-download-current':'downloadCurrent','recipe-privacy':'privacy','recipe-files-only':'filesOnly','recipe-library-label':'library','recipe-import':'import','recipe-undo':'undo'})) $(id).textContent = t(key);
    $('recipe-open').textContent = t('open',{n:entries.length});
    $('recipe-name').placeholder = t('placeholder'); $('recipe-close').setAttribute('aria-label',t('close'));
    if (storageFailed) showError(t('unreadable'));
    $('recipe-undo').hidden = !deleted;
    refresh();
    if (!forceLibrary && !$('recipe-dialog').open) return;
    const list = document.createDocumentFragment();
    for (const entry of entries) {
      const {recipe,id} = entry, resolution = resolveRecipe(recipe,getFiles());
      const card = document.createElement('article'); card.className = 'recipe-card';
      const heading = document.createElement('h3'); heading.textContent = recipe.name;
      const meta = document.createElement('p'); meta.className = 'recipe-meta';
      meta.textContent = t('meta',{project:recipe.projectName,n:recipe.files.length,budget:number(recipe.budget),format:recipe.format==='xml'?'XML':'Markdown'});
      const coverage = document.createElement('p'); coverage.className = `recipe-coverage${resolution.missing.length||resolution.changed.length?' recipe-drift':''}`;
      coverage.textContent = t('coverage',{matched:resolution.selectedIds.length,total:recipe.files.length,changed:resolution.changed.length,missing:resolution.missing.length});
      const actions = document.createElement('div'); actions.className = 'recipe-actions';
      actions.append(button(t('apply'),()=>use(entry),isBusy()||!resolution.selectedIds.length),button(t('update'),()=>mutate(id,'update'),isBusy()||!getSelection().size||storageFailed),button(t('download'),()=>download(recipe)),button(t('remove'),()=>mutate(id,'delete'),isBusy()||storageFailed));
      const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent=t('paths'); details.append(summary);
      // Thousands of saved paths stay out of the DOM until the user opens them.
      details.addEventListener('toggle',()=>{
        if (!details.open || details.dataset.loaded) return;
        const paths = document.createElement('ul');
        const missing = new Set(resolution.missing), changed = new Set(resolution.changed);
        for (const item of recipe.files) {
          const li = document.createElement('li');
          if (missing.has(item.path)) li.textContent = `${item.path} — ${t('missingLabel')}`;
          else { const inspect = document.createElement('button'); inspect.textContent=item.path; inspect.title=t('inspect',{path:item.path}); inspect.addEventListener('click',()=>{$('recipe-dialog').close();inspectFile(item.path);}); li.append(inspect); if(changed.has(item.path))li.append(document.createTextNode(` — ${t('changedLabel')}`)); }
          paths.append(li);
        }
        details.append(paths); details.dataset.loaded='true';
      });
      card.append(heading,meta,coverage,actions,details); list.append(card);
    }
    if (!entries.length) { const empty=document.createElement('p');empty.className='recipe-empty';empty.textContent=t('empty');list.append(empty); }
    $('recipe-list').replaceChildren(list); refresh();
  }
  $('recipe-open').addEventListener('click',()=>open()); $('recipe-save-open').addEventListener('click',()=>open(true));
  $('recipe-form').addEventListener('submit',event=>{event.preventDefault();save();});
  $('recipe-download-current').addEventListener('click',()=>{try{download(current());}catch(error){showError(error.message);}});
  $('recipe-import').addEventListener('click',()=>{if(!isBusy())$('recipe-file').click();}); $('recipe-file').addEventListener('change',importRecipe);
  $('recipe-undo').addEventListener('click',()=>{
    if (!deleted || isBusy()) return;
    read(); if (storageFailed) return showError(t('unreadable'));
    if (entries.length >= MAX_RECIPES) return showError(t('limit',{n:MAX_RECIPES}));
    if (entries.some(entry=>entry.id===deleted.id)) {deleted=null;render();return;}
    if (write([...entries,deleted])) {deleted=null;render();}
  });
  window.addEventListener('storage',()=>{read();render();});
  read();
  function exportNotes() {
    if (!active) return [];
    const {resolution} = active, notes = [];
    if (resolution.missing.length) notes.push(t('exportMissing',{n:resolution.missing.length}));
    if (resolution.changed.length) notes.push(t('exportChanged',{n:resolution.changed.length}));
    return notes;
  }
  return {render,refresh,exportNotes,resetProject:()=>{active=null;$('recipe-dialog').close();renderStatus();},manualChange:()=>{active=null;renderStatus();}};
}
