// Local, account-scoped calibration. Stores numerical telemetry only.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{DatabaseSync}=require('node:sqlite');
const {MAX_READING_GAP}=require('./quota');
const VERSION=3,DAY=86400000;
const POLICY={fitDays:21,halfLifeDays:7,blockMs:3600000,guardMs:300000,minTrain:12,minValidation:6,minTrainPp:10,minValidationPp:5,minSpanMs:2*DAY,priorPp:12,maxStep:.25,improvement:.05};
const INITIAL_FIT={maxMae:.75,maxBiasFraction:.20,maxRateDeviation:.30,minRecentBlocks:3,minRecentPp:3};
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function buildBlocks(events,samples,model,now,gaps=[],coverages=null){
 const groups=new Map();for(const s of samples){if(s.at<now-POLICY.fitDays*DAY||s.at>now-300000||s.used<0||s.used>=100)continue;let key=Math.round(s.reset/60000),group=[...groups.keys()].find(k=>Math.abs(k-key)<=2)??key;if(!groups.has(group))groups.set(group,[]);groups.get(group).push(s)}
 const blocks=[];for(const [reset,ss] of groups){ss.sort((a,b)=>a.at-b.at);const bins=new Map();for(const s of ss)bins.set(Math.floor(s.at/POLICY.blockMs),s);let anchors=[...bins.values()].map(z=>{const r=ss.filter(s=>s.at>z.at-120000&&s.at<=z.at).map(s=>s.used).sort((a,b)=>a-b);return {...z,used:r[Math.floor(r.length/2)],spread:r.at(-1)-r[0]}});
 for(let i=1;i<anchors.length;i++){const a=anchors[i-1],b=anchors[i];if(b.at-a.at>7200000||b.at-a.at<1800000||a.spread>1||b.spread>1||b.used<a.used)continue;
 const interior=ss.filter(s=>s.at>=a.at&&s.at<=b.at);if(interior.some((s,j)=>j&&(s.used<interior[j-1].used||Math.abs(s.reset-interior[j-1].reset)>5000||s.source&&s.at-interior[j-1].at>MAX_READING_GAP)))continue;
 if(gaps.some(g=>g.start<=b.at+POLICY.guardMs&&g.end>=a.at-POLICY.guardMs)||coverages&&!coverages.some(c=>c.start<=a.at-POLICY.guardMs&&c.end>=b.at+POLICY.guardMs))continue;
 const lo=lower(events,a.at-POLICY.guardMs),hi=lower(events,b.at+POLICY.guardMs);let good=true,x=0,tier=null;for(let j=lo;j<hi;j++){const e=events[j];if(e.model!==model||!Number.isFinite(e.credit)||e.credit<=0){good=false;break}const t=e.tier||'assumed-standard';if(tier!==null&&t!==tier){good=false;break}tier=t;if(e.at>a.at&&e.at<=b.at)x+=e.credit}if(!good||x<=0)continue;
 blocks.push({at:b.at,start:a.at,reset,x,y:b.used-a.used,tier});}}
 return blocks.sort((a,b)=>a.at-b.at);
}
function lower(events,t){let l=0,r=events.length;while(l<r){const m=(l+r)>>1;if(events[m].at<t)l=m+1;else r=m}return l}
function metrics(rs,beta){return {mae:rs.reduce((s,r)=>s+Math.abs(r.y-r.x*beta),0)/Math.max(1,rs.length),bias:Math.abs(rs.reduce((s,r)=>s+r.x*beta-r.y,0)),actual:rs.reduce((s,r)=>s+r.y,0),predicted:rs.reduce((s,r)=>s+r.x*beta,0)}}
function evaluate(blocks,current,previous=null,activeReset=null){
 // New candidate is trained only on observations after the previous evaluation.
 const fresh=blocks.filter(b=>!previous||b.start>previous.evaluatedThrough),cut=Math.floor(fresh.length*.7),boundary=fresh.length?Math.floor(fresh[cut].start/DAY)*DAY:0,train=fresh.filter(b=>b.at<boundary-POLICY.guardMs),validation=fresh.filter(b=>b.start>=boundary),trainPp=train.reduce((s,r)=>s+r.y,0),validationPp=validation.reduce((s,r)=>s+r.y,0);
 const coldStart=!(Number.isFinite(current)&&current>0);
 const recent=activeReset==null?validation:validation.filter(r=>Math.abs(r.reset-activeReset)<=2);
 const recentPp=recent.reduce((s,r)=>s+r.y,0),spanMs=fresh.length?fresh.at(-1).at-fresh[0].start:0;
 const needed=(target,actual)=>Math.max(0,target-actual);
 const missing={trainBlocks:needed(POLICY.minTrain,train.length),trainPp:needed(POLICY.minTrainPp,trainPp),
  validationBlocks:needed(POLICY.minValidation,validation.length),validationPp:needed(POLICY.minValidationPp,validationPp),
  recentBlocks:needed(INITIAL_FIT.minRecentBlocks,recent.length),recentPp:needed(INITIAL_FIT.minRecentPp,recentPp),
  spanHours:Math.ceil(needed(POLICY.minSpanMs,spanMs)/3600000)};
 const info={version:VERSION,coldStart,missing,blocks:blocks.length,freshBlocks:fresh.length,trainBlocks:train.length,validationBlocks:validation.length,trainPp,validationPp,status:'collecting',reason:'等待更多独立的单模型、同速度区间',nextRequired:`训练≥${POLICY.minTrain}块/10pp，验证≥${POLICY.minValidation}块/5pp，覆盖≥2天`};
 if(train.length<POLICY.minTrain||validation.length<POLICY.minValidation||trainPp<POLICY.minTrainPp||validationPp<POLICY.minValidationPp||!fresh.length||fresh.at(-1).at-fresh[0].start<POLICY.minSpanMs)return info;
 if(missing.recentBlocks||missing.recentPp)return {...info,reason:'当前额度周期的独立验证不足，继续积累',currentValidationPp:recentPp};
 if(coldStart){
  if(activeReset==null)return {...info,reasonCode:'no-cycle',reason:'等待确认当前额度周期'};
  // Estimate the model's own ratio on earlier blocks, then validate it on
  // untouched later blocks. A zero or missing seed supplies no prior.
  const candidate=trainPp/train.reduce((sum,block)=>sum+block.x,0);
  const passes=rows=>{
   const result=metrics(rows,candidate);
   return result.mae<=INITIAL_FIT.maxMae&&result.bias<=Math.max(1,result.actual*INITIAL_FIT.maxBiasFraction)&&
    Math.abs(result.predicted/result.actual-1)<=INITIAL_FIT.maxRateDeviation;
  };
  const accepted=Number.isFinite(candidate)&&candidate>0&&passes(validation)&&passes(recent);
  return {...info,status:accepted?'accepted':'rejected',reason:accepted?'首个系数通过后续留出验证':'首个系数未通过后续留出验证',
   candidate,coefficient:accepted?candidate:null,newMetrics:metrics(validation,candidate),
   recentNewMetrics:metrics(recent,candidate),currentValidationPp:recentPp,
   evaluatedThrough:validation.at(-1).at,updatedAt:validation.at(-1).at};
 }
 const newest=train.at(-1).at,weight=r=>Math.pow(.5,(newest-r.at)/(POLICY.halfLifeDays*DAY)),sumX=train.reduce((s,r)=>s+r.x*weight(r),0),weightedY=train.reduce((s,r)=>s+r.y*weight(r),0),priorX=POLICY.priorPp/current,raw=(weightedY+POLICY.priorPp)/(sumX+priorX),candidate=Math.max(current*(1-POLICY.maxStep),Math.min(current*(1+POLICY.maxStep),raw)),oldM=metrics(validation,current),newM=metrics(validation,candidate);
 const recentOld=metrics(recent,current),recentNew=metrics(recent,candidate),accepted=newM.mae<=oldM.mae*(1-POLICY.improvement)&&newM.bias<=oldM.bias&&recentNew.mae<=recentOld.mae&&recentNew.bias<=recentOld.bias&&Math.abs(candidate/current-1)>.005;
 return {...info,status:accepted?'accepted':'rejected',reason:accepted?'后续留出数据支持更新':'候选未同时改善留出误差和总量偏差，保留原系数',candidate,coefficient:accepted?candidate:current,oldMetrics:oldM,newMetrics:newM,currentValidationPp:recentPp,recentOldMetrics:recentOld,recentNewMetrics:recentNew,evaluatedThrough:validation.at(-1).at,updatedAt:validation.at(-1).at};
}
function createStore(file,seeds){
 fs.mkdirSync(path.dirname(file),{recursive:true});const db=new DatabaseSync(file);
 db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,account TEXT,at REAL,model TEXT,credit REAL,tier TEXT);
 CREATE INDEX IF NOT EXISTS events_time ON events(account,at);
 CREATE TABLE IF NOT EXISTS samples(id TEXT PRIMARY KEY,account TEXT,at REAL,used REAL,reset REAL,source TEXT);
 CREATE INDEX IF NOT EXISTS samples_time ON samples(account,at);
 CREATE TABLE IF NOT EXISTS coverage(account TEXT,start REAL,end REAL,PRIMARY KEY(account,start));
 CREATE TABLE IF NOT EXISTS gaps(id TEXT PRIMARY KEY,account TEXT,start REAL,end REAL,reason TEXT);
 CREATE INDEX IF NOT EXISTS gaps_time ON gaps(account,end);
 CREATE TABLE IF NOT EXISTS models(account TEXT,model TEXT,version INTEGER,coefficient REAL,history TEXT,report TEXT,PRIMARY KEY(account,model,version));
 CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY,account TEXT,eventId TEXT,changedAt REAL,previous TEXT,reason TEXT);
 CREATE TABLE IF NOT EXISTS shadow(account TEXT PRIMARY KEY,report TEXT);
 CREATE TABLE IF NOT EXISTS policies(account TEXT PRIMARY KEY,signature TEXT);
 CREATE TABLE IF NOT EXISTS account_days(account TEXT,date TEXT,officialTokens REAL,localTokens REAL,difference REAL,status TEXT,measurementVersion TEXT,checkedAt REAL,PRIMARY KEY(account,date));
 CREATE TABLE IF NOT EXISTS official_daily_history(account TEXT,date TEXT,observedAt INTEGER,tokens INTEGER,previousTokens INTEGER,PRIMARY KEY(account,date,observedAt));
 CREATE INDEX IF NOT EXISTS official_daily_observed ON official_daily_history(account,observedAt DESC,date DESC);`);
 const fields={clientVersion:'TEXT',inputTokens:'REAL',cachedTokens:'REAL',outputTokens:'REAL',reasoningTokens:'REAL',totalTokens:'REAL',usageVerified:'INTEGER',deltaMatchesLast:'INTEGER',requestId:'TEXT',measurementVersion:'TEXT',rateVersion:'TEXT',modelSource:'TEXT',compaction:'INTEGER',
  threadId:'TEXT',effort:'TEXT',attributionUnverified:'INTEGER',retainedAt:'REAL',invalidatedAt:'REAL'};
 const existing=new Set(db.prepare('PRAGMA table_info(events)').all().map(c=>c.name));
 for(const [name,type]of Object.entries(fields))if(!existing.has(name))db.exec('ALTER TABLE events ADD COLUMN '+name+' '+type);
 const names=['id','account','at','model','credit','tier',...Object.keys(fields)],upsert=db.prepare(`INSERT INTO events(${names.join(',')}) VALUES(${names.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${names.slice(2).map(n=>n+'=excluded.'+n).join(',')}`);
 const readEvent=db.prepare('SELECT * FROM events WHERE id=?'),archive=db.prepare('INSERT INTO revisions(account,eventId,changedAt,previous,reason) VALUES(?,?,?,?,?)'),remove=db.prepare('DELETE FROM events WHERE id=?');
 const retain=db.prepare('UPDATE events SET retainedAt=? WHERE id=?');
 const invalidate=db.prepare('UPDATE events SET invalidatedAt=?,retainedAt=NULL WHERE id=?');
 const historical=db.prepare(`SELECT * FROM events WHERE account=? AND measurementVersion=? AND at>=? AND at<=?
  AND retainedAt IS NOT NULL AND invalidatedAt IS NULL AND usageVerified=1 ORDER BY at`);
 const lastKnown=db.prepare(`SELECT * FROM events WHERE account=? AND measurementVersion=? AND at>=? AND at<=?
  AND requestId IS NOT NULL AND usageVerified=1 AND invalidatedAt IS NULL ORDER BY at`);
 const invalidated=db.prepare('SELECT at,threadId FROM events WHERE account=? AND measurementVersion=? AND invalidatedAt IS NOT NULL ORDER BY at');
 const migrationFields=new Set(['threadId','effort','attributionUnverified','retainedAt']);
 db.exec('CREATE INDEX IF NOT EXISTS retained_usage_time ON events(account,at) WHERE retainedAt IS NOT NULL OR invalidatedAt IS NOT NULL;');
 const sampleInsert=db.prepare('INSERT OR IGNORE INTO samples VALUES(?,?,?,?,?,?)');
 const lastOfficialTotal=db.prepare('SELECT observedAt,tokens FROM official_daily_history WHERE account=? AND date=? ORDER BY observedAt DESC LIMIT 1');
 const officialTotalInsert=db.prepare('INSERT INTO official_daily_history VALUES(?,?,?,?,?)');
 const officialHistory=db.prepare(`SELECT date,observedAt,tokens,previousTokens,tokens-previousTokens AS difference
  FROM official_daily_history WHERE account=? ORDER BY observedAt DESC,date DESC LIMIT 100`);
 function recordOfficialDailyTotals(account,buckets,observedAt){
  if(!account||!Number.isSafeInteger(observedAt)||!Array.isArray(buckets))return;
  const totals=new Map();
  for(const bucket of buckets){
   const {startDate:date,tokens}=bucket||{};
   if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isSafeInteger(tokens)||tokens<0)continue;
   const parsed=Date.parse(date);
   if(!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==date)continue;
   if(!totals.has(date))totals.set(date,tokens);
   else if(totals.get(date)!==tokens)totals.set(date,null);
  }
  if(!totals.size)return;
  db.exec('BEGIN IMMEDIATE');
  try{
   for(const [date,tokens] of totals){
    if(tokens==null)continue;
    const previous=lastOfficialTotal.get(account,date);
    if(previous&&(previous.observedAt>=observedAt||previous.tokens===tokens))continue;
    officialTotalInsert.run(account,date,observedAt,tokens,previous?.tokens??null);
   }
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
 const lastFit=new Map(),cache=new Map(),ingestedRevisions=new Map();
 const requestKey=(account,id)=>hash([account,'request',id].join('|'));
 // The ledger retains numeric request evidence even after a rollout disappears.
 // A later contradiction stays recorded separately and disqualifies that ID.
 function ingest(account,calls,samples,creditWeight,now,gaps,coverageStart,completeScan,measurementVersion,rateVersion,callsRevision,invalidRequests){
  const inputRevision=callsRevision==null||calls.some(event=>event.time>now+60000)?null:
   JSON.stringify([callsRevision,completeScan,coverageStart,measurementVersion,rateVersion,gaps,invalidRequests]);
  const unchanged=inputRevision!==null&&ingestedRevisions.get(account)===inputRevision;
  const io={eventRowsCompared:0,eventRowsWritten:0,eventRowsRemoved:0,eventRowsRetained:0,eventRowsInvalidated:0,
   eventRowsCorrected:0,sampleRowsWritten:0};
  let revised=false;const keep=new Set();db.exec('BEGIN');
  try{
   const policy=JSON.stringify([VERSION,measurementVersion,rateVersion]),oldPolicy=db.prepare('SELECT signature FROM policies WHERE account=?').get(account);
   if(oldPolicy&&oldPolicy.signature!==policy)revised=true;
   if(oldPolicy?.signature!==policy)db.prepare('INSERT OR REPLACE INTO policies VALUES(?,?)').run(account,policy);
   if(completeScan&&Number.isFinite(coverageStart)&&coverageStart<=now){
    const overlap=db.prepare('SELECT start,end FROM coverage WHERE account=? AND start<=? AND end>=?').all(account,now,coverageStart);
    db.prepare('DELETE FROM coverage WHERE account=? AND start<=? AND end>=?').run(account,now,coverageStart);
    db.prepare('INSERT INTO coverage VALUES(?,?,?)').run(account,Math.min(coverageStart,...overlap.map(x=>x.start)),Math.max(now,...overlap.map(x=>x.end)));
    db.prepare('DELETE FROM gaps WHERE account=? AND end>=?').run(account,coverageStart);
   }
   for(const g of gaps){if(!Number.isFinite(g.start)||!Number.isFinite(g.end)||g.end<g.start)continue;const id=hash([account,g.threadId,g.start,g.end,g.reason].join('|'));db.prepare('INSERT OR IGNORE INTO gaps VALUES(?,?,?,?,?)').run(id,account,g.start,g.end,g.reason||'unverified');}
   const invalidIds=new Set(invalidRequests.map(id=>requestKey(account,id)));
   for(const id of unchanged?[]:invalidIds){
    const old=readEvent.get(id);
    if(!old||old.invalidatedAt!=null)continue;
    archive.run(account,id,now,JSON.stringify(old),'request-evidence-invalidated');
    invalidate.run(now,id);revised=true;io.eventRowsInvalidated++;
   }
   for(const e of unchanged?[]:calls){
    if(!Number.isFinite(e.time)||e.time>now+60000)continue;
    const id=e.requestId?requestKey(account,e.requestId):hash([account,e.threadId,e.time,e.model,e.input_tokens,e.cached_input_tokens,e.output_tokens,e.total_tokens].join('|'));
    if(invalidIds.has(id))continue;
    keep.add(id);const rawCredit=creditWeight(e),credit=e.usageVerified===false||e.attributionUnverified?null:Number.isFinite(rawCredit)&&rawCredit>0?rawCredit:null;
    const record={id,account,at:e.time,model:e.model||'unknown',credit,tier:e.tier==null?'assumed-standard':['default','standard'].includes(e.tier)?'standard':e.tier,
     clientVersion:e.clientVersion||null,inputTokens:e.input_tokens??null,cachedTokens:e.cached_input_tokens??null,outputTokens:e.output_tokens??null,reasoningTokens:e.reasoning_output_tokens??null,totalTokens:e.total_tokens??null,
     usageVerified:e.usageVerified==null?null:Number(e.usageVerified),deltaMatchesLast:e.deltaMatchesLast==null?null:Number(e.deltaMatchesLast),requestId:e.requestId?hash(e.requestId):null,
     measurementVersion,rateVersion,modelSource:e.modelSource||'legacy-context',compaction:Number(!!e.compaction),
     threadId:e.threadId??null,effort:e.effort??null,attributionUnverified:Number(!!e.attributionUnverified),retainedAt:null,invalidatedAt:null};
    io.eventRowsCompared++;
    const old=readEvent.get(id);if(old&&names.every(n=>old[n]===record[n]))continue;
    if(old){
     const corrected=names.some(n=>old[n]!==record[n]&&(!migrationFields.has(n)||old[n]!=null&&n!=='retainedAt'));
     if(corrected){archive.run(account,id,now,JSON.stringify(old),'event-or-rate-corrected');revised=true;io.eventRowsCorrected++;}
    }
    upsert.run(...names.map(n=>record[n]));
    io.eventRowsWritten++;
   }
   // Anonymous counters can be superseded by request records. Only verified
   // requests with stable IDs survive disappearance from a complete scan.
   if(!unchanged&&completeScan&&Number.isFinite(coverageStart))for(const old of db.prepare('SELECT * FROM events WHERE account=? AND at>=? AND at<=?').all(account,coverageStart,now)){
    if(keep.has(old.id)||old.invalidatedAt!=null||old.retainedAt!=null)continue;
    if(old.requestId&&old.usageVerified===1){retain.run(now,old.id);revised=true;io.eventRowsRetained++;continue;}
    archive.run(account,old.id,now,JSON.stringify(old),'superseded-by-complete-scan');remove.run(old.id);revised=true;io.eventRowsRemoved++;
   }
   for(const s of samples){if(s.account!==account||!Number.isFinite(s.at)||s.at>now+60000||!Number.isFinite(s.reset)||!Number.isFinite(s.used)||s.used<0||s.used>100)continue;
    const id=hash([account,s.at,s.used,s.reset,s.source].join('|'));io.sampleRowsWritten+=sampleInsert.run(id,account,s.at,s.used,s.reset,s.source||'log').changes;
   }
   // Retain prior generations for audit. Invalidate only the current derived fit.
   if(revised){db.prepare('DELETE FROM models WHERE account=? AND version=?').run(account,VERSION);db.prepare('DELETE FROM shadow WHERE account=?').run(account);}
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e}
  if(inputRevision!==null)ingestedRevisions.set(account,inputRevision);
  if(revised){cache.delete(account);lastFit.delete(account);}
  return io;
 }
 function collect({account,calls,samples,creditWeight,callsRevision=null,gaps=[],coverageStart=null,completeScan=false,now=Date.now(),measurementVersion='request-ledger-v3',rateVersion='reference-rates-2026-11-11',invalidRequests=[]}){
  return ingest(account,calls,samples,creditWeight,now,gaps,coverageStart,completeScan,measurementVersion,rateVersion,callsRevision,invalidRequests);
 }
 function readLedgerEvidence(account,since,until,measurementVersion,calls,{completeScan=true}={}){
  if(!Number.isFinite(since)||!Number.isFinite(until))return {retainedCalls:[],invalidatedGaps:[],invalidatedDates:[]};
  // A legacy counter can mirror a retained request. Exclude ambiguous
  // history rather than summing both representations or guessing its owner.
  const anonymous=calls.filter(c=>!c.requestId&&Number.isFinite(c.time));
  const anonymousThreads=new Set(),anonymousDays=new Set();
  for(const call of anonymous)for(const boundary of [call.time-120000,call.time+120000]){
   const day=Math.floor(boundary/DAY);
   anonymousThreads.add(JSON.stringify([call.threadId,day]));
   anonymousDays.add(day);
  }
  const currentIds=new Set();
  if(!completeScan)for(const c of calls)if(c.requestId)currentIds.add(requestKey(account,c.requestId));
  const saved=(completeScan?historical:lastKnown).all(account,measurementVersion,since,until);
  const retainedCalls=saved.filter(e=>Number.isSafeInteger(e.totalTokens)&&e.totalTokens>0
   &&!currentIds.has(e.id)&&(e.threadId
   ?!anonymousThreads.has(JSON.stringify([e.threadId,Math.floor(e.at/DAY)]))
   :!anonymousDays.has(Math.floor(e.at/DAY)))).map(e=>({
   threadId:e.threadId,time:e.at,model:e.model==='unknown'?null:e.model,effort:e.effort,
   tier:e.tier==='assumed-standard'?null:e.tier,clientVersion:e.clientVersion,
   input_tokens:e.inputTokens,cached_input_tokens:e.cachedTokens,output_tokens:e.outputTokens,
   reasoning_output_tokens:e.reasoningTokens,total_tokens:e.totalTokens,usageVerified:true,
   attributionUnverified:e.attributionUnverified==null?!!e.compaction&&e.model==='unknown':!!e.attributionUnverified,
   compaction:!!e.compaction,retained:true
  }));
  const invalidatedGaps=[],invalidatedDates=new Set();
  for(const e of invalidated.all(account,measurementVersion)){
   const start=e.at-120000,end=e.at+120000;
   for(const at of [start,end])invalidatedDates.add(new Date(at).toISOString().slice(0,10));
   if(end>=since&&start<=until)invalidatedGaps.push({threadId:e.threadId,start,end,reason:'conflicting-request'});
  }
  return {retainedCalls,invalidatedGaps,invalidatedDates:[...invalidatedDates].sort()};
 }
 function update({account,calls,samples,creditWeight,reset,seedCoefficients=seeds,callsRevision=null,gaps=[],coverageStart=null,completeScan=false,fitReady=true,now=Date.now(),measurementVersion='request-ledger-v3',rateVersion='reference-rates-2026-11-11',accountCoverage=[],reconciliationStatus='pending',reconciliationDays=[],exploratoryCoverage=[],historicalSamples=[],invalidRequests=[],ingestion=null}){
  if(!account)return {coefficients:{...seedCoefficients},models:[],policy:POLICY,status:'no-account'};
  ingestion??=collect({account,calls,samples,creditWeight,callsRevision,gaps,coverageStart,completeScan,now,measurementVersion,rateVersion,invalidRequests});
  if(completeScan&&Number.isFinite(coverageStart)){
   // Invalidate previously matched days when the local evidence changes even
   // during an official usage outage. The saved total remains the reference.
   const saved=db.prepare("SELECT date,officialTokens FROM account_days WHERE account=? AND status='matched' AND measurementVersion=?").all(account,measurementVersion);
   const local=db.prepare(`SELECT COALESCE(sum(CASE WHEN invalidatedAt IS NULL THEN totalTokens END),0) tokens,
    COALESCE(sum(usageVerified=0 OR invalidatedAt IS NOT NULL OR retainedAt IS NOT NULL),0) uncertain
    FROM events WHERE account=? AND measurementVersion=? AND rateVersion=? AND at>=? AND at<?`);
   const freshDays=new Set(reconciliationDays.filter(d=>!['partial','pending'].includes(d.status)).map(d=>d.date));
   for(const d of saved){
    const start=Date.parse(d.date+'T00:00:00Z'),end=start+DAY;
    if(start<coverageStart||end>now||freshDays.has(d.date))continue;
    const total=local.get(account,measurementVersion,rateVersion,start,end);
    const hasGap=gaps.some(g=>g.start<end&&g.end>=start);
    if(total.tokens===d.officialTokens&&!total.uncertain&&!hasGap)continue;
    reconciliationDays=[...reconciliationDays,{...d,localTokens:total.tokens,
     difference:d.officialTokens-total.tokens,status:'unverified'}];
   }
  }
  db.exec('BEGIN');try{for(const d of reconciliationDays){if(!/^\d{4}-\d{2}-\d{2}$/.test(d.date)||!Number.isSafeInteger(d.officialTokens)||!Number.isSafeInteger(d.localTokens))continue;
   const old=db.prepare('SELECT * FROM account_days WHERE account=? AND date=?').get(account,d.date);
   if(old&&old.officialTokens===d.officialTokens&&old.localTokens===d.localTokens&&old.difference===d.difference&&old.status===d.status&&old.measurementVersion===measurementVersion)continue;
   if(['pending','partial'].includes(d.status)&&(!old||old.officialTokens===d.officialTokens))continue;
   if(old&&old.status==='matched'&&(old.officialTokens!==d.officialTokens||old.localTokens!==d.localTokens||d.status!=='matched'||old.measurementVersion!==measurementVersion)){
    archive.run(account,'day:'+d.date,now,JSON.stringify(old),'reconciled-day-revised');db.prepare('DELETE FROM models WHERE account=? AND version=?').run(account,VERSION);db.prepare('DELETE FROM shadow WHERE account=?').run(account);cache.delete(account);lastFit.delete(account);
   }
   db.prepare('INSERT OR REPLACE INTO account_days VALUES(?,?,?,?,?,?,?,?)').run(account,d.date,d.officialTokens,d.localTokens,d.difference,d.status,measurementVersion,now);
  }db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
  const signature=JSON.stringify([fitReady,reconciliationStatus,accountCoverage,exploratoryCoverage,gaps,measurementVersion,rateVersion,seedCoefficients]);
  if(!cache.has(account)||now-(lastFit.get(account)||0)>=60000||cache.get(account).signature!==signature){
   const events=db.prepare(`SELECT at,model,CASE WHEN invalidatedAt IS NULL AND retainedAt IS NULL THEN credit END AS credit,tier,clientVersion
    FROM events WHERE account=? AND at>=? AND measurementVersion=?
    AND (rateVersion=? OR retainedAt IS NOT NULL OR invalidatedAt IS NOT NULL) ORDER BY at`).all(account,now-90*DAY,measurementVersion,rateVersion),
    allGaps=db.prepare('SELECT start,end FROM gaps WHERE account=? AND end>=? ORDER BY start').all(account,now-90*DAY),
    localCoverage=db.prepare('SELECT start,end FROM coverage WHERE account=? AND end>=? ORDER BY start').all(account,now-90*DAY),
    qs=db.prepare('SELECT at,used,reset,source FROM samples WHERE account=? AND at>=? ORDER BY at').all(account,now-90*DAY),coefficients={...seedCoefficients},reports=[];
   const matchedDays=db.prepare("SELECT date, officialTokens FROM account_days WHERE account=? AND status='matched' AND measurementVersion=?").all(account,measurementVersion);
   const dayTotals=db.prepare(`SELECT COALESCE(sum(totalTokens),0) tokens,
    COALESCE(sum(usageVerified=0 OR invalidatedAt IS NOT NULL OR retainedAt IS NOT NULL),0) unverified
    FROM events WHERE account=? AND measurementVersion=? AND rateVersion=? AND at>=? AND at<?`);
   const persistedCoverage=[];
   for(const d of matchedDays){
    const start=Date.parse(d.date+'T00:00:00Z'),end=start+DAY;
    if(start<now-POLICY.fitDays*DAY||allGaps.some(g=>g.start<end&&g.end>=start))continue;
    const day=dayTotals.get(account,measurementVersion,rateVersion,start,end);
    if(!day.unverified&&day.tokens===d.officialTokens)persistedCoverage.push({start,end:end-1});
   }
   const intersect=intervals=>localCoverage.flatMap(a=>intervals.map(b=>({start:Math.max(a.start,b.start),end:Math.min(a.end,b.end)}))).filter(c=>c.end>c.start);
   const strictCoverage=new Map([...accountCoverage,...persistedCoverage].map(d=>[d.start,d]));
   const coverages=intersect([...strictCoverage.values()]);
   const liveSamples=qs.filter(s=>s.source==='live');
   const recentLiveSamples=liveSamples.filter(s=>s.at>=now-POLICY.fitDays*DAY);
   const reconciledLiveSamples=recentLiveSamples.filter(s=>coverages.some(c=>c.start<=s.at&&s.at<=c.end)).length;
   const recentCallsByModel=new Map();
   if(recentLiveSamples.length){
    const first=recentLiveSamples[0].at,last=recentLiveSamples.at(-1).at;
    for(const event of events)if(event.at>=first&&event.at<=last&&event.credit!=null){
     recentCallsByModel.set(event.model,(recentCallsByModel.get(event.model)||0)+1);
    }
   }
   for(const [model,seed] of Object.entries(seedCoefficients)){
    const stored=db.prepare('SELECT * FROM models WHERE account=? AND model=? AND version=?').get(account,model,VERSION),history=stored?JSON.parse(stored.history):[];
    let coefficient=stored?.coefficient??seed,report;
    if(!fitReady)report={...evaluate([],coefficient),status:'paused',reason:'日志读取未完成',reasonCode:'scan'};
    else if(!coverages.length)report={...evaluate([],coefficient),status:'paused',reason:'等待账户日汇总对账',reasonCode:'reconciliation'};
    else {
     const candidates=buildBlocks(events,liveSamples,model,now,allGaps,coverages);
     const blocks=Number.isFinite(coefficient)?candidates:candidates.filter(b=>['standard','default','fast','priority'].includes(b.tier));
     report=evaluate(blocks,coefficient,history.at(-1),Number.isFinite(reset)?Math.round(reset/60000):null);
     if(!blocks.length)report.reasonCode='live-samples';
    }
    if(report.evaluatedThrough){history.push(report);if(report.status==='accepted')coefficient=report.coefficient;db.prepare('INSERT OR REPLACE INTO models VALUES(?,?,?,?,?,?)').run(account,model,VERSION,coefficient,JSON.stringify(history.slice(-100)),JSON.stringify(report));}
    const requestsWithReadings=recentCallsByModel.get(model)||0;
    const provisional=fitReady&&requestsWithReadings?buildBlocks(events,liveSamples,model,now,allGaps,localCoverage):[];
    const candidateEvidence={blocks:provisional.length,positiveBlocks:provisional.filter(b=>b.y>0).length,
     pp:provisional.reduce((sum,b)=>sum+b.y,0),
     callsInLiveRange:requestsWithReadings};
    coefficients[model]=coefficient;reports.push({model,seed,coefficient,...report,candidateEvidence,lastEvaluation:report.evaluatedThrough?report:stored?JSON.parse(stored.report):null,updates:history.filter(h=>h.status==='accepted').length,history:history.slice(-5)});
   }
   const savedShadow=db.prepare('SELECT report FROM shadow WHERE account=?').get(account),previousShadow=savedShadow?JSON.parse(savedShadow.report):null;
   const lastShadowEvaluation=previousShadow?.evaluatedThrough?previousShadow:previousShadow?.lastEvaluation;
   const shadow=require('./mixed-calibration').analyze(events,qs,coefficients,{now,gaps:allGaps,coverage:fitReady?coverages:[],evaluatedThrough:lastShadowEvaluation?.evaluatedThrough||0});
   const historicalShadow=require('./mixed-calibration').analyze(events,historicalSamples,coefficients,{now,gaps:allGaps,coverage:fitReady?intersect(exploratoryCoverage):[],source:'log'});
   if(!shadow.evaluatedThrough&&lastShadowEvaluation)shadow.lastEvaluation={...lastShadowEvaluation,lastEvaluation:undefined};
   db.prepare('INSERT OR REPLACE INTO shadow VALUES(?,?)').run(account,JSON.stringify(shadow));
   cache.set(account,{signature,coefficients,models:reports,shadow,historicalShadow,events:events.length,samples:qs.length,reconciledLiveSamples,gaps:allGaps.length,coverageIntervals:localCoverage.length,reconciledIntervals:coverages.length,fitReady,policy:POLICY,version:VERSION,refreshedAt:now,reconciliationStatus,measurementVersion,rateVersion});lastFit.set(account,now);
  }
  return {...cache.get(account),signature:undefined,ingestion};
 }
 function readLiveSamples(account,since){
  return db.prepare("SELECT at,used,reset,source FROM samples WHERE account=? AND at>=? AND source='live' ORDER BY at").all(account,since);
 }
 return {collect,update,readLedgerEvidence,readLiveSamples,recordOfficialDailyTotals,
  readOfficialDailyHistory:account=>officialHistory.all(account),close:()=>db.close()};
}

module.exports={VERSION,createStore,buildBlocks,evaluate,POLICY};
