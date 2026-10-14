import { analyzeFile, isIgnored, normalizePath, estimateTokens, calculateSelection, suggestSelection, buildContext } from './core.js';
import { demoProject } from './demo.js';
import { layoutTreemap } from './treemap.js';
import { zh, en } from './i18n.js';
import { prepareImport, scopedIgnorePatterns, folderRelativePath } from './import-utils.js';

const $ = id => document.getElementById(id);
const defaults = new Map([...document.querySelectorAll('[data-i18n]')].map(el=>[el,el.innerHTML]));
const MAX_FILE = 1024 * 1024, MAX_TOTAL = 50 * MAX_FILE, MAX_FILES = 5000;
let locale = 'en', files = [], selected = new Set(), activeId = null, projectName = '', query = '', isDemo = true, importing = false, collecting = false, importRecord = null, format = 'markdown', toastTimer;
const colors = {
 TypeScript:{tile:'#4d6c83',text:'#e2edf4',dot:'#8ab1ca'},JavaScript:{tile:'#92865b',text:'#f7f0d5',dot:'#ddc584'},CSS:{tile:'#656289',text:'#efebfa',dot:'#a59ad2'},HTML:{tile:'#9a715a',text:'#f9eada',dot:'#dda57d'},Markdown:{tile:'#80976a',text:'#f0f5e5',dot:'#bed59e'},JSON:{tile:'#637969',text:'#e4f1e7',dot:'#93b69c'},Python:{tile:'#627e97',text:'#e5f3fc',dot:'#91b6d6'},Go:{tile:'#4b8584',text:'#dbf6f4',dot:'#88c6c2'},Rust:{tile:'#936853',text:'#ffecdf',dot:'#dba68b'},Text:{tile:'#606d76',text:'#ebf0f3',dot:'#92a0ac'}
};
function t(key, values={}) { let out = (locale==='zh'?zh[key]:en[key]) || key; for(const [k,v] of Object.entries(values)) out=out.replaceAll(`{${k}}`,String(v)); return out; }
function num(n) { return Math.round(n).toLocaleString(locale==='zh'?'zh-CN':'en-US'); }
function bytes(n) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(1)} KB` : `${(n/1048576).toFixed(1)} MB`; }
function compact(n) { return n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n); }
const languageNames = {typescript:'TypeScript',javascript:'JavaScript',css:'CSS',html:'HTML',markdown:'Markdown',json:'JSON',python:'Python',go:'Go',rust:'Rust'};
function languageName(file) { return languageNames[file.language] || 'Text'; }
function color(file) { return colors[languageName(file)]; }
function visibleFiles() { return files.filter(file=>file.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())); }
function budget() { return Math.max(500,Math.min(2000000, Number($('budget').value)||16000)); }
function toast(message) { $('toast').textContent=message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),3500); }
function applyLanguage() {
 document.documentElement.lang=locale==='zh'?'zh-CN':'en';
 for(const [el,html] of defaults) { if(locale==='zh' && zh[el.dataset.i18n]) el.innerHTML=zh[el.dataset.i18n]; else el.innerHTML=html; }
 $('language-button').textContent=locale==='en'?'中文':'EN'; $('language-button').setAttribute('aria-label',locale==='en'?'Switch to Chinese':'Switch to English');
 $('search').placeholder=t('search'); $('search').setAttribute('aria-label',t('search'));
 render();
}
function loadDemo(showToast=false) {
 if(importing || collecting) return toast(t('busy'));
 projectName=demoProject.name; files=demoProject.files.map(analyzeFile); selected=new Set(files.filter(f=>!f.path.startsWith('tests/')&&!f.path.startsWith('docs/')&&!f.path.endsWith('sync.ts')).map(f=>f.id));
 activeId='src/components/Editor.tsx';query='';$('search').value='';isDemo=true;render();if(showToast)toast(t('demoLoaded'));
}
function render() {
 $('project-name').textContent=projectName; $('map-project').textContent=projectName;
 $('demo-tag').hidden=!isDemo; $('project-file-count').textContent=t('filesCount',{n:num(files.length)});
 $('project-tokens').textContent=t('totalTokens',{n:num(files.reduce((n,f)=>n+f.tokens,0))});
 $('map-filter').textContent=query?t('filter'):(locale==='zh'?zh.allFiles:'all files');
 if(isDemo) $('import-status').textContent=locale==='zh'?zh.demoStatus:"You're exploring an editable sample project.";
 else if(importRecord) $('import-status').textContent=t('importDone',importRecord);
 renderTree();renderMap();renderInspector();renderStats();
}
function renderTree() {
 const fragment=document.createDocumentFragment(), visible=visibleFiles().sort((a,b)=>a.path.localeCompare(b.path)); let lastDir=null;
 $('visible-count').textContent=num(visible.length);
 for(const file of visible) {
  const dir=file.path.includes('/')?file.path.slice(0,file.path.lastIndexOf('/')):'';
  if(dir!==lastDir && dir){const row=document.createElement('div');row.className='directory-row';row.textContent=dir;row.title=dir;fragment.append(row);}lastDir=dir;
  const row=document.createElement('div');row.className=`file-row${activeId===file.id?' active':''}`;row.style.setProperty('--file-color',color(file).dot);
  const check=document.createElement('input');check.type='checkbox';check.className='file-check';check.checked=selected.has(file.id);check.setAttribute('aria-label',`${locale==='zh'?'选择':'Include'} ${file.path}`);check.addEventListener('change',()=>toggleFile(file.id,check.checked));
  const ext=document.createElement('span');ext.className='file-ext';ext.textContent=file.extension.slice(0,3)||'txt';
  const name=document.createElement('button');name.className='file-name';name.textContent=file.name;name.title=file.path;name.addEventListener('click',()=>setActive(file.id));
  const size=document.createElement('span');size.className='file-size';size.textContent=compact(file.tokens);size.title=`~${num(file.tokens)} tokens`;
  row.append(check,ext,name,size);if(file.risks.length){const risk=document.createElement('span');risk.className='risk-dot';risk.textContent='•';risk.title=t('risk',{n:file.risks.length});row.append(risk);}fragment.append(row);
 }
 if(!visible.length){const empty=document.createElement('div');empty.className='empty-state';empty.textContent=t('empty');fragment.append(empty);}
 $('file-tree').replaceChildren(fragment);
}
function renderMap() {
 const map=$('treemap'), visible=visibleFiles();const rect=map.getBoundingClientRect();
 const tiles=layoutTreemap(visible.map(file=>({id:file.id,weight:Math.max(1,file.tokens),file})),rect.width-2,rect.height-2), fragment=document.createDocumentFragment();
 for(const tile of tiles) {
  const file=tile.file,palette=color(file),el=document.createElement('button');
  el.className=`map-tile${selected.has(file.id)?'':' excluded'}${activeId===file.id?' active':''}${tile.width<100||tile.height<60?' tiny':''}${tile.width<42||tile.height<27?' micro':''}`;
  el.style.cssText=`left:${tile.x}px;top:${tile.y}px;width:${tile.width}px;height:${tile.height}px;--tile-bg:${palette.tile};--tile-text:${palette.text}`;
  el.title=`${file.path}\n~${num(file.tokens)} tokens${file.risks.length?`\n${t('risk',{n:file.risks.length})}`:''}`;el.setAttribute('aria-label',`Inspect ${file.path}, approximately ${file.tokens} tokens`);el.addEventListener('click',()=>setActive(file.id));
  const name=document.createElement('span');name.className='tile-name';name.textContent=file.name;
  const dir=document.createElement('span');dir.className='tile-dir';dir.textContent=file.path.includes('/')?file.path.slice(0,file.path.lastIndexOf('/')):'root';
  const count=document.createElement('span');count.className='tile-count';count.textContent=`~${compact(file.tokens)} tokens`;
  const toggle=document.createElement('span');toggle.className='tile-select';toggle.textContent=selected.has(file.id)?'✓':'+';toggle.setAttribute('aria-hidden','true');toggle.addEventListener('click',event=>{event.stopPropagation();toggleFile(file.id);});
  el.append(name,dir,count);if(tile.width>35&&tile.height>27)el.append(toggle);fragment.append(el);
 }
 if(!tiles.length){const empty=document.createElement('div');empty.className='empty-map';empty.textContent=t('empty');fragment.append(empty);}map.replaceChildren(fragment);
 const legend=document.createDocumentFragment();for(const language of [...new Set(visible.map(languageName))].slice(0,6)){const span=document.createElement('span'),dot=document.createElement('i');dot.style.background=colors[language].dot;span.append(dot,document.createTextNode(language));legend.append(span);}$('language-legend').replaceChildren(legend);
}
function renderInspector() {
 const file=files.find(f=>f.id===activeId);$('toggle-active').disabled=!file;
 if(!file){$('active-path').textContent=t('noInspect');$('active-meta').textContent='';$('code-content').textContent='';$('risk-notice').hidden=true;return;}
 $('active-path').textContent=file.path;$('active-meta').textContent=`~${num(file.tokens)} tokens · ${bytes(file.bytes)}`;
 const included=selected.has(file.id);$('toggle-active').textContent=t(included?'remove':'include');$('toggle-active').classList.toggle('is-included',included);
 $('risk-notice').hidden=!file.risks.length;$('risk-notice').textContent=t('risk',{n:file.risks.length});
 const fragment=document.createDocumentFragment();file.content.split('\n').slice(0,200).forEach((line,i)=>{const el=document.createElement('span');el.className='code-line';const number=document.createElement('span');number.className='line-number';number.textContent=i+1;el.append(number,document.createTextNode(line||' '));fragment.append(el);});
 if(file.content.split('\n').length>200){const el=document.createElement('span');el.textContent='… (first 200 lines; full content included in export)';fragment.append(el);}
 $('code-content').replaceChildren(fragment);
}
function renderStats() {
 const stats=calculateSelection(files,selected),limit=budget(),percent=Math.round(stats.tokens/limit*100),over=stats.tokens>limit;
 $('selected-tokens').textContent=num(stats.tokens);$('budget-fill').style.width=`${Math.min(100,percent)}%`;$('budget-fill').parentElement.classList.toggle('over',over);
 $('budget-percent').textContent=t('used',{n:percent});$('remaining').textContent=t(over?'over':'remaining',{n:num(Math.abs(limit-stats.tokens))});
 $('selected-count').textContent=num(stats.count);$('selected-bytes').textContent=bytes(stats.bytes);$('selected-risks').textContent=stats.risks?`${stats.risks} ↗`:'0';$('selected-risks').classList.toggle('has-risks',stats.risks>0);
 $('export-button').disabled=stats.count===0;for(const el of document.querySelectorAll('[data-budget]'))el.classList.toggle('active',Number(el.dataset.budget)===limit);
}
function setActive(id) {activeId=id;renderTree();renderMap();renderInspector();}
function toggleFile(id,checked=!selected.has(id)) {if(checked)selected.add(id);else selected.delete(id);renderTree();renderMap();renderInspector();renderStats();}
function refreshExport() {
 const redact=$('redact-checkbox').checked, output=buildContext(files,selected,{format,redact,projectName});$('export-preview').value=output;
 const stats=calculateSelection(files,selected);$('export-summary').textContent=t('summary',{n:stats.count,t:num(estimateTokens(output)),b:bytes(new TextEncoder().encode(output).length),r:t(redact?'redacted':'unredacted')});
 const warnings=[];if(!redact&&stats.risks)warnings.push(t('redactionOff'));if(estimateTokens(output)>budget())warnings.push(t('budgetWarning'));
 $('export-warning').hidden=!warnings.length;$('export-warning').textContent=warnings.join(' ');
 for(const el of document.querySelectorAll('[data-format]'))el.classList.toggle('active',el.dataset.format===format);
}
function showExport() {if(!selected.size)return toast(t('nothing'));refreshExport();$('export-dialog').showModal();}
async function copyContext() {const output=$('export-preview').value;try {await navigator.clipboard.writeText(output);toast(t('copied'));}catch{$('export-preview').focus();$('export-preview').select();toast(locale==='zh'?'请按 Ctrl/Cmd+C 复制选中的上下文。':'Press Ctrl/Cmd+C to copy the selected context.');}}
function downloadContext() {const blob=new Blob([$('export-preview').value],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`${projectName.replace(/[^\p{L}\p{N}._-]/gu,'-')}-context.${format==='xml'?'xml':'md'}`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast(t('downloaded'));}

async function importFiles(source, name) {
 if(importing||collecting)return toast(t('busy'));importing=true;$('import-button').disabled=true;$('import-button').querySelector('span').textContent=t('importing');$('import-status').textContent=t('importing');
 try {
  const prepared=prepareImport(source,MAX_FILES),list=prepared.entries;let skipped=prepared.skipped,total=0;const next=[],ignoreRules=[];
  // Respect nested ignore files by resolving patterns relative to their directory.
  for(const entry of prepared.ignoreFiles.sort((a,b)=>a.path.split('/').length-b.path.split('/').length)) {
   try {if(entry.file.size>MAX_FILE)continue;ignoreRules.push(...scopedIgnorePatterns(entry.path,await entry.file.text()));}catch{skipped++;}
  }
  for(let i=0;i<list.length;i++) {
   const entry=list[i];try {
    const path=normalizePath(entry.path);if(isIgnored(path,ignoreRules)||entry.file.size>MAX_FILE||total+entry.file.size>MAX_TOTAL){skipped++;continue;}
    const buffer=await entry.file.arrayBuffer(),data=new Uint8Array(buffer);if(data.includes(0)){skipped++;continue;}
    let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{skipped++;continue;}
    total+=data.byteLength;next.push(analyzeFile({path,content}));
   }catch{skipped++;}
   if(i%30===0){$('import-status').textContent=`${t('importing')} ${i+1}/${list.length}`;await new Promise(resolve=>setTimeout(resolve,0));}
  }
  if(!next.length){toast(t('importEmpty'));render();return;}
  const unique=[...new Map(next.map(f=>[f.id,f])).values()];projectName=name||'my-project';files=unique;selected=new Set(suggestSelection(files,budget()));activeId=files.find(f=>selected.has(f.id))?.id||files[0].id;query='';$('search').value='';isDemo=false;importRecord={n:num(files.length),s:num(skipped)};render();
  $('import-status').textContent=t('importDone',{n:num(files.length),s:num(skipped)});toast(t('importDone',{n:num(files.length),s:num(skipped)}));
 }catch{toast(t('importFail'));render();}
 finally{importing=false;$('import-button').disabled=false;$('import-button').querySelector('span').textContent=locale==='zh'?zh.open:'Open folder';$('folder-input').value='';}
}
async function collectEntries(entries) {
 const result=[];let seen=0;
 async function walk(entry,prefix='') {
  const path=prefix+entry.name;
  if(entry.isFile&&isIgnored(path))return;
  if(entry.isDirectory&&isIgnored(path+'/placeholder.txt'))return;
  if(++seen>MAX_FILES*3||result.length>=MAX_FILES) return;
  if(entry.isFile) {try{const file=await new Promise((resolve,reject)=>entry.file(resolve,reject));result.push({path,file});}catch{}}
  else if(entry.isDirectory) {if(isIgnored(path+'/placeholder.txt'))return;const reader=entry.createReader();let batch;do{batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));for(const child of batch){if(result.length>=MAX_FILES)return;await walk(child,path+'/');}}while(batch.length);}
 }
 const oneRoot=entries.length===1&&entries[0].isDirectory;for(const entry of entries){if(oneRoot){const reader=entry.createReader();let batch;do{batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));for(const child of batch)await walk(child);}while(batch.length&&result.length<MAX_FILES);}else await walk(entry);}
 return {result,name:oneRoot?entries[0].name:'dropped-files'};
}
$('import-button').addEventListener('click',()=>{if(!importing&&!collecting)$('folder-input').click();});
$('folder-input').addEventListener('change',event=>{const picked=[...event.target.files];if(!picked.length)return;const first=picked[0].webkitRelativePath,name=first.includes('/')?first.split('/')[0]:'my-project';importFiles(picked.map(file=>({file,path:folderRelativePath(file)})),name);});
let dragDepth=0;
document.addEventListener('dragover',event=>{if([...event.dataTransfer.types].includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
document.addEventListener('dragenter',event=>{if([...event.dataTransfer.types].includes('Files')){dragDepth++;$('drop-zone').classList.add('dragging');}});
document.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('drop-zone').classList.remove('dragging');}});
document.addEventListener('drop',async event=>{
 event.preventDefault();dragDepth=0;$('drop-zone').classList.remove('dragging');if(importing||collecting)return toast(t('busy'));
 const items=[...event.dataTransfer.items];const entries=items.map(item=>item.webkitGetAsEntry?.()).filter(Boolean);
 try{if(entries.length){collecting=true;$('import-button').disabled=true;$('import-status').textContent=t('importing');const {result,name}=await collectEntries(entries);collecting=false;if(result.length>=MAX_FILES)toast(t('tooMany'));await importFiles(result,name);}else{await importFiles([...event.dataTransfer.files].map(file=>({path:file.name,file})),'dropped-files');}}catch{toast(t('importFail'));}finally{collecting=false;$('import-button').disabled=false;}
});
$('demo-button').addEventListener('click',()=>loadDemo(true));$('language-button').addEventListener('click',()=>{locale=locale==='en'?'zh':'en';applyLanguage();});
$('search').addEventListener('input',event=>{query=event.target.value;renderTree();renderMap();$('map-filter').textContent=query?t('filter'):(locale==='zh'?zh.allFiles:'all files');});
$('select-all').addEventListener('click',()=>{for(const file of visibleFiles())selected.add(file.id);render();});$('clear-selection').addEventListener('click',()=>{for(const file of visibleFiles())selected.delete(file.id);render();});
$('toggle-active').addEventListener('click',()=>{if(activeId)toggleFile(activeId);});$('budget').addEventListener('input',renderStats);$('budget').addEventListener('change',()=>{$('budget').value=budget();renderStats();});
for(const el of document.querySelectorAll('[data-budget]'))el.addEventListener('click',()=>{$('budget').value=el.dataset.budget;renderStats();});
$('fit-button').addEventListener('click',()=>{selected=new Set(suggestSelection(files,budget()));render();toast(selected.size?t('fitDone',{n:selected.size}):t('noBudget'));});
$('export-button').addEventListener('click',showExport);$('redact-checkbox').addEventListener('change',refreshExport);
for(const el of document.querySelectorAll('[data-format]'))el.addEventListener('click',()=>{format=el.dataset.format;refreshExport();});
$('copy-button').addEventListener('click',copyContext);$('download-button').addEventListener('click',downloadContext);$('help-button').addEventListener('click',()=>$('help-dialog').showModal());
for(const el of document.querySelectorAll('.close-dialog'))el.addEventListener('click',()=>el.closest('dialog').close());
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{const rect=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom))dialog.close();});
let resizeFrame;new ResizeObserver(()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(renderMap);}).observe($('treemap'));
loadDemo();
