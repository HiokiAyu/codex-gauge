const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const packages=require('./CodexDashboard/update-package');
const {readConfig,githubAssetName}=require('./CodexDashboard/update-client');
const setupFiles=new Set(['setup-dependencies/MicrosoftEdgeWebView2RuntimeInstallerX64.exe',
 'setup-dependencies/MicrosoftEdgeWebview2Setup.exe']);
function loadPayload(directory,manifestFile){
 const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8').replace(/^\uFEFF/,''));
 packages.verifyTree(directory,manifest);
 for(const file of manifest.files){
  if(file.path.startsWith('setup-dependencies/')&&!setupFiles.has(file.path))throw Error('Unknown setup-only dependency');
 }
 const identity=JSON.parse(fs.readFileSync(path.join(directory,'app-info.json'),'utf8'));
 return {manifest,identity,files:manifest.files.filter(file=>!setupFiles.has(file.path))};
}
function checkPublicFiles(directory,files){
 const privateMarker=/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
 for(const record of files){
  const base=path.basename(record.path);
  if(/\.(?:sqlite(?:-wal|-shm)?|db|jsonl|pfx|p12|pem|key)$/i.test(base)
   ||/^(?:auth|credentials?|preferences|window-config|value-reference|storage-version)\.json$/i.test(base)){
   throw Error('Private or local data cannot be published');
  }
  const file=path.join(directory,...record.path.split('/')),descriptor=fs.openSync(file,'r');
  const buffer=Buffer.allocUnsafe(1024*1024);let previous='';
  try{
   let bytes;
   while((bytes=fs.readSync(descriptor,buffer,0,buffer.length,null))>0){
    const text=previous+buffer.toString('latin1',0,bytes);
    if(privateMarker.test(text))throw Error('Private key material cannot be published');
    previous=text.slice(-100);
   }
  }finally{fs.closeSync(descriptor);}
 }
}
function validateBuildEvidence(evidenceFile,manifestFile,manifest){
 if(!evidenceFile)throw Error('Build evidence is required for a signed release');
 const value=JSON.parse(fs.readFileSync(evidenceFile,'utf8').replace(/^\uFEFF/,''));
 const digest=crypto.createHash('sha256').update(fs.readFileSync(manifestFile)).digest('hex');
 if(value.version!==manifest.version||value.payloadManifestSha256!==digest||!/^[a-f0-9]{64}$/i.test(value.sourceHash)
  ||!Number.isInteger(value.regressionPassed)||value.regressionPassed<1
  ||value.regressionTotal!=null&&value.regressionPassed!==value.regressionTotal
  ||!Number.isFinite(Date.parse(value.regressionAt)))throw Error('Build evidence does not match a tested payload');
 return value;
}
function inspect({payload,manifestFile,evidenceFile}){
 const loaded=loadPayload(payload,manifestFile);
 checkPublicFiles(payload,loaded.files);
 let config=null,error=null;
 try{config=readConfig(payload);}catch{error='invalid-update-source';}
 const build=evidenceFile?validateBuildEvidence(evidenceFile,manifestFile,loaded.manifest):null;
 return {schema:1,version:loaded.manifest.version,payloadVerified:true,privateFileCheckPassed:true,
  updateConfigured:config?.enabled===true,
  buildEvidenceVerified:!!build,
  blockers:[...(error?[error]:config?.enabled?[]:['update-source-disabled']),...(!build?['build-evidence-not-provided']:[])],
  applicationFiles:loaded.files.length,applicationBytes:loaded.files.reduce((sum,file)=>sum+file.bytes,0),
  systemCodeSignature:'not-evaluated',publication:'local-only'};
}
function webRelative(url,{directory=false}={}){
 const parsed=new URL(url);
 if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash)throw Error('Static publication requires a public HTTPS URL without a query');
 const relative=parsed.pathname.slice(1).split('/').filter((part,index,array)=>part||index!==array.length-1)
  .map(part=>decodeURIComponent(part)).join('/');
 if((!relative&&!directory)||(relative&&!packages.safeRelative(relative))||/[<>?"|*]/.test(relative))throw Error('Unsafe publication URL path');
 return relative;
}
function publicKeyBytes(key){
 return crypto.createPublicKey(key).export({type:'spki',format:'der'});
}
function futureRealPath(filename){
 let existing=path.resolve(filename);const missing=[];
 while(!fs.existsSync(existing)){
  const parent=path.dirname(existing);
  if(parent===existing)throw Error('Output parent is unavailable');
  missing.unshift(path.basename(existing));existing=parent;
 }
 return path.join(fs.realpathSync(existing),...missing);
}
function inside(parent,child){
 const relative=path.relative(parent,child);
 return !relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);
}
function prepare({payload,manifestFile,evidenceFile,keyFile,out,expiresDays=14,passphrase,now=Date.now()}){
 const source=path.resolve(payload),realSource=fs.realpathSync(source),destination=futureRealPath(out);
 if(destination===path.parse(destination).root||inside(realSource,destination)||inside(destination,realSource))throw Error('Output must be a separate new directory');
 if(fs.existsSync(destination))throw Error('Output already exists; review it rather than overwriting a release');
 if(!Number.isInteger(expiresDays)||expiresDays<1||expiresDays>30)throw Error('Use an expiry between one and thirty days');
 const {manifest:original,identity,files}=loadPayload(source,manifestFile);
 const build=validateBuildEvidence(evidenceFile,manifestFile,original);
 checkPublicFiles(source,files);
 const config=readConfig(source);
 if(!config.enabled)throw Error('The payload has no enabled update source; configure a release payload first');
 if(identity.channel!==config.channel||original.channel!==config.channel)throw Error('Payload and update channel do not agree');
 if(config.channel==='stable'&&original.version.includes('-'))throw Error('Prerelease versions require the preview channel');
 const privateKey=crypto.createPrivateKey({key:fs.readFileSync(keyFile),passphrase});
 if(privateKey.asymmetricKeyType!=='rsa'||privateKey.asymmetricKeyDetails.modulusLength<2048)throw Error('Use an RSA key of at least 2048 bits');
 if(!publicKeyBytes(privateKey).equals(publicKeyBytes(config.publicKey)))throw Error('Signing key does not match the client public key');
 if(config.provider==='github'){
  if(files.length>999)throw Error('Too many GitHub release assets');
  const manifest={...original,files,channel:config.channel,expiresAt:new Date(now+expiresDays*86400000).toISOString()};
  const text=JSON.stringify(manifest),signature=crypto.sign('sha256',Buffer.from(text),privateKey).toString('base64');
  packages.verifySignedManifest(text,signature,config.publicKey,{currentVersion:'0.0.0-0',channel:config.channel,now});
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  const stage=destination+'.preparing-'+crypto.randomUUID();fs.mkdirSync(stage);
  try{
   const assets=path.join(stage,'assets');fs.mkdirSync(assets);
   for(const record of files)fs.copyFileSync(path.join(source,...record.path.split('/')),path.join(assets,githubAssetName(record.path)));
   fs.writeFileSync(path.join(assets,'manifest.json'),JSON.stringify({manifest:text,signature}));
   const review={schema:1,provider:'github',repository:config.repository,version:manifest.version,channel:manifest.channel,
    preparedAt:new Date(now).toISOString(),expiresAt:manifest.expiresAt,applicationFiles:files.length,
    publicKeySha256:crypto.createHash('sha256').update(publicKeyBytes(config.publicKey)).digest('hex'),
    buildSourceHash:build.sourceHash,regressionPassed:build.regressionPassed,publication:'local-only'};
   fs.writeFileSync(path.join(stage,'release-review.json'),JSON.stringify(review,null,2));
   fs.writeFileSync(path.join(stage,'部署说明.txt'),'这里只生成本地发行材料，尚未发布。\n将 assets 内所有文件上传到同一 GitHub Release。正式版须设为 latest；预览版使用 ota-preview 标签并设为预发布。\n先上传全部附件，检查完整性后再发布；签名清单到期前需要重新签名并更新附件。不要上传私钥。\n');
   fs.renameSync(stage,destination);return review;
  }catch(error){fs.rmSync(stage,{recursive:true,force:true});throw error;}
 }
 const feedPath=webRelative(config.manifestUrl),filesPath=webRelative(config.filesBaseUrl,{directory:true});
 const prefix=(filesPath?filesPath+'/':'')+original.version+'/';
 const fold=value=>value.normalize('NFC').toLowerCase();
 if(fold(feedPath).startsWith(fold(prefix))||fold(feedPath)===fold(filesPath)
  ||fold(filesPath).startsWith(fold(feedPath)+'/'))throw Error('Feed path conflicts with application files');
 const manifest={...original,files,channel:config.channel,expiresAt:new Date(now+expiresDays*86400000).toISOString()};
 const text=JSON.stringify(manifest),signature=crypto.sign('sha256',Buffer.from(text),privateKey).toString('base64');
 packages.verifySignedManifest(text,signature,config.publicKey,{currentVersion:'0.0.0-0',channel:config.channel,now});
 const envelope={manifest:text,signature};
 fs.mkdirSync(path.dirname(destination),{recursive:true});
 const stage=destination+'.preparing-'+crypto.randomUUID();
 fs.mkdirSync(stage);
 try{
  const site=path.join(stage,'site'),application=path.join(site,...filesPath.split('/'),manifest.version);
  fs.mkdirSync(application,{recursive:true});
  for(const record of files){
   const relative=path.join(...record.path.split('/')),target=path.join(application,relative);
   fs.mkdirSync(path.dirname(target),{recursive:true});
   fs.copyFileSync(path.join(source,relative),target);
  }
  packages.verifyTree(application,manifest);
  const feed=path.join(site,...feedPath.split('/'));
  fs.mkdirSync(path.dirname(feed),{recursive:true});
  fs.writeFileSync(feed,JSON.stringify(envelope));
  const review={schema:1,version:manifest.version,channel:manifest.channel,preparedAt:new Date(now).toISOString(),
   expiresAt:manifest.expiresAt,manifestUrl:config.manifestUrl,filesBaseUrl:config.filesBaseUrl,
   publicKeySha256:crypto.createHash('sha256').update(publicKeyBytes(config.publicKey)).digest('hex'),
   applicationFiles:files.length,applicationBytes:files.reduce((sum,file)=>sum+file.bytes,0),
   feedSha256:crypto.createHash('sha256').update(fs.readFileSync(feed)).digest('hex'),
   buildSourceHash:build.sourceHash,regressionPassed:build.regressionPassed,
   systemCodeSignature:'not-evaluated',publication:'local-only',
   deploymentOrder:['immutable version files','signed feed last'],
   expirationRequiresRefresh:true};
  fs.writeFileSync(path.join(stage,'release-review.json'),JSON.stringify(review,null,2));
  fs.writeFileSync(path.join(stage,'部署说明.txt'),
   '这里只生成本地发行材料，尚未发布。\n仅将 site 目录内容部署到配置的 HTTPS 源站。\n先上传版本文件并校验，再替换清单；保留旧版本回退所需文件。\n代码签名、HTTPS 实际可达性与客户端更新仍需验收。\n签名清单到期前须刷新并重新签名；本工具不会自动上传。\n私钥、密码与 release-review.json 不需要上传。\n');
  fs.renameSync(stage,destination);
  return review;
 }catch(error){
  // This randomly named directory was allocated above by this invocation.
  fs.rmSync(stage,{recursive:true,force:true});throw error;
 }
}
module.exports={inspect,prepare,webRelative};
if(require.main===module){
 try{
  const [action,...values]=process.argv.slice(2),options={};
  const allowed=new Set(['payload','manifest','evidence','key','out','days']);
  for(let index=0;index<values.length;index+=2){
   if(!values[index]?.startsWith('--')||!values[index+1])throw Error('Expected option/value pairs');
   const name=values[index].slice(2);
   if(!allowed.has(name)||Object.hasOwn(options,name))throw Error('Unsupported or duplicate option');
   options[name]=values[index+1];
  }
  const shared={payload:options.payload,manifestFile:options.manifest,evidenceFile:options.evidence};
  const result=action==='inspect'?inspect(shared):action==='prepare'?prepare({...shared,keyFile:options.key,
   out:options.out,expiresDays:Number(options.days||14),passphrase:process.env.CODEX_USAGE_RELEASE_KEY_PASSPHRASE}):null;
  if(!result)throw Error('Use inspect or prepare');
  console.log(JSON.stringify(result,null,2));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
