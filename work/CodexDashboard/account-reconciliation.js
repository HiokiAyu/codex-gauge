const DAY=86400000;
const SETTLE_MS=6*3600000;
const MIN_DAY_AGE=2*DAY;
const MIN_REVISION_AGE=DAY;
// Small residuals can help investigate model fit, but cannot authorize an update.
const SHADOW_MAX_RESIDUAL=100000;
const SHADOW_MAX_FRACTION=0.00005;
// A matching daily token total is a prerequisite, not proof of subscription
// billing attribution. Never rescale local calls to force this equality.
function reviewAfter(end,tokens,observation){
 if(observation?.tokens!==tokens||!Number.isFinite(observation.observedAt))return null;
 return Math.max(end+MIN_DAY_AGE,observation.observedAt+MIN_REVISION_AGE);
}
function compare(calls,buckets,{now=Date.now(),coverageStart=null,gaps=[],complete=false,fresh=false,liveReadings=[],officialObservations=new Map()}={}){
 const totals=new Map();
 for(const e of calls){
  if(!Number.isFinite(e.time)||e.time>now)continue;
  const day=new Date(e.time).toISOString().slice(0,10);
  const d=totals.get(day)||{tokens:0,unverified:0,retainedTokens:0};
  d.tokens+=e.total_tokens||0;
  if(e.usageVerified===false)d.unverified++;
  if(e.retained)d.retainedTokens+=e.total_tokens||0;
  totals.set(day,d);
 }
 const days=[];
 const localDays=[];
 if(complete&&Number.isFinite(coverageStart)){
  let start=Math.ceil(coverageStart/DAY)*DAY;
  for(;start+DAY<=now;start+=DAY){
   const date=new Date(start).toISOString().slice(0,10);
   const local=totals.get(date)||{tokens:0,unverified:0,retainedTokens:0};
   const unverified=!!local.unverified||gaps.some(g=>g.start<start+DAY&&g.end>=start);
   localDays.push({date,tokens:local.tokens,retainedTokens:local.retainedTokens,unverified,complete:true});
  }
 }
 const coverageByDate=new Map(localDays.map(d=>[d.date,d]));
 for(const b of buckets||[]){const start=Date.parse(b.startDate+'T00:00:00Z'),end=start+DAY;
  if(!Number.isFinite(start)||!Number.isSafeInteger(b.tokens)||b.tokens<0||end>now||!Number.isFinite(coverageStart)||end<=coverageStart)continue;
  const local=totals.get(b.startDate)||{tokens:0,unverified:0,retainedTokens:0},difference=b.tokens-local.tokens;
  const nearMatch=difference>0&&difference<=SHADOW_MAX_RESIDUAL&&difference<=b.tokens*SHADOW_MAX_FRACTION;
  const reviewAt=reviewAfter(end,b.tokens,officialObservations.get(b.startDate));
  let status=!complete||coverageStart>start?'partial':!fresh||end>now-SETTLE_MS?'pending':coverageByDate.get(b.startDate)?.unverified?'unverified':reviewAt===null||now<reviewAt?'provisional':difference===0?(local.retainedTokens?'retained-match':'matched'):nearMatch?'near-match':'mismatch';
  days.push({date:b.startDate,start,end,officialTokens:b.tokens,localTokens:local.tokens,retainedTokens:local.retainedTokens,difference,differencePercent:b.tokens?100*difference/b.tokens:null,status,reviewAt});
 }
 days.sort((a,b)=>a.start-b.start);
 const interval=d=>({start:d.start,end:d.end-1});
 const end=Math.floor(now/DAY)*DAY;
 const start=end-DAY,date=new Date(start).toISOString().slice(0,10);
 const settledAt=end+SETTLE_MS;
 const local=coverageByDate.get(date);
 const day=days.find(d=>d.date===date);
 const readings=liveReadings.filter(r=>r.at>=start&&r.at<end);
 const latest={date,settledAt,reviewAt:day?.reviewAt??null,officialTokens:day?.officialTokens??null,localTokens:local?.tokens??null,
  difference:fresh&&day&&local&&now>=settledAt?day.difference:null,
  liveSamples:readings.length,
  status:!complete||!local?'partial':!fresh?'unavailable':now<settledAt?'settling':day?.status??'missing-official'};
 return {status:!fresh?'pending':days.some(d=>['mismatch','near-match'].includes(d.status))?'mismatch':days.some(d=>d.status==='matched')?'matched':days.some(d=>d.status==='retained-match')?'retained-match':days.some(d=>d.status==='provisional')?'provisional':'pending',
  basis:'UTC',sourceFresh:fresh,checkedAt:now,days,localDays,latest,
  eligibleCoverage:days.filter(d=>d.status==='matched').map(interval),
  exploratoryCoverage:days.filter(d=>['matched','near-match'].includes(d.status)).map(interval)};
}
module.exports={compare,reviewAfter};
