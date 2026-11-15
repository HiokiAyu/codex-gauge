(async()=>{
'use strict';
const displayZone=()=>data?.detail?.timeZone||(prefs.timeZone==='system'?undefined:prefs.timeZone||'Asia/Shanghai');
const timeZoneInfo=()=>t('timeZoneInfo',{zone:displayZone()||Intl.DateTimeFormat().resolvedOptions().timeZone});
function zoneOptions(){
 const current=prefs.timeZone??'Asia/Shanghai';
 const zones=[...new Set(['UTC',...Intl.supportedValuesOf('timeZone'),...(current==='system'?[]:[current])])];
 const system='<option value="system" '+(current==='system'?'selected':'')+'>'+tr('timeZoneSystem')+'</option>';
 return system+zones.map(zone=>'<option value="'+esc(zone)+'" '+(zone===current?'selected':'')+'>'+esc(zone)+'</option>').join('');
}
let catalogs=[],prefs={language:'zh-CN',alerts:true,seenNews:[]},data=null,view='home',period='today',query='',sort='quota',pinned=true,compact=false,startupEnabled=false,busy=false,failed=false,notifying=false;
const esc=x=>String(x??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const native=x=>window.chrome?.webview?.postMessage(x),lang=()=>catalogs.find(x=>x.id===prefs.language)||catalogs.find(x=>x.id==='en')||catalogs[0];
function t(key,args={}){let v=lang()?.strings[key]??catalogs.find(x=>x.id==='en')?.strings[key]??key;return v.replace(/\{(\w+)\}/g,(_,k)=>String(args[k]??''))}
const tr=(k,a)=>esc(t(k,a)),pct=x=>Number.isFinite(x)?x.toFixed(2)+'%':'—',tok=x=>Number.isFinite(x)?tr('million',{n:(x/1e6).toFixed(2)}):'—',clock=x=>new Date(x).toLocaleTimeString(prefs.language,{hour:'2-digit',minute:'2-digit',timeZone:displayZone()}),date=x=>new Date(x).toLocaleString(prefs.language,{timeZone:displayZone()}),switchUI=(id,key,on)=>`<button id="${id}" class="switch" role="switch" aria-checked="${on}" aria-label="${tr(key)}"><span>${tr(key)}</span><i aria-hidden="true"></i></button>`;
try{[catalogs,prefs]=await Promise.all([fetch('/locales').then(r=>r.json()),fetch('/preferences').then(r=>r.json())])}catch{document.getElementById('loading-mask').hidden=true;document.body.textContent='Language files could not be loaded. Please restart.';return}
const shell=document.createElement('div');shell.className='shell';document.body.prepend(shell);
let settingsAbort=new AbortController();function build(){settingsAbort.abort();settingsAbort=new AbortController();document.documentElement.lang=prefs.language;document.title=t('app');shell.innerHTML=`<div class="sticky-head"><div class="titlebar"><h1>${tr('app')}</h1><div class="window-actions"><select id="language" aria-label="${tr('language')}">${catalogs.map(c=>`<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>${switchUI('toggle-bubble','bubble',compact)}${switchUI('toggle-pin','pin',pinned)}<button id="settings-button" aria-label="${tr('settings')}" title="${tr('settings')}" aria-expanded="false">⚙</button><button data-command="minimize" aria-label="${tr('minimize')}" title="${tr('minimize')}">—</button><button data-command="maximize" aria-label="${tr('maximize')}" title="${tr('maximize')}">□</button><button data-command="close" aria-label="${tr('close')}" title="${tr('close')}">×</button></div></div><div class="settings-menu" id="settings-menu" hidden><div class="settings-heading">${tr('settings')}</div>${switchUI('news-setting','newsFeature',prefs.resetNewsEnabled!==false)}${switchUI('tray-setting','trayOnClose',prefs.trayOnClose===true)}${switchUI('startup-setting','startup',startupEnabled)}<div class="settings-theme"><span>${tr('theme')}</span><button id="theme-dark" aria-pressed="${prefs.theme!=='light'}">${tr('dark')}</button><button id="theme-light" aria-pressed="${prefs.theme==='light'}">${tr('light')}</button></div><div class="settings-data"><div class="setting-row"><span>${tr('setDataFolder')}</span><button id="choose-data-folder" aria-label="${tr('setDataFolder')}">${tr('configure')}</button></div><div class="setting-row"><span>${tr('restoreDataFolder')}</span><button id="restore-data-folder" aria-label="${tr('restoreDataFolder')}">${tr('restore')}</button></div><div class="setting-row"><span>${tr('resetBubble')}</span><button id="reset-ball" aria-label="${tr('resetBubble')}">${tr('restore')}</button></div></div><label class="setting-timezone">${tr('timeZone')}<select id="time-zone">${zoneOptions()}</select></label><button id="check-updates" disabled aria-describedby="updates-status">${tr('updates')}</button><button id="install-update" hidden></button><p id="updates-status" class="note">${tr('updatesPlanned')}</p><button id="about-app">${tr('about')}</button><p id="settings-status" class="note">${esc(timeZoneInfo())}</p></div><nav class="tabs">${['home','chats','trend','research'].map(v=>`<button data-view="${v}" class="${(view===v||view==='projects'&&v==='chats')?'selected':''}">${tr(v)}</button>`).join('')}<span class="status" id="v-status"></span><button id="manual-refresh" aria-label="${tr('refreshAction')}" title="${tr('refreshAction')}">↻</button></nav></div><div id="v-body" class="content"></div>`;
 document.body.classList.toggle('light-theme',prefs.theme==='light');
 document.addEventListener('keydown',event=>{
  const drawer=document.getElementById('settings-menu'),button=document.getElementById('settings-button');
  if(event.key==='Escape'&&drawer&&!drawer.hidden){
   drawer.hidden=true;button.setAttribute('aria-expanded','false');button.focus();event.preventDefault();
  }
 },{signal:settingsAbort.signal});
 const menu=document.getElementById('settings-menu'),gear=document.getElementById('settings-button');gear.onclick=()=>{menu.hidden=!menu.hidden;gear.setAttribute('aria-expanded',String(!menu.hidden))};document.addEventListener('pointerdown',e=>{const currentMenu=document.getElementById('settings-menu'),currentGear=document.getElementById('settings-button');if(currentMenu&&!currentMenu.hidden&&!currentMenu.contains(e.target)&&!currentGear.contains(e.target)){currentMenu.hidden=true;currentGear.setAttribute('aria-expanded','false')}},{signal:settingsAbort.signal});document.getElementById('reset-ball').onclick=()=>native('reset-bubble-position');document.getElementById('choose-data-folder').onclick=()=>native('choose-data-root');document.getElementById('restore-data-folder').onclick=async()=>{if(prefs.dataRoot&&await save({dataRoot:null},'dataFolderInvalid'))native('restart-dashboard')};document.getElementById('tray-setting').onclick=async()=>{if(await save({trayOnClose:!prefs.trayOnClose})){native(prefs.trayOnClose?'tray-close:on':'tray-close:off');document.getElementById('tray-setting').setAttribute('aria-checked',String(!!prefs.trayOnClose))}};document.getElementById('startup-setting').onclick=()=>native(startupEnabled?'startup:off':'startup:on');document.getElementById('news-setting').onclick=async()=>{if(await save({resetNewsEnabled:prefs.resetNewsEnabled===false})){document.getElementById('news-setting').setAttribute('aria-checked',String(prefs.resetNewsEnabled!==false));await load();render(true)}};for(const theme of ['dark','light'])document.getElementById('theme-'+theme).onclick=async()=>{if(await save({theme})){document.body.classList.toggle('light-theme',theme==='light');document.getElementById('theme-dark').setAttribute('aria-pressed',String(theme==='dark'));document.getElementById('theme-light').setAttribute('aria-pressed',String(theme==='light'))}};document.getElementById('about-app').onclick=()=>document.getElementById('settings-status').textContent=t('aboutText')+(data?.appInfo?' · '+data.appInfo.version:'')+' · '+timeZoneInfo();
 document.getElementById('time-zone').onchange=async event=>{
 if(await save({timeZone:event.target.value})){
  while(busy)await new Promise(resolve=>setTimeout(resolve,50));
  await load();document.getElementById('settings-status').textContent=timeZoneInfo();render(true);
 }
};
 document.getElementById('loading-label').textContent=t('loadingUsage');document.getElementById('manual-refresh').onclick=manualRefresh;document.getElementById('language').value=prefs.language;document.getElementById('language').onchange=async e=>{prefs.language=e.target.value;await save({language:prefs.language});native('language:'+prefs.language);build();render()};shell.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>select(b.dataset.view));shell.querySelectorAll('[data-command]').forEach(b=>b.onclick=()=>native(b.dataset.command));document.getElementById('toggle-bubble').onclick=()=>native(compact?'expand':'compact');document.getElementById('toggle-pin').onclick=()=>native('pin');const title=shell.querySelector('.titlebar');title.onpointerdown=e=>{if(e.button===0&&!e.target.closest('button,input,select,.settings-menu')){e.preventDefault();native('move')}};title.ondblclick=e=>{if(!e.target.closest('button,input,select'))native('maximize')};document.getElementById('bubble').setAttribute('aria-label',t('app'));}
function select(v){view=v;shell.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('selected',(b.dataset.view===v||v==='projects'&&b.dataset.view==='chats')));render(true);window.scrollTo(0,0)}
function windowLabel(window){
 const duration=window.duration;
 const unit=duration%1440===0?'day':duration%60===0?'hour':'minute';
 const size=duration/(unit==='day'?1440:unit==='hour'?60:1);
 const period=new Intl.NumberFormat(prefs.language,{style:'unit',unit,unitDisplay:'short'}).format(size);
 return window.limitId==='codex'?period:(window.label||window.limitId)+' · '+period;
}
function focusQuota(data,now){
 const windows=data.quotaWindows||[];
 const selected=prefs.bubbleWindow;
 if(selected==='urgent'){
  return windows.filter(window=>window.used!=null&&window.reset>now)
   .sort((a,b)=>b.used-a.used||a.reset-b.reset)[0];
 }
 if(selected)return windows.find(window=>window.key===selected);
 return windows.find(window=>window.limitId==='codex'&&window.duration===10080);
}
function forecastCell(current){
 if(!current)return '—';
 const reasons={'no-readings':'forecastNoReadings',stale:'forecastStale','history-mismatch':'forecastHistoryMismatch',
  rebase:'forecastRebase',gap:'forecastGap','low-usage':'forecastLowChange',reset:'forecastNewCycle','missing-fields':'forecastMissingFields'};
 let prediction=current.status==='range'
  ?(current.latest==null?tr('forecastAfter',{start:date(current.earliest)}):tr('forecastRange',{start:date(current.earliest),end:date(current.latest)}))
  :current.status==='past-reset'?tr('forecastPastReset')
  :current.status==='exhausted'?tr('forecastExhausted')
  :current.status==='insufficient'?tr('forecastInsufficient'):'—';
 if(current.reason==='short-span'&&Number.isFinite(current.missingMinutes))
  prediction+='<small class="forecast-reason">'+tr('forecastNeedTime',{n:current.missingMinutes})+'</small>';
 else if(reasons[current.reason])prediction+='<small class="forecast-reason">'+tr(reasons[current.reason])+'</small>';
 if(['range','past-reset'].includes(current.status)&&Number.isFinite(current.from)&&Number.isFinite(current.to)){
  const minutes=(current.to-current.from)/60000;
  const span=new Intl.NumberFormat(prefs.language,{style:'unit',unit:minutes>=60?'hour':'minute',unitDisplay:'short',maximumFractionDigits:1})
   .format(minutes>=60?minutes/60:minutes);
  prediction+='<small class="forecast-basis" title="'+esc(date(current.from)+' – '+date(current.to))+'">'+
   tr('forecastBasis',{span,start:clock(current.from),end:clock(current.to)})+'</small>';
 }
 return prediction;
}
function quotaOverview(data){
 const windows=(data.quotaWindows||[]).slice().sort((a,b)=>
  (b.used??-1)-(a.used??-1)||(a.reset??Infinity)-(b.reset??Infinity));
 if(!windows.length)return '';
 const stale=failed||!!data.error;
 const leading=windows.find(window=>window.used!=null&&window.reset>Date.now())||windows[0];
 const summary=Number.isFinite(leading.used)?windowLabel(leading)+' · '+(100-leading.used).toFixed(0)+'%':windowLabel(leading);
 const rows=windows.map(window=>{
  const current=stale?null:window.forecast;
  const reset=window.reset==null?'—':date(window.reset);
  const prediction=forecastCell(current);
  const remaining=Number.isFinite(window.used)?(100-window.used).toFixed(0)+'%':'—';
  const reserve=window.key?prefs.budgets?.[window.key]:null;
  const margin=Number.isInteger(reserve)&&Number.isFinite(window.used)&&window.reset>Date.now()&&!stale
   ?100-window.used-reserve:null;
  const budget=window.key?`<form class="budget-rule" data-window="${esc(window.key)}">
   <input type="number" min="0" max="99" step="1" value="${reserve??''}" placeholder="—"
    aria-label="${tr('budgetReserveFor',{window:windowLabel(window)})}">
   <button type="submit">${tr('budgetSave')}</button>
  </form>${margin==null?'':`<small class="${margin<=0?'budget-low':''}">${tr(margin<=0?'budgetBelow':'budgetRoom',{n:Math.abs(margin).toFixed(1)})}</small>`}`:'—';
  return `<tr><td>${esc(windowLabel(window))}</td><td>${remaining}</td><td>${esc(reset)}</td><td>${prediction}</td><td>${budget}</td></tr>`;
 }).join('');
 const selected=prefs.bubbleWindow??'';
 const options=[['',t('bubbleWeekly')],['urgent',t('bubbleUrgent')],...windows.filter(window=>window.key
  &&(window.limitId!=='codex'||window.duration!==10080||window.key===selected))
  .map(window=>[window.key,windowLabel(window)])];
 if(!options.some(([key])=>key===selected))options.push([selected,t('bubbleUnavailable')]);
 return `<details id="quota-window-details" class="reset-news quota-windows">
  <summary>${tr('quotaWindows')} · ${esc(summary)}</summary>
  <div class="vtable"><table><thead><tr><th>${tr('quotaWindow')}</th><th>${tr('remaining')}</th>
  <th>${tr('quotaResetTime')}</th><th>${tr('forecastTitle')}</th><th>${tr('budgetReserve')}</th></tr></thead><tbody>${rows}</tbody></table></div>
  <div class="quota-controls">
   <label>${tr('bubbleSource')} <select id="bubble-source">${options.map(([key,label])=>
    `<option value="${esc(key)}" ${key===selected?'selected':''}>${esc(label)}</option>`).join('')}</select></label>
   ${switchUI('quota-budget-alerts','budgetAlerts',prefs.budgetAlerts!==false)}
   ${data.updated?`<span class="note">${tr('quotaUpdated',{time:date(data.updated)})}</span>`:''}
  </div>
 </details>`;
}

function connectionGuide(data){
 const detail=data.detail||{};
 const connected=!failed&&!data.error&&!!data.updated;
 const account=connected&&detail.accountKnown===true;
 const directory=!!data.dataSource&&!detail.sourceError;
 const quota=account&&(data.quotaWindows||[]).some(window=>Number.isFinite(window.used)&&window.reset>Date.now());
 const storageHealthy=data.storage?.healthy!==false&&!detail.calibrationError&&!detail.checkpointError&&!data.windowHistoryError;
 const sampling=account&&directory&&storageHealthy&&!detail.scanning&&!detail.errors&&!data.backgroundError&&!data.quotaHistoryWriteError;
 const steps=[['guideConnection',connected],['guideAccount',account],['guideFolder',directory],
  ['guideReadings',quota],['guideSampling',sampling]];
 const ready=steps.every(([,ok])=>ok);
 if(ready&&prefs.onboardingDismissed)return '';
 const status=ready?t('guideReady'):t('guideProgress',{n:steps.filter(([,ok])=>ok).length,total:steps.length});
 return `<details id="connection-guide" class="reset-news"><summary>${tr('guideTitle')} · ${esc(status)}</summary>
  <ul class="guide-steps">${steps.map(([name,ok])=>
   `<li><span>${tr(name)}</span><span>${tr(ok?'guideOk':'guidePending')}</span></li>`).join('')}</ul>
  <div class="quota-controls">
   ${ready?`<button id="guide-done">${tr('guideDismiss')}</button>`:
    `<button id="guide-refresh">${tr('refreshAction')}</button><button id="guide-folder">${tr('setDataFolder')}</button>${!storageHealthy?'<button id="guide-backups">'+tr('backupRestore')+'</button>':''}`}
  </div>
 </details>`;
}

function bindQuotaControls(){
 const backups=document.getElementById('guide-backups');
 if(backups)backups.onclick=()=>{
  select('research');
  document.getElementById('support-report').open=true;
  document.getElementById('backup-list').click();
 };
 for(const form of document.querySelectorAll('form.budget-rule')){
  form.onsubmit=async event=>{
   event.preventDefault();
   const input=form.querySelector('input');
   const reserve=input.value===''?null:input.valueAsNumber;
   if(await save({budgetRule:{key:form.dataset.window,reserve}}))render(true);
  };
 }
 const source=document.getElementById('bubble-source');
 if(source)source.onchange=async()=>{
  if(await save({bubbleWindow:source.value||null}))render(true);
  else source.value=prefs.bubbleWindow??'';
 };
 const alerts=document.getElementById('quota-budget-alerts');
 if(alerts)alerts.onclick=async()=>{
  if(await save({budgetAlerts:prefs.budgetAlerts===false}))render(true);
 };
 const done=document.getElementById('guide-done');
 if(done)done.onclick=async()=>{if(await save({onboardingDismissed:true}))render(true);};
 const retry=document.getElementById('guide-refresh');
 if(retry)retry.onclick=manualRefresh;
 const folder=document.getElementById('guide-folder');
 if(folder)folder.onclick=()=>native('choose-data-root');
}
const projectFilters={period:'today',model:'',effort:''};
let projectReport=null,projectReportKey=null,projectLoadingKey=null,projectFailed=false,projectPick=null,projectRevision=0;

function projectQuery(){
 return new URLSearchParams(projectFilters).toString();
}

function requestProjectReport(){
 const query=projectQuery();
 const key=JSON.stringify([data?.snapshotAt??data?.updated,query,projectRevision]);
 if(key===projectReportKey||key===projectLoadingKey)return;
 projectLoadingKey=key;
 fetch('/projects?'+query,{cache:'no-store',signal:AbortSignal.timeout(10000)}).then(response=>{
  if(!response.ok)throw Error('Project report unavailable');
  return response.json();
 }).then(report=>{
  if(projectLoadingKey!==key)return;
  projectReport=report;
  projectReportKey=key;
  projectFailed=false;
 }).catch(()=>{
  if(projectLoadingKey!==key)return;
  projectFailed=true;
 }).finally(()=>{
  if(projectLoadingKey!==key)return;
  projectLoadingKey=null;
  if(view==='projects'){
   if(projectFailed)document.getElementById('project-status').textContent=t('projectUnavailable');
   else render(true);
  }
 });
}

function projectPanel(){
 const report=projectReport;
 const groups=report?.groups||[];
 const options=(items,selected,empty)=>`<option value="">${tr(empty)}</option>${items.map(value=>
  `<option value="${esc(value)}" ${value===selected?'selected':''}>${esc(value)}</option>`).join('')}`;
 const saved=report?.projects||[];
 const quote=group=>group.partial
  ?(group.knownQuota>0?tr('knownPartial',{n:pct(group.knownQuota),tokens:tok(group.unknownTokens)}):'—')
  :pct(group.knownQuota);
 const headings=['projectSession','model','effort','tokens','input','cache','output','quota'];
 const cards=groups.map(group=>`<details class="reset-news project-group" id="project-group-${esc(group.id||'unassigned')}">
  <summary><strong>${group.name?esc(group.name):tr('projectUnassigned')}</strong><span>${tok(group.tokens)} · ${quote(group)}</span></summary>
  <div class="vtable"><table><thead><tr>${headings.map(key=>`<th>${tr(key)}</th>`).join('')}</tr></thead>
  <tbody>${group.sessions.map(row=>`<tr><td class="name">${esc(row.title)}</td><td>${esc(row.model)}</td>
   <td>${esc(row.effort)}</td><td>${tok(row.tokens)}</td><td>${tok(row.input)}</td><td>${tok(row.cached)}</td>
   <td>${tok(row.output)}</td><td>${row.estimate==null?'—':pct(row.estimate)}</td></tr>`).join('')}</tbody></table></div>
 </details>`).join('');
 return `<div class="toolbar project-toolbar">
  <button id="project-back">${tr('chats')}</button>
  <label>${tr('projectPeriod')} <select id="project-period"><option value="today" ${projectFilters.period==='today'?'selected':''}>${tr('today')}</option>
   <option value="cycle" ${projectFilters.period==='cycle'?'selected':''}>${tr('cycle')}</option></select></label>
  <label>${tr('model')} <select id="project-model">${options(report?.models||[],projectFilters.model,'projectAllModels')}</select></label>
  <label>${tr('effort')} <select id="project-effort">${options(report?.efforts||[],projectFilters.effort,'projectAllEfforts')}</select></label>
  <button id="project-export" ${!report?.available?'disabled':''}>${tr('projectCsv')}</button>
 </div>
 <p class="note" id="project-status">${projectFailed?tr('projectUnavailable'):report?.available?
  tr('projectTotal',{tokens:tok(report.total.tokens),quota:quote(report.total)}):tr(report?'noData':'loading')}</p>
 ${cards}
 <details id="project-settings" class="reset-news">
  <summary>${tr('projectManage')}</summary>
  <form id="project-add" class="project-edit">
   <input name="name" aria-label="${tr('projectName')}" placeholder="${tr('projectName')}" maxlength="80" required>
   <button type="submit">${tr('projectAddFolder')}</button>
  </form>
  ${saved.map(project=>`<form class="project-edit project-existing" data-project="${esc(project.id)}">
   <input name="name" aria-label="${tr('projectName')}" maxlength="80" value="${esc(project.name)}" required>
   <span class="note">${tr('projectFolders',{n:project.folders})}</span>
   <button type="submit">${tr('budgetSave')}</button>
   <button type="button" data-attach>${tr('projectAddFolder')}</button>
   <button type="button" data-remove>${tr('projectRemove')}</button>
  </form>`).join('')}
 </details>`;
}

async function changeProject(change){
 if(await save({projectChange:change},'projectSaveError')){
  projectRevision++;
  if(view==='projects')render(true);
 }
}

async function exportProjects(){
 try{
  const response=await fetch('/projects.csv?'+projectQuery(),{signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw Error('Export failed');
  const url=URL.createObjectURL(await response.blob());
  const link=document.createElement('a');
  link.href=url;
  link.download='codex-project-'+projectFilters.period+'.csv';
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch{toast(t('projectUnavailable'));}
}

function bindProjects(){
 document.getElementById('project-back').onclick=()=>select('chats');
 document.getElementById('project-export').onclick=exportProjects;
 for(const field of ['period','model','effort']){
  const input=document.getElementById('project-'+field);
  input.onchange=()=>{
   projectFilters[field]=input.value;
   if(field==='period'){projectFilters.model='';projectFilters.effort='';}
   requestProjectReport();
  };
 }
 document.getElementById('project-add').onsubmit=event=>{
  event.preventDefault();
  projectPick={action:'save',name:event.currentTarget.elements.namedItem('name').value};
  native('choose-project-folder');
 };
 for(const form of document.querySelectorAll('.project-existing')){
  const id=form.dataset.project;
  form.onsubmit=event=>{
   event.preventDefault();
   void changeProject({action:'save',id,name:form.elements.namedItem('name').value});
  };
  form.querySelector('[data-attach]').onclick=()=>{
   projectPick={action:'attach',id};
   native('choose-project-folder');
  };
  form.querySelector('[data-remove]').onclick=()=>void changeProject({action:'remove',id});
 }
 requestProjectReport();
}
async function save(p,errorKey='savedError'){try{const r=await fetch('/preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});if(!r.ok)throw Error();prefs=await r.json();return true}catch{toast(t(errorKey));return false}}
function toast(text){const el=document.getElementById('toast');el.innerHTML=`<button aria-label="${tr('close')}">×</button><strong>${tr('notificationTitle')}</strong><p>${esc(text)}</p>`;el.hidden=false;el.querySelector('button').onclick=()=>el.hidden=true;}
function popup(body){toast(body);native('notify:'+JSON.stringify({title:t('notificationTitle'),body}));}
async function notifyNews(){if(notifying||prefs.resetNewsEnabled===false||!data?.resetNews)return;const aliases=x=>[x.id,...(x.records||[x]).map(r=>'event:'+Math.round(r.at/60000)+':'+r.type)];const unseen=(data.resetNews.recent||[]).filter(x=>x.freshSources?.length&&!aliases(x).some(id=>prefs.seenNews.includes(id)));if(!unseen.length)return;notifying=true;try{const enabled=prefs.alerts;if(await save({seenNews:unseen.flatMap(aliases)})){if(enabled)popup(t('notificationBody',{n:unseen.length}))}}finally{notifying=false}}
function reason(row){
 if(!row.estimateReason)return '';
 return tr(row.estimateReason.includes('基线')?'unverified':row.compaction?'compactionEstimateUnavailable':'unknownRate');
}
function quotaValue(row){return Number.isFinite(row.q)?'≈ '+pct(row.q):'—'+(reason(row)?'<small>'+reason(row)+'</small>':'')}
function groups(list,limit,sortMode){
 const map=new Map();
 for(const x of list){
  let group=map.get(x.id);
  if(!group){group={id:x.id,title:x.title,rows:[],total:0,q:0,complete:true};map.set(x.id,group);}
  group.rows.push(x);
  group.total+=x.total;
  if(Number.isFinite(x.q))group.q+=x.q;
  else group.complete=false;
 }
 const comparable=g=>g.complete||g.q>0?g.q:-1;
 return [...map.values()].sort((a,b)=>sortMode==='tokens'?b.total-a.total:comparable(b)-comparable(a)||b.total-a.total).slice(0,limit);
}
function groupQuota(group){
 if(group.complete)return '≈ '+pct(group.q);
 return group.q>0?tr('chatPartialQuota',{n:pct(group.q)}):'—';
}
function table(list,limit=250,sortMode=sort){const gs=groups(list,limit,sortMode);return gs.map(g=>`<section class="chat-group"><div class="chat-heading"><div><div class="chat-title">${g.id==='retained-usage'||(g.rows.every(r=>r.retainedTokens)&&g.title==='未命名')?tr('retainedUsage'):esc(g.title)}</div><div class="note">${tr('settingsCount',{n:g.rows.length})}</div></div><div class="chat-summary">${tok(g.total)}<div class="note">${groupQuota(g)}</div></div></div><div class="vtable"><table><thead><tr>${['model','effort','tier','tokens','input','cache','output','quota'].map(k=>`<th>${tr(k)}</th>`).join('')}</tr></thead><tbody>${g.rows.sort((a,b)=>b.total-a.total).map(x=>`<tr><td>${x.compaction&&x.attributionUnverified?tr('compactionUnknown'):x.model==='未知'?tr('unknown'):esc(x.model)}</td><td>${tr(['low','medium','high','xhigh','max','ultra','minimal','none'].includes(x.effort)?x.effort:'unknown')}</td><td>${tr(['default','standard'].includes(x.tier)?'standard':['fast','priority'].includes(x.tier)?'fast':'unrecorded')}</td><td>${tok(x.total)}${x.retainedTokens?'<small>'+tr('retainedTokenLabel')+'</small>':''}</td><td>${tok(x.input)}</td><td>${tok(x.cached)}</td><td>${tok(x.output)}</td><td>${quotaValue(x)}</td></tr>`).join('')}</tbody></table></div></section>`).join('')||`<p class="note">${tr('noData')}</p>`}
const typeKey=x=>({automatic:'newsAutomatic',banked:'newsBanked',both:'newsBoth'})[x]||'newsUnknown';
function newsItems(items){return `${items.map(x=>`<p><a href="${esc(x.url)}" target="_blank" rel="noopener">${tr(typeKey(x.type))} ↗</a> · ${esc(date(x.at))}<br><span class="note">${x.conflict?tr('newsConflict'):x.sources.length>1?tr('matched',{n:x.sources.length}):tr('single')} · ${esc(x.sources.join(', '))}</span></p><details id="source-${esc(x.id)}"><summary class="note">${tr('details')}</summary>${(x.records||[]).map(r=>`<p class="note"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.source)}</a> · ${tr(typeKey(r.type))} · ${esc(date(r.at))}</p>`).join('')}</details>`).join('')}`;}
function news(){const f=data.resetNews||{},latest=f.recent?.[0],state=f.status;if(state==='disabled')return '';let label=state==='loading'?tr('loading'):state==='error'?tr('newsUnavailable'):latest?tr(typeKey(latest.type)):tr('newsNone');return `<details class="reset-news" id="news-details"><summary>${tr('news')} · ${label}${state==='partial'?' · '+tr('newsPartial'):''}</summary><div class="news-actions">${switchUI('toggle-alerts','alerts',prefs.alerts)}</div>${newsItems((f.recent||[]).slice(0,3))}<details class="news-diagnostics" id="news-diagnostics"><summary>${tr('newsArchiveDetails')}</summary><button id="test-alert">${tr('testAlert')}</button><p class="note">${tr('newsDisclaimer')}</p>${newsItems((f.items||[]).filter(x=>!(f.recent||[]).slice(0,3).some(r=>r.id===x.id)).slice(0,8))}<h4>${tr('sources')}</h4><div class="source-grid">${(f.sources||[]).map(s=>`<div class="source-item"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.id)}</a> · ${tr(s.status)}<div class="note">${tr('checked')}: ${s.checkedAt?esc(date(s.checkedAt)):'—'}${s.updated?'<br>'+tr('sourceUpdated')+': '+esc(date(s.updated)):''}</div></div>`).join('')}</div><p class="note">${tr('refreshNews')}</p><p class="note">${tr('newsCredits')} · <a href="https://codex-resets.com" target="_blank" rel="noopener">Codex Resets</a> · <a href="https://claude-resets.com" target="_blank" rel="noopener">Claude Resets</a></p></details></details>`}
function previousCycleNotes(calendar){
 return (calendar?.segments||[]).slice(0,-1).filter(x=>['observed','conflict'].includes(x.status)&&x.first&&x.last).map(x=>`<br>${tr('previousCycleObserved',{n:pct(x.status==='observed'?x.delta:x.endpointDelta),start:clock(x.first.at),end:clock(x.last.at)})}${x.status==='conflict'?' · '+tr('netChange'):''}${observationNotes(x,' · ')}`).join('');
}
function observationNotes(obs,separator='<br>'){
 const notes=[];
 if(obs?.source)notes.push(tr(obs.baselineFromLog?'quotaLogBaseline':obs.source==='live'?'quotaLiveSource':'quotaLogSource'));
 const gaps=(obs?.gaps||[]).filter(g=>Number.isFinite(g.start)&&Number.isFinite(g.end));
 if(gaps.length){
  const ranges=gaps.map(g=>clock(g.start)+'–'+clock(g.end)).join(' · ');
  notes.push(`<span class="quota-gap-count" title="${esc(ranges)}">${tr('quotaGapCount',{n:gaps.length})}</span>`);
 }
 return notes.length?separator+notes.join(' · '):'';
}
function chart(obs){
 const series=obs?.series||(obs?.points?[obs.points]:[]);
 const points=series.flat();
 if(points.length<2)return '';
 const from=obs.windowStart??points[0].at,to=obs.windowEnd??points.at(-1).at,span=to-from;
 if(span<=0)return '';
 const used=points.map(p=>p.used);
 const bottom=Math.min(95,Math.floor(Math.min(...used)/5)*5);
 const top=Math.max(bottom+5,Math.ceil(Math.max(...used)/5)*5);
 const x=at=>(at-from)/span*300;
 const y=used=>48-(used-bottom)/(top-bottom)*40;
 const gaps=(obs.gaps||[]).filter(g=>g.start>=from&&g.end<=to);
 const bands=gaps.map(g=>`<rect class="quota-chart-gap" x="${x(g.start).toFixed(1)}" y="6" width="${(x(g.end)-x(g.start)).toFixed(1)}" height="42">
  <title>${tr('quotaGapRange',{from:clock(g.start),to:clock(g.end)})}</title></rect>`).join('');
 const color=obs.source==='log'?'quota-chart-log':'quota-chart-live';
 const lines=series.map(points=>{
  if(points.length===1)return `<circle class="${points[0].source==='log'?'quota-chart-log':color}" cx="${x(points[0].at).toFixed(1)}" cy="${y(points[0].used).toFixed(1)}" r="1.5"/>`;
  const coords=points.map(p=>`${x(p.at).toFixed(1)},${y(p.used).toFixed(1)}`).join(' ');
  return `<polyline class="${color}" points="${coords}" fill="none" stroke-width="2"/>`;
 }).join('');
 const label=tr('chartUsedRange',{low:bottom,high:top})+(gaps.length?' · '+tr('quotaGapCount',{n:gaps.length}):'');
 return `<div class="chart-with-scale"><div class="chart-scale note"><span>${top}%</span><span>${bottom}%</span></div><svg class="today-chart" viewBox="0 0 300 56" preserveAspectRatio="none" role="img" aria-label="${label}"><line x1="0" y1="48" x2="300" y2="48" class="quota-chart-baseline"/>${bands}${lines}</svg></div>`;
}
function todayQuotaTile(rows,valid,calendar,cycle,hasUnverified,models){
 const afterReset=calendar?.status==='reset';
 const observation=afterReset?cycle:calendar;
 const segments=afterReset?calendar.segments||[]:observation?[observation]:[];
 const delta=segment=>segment.status==='observed'?segment.delta:segment.status==='conflict'?segment.endpointDelta:null;
 const deltas=segments.map(delta).filter(Number.isFinite);
 const actual=deltas.length?deltas.reduce((sum,value)=>sum+value,0):null;
 const ordinary=rows.filter(row=>!row.compaction);
 const priced=ordinary.filter(row=>Number.isFinite(row.q));
 const partial=priced.length<ordinary.length||hasUnverified;
 const estimated=valid&&(priced.length||!partial)?priced.reduce((sum,row)=>sum+row.q,0):null;
 const calibrated=new Set((models||[]).filter(model=>model.updates>0&&Number.isFinite(model.coefficient)).map(model=>model.model));
 const referenceEstimate=priced.some(row=>!calibrated.has(row.model));
 const range=observation?.first&&observation?.last&&Number.isFinite(delta(observation))
  ?tr('observedRange',{start:clock(observation.first.at),end:clock(observation.last.at)}):tr('waitingReadings');
 const actualNotes=[
  afterReset?tr('actualAfterReset'):null,
  segments.some(segment=>segment.status==='conflict')?tr('netChange'):null,
  deltas.length>0&&(deltas.length<segments.length||
   segments.some(segment=>segment.gaps?.some(gap=>gap.edge==='end'||gap.edge==='start'&&!segment.baselineFromLog)))?tr('actualPartial'):null,
  range
 ].filter(Boolean).join('<br>');
 return `<div class="tile">
  <div class="caption">${tr('todayQuotaEstimate')}</div>
  <dl class="today-quota-values">
   <div><dt class="note">${tr('quotaActual')}</dt><dd class="metric" id="today-quota-actual">${pct(actual)}</dd></div>
   <div><dt class="note">${tr('quotaEstimated')}</dt><dd class="metric" id="today-quota-estimated">${estimated==null?'—':'≈ '+pct(estimated)}</dd></div>
  </dl>
  <div class="note">${tr('estimateExcludesCompaction')}${valid&&partial?'<br>'+tr('estimateRowsOnly'):''}${valid&&referenceEstimate?'<br>'+tr('estimateReferenceRates'):''}</div>
  ${Number.isFinite(delta(observation||{}))?chart(observation):''}
  <div class="note">${actualNotes}${observationNotes(observation)}${afterReset?previousCycleNotes(calendar):''}</div>
 </div>`;
}
const workloadFilter={model:'',effort:'',tier:''};
function workloadHistory(report){
 const history=report?.history||[];
 const choices=field=>`<option value="">${tr('workloadAll')}</option>${[...new Set(history.map(event=>event[field]))]
  .sort().map(value=>`<option value="${esc(value)}" ${workloadFilter[field]===value?'selected':''}>${esc(value)}</option>`).join('')}`;
 const selected=history.filter(event=>Object.entries(workloadFilter).every(([field,value])=>!value||event[field]===value));
 const changes=selected.map(event=>{
  const revoked=event.status==='revoked';
  const summary=revoked?tr('workloadRevoked'):tr(event.direction==='expensive'?'workloadExpensive':'workloadCheaper',{n:Math.abs(event.change*100).toFixed(0)});
  const number=value=>Number.isFinite(value)?Math.round(value).toLocaleString(prefs.language):'—';
  const bounds=value=>number(value?.points)+' ('+number(value?.low)+'–'+number(value?.high)+')';
  return `<details class="reset-news" id="workload-event-${esc(event.id)}"><summary>
   ${esc(event.model)} · ${esc(event.effort)} · ${esc(event.tier)} · ${summary}</summary>
   <p>${tr('workloadWindow',{from:date(event.from),to:date(event.to)})}</p>
   <p>${tr('workloadBeforeAfter',{before:bounds(event.before),after:bounds(event.after)})}</p>
   <p class="note">${tr('workloadConfirmedAt',{time:date(event.confirmedAt)})}
    · ${tr('workloadRuleVersion',{rule:event.policyVersion,weights:event.referenceVersion})}
    ${revoked?'<br>'+tr(event.reason==='local-evidence-revised'?'workloadRevokedLocalAt':'workloadRevokedAt',{time:date(event.revokedAt)}):''}</p>
   <div class="vtable"><table><thead><tr>${['date','input','cache','output','quota','samples'].map(key=>
    `<th>${tr(key)}</th>`).join('')}</tr></thead><tbody>${(event.dates||[]).map(day=>`<tr>
    <td>${esc(day.date)} UTC</td><td>${tok(day.input)}</td><td>${tok(day.cache)}</td><td>${tok(day.output)}</td>
    <td>${pct(day.pp)}</td><td>${day.windows}</td></tr>`).join('')}</tbody></table></div>
  </details>`;
 }).join('');
 return `<details class="research-details" id="workload-history"><summary>${tr('workloadHistory',{n:history.length})}</summary>
  ${history.length?`<div class="toolbar">${['model','effort','tier'].map(field=>`<label>${tr(field)}
   <select id="workload-filter-${field}">${choices(field)}</select></label>`).join('')}</div>`:''}
  ${changes||'<p class="note">'+tr('workloadHistoryEmpty')+'</p>'}
 </details>`;
}
function bindWorkloadHistory(){
 for(const field of Object.keys(workloadFilter)){
  const input=document.getElementById('workload-filter-'+field);
  if(input)input.onchange=()=>{workloadFilter[field]=input.value;render(true);};
 }
}
let supportReport=null,supportStats=false,backupRecords=null,backupSelection='',updateState={status:'unconfigured'};
function updateControls(){
 const check=document.getElementById('check-updates'),install=document.getElementById('install-update'),status=document.getElementById('updates-status');
 if(!check||!install||!status)return;
 const state=updateState;
 check.disabled=['unconfigured','invalid-config','checking','downloading'].includes(state.status);
 install.hidden=!['available','ready','downloading'].includes(state.status);
 install.disabled=state.status==='downloading';
 install.textContent=t(state.status==='ready'?'updateRestart':'updateDownload');
 const keys={unconfigured:'updatesPlanned','invalid-config':'updateInvalid',idle:'updateIdle',checking:'updateChecking',
  current:'updateCurrent',available:'updateAvailable',ready:'updateReady',downloading:'updateDownloading',unavailable:'updateUnavailable',error:'updateFailed'};
 const percent=state.totalBytes?Math.min(100,100*((state.reusedBytes||0)+(state.downloadedBytes||0))/state.totalBytes):0;
 status.textContent=t(keys[state.status]||'updateFailed',{version:state.version||'',n:percent.toFixed(0)});
 check.onclick=async()=>{
  updateState={status:'checking'};updateControls();
  try{
   const response=await fetch('/updates/check',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(125000)});
   if(!response.ok)throw Error();
   updateState=await response.json();
  }catch{updateState={status:'error'};}
  updateControls();
 };
 install.onclick=async()=>{
  if(updateState.status==='ready'){native('apply-update');return;}
  updateState={...updateState,status:'downloading'};updateControls();
  try{
   const response=await fetch('/updates/stage',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(660000)});
   if(!response.ok)throw Error();
   updateState=await response.json();
  }catch{updateState={status:'error'};}
  updateControls();
 };
}
function supportPanel(){
 return `<details class="research-details" id="support-report"><summary>${tr('supportTitle')}</summary>
  <div class="quota-controls"><label><input type="checkbox" id="support-stats" ${supportStats?'checked':''}>
   ${tr('supportStats')}</label>
   <button id="support-preview">${tr('supportPreview')}</button>
   <button id="support-export" ${supportReport?'':'disabled'}>${tr('supportExport')}</button></div>
  <p class="note">${tr('supportPrivacy')}</p>
  <pre id="support-content" class="support-content" ${supportReport?'':'hidden'}></pre>
  <div class="quota-controls"><button id="backup-list">${tr('backupList')}</button>
   <select id="backup-choice" ${backupRecords?.length?'':'hidden'} aria-label="${tr('backupList')}">${(backupRecords||[]).map(item=>'<option value="'+esc(item.id)+'" '+(backupSelection===item.id?'selected':'')+'>'+esc(date(item.createdAt))+' · '+esc(item.applicationVersion)+'</option>').join('')}</select>
   <button id="backup-restore" ${backupRecords?.length?'':'hidden disabled'}>${tr('backupRestore')}</button></div>
  <p class="note" id="backup-status" role="status">${backupRecords?tr(backupRecords.length?'backupHint':'backupEmpty'):''}</p>
 </details>`;
}
function bindSupport(){
 const choice=document.getElementById('backup-choice'),restore=document.getElementById('backup-restore');
 choice.onchange=()=>{backupSelection=choice.value;};
 document.getElementById('backup-list').onclick=async()=>{
  const status=document.getElementById('backup-status');
  status.textContent=t('loading');
  try{
   const response=await fetch('/backups',{cache:'no-store',signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw Error('Backup listing unavailable');
   backupRecords=await response.json();
   if(!backupRecords.some(item=>item.id===backupSelection))backupSelection=backupRecords[0]?.id||'';
   render(true);
  }catch{status.textContent=t('backupFailed');}
 };
 restore.onclick=()=>{if(choice.value)native('restore-backup:'+JSON.stringify(choice.value));};
 const preview=document.getElementById('support-content');
 if(supportReport)preview.textContent=JSON.stringify(supportReport,null,2);
 document.getElementById('support-stats').onchange=event=>{
  supportStats=event.target.checked;
  supportReport=null;
  preview.hidden=true;
  document.getElementById('support-export').disabled=true;
 };
 document.getElementById('support-preview').onclick=async()=>{
  try{
   const response=await fetch('/diagnostics?stats='+(supportStats?'1':'0'),{cache:'no-store',signal:AbortSignal.timeout(12000)});
   if(!response.ok)throw Error('Preview unavailable');
   supportReport=await response.json();
   preview.textContent=JSON.stringify(supportReport,null,2);
   preview.hidden=false;
   document.getElementById('support-export').disabled=false;
  }catch{toast(t('supportFailed'));}
 };
 document.getElementById('support-export').onclick=()=>{
  if(!supportReport)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(supportReport,null,2)],{type:'application/json'}));
  const link=document.createElement('a');
  link.href=url;link.download='codex-diagnostics.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 };
}
function workloadPanel(report){
 const number=n=>Math.round(n).toLocaleString(prefs.language);
 const renderRow=r=>{
  const latest=r.latest,change=r.change;
  const status=r.compared?'workloadNoChange':r.confirmedDays>=6?'workloadNotComparable':
   !r.windows?'workloadNoWindows':!r.confirmedDays&&!r.matchedLiveDays?'workloadNeedReconciled':'workloadInsufficient';
  const settings=tr(['minimal','low','medium','high','xhigh','max','ultra','none'].includes(r.effort)?r.effort:'unknown')+' · '+tr(r.tier);
  const estimate=latest?`<strong>${esc(number(latest.points))}</strong><div class="note">${esc(number(latest.low))}–${esc(number(latest.high))} · ${esc(latest.date)} UTC · ${tr(latest.verified?'reconciled':latest.source==='log'?'workloadLogEstimate':'workloadLiveEstimate')}</div>`:'—';
  const evidence=tr('workloadSamples',{days:r.confirmedDays,windows:r.windows,pp:r.observedPp.toFixed(1)})+
   (r.windows&&r.evidenceSource?`<div class="note">${tr(r.evidenceSource==='log'?'workloadLogEstimate':'workloadOfficialReadings')}</div>`:'');
  const progress=!r.compared&&r.windows&&Number.isFinite(r.confirmedPp)?`<div class="note">${tr('workloadEvidenceProgress',{
   days:r.confirmedDays,needDays:r.comparisonsRequiredDays,pp:r.confirmedPp.toFixed(1),needPp:r.comparisonsRequiredPp})}</div>`:'';
  const result=change?`<strong>${tr(change.direction==='expensive'?'workloadExpensive':'workloadCheaper',{n:Math.abs(change.change*100).toFixed(0)})}</strong><div class="note">${tr('workloadWindow',{from:date(change.from),to:date(change.to)})}</div>`:tr(status)+progress;
  return `<tr><td>${esc(r.model)}<div class="note">${settings}</div></td><td>${estimate}</td><td>${evidence}</td><td>${result}</td></tr>`;
 };
 const all=report?.rows||[];
 const ready=all.filter(r=>r.windows||r.latest||r.change),waiting=all.filter(r=>!r.windows&&!r.latest&&!r.change);
 const tableFor=rows=>`<div class="vtable"><table><thead><tr>${['model','workloadPoints','samples','state'].map(k=>`<th>${tr(k)}</th>`).join('')}</tr></thead><tbody>${rows.map(renderRow).join('')}</tbody></table></div>`;
 return `<div class="section-title"><h2>${tr('workloadTitle')}</h2></div><p class="note">${tr('workloadNote')}</p>${report?.persistenceError?`<p class="notice">${tr('workloadSaveError')}</p>`:''}
 ${ready.length?tableFor(ready):`<p class="note">${tr('workloadInsufficient')}</p>`}
 ${waiting.length?`<details class="research-details" id="workload-waiting"><summary>${tr('workloadWaitingProfiles',{n:waiting.length})}</summary>${tableFor(waiting)}</details>`:''}
 ${workloadHistory(report)}`;
}
function researchPanel(d){
 const c=d.calibration,rec=d.reconciliation,shadow=c?.shadow;
 const label=status=>({accepted:'fitAccepted',collecting:'fitCollecting',rejected:'fitRejected',paused:'fitPaused',uncalibrated:'fitUnknown',matched:'reconciled','near-match':'nearMatch','retained-match':'retainedMatch',mismatch:'mismatch',partial:'partial',pending:'pending',unverified:'unverified',supported:'shadowSupported'})[status]||'pending';
 const modelStatus=m=>{
  if(m.status==='uncalibrated')return 'fitNoSeed';
  if(m.coldStart&&m.status==='rejected')return 'fitInitialRejected';
  if(m.reasonCode==='no-cycle')return 'waitingCycle';
  if(m.reasonCode==='reconciliation')return 'waitingReconciliation';
  if(m.reasonCode==='live-samples')return c.reconciledLiveSamples===0?'matchedDaysNoReadings':c.reconciledLiveSamples>0?'fitNoWindows':'waitingLiveSamples';
  return label(m.status);
 };
 const initialProgress=m=>{
  if(Number.isFinite(m.coefficient)||!m.coldStart||!m.missing||m.status==='rejected'||m.reasonCode==='no-cycle')return '';
  const x=m.missing;
  const remaining=tr('fitInitialMissing',{train:x.trainBlocks,trainPp:x.trainPp.toFixed(1),validation:x.validationBlocks,validationPp:x.validationPp.toFixed(1)});
  const cycle=tr('fitInitialCycle',{blocks:x.recentBlocks,pp:x.recentPp.toFixed(1),hours:x.spanHours});
  return `<div class="note">${remaining}<br>${cycle}</div>`;
 };
 const candidateProgress=m=>{
  const e=m.candidateEvidence;
  if(!e||c.fitReady===false||m.blocks||m.status==='accepted')return '';
  const message=e.callsInLiveRange===0?'fitNoOverlappingCalls':e.blocks?'fitCandidateEvidence':'fitCandidateNoWindow';
  return `<div class="note">${tr(message,{n:e.blocks,pp:e.pp.toFixed(1)})}</div>`;
 };
 const latest=rec?.latest;
 const officialHistory=rec?.officialHistory||[];
 const counts=value=>Number.isSafeInteger(value)?esc(value.toLocaleString(prefs.language)):'—';
 const revisionHistory=rec?.officialHistoryError||officialHistory.length?`<details class="research-details" id="official-daily-revisions">
  <summary>${tr('officialDailyHistory')}</summary>
  ${rec.officialHistoryError?`<p class="notice">${tr('officialDailyHistoryError')}</p>`:''}
  ${officialHistory.length?`<div class="vtable"><table><thead><tr>${['dateUTC','officialDailyObservedAt','officialDailyBefore','officialTokens','officialDailyDelta'].map(k=>`<th>${tr(k)}</th>`).join('')}</tr></thead><tbody>
  ${officialHistory.map(row=>`<tr><td>${esc(row.date)}</td><td>${esc(date(row.observedAt))}</td>
   <td>${counts(row.previousTokens)}</td><td>${counts(row.tokens)}</td>
   <td>${row.difference==null?tr('officialDailyFirst'):(row.difference>0?'+':'')+counts(row.difference)}</td></tr>`).join('')}
  </tbody></table></div>`:''}
 </details>`:'';
 const latestStatus={settling:'latestDaySettling','missing-official':'latestDayMissing',unavailable:'latestDayUnavailable'}[latest?.status];
 const latestSummary=latest?`<section class="tile">
  <div class="caption">${tr('latestDayCheck',{date:latest.date})}</div>
  <div class="summary-value">${tr(latestStatus||label(latest.status),{time:date(latest.settledAt)})}</div>
  <div class="note">${tr('latestDayReadings',{n:latest.liveSamples})}
   ${Number.isFinite(latest.difference)?' · '+tr('latestDayTotals',{official:tok(latest.officialTokens),local:tok(latest.localTokens),difference:tok(latest.difference)}):''}</div>
 </section>`:'';
 return `${latestSummary}${revisionHistory}${workloadPanel(d.workloadMonitor)}
 <details class="research-details" id="calibration-details"><summary>${tr('calibrationDetails')}</summary>
 <div class="section-title"><h2>${tr('coefficient')}</h2></div><div class="vtable"><table><thead><tr>${['model','uncached','cache','output','fitUpdates','state'].map(k=>`<th>${tr(k)}</th>`).join('')}</tr></thead><tbody>${(c?.models||[]).map(m=>`<tr><td>${esc(m.model)}</td>${(c.rates[m.model]||[0,0,0]).map(rate=>`<td>${Number.isFinite(m.coefficient)?'≈ '+(rate*m.coefficient).toFixed(4)+'%':'—'}</td>`).join('')}<td>${m.updates}</td><td>${Number.isFinite(m.coefficient)?`<div>${tr(m.updates>0?'fitVerifiedRate':'fitSeedRate')}</div>`:''}${tr(modelStatus(m))}${m.status!=='rejected'&&m.lastEvaluation?.status==='rejected'?`<div class="note">${tr('fitPreviousRejected')}</div>`:''}${candidateProgress(m)}${initialProgress(m)}</td></tr>`).join('')}</tbody></table></div>
</details>
 <details class="research-details" id="reconciliation-details"><summary>${tr('diagnosticDetails')}</summary>
 <p class="note">${tr('methodNote')}</p><div class="research-grid">${[['events',c?.events],['samples',c?.samples],['compactions',d.ledger?.compactions]].map(([k,n])=>`<div class="tile"><div class="caption">${tr(k)}</div><div class="summary-value">${n??'—'}</div></div>`).join('')}</div>
 <div class="section-title"><h2>${tr('reconciliation')}</h2><span>${tr(label(rec?.status))}</span></div><p class="note">${tr('reconcileNote')}${c?.reconciledIntervals?' · '+tr('eligibleDays',{n:c.reconciledIntervals}):''}${Number.isFinite(c?.reconciledLiveSamples)?' · '+tr('matchedReadingCount',{n:c.reconciledLiveSamples}):''}</p>
 <div class="vtable"><table><thead><tr>${['dateUTC','officialTokens','localTokens','tokenDifference','state'].map(k=>`<th>${tr(k)}</th>`).join('')}</tr></thead><tbody>${(rec?.days||[]).slice(-10).map(x=>`<tr><td>${esc(x.date)}</td><td>${tok(x.officialTokens)}</td><td>${tok(x.localTokens)}${x.retainedTokens?'<small>'+tr('retainedDayTokens',{n:tok(x.retainedTokens)})+'</small>':''}</td><td>${tok(x.difference)}</td><td>${tr(label(x.status))}</td></tr>`).join('')||`<tr><td colspan="5">${tr('pending')}</td></tr>`}</tbody></table></div>
 <p class="note">${tr('shadowNote',{n:shadow?.blocks||0})} · ${tr(label(shadow?.status))}${c?.historicalShadow?' · '+tr('historicalShadow',{n:c.historicalShadow.blocks}):''}</p>
 <details id="research-gaps"><summary>${tr('gaps')}</summary>${(d.incomplete||[]).map(x=>`<p>${esc(x.title)} · ${esc(date(x.start))}–${esc(date(x.end))} · ${tr('unverified')}</p>`).join('')||`<p class="note">${tr('noData')}</p>`}</details>
</details>${supportPanel()}`;
}

function render(force=false){if(!shell.isConnected)return;updateControls();const out=document.getElementById('v-body');if(!data){out.innerHTML=`<p class="note">${tr('loading')}</p>`;return}const d=data.detail||{},r=data.quota?.rateLimitsByLimitId?.codex||data.quota?.rateLimits,w=[r?.primary,r?.secondary].find(x=>x?.windowDurationMins===10080),valid=!d.scanning&&!d.errors&&d.accountKnown!==false;document.getElementById('v-status').textContent=t(d.accountKnown===false?'accountMissing':failed||data.error?'offline':d.scanning?'loading':d.errors?'readError':'connected');const bubble=document.getElementById('bubble');bubble.textContent=Number.isFinite(w?.usedPercent)?Math.max(0,100-w.usedPercent).toFixed(0)+'%':'—';bubble.classList.toggle('failed',!!(failed||data.error));if(!force&&document.activeElement?.matches('#v-search,#quota-window-details input,#quota-window-details select,.project-edit input'))return;const open=new Set([...out.querySelectorAll('details[open][id]')].map(x=>x.id));const scrolls=[...out.querySelectorAll('.vtable')].map(x=>x.scrollLeft);const warning=valid?'':`<div class="notice">${tr(d.sourceError?'dataFolderMissing':'readWarning')}</div>`;
if(view==='home'){const now=Date.now(),focus=focusQuota(data,now),legacy=!data.quotaWindows,reset=focus?.reset??(legacy?Number(w?.resetsAt)*1000:null),duration=(focus?.duration??(legacy?w?.windowDurationMins:null))*60000,elapsed=Number.isFinite(reset)&&duration>0&&reset>now?Math.max(0,Math.min(100,(now-reset+duration)/duration*100)):null,used=focus?.used??(legacy&&Number.isFinite(w?.usedPercent)?Math.min(100,Math.max(0,w.usedPercent)):null),gap=elapsed!=null&&used!=null?used-elapsed:null,days=reset>now?(reset-now)/86400000:null;let pace=gap==null?'waitingCycle':failed||data.error?'offline':Math.abs(gap)<.5?'paceEven':gap>0?'paceFast':'paceSlow';const list=(d.dayRows||[]).map(x=>({...x,q:valid?x.estimatedQuota:null}));out.innerHTML=`<div class="hero"><div class="tile primary"><div class="caption">${tr('remaining')}${focus?' · '+esc(windowLabel(focus)):''}</div><div class="metric">${used==null?'—':(100-used).toFixed(0)+'%'}</div><div class="pace-row time" title="${tr('cycleHint')}"><span>${tr('elapsed')}</span><div class="mini-track"><i style="width:${elapsed??0}%"></i></div><span>${elapsed==null?'—':elapsed.toFixed(1)+'%'}</span></div><div class="pace-row"><span>${tr('used')}</span><div class="mini-track"><i style="width:${used??0}%"></i></div><span>${used==null?'—':used.toFixed(1)+'%'}</span></div><div class="pace-result ${gap>.5?'fast':''}">${tr(pace,{n:Math.abs(gap||0).toFixed(1)})}</div><div class="note">${days==null?tr('unknownReset'):tr('resetsIn',{d:Math.floor(days),h:Math.floor(days%1*24)})}</div></div>${todayQuotaTile(list,valid,d.quotaHistory?.calendar?.at(-1),d.quotaHistory?.today,d.dayUnverified>0,d.calibration?.models)}<div class="tile"><div class="caption">${tr('todayUsage')}</div><div class="metric">${d.scanning?'—':tok(d.dayTotal)}</div><div class="note">${tr('todayRange')}</div></div></div>${quotaOverview(data)}${connectionGuide(data)}${news()}${warning}<div class="section-title"><h2>${tr('todayConsumption')}</h2><button id="v-all">${tr('allChats')}</button></div>${table(list,5,'quota')}<p class="note">${tr('usageNote')}</p>`;document.getElementById('v-all').onclick=()=>{period='today';query='';select('chats');};const alerts=document.getElementById('toggle-alerts'),testAlert=document.getElementById('test-alert');if(alerts)alerts.onclick=async()=>{await save({alerts:!prefs.alerts});render(true);};if(testAlert)testAlert.onclick=()=>popup(t('notificationTest'));bindQuotaControls();}
else if(view==='projects'){out.innerHTML=projectPanel();bindProjects();}
else if(view==='chats'){out.innerHTML=`<div class="toolbar"><button id="v-today" style="color:${period==='today'?'#9ce7cd':'inherit'}">${tr('today')}</button><button id="v-week" style="color:${period==='week'?'#9ce7cd':'inherit'}">${tr('cycle')}</button><input id="v-search" aria-label="${tr('search')}" placeholder="${tr('search')}" value="${esc(query)}"><button id="v-projects">${tr('projectLedger')}</button><select id="v-sort"><option value="quota">${tr('sortQuota')}</option><option value="tokens">${tr('sortTokens')}</option></select></div>${warning}<div id="v-results"></div><p class="note">${tr('usageNote')}</p>`;const update=()=>{const list=(period==='today'?d.dayRows||[]:d.weekDetailRows||[]).filter(x=>(x.title+' '+x.model+' '+x.effort).toLowerCase().includes(query.toLowerCase())).map(x=>({...x,q:valid?(period==='today'?x.estimatedQuota:x.weekPercent):null}));document.getElementById('v-results').innerHTML=table(list)+(new Set(list.map(x=>x.id)).size>250?`<p class="note">${tr('moreChats',{n:250})}</p>`:'')};update();document.getElementById('v-projects').onclick=()=>select('projects');document.getElementById('v-sort').value=sort;document.getElementById('v-sort').onchange=e=>{sort=e.target.value;update()};document.getElementById('v-search').oninput=e=>{query=e.target.value;update()};document.getElementById('v-today').onclick=()=>{period='today';render(true)};document.getElementById('v-week').onclick=()=>{period='week';render(true)};}
else if(view==='trend'){out.innerHTML=`<div class="section-title"><h2>${tr('dailyTitle')}</h2></div><div class="vtable"><table><thead><tr>${['date','observed','interval','state'].map(k=>`<th>${tr(k)}</th>`).join('')}</tr></thead><tbody>${(d.quotaHistory?.weekly||[]).map(x=>`<tr><td>${esc(x.date)}</td><td>${x.status==='observed'?pct(x.delta):x.status==='conflict'?pct(x.endpointDelta):'—'}</td><td>${x.first&&x.last?clock(x.first.at)+'–'+clock(x.last.at):'—'}</td><td>${tr(({observed:'recorded',missing:'noData',one:'one',conflict:'netChange',reset:'resetDay'})[x.status]||'unknown')}${observationNotes(x)}</td></tr>`).join('')||`<tr><td colspan="4">${tr('noData')}</td></tr>`}</tbody></table></div><p class="note">${tr('dailyNote')}</p>`;}
else {out.innerHTML=researchPanel(d);bindWorkloadHistory();bindSupport();}
for(const id of open){const e=document.getElementById(id);if(e)e.open=true}out.querySelectorAll('.vtable').forEach((e,i)=>e.scrollLeft=scrolls[i]||0)}
for(const h of document.querySelectorAll('[data-resize]'))h.onpointerdown=e=>{if(e.button===0){e.preventDefault();native(h.dataset.resize==='top'?'move':'resize:'+h.dataset.resize)}};
const bubble=document.getElementById('bubble');let start=null,dragged=false;bubble.onpointerdown=e=>{if(e.button!==0)return;start={x:e.screenX,y:e.screenY};dragged=false;bubble.setPointerCapture(e.pointerId)};bubble.onpointermove=e=>{if(start&&!dragged&&Math.hypot(e.screenX-start.x,e.screenY-start.y)>5){dragged=true;native('drag')}};bubble.onpointerup=()=>{if(start&&!dragged)native('expand');start=null};bubble.onpointercancel=()=>start=null;bubble.onkeydown=e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();native('expand')}};
window.chrome?.webview?.addEventListener('message',async e=>{if(typeof e.data==='string'&&e.data.startsWith('data-root-picked:')){try{const selected=JSON.parse(e.data.slice('data-root-picked:'.length));if(selected!==prefs.dataRoot&&await save({dataRoot:selected},'dataFolderInvalid'))native('restart-dashboard')}catch{toast(t('dataFolderInvalid'))}}if(typeof e.data==='string'&&e.data.startsWith('project-folder-picked:')){
 const change=projectPick;projectPick=null;
 if(change)try{await changeProject({...change,folder:JSON.parse(e.data.slice('project-folder-picked:'.length))});}
 catch{toast(t('projectSaveError'));}
}
if(e.data==='panel-hidden')panelVisible=false; if(e.data==='panel-visible'&&!panelVisible){panelVisible=true;void load();} if(e.data==='restart-error')toast(t('restartError')); if(['startup-on','startup-off'].includes(e.data)){startupEnabled=e.data==='startup-on';document.getElementById('startup-setting')?.setAttribute('aria-checked',String(startupEnabled))}if(e.data==='startup-error')toast(t('startupError')); if(['pinned','unpinned'].includes(e.data)){pinned=e.data==='pinned';document.getElementById('toggle-pin').setAttribute('aria-checked',String(pinned))}if(['bubble-on','bubble-off'].includes(e.data)){compact=e.data==='bubble-on';document.getElementById('toggle-bubble').setAttribute('aria-checked',String(compact))}});
let firstLoad=true,manualBusy=false,panelVisible=true;async function manualRefresh(){if(manualBusy)return;manualBusy=true;const mask=document.getElementById('loading-mask');mask.hidden=false;document.getElementById('loading-label').textContent=t('refreshingUsage');const started=Date.now();try{while(busy)await new Promise(r=>setTimeout(r,50));const r=await fetch('/refresh',{cache:'no-store',signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error();while(busy)await new Promise(r=>setTimeout(r,50));await load()}catch{failed=true;render()}finally{await new Promise(r=>setTimeout(r,Math.max(0,350-(Date.now()-started))));mask.hidden=true;manualBusy=false}}
async function load(){if(busy)return;busy=true;try{const r=await fetch('/data',{cache:'no-store',signal:AbortSignal.timeout(45000)});if(!r.ok)throw Error();const next=await r.json();if(data?.quota?.accountId!==next?.quota?.accountId){projectReport=null;projectReportKey=null;projectLoadingKey=null;supportReport=null;}updateState=next.updates||updateState;data=next;failed=false;render();if(!data.nativeAlerts)await notifyNews()}catch{failed=true;if(data)render();else document.getElementById('v-body').innerHTML=`<p class="note">${tr('offline')}</p>`}finally{busy=false;if(firstLoad){firstLoad=false;document.getElementById('loading-mask').hidden=true}}}
build();updateControls();render();native('language:'+prefs.language);native('state');load();setInterval(()=>{if(panelVisible)void load()},5000);
})();
