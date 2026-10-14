import {isIgnored, normalizePath} from './core.js';

function hasIgnoredAncestor(path,patterns) {
 const parts=path.split('/');
 for(let i=1;i<parts.length;i++) {
  if(isIgnored(parts.slice(0,i).join('/'),patterns,{directory:true}))return true;
 }
 return false;
}

// Apply all known exclusions before limiting: generated files must not crowd out source.
export function prepareImport(source, maxFiles=5000, customPatterns=[], {blockedDirectories=[]}={}) {
 const candidates=[],ignoreFiles=[],seen=new Set();let skipped=0;
 for(const entry of source){
  let path;try{path=normalizePath(entry.path);}catch{skipped++;continue;}
  if(isIgnored(path)||seen.has(path)||blockedDirectories.some(base=>base===''||path===base||path.startsWith(base+'/'))){skipped++;continue;}seen.add(path);
  const normalized={...entry,path};
  if(path.split('/').at(-1)==='.gitignore')ignoreFiles.push(normalized);
  if(hasIgnoredAncestor(path,customPatterns)||isIgnored(path,customPatterns)){skipped++;continue;}
  candidates.push(normalized);
 }
 return {entries:candidates.slice(0,maxFiles),ignoreFiles,skipped:skipped+Math.max(0,candidates.length-maxFiles)};
}

export function scopedIgnorePatterns(ignorePath,content) {
 const path=normalizePath(ignorePath),base=path.slice(0,-'.gitignore'.length),patterns=[];
 for(let line of content.split(/\r?\n/)){
  line=line.trim();if(!line||line.startsWith('#'))continue;
  const negated=line.startsWith('!');if(negated)line=line.slice(1);
  const anchored=line.startsWith('/'),withoutTrailing=line.replace(/\/$/,'');
  if(base&&!anchored&&!withoutTrailing.includes('/')) line=`${base}**/${line}`;
  else if(base)line=`${base}${line.replace(/^\//,'')}`;
  patterns.push(`${negated?'!':''}${line}`);
 }
 return patterns;
}

export function folderRelativePath(file) {
 const relative=file.webkitRelativePath;
 return relative&&relative.includes('/')?relative.split('/').slice(1).join('/'):file.name;
}

/** Read shallow rules first, without consulting ignore files inside an excluded directory. */
export async function readIgnoreRules(ignoreFiles,{maxBytes=1024*1024}={}) {
 const patterns=[],blockedDirectories=[];
 let bytes=0,truncated=false;
 const sorted=[...ignoreFiles].sort((a,b)=>a.path.split('/').length-b.path.split('/').length);
 for(const entry of sorted) {
  let path;try{path=normalizePath(entry.path);}catch{truncated=true;continue;}
  const parts=path.split('/');
  if(parts.at(-1)!=='.gitignore')continue;
  if(hasIgnoredAncestor(path,patterns)||blockedDirectories.some(base=>base===''||path.startsWith(base+'/')))continue;
  const directory=parts.slice(0,-1).join('/');
  try {
   if(entry.file.size>maxBytes-bytes){truncated=true;blockedDirectories.push(directory);continue;}
   bytes+=entry.file.size;
   for(const pattern of scopedIgnorePatterns(path,await entry.file.text()))patterns.push(pattern);
  }catch{truncated=true;blockedDirectories.push(directory);}
 }
 return {patterns,truncated,blockedDirectories};
}

/** Collect dropped FileSystemEntry objects with the same ignore scope as folder imports.
 * Directory enumeration is bounded independently from the eligible-file limit. A directory's
 * own .gitignore is read before its children, including when it arrives in a later reader batch.
 * `skipped` counts filtered/unreadable entries; descendants of pruned folders are not enumerated.
 */
export async function collectDroppedEntries(entries, {
 maxFiles=5000, maxEntries=100000, maxIgnoreBytes=1024*1024,
}={}) {
 const result=[],seenPaths=new Set(),fileCache=new WeakMap();
 let enumerated=0,skipped=0,truncated=false,full=false,ignoreBytes=0;
 const oneRoot=entries.length===1&&entries[0].isDirectory;
 const name=oneRoot?entries[0].name:'dropped-files';

 function getFile(entry) {
  if(!fileCache.has(entry)) fileCache.set(entry,new Promise(resolve=>{
   try{entry.file(resolve,()=>resolve(null));}catch{resolve(null);}
  }));
  return fileCache.get(entry);
 }
 async function readChildren(entry) {
  const children=[];
  try {
   const reader=entry.createReader();
   // At the exact limit, read the terminating batch too: an empty batch proves
   // the listing is complete without enumerating any additional entries.
   while(true) {
    const batch=await new Promise((resolve,reject)=>reader.readEntries(resolve,reject));
    if(!batch.length)return children;
    const available=maxEntries-enumerated;
    for(const child of batch.slice(0,available))children.push(child);
    enumerated+=Math.min(batch.length,available);
    if(batch.length>available){truncated=true;break;}
   }
  }catch{skipped++;truncated=true;}
  // Without a complete listing, a later .gitignore may still be missing. Only a
  // directory whose ignore file was found can safely contribute partial results.
  if(!children.some(child=>child.isFile&&child.name==='.gitignore')){skipped+=children.length;return [];}
  return children;
 }
 async function walkChildren(children,prefix,inherited) {
  let patterns=inherited;
  const ignoreEntry=children.find(entry=>entry.isFile&&entry.name==='.gitignore');
  if(ignoreEntry) {
   const file=await getFile(ignoreEntry);
   if(file&&file.size<=maxIgnoreBytes-ignoreBytes) {
    ignoreBytes+=file.size;
    try{patterns=[...inherited,...scopedIgnorePatterns(prefix+'.gitignore',await file.text())];}
    catch{truncated=true;skipped+=children.length;return;}
   }else{truncated=true;skipped+=children.length;return;}
  }
  for(const entry of children) {
   if(full)break;
   let path;try{path=normalizePath(prefix+entry.name);}catch{skipped++;continue;}
   if(isIgnored(path,patterns,{directory:entry.isDirectory})){skipped++;continue;}
   if(entry.isDirectory) await walkChildren(await readChildren(entry),path+'/',patterns);
   else if(entry.isFile) {
    if(seenPaths.has(path)){skipped++;continue;}seenPaths.add(path);
    const file=await getFile(entry);
    if(!file){skipped++;continue;}
    if(result.length>=maxFiles){truncated=true;full=true;break;}
    result.push({path,file});
   }
  }
 }
 if(oneRoot)await walkChildren(await readChildren(entries[0]),'',[]);
 else {
  const initial=entries.slice(0,maxEntries);enumerated=initial.length;
  if(initial.length<entries.length)truncated=true;
  await walkChildren(initial,'',[]);
 }
 return {result,name,truncated,skipped};
}
