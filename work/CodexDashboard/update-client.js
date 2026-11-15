const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const packages=require('./update-package');
const appName='CodexUsageDashboard';
function readConfig(directory){
 const value=JSON.parse(fs.readFileSync(path.join(directory,'update-source.json'),'utf8').replace(/^\uFEFF/,''));
 if(value.enabled!==true)return {enabled:false};
 if(value.provider==='github'){
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository||'')||value.repository.split('/').some(s=>s==='.'||s==='..')||!['stable','preview'].includes(value.channel))throw Error('Invalid GitHub update configuration');
  const key=crypto.createPublicKey(value.publicKey);
  if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<2048)throw Error('Invalid update key');
  return value;
 }
 const manifest=new URL(value.manifestUrl),files=new URL(value.filesBaseUrl);
 if(manifest.protocol!=='https:'||files.protocol!=='https:'||manifest.origin!==files.origin
  ||manifest.username||manifest.password||files.username||files.password||files.search||files.hash
  ||!files.pathname.endsWith('/')||!['stable','preview'].includes(value.channel))throw Error('Invalid update configuration');
 const key=crypto.createPublicKey(value.publicKey);
 if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<2048)throw Error('Invalid update key');
 return {...value,enabled:true};
}
async function hashFile(file){
 const hash=crypto.createHash('sha256');
 for await(const chunk of fs.createReadStream(file))hash.update(chunk);
 return hash.digest('hex');
}
async function responseAt(fetchImpl,url){
 const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(120000)});
 if(!response.ok||response.redirected)throw Error('Update download failed');
 return response;
}
function githubAssetName(file){return 'file-'+crypto.createHash('sha256').update(file,'utf8').digest('hex')+'.bin';}
function githubAssetUrl(config,name){
 const release=config.channel==='stable'?'latest/download':'download/ota-preview';
 return `https://github.com/${config.repository}/releases/${release}/${name}`;
}
async function githubResponse(fetchImpl,url){
 const hosts=new Set(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','github-releases.githubusercontent.com']);
 for(let count=0;count<6;count++){
  const u=new URL(url);
  if(u.protocol!=='https:'||u.username||u.password||!hosts.has(u.hostname)||u.port)throw Error('Untrusted GitHub redirect');
  const response=await fetchImpl(u.href,{redirect:'manual',signal:AbortSignal.timeout(120000)});
  if([301,302,303,307,308].includes(response.status)){
   const location=response.headers.get('location');if(!location)throw Error('Missing redirect');url=new URL(location,u).href;continue;
  }
  if(response.status===404){const error=Error('GitHub update asset not found');error.code='GITHUB_ASSET_MISSING';throw error;}
  if(!response.ok||response.redirected)throw Error('GitHub download failed');
  return response;
 }
 throw Error('Too many redirects');
}
async function limitedJson(response,limit){
 const chunks=[];let bytes=0;
 for await(const chunk of response.body){
  bytes+=chunk.length;if(bytes>limit)throw Error('Update response too large');
  chunks.push(chunk);
 }
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function checkEnvelope(envelope,config,currentVersion){
 return packages.verifySignedManifest(envelope.manifest,envelope.signature,config.publicKey,{currentVersion,channel:config.channel});
}
function pruneStages(directory,dataDirectory){
 const parent=path.join(path.resolve(dataDirectory),'updates');
 if(!fs.existsSync(parent))return;
 let retained=null;
 try{retained=path.resolve(JSON.parse(fs.readFileSync(path.join(parent,'ready.json'),'utf8')).root);}catch{}
 for(const entry of fs.readdirSync(parent,{withFileTypes:true})){
  if(!entry.isDirectory()||!/^stage-[a-f0-9-]{36}$/.test(entry.name))continue;
  const folder=path.join(parent,entry.name);
  if(folder===retained||path.resolve(directory).startsWith(folder+path.sep))continue;
  try{
   if(fs.lstatSync(folder).isSymbolicLink()||JSON.parse(fs.readFileSync(path.join(folder,'owner.json'),'utf8')).application!==appName)continue;
   let active=false;
   try{
    const {pid}=JSON.parse(fs.readFileSync(path.join(folder,'active.json'),'utf8'));
    if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid,0);active=true;}catch{}}
   }catch{}
   if(!active)fs.rmSync(folder,{recursive:true,force:true});
  }catch{}
 }
}
function createService({directory,dataDirectory,fetchImpl=fetch}){
 pruneStages(directory,dataDirectory);
 const current=JSON.parse(fs.readFileSync(path.join(directory,'app-info.json'),'utf8'));
 let config,state;
 try{config=readConfig(directory);state={status:config.enabled?'idle':'unconfigured'};}
 catch{config={enabled:false};state={status:'invalid-config'};}
 let envelope=null,manifest=null,checkFlight=null,stageFlight=null;
 const parent=path.join(dataDirectory,'updates');
 const status=()=>({...state});
 async function check(){
  if(!config.enabled)return status();
  if(stageFlight)return status();
  if(checkFlight)return checkFlight;
  checkFlight=(async()=>{
   state={status:'checking'};
   try{
    const response=config.provider==='github'?await githubResponse(fetchImpl,githubAssetUrl(config,'manifest.json')):await responseAt(fetchImpl,config.manifestUrl);
    const incoming=await limitedJson(response,8*1024*1024);
    // Even an equal-version response must be authentic and bounded.
    const parsed=packages.verifySignedManifest(incoming.manifest,incoming.signature,config.publicKey,
     {currentVersion:'0.0.0-0',channel:config.channel});
    if(packages.compareVersions(parsed.version,current.version)<=0){
     manifest=envelope=null;state={status:'current',checkedAt:Date.now()};return status();
    }
    manifest=checkEnvelope(incoming,config,current.version);envelope=incoming;
    let ready=false;
    try{ready=verifyReady(directory,dataDirectory).manifest.version===manifest.version;}catch{}
    state={status:ready?'ready':'available',version:manifest.version,checkedAt:Date.now()};
   }catch(error){state={status:config.provider==='github'&&error.code==='GITHUB_ASSET_MISSING'?'unavailable':'error',checkedAt:Date.now()};}
   return status();
  })().finally(()=>{checkFlight=null;});
  return checkFlight;
 }
 async function stage(){
  if(stageFlight)return stageFlight;
  stageFlight=(async()=>{
   if(checkFlight)await checkFlight;
   if(!manifest||!envelope||!config.enabled)throw Error('No verified update available');
   if(state.status==='ready')return status();
   const signed=envelope;
   const candidate=checkEnvelope(signed,config,current.version);
   const total=candidate.files.reduce((sum,file)=>sum+file.bytes,0);
   fs.mkdirSync(parent,{recursive:true});
   const disk=fs.statfsSync(parent,{bigint:true});
   if(disk.bavail*disk.bsize<BigInt(total)*2n+104857600n)throw Error('Insufficient update disk space');
   const root=path.join(parent,'stage-'+crypto.randomUUID()),payload=path.join(root,'application');
   fs.mkdirSync(payload,{recursive:true});
   fs.writeFileSync(path.join(root,'owner.json'),JSON.stringify({application:appName}));
   let reusedBytes=0,downloadedBytes=0;
   state={status:'downloading',version:candidate.version,totalBytes:total,reusedBytes,downloadedBytes};
   try{
    for(const file of candidate.files){
     const destination=path.join(payload,...file.path.split('/'));
     fs.mkdirSync(path.dirname(destination),{recursive:true});
     const existing=path.join(directory,...file.path.split('/'));
     let reuse=false;
     try{reuse=fs.statSync(existing).isFile()&&fs.statSync(existing).size===file.bytes&&(await hashFile(existing))===file.sha256;}catch{}
     if(reuse){fs.copyFileSync(existing,destination);reusedBytes+=file.bytes;}
     else{
      let response;
      if(config.provider==='github')response=await githubResponse(fetchImpl,githubAssetUrl(config,githubAssetName(file.path)));
      else{
       const relative=candidate.version+'/'+file.path.split('/').map(encodeURIComponent).join('/');
       const url=new URL(relative,config.filesBaseUrl);
       if(url.origin!==new URL(config.filesBaseUrl).origin)throw Error('Invalid update file URL');
       response=await responseAt(fetchImpl,url.href);
      }
      const descriptor=fs.openSync(destination,'wx');
      let received=0;
      const hash=crypto.createHash('sha256');
      try{
       for await(const chunk of response.body){
        received+=chunk.length;if(received>file.bytes)throw Error('Update file too large');
        hash.update(chunk);
        let offset=0;
        while(offset<chunk.length)offset+=fs.writeSync(descriptor,chunk,offset,chunk.length-offset);
        downloadedBytes+=chunk.length;state={...state,downloadedBytes};
       }
      }finally{fs.closeSync(descriptor);}
      if(received!==file.bytes||hash.digest('hex')!==file.sha256)throw Error('Update file checksum mismatch');
     }
     state={...state,reusedBytes,downloadedBytes};
    }
    packages.verifyTree(payload,candidate);
    fs.writeFileSync(path.join(root,'signed.json'),JSON.stringify(signed));
    fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(candidate));
    fs.writeFileSync(path.join(parent,'ready.json.tmp'),JSON.stringify({root,version:candidate.version}));
    fs.renameSync(path.join(parent,'ready.json.tmp'),path.join(parent,'ready.json'));
    state={...state,status:'ready'};
    return status();
   }catch(error){
    // root was just allocated by this invocation and never comes from a server.
    fs.rmSync(root,{recursive:true,force:true});
    state={status:'error',version:candidate.version};throw error;
   }
  })().finally(()=>{stageFlight=null;});
  return stageFlight;
 }
 return {status,check,stage};
}
function verifyReady(directory,dataDirectory){
 const parent=path.join(path.resolve(dataDirectory),'updates');
 const ready=JSON.parse(fs.readFileSync(path.join(parent,'ready.json'),'utf8'));
 const root=path.resolve(ready.root);
 if(path.dirname(root)!==parent||!/^stage-[a-f0-9-]{36}$/.test(path.basename(root))
  ||fs.lstatSync(root).isSymbolicLink())throw Error('Invalid staged update');
 const config=readConfig(directory);
 if(!config.enabled)throw Error('Updates are not configured');
 const current=JSON.parse(fs.readFileSync(path.join(directory,'app-info.json'),'utf8'));
 if(current.name!==appName)throw Error('Invalid installation identity');
 const envelope=JSON.parse(fs.readFileSync(path.join(root,'signed.json'),'utf8'));
 const manifest=checkEnvelope(envelope,config,current.version);
 if(manifest.version!==ready.version)throw Error('Staged version mismatch');
 const payload=path.join(root,'application');
 packages.verifyTree(payload,manifest);
 if(!fs.existsSync(path.join(payload,'Codex大看板.exe'))||!fs.existsSync(path.join(payload,'runtime','node.exe')))throw Error('Update runtime missing');
 return {root,payload,manifest};
}
async function applyReady(directory,dataDirectory,{integrate=false}={}){
 const ready=verifyReady(directory,dataDirectory);
 fs.writeFileSync(path.join(ready.root,'active.json'),JSON.stringify({pid:process.pid}));
 const options={target:path.resolve(directory),source:ready.payload,manifest:path.join(ready.root,'manifest.json'),dataDirectory,integrate};
 // Regenerate this unsigned helper input from the authenticated manifest.
 fs.writeFileSync(options.manifest,JSON.stringify(ready.manifest));
 const request=path.join(ready.root,'install-request.json');
 fs.writeFileSync(request,JSON.stringify(options));
 const result=spawnSync(process.execPath,[path.join(__dirname,'install-worker.js'),request],{
  windowsHide:true,encoding:'utf8',timeout:600000,maxBuffer:1024*1024
 });
 if(result.error||result.status!==0)throw Error('Update activation failed');
 fs.rmSync(path.join(dataDirectory,'updates','ready.json'),{force:true});
 return {success:true,version:ready.manifest.version};
}
module.exports={readConfig,createService,verifyReady,applyReady,pruneStages,githubAssetName,githubAssetUrl,githubResponse};
if(require.main===module){
 const [action,directory,dataDirectory]=process.argv.slice(2);
 (async()=>{
  if(action==='--verify-ready'){
   const ready=verifyReady(directory,dataDirectory);console.log(JSON.stringify({executable:path.join(ready.payload,'Codex大看板.exe')}));
  }else if(action==='--apply'){
   console.log(JSON.stringify(await applyReady(directory,dataDirectory,{integrate:process.argv.includes('--integrate')})));
  }else throw Error('Invalid update request');
 })().catch(()=>{console.error('Update could not be verified or installed.');process.exitCode=1;});
}
