const fs=require('fs'),path=require('path'),os=require('os');const quota=require('./quota'),ledger=require('./request-ledger');
const {createHash}=require('node:crypto');
const calendar=require('./time-zone');
const ACCOUNT_REQUIRED=true,MEASUREMENT_VERSION='request-ledger-v3';
let revision=0,recordCache=null,lastPaths=new Map();
const stateVersions=new WeakMap(),sessionReconcile=require('./session-reconcile-cache').createCache();
function changedState(state){revision++;stateVersions.set(state,revision);}
// OpenAI's published Codex credit rates, credits per million tokens, checked 2026-11-07.
// Better relative weights than API USD prices; subscription allocation is still inferred.
const RATES={'gpt-6-astra':[250,25,1250],'gpt-6.1-sol':[50,2.5,250],'gpt-6.1-terra':[25,1.25,125],'gpt-6-sol':[50,5,250],'gpt-6-luna':[2.5,.25,12.5],'gpt-5.6-sol':[100,10,500],'gpt-5.6-terra':[50,5,300],'gpt-5.6-luna':[5,.5,30],'daybreak-blue':[100,10,500],'daybreak-red':[312.5,31.25,1875]};
// Account-specific model scalars fitted to local token deltas and weekly meter
// snapshots through 2026-11-08. Other models are deliberately uncalibrated.
// Values are weekly percentage points per published standard Codex credit.
const PP_PER_CREDIT={'gpt-6.1-sol':0.0037872568006282518,'gpt-6-astra':0.0033940453479000834,'gpt-6.1-terra':0.006132928702596234,'gpt-6-luna':null};
function accountSeeds(accountId,plan,models=[]){
 const reference=require('./seed-owner.json');
 const owner=typeof accountId==='string'&&plan==='pro'
  &&createHash('sha256').update(accountId).digest('hex')===reference.accountHash;
 const names=new Set([...Object.keys(PP_PER_CREDIT),...models.filter(model=>Object.hasOwn(RATES,model))]);
 return Object.fromEntries([...names].map(model=>[model,owner?PP_PER_CREDIT[model]??null:null]));
}
let selectedRoot=path.join(os.homedir(),'.codex'),strictRoot=false;function setRoot(root,strict=false){selectedRoot=root;strictRoot=strict;}
const states=new Map();let fileIndex=new Map(),fileOwners=new Map(),lastCutoff=null;let running=false,scanStarted=false,done=0,expected=0,errors=0,lastDone=0;
let checkpoints=null,checkpointError=null;
let scanMetrics=null;
const checkpointChanges=new Map();
function useCheckpoints(filename){
 checkpoints?.close();
 checkpoints=null;
 checkpointError=null;
 if(!filename)return;
 try{checkpoints=require('./log-checkpoints').openCheckpoints(filename,MEASUREMENT_VERSION+'-checkpoint-2');}
 catch(error){checkpointError=error.code||'open-failed';}
}
function tierFactor(e){const t=e.tier;if(t==null||t==='default'||t==='standard')return 1;if(t==='priority'||t==='fast')return 2.5;return null}
function HAS_CREDIT_RATE(e){return e.usageVerified!==false&&!e.attributionUnverified&&!!RATES[e.model]&&tierFactor(e)!=null}
function PRICED(e){return HAS_CREDIT_RATE(e)&&Number.isFinite(PP_PER_CREDIT[e.model])}
function creditWeight(e){if(e.usageVerified===false||e.attributionUnverified)return 0;const p=RATES[e.model],factor=tierFactor(e);if(!p||factor==null)return 0;const input=e.input_tokens,cached=Math.min(input,e.cached_input_tokens),uncached=Math.max(0,input-cached);return factor*(uncached*p[0]+cached*p[1]+e.output_tokens*p[2])/1e6}
function quotaWeight(e,coefficients=PP_PER_CREDIT){return creditWeight(e)*(coefficients[e.model]||0)}
function localDay(){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());return Date.parse(p+'T00:00:00+08:00')}
function get(s,k){return Math.max(0,Number(s?.[k])||0)}
function handle(s,line,cutoff){if(!/"(?:token_count|turn_context|thread_settings_applied|token_usage_record|compacted)"/.test(line))return;let o;try{o=JSON.parse(line)}catch{return}let p=o.payload||{};ledger.capture(s,o);if(o.type==='event_msg'&&p.type==='thread_settings_applied'){if(Object.hasOwn(p.thread_settings||{},'service_tier'))s.tier=p.thread_settings.service_tier;return}if(o.type==='turn_context'){s.model=p.model||s.model;s.effort=p.effort||s.effort;return}if(o.type==='event_msg'&&p.type==='token_count'){let q=p.rate_limits;if(q&&q.limit_id==='codex'){let w=[q.primary,q.secondary].find(x=>x?.window_minutes===10080);let t=Date.parse(o.timestamp);if(w&&Number.isFinite(t)&&t>=cutoff&&Number.isFinite(w.used_percent)&&Number.isFinite(w.resets_at))s.samples.push({at:t,used:w.used_percent,reset:w.resets_at*1000,account:s.accountId,source:'log',plan:q.plan_type||null})}}if(o.type!=='event_msg'||p.type!=='token_count'||!p.info?.total_token_usage)return;
 const t=Date.parse(o.timestamp);if(!Number.isFinite(t))return;let recoveredFromParent=false;const u=p.info.total_token_usage;if(s.first){s.first=false;if(s.hasMeta&&!s.prev&&!s.needAnchor){const last=p.info.last_token_usage;if(!last||get(u,'total_tokens')>get(last,'total_tokens')){markGap(s,t);s.prev=u;s.prevAt=t;return}}}if(s.needAnchor){s.needAnchor=false;const last=p.info.last_token_usage,fields=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];const match=last&&s.baseCandidates.find(v=>fields.every(k=>get(v,k)+get(last,k)===get(u,k)));if(match){s.prev=match;s.needsRetry=false;recoveredFromParent=true}else{const unchanged=s.baseCandidates.some(v=>fields.every(k=>get(v,k)===get(u,k)));if(unchanged)s.needsRetry=false;else markGap(s,t);s.prev=u;s.prevAt=t;return}}const fields=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];let vals={};let reset=s.prev&&get(u,'total_tokens')<get(s.prev,'total_tokens');if(reset){markGap(s,t);s.prev=u;s.prevAt=t;return}for(const k of fields) vals[k]=s.prev&&!reset?Math.max(0,get(u,k)-get(s.prev,k)):get(u,k);s.prev=u;s.prevAt=t;if(!vals.total_tokens||t<cutoff)return;
 const last=p.info.last_token_usage,deltaMatchesLast=last?fields.every(k=>vals[k]===get(last,k)):null,usageVerified=deltaMatchesLast!==false&&vals.cached_input_tokens<=vals.input_tokens&&vals.reasoning_output_tokens<=vals.output_tokens&&vals.total_tokens===vals.input_tokens+vals.output_tokens;
 s.events.push({time:t,cumulativeFingerprint:ledger.vector(u),recoveredFromParent,usageVerified,deltaMatchesLast,lastUsageIncludesReasoning:p.info.last_usage_includes_reasoning??null,serviceTierVerified:false,clientVersion:s.clientVersion||null,model:s.model||null,effort:s.effort||null,tier:s.tier??null,...vals});}
const archiveCache=require('./archive-cache').createArchiveCache(path.join(process.env.LOCALAPPDATA||os.tmpdir(),'CodexUsageDashboard','log-cache'));
function readableLog(file){
 const source=file.endsWith('.zst')?file:file+'.zst';
 if(!file.endsWith('.zst')&&fs.existsSync(file))return file;
 if(!fs.existsSync(source))return file;
 try{return archiveCache.resolve(source);}
 catch{return file.endsWith('.zst')?file.slice(0,-4):file;}
}
function enrichRows(rows){let map=new Map(rows.map(r=>[r.id,r]));fileIndex=new Map();fileOwners=new Map();function setOwner(f,account){if(!account)return;const k=pathKey(f);if(fileOwners.has(k)&&fileOwners.get(k)!==account)fileOwners.set(k,null);else if(!fileOwners.has(k))fileOwners.set(k,account)}for(const row of rows){row.paths=row.rollout_path?[readableLog(row.rollout_path)]:[];if(row.paths[0])setOwner(row.paths[0],row.accountId)}function walk(dir){let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true})}catch{return}for(const e of entries){let f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.name.endsWith('.jsonl')||e.name.endsWith('.jsonl.zst')){f=readableLog(f);let ids=[...e.name.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig)].map(m=>m[0].toLowerCase());for(const id of new Set(ids)){if(!fileIndex.has(id))fileIndex.set(id,[]);fileIndex.get(id).push(f)}let r=map.get(ids[0]);if(r){setOwner(f,r.accountId);if(!r.paths.includes(f))r.paths.push(f)}}}}let root=selectedRoot;walk(path.join(root,'sessions'));walk(path.join(root,'archived_sessions'));for(const row of rows){const unique=new Map();for(const f of row.paths)if(!unique.has(pathKey(f)))unique.set(pathKey(f),f);row.paths=[...unique.values()].sort((a,b)=>path.basename(a).localeCompare(path.basename(b)))}}
function pathKey(file){let p;try{p=fs.realpathSync.native(file)}catch{p=path.resolve(file)}return process.platform==='win32'?p.replace(/^\\\\\?\\/,'').toLowerCase():p}
function* records(rows){
 const key=JSON.stringify([revision,rows.map(r=>[r.accountId,r.id,r.title,r.paths])]);
 if(recordCache?.key!==key){const entries=[];for(const row of rows)for(const f of row.paths||[row.rollout_path]){const st=states.get(f);if(st)entries.push({row,path:f,state:st,version:stateVersions.get(st)})}recordCache={key,...sessionReconcile(entries)};}
 yield* recordCache.records;
}
async function header(file){archiveCache.pin(file);let fd;try{archiveCache.restore(file);fd=await fs.promises.open(file,'r');}catch(error){archiveCache.unpin(file);throw error;}try{let parts=[],n=0;for(;;){let b=Buffer.alloc(65536),v=await fd.read(b,0,b.length,n);if(!v.bytesRead)break;let chunk=b.subarray(0,v.bytesRead),i=chunk.indexOf(10);if(i>=0){parts.push(chunk.subarray(0,i));break}parts.push(chunk);n+=v.bytesRead;if(n>8*1024*1024)return null}let x=JSON.parse(Buffer.concat(parts).toString('utf8'));return x.type==='session_meta'?x.payload:null}catch{return null}finally{await fd.close();archiveCache.unpin(file)}}
async function lastBefore(file,end,ordinal){let fd;archiveCache.pin(file);try{archiveCache.restore(file);fd=await fs.promises.open(file,'r');let stat=await fd.stat();if(end>stat.size||end<=0)return null;const boundary=Buffer.alloc(1);await fd.read(boundary,0,1,end-1);if(boundary[0]!==10)return null;let pos=end,rest='',lastOrdinal=null;while(pos>0){let n=Math.min(pos,131072);pos-=n;let b=Buffer.alloc(n);await fd.read(b,0,n,pos);let lines=(b.toString('utf8')+rest).split('\n');rest=lines.shift();for(let i=lines.length-1;i>=0;i--){let line=lines[i];try{let x=JSON.parse(line);if(lastOrdinal===null&&Number.isSafeInteger(x.ordinal)){lastOrdinal=x.ordinal;if(ordinal!=null&&lastOrdinal!==ordinal-1)return null}if(x.type==='event_msg'&&x.payload?.type==='token_count'&&x.payload.info?.total_token_usage&&(ordinal==null||x.ordinal==null||x.ordinal<ordinal)){if(ordinal!=null&&lastOrdinal!==ordinal-1)return null;return x.payload.info.total_token_usage}}catch{}}}return ordinal!=null&&lastOrdinal===ordinal-1?{inheritedOnly:true}:null}catch{return null}finally{await fd?.close();archiveCache.unpin(file)}}
function parentCandidates(row,file,meta){const base=meta?.history_base;if(!base)return [];const paths=[...(fileIndex.get(String(base.thread_id||'').toLowerCase())||[]),...(base.thread_id===row.id?(row.paths||[]):[])];const seen=new Set();return paths.filter(p=>{const k=pathKey(p);if(k===pathKey(file)||seen.has(k)||(row.accountId&&fileOwners.get(k)!==row.accountId))return false;seen.add(k);return true})}
function ownerSignature(row,file,meta){return (row.accountId||'')+'|'+parentCandidates(row,file,meta).map(pathKey).sort().join('|')}
function anchorSignature(row,file,meta){return parentCandidates(row,file,meta).map(f=>{try{const s=archiveCache.sourceStat(f);return JSON.stringify([pathKey(f),s.dev,s.ino,s.birthtimeMs,s.size,s.mtimeMs,s.ctimeMs])}catch{return pathKey(f)+':missing'}}).sort().join('|')}
async function anchor(row,file,meta,seen=new Set()){if(seen.has(pathKey(file))||seen.size>=32)return {candidates:[],required:true};seen=new Set(seen);seen.add(pathKey(file));let base=meta?.history_base;if(!base)return {candidates:[],required:false};if(!Number.isSafeInteger(base.end_byte_offset)||base.end_byte_offset<=0||!Number.isSafeInteger(base.end_ordinal_exclusive)||!base.thread_id)return {candidates:[],required:true};const candidates=[];for(const f of parentCandidates(row,file,meta)){const usage=await lastBefore(f,base.end_byte_offset,base.end_ordinal_exclusive);if(usage?.inheritedOnly){const parentMeta=await header(f);const inherited=await anchor(row,f,parentMeta,seen);candidates.push(...inherited.candidates)}else if(usage)candidates.push(usage)}return {candidates,required:true}}
function markGap(s,t){s.unverifiedAt=t;let start=Number.isFinite(s.prevAt)?s.prevAt:s.segmentStart;let startUnknown=!Number.isFinite(start)||start>t;if(startUnknown)start=t-90*86400000;s.gaps.push({start,end:t,startUnknown,reason:'无法核验日志分段的基线'});}
function sameFile(previous,stat){
 return previous.dev===stat.dev&&previous.ino===stat.ino&&previous.birthtimeMs===stat.birthtimeMs;
}

function sameFileVersion(previous,stat){
 return sameFile(previous,stat)&&previous.size===stat.size
  &&previous.mtimeMs===stat.mtimeMs&&previous.ctimeMs===stat.ctimeMs;
}

async function boundaryAt(file,offset){
 const bytes=Buffer.alloc(Math.min(128,offset));
 if(bytes.length){
  const {bytesRead}=await file.read(bytes,0,bytes.length,offset-bytes.length);
  if(bytesRead!==bytes.length)return null;
 }
 return createHash('sha256').update(bytes).digest('hex');
}

function trimState(state,cutoff){
 if(cutoff<=state.cutoff)return false;
 const previous=[state.requests.length,state.events.length,state.samples.length,state.gaps.length];
 state.requests=state.requests.filter(event=>event.time>=cutoff);
 state.events=state.events.filter(event=>event.time>=cutoff);
 state.samples=state.samples.filter(sample=>sample.at>=cutoff);
 state.gaps=state.gaps.filter(gap=>gap.end>=cutoff);
 const requests=new Set(state.requests.map(event=>event.requestId));
 state.compactions=new Set([...state.compactions].filter(id=>requests.has(id)));
 state.cutoff=cutoff;
 return previous.some((count,index)=>count!==[state.requests.length,state.events.length,state.samples.length,state.gaps.length][index]);
}

async function readFile(row,cutoff){
 const filename=row._file||row.rollout_path;
 if(!filename)return;
 let s=states.get(filename);
 if(!s&&checkpoints){
  try{
   s=checkpoints.read(filename);
   if(s){states.set(filename,s);changedState(s);}
  }catch(error){checkpointError=error.code||'read-failed';}
 }
 if(s&&(cutoff<s.cutoff||s.ownerSignature!==ownerSignature(row,filename,s.meta)
  ||(s.needsRetry&&anchorSignature(row,filename,s.meta)!==s.baseSignature)))s=null;
 if(s&&trimState(s,cutoff)){
  changedState(s);
  if(checkpoints)checkpointChanges.set(filename,s);
 }
 if(s?.fileStat&&row._stat&&sameFileVersion(s.fileStat,row._stat)){
  s.fallbackModel=row.model;
  s.fallbackEffort=row.reasoning_effort;
  return;
 }
 let file;
 archiveCache.pin(filename);
 try{
  archiveCache.restore(filename);
  file=await fs.promises.open(filename,'r');
  if(scanMetrics)scanMetrics.filesOpened++;
  const stat=await file.stat();
  const unchanged=s?.fileStat&&sameFileVersion(s.fileStat,stat);
  if(s&&!unchanged&&s.fileStat){
   const append=sameFile(s.fileStat,stat)&&stat.size>s.fileStat.size;
   const boundary=append&&await boundaryAt(file,s.offset);
   if(!boundary||s.boundary!==boundary)s=null;
  }
  if(!s||stat.size<s.offset){
   const meta=await header(filename),base=await anchor(row,filename,meta);
   s={offset:0,cutoff,prev:null,prevAt:null,first:true,hasMeta:!!meta,needAnchor:base.required,
    baseCandidates:base.candidates,meta,baseSignature:anchorSignature(row,filename,meta),
    ownerSignature:ownerSignature(row,filename,meta),needsRetry:base.required,requests:[],
    compactions:new Set(),gaps:[],segmentStart:Date.parse(meta?.timestamp),unverifiedAt:null,
    accountId:row.accountId||null,clientVersion:meta?.cli_version||null,samples:[],model:null,
    effort:null,tier:null,events:[],fallbackModel:row.model,fallbackEffort:row.reasoning_effort};
   states.set(filename,s);
   changedState(s);
  }
  s.fallbackModel=row.model;
  s.fallbackEffort=row.reasoning_effort;
  if(s.fileStat&&unchanged)return;
  if(stat.size>s.offset){
   const stream=file.createReadStream({start:s.offset,end:stat.size-1,autoClose:false,highWaterMark:1024*1024});
   let parts=[],size=0;
   for await(const chunk of stream){
    if(scanMetrics)scanMetrics.logBytesRead+=chunk.length;
    let start=0,index;
    while((index=chunk.indexOf(10,start))!==-1){
     const part=chunk.subarray(start,index);
     const line=parts.length?Buffer.concat([...parts,part],size+part.length):part;
     handle(s,line.toString('utf8'),cutoff);
     if(scanMetrics)scanMetrics.linesRead++;
     s.offset+=size+part.length+1;
     parts=[];
     size=0;
     start=index+1;
    }
    if(start<chunk.length){
     const rest=chunk.subarray(start);
     parts.push(rest);
     size+=rest.length;
    }
   }
   changedState(s);
  }
  s.boundary=await boundaryAt(file,s.offset);
  if(!s.boundary)throw Error('Log changed during read');
  s.fileStat=stat;
  s.cutoff=cutoff;
  s.requests=s.requests.filter(x=>x.time>=cutoff);
  s.events=s.events.filter(x=>x.time>=cutoff);
  s.samples=s.samples.filter(x=>x.at>=cutoff);
  if(checkpoints)checkpointChanges.set(filename,s);
 }catch{
  errors++;
  // Replay on the next pass if a file changed or a read stopped mid-scan.
  if(states.delete(filename))revision++;
  if(checkpoints)checkpointChanges.set(filename,null);
 }finally{
  await file?.close();
  archiveCache.unpin(filename);
 }
}
async function scan(rows,weekStart,accountCoverageStart=null,{force=false}={}){
 const rowKey=row=>JSON.stringify([row.accountId,row.id]);
 if(running||(!force&&Date.now()-lastDone<10000)){
  for(const row of rows)row.paths=lastPaths.get(rowKey(row))||[];
  return;
 }
 const started=performance.now();
 scanMetrics={filesOpened:0,logBytesRead:0,linesRead:0,durationMs:null};
 enrichRows(rows);
 lastPaths=new Map(rows.map(row=>[rowKey(row),row.paths]));
 running=true;
 scanStarted=true;
 done=0;
 errors=0;
 const cutoff=Math.min(weekStart||Date.now()-8*86400000,localDay()-7*86400000,accountCoverageStart??Infinity)-3600000;
 lastCutoff=cutoff;
 if(strictRoot)errors+=rows.filter(row=>row.updated*1000>=cutoff&&!row.paths?.length).length;
 const relevant=[];
 for(const row of rows)for(const file of row.paths||[]){
  try{
   const stat=fs.existsSync(file)?fs.statSync(file):archiveCache.sourceStat(file);
   if(stat.mtimeMs>=cutoff)relevant.push({...row,_file:file,_stat:stat});
  }catch{
   if(states.delete(file))revision++;
   if(checkpoints)checkpointChanges.set(file,null);
   if(row.updated*1000>=cutoff)errors++;
  }
 }
 expected=relevant.length;
 const retained=new Set(relevant.map(row=>row._file));
 for(const filename of states.keys()){
  if(!retained.has(filename)){
   states.delete(filename);
   revision++;
  }
 }
 let next=0;
 async function worker(){
  while(next<relevant.length){
   await readFile(relevant[next++],cutoff);
   done++;
  }
 }
 try{
  await Promise.all([worker(),worker()]);
  if(checkpoints&&checkpointChanges.size){
   try{checkpoints.commit(checkpointChanges,cutoff);checkpointError=null;}
   catch(error){checkpointError=error.code||'write-failed';}
  }
 }finally{
  checkpointChanges.clear();
  running=false;
  lastDone=Date.now();
  archiveCache.trim();
  scanMetrics.archiveCache=archiveCache.metrics();
  scanMetrics.durationMs=Math.round((performance.now()-started)*100)/100;
 }
}
function compute(rows,weekStart,weekEnd,used,quotaContext={}){
 const accountKnown=!!quotaContext.accountId;
 rows=accountKnown?rows.filter(r=>r.accountId===quotaContext.accountId):[];
 const measured=[...records(rows)];
 const invalidRequests=new Set(measured.flatMap(([,s])=>s.invalidRequests||[]));
 const diagnostics=recordCache?.diagnostics||{};
 const knownRows=new Map(rows.map(row=>[row.id,row]));
 const saved=new Map();
 const byThread=id=>{
  const key=id||'retained-usage';
  if(!saved.has(key))saved.set(key,{row:knownRows.get(key)||{id:key},events:[],gaps:[],samples:[]});
  return saved.get(key);
 };
 if(accountKnown){
  for(const e of quotaContext.retainedCalls||[])byThread(e.threadId).events.push(e);
  for(const g of quotaContext.invalidatedGaps||[])byThread(g.threadId).gaps.push(g);
 }
 for(const {row,...state} of saved.values())measured.push([row,state]);
 const now=quotaContext.now??Date.now();
 const coefficients=quotaContext.coefficients||PP_PER_CREDIT;
 const calibrated=e=>!e.retained&&HAS_CREDIT_RATE(e)&&Number.isFinite(coefficients[e.model]);
 const timeZone=calendar.resolveTimeZone(quotaContext.timeZone??'Asia/Shanghai');
 const {start:day,end:dayEnd}=calendar.dayBounds(now,timeZone);
 let dayGroups=new Map(),weekGroups=new Map(),weekDetails=new Map(),hourly=Array.from({length:24},()=>0);
 let incomplete=[],historyIncomplete=[],recovered={segments:0,tokens:0},all=0,unknown=0,unverified=0;
 for(const [row,st] of measured)for(const g of st.gaps||[]){
  const item={id:row.id,title:row.title||'未命名',...g};
  historyIncomplete.push(item);
  if(g.end>=Math.min(day,weekStart||Infinity)){unverified++;incomplete.push(item);}
 }
 const hasCycle=Number.isFinite(weekStart)&&Number.isFinite(weekEnd)&&weekEnd>weekStart;
 const dayUnverified=incomplete.filter(g=>g.end>=day&&g.start<dayEnd).length;
 const dayCycleUnverified=incomplete.filter(g=>g.end>=Math.max(day,weekStart||Infinity)&&g.start<Math.min(dayEnd,weekEnd||Infinity)).length;
 let dayCycleUnknown=0,weekDayWeight=0;
 const blank=()=>({input:0,output:0,total:0,cached:0,weight:0,creditEquivalent:0,cycleWeight:0,unknown:0});
 function add(map,key,e,row){
  let x=map.get(key);
  if(!x){
   x={id:row.id,title:row.title||'未命名',model:e.model||'未知',effort:e.effort||'未知',tier:e.tier||'未记录',
    compaction:!!e.compaction,attributionUnverified:!!e.attributionUnverified,...blank()};
   map.set(key,x);
  }
  const input=e.input_tokens,cache=Math.min(input,e.cached_input_tokens),priced=calibrated(e);
  const weight=priced?quotaWeight(e,coefficients):0;
  x.input+=input;x.output+=e.output_tokens;x.total+=e.total_tokens;x.cached+=cache;
  x.creditEquivalent+=HAS_CREDIT_RATE(e)?creditWeight(e):0;x.weight+=weight;
  if(!priced)x.unknown+=e.total_tokens;
  if(e.retained)x.retainedTokens=(x.retainedTokens||0)+e.total_tokens;
  return weight;
 }
 for(const [row,s] of measured)for(const e of s.events){
  if(e.time>now+60000||invalidRequests.has(e.requestId))continue;
  const key=JSON.stringify([row.id,e.model,e.effort,e.tier,!!e.compaction,!!e.attributionUnverified,!!e.retained]);
  const inDay=e.time>=day&&e.time<dayEnd;
  const dayWeight=inDay?add(dayGroups,key,e,row):0;
  if(inDay)hourly[calendar.hourOfDay(e.time,timeZone)]+=e.total_tokens;
  if(!hasCycle||e.time<weekStart||e.time>=weekEnd)continue;
  if(e.recoveredFromParent&&e.usageVerified){recovered.segments++;recovered.tokens+=e.total_tokens;}
  all+=add(weekGroups,row.id,e,row);
  add(weekDetails,key,e,row);
  if(inDay){dayGroups.get(key).cycleWeight+=dayWeight;weekDayWeight+=dayWeight;}
  if(!calibrated(e)){unknown+=e.total_tokens;if(inDay)dayCycleUnknown+=e.total_tokens;}
 }
 let dayRows=[...dayGroups.values()],weekRows=[...weekGroups.values()],weekDetailRows=[...weekDetails.values()];
 let dayTotal=dayRows.reduce((a,x)=>a+x.total,0),dayInput=dayRows.reduce((a,x)=>a+x.input,0),dayOutput=dayRows.reduce((a,x)=>a+x.output,0);const dayGapIds=new Set(incomplete.filter(g=>g.end>=day&&g.start<dayEnd).map(g=>g.id)),weekGapIds=new Set(incomplete.filter(g=>g.end>=weekStart&&g.start<weekEnd).map(g=>g.id));for(const x of dayRows){x.estimateReason=x.unknown?'部分用量没有可靠的计量系数或记录不一致':dayGapIds.has(x.id)?'分叉记录缺少可核验基线':null;x.estimatedQuota=x.estimateReason?null:x.weight;}for(const x of dayRows)x.todayShare=dayTotal?100*x.total/dayTotal:null;let dayWeightTotal=dayRows.reduce((a,x)=>a+x.weight,0),dayUnknown=dayRows.reduce((a,x)=>a+x.unknown,0),sessionMap=new Map();for(const x of dayRows){let y=sessionMap.get(x.id);if(!y){y={id:x.id,title:x.title,total:0,input:0,output:0,weight:0,creditEquivalent:0,cycleWeight:0,unknown:0,models:new Set(),efforts:new Set(),tiers:new Set()};sessionMap.set(x.id,y)}for(const k of ['total','input','output','weight','creditEquivalent','cycleWeight','unknown'])y[k]+=x[k];y.models.add(x.model);y.efforts.add(x.effort);y.tiers.add(x.tier)}let daySessions=[...sessionMap.values()];for(const x of [...dayRows,...daySessions]){x.todayQuotaShare=dayWeightTotal>0&&!dayUnknown&&!dayUnverified?100*x.weight/dayWeightTotal:null;x.weekQuotaToday=hasCycle&&!dayCycleUnknown&&!dayCycleUnverified&&Number.isFinite(used)?x.cycleWeight:null;if(x.models)x.models=[...x.models];if(x.efforts)x.efforts=[...x.efforts];if(x.tiers)x.tiers=[...x.tiers]}daySessions.sort((a,b)=>b.weight-a.weight);let weekTotal=weekRows.reduce((a,x)=>a+x.total,0),weekInput=weekRows.reduce((a,x)=>a+x.input,0),weekOutput=weekRows.reduce((a,x)=>a+x.output,0);for(const x of [...weekRows,...weekDetailRows]){x.estimateReason=x.unknown?'部分用量没有可靠的计量系数或记录不一致':weekGapIds.has(x.id)?'分叉记录缺少可核验基线':null;x.weekPercent=Number.isFinite(used)&&!x.estimateReason?x.weight:null;x.weekShare=weekTotal?100*x.total/weekTotal:null;}
 let quotaSamples=[...(quotaContext.samples||[])];for(const [,st] of measured)quotaSamples.push(...st.samples);let quotaHistory=quota.aggregate(quotaSamples,{now,start:weekStart,end:weekEnd,accountId:quotaContext.accountId||null,plan:quotaContext.plan,timeZone});return {accountKnown,timeZone,dayEnd,measurementVersion:MEASUREMENT_VERSION,ledger:diagnostics,estimateStatus:accountKnown?'provisional':'no-account',quotaHistory,incomplete,historyIncomplete,recovered,dayUnverified,dayCycleUnverified,dayCycleUnknown,coverageStart:lastCutoff,scanning:running||!lastDone,done,expected,errors,unverified,dayStart:day,weekStart,weekEnd,dayRows:dayRows.sort((a,b)=>b.total-a.total),daySessions,dayUnknown,hourly,weekRows:weekRows.sort((a,b)=>b.weight-a.weight),weekDetailRows:weekDetailRows.sort((a,b)=>b.total-a.total),weekTotal,weekInput,weekOutput,dayTotal,dayInput,dayOutput,unknown,estimateDayQuota:accountKnown&&!dayUnknown&&!dayUnverified?dayWeightTotal:null,knownDayQuota:accountKnown?dayWeightTotal:null,estimatedWeekQuota:accountKnown&&!unknown&&!unverified?all:null,knownWeekQuota:accountKnown?all:null,estimateToday:hasCycle&&!dayCycleUnknown&&!dayCycleUnverified?weekDayWeight:null};}
function observations(rows){
 const calls=[],samples=[],gaps=[],invalidRequests=new Set();
 for(const [row,s] of records(rows)){
  for(const e of s.events)calls.push({threadId:row.id,...e});
  samples.push(...s.samples);
  for(const x of s.gaps||[])gaps.push({threadId:row.id,...x});
  for(const id of s.invalidRequests||[])invalidRequests.add(id);
 }
 return {calls:calls.filter(e=>!invalidRequests.has(e.requestId)),samples,gaps,invalidRequests:[...invalidRequests],revision};
}
function originalWorkingDirectory(row){
 let earliest=null;
 for(const file of row.paths||[]){
  const meta=states.get(file)?.meta;
  if(meta?.id!==row.id||typeof meta.cwd!=='string'||meta.history_base)continue;
  const time=Date.parse(meta.timestamp);
  if(!earliest||(Number.isFinite(time)&&(!Number.isFinite(earliest.time)||time<earliest.time))){
   earliest={folder:meta.cwd,time};
  }
 }
 return earliest?.folder??row.cwd??null;
}
module.exports={MEASUREMENT_VERSION,scan,compute,setRoot,useCheckpoints,checkpointStatus:()=>checkpointError,
 scanMetrics:()=>scanMetrics&&{...scanMetrics},RATES,creditWeight,quotaWeight,PP_PER_CREDIT,accountSeeds,observations,originalWorkingDirectory,pathKey};
