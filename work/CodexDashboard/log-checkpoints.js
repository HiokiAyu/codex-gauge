const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');

function openCheckpoints(filename,version){
 fs.mkdirSync(path.dirname(filename),{recursive:true});
 const db=new DatabaseSync(filename);
 try{
  db.exec(`PRAGMA busy_timeout=3000;
   CREATE TABLE IF NOT EXISTS checkpoints(
    filename TEXT PRIMARY KEY, version TEXT NOT NULL, modified REAL NOT NULL, state TEXT NOT NULL
   )`);
  const read=db.prepare('SELECT state FROM checkpoints WHERE filename=? AND version=?');
  const write=db.prepare('INSERT OR REPLACE INTO checkpoints VALUES(?,?,?,?)');
  const remove=db.prepare('DELETE FROM checkpoints WHERE filename=?');
  const prune=db.prepare('DELETE FROM checkpoints WHERE version<>? OR modified<?');
  return {
   read(filename){
    const record=read.get(filename,version);
    if(!record)return null;
    const state=JSON.parse(record.state);
    state.compactions=new Set(state.compactions);
    return state;
   },
   commit(changes,cutoff){
    db.exec('BEGIN IMMEDIATE');
    try{
     for(const [filename,state] of changes){
      if(!state?.fileStat){remove.run(filename);continue;}
      const meta=state.meta&&{
       id:state.meta.id,timestamp:state.meta.timestamp,cli_version:state.meta.cli_version,cwd:state.meta.cwd,
       history_base:state.meta.history_base&&{
        thread_id:state.meta.history_base.thread_id,
        end_byte_offset:state.meta.history_base.end_byte_offset,
        end_ordinal_exclusive:state.meta.history_base.end_ordinal_exclusive
       }
      };
      const payload=JSON.stringify({...state,meta,compactions:[...state.compactions]});
      if(Buffer.byteLength(payload)<=64*1024*1024)write.run(filename,version,state.fileStat.mtimeMs,payload);
      else remove.run(filename);
     }
     prune.run(version,cutoff);
     db.exec('COMMIT');
    }catch(error){
     db.exec('ROLLBACK');
     throw error;
    }
   },
   close(){db.close();}
  };
 }catch(error){
  db.close();
  throw error;
 }
}

module.exports={openCheckpoints};
