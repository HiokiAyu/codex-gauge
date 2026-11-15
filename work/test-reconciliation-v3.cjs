const assert=require('assert'),{compare}=require('./CodexDashboard/account-reconciliation');
const start=Date.parse('2026-11-01T00:00:00Z'),DAY=86400000,calls=[{time:start+1,total_tokens:100},{time:start+DAY-1,total_tokens:200},{time:start+DAY,total_tokens:500}],buckets=[{startDate:'2026-11-01',tokens:300},{startDate:'2026-11-02',tokens:600}];
const opts={now:start+4*DAY,coverageStart:start,complete:true,fresh:true};let r=compare(calls,buckets,opts);assert.equal(r.days[0].status,'matched');assert.equal(r.days[1].status,'mismatch');assert.equal(r.days[1].difference,100);assert.equal(r.eligibleCoverage.length,1);assert.equal(compare(calls,buckets,{...opts,coverageStart:start+1000}).days[0].status,'partial');assert.equal(compare(calls,buckets,{...opts,fresh:false}).eligibleCoverage.length,0);assert.equal(compare(calls,buckets,{...opts,gaps:[{start:start+5,end:start+10}]}).days[0].status,'unverified');assert.equal(compare(calls,buckets,{...opts,now:start+DAY+1000}).days[0].status,'pending');
const close=compare([{time:start+1,total_tokens:488674800}],[{startDate:'2026-11-01',tokens:488689482}],opts);
assert.equal(close.days[0].status,'near-match');
assert.equal(close.eligibleCoverage.length,0);
assert.equal(close.exploratoryCoverage.length,1);
const retained=compare([{...calls[0],retained:true},...calls.slice(1)],buckets,opts);
assert.equal(retained.days[0].localTokens,300);
assert.equal(retained.days[0].retainedTokens,100);
assert.equal(retained.days[0].status,'retained-match');
assert.equal(retained.eligibleCoverage.length,0,'saved requests preserve totals without proving current coverage');
assert.deepEqual(compare(calls,[],{...opts,fresh:false}).localDays[0],
 {date:'2026-11-01',tokens:300,retainedTokens:0,unverified:false,complete:true});
const latestOpts={...opts,now:start+2*DAY+7*3600000,liveReadings:[{at:start+DAY},{at:start+2*DAY}]};
const latest=compare(calls,buckets,latestOpts).latest;
assert.equal(latest.date,'2026-11-02');
assert.equal(latest.status,'mismatch');
assert.equal(latest.liveSamples,1,'midnight readings belong to the new day');
assert.equal(latest.difference,100);
assert.equal(compare(calls,[buckets[0]],latestOpts).latest.status,'missing-official');
assert.equal(compare(calls,buckets,{...latestOpts,fresh:false}).latest.status,'unavailable');
assert.equal(compare(calls,buckets,{...latestOpts,now:start+2*DAY+3600000}).latest.status,'settling');
assert.equal(compare(calls,buckets,{...latestOpts,coverageStart:start+DAY+1}).latest.status,'partial');
assert.equal(compare(calls,[{...buckets[0],tokens:301},{...buckets[1],tokens:500}],latestOpts).latest.status,'matched',
 'an older mismatch cannot mask the latest day');
console.log('Passed: UTC boundaries, exact reconciliation, shadow-only near match, unexplained residual, partial coverage, stale data and unsettled day exclusion.');
