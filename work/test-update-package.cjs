const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {installPackage,verifyTree,verifySignedManifest,safeRelative,compareVersions,recoverInstallation}=require('./CodexDashboard/update-package');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-update-'));
const source=path.join(root,'source');
const target=path.join(root,'installed');
fs.mkdirSync(source);
function packageAt(version){
 fs.writeFileSync(path.join(source,'app-info.json'),JSON.stringify({name:'CodexUsageDashboard',version}));
 fs.writeFileSync(path.join(source,'program.txt'),version);
 return {schema:1,application:'CodexUsageDashboard',version,platform:'win-x64',channel:'stable',
  expiresAt:new Date(Date.now()+86400000).toISOString(),files:fs.readdirSync(source).map(name=>{
   const bytes=fs.readFileSync(path.join(source,name));
   return {path:name,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
  })};
}
async function test(){
 const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 let manifest=packageAt('1.0.0');
 const text=JSON.stringify(manifest);
 const signature=crypto.sign('sha256',Buffer.from(text),keys.privateKey).toString('base64');
 assert.equal(verifySignedManifest(text,signature,keys.publicKey,{currentVersion:'0.9.0'}).version,'1.0.0');
 assert.throws(()=>verifySignedManifest(text+' ',signature,keys.publicKey,{currentVersion:'0.9.0'}),/signature/);
 assert.throws(()=>verifySignedManifest(text,signature,keys.publicKey,{currentVersion:'1.0.0'}),/version/);
 assert(!safeRelative('../escape'));
 assert(!safeRelative('/absolute'));
 assert(!safeRelative('folder/CON.txt'));
 assert(!safeRelative('folder/file:stream'));
 assert(!safeRelative('folder./file'));
 assert.equal(compareVersions('1.0.0','1.0.0-rc.1'),1);
 assert.equal(compareVersions('1.0.0-rc.10','1.0.0-rc.2'),1);
 await installPackage(source,target,manifest,{healthCheck:()=>verifyTree(target,manifest)});
 assert.equal(fs.readFileSync(path.join(target,'program.txt'),'utf8'),'1.0.0');
 manifest=packageAt('1.1.0');
 await installPackage(source,target,manifest,{healthCheck:()=>verifyTree(target,manifest)});
 assert.equal(fs.readFileSync(path.join(target+'.rollback','program.txt'),'utf8'),'1.0.0');
 manifest=packageAt('1.2.0');
 await assert.rejects(installPackage(source,target,manifest,{healthCheck:()=>{throw Error('startup failed');}}),/startup failed/);
 assert.equal(fs.readFileSync(path.join(target,'program.txt'),'utf8'),'1.1.0');
 assert.equal(fs.readFileSync(path.join(target+'.failed','program.txt'),'utf8'),'1.2.0');
 fs.appendFileSync(path.join(source,'program.txt'),'tampered');
 await assert.rejects(installPackage(source,target,manifest),/checksum/);
 assert.equal(fs.readFileSync(path.join(target,'program.txt'),'utf8'),'1.1.0');
 // Reproduce an OS termination after moving the old application aside.
 const stage=target+'.staging-interrupted';
 fs.cpSync(target,stage,{recursive:true});
 fs.renameSync(target,target+'.rollback');
 fs.writeFileSync(target+'.pending.json',JSON.stringify({target,stage,rollback:target+'.rollback',phase:'old-moved',firstInstall:false}));
 assert(recoverInstallation(target));
 assert(fs.existsSync(path.join(target,'app-info.json')));
 assert(!fs.existsSync(stage));
 assert(!fs.existsSync(target+'.pending.json'));
 console.log('Passed: signed update validation, safe paths, verified install, health-check rollback and interrupted activation.');
}
test().catch(error=>{console.error(error);process.exitCode=1;})
 .finally(()=>fs.rmSync(root,{recursive:true,force:true}));
