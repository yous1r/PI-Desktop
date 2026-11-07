/**
 * Pure admission/recovery helpers of the transactional pi-host deployment.
 *
 * These decide whether an upgrade or a repair may start a new Host: identity,
 * the saved owner device, the previous release and the directory naming rules.
 * They take text only, so every branch is provable on any platform.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  admitOfflineHost, admitVersionEvidence, compareVersions, findOwnerDevice, isVersionDirName,
  lastReady, parseReadyLine, sameReleaseChannel,
  validateMaintenanceLease, admitFreshInstallation, deploymentNeedsPairing,
  admitInterruptedDeployment, pairingRecordUsable,
} from "../../pi-host/scripts/deploy-recovery.mjs";

const HOST_ID = "host_abc";
const TOKEN_HASH = "b".repeat(64);
const OWNER = {
  deviceId: "dev_1",
  label: "desktop",
  roles: ["owner"],
  tokenHash: TOKEN_HASH,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const identity = JSON.stringify({ hostId: HOST_ID, createdAt: "2026-01-01T00:00:00.000Z" });
const credentials = (devices) => JSON.stringify({ devices, pairings: [] });

function code(fn) {
  try { fn(); } catch (error) { return error.code; }
  return null;
}

test("semantic comparison orders releases and prereleases", () => {
  assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
  assert.equal(compareVersions("1.3.0", "1.2.9"), 1);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("1.2.3-beta.1", "1.2.3"), -1);
  assert.equal(compareVersions("1.2.3-beta.2", "1.2.3-beta.10"), -1);
  assert.equal(compareVersions("1.2.3-beta.1", "1.2.3-beta"), 1);
  assert.equal(compareVersions("1.2.3+build.5", "1.2.3"), 0);
  assert.equal(compareVersions("not-a-version", "1.2.3"), null);
  assert.equal(compareVersions("1.2.3", undefined), null);
});

test("release and prerelease are different channels", () => {
  assert.equal(sameReleaseChannel("1.2.3", "1.3.0"), true);
  assert.equal(sameReleaseChannel("1.2.3-beta.1", "1.2.3-beta.9"), true);
  assert.equal(sameReleaseChannel("1.2.3", "1.2.3-beta.1"), false);
  assert.equal(sameReleaseChannel("bad", "1.2.3"), false);
});

test("version directory names accept only canonical or repair siblings", () => {
  const digest = "a".repeat(64);
  assert.equal(isVersionDirName(`sha256-${digest}`), true);
  assert.equal(isVersionDirName(`sha256-${digest}-repair-0123456789abcdef`), true);
  for (const invalid of [
    `sha256-${digest}-repair-`, `sha256-${digest}-repair-ZZZZ`, `sha256-${"a".repeat(63)}`,
    `../sha256-${digest}`, `/sha256-${digest}`, `sha256-${digest}-repair-${"a".repeat(33)}`, "",
  ]) {
    assert.equal(isVersionDirName(invalid), false, invalid);
  }
});

test("readiness parsing keeps only one valid loopback line and prefers the last", () => {
  const line = 'PI_HOST_READY {"hostId":"host_abc","host":"127.0.0.1","port":41234,"version":"0.22.1-beta.6"}';
  assert.deepEqual(parseReadyLine(line), {
    hostId: "host_abc", host: "127.0.0.1", port: 41234, version: "0.22.1-beta.6",
  });
  assert.equal(parseReadyLine('PI_HOST_READY {"hostId":"h","host":"0.0.0.0","port":1,"version":"1"}'), null);
  assert.equal(parseReadyLine('PI_HOST_READY {"hostId":"h","host":"127.0.0.1","port":0,"version":"1"}'), null);
  assert.equal(parseReadyLine("PI_HOST_READY {broken"), null);
  assert.equal(parseReadyLine(undefined), null);

  const log = [
    'PI_HOST_READY {"hostId":"host_old","host":"127.0.0.1","port":1000,"version":"0.21.0"}',
    "some later log line",
    line,
  ].join("\n");
  assert.equal(lastReady(log)?.hostId, "host_abc");
  assert.equal(lastReady(log)?.version, "0.22.1-beta.6");
  assert.equal(lastReady(""), null);
  assert.equal(lastReady(undefined), null);
});

test("only an unrevoked owner device hash is admitted", () => {
  const device = findOwnerDevice(credentials([OWNER]), TOKEN_HASH);
  assert.equal(device.deviceId, "dev_1");
  // The helper never returns or copies the raw credential: only its hash.
  assert.equal(JSON.stringify(device).includes(TOKEN_HASH), true);
  assert.equal(code(() => findOwnerDevice(credentials([{ ...OWNER, revokedAt: "2026-02-01T00:00:00.000Z" }]), TOKEN_HASH)), "HOST_AUTH_FAILED");
  assert.equal(code(() => findOwnerDevice(credentials([{ ...OWNER, roles: ["viewer"] }]), TOKEN_HASH)), "HOST_AUTH_FAILED");
  assert.equal(code(() => findOwnerDevice(credentials([OWNER, OWNER]), TOKEN_HASH)), "HOST_AUTH_FAILED");
  assert.equal(code(() => findOwnerDevice(credentials([]), TOKEN_HASH)), "HOST_AUTH_FAILED");
  assert.equal(code(() => findOwnerDevice("not json", TOKEN_HASH)), "HOST_RECOVERY_REQUIRED");
  assert.equal(code(() => findOwnerDevice(JSON.stringify({ devices: "x" }), TOKEN_HASH)), "HOST_RECOVERY_REQUIRED");
  // A raw token (not a 64-hex hash) is refused before any lookup.
  assert.equal(code(() => findOwnerDevice(credentials([OWNER]), "ppt1.raw-token")), "HOST_AUTH_FAILED");
});

test("previous version evidence must be present, unambiguous and upgradeable", () => {
  assert.deepEqual(
    admitVersionEvidence({
      candidateVersion: "0.22.1-beta.6",
      packageVersion: "0.22.1-beta.5",
      readyVersion: "0.22.1-beta.5",
      expectedCurrentVersion: "0.22.1-beta.5",
    }),
    { version: "0.22.1-beta.5", sources: ["package", "readiness"] },
  );
  // One surviving source is enough; the readiness log outlives a deleted bundle.
  assert.deepEqual(
    admitVersionEvidence({ candidateVersion: "0.22.1-beta.6", readyVersion: "0.22.1-beta.5" }),
    { version: "0.22.1-beta.5", sources: ["readiness"] },
  );
  const base = { candidateVersion: "0.22.1-beta.6", packageVersion: "0.22.1-beta.5" };
  assert.equal(code(() => admitVersionEvidence({ ...base, readyVersion: "0.22.0" })), "HOST_RECOVERY_REQUIRED");
  assert.equal(code(() => admitVersionEvidence({ candidateVersion: "0.22.1-beta.6" })), "HOST_RECOVERY_REQUIRED");
  assert.equal(code(() => admitVersionEvidence({ ...base, expectedCurrentVersion: "0.22.1-beta.6" })), "HOST_VERSION_MISMATCH");
  assert.equal(code(() => admitVersionEvidence({ ...base, candidateVersion: "0.22.1-beta.4" })), "HOST_VERSION_MISMATCH");
  assert.equal(code(() => admitVersionEvidence({ ...base, candidateVersion: "0.22.0" })), "HOST_VERSION_MISMATCH");
  assert.equal(code(() => admitVersionEvidence({ ...base, candidateVersion: "garbage" })), "HOST_VERSION_MISMATCH");
  assert.equal(code(() => admitVersionEvidence({ candidateVersion: "0.22.1", readyVersion: "not-a-version" })), "HOST_RECOVERY_REQUIRED");
});

test("explicit SSH enrollment can recover an offline identity without a readiness log", () => {
  const input = {
    identityText: identity, credentialsText: credentials([OWNER]), requireOwnerDevice: false,
    allowNewEnrollment: true, candidateVersion: "0.22.2", packageVersion: "0.21.0",
  };
  assert.deepEqual(admitOfflineHost(input), {
    hostId: HOST_ID, deviceId: null, version: "0.21.0", sources: ["package"],
  });
  for (const identityText of [undefined, "null", "{}", "broken", '{"hostId":" "}']) {
    assert.equal(code(() => admitOfflineHost({ ...input, identityText })), "HOST_RECOVERY_REQUIRED");
  }
  for (const expectedHostId of ["", "host_other", null]) {
    assert.equal(code(() => admitOfflineHost({ ...input, expectedHostId })), "HOST_AUTH_FAILED");
  }
  for (const credentialsText of [undefined, null, "null", "broken", "{}", '{"devices":{}}']) {
    assert.equal(code(() => admitOfflineHost({ ...input, credentialsText })), "HOST_RECOVERY_REQUIRED");
  }
  assert.equal(code(() => admitOfflineHost({ ...input, allowNewEnrollment: false })), "HOST_AUTH_FAILED");
  assert.equal(code(() => admitOfflineHost({ ...input, requireOwnerDevice: true })), "HOST_AUTH_FAILED");
  assert.equal(code(() => admitOfflineHost({ ...input, expectedDeviceTokenHash: TOKEN_HASH })), "HOST_AUTH_FAILED");
  assert.equal(code(() => admitOfflineHost({ ...input, expectedHostId: HOST_ID,
    expectedDeviceTokenHash: TOKEN_HASH, credentialsText: credentials([{ ...OWNER, revokedAt: "revoked" }]),
  })), "HOST_AUTH_FAILED");
  assert.equal(code(() => admitOfflineHost({ ...input, packageVersion: "0.23.0" })), "HOST_VERSION_MISMATCH");
  assert.equal(code(() => admitOfflineHost({ ...input, readyVersion: "0.22.0" })), "HOST_RECOVERY_REQUIRED");
});

test("offline admission requires identity, owner device and version evidence", () => {
  const admitted = admitOfflineHost({
    identityText: identity,
    credentialsText: credentials([OWNER]),
    expectedHostId: HOST_ID,
    expectedDeviceTokenHash: TOKEN_HASH,
    candidateVersion: "0.22.1-beta.6",
    packageVersion: "0.22.1-beta.5",
    readyVersion: "0.22.1-beta.5",
  });
  assert.equal(admitted.hostId, HOST_ID);
  assert.equal(admitted.deviceId, "dev_1");
  assert.equal(admitted.version, "0.22.1-beta.5");
  assert.equal(JSON.stringify(admitted).includes("ppt1"), false);

  const base = {
    identityText: identity,
    credentialsText: credentials([OWNER]),
    expectedHostId: HOST_ID,
    expectedDeviceTokenHash: TOKEN_HASH,
    candidateVersion: "0.22.1-beta.6",
    readyVersion: "0.22.1-beta.5",
  };
  // A different saved Host must never be adopted or re-minted.
  assert.equal(code(() => admitOfflineHost({ ...base, identityText: JSON.stringify({ hostId: "host_other" }) })), "HOST_AUTH_FAILED");
  assert.equal(code(() => admitOfflineHost({ ...base, expectedHostId: "host_other" })), "HOST_AUTH_FAILED");
  assert.equal(code(() => admitOfflineHost({ ...base, expectedHostId: "" })), "HOST_AUTH_FAILED");
  assert.equal(code(() => admitOfflineHost({ ...base, identityText: "{}" })), "HOST_RECOVERY_REQUIRED");
  assert.equal(code(() => admitOfflineHost({ ...base, identityText: "broken" })), "HOST_RECOVERY_REQUIRED");
  // Repair must prove the saved owner device, never a token or a fresh pairing.
  assert.equal(code(() => admitOfflineHost({ ...base, expectedDeviceTokenHash: undefined })), "HOST_AUTH_FAILED");
  assert.equal(code(() => admitOfflineHost({ ...base, credentialsText: credentials([{ ...OWNER, revokedAt: "x" }]) })), "HOST_AUTH_FAILED");
  assert.equal(code(() => admitOfflineHost({ ...base, credentialsText: credentials([{ ...OWNER, roles: ["controller"] }]) })), "HOST_AUTH_FAILED");
  assert.equal(code(() => admitOfflineHost({ ...base, credentialsText: "not json" })), "HOST_RECOVERY_REQUIRED");
  // Version checks still apply to the offline path.
  assert.equal(code(() => admitOfflineHost({ ...base, candidateVersion: "0.22.1-beta.4" })), "HOST_VERSION_MISMATCH");
  assert.equal(admitOfflineHost({ ...base, candidateVersion: "0.22.1" }).version, "0.22.1-beta.5");
  assert.equal(admitOfflineHost({ ...base, candidateVersion: "0.22.2" }).hostId, HOST_ID);
  assert.equal(code(() => admitOfflineHost({ ...base, readyVersion: "0.22.1", candidateVersion: "0.22.2-beta.1" })), "HOST_VERSION_MISMATCH");
  // Without a required device (intact install, stopped process), identity and
  // version alone gate the upgrade; no credential is read or minted.
  const withoutDevice = admitOfflineHost({
    ...base,
    expectedDeviceTokenHash: undefined,
    requireOwnerDevice: false,
  });
  assert.equal(withoutDevice.deviceId, null);
  assert.equal(withoutDevice.hostId, HOST_ID);
});

test("maintenance acquisition accepts its own busy lease and rejects expired or foreign leases", () => {
  const now = 1_000_000;
  const reply = { ok: true, busy: true, leaseId: "l1", expiresAt: new Date(now + 120_000).toISOString() };
  assert.doesNotThrow(() => validateMaintenanceLease(reply, "l1", now));
  assert.throws(() => validateMaintenanceLease(reply, "other", now), { code: "HOST_MAINTENANCE_UNAVAILABLE" });
  assert.throws(() => validateMaintenanceLease(reply, "l1", now + 120_000), { code: "HOST_MAINTENANCE_UNAVAILABLE" });
});

test("first install requires an empty identity boundary and repair never pairs again", () => {
  const fresh = { currentKind: "absent", processState: "dead" };
  assert.doesNotThrow(() => admitFreshInstallation(fresh));
  for (const extra of [{ identityExists: true }, { credentialsExist: true }, { readyExists: true },
    { preservePairing: true }, { expectedHostId: "enrolled" }, { currentKind: "ready" }]) {
    assert.throws(() => admitFreshInstallation({ ...fresh, ...extra }), { code: "HOST_AUTH_FAILED" });
  }
  assert.throws(() => admitFreshInstallation({ ...fresh, processState: "unidentified" }), { code: "HOST_PROCESS_UNIDENTIFIED" });
  assert.equal(deploymentNeedsPairing(false), true);
  assert.equal(deploymentNeedsPairing(true), false);
});

test("interrupted deployment resumes only matching post-start identity and release evidence", () => {
  const transactionId = "d".repeat(32);
  const input = { record: { protocol: 1, transactionId, phase: "recovery-required", version: "0.22.2",
    hostId: HOST_ID, failureCode: "HOST_RECOVERY_REQUIRED" }, request: { transactionId, version: "0.22.2" },
    identity: { hostId: HOST_ID }, ready: { hostId: HOST_ID, version: "0.22.2" }, targetVersion: "0.22.2" };
  assert.deepEqual(admitInterruptedDeployment(input), { hostId: HOST_ID });
  for (const phase of ["queued", "starting", "activating", "failed-safe", "complete"]) {
    assert.equal(code(() => admitInterruptedDeployment({ ...input, record: { ...input.record, phase } })), "HOST_RECOVERY_REQUIRED");
  }
  assert.equal(code(() => admitInterruptedDeployment({ ...input, request: { ...input.request, transactionId: "e".repeat(32) } })), "HOST_RECOVERY_REQUIRED");
  assert.equal(code(() => admitInterruptedDeployment({ ...input, targetVersion: "0.22.1" })), "HOST_VERSION_MISMATCH");
  assert.equal(code(() => admitInterruptedDeployment({ ...input, ready: { ...input.ready, hostId: "other" } })), "HOST_AUTH_FAILED");
  assert.equal(code(() => admitInterruptedDeployment({ ...input, expectedHostId: "other" })), "HOST_AUTH_FAILED");
  assert.equal(code(() => admitInterruptedDeployment({ ...input, request: { ...input.request, preservePairing: true } })), "HOST_AUTH_FAILED");
  const enrolled = { ...input, preservePairing: true, expectedHostId: HOST_ID, expectedDeviceTokenHash: TOKEN_HASH, credentialsText: credentials([OWNER]) };
  assert.deepEqual(admitInterruptedDeployment(enrolled), { hostId: HOST_ID });
  assert.equal(code(() => admitInterruptedDeployment({ ...enrolled, credentialsText: credentials([{ ...OWNER, revokedAt: "now" }]) })), "HOST_AUTH_FAILED");
});

test("recovery reuses only an unexpired and unconsumed persisted pairing", () => {
  const now = 1_800_000_000_000, tokenHash = "f".repeat(64), pairing = { token: "fixture", expiresAt: now + 60_000 };
  const record = { tokenHash, expiresAt: new Date(now + 60_000).toISOString() };
  assert.equal(pairingRecordUsable(pairing, { pairings: [record] }, tokenHash, now), true);
  for (const candidate of [{ ...record, consumedAt: "now" }, { ...record, tokenHash: "other" },
    { ...record, expiresAt: new Date(now - 1).toISOString() }]) {
    assert.equal(pairingRecordUsable(pairing, { pairings: [candidate] }, tokenHash, now), false);
  }
  assert.equal(pairingRecordUsable({ ...pairing, expiresAt: now }, { pairings: [record] }, tokenHash, now), false);
  assert.equal(pairingRecordUsable(null, {}, tokenHash, now), false);
});
