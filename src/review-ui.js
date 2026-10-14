import { calculateReviewSelection } from './review.js';
import { redactDiff } from './review-diff.js';
import { demoReviewDiff } from './review-demo.js';
const $=id=>document.getElementById(id);
const messages={
 en:{
  focusTab:'◎ Focus a file',reviewTab:'⇄ Review a change · NEW',pitch:'Your diff. The context to review it.',
  detail:'Bring a Git diff. Gather changed files, dependencies and tests into one review pack.',
  demo:'Try review demo ↗',open:'＋ Import Git diff',edit:'↗ Replace Git diff',result:'READY FOR A CODE REVIEW',
  heading:'{n} changed files. One review pack.',headingOne:'1 changed file. One review pack.',summary:'Source files: {n} · diff + review brief · ~{tokens} tokens',
  undo:'↶ Restore previous selection',callers:'Include importing modules',tests:'Include related tests',rebuild:'Rebuild pack ↗',
  changes:'THE CHANGES',related:'SURROUNDING CONTEXT',patch:'Preview filtered diff · suspected secrets redacted',
  support:'The pack contains the filtered diff, review instructions and selected source files. Files are your imported snapshot; patches are never applied. Import tracing supports local JS/TS on a best-effort basis.',
  title:'Bring the change you want reviewed.',help:'Import the project folder at the diff’s new version, then paste a Git unified diff or load a .diff / .patch file. Generate one from your repository:',
  label:'Git unified diff',upload:'Load patch file',limit:'Up to 1 MiB / 500 changed files. Processed locally. Ignored paths are filtered.',build:'Build review pack →',busy:'Building review pack…',
  changed:'Budget or options changed. Rebuild to apply them.',custom:'Selection customized. Rebuilding restores the suggested context.',
  over:'This review pack exceeds the current budget. Increase the budget or review a smaller change; automatic selection keeps changed files.',
  omitted:'Related files omitted by budget: {n}. Review them before exporting.',
  missing:'Changed files not imported: {n}. Their diff is included, but their full source is unavailable.',
  mismatch:'Snapshot mismatches: {n}. Import the diff’s new version before relying on this pack.',
  skipped:'Patch sections excluded by file filters or unsupported formats: {n}.',
  unresolved:'Import references or analysis limits to review: {n}.',
  ignored:'Ignored path',blocked:'Blocked path',binary:'Binary change',symlink:'Symbolic link',
  'not-found':'Import target not found','outside-root':'Outside the imported project','unsupported-specifier':'Unsupported import path','unconfigured-alias':'Alias not configured','analysis-limit':'Analysis limit reached',
  diagnostics:'Review notices · {n}',modified:'Modified',added:'Added',deleted:'Deleted',renamed:'Renamed',
  included:'Included',excluded:'Not selected',diffOnly:'Diff only',notFound:'Full source unavailable',mismatchRow:'Snapshot mismatch',
  dependency:'Dependency of {path}',caller:'Imports {path}',test:'Related test for {path}',changedReason:'Changed in this diff',
  noRelated:'No additional context found.',empty:'Paste a Git unified diff first.',
  failure:'Could not build this pack. Use a complete Git unified diff; combined merge diffs and malformed or truncated patches are unsupported. Previous selection preserved.',
  tooLarge:'The patch exceeds the 1 MiB limit. Export a smaller change.',fileError:'Could not read this patch as UTF-8 text. Choose a .diff or .patch file up to 1 MiB.',
  filtered:'No reviewable changes remain. Check the patch and ignored paths.',done:'Review pack ready',restored:'Previous selection restored',
 },
 zh:{
  focusTab:'◎ 聚焦一个文件',reviewTab:'⇄ 审查一次变更 · 新功能',pitch:'带上改动，也带上审查所需的上下文。',
  detail:'导入 Git diff，汇集改动文件、依赖和测试，生成一份审查包。',
  demo:'体验审查演示 ↗',open:'＋ 导入 Git diff',edit:'↗ 更换 Git diff',result:'准备代码审查',
  heading:'{n} 个改动文件，一份审查包。',headingOne:'1 个改动文件，一份审查包。',summary:'{n} 个源文件 + diff + 审查说明 · 约 {tokens} tokens',
  undo:'↶ 恢复之前的选择',callers:'包含引用方',tests:'包含相关测试',rebuild:'重新构建审查包 ↗',
  changes:'本次改动',related:'相关上下文',patch:'预览过滤后的 diff · 疑似密钥已脱敏',
  support:'审查包包含过滤后的 diff、审查说明和选中的源文件。源文件来自导入时的版本，不会应用补丁。本地 JS/TS 引用分析提供尽力支持。',
  title:'导入这次需要审查的改动。',help:'先导入与 diff 新版本一致的项目文件夹，再粘贴 Git unified diff 或读取 .diff / .patch 文件。可在仓库中运行：',
  label:'Git unified diff',upload:'读取补丁文件',limit:'最多 1 MiB / 500 个改动文件。在本地处理，并过滤忽略路径。',build:'生成审查包 →',busy:'正在生成审查包…',
  changed:'预算或选项已变化，点击重新构建后应用。',custom:'已手动调整文件选择，重新构建会恢复建议的上下文。',
  over:'当前审查包已超出预算。请提高预算或缩小审查范围；自动选择会保留改动文件。',
  omitted:'有 {n} 个相关文件因预算不足未选中，请在导出前检查。',
  missing:'有 {n} 个改动文件未导入。审查包包含其 diff，但缺少完整源码。',
  mismatch:'有 {n} 个文件与 diff 的新版本不一致。请先导入对应版本，再使用审查包。',
  skipped:'有 {n} 个补丁区段因文件过滤或不支持的格式被排除。',
  unresolved:'有 {n} 处引用或分析限制需要检查。',
  ignored:'已忽略的路径',blocked:'已阻止的路径',binary:'二进制改动',symlink:'符号链接',
  'not-found':'未找到引用目标','outside-root':'超出导入项目范围','unsupported-specifier':'不支持的引用路径','unconfigured-alias':'未配置此别名','analysis-limit':'已达到分析上限',
  diagnostics:'审查提示 · {n}',modified:'修改',added:'新增',deleted:'删除',renamed:'重命名',
  included:'已包含',excluded:'未选择',diffOnly:'仅 diff',notFound:'缺少完整源码',mismatchRow:'版本不一致',
  dependency:'{path} 的依赖',caller:'引用了 {path}',test:'与 {path} 相关的测试',changedReason:'本次 diff 中有改动',
  noRelated:'未找到其他相关上下文。',empty:'请先粘贴 Git unified diff。',
  failure:'未能生成审查包。请提供完整的 Git unified diff；暂不支持合并提交的 combined diff、格式错误或被截断的补丁。已保留之前的选择。',
  tooLarge:'补丁超过 1 MiB，请导出范围更小的改动。',fileError:'无法将补丁读取为 UTF-8 文本，请选择不超过 1 MiB 的 .diff 或 .patch 文件。',
  filtered:'没有可审查的改动，请检查补丁及忽略路径。',done:'审查包已准备好',restored:'已恢复之前的选择',
 }
};
export function createReviewUI({getFiles,getSelection,getActiveId,getBudget,getLocale,getRules,isImporting,applySelection,inspectFile,loadDemo,toast,onBusyChange,onStart}) {
 let worker=null,loaded=false,pending=null,timer,requestId=0,revision=0,busy=false,result=null,lastDiff='',customized=false,ignoreClose=false,uploadSeq=0,loadingPatch=false;
 const t=(key,values={})=>{let out=messages[getLocale()==='zh'?'zh':'en'][key]||key;for(const[k,v]of Object.entries(values))out=out.replaceAll(`{${k}}`,String(v));return out;};
 const num=n=>Math.round(n).toLocaleString(getLocale()==='zh'?'zh-CN':'en-US');
 const options=()=>({includeCallers:$('review-callers').checked,includeTests:$('review-tests').checked});
 function stopWorker(){clearTimeout(timer);worker?.terminate();worker=null;loaded=false;pending?.reject(new Error('stopped'));pending=null;}
 function cancel(){revision++;uploadSeq++;loadingPatch=false;busy=false;stopWorker();refreshControls();onBusyChange();}
 function request(diff,budget,settings){
  if(!worker){worker=new Worker(new URL('./review-worker.js',import.meta.url),{type:'module'});worker.onerror=()=>stopWorker();worker.onmessage=({data})=>{
   if(data.requestId!==pending?.requestId)return;clearTimeout(timer);const current=pending;pending=null;
   if(data.error){stopWorker();const error=new Error('Analysis failed');error.code=data.code;current.reject(error);}else current.resolve(data.plan);
  };}
  return new Promise((resolve,reject)=>{pending={requestId:++requestId,resolve,reject};timer=setTimeout(stopWorker,30000);try{worker.postMessage({requestId,diff,budget,options:settings,...(!loaded?{files:getFiles(),rules:getRules()}:{})});loaded=true;}catch{stopWorker();}});
 }
 async function run(diff=lastDiff){
  if(busy||loadingPatch||isImporting())return;
  if(!diff.trim()){showError('empty');return;}
  if(new TextEncoder().encode(diff).length>1048576){showError('tooLarge');return;}
  onStart();const currentRevision=revision,oldResult=result,previous=result?.previous||{ids:[...getSelection()],activeId:getActiveId()};
  const requestedBudget=getBudget(),settings=options();busy=true;refreshControls();onBusyChange();$('review-input-error').hidden=true;
  try{
   const plan=await request(diff,requestedBudget,settings);if(currentRevision!==revision)return;
   lastDiff=diff;customized=false;result={plan,previous,requestedBudget,settings};
   if($('review-dialog').open){ignoreClose=true;$('review-dialog').close();}applySelection(plan.selectedIds,plan.selectedIds[0]||getActiveId());
   $('review-heading').focus({preventScroll:true});$('review-panel').scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});toast(t('done'));
  }catch(error){if(currentRevision===revision){result=oldResult;showError(/large|limit|size/i.test(error.code||'')?'tooLarge':/empty|eligible|filtered/i.test(error.code||'')?'filtered':'failure');}}
  finally{if(currentRevision===revision){busy=false;refreshStatus();onBusyChange();}}
 }
 function showError(key){$('review-input-error').textContent=t(key);$('review-input-error').hidden=false;if(!$('review-dialog').open)toast(t(key));}
 function refreshControls(){
  for(const id of ['review-open','review-demo','review-rebuild','review-undo','review-upload','review-input'])$(id).disabled=busy||loadingPatch||isImporting();
  $('review-build').disabled=busy||loadingPatch||isImporting();$('review-build').textContent=t(busy?'busy':'build');$('review-open').textContent=t(result?'edit':'open');
 }
 function refreshStatus(){
  refreshControls();if(!result)return;
  const {plan,requestedBudget,settings}=result,notes=[],stats=calculateReviewSelection(getFiles(),getSelection(),plan);
  if(requestedBudget!==getBudget()||settings.includeCallers!==options().includeCallers||settings.includeTests!==options().includeTests)notes.push(t('changed'));
  if(customized)notes.push(t('custom'));
  if(stats.tokens>getBudget())notes.push(t('over'));else if(plan.omittedCount&&!customized)notes.push(t('omitted',{n:plan.omittedCount}));
  for(const[key,list]of [['missing',plan.missing],['mismatch',plan.mismatched],['skipped',plan.skipped],['unresolved',plan.unresolved]])if(list?.length)notes.push(t(key,{n:list.length}));
  $('review-status').hidden=!notes.length;$('review-status').textContent=notes.join(' ');
  $('review-summary').textContent=t('summary',{n:stats.count,tokens:num(stats.tokens)});
 }
 function render(){
  for(const[id,key]of Object.entries({'workflow-focus':'focusTab','workflow-review':'reviewTab','review-pitch':'pitch','review-detail':'detail','review-demo':'demo','review-result-label':'result','review-undo':'undo','review-callers-label':'callers','review-tests-label':'tests','review-rebuild':'rebuild','review-changes-label':'changes','review-related-label':'related','review-patch-label':'patch','review-support':'support','review-dialog-title':'title','review-input-help':'help','review-input-label':'label','review-upload':'upload','review-input-limit':'limit'}))$(id).textContent=t(key);
  refreshControls();$('review-panel').hidden=!result;if(!result)return;
  const {plan}=result,selected=getSelection(),byPath=new Map(getFiles().map(file=>[file.path,file]));
  $('review-heading').textContent=t(plan.changes.length===1?'headingOne':'heading',{n:plan.changes.length});
  const rows=document.createDocumentFragment();
  for(const change of plan.changes){
   const file=byPath.get(change.path),row=document.createElement(file?'button':'div');row.className='review-change';
   if(file){row.addEventListener('click',()=>inspectFile(file.id));row.title=change.path;}
   const path=document.createElement('strong');path.textContent=change.path;
   const metadata=document.createElement('span');metadata.className='review-change-meta';
   const status=document.createElement('span');status.textContent=t(change.status);status.className=`review-kind review-${change.status}`;
   const count=document.createElement('span');count.textContent=`+${change.additions} / −${change.deletions}`;count.className='review-line-count';metadata.append(status,count);
   const label=document.createElement('span');label.className='review-change-state';label.textContent=plan.mismatched.includes(change.path)?t('mismatchRow'):file?t(selected.has(file.id)?'included':'excluded'):t('diffOnly');
   row.append(path,metadata,label);if(change.status==='renamed'){const old=document.createElement('small');old.textContent=`← ${change.oldPath}`;row.append(old);}rows.append(row);
  }$('review-changes').replaceChildren(rows);
  const related=document.createDocumentFragment(),filesById=new Map(getFiles().map(file=>[file.id,file]));
  for(const item of plan.candidates.filter(candidate=>candidate.kind!=='changed')){
   const file=filesById.get(item.id);if(!file)continue;
   const row=document.createElement('button');row.className=`focus-file review-related-file${selected.has(item.id)?'':' focus-omitted'}`;row.addEventListener('click',()=>inspectFile(item.id));
   const name=document.createElement('strong');name.textContent=file.path;const reason=document.createElement('span');reason.className='focus-file-reason';reason.textContent=t(item.kind,{path:item.via||''});
   const badge=document.createElement('span');badge.className='focus-file-badge';badge.textContent=t(selected.has(item.id)?'included':'excluded');row.append(name,reason,badge);related.append(row);
  }
  if(!related.childNodes.length){const empty=document.createElement('p');empty.className='focus-empty';empty.textContent=t('noRelated');related.append(empty);}$('review-related').replaceChildren(related);
  const diagnostics=[];for(const path of plan.missing)diagnostics.push(`${path} — ${t('notFound')}`);for(const path of plan.mismatched)diagnostics.push(`${path} — ${t('mismatchRow')}`);
  for(const item of plan.skipped)diagnostics.push(`${item.path} — ${t(item.reason)}`);for(const item of plan.unresolved)diagnostics.push(`${item.id}${item.specifier?' → '+item.specifier:''} — ${t(item.reason)}`);
  $('review-diagnostics').hidden=!diagnostics.length;$('review-diagnostics-label').textContent=t('diagnostics',{n:diagnostics.length});
  const list=document.createDocumentFragment();for(const note of diagnostics){const li=document.createElement('li');li.textContent=note;list.append(li);}$('review-diagnostics-list').replaceChildren(list);
  $('review-patch-preview').textContent=redactDiff(plan.changes.map(change=>change.patch).join('\n'));
  refreshStatus();
 }
 function manualChange(){if(busy||loadingPatch)cancel();if(result){customized=true;render();}}
 function clear({forgetInput=false}={}){cancel();result=null;customized=false;$('review-panel').hidden=true;if(forgetInput){lastDiff='';$('review-input').value='';$('review-file').value='';$('review-callers').checked=true;$('review-tests').checked=true;$('review-dialog').close();}onBusyChange();}
 function open(){if(busy||loadingPatch||isImporting())return;onStart();$('review-input').value=lastDiff;$('review-input-error').hidden=true;$('review-dialog').showModal();$('review-input').focus();}
 function demo(){if(busy||loadingPatch||isImporting())return;loadDemo();onStart();run(demoReviewDiff());}
 $('review-open').addEventListener('click',open);$('review-demo').addEventListener('click',demo);$('review-build').addEventListener('click',()=>run($('review-input').value));$('review-rebuild').addEventListener('click',()=>run());
 for(const id of ['review-callers','review-tests'])$(id).addEventListener('change',refreshStatus);
 $('review-close').addEventListener('click',()=>{if(busy||loadingPatch)cancel();$('review-dialog').close();});$('review-dialog').addEventListener('cancel',()=>{if(busy||loadingPatch)cancel();});
 $('review-dialog').addEventListener('close',()=>{if(ignoreClose){ignoreClose=false;return;}if(busy||loadingPatch)cancel();});
 $('review-upload').addEventListener('click',()=>$('review-file').click());
 $('review-file').addEventListener('change',async event=>{
  const file=event.target.files[0],currentRevision=revision,sequence=++uploadSeq;if(!file)return;loadingPatch=true;refreshControls();onBusyChange();
  try{if(file.size>1048576){showError('tooLarge');return;}const content=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());if(currentRevision!==revision||sequence!==uploadSeq)return;$('review-input').value=content;$('review-input-error').hidden=true;}
  catch{if(currentRevision===revision&&sequence===uploadSeq)showError('fileError');}finally{if(sequence===uploadSeq){loadingPatch=false;$('review-file').value='';refreshControls();onBusyChange();}}
 });
 $('review-undo').addEventListener('click',()=>{if(!result||busy)return;const {previous}=result;clear();applySelection(previous.ids,previous.activeId);toast(t('restored'));});
 return {render,refreshStatus,manualChange,clear,resetProject:()=>clear({forgetInput:true}),run,demo,isBusy:()=>busy||loadingPatch,getPlan:()=>result?.plan||null};
}
