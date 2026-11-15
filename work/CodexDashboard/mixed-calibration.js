// Shadow challenger only. It never changes coefficients used by the dashboard.
// Learn per-model scales of explicit reference weights, not independent token prices.
const DAY=86400000,H=3600000;
function solve(rows,models,seeds){
 const x=rows.map(r=>models.map(m=>(r.x[m]||0)*seeds[m])),y=rows.map(r=>r.y),beta=models.map(()=>1),lambda=1;
 for(let iter=0;iter<400;iter++){let change=0;for(let j=0;j<models.length;j++){let num=lambda,den=lambda;for(let i=0;i<x.length;i++){let residual=y[i];for(let k=0;k<models.length;k++)if(k!==j)residual-=x[i][k]*beta[k];num+=x[i][j]*residual;den+=x[i][j]**2}const next=Math.max(.25,Math.min(4,num/den));change=Math.max(change,Math.abs(next-beta[j]));beta[j]=next}if(change<1e-8)break}
 return Object.fromEntries(models.map((m,i)=>[m,seeds[m]*beta[i]]));
}
function rank(rows,models,seeds){
 const a=rows.map(r=>models.map(m=>(r.x[m]||0)*seeds[m])),norm=models.map((_,j)=>Math.sqrt(a.reduce((n,r)=>n+r[j]**2,0)));
 for(const r of a)for(let j=0;j<models.length;j++)r[j]=norm[j]?r[j]/norm[j]:0;
 let pivot=0;for(let c=0;c<models.length&&pivot<a.length;c++){let best=pivot;for(let i=pivot+1;i<a.length;i++)if(Math.abs(a[i][c])>Math.abs(a[best][c]))best=i;if(Math.abs(a[best][c])<1e-6)continue;[a[pivot],a[best]]=[a[best],a[pivot]];const d=a[pivot][c];for(let j=c;j<models.length;j++)a[pivot][j]/=d;for(let i=pivot+1;i<a.length;i++){const f=a[i][c];for(let j=c;j<models.length;j++)a[i][j]-=f*a[pivot][j]}pivot++}return pivot;
}
function metrics(rows,c){let predicted=0,observed=0,error=0;for(const r of rows){let p=Object.entries(r.x).reduce((n,[m,x])=>n+x*(c[m]||0),0);predicted+=p;observed+=r.y;error+=Math.abs(p-r.y)}return {mae:rows.length?error/rows.length:null,bias:Math.abs(predicted-observed),predicted,observed};}
function analyze(events,samples,seeds,{now=Date.now(),gaps=[],coverage=[],evaluatedThrough=0,source='live'}={}){
 const models=Object.keys(seeds).filter(m=>Number.isFinite(seeds[m])&&seeds[m]>0),bins=new Map();
 const width=source==='log'?H:4*H;
 const ss=samples.filter(s=>s.source===source&&s.at>=now-21*DAY&&s.at<=now-300000&&s.used>=0&&s.used<100).sort((a,b)=>a.at-b.at);
 for(const s of ss)bins.set(Math.floor(s.at/width),s);
 const anchors=[...bins.values()],blocks=[];
 for(let i=1;i<anchors.length;i++){const a=anchors[i-1],b=anchors[i];if(b.at-a.at<width*.75||b.at-a.at>width*1.25||Math.abs(a.reset-b.reset)>5000||b.used<a.used)continue;
  if(!coverage.some(c=>c.start<=a.at-300000&&c.end>=b.at+300000)||gaps.some(g=>g.start<=b.at+300000&&g.end>=a.at-300000))continue;
  const readings=ss.filter(s=>s.at>=a.at&&s.at<=b.at);if(readings.some((s,j)=>j&&(s.used<readings[j-1].used||s.at-readings[j-1].at>900000||Math.abs(s.reset-a.reset)>5000)))continue;
  const es=events.filter(e=>e.at>a.at-300000&&e.at<=b.at+300000);if(!es.length||es.some(e=>!models.includes(e.model)||!Number.isFinite(e.credit)||e.credit<=0))continue;
  const x={};for(const e of es)if(e.at>a.at&&e.at<=b.at)x[e.model]=(x[e.model]||0)+e.credit;
  if(a.at>evaluatedThrough&&Object.keys(x).length)blocks.push({start:a.at,at:b.at,y:b.used-a.used,x});
 }
 const split=blocks.length?Math.floor(blocks[Math.floor(blocks.length*.7)].start/DAY)*DAY:0;
 const train=blocks.filter(b=>b.at<split-300000),validation=blocks.filter(b=>b.start>=split),active=models.filter(m=>train.some(b=>b.x[m]>0));
 const dayCount=rs=>new Set(rs.map(r=>Math.floor(r.start/DAY))).size;
 const result={status:'collecting',mode:'shadow',blocks:blocks.length,trainBlocks:train.length,validationBlocks:validation.length,trainDays:dayCount(train),validationDays:dayCount(validation),models:active,rank:rank(train,active,seeds),coefficients:null};
 if(train.length<12||validation.length<6||result.trainDays<3||result.validationDays<2||!active.length||result.rank<active.length||train.reduce((n,b)=>n+b.y,0)<15||validation.reduce((n,b)=>n+b.y,0)<5||active.some(m=>train.filter(b=>b.x[m]>0).length<6||validation.filter(b=>b.x[m]>0).length<3))return result;
 const coefficients=solve(train,active,seeds),oldMetrics=metrics(validation,seeds),newMetrics=metrics(validation,coefficients);
 return {...result,status:newMetrics.mae<oldMetrics.mae*.95&&newMetrics.bias<=oldMetrics.bias?'supported':'rejected',coefficients,oldMetrics,newMetrics,evaluatedThrough:validation.at(-1).at};
}
module.exports={analyze,solve,rank};
