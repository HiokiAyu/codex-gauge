// Quota samples are observed account readings, not per-chat billing.
const {dayStart,startForDate,addDays,dayBounds,resolveTimeZone}=require('./time-zone');
const MAX_READING_GAP=15*60000;
function summarize(samples,start,end,reset,includeSources=true){let subset=samples.filter(x=>x.at>=start&&x.at<end&&(reset==null||x.reset===reset)).sort((a,b)=>a.at-b.at||a.used-b.used);if(!subset.length)return {status:'missing',n:0};let resets=new Set(subset.map(s=>s.reset));if(reset==null&&resets.size>1){const segments=[...resets].map(r=>({reset:r,...summarize(subset,start,end,r,includeSources)})).sort((a,b)=>(a.first?.at??0)-(b.first?.at??0));return {status:'reset',n:subset.length,segments};}let first=subset[0],last=subset[subset.length-1];if(subset.length<2||first.at===last.at)return {status:'one',n:subset.length,first,last};let decreases=0;for(let i=1;i<subset.length;i++)if(subset[i].used<subset[i-1].used-1e-8)decreases++;const points=subset.filter((x,i)=>i===0||i===subset.length-1||x.used!==subset[i-1].used).map(x=>({at:x.at,used:x.used}));if(decreases){const result={status:'conflict',points,decreases,n:subset.length,first,last,endpointDelta:Math.round((last.used-first.used)*10000)/10000};if(includeSources){result.sources={};for(const source of ['live','log']){const own=subset.filter(x=>x.source===source);if(own.length)result.sources[source]=summarize(own,start,end,reset,false)}}return result;}return {status:'observed',n:subset.length,first,last,points,delta:Math.round((last.used-first.used)*10000)/10000};}
function quotaObservation(samples,start,end,reset){
 const relevant=samples.filter(x=>x.at>=start&&x.at<end&&(reset==null||x.reset===reset))
  .sort((a,b)=>a.at-b.at||a.used-b.used);
 const live=relevant.filter(x=>x.source==='live');
 const liveResets=new Set(live.map(s=>s.reset));
 // A replayed log can still carry a previous cycle after live readings have
 // moved on. Keep log-only cycles where live coverage is absent.
 const resets=new Set(relevant.filter(s=>!live.length||s.source==='live'||liveResets.has(s.reset)
  ||s.at<live[0].at&&s.reset<=live[0].at).map(s=>s.reset));
 if(reset==null&&resets.size>1){
  const segments=[...resets].map(r=>({reset:r,...quotaObservation(relevant,start,end,r)}))
   .sort((a,b)=>(a.first?.at??0)-(b.first?.at??0));
  return {status:'reset',n:relevant.length,segments};
 }
 // Use the live series when possible. If its start is missing, a nearby
 // reading from the same weekly counter can supply the opening balance.
 const spansTime=readings=>readings.length>=2&&readings[0].at<readings.at(-1).at;
 const log=relevant.filter(x=>x.source!=='live'&&resets.has(x.reset));
 const firstLive=live[0];
 const boundary=firstLive?Math.max(start,firstLive.reset-7*86400000):start;
 const opening=firstLive&&firstLive.at>boundary
  ?log.find(s=>s.source==='log'&&s.reset===firstLive.reset&&(!firstLive.plan||s.plan===firstLive.plan)&&s.at>=boundary&&s.at<firstLive.at)
  :null;
 const logBaseline=opening&&opening.at-boundary<=MAX_READING_GAP&&opening.used<=firstLive.used
  &&!log.some(s=>s.at===opening.at&&s.reset===opening.reset&&s.plan===opening.plan&&s.used!==opening.used)
  ?opening:null;
 const preferLive=firstLive&&(!spansTime(log)||spansTime(live)||logBaseline);
 const primary=preferLive?live:log;
 // Only the boundary reading is used. Stale interior log readings cannot
 // introduce a fall in the live series or join the gap with a line.
 const report=summarize(logBaseline?[logBaseline,...primary]:primary,start,end,reset,false);
 if(!primary.length)return report;
 const source=preferLive?'live':log.some(s=>s.source==='log')?'log':null;
 const runs=[],gaps=[];
 const cycle=primary[0].reset;
 const windowStart=Math.min(primary[0].at,Math.max(start,cycle-7*86400000));
 const windowEnd=Math.max(primary.at(-1).at,Math.min(end,cycle));
 if(primary[0].at-windowStart>MAX_READING_GAP)gaps.push({start:windowStart,end:primary[0].at,edge:'start'});
 let run=[];
 for(const sample of primary){
  const previous=run.at(-1);
  if(previous&&sample.at-previous.at>MAX_READING_GAP){
   gaps.push({start:previous.at,end:sample.at});
   runs.push(run);run=[];
  }
  run.push({at:sample.at,used:sample.used});
 }
 runs.push(run);
 if(windowEnd-primary.at(-1).at>MAX_READING_GAP)gaps.push({start:primary.at(-1).at,end:windowEnd,edge:'end'});
 // Compress flat sections without losing their last point or joining gaps.
 const series=runs.map(points=>points.filter((point,i)=>
  i===0||i===points.length-1||point.used!==points[i-1].used||point.used!==points[i+1].used));
 if(logBaseline)series.unshift([{at:logBaseline.at,used:logBaseline.used,source:'log'}]);
 return {...report,source,windowStart,windowEnd,gaps,series,baselineFromLog:!!logBaseline};
}
function aggregate(raw,{now=Date.now(),start=null,end=null,accountId=null,plan=null,timeZone='Asia/Shanghai'}={}){if(!accountId)return {available:false,weekly:[],calendar:[]};timeZone=resolveTimeZone(timeZone);let samples=raw.filter(x=>x&&x.account===accountId&&(!plan||!x.plan||x.plan===plan)&&Number.isFinite(x.at)&&x.at<=now+60000&&Number.isFinite(x.used)&&x.used>=0&&x.used<=100&&Number.isFinite(x.reset)).map(x=>({...x}));// The service sometimes rounds the same reset boundary by one or two seconds.
 const anchors=Number.isFinite(end)?[end]:[];for(const x of [...samples].sort((a,b)=>a.reset-b.reset)){let a=anchors.find(v=>Math.abs(v-x.reset)<=5000);if(a==null){a=x.reset;anchors.push(a)}x.reset=a;}
 const seen=new Set();
 samples=samples.filter(sample=>{
  const key=[sample.at,sample.used,sample.reset,sample.source].join('|');
  if(seen.has(key))return false;
  seen.add(key);return true;
 });
 const today=dayBounds(now,timeZone),calendar=[];
 for(let i=6;i>=0;i--){
  const date=addDays(today.date,-i);
  const from=startForDate(date,timeZone),to=Math.min(startForDate(addDays(date,1),timeZone),now+1);
  calendar.push({date,...quotaObservation(samples,from,to,null)});
 }
 const weekly=[];
 if(Number.isFinite(start)&&Number.isFinite(end)&&end>start){
  for(let day=dayBounds(start,timeZone);day.start<=today.start&&day.start<end;day=dayBounds(day.end,timeZone)){
   const from=Math.max(day.start,start),to=Math.min(day.end,end,now+1);
   if(to>from)weekly.push({date:day.date,windowStart:from,windowEnd:to,...quotaObservation(samples,from,to,end)});
  }
 }
 return {available:true,timeZone,weekly,calendar,today:weekly.find(sample=>sample.date===today.date)||null};
}
module.exports={aggregate,dayStart,summarize,MAX_READING_GAP};
