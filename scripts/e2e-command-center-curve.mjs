#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

assert.equal(process.argv.length, 4, 'Usage: node scripts/e2e-command-center-curve.mjs <run-directory> <output-directory>');
const input = resolve(process.argv[2]), output = resolve(process.argv[3]);
const samples = (await readFile(join(input, 'memory.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
assert.ok(samples.length > 1, 'At least two samples required');
const config = JSON.parse(await readFile(join(input, 'config.json'), 'utf8'));
const roles = ['coordinator', 'host', 'sidecar'];
const started = samples[0].timestampMs;
const rows = samples.map(sample => {
  const processes = Object.fromEntries(sample.processes.map(p => [p.role, p]));
  assert.equal(sample.processes.length, 3); assert.equal(Object.keys(processes).length, 3);
  for (const role of roles) assert.ok(Number.isFinite(processes[role]?.privateBytes), 'Incomplete memory sample');
  return { seconds: (sample.timestampMs - started) / 1000, timestampMs: sample.timestampMs,
    total: roles.reduce((sum, role) => sum + processes[role].privateBytes, 0), processes, collectionMs: sample.collectionMs };
});
const sorted = rows.map(row => row.total).sort((a,b) => a-b);
const percentile = p => sorted[Math.ceil(p*sorted.length)-1];
const target = config.targetBytes ?? 4000000000, hard = config.budgetBytes;
const duration = rows.at(-1).seconds;
const minutes = new Map();
for (const row of rows) {
  const minute = Math.floor(row.seconds/60);
  if (!minutes.has(minute)) minutes.set(minute, []);
  minutes.get(minute).push(row.total);
}
const buckets = [...minutes].map(([minute, values]) => ({ minute,
  minBytes: Math.min(...values), meanBytes: values.reduce((a,b)=>a+b,0)/values.length, maxBytes: Math.max(...values) }));
const warm = buckets.filter(b => b.minute >= 5 && b.minute < Math.floor(duration/60));
const meanX = warm.reduce((s,b)=>s+b.minute,0)/warm.length;
const meanY = warm.reduce((s,b)=>s+b.minBytes,0)/warm.length;
const denominator = warm.reduce((s,b)=>s+(b.minute-meanX)**2,0);
const slope = denominator ? warm.reduce((s,b)=>s+(b.minute-meanX)*(b.minBytes-meanY),0)/denominator : null;
const processMetrics = Object.fromEntries(roles.map(role => [role, {
  peakPrivateBytes: Math.max(...rows.map(r=>r.processes[role].privateBytes)),
  firstPrivateBytes: rows[0].processes[role].privateBytes, lastPrivateBytes: rows.at(-1).processes[role].privateBytes,
  cpuSeconds: rows.at(-1).processes[role].cpuSeconds - rows[0].processes[role].cpuSeconds,
  firstHandles: rows[0].processes[role].handles, lastHandles: rows.at(-1).processes[role].handles,
  peakHandles: Math.max(...rows.map(r=>r.processes[role].handles)),
  peakThreads: Math.max(...rows.map(r=>r.processes[role].threads)),
}]));
const summary = { sampleCount: rows.length, measuredSeconds: duration, peakPrivateBytes: sorted.at(-1),
  meanPrivateBytes: sorted.reduce((a,b)=>a+b,0)/sorted.length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99),
  targetBytes: target, hardLimitBytes: hard, targetMet: sorted.at(-1) <= target, hardLimitMet: sorted.at(-1) <= hard,
  samplesAboveTarget: rows.filter(r=>r.total>target).length,
  sampleGapMaxMs: Math.max(...rows.slice(1).map((r,i)=>r.timestampMs-rows[i].timestampMs)),
  collectionMaxMs: Math.max(...rows.map(r=>r.collectionMs)),
  postWarmupMinuteMinimumSlopeBytesPerMinute: slope, processMetrics,
  note: 'Slope uses minute minima after 5 minutes and excludes the final partial minute. It is diagnostic, not a leak guarantee. SVG uses peak per second for each series; CSV preserves every sample.' };
await mkdir(output, { recursive: true });
const columns = ['timestamp_ms','elapsed_seconds','total_private_bytes', ...roles.flatMap(role => [role+'_private_bytes',role+'_working_set_bytes',role+'_cpu_seconds',role+'_handles',role+'_threads']), 'collection_ms'];
const csv = [columns.join(','), ...rows.map(r => [r.timestampMs,r.seconds,r.total,...roles.flatMap(role => {
  const p=r.processes[role]; return [p.privateBytes,p.workingSetBytes,p.cpuSeconds,p.handles,p.threads];
}),r.collectionMs].join(','))].join('\n')+'\n';
await writeFile(join(output,'memory.csv'),csv);
await writeFile(join(output,'curve-metrics.json'),JSON.stringify(summary,null,2)+'\n');
await writeFile(join(output,'minute-memory.json'),JSON.stringify(buckets,null,2)+'\n');
const width=1200,height=620,left=85,right=35,top=95,bottom=95;
const yMax=Math.max(hard,summary.peakPrivateBytes)*1.08, xMax=Math.max(1,duration/60);
const x=seconds=>left+(seconds/60)/xMax*(width-left-right);
const y=bytes=>top+(1-bytes/yMax)*(height-top-bottom);
const peakSeconds=new Map();
for (const r of rows) {
  const sec=Math.floor(r.seconds); const values=peakSeconds.get(sec)??{seconds:r.seconds,total:0,coordinator:0,host:0,sidecar:0};
  values.total=Math.max(values.total,r.total); for(const role of roles) values[role]=Math.max(values[role],r.processes[role].privateBytes);
  peakSeconds.set(sec,values);
}
const points=[...peakSeconds.values()];
const colors={total:'#195bb6',coordinator:'#ab47bc',host:'#25845b',sidecar:'#df7a13'};
const line=(key,color)=>`<polyline fill="none" stroke="${color}" stroke-width="${key==='total'?2.4:1.4}" points="${points.map(p=>`${x(p.seconds).toFixed(2)},${y(p[key]).toFixed(2)}`).join(' ')}"/>`;
const parts=[`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Command-center load memory curve"><rect width="100%" height="100%" fill="white"/><g font-family="Arial,sans-serif" fill="#243247"><text x="${left}" y="32" font-size="23" font-weight="bold">Command-center load: process Private Bytes</text><text x="${left}" y="57" font-size="14">${config.sessions} sessions · ${config.contextBytes} context bytes/session · ${duration.toFixed(1)} measured seconds · peak ${(summary.peakPrivateBytes/1e9).toFixed(3)} GB</text>`];
for(let gb=0;gb<=Math.floor(yMax/1e9);gb++) parts.push(`<line x1="${left}" y1="${y(gb*1e9)}" x2="${width-right}" y2="${y(gb*1e9)}" stroke="#dde2e9"/><text x="${left-12}" y="${y(gb*1e9)+5}" text-anchor="end" font-size="13">${gb} GB</text>`);
for(let minute=0;minute<=Math.ceil(xMax);minute+=Math.max(1,Math.ceil(xMax/12))) parts.push(`<text x="${x(minute*60)}" y="${height-bottom+25}" text-anchor="middle" font-size="13">${minute}</text>`);
for(const [bytes,label,color] of [[target,'Target','#bd8600'],[hard,'Hard limit','#c63232']]) parts.push(`<line x1="${left}" y1="${y(bytes)}" x2="${width-right}" y2="${y(bytes)}" stroke="${color}" stroke-dasharray="8 5"/><text x="${width-right-3}" y="${y(bytes)-7}" text-anchor="end" fill="${color}" font-size="13">${label}: ${(bytes/1e9).toFixed(1)} GB</text>`);
for(const [key,color] of Object.entries(colors)) parts.push(line(key,color));
Object.entries(colors).forEach(([key,color],i)=>parts.push(`<rect x="${left+i*250}" y="${height-46}" width="20" height="4" fill="${color}"/><text x="${left+28+i*250}" y="${height-40}" font-size="13">${key==='total'?'Concurrent total':key}</text>`));
parts.push(`<text x="${width/2}" y="${height-bottom+49}" text-anchor="middle" font-size="14">Elapsed minutes</text><text x="${left}" y="${height-13}" font-size="12">Per-second peaks; raw CSV retained. Sequential process sampling; excludes Desktop UI, plugins and measurement driver.</text></g></svg>`);
await writeFile(join(output,'memory-curve.svg'),parts.join('\n'));
console.log(JSON.stringify(summary,null,2));
