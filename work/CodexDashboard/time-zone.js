const DAY=86400000;
const formatters=new Map(),starts=new Map();

function resolveTimeZone(value){
 const zone=value==null||value==='system'?Intl.DateTimeFormat().resolvedOptions().timeZone:value;
 if(typeof zone!=='string'||zone.length>100)throw Error('Invalid time zone');
 new Intl.DateTimeFormat('en',{timeZone:zone}).format(0);
 return zone;
}
function formatter(zone,hour=false){
 const key=zone+'|'+hour;
 if(!formatters.has(key)){
  formatters.set(key,new Intl.DateTimeFormat('en-US',hour
   ?{timeZone:zone,hour:'numeric',hourCycle:'h23'}
   :{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}));
 }
 return formatters.get(key);
}
function dateKey(at,zone){
 const parts=Object.fromEntries(formatter(zone).formatToParts(at).map(part=>[part.type,part.value]));
 return parts.year+'-'+parts.month+'-'+parts.day;
}
function addDays(date,count){
 const timestamp=Date.parse(date+'T00:00:00Z');
 if(!Number.isFinite(timestamp)||new Date(timestamp).toISOString().slice(0,10)!==date)throw Error('Invalid date');
 return new Date(timestamp+count*DAY).toISOString().slice(0,10);
}
function startForDate(date,zone){
 const key=zone+'|'+date;
 if(starts.has(key))return starts.get(key);
 const nominal=Date.parse(date+'T00:00:00Z');
 if(!Number.isFinite(nominal))throw Error('Invalid date');
 // Calendar days have variable lengths across offset changes. Find the first
 // instant with this date, including zones whose midnight is skipped.
 let low=nominal-2*DAY,high=nominal+2*DAY;
 while(high-low>1){
  const middle=Math.floor((low+high)/2);
  if(dateKey(middle,zone)<date)low=middle;else high=middle;
 }
 starts.set(key,high);
 if(starts.size>512)starts.delete(starts.keys().next().value);
 return high;
}
function dayStart(at,zone='Asia/Shanghai'){
 return startForDate(dateKey(at,zone),zone);
}
function dayBounds(at,zone='Asia/Shanghai'){
 const date=dateKey(at,zone);
 return {date,start:startForDate(date,zone),end:startForDate(addDays(date,1),zone)};
}
function hourOfDay(at,zone){
 return Number(formatter(zone,true).formatToParts(at).find(part=>part.type==='hour').value)%24;
}
module.exports={resolveTimeZone,dateKey,addDays,startForDate,dayStart,dayBounds,hourOfDay};
