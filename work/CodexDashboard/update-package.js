const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const application='CodexUsageDashboard';
const versionPattern=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*))?$/;
function compareVersions(a,b){
 const left=versionPattern.exec(a),right=versionPattern.exec(b);
 if(!left||!right)throw Error('Invalid version');
 const numericCompare=(x,y)=>BigInt(x)>BigInt(y)?1:BigInt(x)<BigInt(y)?-1:0;
 for(let index=1;index<=3;index++){
  const difference=numericCompare(left[index],right[index]);
  if(difference)return difference;
 }
 if(left[4]===right[4])return 0;
 if(!left[4])return 1;
 if(!right[4])return -1;
 const aa=left[4].split('.'),bb=right[4].split('.');
 for(let index=0;index<Math.max(aa.length,bb.length);index++){
  if(aa[index]===undefined)return -1;
  if(bb[index]===undefined)return 1;
  if(aa[index]===bb[index])continue;
  const numericA=/^\d+$/.test(aa[index]),numericB=/^\d+$/.test(bb[index]);
  if(numericA&&numericB)return numericCompare(aa[index],bb[index]);
  if(numericA!==numericB)return numericA?-1:1;
  return aa[index]<bb[index]?-1:1;
 }
 return 0;
}

function safeRelative(file){
 if(typeof file!=='string'||file.length>240||/[\\:\x00-\x1f]/.test(file))return false;
 return file.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/[. ]$/.test(part)
  &&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function validateManifest(manifest){
 if(manifest.schema!==1||manifest.application!==application||!versionPattern.test(manifest.version)
  ||manifest.platform!=='win-x64'||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>20000){
  throw Error('Invalid update manifest');
 }
 const names=new Set();
 let bytes=0;
 for(const file of manifest.files){
  if(!safeRelative(file.path)||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<0){
   throw Error('Invalid update file');
  }
  const key=file.path.normalize('NFC').toLowerCase();
  if(names.has(key))throw Error('Duplicate update file');
  names.add(key);bytes+=file.bytes;
 }
 if(bytes>2*1024*1024*1024||!names.has('app-info.json'))throw Error('Unsupported package size or missing identity');
 return manifest;
}
function verifySignedManifest(text,signature,publicKey,{currentVersion,channel='stable',now=Date.now()}){
 if(typeof text!=='string'||Buffer.byteLength(text)>8*1024*1024||typeof signature!=='string'||signature.length>8192){
  throw Error('Invalid signed manifest');
 }
 if(!crypto.verify('sha256',Buffer.from(text),publicKey,Buffer.from(signature,'base64')))throw Error('Invalid update signature');
 const manifest=validateManifest(JSON.parse(text));
 if(manifest.channel!==channel||compareVersions(manifest.version,currentVersion)<=0)throw Error('Update channel or version rejected');
 const expires=Date.parse(manifest.expiresAt);
 if(!Number.isFinite(expires)||expires<=now||expires>now+90*86400000)throw Error('Expired or unbounded update manifest');
 return manifest;
}
function walk(directory,prefix=''){
 const files=[];
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  const name=prefix+entry.name;
  if(entry.isSymbolicLink())throw Error('Links are not permitted in a package');
  if(entry.isDirectory())files.push(...walk(path.join(directory,entry.name),name+'/'));
  else if(entry.isFile())files.push(name);
  else throw Error('Unsupported package entry');
 }
 return files;
}
function verifyTree(directory,manifest){
 if(fs.lstatSync(directory).isSymbolicLink())throw Error('Package root link rejected');
 validateManifest(manifest);
 const expected=new Map(manifest.files.map(file=>[file.path,file]));
 const files=walk(directory);
 if(files.length!==expected.size)throw Error('Package contains unexpected files');
 for(const name of files){
  const record=expected.get(name);
  if(!record)throw Error('Package contains unexpected files');
  const file=path.join(directory,...name.split('/'));
  const stat=fs.statSync(file);
  if(stat.size!==record.bytes||fileDigest(file)!==record.sha256){
   throw Error('Package checksum mismatch');
  }
 }
 const identity=JSON.parse(fs.readFileSync(path.join(directory,'app-info.json'),'utf8'));
 if(identity.name!==application||identity.version!==manifest.version)throw Error('Package identity mismatch');
}
function fileDigest(file){
 const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024),descriptor=fs.openSync(file,'r');
 try{
  let size;
  while((size=fs.readSync(descriptor,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,size));
 }finally{fs.closeSync(descriptor);}
 return hash.digest('hex');
}

function owned(directory){
 try{return JSON.parse(fs.readFileSync(path.join(directory,'app-info.json'),'utf8')).name===application;}
 catch{return false;}
}
function managedPath(target,kind,value){
 const expected=target+kind;
 const resolved=path.resolve(value);
 if(path.dirname(resolved)!==path.dirname(target)||!resolved.startsWith(expected)
  ||(kind!=='.staging-'&&resolved!==expected))throw Error('Invalid installation journal path');
 if(fs.existsSync(resolved)&&fs.lstatSync(resolved).isSymbolicLink())throw Error('Installation link rejected');
 return resolved;
}
function removeOwned(directory){
 if(!fs.existsSync(directory))return;
 if(fs.lstatSync(directory).isSymbolicLink()||!owned(directory))throw Error('Cannot replace an unrecognized installation directory');
 fs.rmSync(directory,{recursive:true,force:true});
}
function writeJournal(file,journal){
 fs.writeFileSync(file+'.tmp',JSON.stringify(journal));
 fs.renameSync(file+'.tmp',file);
}
function recoverInstallation(target){
 target=path.resolve(target);
 const journalFile=target+'.pending.json';
 if(!fs.existsSync(journalFile))return false;
 const journal=JSON.parse(fs.readFileSync(journalFile,'utf8'));
 if(journal.target!==target)throw Error('Installation journal does not match target');
 const stage=managedPath(target,'.staging-',journal.stage);
 const rollback=managedPath(target,'.rollback',journal.rollback);
 const failed=managedPath(target,'.failed',target+'.failed');
 if(fs.existsSync(rollback)){
  if(fs.existsSync(target)){
   removeOwned(failed);
   if(!owned(target))throw Error('Cannot roll back an unrecognized installation');
   fs.renameSync(target,failed);
  }
  fs.renameSync(rollback,target);
 }else if(journal.firstInstall&&journal.phase!=='prepared'&&fs.existsSync(target)){
  removeOwned(failed);
  if(!owned(target))throw Error('Cannot recover an unrecognized first installation');
  fs.renameSync(target,failed);
 }
 if(journal.emptyTarget&&!fs.existsSync(target))fs.mkdirSync(target);
 if(fs.existsSync(stage))removeOwned(stage);
 fs.unlinkSync(journalFile);
 return true;
}

// Windows may briefly keep the installation directory busy while child
// processes and WebView release it after the main window has exited.
async function renameForActivation(from,to){
 for(let attempt=0;;attempt++){
  try{fs.renameSync(from,to);return;}
  catch(error){
   if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=9)throw error;
   await new Promise(resolve=>setTimeout(resolve,Math.min(1000,100*2**attempt)));
  }
 }
}
async function installPackage(source,target,manifest,{healthCheck}={}){
 target=path.resolve(target);
 if(!path.isAbsolute(target)||target===path.parse(target).root)throw Error('Invalid installation target');
 recoverInstallation(target);
 let emptyTarget=false;
 if(fs.existsSync(target)){
  const info=fs.lstatSync(target);
  if(info.isSymbolicLink()||!info.isDirectory())throw Error('Unrecognized installation target');
  if(!owned(target)){
   if(fs.readdirSync(target).length)throw Error('Unrecognized installation target');
   emptyTarget=true;
  }
 }
 verifyTree(source,manifest);
 const stage=target+'.staging-'+crypto.randomUUID();
 const rollback=target+'.rollback';
 const journalFile=target+'.pending.json';
 fs.mkdirSync(path.dirname(target),{recursive:true});
 try{
  fs.cpSync(source,stage,{recursive:true,errorOnExist:true,force:false});
  verifyTree(stage,manifest);
 }catch(error){
  managedPath(target,'.staging-',stage);
  fs.rmSync(stage,{recursive:true,force:true});
  throw error;
 }
 removeOwned(rollback);
 const journal={target,stage,rollback,firstInstall:!fs.existsSync(target)||emptyTarget,emptyTarget,phase:'prepared'};
 writeJournal(journalFile,journal);
 try{
  if(emptyTarget)fs.rmdirSync(target);
  else if(fs.existsSync(target))await renameForActivation(target,rollback);
  journal.phase='old-moved';writeJournal(journalFile,journal);
  fs.renameSync(stage,target);
  journal.phase='activated';writeJournal(journalFile,journal);
  if(healthCheck)await healthCheck(target);
  fs.unlinkSync(journalFile);
  removeOwned(target+'.failed');
  return {target,version:manifest.version,rollback:fs.existsSync(rollback)?rollback:null};
 }catch(error){
  try{recoverInstallation(target);}catch(recoveryError){error.recoveryError=recoveryError.message;}
  throw error;
 }
}

module.exports={compareVersions,safeRelative,validateManifest,verifySignedManifest,verifyTree,installPackage,recoverInstallation};
