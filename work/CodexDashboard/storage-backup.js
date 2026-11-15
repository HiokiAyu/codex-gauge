const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');

const quote=value=>"'"+value.replace(/'/g,"''")+"'";
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const filesForBackup=directory=>fs.readdirSync(directory,{withFileTypes:true})
 .filter(entry=>entry.isFile()&&filesForBackupNames(entry.name)).map(entry=>entry.name);

function checkDatabase(file){
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('Database integrity check failed');
 }finally{db.close();}
}

function makeBackup(directory,version,{now=Date.now(),preserveDamaged=false}={}){
 fs.mkdirSync(directory,{recursive:true});
 const backups=path.join(directory,'backups');
 fs.mkdirSync(backups,{recursive:true});
 const id=new Date(now).toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
 const staging=path.join(backups,'.'+id);
 const target=path.join(backups,id);
 fs.mkdirSync(staging);
 try{
  const records=[];
  for(const name of filesForBackup(directory)){
   const source=path.join(directory,name),destination=path.join(staging,name);
   let damaged=false;
   if(name.endsWith('.sqlite')){
    try{
     const db=new DatabaseSync(source,{readOnly:true});
     try{
      db.exec('PRAGMA busy_timeout=5000');
      db.exec('VACUUM INTO '+quote(destination));
     }finally{db.close();}
     checkDatabase(destination);
    }catch(error){
     if(!preserveDamaged)throw error;
     damaged=true;
     fs.copyFileSync(source,destination);
    }
   }else{
    fs.copyFileSync(source,destination);
    if(name.endsWith('.json'))try{JSON.parse(fs.readFileSync(destination,'utf8').replace(/^\uFEFF/,''));}
    catch(error){if(!preserveDamaged)throw error;damaged=true;}
   }
   records.push({name,bytes:fs.statSync(destination).size,sha256:digest(destination),damaged});
  }
  const manifest={schema:1,applicationVersion:version,createdAt:new Date(now).toISOString(),files:records};
  fs.writeFileSync(path.join(staging,'manifest.json'),JSON.stringify(manifest,null,2));
  fs.renameSync(staging,target);
  return target;
 }catch(error){
  fs.rmSync(staging,{recursive:true,force:true});
  throw error;
 }
}

function readBackup(backup,{allowDamaged=false}={}){
 if(fs.lstatSync(backup).isSymbolicLink())throw Error('Invalid backup link');
 if(fs.lstatSync(path.join(backup,'manifest.json')).isSymbolicLink())throw Error('Invalid backup manifest');
 const manifest=JSON.parse(fs.readFileSync(path.join(backup,'manifest.json'),'utf8'));
 if(manifest.schema!==1||!Array.isArray(manifest.files))throw Error('Invalid backup');
 const names=new Set();
 for(const record of manifest.files){
  if(typeof record.name!=='string'||path.basename(record.name)!==record.name
   ||!filesForBackupNames(record.name)||names.has(record.name))throw Error('Invalid backup file');
  names.add(record.name);
  const file=path.join(backup,record.name);
  if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw Error('Invalid backup file');
  if(fs.statSync(file).size!==record.bytes||digest(file)!==record.sha256)throw Error('Backup checksum mismatch');
  if(record.damaged&&!allowDamaged)throw Error('Backup contains damaged data');
  if(record.damaged)continue;
  if(record.name.endsWith('.sqlite'))checkDatabase(file);
  else if(record.name.endsWith('.json'))JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 }
 return manifest;
}
function filesForBackupNames(name){
 return /^(?:calibration(?:-source-[a-f0-9]+)?|window-history)\.sqlite$/.test(name)
  ||/^(?:preferences|window-config|workload-[a-f0-9]+)\.json$/.test(name)||name==='quota-history.jsonl';
}

function applyRestore(directory,backup){
 const manifest=readBackup(backup);
 const names=new Set(manifest.files.map(record=>record.name));
 for(const record of manifest.files){
  const destination=path.join(directory,record.name);
  const temporary=destination+'.restore.tmp';
  fs.copyFileSync(path.join(backup,record.name),temporary);
  if(digest(temporary)!==record.sha256)throw Error('Restore verification failed');
  fs.renameSync(temporary,destination);
  if(record.name.endsWith('.sqlite')){
   for(const suffix of ['-wal','-shm'])fs.rmSync(destination+suffix,{force:true});
  }
 }
 // Newer managed stores must not remain beside an older, restored snapshot.
 // Their pre-restore contents have already been saved in the recovery backup.
 for(const name of filesForBackup(directory))if(!names.has(name)){
  fs.unlinkSync(path.join(directory,name));
  if(name.endsWith('.sqlite'))for(const suffix of ['-wal','-shm'])fs.rmSync(path.join(directory,name+suffix),{force:true});
 }
 return manifest.files.map(record=>record.name);
}

function resumeRestore(directory){
 const journal=path.join(directory,'restore-pending.json');
 if(!fs.existsSync(journal))return null;
 const {backup,recovery}=JSON.parse(fs.readFileSync(journal,'utf8'));
 const parent=path.join(path.resolve(directory),'backups');
 for(const folder of [backup,recovery]){
  if(typeof folder!=='string'||path.dirname(path.resolve(folder))!==parent)throw Error('Invalid restore journal');
 }
 const restored=applyRestore(directory,backup);
 fs.rmSync(path.join(directory,'storage-version.json'),{force:true});
 fs.unlinkSync(journal);
 return {restored,recovery};
}

function restoreBackup(directory,backup){
 const localBackup=path.dirname(path.resolve(backup))===path.join(path.resolve(directory),'backups');
 if(!localBackup)throw Error('Restore requires a local application backup');
 readBackup(backup);
 const recovery=makeBackup(directory,'before-restore',{preserveDamaged:true});
 const journal=path.join(directory,'restore-pending.json');
 fs.writeFileSync(journal+'.tmp',JSON.stringify({backup:path.resolve(backup),recovery}));
 fs.renameSync(journal+'.tmp',journal);
 return resumeRestore(directory);
}

function prepareStorage(directory,version){
 fs.mkdirSync(directory,{recursive:true});
 resumeRestore(directory);
 const marker=path.join(directory,'storage-version.json');
 let previous=null;
 try{previous=JSON.parse(fs.readFileSync(marker,'utf8'));}catch{}
 if(previous?.applicationVersion===version)return previous;
 const exists=filesForBackup(directory).length>0;
 const backup=exists?makeBackup(directory,previous?.applicationVersion||'legacy'):null;
 // This checkpoint is finalized only after the caller has opened every migrated store.
 return {schema:1,applicationVersion:version,backup,finalize(){
  const value={schema:1,applicationVersion:version,backup,preparedAt:new Date().toISOString()};
  fs.writeFileSync(marker+'.tmp',JSON.stringify(value));
  fs.renameSync(marker+'.tmp',marker);
  pruneBackups(directory);
 }};
}

function pruneBackups(directory){
 const parent=path.join(path.resolve(directory),'backups');
 if(!fs.existsSync(parent))return;
 const keep=new Set();
 for(const name of ['storage-version.json','restore-pending.json']){
  try{
   const marker=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
   for(const value of [marker.backup,marker.recovery])if(typeof value==='string')keep.add(path.resolve(value));
  }catch{}
 }
 const folders=fs.readdirSync(parent,{withFileTypes:true}).filter(entry=>entry.isDirectory()
  &&/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[a-f0-9]{8}$/.test(entry.name))
  .map(entry=>path.join(parent,entry.name)).sort().reverse();
 if(folders[0])keep.add(folders[0]);
 let valid=0;
 for(const folder of folders){
  if(valid>=2)break;
  try{readBackup(folder);keep.add(folder);valid++;}catch{}
 }
 for(const folder of folders){
  if(keep.has(folder))continue;
  if(path.dirname(path.resolve(folder))!==parent||fs.lstatSync(folder).isSymbolicLink())throw Error('Invalid backup cleanup target');
  fs.rmSync(folder,{recursive:true,force:true});
 }
}

const backupIdPattern=/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-[a-f0-9]{8}$/;
function listBackups(directory){
 const parent=path.join(directory,'backups');
 if(!fs.existsSync(parent))return [];
 const result=[];
 for(const entry of fs.readdirSync(parent,{withFileTypes:true})){
  if(!entry.isDirectory()||!backupIdPattern.test(entry.name))continue;
  try{
   const manifest=readBackup(path.join(parent,entry.name));
   result.push({id:entry.name,createdAt:manifest.createdAt,applicationVersion:manifest.applicationVersion,fileCount:manifest.files.length});
  }catch{}
 }
 return result.sort((a,b)=>b.id.localeCompare(a.id));
}
function restoreById(directory,id){
 if(typeof id!=='string'||!backupIdPattern.test(id))throw Error('Invalid backup identifier');
 return restoreBackup(directory,path.join(directory,'backups',id));
}
module.exports={makeBackup,readBackup,restoreBackup,restoreById,listBackups,resumeRestore,prepareStorage,pruneBackups};
if(require.main===module){
 try{
  const [action,id,directory]=process.argv.slice(2);
  if(action!=='--restore'||!directory)throw Error('Invalid restore request');
  const result=restoreById(directory,id);
  console.log(JSON.stringify({success:true,restored:result.restored}));
 }catch{console.error('Restore could not be completed. The recovery journal will be checked at next startup.');process.exitCode=1;}
}
