const assert=require('assert'),L=require('./CodexDashboard/request-ledger');
const u=n=>({input_tokens:n,cached_input_tokens:0,cache_write_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:n});
const req=(id,n,time=1000,extra={})=>({requestId:id,owner:'a',time,model:'gpt-6.1-sol',modelSource:'turn-context',effort:'max',tier:'default',rawUsage:u(n),...u(n),...extra});
const event=(n,time=1100,extra={})=>({...u(n),time,model:'gpt-6.1-sol',effort:'max',tier:'default',usageVerified:true,...extra});
const row={id:'a',accountId:'account-a'},st=(events=[],requests=[],compactions=[])=>({meta:{id:'a'},events,requests,compactions:new Set(compactions),gaps:[],samples:[]});
let r=L.reconcile([[row,st([event(100)],[req('r1',100)])]]);assert.equal(r.records[0][1].events.length,1);assert.equal(r.records[0][1].events[0].source,'request-ledger');assert.equal(r.records[0][1].events[0].effort,'max');
r=L.reconcile([[row,st([event(100)],[req('r1',100),req('c1',40,1200)],['c1'])],[row,st([event(100)],[req('r1',100),req('c1',40,1200)],['c1'])]]);assert.equal(r.records[0][1].events.reduce((n,e)=>n+e.total_tokens,0),140);assert.equal(r.diagnostics.compactions,1);assert.equal(r.records[0][1].events[1].model,null);assert(r.records[0][1].events[1].attributionUnverified);
r=L.reconcile([[row,st([event(40,1300)],[req('c1',40,1200,{modelSource:'request'})],['c1'])]]);assert.equal(r.records[0][1].events.length,1);assert.equal(r.records[0][1].events[0].model,'gpt-6.1-sol');
r=L.reconcile([[row,st([event(100,1100),event(100,2100)],[req('r1',100,1000),req('r2',100,2000)])]]);assert.equal(r.records[0][1].events.length,2,'same size is not same request');
r=L.reconcile([[row,st([event(100,500000,{cumulativeFingerprint:'same'})],[req('slow',100,1000,{cumulativeFingerprint:'same'})])]]);assert.equal(r.records[0][1].events.length,1,'delayed mirror uses cumulative identity');
r=L.reconcile([[row,st([event(100,500000,{cumulativeFingerprint:'inherited-plus-current'})],[req('slow',100,1000,{cumulativeFingerprint:'own-thread-only'})])]]);assert.equal(r.records[0][1].events.length,1,'resumed totals can differ; ordered request mirror remains one charge');
r=L.reconcile([[row,st([event(100),event(101)],[req('r1',100),req('r1',101)])]]);assert.equal(r.records[0][1].events.length,0);assert.equal(r.diagnostics.conflicts,1);assert.equal(r.records[0][1].gaps.length,1);
r=L.reconcile([[row,st([],[req('parent',100,1000,{owner:'parent'})])]]);assert.equal(r.records[0][1].events.length,0,'inherited request excluded');
r=L.reconcile([[row,st([event(200,1100,{usageVerified:false})],[req('r1',100)])]]);assert.equal(r.records[0][1].events.length,1);assert.equal(r.diagnostics.unresolved,1,'unmatched aggregate is not added twice');
const manyRequests=[],manyMirrors=[];
for(let i=0;i<2000;i++){
 const cumulativeFingerprint='counter-'+i,time=1000+i*1000;
 manyRequests.push(req('bulk-'+i,100,time,{cumulativeFingerprint}));
 manyMirrors.push(event(100,time+500000,{cumulativeFingerprint}));
 // The same cumulative identity may have two delayed mirrors.
 if(i%100===0)manyMirrors.push(event(100,time+600000,{cumulativeFingerprint}));
}
r=L.reconcile([[row,st(manyMirrors,manyRequests)]]);
assert.equal(r.records[0][1].events.length,2000);
assert.equal(r.records[0][1].events.reduce((sum,e)=>sum+e.total_tokens,0),200000);
assert.equal(new Set(r.records[0][1].events.map(e=>e.requestId)).size,2000);
console.log('Passed: request/mirror dedup, inherited replay, compaction recovery, unknown attribution, same-size requests, conflicting IDs, ambiguous counters, bulk delayed cumulative mirrors.');
