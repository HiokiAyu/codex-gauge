const os=require('node:os');
const info=require('./app-info.json');

const number=value=>Number.isFinite(value)?value:null;
const timestamp=value=>{
 const parsed=typeof value==='string'?Date.parse(value):value;
 return Number.isFinite(parsed)?new Date(parsed).toISOString():null;
};
const identifier=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(value)?value:'unknown';

function diagnostics(snapshot,{includeStats=false,now=Date.now()}={}){
 const detail=snapshot.detail||{};
 const reconciliation=detail.reconciliation||{};
 const days=reconciliation.days||[];
 const statuses={};
 for(const day of days){
  const key=identifier(day.status);
  statuses[key]=(statuses[key]||0)+1;
 }
 const report={
  schema:1,application:info,generatedAt:timestamp(now),
  runtime:{node:process.version,platform:process.platform,architecture:process.arch,osRelease:os.release()},
  collection:{
   connected:!snapshot.error&&!!snapshot.quota?.accountId,accountKnown:detail.accountKnown===true,
   lastOfficialRead:timestamp(snapshot.updated),snapshotAt:timestamp(snapshot.snapshotAt),
   sourceDefault:snapshot.dataSource?.isDefault===true,sourceAvailable:detail.sourceError!==true,
   scanning:detail.scanning===true,scannedFiles:number(detail.done),expectedFiles:number(detail.expected),
   scanErrors:number(detail.errors),coverageStart:timestamp(detail.coverageStart),
   quotaHistoryWritable:!snapshot.quotaHistoryWriteError,windowHistoryWritable:!snapshot.windowHistoryError,
   checkpointAvailable:!detail.checkpointError,calibrationAvailable:!detail.calibrationError,
   backgroundHealthy:!snapshot.backgroundError
  },
  storage:{healthy:snapshot.storage?.healthy!==false,backupAvailable:snapshot.storage?.backupAvailable===true},
  measurement:{version:identifier(detail.measurementVersion),timezone:detail.timeZone||'Asia/Shanghai',
   reconciliation:identifier(reconciliation.status),dayStatuses:statuses},
  statsIncluded:includeStats
 };
 if(includeStats){
  const latest=reconciliation.latest;
  report.statistics={
   todayTokens:number(detail.dayTotal),cycleTokens:number(detail.weekTotal),
   ledger:{requests:number(detail.ledger?.requests),compactions:number(detail.ledger?.compactions),
    conflicts:number(detail.ledger?.conflicts),unresolved:number(detail.ledger?.unresolved)},
   scan:{durationMs:number(detail.scanMetrics?.durationMs),filesOpened:number(detail.scanMetrics?.filesOpened),
    logBytesRead:number(detail.scanMetrics?.logBytesRead),linesRead:number(detail.scanMetrics?.linesRead)},
   ingestion:{eventRowsCompared:number(detail.calibration?.ingestion?.eventRowsCompared),
    eventRowsWritten:number(detail.calibration?.ingestion?.eventRowsWritten),
    sampleRowsWritten:number(detail.calibration?.ingestion?.sampleRowsWritten)},
   latestDay:latest?{
    date:/^\d{4}-\d{2}-\d{2}$/.test(latest.date)?latest.date:null,status:identifier(latest.status),
    earliestComparisonAt:timestamp(latest.settledAt),liveSamples:number(latest.liveSamples),
    officialTokens:number(latest.officialTokens),localTokens:number(latest.localTokens),difference:number(latest.difference)
   }:null,
   reconciliation:days.map(day=>({
    date:/^\d{4}-\d{2}-\d{2}$/.test(day.date)?day.date:null,status:identifier(day.status),
    officialTokens:number(day.officialTokens),localTokens:number(day.localTokens),difference:number(day.difference)
   })),
   calibration:(detail.calibration?.models||[]).map(model=>({
    model:identifier(model.model),status:identifier(model.status),updates:number(model.updates),coefficient:number(model.coefficient)
   }))
  };
 }
 return report;
}

module.exports={diagnostics};
