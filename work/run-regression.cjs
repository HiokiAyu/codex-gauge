const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const directory=__dirname;
const sourceHash=require('./source-fingerprint.cjs');
const startedSource=sourceHash();
const reportFile=path.join(directory,'v1-regression-results.json');
const oldReport=process.argv.includes('--failed')?JSON.parse(fs.readFileSync(reportFile,'utf8')):null;
const previous=oldReport?.sourceHash===startedSource?oldReport.results:[];
const tests=previous.length?previous.filter(result=>!result.passed).map(result=>result.test):
 fs.readdirSync(directory).filter(name=>/^test-.*\.cjs$/.test(name)).sort();
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-regression-'));
const results=previous.filter(result=>result.passed);
try{
 for(const [index,name] of tests.entries()){
  const profile=path.join(temporary,String(index));fs.mkdirSync(profile,{recursive:true});
  // Edge obtains Windows profile paths from several sources. These UI tests
  // serve only fixtures and use Playwright's own disposable browser profile.
  const browserTest=['test-accessibility-ui.cjs','test-project-ui.cjs','test-repair-ui.cjs','test-ui-v3.cjs'].includes(name);
  const result=cp.spawnSync(process.execPath,[path.join(directory,name)],{
   cwd:path.dirname(directory),env:browserTest?process.env:{...process.env,LOCALAPPDATA:path.join(profile,'local'),USERPROFILE:profile},
   windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024
  });
  results.push({test:name,passed:result.status===0,exitCode:result.status,
   output:(result.stdout||'').trim().slice(-2500),error:(result.stderr||result.error?.message||'').trim().slice(-2500)});
  console.log((result.status===0?'PASS ':'FAIL ')+name);
 }
 const sourceUnchanged=sourceHash()===startedSource;
 fs.writeFileSync(reportFile,JSON.stringify({
  at:new Date().toISOString(),node:process.version,sourceHash:startedSource,sourceUnchanged,
  passed:results.filter(result=>result.passed).length,total:results.length,results
 },null,2));
 if(!sourceUnchanged||results.some(result=>!result.passed))process.exitCode=1;
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
