const $ = id => document.getElementById(id);
const messages = {
  en: {
    pitch:'Start with one file. Bring its context.',
    detail:'Follow local imports, find references and tests, then fit your budget.',
    demo:'Try Focus demo ↗', action:'◎ Focus on this file', inspect:'◎ Focus', busy:'Tracing local imports…',
    result:'YOUR FOCUSED CONTEXT', undo:'↶ Restore previous selection',
    callers:'Include files that import it', tests:'Include related tests', rebuild:'Rebuild focus ↗',
    root:'START HERE', dependency:'DEPENDS ON', caller:'IMPORTED BY', test:'RELATED TESTS',
    rootReason:'The file you are changing', dependencyReason:'Imported by {path}',
    callerReason:'Imports {path}', testImport:'Imports {path}', testFilename:'Filename match for {path}',
    skipped:'Over budget', included:'Included', empty:'No files found',
    summary:'{n} of {total} files · ~{tokens} tokens · {saving}% less than the full project',
    changed:'Budget or options changed. Rebuild to apply them to this selection.',
    omitted:'Related files omitted by budget: {n}. Review them before exporting.',
    over:'The focal file alone exceeds this budget. It is kept selected; increase the budget or choose another file.',
    unresolved:'{n} import analysis notices',
    'not-found':'Target file not found', 'outside-root':'Outside the imported project',
    'unsupported-specifier':'Unsupported import path', 'unconfigured-alias':'Alias is not configured in the root config',
    'analysis-limit':'Analysis limit reached; results may be incomplete',
    unsupported:'Imports inside this file type are not analyzed. Incoming JS/TS references may still be included.',
    support:'Best-effort local JS/TS import tracing, including aliases directly declared in the root tsconfig/jsconfig. Related tests may use filename matching. Computed imports, external packages and framework loaders are not traced; review the result.',
    fail:'Focus analysis could not finish. Your previous selection is preserved.',
    done:'Focused on {n} related files', reset:'Previous selection restored',
  },
  zh: {
    pitch:'从一个文件出发，带上相关上下文。',
    detail:'追踪本地依赖、引用它的文件和相关测试，再按预算挑选。',
    demo:'体验聚焦演示 ↗', action:'◎ 围绕此文件构建', inspect:'◎ 聚焦', busy:'正在分析本地引用…',
    result:'聚焦上下文', undo:'↶ 恢复之前的选择',
    callers:'包含引用它的文件', tests:'包含相关测试', rebuild:'重新构建 ↗',
    root:'正在修改', dependency:'依赖文件', caller:'被这些文件引用', test:'相关测试',
    rootReason:'你正在修改的文件', dependencyReason:'被 {path} 引用',
    callerReason:'引用了 {path}', testImport:'引用了 {path}', testFilename:'与 {path} 文件名匹配',
    skipped:'预算不足', included:'已包含', empty:'未找到相关文件',
    summary:'{total} 个文件中选取 {n} 个 · 约 {tokens} tokens · 比完整项目减少 {saving}%',
    changed:'预算或选项已变化，点击“重新构建”后应用到当前选择。',
    omitted:'有 {n} 个相关文件因预算不足未选中，请在导出前检查。',
    over:'焦点文件本身已超出预算，当前仍保留它。请提高预算或选择其他文件。',
    unresolved:'有 {n} 条引用分析提示',
    'not-found':'未找到目标文件', 'outside-root':'超出已导入项目范围',
    'unsupported-specifier':'不支持的引用路径', 'unconfigured-alias':'根配置文件未声明此别名',
    'analysis-limit':'已达到分析上限，结果可能不完整',
    unsupported:'暂不分析此类文件内部的引用，但仍会查找引用它的 JS/TS 文件。',
    support:'尽可能在本地追踪 JS/TS 引用及根目录 tsconfig/jsconfig 直接声明的别名。相关测试可能按文件名匹配。计算生成的引用、外部包及框架加载规则不在追踪范围内，请检查选择结果。',
    fail:'未能完成聚焦分析，已保留之前的选择。',
    done:'已聚焦 {n} 个相关文件', reset:'已恢复之前的选择',
  },
};

export function createFocusUI({getFiles,getSelection,getActiveId,getBudget,getLocale,isImporting,applySelection,inspectFile,loadDemo,toast,onBusyChange=()=>{},onStart=()=>{}}) {
  let worker=null, workerLoaded=false, pending=null, timeout;
  let revision=0, requestId=0, busy=false, result=null;
  const t = (key,values={}) => {
    let value=messages[getLocale()==='zh'?'zh':'en'][key];
    for (const [name,replacement] of Object.entries(values)) value=value.replaceAll(`{${name}}`,String(replacement));
    return value;
  };
  const options = () => ({includeCallers:$('focus-callers').checked,includeTests:$('focus-tests').checked});
  const number = n => Math.round(n).toLocaleString(getLocale()==='zh'?'zh-CN':'en-US');

  function stopWorker() {
    clearTimeout(timeout);
    worker?.terminate();worker=null;workerLoaded=false;
    pending?.reject(new Error('Analysis stopped'));pending=null;
  }
  function requestPlan(rootId,budget,settings) {
    if (!worker) {
      worker=new Worker(new URL('./focus-worker.js',import.meta.url),{type:'module'});
      worker.onmessage=({data})=>{
        if(data.requestId!==pending?.requestId)return;
        clearTimeout(timeout);
        const current=pending;pending=null;
        if(data.error){stopWorker();current.reject(new Error('Analysis failed'));}else current.resolve(data);
      };
      worker.onerror=()=>stopWorker();
    }
    return new Promise((resolve,reject)=>{
      pending={requestId:++requestId,resolve,reject};
      timeout=setTimeout(stopWorker,30000);
      try {
        worker.postMessage({requestId,rootId,budget,options:settings,...(!workerLoaded?{files:getFiles()}:{})});
        workerLoaded=true;
      }catch{stopWorker();}
    });
  }
  async function run(rootId=getActiveId()) {
    if(busy||isImporting()||!rootId)return;
    onStart();
    const currentRevision=revision, oldResult=result;
    const previous=oldResult?.previous||{ids:[...getSelection()],activeId:getActiveId()};
    const requestedBudget=getBudget(),settings=options();
    busy=true;refreshTrigger();onBusyChange();
    try {
      const data=await requestPlan(rootId,requestedBudget,settings);
      if(currentRevision!==revision)return;
      result={...data,rootId,requestedBudget,settings,previous};
      applySelection(data.plan.selectedIds,rootId);
      $('focus-root').focus({preventScroll:true});
      $('focus-panel').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
      toast(t('done',{n:data.plan.selectedIds.length}));
    }catch{
      if(currentRevision===revision){result=oldResult;toast(t('fail'));}
    }finally{
      if(currentRevision===revision){busy=false;refreshBudget();onBusyChange();}
    }
  }
  function refreshTrigger() {
    $('focus-button').textContent=t(busy?'busy':'action');
    $('focus-button').disabled=busy||isImporting()||!getActiveId();
    $('focus-inspect-button').textContent=t('inspect');
    $('focus-inspect-button').disabled=busy||isImporting()||!getActiveId();
    $('focus-demo').disabled=busy||isImporting();
    $('focus-active-file').textContent=getActiveId()||'';
    $('focus-active-file').title=getActiveId()||'';
    $('focus-rebuild').disabled=busy||isImporting();
    $('focus-undo').disabled=busy||isImporting();
  }
  function refreshBudget() {
    refreshTrigger();
    if(!result)return;
    const changed=result.requestedBudget!==getBudget()||result.settings.includeCallers!==options().includeCallers||result.settings.includeTests!==options().includeTests;
    const notes=[];
    if(!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(result.rootId))notes.push(t('unsupported'));
    if(changed)notes.push(t('changed'));
    if(result.plan.overBudget)notes.push(t('over'));
    else if(result.plan.omittedCount)notes.push(t('omitted',{n:result.plan.omittedCount}));
    $('focus-status').hidden=!notes.length;$('focus-status').textContent=notes.join(' ');
    $('focus-rebuild').classList.toggle('needs-rebuild',changed);
  }
  function render() {
    for(const [id,key] of Object.entries({'focus-pitch':'pitch','focus-pitch-detail':'detail','focus-demo':'demo','focus-result-label':'result','focus-undo':'undo','focus-callers-label':'callers','focus-tests-label':'tests','focus-rebuild':'rebuild','focus-support':'support'}))$(id).textContent=t(key);
    refreshTrigger();$('focus-panel').hidden=!result;
    if(!result)return;
    const {plan,rootId,projectTokens}=result, files=new Map(getFiles().map(file=>[file.id,file]));
    $('focus-root').textContent=rootId;
    const saving=projectTokens?Math.max(0,Math.round((1-plan.tokens/projectTokens)*100)):0;
    $('focus-summary').textContent=t('summary',{n:number(plan.selectedIds.length),total:number(files.size),tokens:number(plan.tokens),saving});
    const lanes=document.createDocumentFragment();
    for(const kind of ['root','dependency','caller','test']) {
      const candidates=plan.candidates.filter(candidate=>candidate.kind===kind);
      const lane=document.createElement('section');lane.className=`focus-lane focus-lane-${kind}`;
      const heading=document.createElement('h3');heading.textContent=`${t(kind)} · ${candidates.length}`;lane.append(heading);
      const list=document.createElement('div');list.className='focus-file-list';
      for(const candidate of candidates) {
        const file=files.get(candidate.id);if(!file)continue;
        const item=document.createElement('button');item.className=`focus-file${candidate.included?'':' focus-omitted'}`;
        item.title=file.path;item.addEventListener('click',()=>inspectFile(file.id));
        const name=document.createElement('strong');name.textContent=file.name;
        const path=document.createElement('span');path.className='focus-file-path';path.textContent=file.path;
        const reason=document.createElement('span');reason.className='focus-file-reason';
        reason.textContent=t(kind==='test'?(candidate.matchedBy==='filename'?'testFilename':'testImport'):`${kind}Reason`,{path:candidate.via||rootId});
        const badge=document.createElement('span');badge.className='focus-file-badge';badge.textContent=candidate.included?`✓ ${t('included')}`:t('skipped');
        item.append(name,path,reason,badge);list.append(item);
      }
      if(!candidates.length){const empty=document.createElement('p');empty.className='focus-empty';empty.textContent=t('empty');list.append(empty);}
      lane.append(list);lanes.append(lane);
    }
    $('focus-lanes').replaceChildren(lanes);
    $('focus-unresolved').hidden=!plan.unresolved.length;
    $('focus-unresolved-label').textContent=t('unresolved',{n:plan.unresolved.length});
    const unresolved=document.createDocumentFragment();
    for(const item of plan.unresolved){const li=document.createElement('li');li.textContent=`${item.id}${item.specifier?` → ${item.specifier}`:''} — ${t(item.reason)}`;unresolved.append(li);}
    $('focus-unresolved-list').replaceChildren(unresolved);
    refreshBudget();
  }
  function manualChange() {
    if(busy){revision++;busy=false;stopWorker();refreshTrigger();onBusyChange();}
    result=null;$('focus-panel').hidden=true;
  }
  function resetProject() {revision++;busy=false;stopWorker();manualChange();$('focus-callers').checked=true;$('focus-tests').checked=true;}
  $('focus-button').addEventListener('click',()=>run());
  $('focus-inspect-button').addEventListener('click',()=>run());
  $('focus-demo').addEventListener('click',()=>{if(busy||isImporting())return;loadDemo();inspectFile('src/lib/storage.ts');run('src/lib/storage.ts');});
  $('focus-rebuild').addEventListener('click',()=>run(result?.rootId));
  for(const id of ['focus-callers','focus-tests'])$(id).addEventListener('change',refreshBudget);
  $('focus-undo').addEventListener('click',()=>{
    if(!result||busy)return;
    const {previous}=result;manualChange();applySelection(previous.ids,previous.activeId);toast(t('reset'));
  });
  return {render,refreshTrigger,refreshBudget,manualChange,resetProject,run,isBusy:()=>busy};
}
