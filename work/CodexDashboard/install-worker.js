const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {installPackage,verifyTree}=require('./update-package');
const {makeBackup,readBackup,pruneBackups}=require('./storage-backup');

function run(executable,args,{env,timeout=30000}={}){
 const result=spawnSync(executable,args,{windowsHide:true,encoding:'utf8',env:env??process.env,timeout});
 if(result.error||result.status!==0)throw Error('Subprocess failed ('+result.status+'): '+(result.error?.message||result.stderr||'').slice(0,2000));
 return result.stdout;
}
function stopInstalledApp(target,source){
 const app=path.join(target,'Codex大看板.exe');
 if(fs.existsSync(app))run(path.join(source,'Codex大看板.exe'),['--shutdown-target',app],{timeout:20000});
}
function checkRuntime(target,resultFile,dependencyDirectory){
 const app=path.join(target,'Codex大看板.exe');
 const checked=spawnSync(app,['--health-check',resultFile],{windowsHide:true,timeout:30000});
 let report=null;
 try{report=JSON.parse(fs.readFileSync(resultFile,'utf8'));}catch{}
 if(checked.error||checked.status!==0||!report?.healthy){
  if(report?.error==='webview-missing'){
   const directory=dependencyDirectory&&fs.existsSync(dependencyDirectory)?dependencyDirectory:path.join(target,'runtime');
   const standalone=path.join(directory,'MicrosoftEdgeWebView2RuntimeInstallerX64.exe');
   const bootstrap=path.join(directory,'MicrosoftEdgeWebview2Setup.exe');
   const installer=fs.existsSync(standalone)?standalone:bootstrap;
   if(fs.existsSync(installer)){
    run(installer,['/silent','/install'],{timeout:180000});
    run(app,['--health-check',resultFile],{timeout:30000});
    report=JSON.parse(fs.readFileSync(resultFile,'utf8'));
   }
  }
  if(!report?.healthy)throw Error('Installed runtime health check failed: '+(report?.error||'no-report')+' (exit '+checked.status+')');
 }
}
function applicationPayload(source,manifest,destination){
 verifyTree(source,manifest);
 const setupFiles=new Set([
  'setup-dependencies/MicrosoftEdgeWebView2RuntimeInstallerX64.exe',
  'setup-dependencies/MicrosoftEdgeWebview2Setup.exe'
 ]);
 const files=manifest.files.filter(file=>!file.path.startsWith('setup-dependencies/'));
 for(const file of manifest.files){
  if(file.path.startsWith('setup-dependencies/')&&!setupFiles.has(file.path))throw Error('Unknown setup dependency');
 }
 if(files.length===manifest.files.length)return {source,manifest};
 fs.mkdirSync(destination,{recursive:true});
 for(const file of files){
  const name=path.join(...file.path.split('/'));
  const target=path.join(destination,name);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(path.join(source,name),target);
 }
 const applicationManifest={...manifest,files};
 verifyTree(destination,applicationManifest);
 return {source:destination,manifest:applicationManifest};
}
function checkMigration(source,dataBackup,temporary){
 const isolated=path.join(temporary,'profile');
 const data=path.join(isolated,'CodexUsageDashboard');
 fs.mkdirSync(data,{recursive:true});
 if(dataBackup){
  const manifest=readBackup(dataBackup);
  for(const file of manifest.files)fs.copyFileSync(path.join(dataBackup,file.name),path.join(data,file.name));
 }
 const env={...process.env,LOCALAPPDATA:isolated};
 const result=run(path.join(source,'runtime','node.exe'),[path.join(source,'backend.js'),'0','--storage-probe'],{env});
 if(!JSON.parse(result.trim()).healthy)throw Error('Data migration check failed');
}

async function main(){
 const options=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
 const manifest=JSON.parse(fs.readFileSync(options.manifest,'utf8'));
 const data=options.dataDirectory||path.join(process.env.LOCALAPPDATA,'CodexUsageDashboard');
 stopInstalledApp(options.target,options.source);
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'codex-install-'));
 let dataBackup=null;
 try{
  if(fs.existsSync(data)&&fs.readdirSync(data).length){
   dataBackup=makeBackup(data,'before-install');
  }
  console.log(JSON.stringify({stage:'migration'}));
  checkMigration(options.source,dataBackup,temporary);
  console.log(JSON.stringify({stage:'activation'}));
  const application=applicationPayload(options.source,manifest,path.join(temporary,'application'));
  const result=await installPackage(application.source,options.target,application.manifest,{
   healthCheck:target=>{
    checkRuntime(target,path.join(temporary,'health.json'),path.join(options.source,'setup-dependencies'));
    if(options.integrate){
     const args=['--register'];
     if(typeof options.startup==='boolean')args.push(options.startup?'--startup-on':'--startup-off');
     if(typeof options.desktop==='boolean')args.push(options.desktop?'--desktop-on':'--desktop-off');
     run(path.join(target,'Codex大看板.exe'),args);
    }
   }
  });
  if(dataBackup)pruneBackups(data);
  console.log(JSON.stringify({stage:'complete',...result,dataBackup}));
 }finally{
  fs.rmSync(temporary,{recursive:true,force:true});
 }
}

if(require.main===module)main().catch(error=>{
 console.error(error.message);
 process.exitCode=1;
});
module.exports={checkMigration,checkRuntime,stopInstalledApp,applicationPayload};
