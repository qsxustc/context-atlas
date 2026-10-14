import {isIgnored, normalizePath} from './core.js';

// Filter generated directories before limiting: dependency-heavy folders must not crowd out source.
export function prepareImport(source, maxFiles=5000) {
 const candidates=[];let skipped=0;
 for(const entry of source){let path;try{path=normalizePath(entry.path);}catch{skipped++;continue;}if(isIgnored(path)){skipped++;continue;}candidates.push({...entry,path});}
 const ignoreFiles=candidates.filter(entry=>entry.path.split('/').at(-1)==='.gitignore');
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
