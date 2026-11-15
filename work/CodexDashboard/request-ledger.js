// Request IDs identify consumption. token_count is often a second view of the
// same request; inherited rollouts and cumulative counters are not new usage.
const FIELDS=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
const vector=u=>FIELDS.map(k=>u?.[k]??0).join('|');
const valid=u=>FIELDS.every(k=>Number.isSafeInteger(u?.[k]??0)&&(u?.[k]??0)>=0)&&u.total_tokens===u.input_tokens+u.output_tokens&&(u.cached_input_tokens??0)<=u.input_tokens&&(u.reasoning_output_tokens??0)<=u.output_tokens;
const usage=u=>Object.fromEntries(FIELDS.map(k=>[k,u?.[k]??0]));

function capture(s,o){
 const p=o.payload||{},time=Date.parse(o.timestamp);
 if(o.type==='compacted'&&p.compaction_response_id)s.compactions.add(p.compaction_response_id);
 if(o.type!=='token_usage_record'||!p.response_id||!p.thread_id||!Number.isFinite(time)||!p.usage)return;
 // Do not charge inherited parent requests to a child, or trust a filename alone.
 if(!s.meta?.id||p.thread_id!==s.meta.id)return;
 s.requests.push({requestId:p.response_id,owner:p.thread_id,time,model:p.model||s.model||null,
   modelSource:p.model?'request':'turn-context',effort:p.reasoning_effort||p.effort||s.effort||null,
   tier:p.service_tier??s.tier??null,serviceTierVerified:p.service_tier!=null,
   clientVersion:s.clientVersion||null,cumulativeFingerprint:p.thread_token_usage?vector(p.thread_token_usage):null,rawUsage:p.usage,...usage(p.usage)});
}

function reconcile(entries){
 const groups=new Map(),diagnostics={requests:0,compactions:0,compactionTokens:0,conflicts:0,unresolved:0};
 for(const [row,s] of entries){const k=(row.accountId||'unknown')+'|'+row.id;if(!groups.has(k))groups.set(k,{row,states:[]});
  if(s.meta?.id&&s.meta.id!==row.id){groups.get(k).states.push({events:[],requests:[],samples:[],gaps:[{start:s.segmentStart||0,end:Date.now(),reason:'log-owner-mismatch'}]});continue;}
  groups.get(k).states.push(s)}
 const result=[];
 for(const {row,states} of groups.values()){
  const legacyMap=new Map(),requests=new Map(),markers=new Set(),gaps=states.flatMap(s=>s.gaps||[]);
  const invalidRequests=[];
  for(const s of states){for(const id of s.compactions||[])markers.add(id);for(const e of s.events){const k=[e.time,e.model,vector(e)].join('|');if(!legacyMap.has(k))legacyMap.set(k,e)}for(const e of s.requests||[]){if(e.owner!==row.id)continue;if(!requests.has(e.requestId))requests.set(e.requestId,[]);requests.get(e.requestId).push(e)}}
  const legacy=[...legacyMap.values()].sort((a,b)=>a.time-b.time),consumed=new Set(),events=[],byVector=new Map(),byCumulative=new Map();
  for(let i=0;i<legacy.length;i++){
   const e=legacy[i],fp=vector(e),item={e,i};
   if(!byVector.has(fp))byVector.set(fp,[]);byVector.get(fp).push(item);
   if(e.cumulativeFingerprint){
    if(!byCumulative.has(fp))byCumulative.set(fp,new Map());
    const counters=byCumulative.get(fp);
    if(!counters.has(e.cumulativeFingerprint))counters.set(e.cumulativeFingerprint,[]);
    counters.get(e.cumulativeFingerprint).push(item);
   }
  }
  const unverified=legacy.map((e,i)=>({e,i})).filter(x=>x.e.usageVerified===false);
  const gap=(e,reason)=>{
   invalidRequests.push(e.requestId);
   gaps.push({start:e.time-120000,end:e.time+120000,reason});
  };
  const ordered=[...requests].sort((a,b)=>a[1][0].time-b[1][0].time);
  for(let index=0;index<ordered.length;index++){
   const [id,copies]=ordered[index],nextRequestTime=ordered[index+1]?.[1][0].time??Infinity;
   const r=copies[0],fp=vector(r),compaction=markers.has(id);
   const identified=(byCumulative.get(fp)?.get(r.cumulativeFingerprint)||[]).filter(({i})=>!consumed.has(i));
   // A resumed counter may include an inherited prefix whereas the request's
   // thread total does not. In that case reconcile the per-request vector in
   // order; a tool wait can delay its mirror beyond an arbitrary two minutes.
   const matches=identified.length?identified:(byVector.get(fp)||[]).filter(({e,i})=>!consumed.has(i)&&e.time>=r.time&&(e.time-r.time<=120000||e.time<nextRequestTime));
   if(new Set(copies.map(vector)).size!==1||copies.some(e=>!valid(e.rawUsage))){
    diagnostics.conflicts++;for(const copy of copies)for(const {e,i} of byVector.get(vector(copy))||[])if(e.time>=copy.time&&e.time-copy.time<=120000)consumed.add(i);gap(r,'conflicting-request');continue;
   }
   const match=matches[0];
   if(match){consumed.add(match.i);for(const mirror of identified)consumed.add(mirror.i);}
   // A non-matching cumulative delta may cover this request plus unrecorded
   // work. Keep it unresolved instead of adding both and double counting.
   if(!match&&!compaction&&unverified.some(({e,i})=>!consumed.has(i)&&e.time>=r.time&&e.time-r.time<=120000)){
    diagnostics.unresolved++;gap(r,'unmatched-request-counter');continue;
   }
   const contextConflicts=new Set(copies.map(e=>[e.model,e.effort,e.tier].join('|'))).size>1;
   const attributionUnverified=contextConflicts||(compaction&&r.modelSource!=='request');
   const e={...r,rawUsage:undefined,requestId:id,source:'request-ledger',compaction,
    contextModel:r.model,model:attributionUnverified?null:r.model,
    effort:attributionUnverified?null:r.effort,tier:attributionUnverified&&!r.serviceTierVerified?null:r.tier,
    attributionUnverified,usageVerified:true,deltaMatchesLast:match?.e.deltaMatchesLast??null,
    recoveredFromParent:match?.e.recoveredFromParent||false};
   events.push(e);diagnostics.requests++;
   if(compaction){diagnostics.compactions++;diagnostics.compactionTokens+=e.total_tokens;}
  }
  for(let i=0;i<legacy.length;i++)if(!consumed.has(i))events.push({...legacy[i],source:'legacy-counter'});
  events.sort((a,b)=>a.time-b.time);
  result.push([row,{events,gaps,invalidRequests,samples:states.flatMap(s=>s.samples||[])}]);
 }
 return {records:result,diagnostics};
}
module.exports={capture,reconcile,vector,valid,FIELDS};
