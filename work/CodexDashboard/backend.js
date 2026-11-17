const resetNews=require('./reset-news').createFeed({cacheFile:require('path').join(process.env.LOCALAPPDATA||require('os').tmpdir(),'CodexUsageDashboard','reset-news-cache.json')});
const http=require('http'),fs=require('fs'),path=require('path'),os=require('os'),{spawn}=require('child_process'),readline=require('readline');
const appInfo=require('./app-info.json');
const {resolveTimeZone}=require('./time-zone');
const appDataDirectory=path.join(process.env.LOCALAPPDATA||os.tmpdir(),'CodexUsageDashboard');
const updates=require('./update-client').createService({directory:__dirname,dataDirectory:appDataDirectory});
let storagePreparation=null,storageError=null;
try{storagePreparation=require('./storage-backup').prepareStorage(appDataDirectory,appInfo.version);}
catch(error){storageError=error.code||'backup-failed';}
const preferences=require('./preferences');
const {DatabaseSync}=require('node:sqlite'); const stats=require('./stats');const source=require('./data-root');const root=preferences.get().dataRoot||source.defaultRoot;const sourceSuffix=source.cacheSuffix(root);stats.setRoot(root,!!sourceSuffix);
stats.useCheckpoints(path.join(process.env.LOCALAPPDATA||os.tmpdir(),'CodexUsageDashboard','log-checkpoints'+sourceSuffix+'.sqlite'));
const {normalizeWindows,forecast,bubbleWindow,openWindowHistory}=require('./quota-windows');
const {getProjectReport,projectCsv}=require('./project-ledger');
const managed=process.argv.includes('--managed');
let windowHistory=null,windowHistoryError=null;
try{if(!storageError)windowHistory=openWindowHistory(path.join(appDataDirectory,'window-history.sqlite'));}
catch(error){windowHistoryError=error.code||'open-failed';}
let calibrationStore=null,calibrationError=null;
if(storageError){calibrationError='storage-unavailable';windowHistoryError='storage-unavailable';}
try{
 if(!storageError)calibrationStore=require('./calibration').createStore(path.join(appDataDirectory,'calibration'+sourceSuffix+'.sqlite'),stats.PP_PER_CREDIT);
}catch(error){calibrationError=error.message;}
if(!storageError&&!calibrationError&&!windowHistoryError){
 try{storagePreparation?.finalize?.();}
 catch(error){storageError=error.code||'backup-finalize-failed';}
}
if(process.argv.includes('--storage-probe')){
 console.log(JSON.stringify({healthy:!storageError&&!calibrationError&&!windowHistoryError}));
 calibrationStore?.close();
 windowHistory?.close();
 stats.useCheckpoints(null);
 process.exit(storageError||calibrationError||windowHistoryError?1:0);
}
const workloadMonitor=require('./workload-monitor');
let workloadCache=null;
const hydratedNamespaces=new Set();
const pendingQuotaSamples=new Map();
const sampleKey=sample=>JSON.stringify([sample.at,sample.used,sample.reset,sample.source]);
function calibrationSamples(namespace,accountId,plan){
 if(!pendingQuotaSamples.has(namespace)){
  const queue=new Map(observed.filter(sample=>sample.account===accountId&&sample.plan===plan)
   .map(sample=>[sampleKey(sample),sample]));
  pendingQuotaSamples.set(namespace,queue);
 }
 return [...pendingQuotaSamples.get(namespace).values()].map(sample=>({...sample,account:namespace}));
}
function rememberQuotaSample(sample){
 const namespace=sample.account+'|'+sample.plan;
 pendingQuotaSamples.get(namespace)?.set(sampleKey(sample),sample);
}
const quotaFile=path.join(process.env.LOCALAPPDATA||os.tmpdir(),'CodexUsageDashboard','quota-history.jsonl');let observed=[];try{let fd=fs.openSync(quotaFile,'r');try{let st=fs.fstatSync(fd),n=Math.min(st.size,20*1024*1024),buf=Buffer.alloc(n);fs.readSync(fd,buf,0,n,st.size-n);let lines=buf.toString('utf8').split('\n');if(st.size>n)lines.shift();for(let line of lines){try{let q=JSON.parse(line);if(q.at>Date.now()-90*86400000)observed.push(q)}catch{}}}finally{fs.closeSync(fd)}}catch{}function saveQuota(q){let r=q?.rateLimitsByLimitId?.codex||q?.rateLimits;if(!q?.rateLimitsByLimitId?.codex&&r?.limitId!=='codex')return;let w=[r?.primary,r?.secondary].find(x=>x?.windowDurationMins===10080);if(!q?.accountId||!w?.resetsAt||!Number.isFinite(w.usedPercent))return;let x={at:Date.now(),used:w.usedPercent,reset:w.resetsAt*1000,account:q.accountId,plan:r.planType||'unknown',source:'live'};observed.push(x);rememberQuotaSample(x);observed=observed.filter(v=>v.at>Date.now()-90*86400000);try{fs.mkdirSync(path.dirname(quotaFile),{recursive:true});fs.appendFileSync(quotaFile,JSON.stringify(x)+'\n');state.quotaHistoryWriteError=null;}catch(error){state.quotaHistoryWriteError=error.code||'write-failed';}}const port=Number(process.argv[2]);let state={quota:null,account:null,updated:null,error:'正在连接 Codex…'}, pending=new Map(),next=1, app;
function request(method,params={}){
 const child=app;
 if(!child?.stdin?.writable)return Promise.reject(Error('Codex 接口未连接'));
 return new Promise((resolve,reject)=>{
  const id=next++;
  function fail(error){
   if(!pending.has(id))return;
   clearTimeout(timer);
   pending.delete(id);
   reject(error);
  }
  const timer=setTimeout(()=>fail(Error('连接超时')),12000);
  pending.set(id,{resolve,reject,t:timer});
  try{child.stdin.write(JSON.stringify({id,method,params})+'\n',error=>{if(error)fail(error);});}
  catch(error){fail(error);}
 });
}
function codexPath(){let base=path.join(process.env.LOCALAPPDATA||'', 'OpenAI','Codex','bin');try{let candidates=fs.readdirSync(base,{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>path.join(base,x.name,'codex.exe')).filter(x=>fs.existsSync(x)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);return candidates[0]||'codex'}catch{return 'codex'}}
let appReady=false,reconnectTimer=null,disconnectApp=null;
function retryConnection(){
 if(reconnectTimer)return;
 reconnectTimer=setTimeout(()=>{reconnectTimer=null;connect();},15000);
}
async function connect(){
 if(app)return;
 let child;
 function disconnected(message){
  if(child!==app)return;
  app=null;
  appReady=false;
  disconnectApp=null;
  state.error=message;
  publishTrayStatus();
  for(const p of pending.values()){clearTimeout(p.t);p.reject(Error(message));}
  pending.clear();
  retryConnection();
 }
 try{
  child=spawn(codexPath(),['app-server'],{windowsHide:true,stdio:['pipe','pipe','ignore']});
  app=child;
  disconnectApp=message=>{disconnected(message);child.kill();};
  child.on('error',()=>disconnected('无法启动 Codex 接口'));
  child.on('exit',()=>disconnected('Codex 接口已断开'));
  child.stdin.on('error',()=>{});
  readline.createInterface({input:child.stdout}).on('line',line=>{
   if(app!==child)return;
   try{
    const result=JSON.parse(line),p=pending.get(result.id);
    if(!p)return;
    pending.delete(result.id);
    clearTimeout(p.t);
    if(result.error)p.reject(Error(result.error.message));else p.resolve(result.result);
   }catch{}
  });
  await request('initialize',{clientInfo:{name:'local_usage_dashboard',title:'Local Usage Dashboard',version:appInfo.version},capabilities:null});
  child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  appReady=true;
  void collectInBackground();
 }catch(error){
  if(child){disconnected('连接失败：'+error.message);child.kill();}
  else{state.error='连接失败：'+error.message;publishTrayStatus();retryConnection();}
 }
}
let refreshInFlight=null,lastActivityAttempt=0,consecutiveQuotaFailures=0,accountGeneration=0;
const activityInterval=60000;
function refresh(){
 if(!appReady)return Promise.resolve();
 if(!refreshInFlight)refreshInFlight=sampleAccount().finally(()=>{refreshInFlight=null;});
 return refreshInFlight;
}

async function sampleAccount(){
 const child=app;
 try{
  let quota=await request('account/rateLimits/read');
  if(child!==app)return;
  const accountId=quota?.accountId||null;
  applyQuota(quota);
  if(!accountId||Date.now()-lastActivityAttempt<activityInterval)return;
  lastActivityAttempt=Date.now();
  const activityGeneration=accountGeneration;
  try{
   const activity=await request('account/usage/read');
   const observedAt=Date.now();
   if(child!==app)return;
   // Usage has no guaranteed account identifier. Check who owns it before publishing.
   quota=await request('account/rateLimits/read');
   if(child!==app)return;
   applyQuota(quota);
   if(accountGeneration!==activityGeneration)return;
   state.account=activity;
   state.accountDataAccount=accountId;
   state.accountUpdated=Date.now();
   state.accountError=null;
   if(calibrationStore){
    try{
     calibrationStore.recordOfficialDailyTotals(accountId,activity?.dailyUsageBuckets,observedAt);
     state.officialDailyHistoryError=false;
    }catch{state.officialDailyHistoryError=true;}
   }
  }catch{
   if(child===app)state.accountError='账户活动暂不可用';
  }
 }catch(error){
  if(child!==app)return;
  state.error='额度刷新失败：'+error.message;
  publishTrayStatus();
  if(++consecutiveQuotaFailures>=2){
   consecutiveQuotaFailures=0;
   disconnectApp?.(state.error);
  }
 }
}

function applyQuota(quota){
 if(snapshotScope(state.quota)!==snapshotScope(quota)){
  accountGeneration++;
  state.account=null;
  state.accountDataAccount=null;
  state.officialDailyHistoryError=false;
  state.accountUpdated=null;
  state.accountError='账户活动暂不可用';
  lastActivityAttempt=0;
 }
 state.quota=quota;
 const now=Date.now();
 state.updated=new Date(now).toISOString();
 state.error=null;
 consecutiveQuotaFailures=0;
 saveQuota(quota);
 if(windowHistory&&quota?.accountId){
  try{windowHistory.save(quota.accountId,normalizeWindows(quota),now);windowHistoryError=null;}
  catch(error){windowHistoryError=error.code||'write-failed';}
 }
 publishTrayStatus();
 checkBudgetAlerts();
}

function publishTrayStatus(){
 if(!managed)return;
 const now=Date.now();
 const windows=state.quota?.accountId?normalizeWindows(state.quota):[];
 const chosen=bubbleWindow(windows,preferences.get().bubbleWindow,now);
 const remaining=window=>window?.used!=null&&window.reset>now?100-window.used:null;
 console.log('STATUS '+JSON.stringify({remaining:remaining(chosen),duration:chosen?.duration??null,timeZone:resolveTimeZone(preferences.get().timeZone),
  updated:state.updated,connected:!state.error&&!!state.quota?.accountId}));
}

async function refreshNews(){
 if(preferences.get().resetNewsEnabled===false)return;
 try{
  await resetNews.refresh();
  if(!managed||preferences.get().resetNewsEnabled===false)return;
  const {unseen,aliases}=require('./reset-news').findUnseen(resetNews.snapshot(),preferences.get().seenNews);
  if(!unseen.length)return;
  const enabled=preferences.get().alerts;
  preferences.update({seenNews:aliases});
  if(enabled)console.log('NEWS '+JSON.stringify({count:unseen.length}));
 }catch{
  // Leave unrecorded notices eligible on the next pass if preferences could not be saved.
 }
}

function checkBudgetAlerts(){
 const now=Date.now();
 const prefs=preferences.get();
 const account=state.quota?.accountId;
 if(!managed||!windowHistory||!account||prefs.budgetAlerts===false||state.error
  ||!state.updated||now-Date.parse(state.updated)>65000)return;
 const triggered=[];
 try{
  for(const window of normalizeWindows(state.quota)){
   const reserve=prefs.budgets[window.key];
   if(windowHistory.claimBudgetAlert(account,window,reserve,now)){
    triggered.push({label:window.label||window.limitId,duration:window.duration,
     remaining:100-window.used,reserve});
   }
  }
 }catch(error){windowHistoryError=error.code||'alert-write-failed';}
 if(triggered.length)console.log('BUDGET '+JSON.stringify(triggered));
}
function readUsage(file){let fd;try{fd=fs.openSync(file,'r');let pos=fs.fstatSync(fd).size,rest='';while(pos>0){let n=Math.min(pos,131072);pos-=n;let b=Buffer.alloc(n);fs.readSync(fd,b,0,n,pos);let a=(b.toString('utf8')+rest).split('\n');rest=a.shift();for(let i=a.length-1;i>=0;i--){if(!a[i].includes('token_count'))continue;try{let x=JSON.parse(a[i]);if(x.payload?.type==='token_count'&&x.payload.info?.total_token_usage){let i=x.payload.info;return {total:i.total_token_usage,context:i.last_token_usage?.input_tokens??null,window:i.model_context_window??null,at:x.timestamp??null}} }catch{}}}}catch{}finally{if(fd!==undefined)fs.closeSync(fd)}return null}
const usageCache=new Map();
function usage(file){
 if(!file)return null;
 try{
  const stat=fs.statSync(file);
  const signature=JSON.stringify([stat.dev,stat.ino,stat.birthtimeMs,stat.mtimeMs,stat.ctimeMs,stat.size]);
  const cached=usageCache.get(file);
  if(cached?.signature===signature)return cached.value;
  const value=readUsage(file);
  usageCache.delete(file);
  usageCache.set(file,{signature,value});
  if(usageCache.size>4096)usageCache.delete(usageCache.keys().next().value);
  return value;
 }catch{usageCache.delete(file);return null;}
}
let threadError=null;function threads(){threadError=null;let db;try{db=new DatabaseSync(path.join(root,'state_5.sqlite'),{readOnly:true});let index={};try{for(const line of fs.readFileSync(path.join(root,'session_index.jsonl'),'utf8').split('\n')){try{let v=JSON.parse(line);index[v.id]=v.thread_name}catch{}}}catch{};const cwd=db.prepare('PRAGMA table_info(threads)').all().some(column=>column.name==='cwd')?'t.cwd':'NULL';let rows=db.prepare('select '+cwd+' as cwd, t.id, t.rollout_path, t.title, t.name, t.first_user_message, t.model, t.reasoning_effort, t.tokens_used, t.archived, t.updated_at, t.agent_nickname, t.agent_role, t.creator_account_id, e.parent_thread_id, p.title as parent_title from threads t left join thread_spawn_edges e on e.child_thread_id=t.id left join threads p on p.id=e.parent_thread_id order by t.updated_at desc').all();return rows.map(r=>{let title=(r.name||r.title||index[r.id]||r.first_user_message||(r.parent_thread_id?('子任务 · '+(r.agent_nickname||r.agent_role||r.parent_title||r.id.slice(0,8))):'')||'').replace(/\s+/g,' ').trim();if(!title||title==='New thread'||title==='新建对话')title='未命名 · '+r.id.slice(0,8);const selectedPath=sourceSuffix&&!source.inside(root,r.rollout_path)?null:r.rollout_path;let detail=usage(selectedPath);return {id:r.id,cwd:r.cwd,title:title.slice(0,85),model:r.model,effort:r.reasoning_effort,reasoning_effort:r.reasoning_effort,rollout_path:selectedPath,accountId:r.creator_account_id||null,archived:!!r.archived,updated:r.updated_at,tokens:r.tokens_used,usage:detail?.total||null,context:detail?.context??null,contextWindow:detail?.window??null,contextAt:detail?.at??null}})}catch(e){threadError=e.message;return []}finally{db?.close()}}
let snapshotInFlight=null,latestSnapshot=null;
function snapshotScope(quota){
 const plan=quota?.rateLimitsByLimitId?.codex?.planType??quota?.rateLimits?.planType??null;
 return JSON.stringify([quota?.accountId??null,plan]);
}

function rebuildSnapshot(forceScan=false){
 if(!snapshotInFlight){
  const input={...state};
  const generation=accountGeneration;
  snapshotInFlight=buildSnapshot(input,generation,forceScan).then(payload=>{
   if(payload&&generation===accountGeneration)latestSnapshot={generation,payload,at:Date.now()};
  }).finally(()=>{snapshotInFlight=null;});
 }
 return snapshotInFlight;
}

async function getCurrentSnapshot(){
 if(latestSnapshot?.generation!==accountGeneration){
  await rebuildSnapshot();
  if(latestSnapshot?.generation!==accountGeneration)await rebuildSnapshot();
 }
 const current=latestSnapshot?.generation===accountGeneration?latestSnapshot:null;
 if(!current)throw Error('Account changed during snapshot');
 return current;
}

async function snapshot(){
 const current=await getCurrentSnapshot();
 const {projectThreads,...payload}=current.payload;
 // Only connection diagnostics can be newer than the underlying data snapshot.
 const resetNewsState=preferences.get().resetNewsEnabled===false
  ?{status:'disabled',items:[],recent:[],sources:[]}:resetNews.snapshot();
 return {...payload,error:state.error,backgroundError:state.backgroundError,
  quotaHistoryWriteError:state.quotaHistoryWriteError,windowHistoryError,snapshotAt:current.at,resetNews:resetNewsState,
  nativeAlerts:managed,appInfo,updates:updates.status(),storage:{
   healthy:!storageError&&!calibrationError&&!windowHistoryError&&!stats.checkpointStatus()&&!state.quotaHistoryWriteError,
   backupAvailable:!!storagePreparation?.backup}};
}

async function collectInBackground(forceScan=false){
 try{
  await refresh();
  if(state.quota?.accountId&&!state.error)await rebuildSnapshot(forceScan);
  state.backgroundError=null;
 }catch(error){
  state.backgroundError=error.message;
 }
}

async function buildSnapshot(responseState,generation,forceScan){
 const rows=threads();
 const r=responseState.quota?.rateLimitsByLimitId?.codex||responseState.quota?.rateLimits;
 const w=[r?.primary,r?.secondary].find(x=>x?.windowDurationMins===10080);
 const dayMs=86400000;
 const accountCoverageStart=Math.floor(Date.now()/dayMs)*dayMs-require('./calibration').POLICY.fitDays*dayMs;
 await stats.scan(rows,w?.resetsAt?w.resetsAt*1000-10080*60000:null,accountCoverageStart,{force:forceScan});
 let sourceAvailable=!threadError;try{source.validate(root)}catch{sourceAvailable=false}
 if(generation!==accountGeneration)return null;
 const end=w?.resetsAt?w.resetsAt*1000:null,start=end?end-10080*60000:null;
 const accountId=responseState.quota?.accountId||null,plan=r?.planType||'unknown';
 const namespace=accountId+'|'+plan;
 if(calibrationStore&&accountId&&!hydratedNamespaces.has(namespace)){
  try{
   const saved=calibrationStore.readLiveSamples(namespace,Date.now()-90*dayMs);
   const seen=new Set(observed.filter(q=>q.account===accountId&&q.plan===plan).map(q=>JSON.stringify([q.at,q.used,q.reset,q.source])));
   for(const q of saved){
    const key=JSON.stringify([q.at,q.used,q.reset,q.source]);
    if(!seen.has(key))observed.push({...q,account:accountId,plan});
    seen.add(key);
   }
   hydratedNamespaces.add(namespace);
  }catch(error){responseState.quotaHistoryReadError=error.code||'read-failed';}
 }
 const seeds=stats.accountSeeds(accountId,plan,rows.map(row=>row.model));
 const context={accountId,plan,samples:observed,coefficients:seeds,timeZone:preferences.get().timeZone};
 let detail=stats.compute(rows,start,end,w?.usedPercent,context),completeScan=!detail.scanning&&!detail.errors&&sourceAvailable,calibration=null;
 const o=accountId&&!detail.scanning?stats.observations(rows.filter(r=>r.accountId===accountId)):{calls:[],samples:[],gaps:[],invalidRequests:[]};
 const now=Date.now();
 const measure={account:namespace,calls:o.calls,callsRevision:o.revision,creditWeight:stats.creditWeight,
  now,coverageStart:detail.coverageStart,completeScan,measurementVersion:stats.MEASUREMENT_VERSION,
  rateVersion:'included-speed-2.5-reference-2026-11-11',invalidRequests:o.invalidRequests};
 let ingestion=null,retainedCalls=[],invalidatedGaps=[],invalidatedDates=[];
 if(calibrationStore&&accountId){try{
  const sampleBatch=calibrationSamples(namespace,accountId,plan);
  ingestion=calibrationStore.collect({...measure,samples:sampleBatch,gaps:o.gaps});
  for(const sample of sampleBatch)pendingQuotaSamples.get(namespace).delete(sampleKey(sample));
  ({retainedCalls,invalidatedGaps,invalidatedDates}=calibrationStore.readLedgerEvidence(namespace,
   Math.min(detail.coverageStart??Infinity,detail.dayStart,start??Infinity)-120000,now,
   stats.MEASUREMENT_VERSION,o.calls,{completeScan}));
  calibrationError=null;
 }catch(e){calibrationError=e.message;}}
 const gaps=[...o.gaps],additionalGaps=[];
 for(const g of invalidatedGaps){
  if(!gaps.some(x=>x.threadId===g.threadId&&x.start<=g.start&&x.end>=g.end)){
   gaps.push(g);additionalGaps.push(g);
  }
 }
 const calls=retainedCalls.length?[...o.calls,...retainedCalls]:o.calls;
 const officialDays=accountId&&responseState.accountDataAccount===accountId?responseState.account?.dailyUsageBuckets:[];
 let officialObservations=new Map(),officialHistoryError=!!accountId&&(!calibrationStore||!!responseState.officialDailyHistoryError);
 if(accountId&&calibrationStore){
  try{
   officialObservations=calibrationStore.readOfficialObservations(accountId,new Date(now-90*86400000).toISOString().slice(0,10));
  }catch{officialHistoryError=true;}
 }
 const reconciliation=require('./account-reconciliation').compare(calls,officialDays,{
  now,coverageStart:detail.coverageStart,gaps,complete:completeScan,officialObservations,
  liveReadings:observed.filter(q=>q.account===accountId&&q.plan===plan&&q.source==='live'),
  fresh:!!accountId&&!responseState.error&&!responseState.accountError&&responseState.accountDataAccount===accountId&&now-(responseState.accountUpdated||0)<120000
 });
 if(calibrationStore&&ingestion&&!calibrationError){try{
  calibration=calibrationStore.update({...measure,ingestion,reset:end,gaps,
   fitReady:completeScan&&!responseState.error,seedCoefficients:seeds,
   accountCoverage:reconciliation.eligibleCoverage,reconciliationStatus:reconciliation.status,
   officialObservations,
   reconciliationDays:reconciliation.sourceFresh?reconciliation.days:[],
   exploratoryCoverage:reconciliation.exploratoryCoverage,historicalSamples:o.samples.filter(s=>s.plan===plan)});
 }catch(e){calibrationError=e.message;}}
 if(calibration||retainedCalls.length||invalidatedGaps.length){
  detail=stats.compute(rows,start,end,w?.usedPercent,{...context,now,retainedCalls,invalidatedGaps:additionalGaps,
   coefficients:calibration?.coefficients||seeds});
 }
 if(calibration)calibration.rates=stats.RATES;
 if(accountId&&typeof plan==='string'&&plan!=='unknown'){
  const scope=require('crypto').createHash('sha256').update(JSON.stringify([accountId,plan,root,stats.MEASUREMENT_VERSION,workloadMonitor.POLICY.version])).digest('hex').slice(0,24);
  const activityKey=JSON.stringify([reconciliation.days.filter(d=>d.status!=='pending')
   .map(d=>[d.date,d.officialTokens,d.localTokens,d.status]),invalidatedDates,completeScan,reconciliation.sourceFresh]);
  const evidenceRevised=ingestion&&(ingestion.eventRowsRetained||ingestion.eventRowsInvalidated||ingestion.eventRowsRemoved||ingestion.eventRowsCorrected);
  if((completeScan||invalidatedDates.length||reconciliation.sourceFresh)
    &&(!workloadCache||workloadCache.scope!==scope||workloadCache.activityKey!==activityKey||now-workloadCache.at>=300000||evidenceRevised)){
   const file=path.join(process.env.LOCALAPPDATA||os.tmpdir(),'CodexUsageDashboard','workload-'+scope+'.json');
   const samples=[...o.samples,...observed].filter(q=>q.account===accountId&&q.plan===plan);
   const current=workloadMonitor.buildDays(calls,samples,{now,gaps,coverageStart:detail.coverageStart,reconciliation:reconciliation.days});
   let previous=null,previousText=null;
   try{previousText=fs.readFileSync(file,'utf8');previous=JSON.parse(previousText);}catch{}
   const comparedDates=new Set(reconciliation.days.map(d=>d.date));
   const olderOfficial=(responseState.accountDataAccount===accountId?responseState.account?.dailyUsageBuckets||[]:[])
    .filter(d=>!comparedDates.has(d.startDate)).map(d=>({date:d.startDate,officialTokens:d.tokens,status:'partial'}));
   const evidence=workloadMonitor.merge(previous,current,[...reconciliation.days,...olderOfficial],
    {now,coverageStart:detail.coverageStart,complete:completeScan,fresh:reconciliation.sourceFresh,
     localDays:reconciliation.localDays,invalidatedDates});
   const report=workloadMonitor.report(evidence,now);
   try{
    const serialized=JSON.stringify(evidence);
    if(serialized!==previousText){
     fs.mkdirSync(path.dirname(file),{recursive:true});
     fs.writeFileSync(file+'.tmp',serialized);
     fs.renameSync(file+'.tmp',file);
    }
   }catch(error){report.persistenceError=true;}
   workloadCache={scope,at:now,activityKey,report};
  }
  if(workloadCache?.scope===scope)detail.workloadMonitor=workloadCache.report;
 }
 if(accountId){
  try{
   reconciliation.officialHistory=calibrationStore?.readOfficialDailyHistory(accountId)??[];
   reconciliation.officialHistoryError=officialHistoryError;
  }catch{reconciliation.officialHistoryError=true;}
 }
 detail.reconciliation=reconciliation;detail.calibration=calibration;detail.calibrationError=calibrationError;detail.checkpointError=stats.checkpointStatus();detail.scanMetrics=stats.scanMetrics();detail.sourceError=!sourceAvailable;if(!sourceAvailable)detail.errors=(detail.errors||0)+1;
 const quotaWindows=normalizeWindows(responseState.quota).map(window=>{
  let samples=[];
  if(accountId&&windowHistory){
   try{samples=windowHistory.read(accountId,window,now);}
   catch(error){windowHistoryError=error.code||'read-failed';}
  }
  return {...window,forecast:forecast(window,samples,now)};
 });
 const ownRows=accountId?rows.filter(row=>row.accountId===accountId):[];
 const projectThreads=ownRows.map(row=>({id:row.id,projectFolder:stats.originalWorkingDirectory(row)}));
 const publicThreads=ownRows.map(({cwd,...row})=>row);
 return {...responseState,quotaWindows,dataSource:{path:root,isDefault:!sourceSuffix},threads:publicThreads,projectThreads,detail};
}

const staticFiles=new Map([
 ['/',{file:'dashboard.html',type:'text/html; charset=utf-8'}],
 ['/experience.css',{file:'experience.css',type:'text/css; charset=utf-8'}],
 ['/experience.js',{file:'experience.js',type:'application/javascript; charset=utf-8'}]
]);
for(const entry of staticFiles.values())entry.body=fs.readFileSync(path.join(__dirname,entry.file));
const origin='http://127.0.0.1:'+port;

function json(res,body,status=200){
 res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
 res.end(JSON.stringify(body));
}

async function savePreferences(req,res){
 if(req.headers.origin!==origin||!String(req.headers['content-type']).startsWith('application/json')){
  json(res,{error:'invalid-origin'},403);
  return;
 }
 let text='';
 for await(const chunk of req){
  text+=chunk;
  if(text.length>65536){json(res,{error:'size'},413);return;}
 }
 try{
  const patch=JSON.parse(text);
  preferences.update(patch);
  if(Object.hasOwn(patch,'timeZone')){
   accountGeneration++;
   latestSnapshot=null;
   publishTrayStatus();
   void collectInBackground(true);
  }
  if(Object.hasOwn(patch,'bubbleWindow'))publishTrayStatus();
  if(patch.resetNewsEnabled===true)void refreshNews();
  if(Object.hasOwn(patch,'budgetRule')||Object.hasOwn(patch,'budgetAlerts'))checkBudgetAlerts();
  json(res,preferences.get());
 }catch{
  json(res,{error:'invalid-preferences'},400);
 }
}

async function serve(req,res){
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 if(req.headers.host!=='127.0.0.1:'+port){json(res,{error:'invalid-host'},403);return;}
 const url=new URL(req.url,origin);
 const route=url.pathname;
 if(req.method==='POST'&&['/updates/check','/updates/stage'].includes(route)){
  if(req.headers.origin!==origin||!String(req.headers['content-type']).startsWith('application/json')){
   json(res,{error:'invalid-origin'},403);return;
  }
  try{json(res,await updates[route.endsWith('stage')?'stage':'check']());}
  catch{json(res,updates.status(),503);}
  return;
 }
 if(req.method==='POST'&&route==='/preferences'){await savePreferences(req,res);return;}
 if(req.method!=='GET'){json(res,{error:'method'},405);return;}
 const asset=staticFiles.get(route);
 if(asset){res.writeHead(200,{'Content-Type':asset.type});res.end(asset.body);return;}
 if(route==='/preferences'){json(res,preferences.get());return;}
 if(route==='/locales'){json(res,preferences.locales());return;}
 if(route==='/backups'){json(res,require('./storage-backup').listBackups(appDataDirectory));return;}
 if(route==='/updates/status'){json(res,updates.status());return;}
 if(route==='/refresh'){
  await collectInBackground(true);
  json(res,{},state.error||state.backgroundError?503:200);
  return;
 }
 if(route==='/data'){json(res,await snapshot());return;}
 if(route==='/diagnostics'||route==='/diagnostics.json'){
  const report=require('./diagnostics').diagnostics(await snapshot(),{includeStats:url.searchParams.get('stats')==='1'});
  if(route.endsWith('.json'))res.setHeader('Content-Disposition','attachment; filename="codex-diagnostics.json"');
  json(res,report);
  return;
 }
 if(route==='/projects'||route==='/projects.csv'){
  const period=url.searchParams.get('period')||'today';
  const model=url.searchParams.get('model')||'',effort=url.searchParams.get('effort')||'';
  if(!['today','cycle'].includes(period)||model.length>100||effort.length>50){
   json(res,{error:'invalid-filter'},400);return;
  }
  const current=await getCurrentSnapshot();
  const report=getProjectReport({detail:current.payload.detail,threads:current.payload.projectThreads,
   projects:preferences.get().projects,period,model,effort,now:current.at});
  if(route==='/projects'){json(res,report);return;}
  if(!report.available){json(res,{error:'missing-coverage'},409);return;}
  res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8',
   'Content-Disposition':'attachment; filename="codex-project-'+period+'.csv"'});
  res.end(projectCsv(report));
  return;
 }
 json(res,{error:'not-found'},404);
}
http.createServer((req,res)=>{
 serve(req,res).catch(()=>{
  if(!res.headersSent)json(res,{error:'data-unavailable'},500);
  else res.end();
 });
}).listen(port,'127.0.0.1',()=>{console.log('READY');void connect();});
void refreshNews();
setInterval(refreshNews,60000).unref();
async function checkUpdateNotice(){
 const result=await updates.check();
 if(!managed||!['available','ready'].includes(result.status))return;
 const marker=path.join(appDataDirectory,'updates','announced.json');
 try{if(JSON.parse(fs.readFileSync(marker,'utf8')).version===result.version)return;}catch{}
 try{
  fs.mkdirSync(path.dirname(marker),{recursive:true});
  fs.writeFileSync(marker,JSON.stringify({version:result.version}));
  console.log('UPDATE '+JSON.stringify({version:result.version}));
 }catch{}
}
void checkUpdateNotice();
setInterval(()=>void checkUpdateNotice(),6*3600000).unref();
setInterval(()=>collectInBackground(),30000);
process.on('exit',()=>app?.kill());
const commands=readline.createInterface({input:process.stdin});
commands.on('line',command=>{
 if(command!=='resume')return;
 if(appReady)void collectInBackground();
 else if(!app){clearTimeout(reconnectTimer);reconnectTimer=null;void connect();}
});
if(managed)commands.once('close',()=>process.exit(0));
