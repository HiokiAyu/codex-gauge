const path=require('node:path');
const {randomUUID}=require('node:crypto');

function normalizeFolder(value){
 if(typeof value!=='string'||!value||value.length>1024||/[\x00-\x1f]/.test(value))return null;
 const windows=/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(value);
 const dialect=windows?path.win32:path.posix;
 if(!dialect.isAbsolute(value))return null;
 if(windows&&value.startsWith('\\\\?\\'))value=value.slice(4).replace(/^UNC\\/i,'\\\\');
 let result=dialect.normalize(value);
 if(result!==dialect.parse(result).root)result=result.replace(/[\\/]$/,'');
 return windows?result.toLowerCase():result;
}

function updateProjects(projects,change){
 if(!change||typeof change!=='object')throw Error('Invalid project');
 if(change.action==='remove'){
  if(!projects.some(p=>p.id===change.id))throw Error('Unknown project');
  return projects.filter(p=>p.id!==change.id);
 }
 if(!['save','attach'].includes(change.action))throw Error('Unknown project action');
 const existing=projects.find(p=>p.id===change.id);
 if(change.id&&!existing||change.action==='attach'&&!existing)throw Error('Unknown project');
 const name=(change.name??existing?.name)?.trim();
 if(!name||name.length>80||normalizeFolder(name)||/[\x00-\x1f]/.test(name))throw Error('Invalid project name');
 const root=change.folder===undefined?null:normalizeFolder(change.folder);
 if(change.folder!==undefined&&!root||!existing&&!root)throw Error('Invalid folder');
 if(root&&projects.some(p=>p.id!==existing?.id&&p.roots.includes(root)))throw Error('Folder already assigned');
 const roots=[...new Set([...(existing?.roots||[]),...(root?[root]:[])])];
 if(roots.length>32||!existing&&projects.length>=64)throw Error('Project limit reached');
 const next={id:existing?.id||randomUUID(),name,roots};
 return existing?projects.map(p=>p===existing?next:p):[...projects,next];
}

function projectFor(folder,roots){
 const current=normalizeFolder(folder);
 if(!current)return null;
 return roots.find(({root})=>{
  const separator=root.startsWith('/')?'/':'\\';
  return current===root||current.startsWith(root.endsWith(separator)?root:root+separator);
 })?.project??null;
}

function getProjectReport({detail,threads,projects,period,model='',effort='',now}){
 const day=period==='today';
 const sourceRows=(day?detail.dayRows:detail.weekDetailRows)||[];
 const start=day?detail.dayStart:detail.weekStart;
 const cycleEnd=day?(detail.dayEnd??start+86400000):detail.weekEnd;
 const end=Number.isFinite(start)&&Number.isFinite(cycleEnd)?cycleEnd:null;
 const models=[...new Set(sourceRows.map(row=>row.model))].sort();
 const efforts=[...new Set(sourceRows.map(row=>row.effort))].sort();
 const roots=projects.flatMap(project=>project.roots.map(root=>({root,project}))).sort((a,b)=>b.root.length-a.root.length);
 const threadProjects=new Map(threads.map(thread=>[thread.id,projectFor(thread.projectFolder,roots)]));
 const groups=new Map();
 const blank=()=>({tokens:0,input:0,cached:0,output:0,knownQuota:0,unknownTokens:0,partial:false});
 const total=blank();
 const useEstimate=!detail.scanning&&!detail.errors&&detail.accountKnown!==false;
 for(const row of sourceRows){
  if(model&&row.model!==model||effort&&row.effort!==effort)continue;
  const project=threadProjects.get(row.id)||null;
  const key=project?.id??null;
  if(!groups.has(key))groups.set(key,{id:key,name:project?.name??null,...blank(),sessions:[]});
  const group=groups.get(key);
  const estimate=day?row.estimatedQuota:row.weekPercent;
  const values={tokens:row.total,input:row.input,cached:row.cached,output:row.output,
   knownQuota:useEstimate?row.weight:0,unknownTokens:useEstimate?row.unknown:row.total};
  for(const name of Object.keys(values)){
   const value=Number.isFinite(values[name])?values[name]:0;
   values[name]=value;
   group[name]+=value;
   total[name]+=value;
  }
  group.partial=group.partial||!useEstimate||estimate==null;
  total.partial=total.partial||group.partial;
  group.sessions.push({id:row.id,title:row.title,model:row.model,effort:row.effort,tier:row.tier,...values,
   estimate:useEstimate?estimate:null});
 }
 const selected=Array.from(groups.values()).sort((a,b)=>b.tokens-a.tokens);
 for(const group of selected)group.sessions.sort((a,b)=>b.tokens-a.tokens);
 return {period,timezone:detail.timeZone||'Asia/Shanghai',start:start??null,end,asOf:now,model,effort,models,efforts,total,
  coverageStart:detail.coverageStart,available:detail.accountKnown===true&&end!=null,
  groups:selected,projects:projects.map(p=>({id:p.id,name:p.name,folders:p.roots.length}))};
}

function csvCell(value){
 let text=String(value??'');
 if(typeof value==='string'&&/^[\s\ufeff]*[=+\-@]/.test(text))text="'"+text;
 return '"'+text.replace(/"/g,'""')+'"';
}
function projectCsv(report){
 const header=['period','start_inclusive','end_exclusive','time_zone','snapshot_at','scope','project','model','effort','tier',
  'local_tokens','input_tokens','cached_input_tokens','output_tokens','known_quota_percentage_points',
  'tokens_without_estimate','partial_estimate','model_filter','effort_filter','coverage_start'];
 const asDate=value=>Number.isFinite(value)?new Date(value).toISOString():null;
 const common=[report.period,asDate(report.start),asDate(report.end),report.timezone,asDate(report.asOf)];
 const filter=[report.model,report.effort,asDate(report.coverageStart)];
 const rows=[header];
 const add=(scope,name,model,effort,tier,values,partial)=>rows.push([
  ...common,scope,name,model,effort,tier,values.tokens,values.input,values.cached,values.output,
  values.knownQuota,values.unknownTokens,partial,...filter
 ]);
 add('total',null,null,null,null,report.total,report.total.partial);
 for(const group of report.groups){
  add(group.id?'project':'unassigned',group.name,null,null,null,group,group.partial);
  const models=new Map();
  for(const row of group.sessions){
   const key=JSON.stringify([row.model,row.effort,row.tier]);
   if(!models.has(key))models.set(key,{tokens:0,input:0,cached:0,output:0,knownQuota:0,unknownTokens:0,partial:false});
   const summed=models.get(key);
   for(const name of ['tokens','input','cached','output','knownQuota','unknownTokens'])summed[name]+=row[name]||0;
   summed.partial=summed.partial||row.estimate==null;
  }
  for(const [key,values] of models)add('profile',group.name,...JSON.parse(key),values,values.partial);
 }
 return '\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}

module.exports={normalizeFolder,updateProjects,getProjectReport,projectCsv};
