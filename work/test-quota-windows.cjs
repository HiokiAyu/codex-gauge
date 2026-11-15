const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {normalizeWindows,forecast,openWindowHistory,budgetStatus,bubbleWindow,validWindowKey}=require('./CodexDashboard/quota-windows');

const minute=60000;
const now=1_800_000_000_000;
const usage=(windowDurationMins,usedPercent,resetsAt)=>({windowDurationMins,usedPercent,resetsAt});
const short=usage(300,70,(now+30*minute)/1000);
const weekly=usage(10080,31,(now+86400000)/1000);
const windows=normalizeWindows({
 rateLimits:{limitId:'codex',primary:short},
 rateLimitsByLimitId:{codex:{planType:'pro',primary:short,secondary:weekly},
  other:{primary:usage(300,105,null),secondary:usage(300,0,short.resetsAt)}}
});
assert.equal(windows.length,4);
assert.equal(new Set(windows.map(window=>window.key)).size,4);
assert.equal(windows[0].reset,short.resetsAt*1000);
assert.equal(windows[2].used,null);
assert.equal(windows[2].reset,null);
assert.equal(windows[3].used,0);
assert.equal(normalizeWindows({rateLimits:{primary:weekly}})[0].duration,10080);
assert.equal(normalizeWindows({rateLimitsByLimitId:{codex:{secondary:short}}})[0].key,windows[0].key);
assert.equal(bubbleWindow(windows,null,now),windows[1]);
assert.equal(bubbleWindow(windows,'urgent',now),windows[0]);
assert.equal(bubbleWindow(windows,windows[3].key,now),windows[3]);
assert.equal(bubbleWindow(windows,'["other",60]',now),undefined);
assert(windows.every(window=>validWindowKey(window.key)));
assert(!validWindowKey('__proto__'));

const live={...windows[0],used:95};
const samples=Array.from({length:31},(_,index)=>({
 at:now+(index-30)*minute,used:80+Math.floor(index/2)
}));
const result=forecast(live,samples,now);
assert.equal(result.status,'range');
assert(result.earliest>=now&&result.latest>result.earliest&&result.latest<live.reset);
const lowUsage=samples.map((sample,index)=>({...sample,used:Math.floor(index/3)}));
assert.equal(forecast({...live,used:10},lowUsage,now).status,'past-reset');
assert.equal(forecast({...live,used:40,reset:now+360*minute},samples,now).status,'insufficient',
 'Do not apply old speed after the official meter rebases but history has not been written');
assert.equal(forecast({...live,used:40},samples,now).reason,'history-mismatch');
const shortRun=forecast(live,samples.slice(-5),now);
assert.equal(shortRun.reason,'short-span');
assert.equal(shortRun.missingMinutes,16);
assert.equal(shortRun.from,samples.at(-5).at);
assert.equal(shortRun.to,now);
assert.equal(result.from,samples[0].at);
assert.equal(result.to,now);
assert.equal(forecast({...live,reset:null,used:100},samples,now).status,'exhausted');
assert.equal(forecast({...live,reset:now},samples,now).reason,'reset');
assert.equal(forecast(live,[],now).reason,'no-readings');
assert.equal(forecast(live,samples.map(sample=>({...sample,at:sample.at-6*minute})),now).reason,'stale');
assert.equal(forecast({...live,used:10},[...samples.slice(0,-1),{at:now,used:10}],now).reason,'rebase');
const irregular=Array.from({length:6},(_,index)=>({at:now+(index*4-20)*minute,used:90+index}));
assert.equal(forecast(live,irregular,now).missingMinutes,2);
const weeklySlow={...windows[1],used:92,reset:now+48*60*minute};
const slowReadings=Array.from({length:433},(_,index)=>({at:now+(index*5-36*60)*minute,used:80+Math.floor(index/36)}));
const slowForecast=forecast(weeklySlow,slowReadings,now);
assert.equal(slowForecast.status,'range','Weekly low-rate usage must not be permanently restricted to a two-hour history');
assert.equal(slowForecast.from,slowReadings[0].at);
assert(slowForecast.earliest>=now+10*60*minute,'Integer rounding must not dominate weekly estimates through ten-minute bins');
assert.equal(forecast({...live,used:100},samples,now).status,'exhausted');
assert.equal(forecast(live,samples.slice(-5),now).status,'insufficient');
assert.equal(forecast(live,[...samples.slice(0,20),...samples.slice(-5)],now).status,'insufficient');
assert.equal(forecast(live,[...samples.slice(0,-1),{at:now,used:10}],now).status,'insufficient');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-windows-'));
const file=path.join(root,'windows.sqlite');
let db=openWindowHistory(file);
try{
 for(const sample of samples)db.save('account-a',[{...live,used:sample.used}],sample.at);
 for(const sample of slowReadings)db.save('slow-week',[{...weeklySlow,used:sample.used}],sample.at);
 assert.equal(db.read('slow-week',weeklySlow,now).length,slowReadings.length);
 db.save('account-b',[live],now);
 db.save('account-a',[{...live,plan:'other'}],now);
 assert.deepEqual(budgetStatus(live,8,now),{reserve:8,remaining:5,headroom:-3,low:true});
 assert(!db.claimBudgetAlert('account-a',live,4,now));
 assert(!db.claimBudgetAlert('account-a',{...live,reset:now},8,now));
 assert(db.claimBudgetAlert('account-a',live,8,now));
 db.close();
 db=openWindowHistory(file);
 assert.equal(db.read('account-a',live,now).length,31);
 assert.equal(db.read('account-b',live,now).length,1);
 assert.equal(db.read('account-a',{...live,reset:live.reset+1000},now).length,31);
 assert.equal(db.read('account-a',{...live,reset:live.reset+3000},now).length,0);
 assert.equal(db.read('account-a',{...live,plan:'other'},now).length,1);
 assert.equal(db.read('account-a',windows[1],now).length,0);
 assert(!db.claimBudgetAlert('account-a',live,8,now+1000));
 assert(!db.claimBudgetAlert('account-a',{...live,reset:live.reset+2000},8,now+1000));
 assert(!db.claimBudgetAlert('account-a',{...live,used:90},8,now+2000));
 assert(!db.claimBudgetAlert('account-a',live,8,now+3000));
 assert(db.claimBudgetAlert('account-a',live,9,now+3000));
 assert(db.claimBudgetAlert('account-a',{...live,reset:live.reset+300*minute},8,now+3000));
 assert(db.claimBudgetAlert('account-b',live,8,now+3000));
 assert(db.claimBudgetAlert('account-a',{...live,plan:'other'},8,now+3000));
}finally{
 db.close();
 fs.rmSync(root,{recursive:true,force:true});
}
console.log('Passed: quota windows, persisted isolation by account/plan/window/reset, and guarded forecast.');
