const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {zstdDecompressSync}=require('node:zlib');

const limitBytes=1024*1024*1024;
const outputLimit=512*1024*1024;
function createArchiveCache(folder,{limit=limitBytes}={}){
 const known=new Map(),sources=new Map(),pinned=new Map(),verified=new Map();
 let initialized=false;
 function initialize(){
  if(initialized)return;
  fs.mkdirSync(folder,{recursive:true});
  for(const entry of fs.readdirSync(folder,{withFileTypes:true})){
   if(!entry.isFile()||!entry.name.endsWith('.jsonl'))continue;
   const file=path.join(folder,entry.name);
   const stat=fs.statSync(file);
   known.set(file,{size:stat.size,touched:stat.atimeMs});
  }
  initialized=true;
 }
 function trim(){
  initialize();
  let bytes=[...known.values()].reduce((sum,entry)=>sum+entry.size,0);
  for(const [file,entry] of [...known].sort((a,b)=>a[1].touched-b[1].touched)){
   if(bytes<=limit)break;
   if(pinned.has(file))continue;
   try{fs.unlinkSync(file);}
   catch(error){if(error.code!=='ENOENT')continue;}
   try{fs.unlinkSync(file+'.meta.json');}catch{}
   known.delete(file);
   verified.delete(file);
   bytes-=entry.size;
  }
  return bytes;
 }
 function resolve(source){
  initialize();
  const stat=fs.statSync(source);
  const signature=JSON.stringify([stat.dev,stat.ino,stat.birthtimeMs,stat.size,stat.mtimeMs,stat.ctimeMs]);
  const file=path.join(folder,createHash('sha256').update(path.resolve(source)).digest('hex').slice(0,16)
   +'-'+path.basename(source,'.zst'));
  sources.set(file,source);
  let reusable=false;
  try{
   const metadata=JSON.parse(fs.readFileSync(file+'.meta.json','utf8'));
   const cached=fs.statSync(file);
   const cachedVersion=JSON.stringify([cached.ino,cached.size,cached.mtimeMs,cached.ctimeMs]);
   if(metadata.signature===signature&&metadata.bytes===cached.size){
    reusable=verified.get(file)===cachedVersion
     ||createHash('sha256').update(fs.readFileSync(file)).digest('hex')===metadata.sha256;
    if(reusable)verified.set(file,cachedVersion);
   }
  }catch{}
  if(!reusable){
   const bytes=zstdDecompressSync(fs.readFileSync(source),{maxOutputLength:outputLimit});
   const temporary=file+'.tmp';
   try{
    fs.writeFileSync(temporary,bytes);
    fs.renameSync(temporary,file);
    fs.utimesSync(file,stat.atime,stat.mtime);
    fs.writeFileSync(file+'.meta.json',JSON.stringify({signature,bytes:bytes.length,
     sha256:createHash('sha256').update(bytes).digest('hex')}));
    const cached=fs.statSync(file);
    verified.set(file,JSON.stringify([cached.ino,cached.size,cached.mtimeMs,cached.ctimeMs]));
   }finally{try{fs.unlinkSync(temporary);}catch{}}
  }
  known.set(file,{size:fs.statSync(file).size,touched:Date.now()});
  // The caller may need this file while other cache entries are reclaimed.
  pinned.set(file,(pinned.get(file)||0)+1);
  trim();
  unpin(file);
  return file;
 }
 function restore(file){
  const source=sources.get(file);
  if(source&&!fs.existsSync(file))return resolve(source);
  return file;
 }
 function pin(file){
  pinned.set(file,(pinned.get(file)||0)+1);
 }
 function unpin(file){
  const count=pinned.get(file)||0;
  if(count<=1)pinned.delete(file);
  else pinned.set(file,count-1);
 }
 function sourceStat(file){
  return fs.statSync(sources.get(file)||file);
 }
 return {resolve,restore,pin,unpin,sourceStat,trim,metrics:()=>({
  budget:limit,bytes:[...known.values()].reduce((sum,entry)=>sum+entry.size,0),files:known.size
 })};
}
module.exports={createArchiveCache,limitBytes};
