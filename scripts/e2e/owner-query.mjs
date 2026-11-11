import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database, until } from './owner-handoff-fixture.mjs';

/** SQL is used only for isolated fault injection and an independent assertion.
 * Production identity and transfer facts always arrive over original stdio. */
export async function verifyOwnerQueries(source, profile, queryIdentity, readTransfer) {
  let identity;
  await until(async () => {
    try { identity = await queryIdentity(() => source); return true; }
    catch (error) { if (error.errorCode === 'HANDOFF_UNAVAILABLE') return false; throw error; }
  }, 'original owner identity available');
  const binding = { host: source, sourceEpoch: identity.sourceEpoch, profileId: identity.profileId };
  const owner = database(profile, db => JSON.parse(db.prepare('SELECT record_json FROM execution_owners WHERE epoch=?').get(identity.sourceEpoch).record_json));
  assert.equal(owner.profile, identity.profileId);
  const build = { sha256: 'b'.repeat(64), schema: 31, protocol: 1 };
  const record = { version: 1, id: randomUUID(), profile: identity.profileId, sourceEpoch: identity.sourceEpoch,
    targetEpoch: randomUUID(), sourceBuild: build, targetBuild: build, requester: owner.coordinator,
    capabilityHash: 'c'.repeat(64), revision: 1, phase: 'cancelled', recoveryAttempt: 0, lastFailure: null };
  const replace = value => database(profile, db => db.prepare('UPDATE owner_handoffs SET source_epoch=?,profile=?,record_json=? WHERE id=?')
    .run(value.sourceEpoch, value.profile, JSON.stringify(value), record.id), false);
  // A terminal fixture cannot fence or block native startup. No production
  // prepare/mutation endpoint is introduced for the sake of the test.
  database(profile, db => db.prepare('INSERT INTO owner_handoffs(id,profile,source_epoch,target_epoch,revision,phase,record_json) VALUES(?,?,?,?,?,?,?)')
    .run(record.id, record.profile, record.sourceEpoch, record.targetEpoch, record.revision, record.phase, JSON.stringify(record)), false);
  assert.deepEqual(await readTransfer(() => binding, record.id), { version: 1, record });
  const originalOwner = JSON.stringify(owner);
  try {
    for (const field of ['host', 'coordinator']) {
      const altered = structuredClone(owner);
      altered[field].createdAt = (BigInt(altered[field].createdAt) + 1n).toString();
      database(profile, db => db.prepare('UPDATE execution_owners SET record_json=? WHERE epoch=?').run(JSON.stringify(altered), owner.epoch), false);
      await assert.rejects(queryIdentity(() => source), error => error.errorCode === 'HANDOFF_UNAVAILABLE');
      await assert.rejects(readTransfer(() => binding, record.id), error => error.errorCode === 'HANDOFF_UNAVAILABLE');
    }
  } finally {
    database(profile, db => db.prepare('UPDATE execution_owners SET record_json=? WHERE epoch=?').run(originalOwner, owner.epoch), false);
  }
  try {
    for (const invalid of [{ ...record, profile: 'f'.repeat(64) },
      { ...record, requester: { ...record.requester, sid: 'S-1-5-21-other' } }, { ...record, revision: 2 }]) {
      replace(invalid);
      await assert.rejects(readTransfer(() => binding, record.id), error => error.errorCode === 'HANDOFF_UNAVAILABLE');
    }
  } finally { replace(record); }
  assert.deepEqual(await readTransfer(() => binding, record.id), { version: 1, record });
  assert.deepEqual(database(profile, db => JSON.parse(db.prepare('SELECT record_json FROM owner_handoffs WHERE id=?').get(record.id).record_json)), record);
  for (const change of [{ sourceEpoch: randomUUID() }, { profileId: 'f'.repeat(64) }]) {
    await assert.rejects(readTransfer(() => ({ ...binding, ...change }), record.id), error => error.errorCode === 'HANDOFF_UNAVAILABLE');
  }
  await assert.rejects(readTransfer(() => binding, randomUUID()), error => error.errorCode === 'HANDOFF_UNAVAILABLE');
  await assert.rejects(source.call('ownerHandoff.identity', { version: 1, requestId: randomUUID(), idle: true }), error =>
    error.errorCode === 'HANDOFF_UNAVAILABLE' && error.message.includes('owner query unavailable'));
  return { identity, owner };
}
