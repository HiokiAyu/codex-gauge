const assert=require('node:assert/strict');
const {buildDays,merge,report}=require('./CodexDashboard/workload-monitor');
const DAY=86400000,MINUTE=60000,start=Date.parse('2026-11-01T00:00:00Z');
const reset=start+7*DAY,now=reset+DAY;
function scenario(afterFactor=0.5,{source='live',mixed=false,unmatched=false,cacheShift=false}={}){
 const calls=[],samples=[],reconciliation=[];
 for(let day=0;day<6;day++){
  const date=new Date(start+day*DAY).toISOString().slice(0,10),at=start+day*DAY+8*60*MINUTE+20*MINUTE;
  let total=0;
  for(let i=0;i<=18;i++)samples.push({at:at+i*10*MINUTE,reset,used:day*12+2*Math.floor(i/3),source});
  for(let i=0;i<6;i++)for(let j=0;j<2*(day>=3?afterFactor:1);j++){
   const input=100000000,output=input/100;
   calls.push({time:at+(14+i*30+j)*MINUTE,model:'gpt-6.1-sol',effort:'high',tier:'default',
    input_tokens:input,cached_input_tokens:cacheShift&&day>=3?input:input/2,output_tokens:output,usageVerified:true});
   total+=input+output;
   if(mixed)calls.push({...calls.at(-1),effort:'xhigh'});
  }
  reconciliation.push({date,officialTokens:total,status:unmatched&&day>=3?'mismatch':'matched'});
 }
 return {calls,samples,reconciliation};
}
function run(fixture){
 const evidence=buildDays(fixture.calls,fixture.samples,{now,coverageStart:start,reconciliation:fixture.reconciliation});
 return {evidence,row:report(evidence,now).rows[0]};
}
let {evidence,row}=run(scenario());
assert.equal(row.confirmedDays,6);
assert.equal(row.change.direction,'expensive');
assert(Math.abs(row.change.change+.5)<1e-10);
assert(row.change.from<row.change.to&&row.change.to<row.change.confirmedAt);
assert.equal(evidence.days[0].runs,1,'adjacent windows share one rounding margin');
assert.equal(evidence.days[0].pp,12);
assert.equal(run(scenario(2)).row.change.direction,'cheaper');
assert.equal(run(scenario(1)).row.change,null);
assert.equal(run(scenario(.5,{mixed:true})).row.windows,0);
assert.equal(run(scenario(.5,{unmatched:true})).row.change,null);
assert.equal(run(scenario(.5,{cacheShift:true})).row.change,null);
const logged=run(scenario(.5,{source:'log'})).row;
assert.equal(logged.change,null);
assert.equal(logged.latest.source,'log');
assert.equal(logged.latest.verified,false);
const revised={...scenario().reconciliation[0],officialTokens:0,status:'mismatch'};
const saved=merge(evidence,{catalog:evidence.catalog,days:[]},[revised],{now,coverageStart:start+DAY,complete:true,fresh:true});
assert.equal(report(saved,now).rows[0].confirmedDays,5,'official revision revokes archived evidence');
assert.equal(report(saved,now).rows[0].change,null);
const archived=merge(null,evidence,scenario().reconciliation,{now,coverageStart:start,complete:true,fresh:true});
assert.equal(archived.history.length,1);
assert.equal(archived.history[0].status,'confirmed');
assert.equal(archived.history[0].dates.length,6);
assert(archived.history[0].referenceVersion);
const rerun=merge(JSON.parse(JSON.stringify(archived)),evidence,scenario().reconciliation,
 {now:now+1000,coverageStart:start,complete:true,fresh:true});
assert.equal(rerun.history.length,1);
assert.equal(rerun.history[0].recordedAt,archived.history[0].recordedAt);
const revoked=merge(rerun,{catalog:evidence.catalog,days:[]},[revised],
 {now:now+2000,coverageStart:start+DAY,complete:true,fresh:true});
assert.equal(revoked.history[0].status,'revoked');
assert.equal(report(revoked,now).history[0].reason,'official-revision');
const offline=merge(rerun,{catalog:evidence.catalog,days:[]},[revised],
 {now:now+2000,coverageStart:start,complete:false,fresh:false});
assert.equal(offline.history[0].status,'confirmed');
const options={now:now+3000,coverageStart:start,complete:true,fresh:false};
const noOriginalCalls=scenario().calls.filter(c=>c.time>=start+DAY);
const offlineNow=buildDays(noOriginalCalls,scenario().samples,options);
const localDays=scenario().reconciliation.map((d,i)=>({date:d.date,complete:true,
 tokens:i===0?0:d.officialTokens,unverified:false,retainedTokens:0}));
const invalidLocal=merge(rerun,offlineNow,[],{...options,localDays});
assert.equal(invalidLocal.history[0].status,'revoked','a checked local loss withdraws the event even offline');
assert.equal(invalidLocal.history[0].reason,'local-evidence-revised');
assert.equal(report(invalidLocal,now).rows[0].change,null);
const merelyOffline=merge(rerun,buildDays(scenario().calls,scenario().samples,options),[],
 {...options,localDays:localDays.map((d,i)=>i===0?{...d,tokens:scenario().reconciliation[0].officialTokens}:d)});
assert.equal(merelyOffline.history[0].status,'confirmed','an intact local rescan and saved official totals remain valid');
const restored=merge(invalidLocal,evidence,scenario().reconciliation,{...options,fresh:true});
assert.equal(restored.history[0].status,'confirmed','a change must pass comparison again after evidence returns');
console.log('Passed: confirmed cheaper and more expensive regimes, bounded change date, rounding, mixed profiles, usage-mix drift, provisional evidence and archived revisions.');
