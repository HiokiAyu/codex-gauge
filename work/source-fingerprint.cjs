const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function sourceHash(){
 const base=path.join(__dirname,'CodexDashboard'),hash=crypto.createHash('sha256');
 function visit(folder,root,prefix){
  for(const entry of fs.readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
   if(entry.name==='bin'||entry.name==='obj')continue;
   const file=path.join(folder,entry.name);
   if(entry.isDirectory())visit(file,root,prefix);
   else if(/\.(?:js|cs|json|csproj|css|html|txt|ico)$/.test(entry.name)){
    hash.update(prefix+path.relative(root,file));hash.update('\0');hash.update(fs.readFileSync(file));hash.update('\0');
   }
  }
 }
 visit(base,base,'dashboard/');const setup=path.join(__dirname,'CodexSetup');visit(setup,setup,'setup/');return hash.digest('hex');
}
module.exports=sourceHash;
if(require.main===module)console.log(sourceHash());
