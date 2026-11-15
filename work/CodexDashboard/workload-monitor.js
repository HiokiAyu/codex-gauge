// Fixed workload points never use the adaptive quota coefficients.
const {FROZEN_RATES}=require('./value-meter');
const {createHash}=require('node:crypto');
const {MAX_READING_GAP}=require('./quota');
const DAY=86400000,WINDOW=1800000,GUARD=300000;
const POLICY={version:1,scale:24.561849105242025,minDayPp:2,minEstimatePp:5,minPhasePp:15,minPhaseDays:3,minChange:.15,maxGapDays:14};
const utcDay=at=>new Date(at).toISOString().slice(0,10);
const profileKey=p=>JSON.stringify([p.model,p.effort,p.tier]);
const dayKey=d=>JSON.stringify([profileKey(d),d.date,d.source]);
const referenceVersion=createHash('sha256').update(JSON.stringify([POLICY.scale,FROZEN_RATES])).digest('hex').slice(0,12);

function profile(call){
 const tier={default:'standard',standard:'standard',fast:'fast',priority:'fast'}[call.tier];
 if(!tier||!call.effort||!FROZEN_RATES[call.model])return null;
 return {model:call.model,effort:call.effort,tier};
}
function measure(call){
 const p=profile(call);
 if(!p||call.retained||call.usageVerified===false||call.attributionUnverified)return null;
 const {input_tokens:input,cached_input_tokens:cache,output_tokens:output}=call;
 if(![input,cache,output].every(n=>Number.isSafeInteger(n)&&n>=0)||cache>input)return null;
 const [a,b,c]=FROZEN_RATES[p.model];
 const credit=((input-cache)*a+cache*b+output*c)/1e6;
 if(!(credit>0))return null;
 return {profile:p,key:profileKey(p),credit,input,cache,output,outputCredit:output*c/1e6};
}
function lowerBound(events,at){
 let lo=0,hi=events.length;
 while(lo<hi){const mid=(lo+hi)>>1;if(events[mid].time<at)lo=mid+1;else hi=mid;}
 return lo;
}

function buildDays(calls,samples,{now=Date.now(),gaps=[],coverageStart=null,reconciliation=[]}={}){
 const catalog=new Map(),buckets=new Map(),accountDays=new Map(reconciliation.map(d=>[d.date,d]));
 const events=calls.filter(e=>Number.isFinite(e.time)&&e.time<=now).map(e=>{
  const p=profile(e);
  if(p)catalog.set(profileKey(p),p);
  return {time:e.time,value:measure(e)};
 }).sort((a,b)=>a.time-b.time);
 for(const source of ['live','log']){
  const readings=samples.filter(s=>s.source===source&&Number.isFinite(s.at)&&s.at<=now-GUARD&&Number.isFinite(s.reset)&&s.used>=0&&s.used<=100).sort((a,b)=>a.at-b.at);
  const timeBins=new Map();
  for(let i=0;i<readings.length;i++)timeBins.set(Math.floor(readings[i].at/WINDOW),i);
  const anchors=[...timeBins.values()];
  for(let i=1;i<anchors.length;i++){
   const from=anchors[i-1],to=anchors[i],a=readings[from],b=readings[to];
   const date=utcDay(a.at),duration=b.at-a.at;
   if(!Number.isFinite(coverageStart)||a.at-GUARD<coverageStart||duration<WINDOW/2||duration>WINDOW*1.5||b.used>=100)continue;
   if(utcDay(a.at-GUARD)!==date||utcDay(b.at+GUARD)!==date||b.at+GUARD>=a.reset)continue;
   let continuous=true;
   for(let j=from+1;j<=to;j++){
    const q=readings[j],prev=readings[j-1];
    if(q.used<prev.used||q.at-prev.at>MAX_READING_GAP||Math.abs(q.reset-a.reset)>5000){continuous=false;break;}
   }
   if(!continuous||gaps.some(g=>g.start<=b.at+GUARD&&g.end>=a.at-GUARD))continue;
   const all=events.slice(lowerBound(events,a.at-GUARD),lowerBound(events,b.at+GUARD+1));
   const first=all[0]?.value;
   if(!first||all.some(e=>e.value?.key!==first.key))continue;
   const central=all.filter(e=>e.time>a.at&&e.time<=b.at);
   if(!central.length)continue;
   const guarded=all.filter(e=>e.time>a.at+GUARD&&e.time<=b.at-GUARD);
   const sum=(list,field)=>list.reduce((n,e)=>n+e.value[field],0);
   const k=dayKey({...first.profile,date,source});
   let d=buckets.get(k);
   if(!d){
    const official=accountDays.get(date);
    d={...first.profile,date,source,officialTokens:official?.officialTokens??null,proof:official?.status||'pending',
     start:a.at,end:b.at,windows:0,runs:0,pp:0,credit:0,minCredit:0,maxCredit:0,input:0,cache:0,output:0,outputCredit:0,requests:0};
    buckets.set(k,d);
   }
   const joins=d.windows>0&&d.end===a.at&&Math.abs(d.reset-a.reset)<=5000;
   if(!joins)d.runs++;
   d.end=b.at;d.reset=b.reset;d.windows++;d.pp+=b.used-a.used;d.requests+=central.length;
   // Bound the numerator for readings that can lag within the guard period.
   // Accumulate contiguous windows as runs so shared endpoints cancel.
   d.credit+=sum(central,'credit');
   d.minCredit+=sum(joins?central.filter(e=>e.time<=b.at-GUARD):guarded,'credit');
   if(joins)d.minCredit+=d.lastTrailingCredit;
   d.maxCredit+=sum(joins?all.filter(e=>e.time>a.at+GUARD):all,'credit');
   d.lastTrailingCredit=sum(central.filter(e=>e.time>b.at-GUARD),'credit');
   for(const field of ['input','cache','output','outputCredit'])d[field]+=sum(central,field);
  }
 }
 const days=[...buckets.values()].map(({lastTrailingCredit,reset,...d})=>d);
 return {catalog:[...catalog.values()],days};
}

function estimate(days){
 const sum=key=>days.reduce((n,d)=>n+d[key],0);
 const pp=sum('pp'),credit=sum('credit'),margin=2*sum('runs');
 if(pp<POLICY.minDayPp)return null;
 return {points:credit*POLICY.scale/pp,low:sum('minCredit')*POLICY.scale/(pp+margin),
  high:pp>margin?sum('maxCredit')*POLICY.scale/(pp-margin):null,pp,days:days.length,
  start:days[0].start,end:days.at(-1).end,cacheShare:sum('cache')/Math.max(1,sum('input')),
  outputShare:sum('outputCredit')/credit,inputPerRequest:sum('input')/sum('requests')};
}

function detect(days){
 const n=POLICY.minPhaseDays;
 let compared=0;
 const candidates=[];
 for(let i=n;i<=days.length-n;i++){
  const before=days.slice(i-n,i),after=days.slice(i,i+n);
  const a=estimate(before),b=estimate(after);
  if(a.pp<POLICY.minPhasePp||b.pp<POLICY.minPhasePp)continue;
  if(b.start-a.end>POLICY.maxGapDays*DAY||a.end-a.start>POLICY.maxGapDays*DAY||b.end-b.start>POLICY.maxGapDays*DAY)continue;
   if(Math.abs(a.cacheShare-b.cacheShare)>.05||Math.abs(a.outputShare-b.outputShare)>.10||
   Math.abs(Math.log(b.inputPerRequest/a.inputPerRequest))>Math.log(1.5))continue;
  if(a.high==null||b.high==null)continue;
  compared++;
  const change=b.points/a.points-1;
  if(Math.abs(change)<POLICY.minChange)continue;
  const cheaper=change>0;
  if(cheaper?b.low<=a.high:b.high>=a.low)continue;
  // Require each later day to point in the same direction as the phase.
  if(!after.every(d=>cheaper?estimate([d]).points>a.points:estimate([d]).points<a.points))continue;
  if(!before.every(d=>cheaper?estimate([d]).points<b.points:estimate([d]).points>b.points))continue;
  candidates.push({direction:cheaper?'cheaper':'expensive',change,from:a.end,to:b.start,confirmedAt:b.end,before:a,after:b,
   dates:[...before,...after].map(d=>({date:d.date,officialTokens:d.officialTokens,windows:d.windows,pp:d.pp,
    input:d.input,cache:d.cache,output:d.output,requests:d.requests}))});
 }
 const changes=[];
 for(const candidate of candidates){
  const prior=changes.at(-1);
  if(prior?.direction===candidate.direction&&candidate.from-prior.to<=2*DAY){
   if(Math.abs(Math.log1p(candidate.change))>Math.abs(Math.log1p(prior.change)))changes[changes.length-1]=candidate;
  }else changes.push(candidate);
 }
 return {latest:changes.at(-1)||null,changes,compared};
}

const confirmedDays=days=>days.filter(d=>d.source==='live'&&d.proof==='matched'&&d.pp>=POLICY.minDayPp);
const evidenceFields=['date','officialTokens','start','end','windows','runs','pp','credit','minCredit','maxCredit','input','cache','output','outputCredit','requests'];
const evidenceKey=day=>createHash('sha256').update(JSON.stringify(evidenceFields.map(field=>day[field]))).digest('hex');
function changeEvents(days){
 const groups=new Map();
 for(const day of confirmedDays(days)){
  const key=profileKey(day);
  if(!groups.has(key))groups.set(key,[]);
  groups.get(key).push(day);
 }
 return [...groups.values()].flatMap(series=>{
  series.sort((a,b)=>a.start-b.start);
  const {model,effort,tier}=series[0];
  return detect(series).changes.map(event=>{
   const id=JSON.stringify([model,effort,tier,event.direction,utcDay(event.from),utcDay(event.to)]);
   return {...event,id,model,effort,tier,policyVersion:POLICY.version,referenceVersion};
  });
 });
}

function updateHistory(previous,days,official,{now,fresh,checkedDays}){
 const current=new Map(changeEvents(days).map(event=>[event.id,event]));
 const evidence=new Map(confirmedDays(days).map(day=>[dayKey(day),day]));
 const history=new Map();
 for(const event of previous||[]){
  if(event.confirmedAt<now-365*DAY)continue;
  const officialRevision=fresh&&event.dates.some(day=>{
   const updated=official.get(day.date);
   return day.officialTokens!=null&&Number.isFinite(updated?.officialTokens)&&updated.officialTokens!==day.officialTokens;
  });
  const localRevision=event.dates.some(day=>{
   if(!checkedDays.has(day.date))return false;
   const replacement=evidence.get(dayKey({...event,date:day.date,source:'live'}));
   return !replacement||(day.evidence?day.evidence!==evidenceKey(replacement)
    :['windows','pp','input','cache','output','requests'].some(field=>day[field]!==replacement[field]));
  });
  if(!current.has(event.id)&&event.status==='confirmed'&&(officialRevision||localRevision)){
   history.set(event.id,{...event,status:'revoked',revokedAt:now,reason:officialRevision?'official-revision':'local-evidence-revised'});
  }else history.set(event.id,event);
 }
 for(const [id,event] of current){
  const prior=history.get(id);
  const dates=event.dates.map(day=>({...day,
   evidence:evidenceKey(evidence.get(dayKey({...event,date:day.date,source:'live'})))}));
  history.set(id,{...event,dates,status:'confirmed',recordedAt:prior?.status==='confirmed'?prior.recordedAt??now:now});
 }
 return [...history.values()].sort((a,b)=>b.confirmedAt-a.confirmedAt);
}

function merge(previous,current,reconciliation,{now=Date.now(),coverageStart=null,complete=false,fresh=false,localDays=[],invalidatedDates=[]}={}){
 const currentDays=new Map(reconciliation.map(d=>[d.date,d])),days=new Map();
 const localByDate=new Map(localDays.map(d=>[d.date,d]));
 const invalid=new Set(invalidatedDates);
 const checkedDays=new Set(invalid);
 if(complete&&Number.isFinite(coverageStart)){
  for(const [date,day] of currentDays){
   if(fresh&&!['partial','pending'].includes(day.status)&&Date.parse(date)>=coverageStart)checkedDays.add(date);
  }
  for(const [date,day] of localByDate)if(day.complete)checkedDays.add(date);
 }
 const currentEvidence=new Map(complete?current.days.filter(d=>!invalid.has(d.date)).map(day=>[dayKey(day),day]):[]);
 for(const d of previous?.days||[]){
  const start=Date.parse(d.date+'T00:00:00Z');
  if(start<now-90*DAY||invalid.has(d.date))continue;
  const updated=currentDays.get(d.date);
  if(fresh&&updated&&d.officialTokens!=null&&updated.officialTokens!==d.officialTokens)continue;
  if(checkedDays.has(d.date)){
   const local=localByDate.get(d.date);
   const proof=fresh&&updated&&!['partial','pending'].includes(updated.status)?updated.status
    :local&&(local.unverified||local.retainedTokens||d.officialTokens!==local.tokens)?'unverified':d.proof;
   const replacement=currentEvidence.get(dayKey(d));
   // While the account summary is unavailable, compare current local
   // totals with the previously saved official total for that date.
   if(replacement&&local&&d.proof==='matched'&&['partial','pending'].includes(replacement.proof)){
    currentEvidence.set(dayKey(d),{...replacement,proof,officialTokens:d.officialTokens});
   }
   continue;
  }
  days.set(dayKey(d),d);
 }
 for(const d of currentEvidence.values()){
  const k=dayKey(d),old=days.get(k);
  if(old?.proof==='matched'&&['pending','partial'].includes(d.proof))continue;
  days.set(k,d);
 }
 const list=[...days.values()];
 return {days:list,catalog:complete?current.catalog:previous?.catalog??current.catalog,
  history:updateHistory(previous?.history,list,currentDays,{now,fresh,checkedDays})};
}

function report(evidence,now=Date.now()){
 const groups=new Map(evidence.catalog.map(p=>[profileKey(p),{...p,days:[]}]));
 for(const d of evidence.days){
  const k=profileKey(d);
  if(!groups.has(k))groups.set(k,{model:d.model,effort:d.effort,tier:d.tier,days:[]});
  groups.get(k).days.push(d);
 }
 const rows=[...groups.values()].map(({days,...p})=>{
  days.sort((a,b)=>a.start-b.start);
  const confirmed=confirmedDays(days);
  const indicative=days.filter(d=>d.pp>=POLICY.minDayPp);
  function recentEstimate(series,verified){
   const last=series.at(-1);
   if(!last)return null;
   const recent=series.filter(d=>d.start>=last.start-7*DAY);
   const result=estimate(recent);
   if(result.pp<POLICY.minEstimatePp||result.high==null)return null;
   return {...result,date:last.date,source:last.source,verified};
  }
  const provisional=['live','log'].map(source=>recentEstimate(indicative.filter(d=>d.source===source),false)).filter(Boolean).sort((a,b)=>b.end-a.end)[0];
  const latest=recentEstimate(confirmed,true)||provisional||null;
  const comparison=detect(confirmed);
  const evidenceBySource=['live','log'].map(source=>{
   const series=days.filter(d=>d.source===source);
   return {source,pp:series.reduce((n,d)=>n+d.pp,0),windows:series.reduce((n,d)=>n+d.windows,0)};
  });
  const selected=evidenceBySource.find(s=>s.source===(confirmed.length?'live':latest?.source))||
   evidenceBySource.sort((a,b)=>b.pp-a.pp||b.windows-a.windows)[0];
  return {...p,latest,
   confirmedDays:confirmed.length,matchedLiveDays:days.filter(d=>d.source==='live'&&d.proof==='matched').length,
   windows:selected.windows,observedPp:selected.pp,evidenceSource:selected.source,
   confirmedPp:confirmed.reduce((sum,d)=>sum+d.pp,0),
   comparisonsRequiredDays:2*POLICY.minPhaseDays,
   comparisonsRequiredPp:2*POLICY.minPhasePp,
   compared:comparison.compared,change:comparison.latest};
 });
 rows.sort((a,b)=>Number(!!b.change)-Number(!!a.change)||b.confirmedDays-a.confirmedDays||b.windows-a.windows||a.model.localeCompare(b.model));
 const history=evidence.history??changeEvents(evidence.days).map(event=>({...event,status:'confirmed',recordedAt:now}));
 return {asOf:now,policy:POLICY,referenceVersion,rows,history};
}

module.exports={POLICY,buildDays,merge,report};
