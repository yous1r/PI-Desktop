import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('curve export preserves concurrent peaks and every raw CSV row', async () => {
  assert.ok(process.env.PI_SCRATCH_DIR, 'An isolated scratch directory is required');
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'curve-test-'));
  const output = join(directory, 'out');
  const roles = ['coordinator','host','sidecar'];
  const rows = [0, 1, 2].map(i => ({ timestampMs: 1000+i*1000, collectionMs: 2,
    processes: roles.map((role,j) => ({ role,pid:j+1,startTime:'fixed',privateBytes:(i+2)*500000000,
      workingSetBytes:1000,cpuSeconds:i,handles:10+i,threads:3 })) }));
  try {
    await writeFile(join(directory,'config.json'),JSON.stringify({ sessions:36,contextBytes:1048576,targetBytes:4000000000,budgetBytes:6000000000 }));
    await writeFile(join(directory,'memory.ndjson'),rows.map(JSON.stringify).join('\n')+'\n');
    execFileSync(process.execPath,[fileURLToPath(new URL('./e2e-command-center-curve.mjs',import.meta.url)),directory,output],{stdio:'pipe'});
    const result=JSON.parse(await readFile(join(output,'curve-metrics.json'),'utf8'));
    assert.equal(result.peakPrivateBytes,6000000000); assert.equal(result.meanPrivateBytes,4500000000);
    assert.equal(result.targetMet,false); assert.equal(result.hardLimitMet,true); assert.equal(result.samplesAboveTarget,2);
    assert.equal(result.processMetrics.host.cpuSeconds,2);
    const csv=(await readFile(join(output,'memory.csv'),'utf8')).trim().split('\n');
    assert.equal(csv.length,4); assert.equal(Number(csv[3].split(',')[2]),6000000000);
    const svg=await readFile(join(output,'memory-curve.svg'),'utf8');
    assert.equal((svg.match(/<polyline /g)??[]).length,4); assert.ok(!/NaN|Infinity/.test(svg));
    assert.match(svg,/Hard limit: 6.0 GB/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
