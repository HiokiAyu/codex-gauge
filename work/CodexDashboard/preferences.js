const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {validWindowKey}=require('./quota-windows');
const {updateProjects}=require('./project-ledger');
const {resolveTimeZone}=require('./time-zone');

const file=path.join(process.env.LOCALAPPDATA||os.tmpdir(),'CodexUsageDashboard','preferences.json');
const defaults={language:'zh-CN',alerts:true,resetNewsEnabled:true,trayOnClose:true,theme:'dark',
 dataRoot:null,seenNews:[],budgets:{},budgetAlerts:true,bubbleWindow:'urgent',onboardingDismissed:false,projects:[],timeZone:'system'};
let state={...defaults};
try{
 const saved=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 if(!Object.hasOwn(saved,'bubbleWindow'))state.bubbleWindow=null;
 if(!Object.hasOwn(saved,'timeZone'))state.timeZone='Asia/Shanghai';
 for(const key of Object.keys(defaults))if(Object.hasOwn(saved,key))state[key]=saved[key];
 if(typeof state.trayOnClose!=='boolean')state.trayOnClose=defaults.trayOnClose;
 state.budgets=Object.fromEntries(Object.entries(state.budgets||{})
  .filter(([key,reserve])=>validWindowKey(key)&&validReserve(reserve)));
 try{resolveTimeZone(state.timeZone);}catch{state.timeZone='Asia/Shanghai';}
}catch{}

function locales(){
 const dir=path.join(__dirname,'locales');
 return fs.readdirSync(dir).filter(name=>/^[a-zA-Z0-9-]+\.json$/.test(name)).map(name=>{
  try{return JSON.parse(fs.readFileSync(path.join(dir,name),'utf8').replace(/^\uFEFF/,''));}
  catch{return null;}
 }).filter(catalog=>catalog&&typeof catalog.id==='string'&&catalog.strings);
}

function validReserve(value){return Number.isInteger(value)&&value>=0&&value<=99;}

function update(patch){
 if(!patch||typeof patch!=='object'||Array.isArray(patch))throw Error('Invalid preferences');
 const next={...state};
 if(Object.hasOwn(patch,'timeZone')){
  resolveTimeZone(patch.timeZone);
  next.timeZone=patch.timeZone??'system';
 }
 if(Object.hasOwn(patch,'dataRoot'))next.dataRoot=require('./data-root').validate(patch.dataRoot);
 if(typeof patch.language==='string'&&locales().some(catalog=>catalog.id===patch.language))next.language=patch.language;
 for(const key of ['alerts','trayOnClose','resetNewsEnabled','budgetAlerts','onboardingDismissed']){
  if(typeof patch[key]==='boolean')next[key]=patch[key];
 }
 if(['dark','light'].includes(patch.theme))next.theme=patch.theme;
 if(Array.isArray(patch.seenNews)){
  next.seenNews=[...new Set([...state.seenNews,...patch.seenNews.filter(id=>typeof id==='string'&&id.length<120)])].slice(-500);
 }
 if(Object.hasOwn(patch,'bubbleWindow')){
  if(patch.bubbleWindow!==null&&patch.bubbleWindow!=='urgent'&&!validWindowKey(patch.bubbleWindow))throw Error('Invalid window');
  next.bubbleWindow=patch.bubbleWindow;
 }
 if(Object.hasOwn(patch,'budgetRule')){
  const {key,reserve}=patch.budgetRule;
  if(!validWindowKey(key)||reserve!==null&&!validReserve(reserve))throw Error('Invalid reserve');
  next.budgets={...state.budgets};
  if(reserve===null)delete next.budgets[key];
  else next.budgets[key]=reserve;
  if(Object.keys(next.budgets).length>64)throw Error('Too many rules');
 }
 if(Object.hasOwn(patch,'projectChange'))next.projects=updateProjects(state.projects,patch.projectChange);
 fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file+'.tmp',JSON.stringify(next));
 fs.renameSync(file+'.tmp',file);
 state=next;
 return state;
}
module.exports={locales,update,get:()=>state};
