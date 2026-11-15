const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');

const minute=60000;
const predictionSpan=2*60*minute;
const maxGap=5*minute;
const forecastSpan=window=>Math.min(2*24*60*minute,Math.max(predictionSpan,window.duration*minute/4));

function validWindowKey(key){
 if(typeof key!=='string'||key.length>240)return false;
 try{
  const parts=JSON.parse(key);
  return Array.isArray(parts)&&(parts.length===2||parts.length===3)
   &&typeof parts[0]==='string'&&parts[0].length>0&&Number.isFinite(parts[1])&&parts[1]>0
   &&(parts.length===2||['primary','secondary'].includes(parts[2]))&&JSON.stringify(parts)===key;
 }catch{return false;}
}

function bubbleWindow(windows,selected,now){
 if(selected==='urgent'){
  return windows.filter(w=>w.used!=null&&w.reset>now).sort((a,b)=>b.used-a.used||a.reset-b.reset)[0];
 }
 if(selected)return windows.find(w=>w.key===selected);
 return windows.find(w=>w.limitId==='codex'&&w.duration===10080);
}

function budgetStatus(window,reserve,now){
 if(!Number.isInteger(reserve)||reserve<0||reserve>99||window.used==null||!(window.reset>now))return null;
 const remaining=100-window.used;
 return {reserve,remaining,headroom:remaining-reserve,low:remaining<=reserve};
}

function normalizeWindows(quota){
 const limits=quota?.rateLimitsByLimitId;
 const buckets=new Map(Object.entries(limits&&typeof limits==='object'?limits:{}));
 const fallback=quota?.rateLimits;
 if(fallback&&!buckets.has(fallback.limitId||'codex'))buckets.set(fallback.limitId||'codex',fallback);
 const windows=[];
 for(const [limitId,bucket] of buckets){
  if(!bucket||!limitId)continue;
  for(const role of ['primary','secondary']){
   const window=bucket[role];
   const duration=window?.windowDurationMins;
   if(!Number.isFinite(duration)||duration<=0)continue;
   const duplicate=bucket.primary?.windowDurationMins===bucket.secondary?.windowDurationMins;
   const used=window.usedPercent;
   const reset=window.resetsAt;
   windows.push({
    key:JSON.stringify(duplicate?[limitId,duration,role]:[limitId,duration]),
    limitId,role,duration,plan:bucket.planType??null,
    label:typeof bucket.limitName==='string'?bucket.limitName:null,
    used:Number.isFinite(used)&&used>=0&&used<=100?used:null,
    reset:Number.isFinite(reset)&&reset>0?reset*1000:null
   });
  }
 }
 return windows;
}

function forecast(window,samples,now){
 if(!Number.isFinite(window.used)||window.used<0||window.used>100)return {status:'unknown',reason:'missing-fields'};
 if(window.used===100)return {status:'exhausted'};
 if(!Number.isFinite(window.reset)||!Number.isFinite(window.duration)||window.duration<=0)return {status:'unknown',reason:'missing-fields'};
 if(window.reset<=now)return {status:'unknown',reason:'reset'};
 const oldest=now-Math.min(window.duration*minute,forecastSpan(window));
 const recent=samples.filter(sample=>Number.isFinite(sample.at)&&Number.isFinite(sample.used)&&sample.used>=0
  &&sample.used<=100&&sample.at>=oldest&&sample.at<=now)
  .sort((a,b)=>a.at-b.at);
 if(!recent.length)return {status:'insufficient',reason:'no-readings'};
 const last=recent.at(-1),bounds={from:recent[0].at,to:last.at};
 if(now-last.at>maxGap)return {status:'insufficient',reason:'stale',...bounds};
 // The current official reading and persisted history must describe one state.
 // A failed write must not silently bridge a meter rebase or use another speed.
 if(Math.abs(last.used-window.used)>1e-6)return {status:'insufficient',reason:'history-mismatch',...bounds};
 let first=0,breakReason=null;
 for(let i=1;i<recent.length;i++){
  if(recent[i].used<recent[i-1].used){first=i;breakReason='rebase';}
  else if(recent[i].at-recent[i-1].at>maxGap){first=i;breakReason='gap';}
 }
 const run=recent.slice(first);
 const from=run[0],to=run.at(-1);
 const evidence={from:from.at,to:to.at};
 const span=to.at-from.at,change=to.used-from.used;
 if(span<20*minute||change<3)return {status:'insufficient',reason:breakReason||(span<20*minute?'short-span':'low-usage'),
  missingMinutes:Math.max(0,Math.ceil((20*minute-span)/minute)),missingPp:Math.max(0,3-change),...evidence};
 // Slow weekly consumption needs longer intervals: one-point display rounding
 // can overwhelm every ten-minute change even after many days of valid use.
 // Aim for two points per non-overlapping interval, with at least two intervals.
 const interval=Math.max(10*minute,span*Math.min(.5,2/change));
 const speeds=[];
 let anchor=from;
 for(const sample of run){
  if(sample.at-anchor.at<interval)continue;
  const elapsed=sample.at-anchor.at,delta=sample.used-anchor.used;
  speeds.push([Math.max(0,delta-1)/elapsed,(delta+1)/elapsed]);
  anchor=sample;
 }
 if(speeds.length<2)return {status:'insufficient',reason:'short-span',
  missingMinutes:Math.max(1,Math.ceil((interval-(to.at-anchor.at))/minute)),...evidence};
 speeds.sort((a,b)=>a[1]-b[1]);
 const fast=speeds[Math.ceil((speeds.length-1)*0.8)][1];
 const slow=speeds.map(speed=>speed[0]).sort((a,b)=>a-b)[Math.floor((speeds.length-1)*0.2)];
 const remaining=100-window.used;
 const earliest=to.at+Math.max(0,remaining-1)/fast;
 const latest=slow>0?to.at+(remaining+1)/slow:Infinity;
 const basis={from:from.at,to:to.at,intervalMinutes:interval/minute,method:'recent-pace-v2'};
 if(earliest>=window.reset)return {status:'past-reset',...basis};
 return {
  status:'range',earliest:Math.max(now,earliest),
  latest:latest<window.reset?Math.max(now,latest):null,...basis
 };
}

function openWindowHistory(filename){
 fs.mkdirSync(path.dirname(filename),{recursive:true});
 const db=new DatabaseSync(filename);
 try{
  db.exec(`PRAGMA busy_timeout=3000;
   CREATE TABLE IF NOT EXISTS readings(
    account TEXT NOT NULL, plan TEXT NOT NULL, window TEXT NOT NULL, reset INTEGER NOT NULL,
    at INTEGER NOT NULL, used REAL NOT NULL,
    PRIMARY KEY(account,plan,window,reset,at)
   ) WITHOUT ROWID;
   CREATE INDEX IF NOT EXISTS window_readings_at ON readings(at);
   CREATE TABLE IF NOT EXISTS budget_alerts(
    account TEXT NOT NULL, plan TEXT NOT NULL, window TEXT NOT NULL, reserve INTEGER NOT NULL,
    reset INTEGER NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY(account,plan,window,reserve,reset)
   ) WITHOUT ROWID`);
  const insert=db.prepare('INSERT OR IGNORE INTO readings VALUES(?,?,?,?,?,?)');
  const query=db.prepare('SELECT at,used FROM readings WHERE account=? AND plan=? AND window=? AND reset BETWEEN ? AND ? AND at>=? ORDER BY at');
  const prune=db.prepare('DELETE FROM readings WHERE at<?');
  const pruneAlerts=db.prepare('DELETE FROM budget_alerts WHERE reset<?');
  const claimAlert=db.prepare(`INSERT INTO budget_alerts
   SELECT ?,?,?,?,?,? WHERE NOT EXISTS (
    SELECT 1 FROM budget_alerts WHERE account=? AND plan=? AND window=? AND reserve=? AND reset BETWEEN ? AND ?
   )`);
  let lastPrune=0;
  return {
   save(account,windows,at){
    db.exec('BEGIN IMMEDIATE');
    try{
     for(const w of windows)if(w.used!=null&&w.reset!=null&&w.reset>at){
      insert.run(account,w.plan??'',w.key,w.reset,at,w.used);
     }
     if(at-lastPrune>=24*60*minute){
      prune.run(at-14*24*60*minute);
      pruneAlerts.run(at-14*24*60*minute);
     }
     db.exec('COMMIT');
     if(at-lastPrune>=24*60*minute)lastPrune=at;
    }catch(error){
     db.exec('ROLLBACK');
     throw error;
    }
   },
   read(account,window,now){
    if(window.reset==null)return [];
    return query.all(account,window.plan??'',window.key,window.reset-2000,window.reset+2000,now-forecastSpan(window));
   },
   claimBudgetAlert(account,window,reserve,now){
    if(!budgetStatus(window,reserve,now)?.low)return false;
    const rule=[account,window.plan??'',window.key,reserve];
    return claimAlert.run(...rule,window.reset,now,...rule,window.reset-2000,window.reset+2000).changes===1;
   },
   close(){db.close();}
  };
 }catch(error){
  db.close();
  throw error;
 }
}

module.exports={normalizeWindows,validWindowKey,bubbleWindow,budgetStatus,forecast,openWindowHistory};
