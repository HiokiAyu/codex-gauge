const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-preferences-'));
const oldLocal=process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA=root;
const modulePath=require.resolve('./CodexDashboard/preferences');
const file=path.join(root,'CodexUsageDashboard','preferences.json');
function reload(){
 delete require.cache[modulePath];
 return require(modulePath);
}
try{
 const stats=require('./CodexDashboard/stats');
 const reference=require('./CodexDashboard/seed-owner.json');
 const originalHash=reference.accountHash;
 try{
  reference.accountHash=require('node:crypto').createHash('sha256').update('reference-account').digest('hex');
  assert(Object.values(stats.accountSeeds('different-account','pro')).every(value=>value===null));
  assert(Object.values(stats.accountSeeds('reference-account','plus')).every(value=>value===null));
  assert.equal(stats.accountSeeds('reference-account','pro')['gpt-6.1-sol'],stats.PP_PER_CREDIT['gpt-6.1-sol']);
 }finally{reference.accountHash=originalHash;}
 let prefs=reload();
 assert.equal(prefs.get().trayOnClose,true,'fresh installs collect in the tray after closing');
 assert.equal(prefs.get().bubbleWindow,'urgent');
 assert.equal(prefs.get().timeZone,'system');
 assert.equal(prefs.get().budgetAlerts,true);
 prefs.update({budgetRule:{key:'["codex",300]',reserve:20},onboardingDismissed:true});
 prefs=reload();
 assert.equal(prefs.get().budgets['["codex",300]'],20);
 assert.equal(prefs.get().onboardingDismissed,true);
 assert.throws(()=>prefs.update({budgetRule:{key:'__proto__',reserve:30}}));
 assert.throws(()=>prefs.update({budgetRule:{key:'["codex",300]',reserve:100}}));
 assert.throws(()=>prefs.update({bubbleWindow:'unknown-window'}));
 prefs.update({bubbleWindow:'["codex",300]',budgetAlerts:false});
 prefs.update({projectChange:{action:'save',name:'Work',folder:'C:/work'}});
 const id=prefs.get().projects[0].id;
 prefs.update({projectChange:{action:'attach',id,folder:'D:/moved'}});
 prefs=reload();
 assert.equal(prefs.get().projects[0].roots.length,2);
 prefs.update({budgetRule:{key:'["codex",300]',reserve:null}});
 assert.equal(Object.keys(prefs.get().budgets).length,0);
 const previous=prefs.get();
 fs.mkdirSync(file+'.tmp');
 assert.throws(()=>prefs.update({theme:'light'}));
 assert.equal(prefs.get(),previous,'failed write must leave in-memory settings unchanged');
 fs.rmdirSync(file+'.tmp');
 fs.writeFileSync(file,'\uFEFF'+JSON.stringify({language:'en',theme:'light',seenNews:[]}));
 prefs=reload();
 assert.equal(prefs.get().language,'en','Windows UTF-8 BOM must not discard saved settings');
 assert.equal(prefs.get().timeZone,'Asia/Shanghai','Legacy day boundaries must remain compatible');
 assert.equal(prefs.get().bubbleWindow,null,'existing users keep the weekly floating-ball default');
 assert.equal(prefs.get().trayOnClose,true,'a settings file without the flag uses the default');
 prefs.update({trayOnClose:false});
 assert.equal(reload().get().trayOnClose,false,'preserve an explicit opt-out across upgrades');
 console.log('Passed: persisted settings, legacy defaults, input validation and failed-write atomicity.');
}finally{
 if(oldLocal===undefined)delete process.env.LOCALAPPDATA;
 else process.env.LOCALAPPDATA=oldLocal;
 fs.rmSync(root,{recursive:true,force:true});
}
