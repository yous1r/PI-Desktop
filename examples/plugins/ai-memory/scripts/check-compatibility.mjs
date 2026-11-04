import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(await readFile(join(root, 'compatibility/supported-versions.json'), 'utf8'));
const checksums = JSON.parse(await readFile(join(root, 'tests/fixtures/upstream/checksums.json'), 'utf8'));
assert.equal(catalog.schemaVersion, 1);
for (const fixture of checksums.files) {
  assert.match(fixture.file, /^[a-zA-Z0-9.-]+\.json$/);
  const bytes = await readFile(join(root, 'tests/fixtures/upstream', fixture.file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha256, `Fixture checksum: ${fixture.file}`);
}
for (const [version, entry] of Object.entries(catalog.releases)) {
  if (entry.writesVerified || entry.hookVerified || entry.hookIdempotencyVerified) {
    assert.ok(checksums.files.some(fixture => fixture.release === `v${version}` && fixture.binaryVerified), `Missing binary contract evidence for ${version}`);
    assert.ok(entry.evidence && !/pending|source baseline only/i.test(entry.evidence), `Evidence reference required for ${version}`);
    assert.ok(checksums.files.some(fixture => fixture.file === `v${version}-plugin.json` && fixture.binaryVerified), `Missing production plugin/server evidence for ${version}`);
    const evidence = JSON.parse(await readFile(join(root, 'tests/fixtures/upstream', `v${version}-plugin.json`), 'utf8'));
    assert.equal(evidence.release, version); assert.ok(evidence.observations.length > 10); assert.equal(evidence.assertions.length, 12);
  }
}
const descriptors = JSON.parse(await readFile(join(root, 'tests/fixtures/upstream/v3-all-tools.json'), 'utf8'));
assert.equal(descriptors.tools.length, 25);
assert.equal(createHash('sha256').update(JSON.stringify(descriptors.tools)).digest('hex'), descriptors.serializedToolsSha256);
await readFile(join(root, 'compatibility/verified-contract.md'));
console.log('Compatibility catalog and pinned fixture integrity passed. No server was contacted.');
