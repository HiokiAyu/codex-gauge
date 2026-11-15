const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createService,verifyReady,pruneStages,readConfig}=require('./CodexDashboard/update-client');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-ota-'));
const installed=path.join(root,'installed'),data=path.join(root,'data');
fs.mkdirSync(installed);fs.mkdirSync(data);
const keys=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const config={enabled:true,channel:'stable',manifestUrl:'https://updates.example.invalid/stable.json',
 filesBaseUrl:'https://updates.example.invalid/files/',publicKey:keys.publicKey.export({type:'spki',format:'pem'})};
const put=(name,value)=>{const file=path.join(installed,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);};
put('app-info.json',JSON.stringify({name:'CodexUsageDashboard',version:'1.0.0'}));
put('update-source.json',JSON.stringify({enabled:false}));
put('runtime/node.exe','same runtime');
const contents=new Map([
 ['app-info.json',JSON.stringify({name:'CodexUsageDashboard',version:'1.0.1'})],
 ['runtime/node.exe','same runtime'],['Codex大看板.exe','new executable'],['locales/en.json','{"strings":{}}']
]);
let manifest={schema:1,application:'CodexUsageDashboard',version:'1.0.1',channel:'stable',platform:'win-x64',
 expiresAt:new Date(Date.now()+86400000).toISOString(),files:[...contents].map(([name,body])=>({
  path:name,bytes:Buffer.byteLength(body),sha256:crypto.createHash('sha256').update(body).digest('hex')
 }))};
const signed=value=>{const text=JSON.stringify(value);return {manifest:text,signature:crypto.sign('sha256',Buffer.from(text),keys.privateKey).toString('base64')};};
let envelope=signed(manifest),downloads=[],mode='ok';
const fetchImpl=async(url,options)=>{
 assert.equal(options.redirect,'error');
 if(url===config.manifestUrl)return new Response(JSON.stringify(envelope));
 const name=decodeURIComponent(new URL(url).pathname.split('/').slice(3).join('/'));
 downloads.push(name);
 return new Response(mode==='corrupt'?'CORRUPTED':contents.get(name));
};
(async()=>{try{
 const disabled=createService({directory:installed,dataDirectory:data,fetchImpl:()=>{throw Error('Network must remain off');}});
 assert.equal((await disabled.check()).status,'unconfigured');
 put('update-source.json',JSON.stringify(config));
 assert(readConfig(installed).enabled);
 const service=createService({directory:installed,dataDirectory:data,fetchImpl});
 assert.equal((await service.check()).status,'available');
 mode='corrupt';await assert.rejects(service.stage(),/large|checksum/);
 assert.equal(service.status().status,'error');
 assert.equal(fs.existsSync(path.join(data,'updates','ready.json')),false);
 mode='ok';downloads=[];
 await service.check();
 const results=await Promise.all([service.stage(),service.stage()]);
 assert(results.every(value=>value.status==='ready'));
 assert(results[0].reusedBytes>0);
 assert(!downloads.includes('runtime/node.exe'),'Unchanged runtime was downloaded');
 assert.equal(downloads.length,3);
 const ready=verifyReady(installed,data);
 const restored=createService({directory:installed,dataDirectory:data,fetchImpl});
 assert.equal((await restored.check()).status,'ready','Restart lost the prepared update');
 fs.appendFileSync(path.join(ready.payload,'Codex大看板.exe'),'TAMPERED');
 assert.throws(()=>verifyReady(installed,data),/checksum/);
 envelope={...envelope,signature:Buffer.alloc(256).toString('base64')};
 assert.equal((await restored.check()).status,'error');
 envelope=signed({...manifest,expiresAt:new Date(Date.now()-1).toISOString()});
 assert.equal((await restored.check()).status,'error');
 envelope=signed({...manifest,version:'1.0.0'});
 assert.equal((await restored.check()).status,'current');
 const unrelated=path.join(data,'updates','do-not-remove');fs.mkdirSync(unrelated);fs.writeFileSync(path.join(unrelated,'keep'),'keep');
 fs.unlinkSync(path.join(data,'updates','ready.json'));
 pruneStages(installed,data);
 assert(!fs.existsSync(ready.root));
 assert(fs.existsSync(path.join(unrelated,'keep')));
 put('update-source.json',JSON.stringify({...config,manifestUrl:'http://updates.example.invalid/feed'}));
 assert.equal(createService({directory:installed,dataDirectory:data,fetchImpl}).status().status,'invalid-config');
 console.log('Passed: disabled OTA stays offline, signed feeds, bounded downloads, delta reuse, concurrent-stage dedup, restart recovery, tamper/expiry rejection and owned-stage cleanup.');
}finally{fs.rmSync(root,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});
