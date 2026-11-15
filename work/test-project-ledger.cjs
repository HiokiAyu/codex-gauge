const assert=require('node:assert/strict');
const {normalizeFolder,updateProjects,getProjectReport,projectCsv}=require('./CodexDashboard/project-ledger');

assert.equal(normalizeFolder('C:/Repos/Tools/../'),String.raw`c:\repos`);
assert.equal(normalizeFolder(String.raw`\\?\UNC\Server\Share\Folder`),String.raw`\\server\share\folder`);
assert.equal(normalizeFolder('/repos/Case/'),'/repos/Case');
assert.equal(normalizeFolder('C:relative'),null);
let projects=updateProjects([],{action:'save',name:'Workspace',folder:'C:/Repos'});
projects=updateProjects(projects,{action:'save',name:'=Private team',folder:'C:/Repos/Inner'});
const inner=projects[1].id;
projects=updateProjects(projects,{action:'attach',id:inner,folder:'D:/Moved/Inner'});
assert.throws(()=>updateProjects(projects,{action:'attach',id:inner,folder:'C:/REPOS/'}),/already assigned/);
assert.throws(()=>updateProjects(projects,{action:'save',id:inner,name:'D:/Private'}),/Invalid project name/);

const now=Date.UTC(2026,10,11,8);
const rows=[
 {id:'a',model:'sol',effort:'high',total:100,input:70,cached:30,output:30,weight:0.2,estimatedQuota:0.2,weekPercent:0.2,unknown:0},
 {id:'a',model:'luna',effort:'low',total:50,input:40,cached:5,output:10,weight:0,estimatedQuota:null,weekPercent:null,unknown:50},
 {id:'b',model:'sol',effort:'high',total:10,input:9,cached:0,output:1,weight:0.02,estimatedQuota:0.02,weekPercent:0.02,unknown:0},
 {id:'c',model:'sol',effort:'medium',total:20,input:14,cached:0,output:6,weight:0.04,estimatedQuota:0.04,weekPercent:0.04,unknown:0},
 {id:'d',model:'sol',effort:'high',total:40,input:30,cached:6,output:10,weight:0.08,estimatedQuota:0.08,weekPercent:0.08,unknown:0}
].map(row=>({...row,title:'PRIVATE_TITLE',tier:'default'}));
const threads=[
 {id:'a',projectFolder:'C:/REPOS/Inner/sub'},
 {id:'b',projectFolder:'C:/repos/Other'},
 {id:'c',projectFolder:'C:/reposExtra'},
 {id:'d',projectFolder:'D:/Moved/Inner/sub'}
];
const detail={accountKnown:true,errors:0,scanning:false,dayStart:now-3600000,weekStart:now-86400000,
 weekEnd:now+86400000,dayRows:rows,weekDetailRows:rows};
const report=getProjectReport({detail,threads,projects,period:'today',now});
assert.equal(report.total.tokens,220);
assert.equal(report.groups.find(group=>group.id===inner).tokens,190);
assert.equal(report.groups.find(group=>group.id===null).tokens,20);
assert.equal(report.groups.reduce((sum,group)=>sum+group.tokens,0),report.total.tokens);
assert.equal(report.total.unknownTokens,50);
assert(report.groups.find(group=>group.id===inner).partial);
const filtered=getProjectReport({detail,threads,projects,period:'cycle',now,model:'sol',effort:'high'});
assert.equal(filtered.total.tokens,150);
assert.equal(filtered.total.partial,false);
assert.equal(filtered.groups.length,2);
assert.equal(filtered.timezone,'Asia/Shanghai');
const csv=projectCsv(report);
assert(csv.startsWith('\ufeff"period"'));
assert(csv.includes('"start_inclusive","end_exclusive","time_zone"'));
assert(csv.includes("'=Private team"));
assert(csv.includes('"unassigned"'));
assert(!csv.includes('PRIVATE_TITLE'));
assert(!csv.includes('Moved'));
assert(!csv.includes(inner));
console.log('Passed: project prefix boundaries, relocation aliases, filtered accounting, CSV privacy and spreadsheet safety.');
