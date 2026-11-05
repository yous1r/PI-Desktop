import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstream = process.env.AI_MEMORY_CONTRACT_EVIDENCE;
const plugin = process.env.AI_MEMORY_PLUGIN_EVIDENCE;
if (!upstream || !plugin) throw new Error('Provide reviewed upstream and passing production plugin evidence directories.');
const directory = join(root, 'tests/fixtures/upstream');
const checksums = JSON.parse(await readFile(join(directory, 'checksums.json'), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
async function save(file, value, release) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  assert.ok(!/Bearer |authorization|C:\\\\Users|C:\/Users/.test(bytes), 'Evidence must be sanitized');
  await writeFile(join(directory, file), bytes);
  checksums.files = checksums.files.filter(entry => entry.file !== file);
  checksums.files.push({ file, sha256: hash(bytes), release, binaryVerified: true });
}
let descriptors;
for (const version of ['3.3.2', '3.3.3']) {
  const discovery = JSON.parse(await readFile(join(upstream, `${version}-discovery.json`), 'utf8'));
  const tools = discovery.records.find(item => item.input?.method === 'tools/list').wire.json.result.tools;
  assert.equal(tools.length, 25);
  assert.equal(hash(JSON.stringify(tools)), '5574bc6e9b110082862ce910b22a359ebc1248e82dce9737fffe893ed097e135');
  if (descriptors) assert.deepEqual(tools, descriptors);
  descriptors = tools;
  const evidence = JSON.parse(await readFile(join(plugin, `plugin-${version}.json`), 'utf8'));
  assert.equal(evidence.release, version); assert.equal(evidence.assertions.length, 12); assert.ok(evidence.observations.length > 10);
  await save(`v${version}-plugin.json`, evidence, `v${version}`);
}
await save('v3-all-tools.json', { releases: ['3.3.2', '3.3.3'], serializedToolsSha256: hash(JSON.stringify(descriptors)), tools: descriptors }, 'v3.3.2,v3.3.3');
await writeFile(join(directory, 'checksums.json'), JSON.stringify(checksums, null, 2) + '\n');
console.log('Stored sanitized production plugin evidence and identical complete 25-tool descriptors.');
