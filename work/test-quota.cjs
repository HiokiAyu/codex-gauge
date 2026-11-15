const assert=require('assert'),q=require('./CodexDashboard/quota');const day=Date.parse('2026-11-05T00:00:00+08:00'),end=day+86400000,account='a',sample=(h,used,reset=end)=>({account,at:day+h*3600000,used,reset});let r=q.summarize([sample(1,24),sample(2,26),sample(5,33)],day,end,end);assert.equal(r.status,'observed');assert.equal(r.delta,9);r=q.summarize([sample(1,24),sample(2,26),sample(3,25),sample(5,33)],day,end,end);assert.equal(r.status,'conflict');assert.equal(r.endpointDelta,9);r=q.summarize([sample(1,24),sample(1.5,25),sample(2,2,end+86400000),sample(3,5,end+86400000)],day,end,null);assert.equal(r.status,'reset');assert.equal(r.segments.length,2);assert.equal(r.segments[0].delta,1);assert.equal(r.segments[1].delta,3);r=q.summarize([sample(1,24)],day,end,end);assert.equal(r.status,'one');let a=q.aggregate([sample(1,24),sample(5,33),{...sample(2,80),account:'other'}],{now:day+6*3600000,start:day-2*3600000,end,accountId:account});assert.equal(a.today.delta,9);assert.equal(a.calendar.at(-1).delta,9);assert.equal(q.aggregate([sample(1,24)],{accountId:null}).available,false);
const mixed=[{...sample(1,0),source:'live'},{...sample(2,1),source:'live'},{...sample(2.1,0),source:'log'},{...sample(3,2),source:'live'}];
const observed=q.summarize(mixed,day,end,end);assert.equal(observed.status,'conflict');assert.equal(observed.sources.live.status,'observed');assert.equal(observed.sources.live.delta,2);assert.equal(observed.sources.log.status,'one');
const falls=q.summarize([{...sample(1,2),source:'live'},{...sample(2,1),source:'live'}],day,end,end);assert.equal(falls.sources.live.status,'conflict');
const options={now:day+3.5*3600000,start:day,end,accountId:account,plan:'pro'};
const preferred=q.aggregate([...mixed,{...sample(2.8,88),source:'live',plan:'other'}],options).today;
assert.equal(preferred.status,'observed','session logs cannot cause a fall in the live curve');
assert.equal(preferred.source,'live');
assert.equal(preferred.delta,2);
assert.equal(preferred.series.length,3,'lines are separated across gaps');
assert.deepEqual(preferred.gaps.map(g=>g.edge),['start',undefined,undefined,'end']);
const fallback=q.aggregate([{...sample(1,0),source:'live'},{...sample(1.1,1),source:'log'},{...sample(1.2,2),source:'log'}],options).today;
assert.equal(fallback.source,'log');
assert.equal(fallback.delta,1,'a lone live reading does not mix with the log baseline');
const exact=q.aggregate([{...sample(1,0),source:'live'},{...sample(1.25,1),source:'live'}],options).today;
assert.equal(exact.series.length,1,'a fifteen-minute interval is still continuous');
const staleReset=q.aggregate([...mixed,{...sample(2.8,70,end-60000),source:'log'}],options).calendar.at(-1);
assert.equal(staleReset.status,'observed','a stale session reset cannot create a phantom cycle');
const oneLive=q.aggregate([{...sample(1,0),source:'live'},{...sample(1.1,70,end-60000),source:'log'},
 {...sample(1.2,71,end-60000),source:'log'}],options).calendar.at(-1);
assert.equal(oneLive.status,'one','stale logs cannot replace an isolated live reading from another cycle');
assert.equal(oneLive.source,'live');
assert.equal(q.aggregate([{...sample(1,2),source:'live'},{...sample(2,1),source:'live'}],options).today.status,'conflict');
const midnightOptions={...options,now:day+6*3600000};
const liveLate=[{...sample(4.5,22),source:'live',plan:'pro'},{...sample(5.5,24),source:'live',plan:'pro'}];
const midnight={...sample(3/3600,16),source:'log',plan:'pro'};
const restored=q.aggregate([midnight,{...sample(4.75,21),source:'log',plan:'pro'},...liveLate],midnightOptions);
assert.equal(restored.today.delta,8,'a same-cycle midnight reading restores usage before live collection resumed');
assert.equal(restored.calendar.at(-1).delta,8);
assert.equal(restored.today.status,'observed','interior log jitter cannot create a live rollback');
assert.equal(restored.today.baselineFromLog,true);
assert.equal(restored.today.first.at,midnight.at);
assert.equal(restored.today.gaps[0].edge,'start','missing live samples remain visible');
assert.deepEqual(restored.today.series[0],[{at:midnight.at,used:16,source:'log'}]);
for(const wrong of [{reset:end-60000},{plan:'other'},{plan:null},{account:'other'},{at:day-1},{at:day+3600000},{used:30}]){
 const report=q.aggregate([{...midnight,...wrong},...liveLate],midnightOptions).today;
 assert.equal(report.delta,2);
 assert.equal(report.baselineFromLog,false);
}
assert.equal(q.aggregate([midnight,{...midnight,used:17},...liveLate],midnightOptions).today.delta,2,
 'conflicting opening values at the same time cannot be used as a baseline');
console.log('Passed: live-first reads, log fallback, exact gap threshold, reset windows, direct falls and account/plan isolation.');
