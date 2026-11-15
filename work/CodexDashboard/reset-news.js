const fs=require('fs'),path=require('path');
const SOURCES=[{id:'tokenusage',url:'https://tokenusage.dev/api/resets',site:'https://tokenusage.dev/resets'},{id:'agentresets',url:'https://agentresets.com/api/v1/resets.json',site:'https://agentresets.com/api/'},{id:'whenreset',url:'https://whenreset.dev/api/reset-feed?provider=codex',site:'https://whenreset.dev/'}];
function safeLink(value){try{const u=new URL(value);return u.protocol==='https:'&&['x.com','twitter.com','tokenusage.dev','agentresets.com','whenreset.dev'].includes(u.hostname)?u.href:null}catch{return null}}
function item(at,type,url,source){const time=Date.parse(at);if(!Number.isFinite(time))return null;const link=safeLink(url);return {at:time,type:['automatic','banked','both'].includes(type)?type:'unknown',url:link||source.site,postId:link?.match(/\/status\/(\d+)/)?.[1]||null};}
function parse(id,raw,now){const source=SOURCES.find(x=>x.id===id);let items=[],updated=null;
 if(id==='tokenusage'){if(!Array.isArray(raw.resets))throw Error('schema');updated=Date.parse(raw.lastPolledAt);if(!Number.isFinite(updated))throw Error('timestamp');items=raw.resets.map(x=>item(x.postedAt,x.resetType,x.url,source));}
 if(id==='agentresets'){if(!Array.isArray(raw.products?.codex?.events))throw Error('schema');updated=Date.parse(raw.generated_at);if(!Number.isFinite(updated))throw Error('timestamp');items=raw.products.codex.events.map(x=>item(x.time,x.kind==='regular'?'automatic':x.kind,null,source));}
 if(id==='whenreset'){if(typeof raw!=='string'||!raw.includes('<rss'))throw Error('schema');const tag=(s,n)=>s.match(new RegExp('<'+n+'[^>]*>([\\s\\S]*?)</'+n+'>'))?.[1]||'';items=[...raw.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m=>item(tag(m[1],'pubDate'),/Bonus reset/i.test(tag(m[1],'title'))?'banked':/Usage reset/i.test(tag(m[1],'title'))?'automatic':'unknown',tag(m[1],'link'),source));}
 if(updated>now+60000)throw Error('future');return {items:items.filter(x=>x&&x.at<=now+60000).slice(0,100),updated:Number.isFinite(updated)?updated:null,checkedAt:now};
}
function merge(states,now){const groups=[];for(const source of SOURCES){const state=states[source.id];if(!state)continue;for(const x of state.items||[]){let g=groups.find(g=>x.postId&&g.postId===x.postId)||groups.find(g=>!g.sources.includes(source.id)&&g.type===x.type&&Math.abs(g.at-x.at)<=120000);if(!g){g={...x,id:x.postId?'post:'+x.postId:'time:'+x.at+':'+x.type,sources:[],records:[],conflict:false};groups.push(g)}else{if(x.postId&&!g.postId){g.postId=x.postId;g.url=x.url;g.id='post:'+x.postId}if((g.type!==x.type&&g.type!=='unknown'&&x.type!=='unknown')||Math.abs(g.at-x.at)>120000)g.conflict=true;}if(!g.sources.includes(source.id))g.sources.push(source.id);g.records.push({...x,source:source.id});}}
 return groups.sort((a,b)=>b.at-a.at).slice(0,100).map(g=>({...g,match:g.conflict?'conflict':g.sources.length>1?'matched':'single',freshSources:g.sources.filter(id=>{let s=states[id];return !s.error&&now-s.checkedAt<24*3600000&&(!s.updated||now-s.updated<24*3600000)})}));}
function createFeed({fetcher=fetch,now=Date.now,cacheFile=null}={}){let states={},busy=false,next=0;try{if(cacheFile)states=JSON.parse(fs.readFileSync(cacheFile,'utf8')).states||{}}catch{}
 async function refresh(){if(busy||now()<next)return;busy=true;next=now()+5*60000;try{await Promise.all(SOURCES.map(async s=>{try{const r=await fetcher(s.url,{signal:AbortSignal.timeout(12000),redirect:'error',headers:{Accept:s.id==='whenreset'?'application/rss+xml':'application/json'}});if(!r.ok)throw Error('http');let text=await r.text();if(text.length>1024*1024)throw Error('size');states[s.id]={...parse(s.id,s.id==='whenreset'?text:JSON.parse(text),now()),error:false};}catch{states[s.id]={...(states[s.id]||{items:[]}),error:true}}}));if(cacheFile){fs.mkdirSync(path.dirname(cacheFile),{recursive:true});fs.writeFileSync(cacheFile+'.tmp',JSON.stringify({states}));fs.renameSync(cacheFile+'.tmp',cacheFile)}}finally{busy=false}}
 function snapshot(){const t=now(),items=merge(states,t),sources=SOURCES.map(s=>{const v=states[s.id];return {id:s.id,url:s.site,checkedAt:v?.checkedAt||null,updated:v?.updated||null,status:!v?'loading':v.error?'error':t-v.checkedAt>24*3600000||(v.updated&&t-v.updated>24*3600000)?'stale':'ok'}}),ok=sources.filter(x=>x.status==='ok').length;return {items,recent:items.filter(x=>x.at>=t-72*3600000),sources,status:ok===3?'ok':ok?'partial':busy?'loading':'error',checkedAt:Math.max(0,...sources.map(x=>x.checkedAt||0))};}return {refresh,snapshot};}
function findUnseen(snapshot,seen){
 const known=new Set(seen);
 const unseen=[],aliases=[];
 for(const item of snapshot.recent||[]){
  if(!item.freshSources?.length)continue;
  const ids=[item.id,...(item.records||[item]).map(record=>
   'event:'+Math.round(record.at/60000)+':'+record.type)];
  if(ids.some(id=>known.has(id)))continue;
  unseen.push(item);
  for(const id of ids){known.add(id);aliases.push(id);}
 }
 return {unseen,aliases};
}
module.exports={createFeed,parse,merge,findUnseen,SOURCES};
