import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.env.AI_MEMORY_CONTRACT_EVIDENCE;
if (!source) throw new Error('Set AI_MEMORY_CONTRACT_EVIDENCE to reviewed, sanitized parent binary evidence directory.');
const read = async file => JSON.parse(await readFile(join(source, file), 'utf8'));
const evidence = await read('evidence.json');
if (evidence.safety?.loopbackOnly !== true || evidence.safety?.syntheticDataOnly !== true || evidence.checks.some(item => item.passed !== true)) throw new Error('Binary evidence is incomplete');
const all = await readFile(join(source, '3.3.3-schemas.json'));
const schema = JSON.parse(all);
const withoutDescriptions = value => {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['description', 'instructions', 'title'].includes(key)).map(([key, item]) => [key, withoutDescriptions(item)]));
  return value;
};
const checksums = JSON.parse(await readFile(join(root, 'tests/fixtures/upstream/checksums.json'), 'utf8'));
for (const version of ['3.3.2', '3.3.3']) {
  const data = await read(`${version}-behavior.json`);
  const advanced = await read(`${version}-advanced.json`);
  const noClaim = await read(`${version}-no-claim.json`);
  const restart = await read(`${version}-restart-after.json`);
  const selected = ['write-create', 'read-page', 'write-stale', 'handoff-begin', 'handoff-list', 'handoff-accept-exact', 'hook-session-start', 'hook-pre', 'hook-post-error', 'hook-stop', 'observations-before-end'];
  const value = {
    provenance: { release: `v${version}`, binaryVerified: true, platform: evidence.platform, binarySha256: evidence.versions.find(item => item.version === version).binarySha256, selectedSchemasSha256: createHash('sha256').update(all).digest('hex'), source: 'Parent isolated loopback binary contract probe; synthetic data; no paid providers.' },
    initialize: withoutDescriptions(data.records.find(item => item.label === 'initialize').wire.json.result),
    tools: withoutDescriptions(schema),
    records: data.records.filter(item => selected.includes(item.label)).map(({ label, input, wire }) => ({ label, input, wire })),
    advanced: advanced.records.filter(item => ['query-valid', 'key-prompt', 'key-prompt-repeat', 'keys-visible-1'].includes(item.label)).map(({ label, input, wire }) => ({ label, input, wire })),
    noClaim: noClaim.records.filter(item => ['session-start-false', 'handoff-after-start-false'].includes(item.label)).map(({ label, wire }) => ({ label, wire })),
    restart: restart.records.filter(item => ['restart-keyed-replay', 'restart-observations'].includes(item.label)).map(({ label, wire }) => ({ label, wire })),
  };
  const file = `v${version}-binary.json`;
  const bytes = JSON.stringify(value, null, 2) + '\n';
  await writeFile(join(root, 'tests/fixtures/upstream', file), bytes);
  checksums.files = checksums.files.filter(item => item.file !== file);
  checksums.files.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), release: `v${version}`, binaryVerified: true });
}
await writeFile(join(root, 'tests/fixtures/upstream/checksums.json'), JSON.stringify(checksums, null, 2) + '\n');
console.log('Imported reviewed synthetic binary fixtures. Production capability flags were not changed.');
