#!/usr/bin/env node
/**
 * Pure recovery and admission helpers for the transactional pi-host deployment.
 *
 * No file system, process or network access lives here: every input is text
 * the worker already read, so the dangerous decisions (is this the same Host,
 * is the saved device still an active owner, is this really the previous
 * version) are unit-testable on any platform. The worker turns a thrown
 * {@link RecoveryFailure} into its typed, durable failure record.
 */

/** A content-addressed version directory, optionally published as a repair. */
export const VERSION_DIR_PATTERN = /^sha256-[a-f0-9]{64}(?:-repair-[a-f0-9]{8,32})?$/;

export class RecoveryFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new RecoveryFailure(code);
};

export function normalizeVersion(value) {
  return String(value ?? "").replace(/^v/, "");
}

/** Strict `major.minor.patch[-prerelease][+build]`; `null` when it is not one. */
export function parseSemver(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? ""));
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split(".") ?? null };
}

/** `-1 | 0 | 1`, or `null` when either side is not a semantic version. */
export function compareVersions(left, right) {
  const a = parseSemver(left), b = parseSemver(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    if (a.pre[index] === undefined || b.pre[index] === undefined) {
      return a.pre[index] === b.pre[index] ? 0 : a.pre[index] === undefined ? -1 : 1;
    }
    const numericA = /^\d+$/.test(a.pre[index]), numericB = /^\d+$/.test(b.pre[index]);
    if (numericA && numericB) {
      const x = BigInt(a.pre[index]), y = BigInt(b.pre[index]);
      if (x !== y) return x < y ? -1 : 1;
    } else if (numericA !== numericB) return numericA ? -1 : 1;
    else if (a.pre[index] !== b.pre[index]) return a.pre[index] < b.pre[index] ? -1 : 1;
  }
  return 0;
}

/** Release (no prerelease) and prerelease are different channels. */
export function sameReleaseChannel(left, right) {
  const a = parseSemver(left), b = parseSemver(right);
  if (!a || !b) return false;
  return (a.pre === null) === (b.pre === null);
}

export function isVersionDirName(name) {
  return typeof name === "string" && VERSION_DIR_PATTERN.test(name);
}

/** One readiness line the Host printed; `null` for anything malformed. */
export function parseReadyLine(line) {
  if (typeof line !== "string" || !line.startsWith("PI_HOST_READY ")) return null;
  let value;
  try { value = JSON.parse(line.slice("PI_HOST_READY ".length)); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const { hostId, host, port, version } = value;
  if (typeof hostId !== "string" || !hostId) return null;
  if (host !== "127.0.0.1" && host !== "::1") return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof version !== "string" || !version) return null;
  return { hostId, host, port, version };
}

/** Last readiness the recorded log holds: the running process's own statement. */
export function lastReady(logText) {
  if (typeof logText !== "string") return null;
  const lines = logText.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const ready = parseReadyLine(lines[index]);
    if (ready) return ready;
  }
  return null;
}

/**
 * The one active owner device matching a saved token hash.
 *
 * `DeviceRecord` has no expiry field: a device is live until `revokedAt` is set.
 * The caller only ever supplies the SHA-256 of the desktop's stored token, so
 * a raw token never reaches the Host or its logs.
 */
export function findOwnerDevice(credentialsText, tokenHash) {
  if (typeof tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(tokenHash)) fail("HOST_AUTH_FAILED");
  let value;
  try { value = JSON.parse(credentialsText); } catch { fail("HOST_RECOVERY_REQUIRED"); }
  if (!value || !Array.isArray(value.devices)) fail("HOST_RECOVERY_REQUIRED");
  const matches = value.devices.filter((device) => device && device.tokenHash === tokenHash);
  if (matches.length !== 1) fail("HOST_AUTH_FAILED");
  const [device] = matches;
  if (typeof device.deviceId !== "string" || !device.deviceId) fail("HOST_RECOVERY_REQUIRED");
  if (device.revokedAt) fail("HOST_AUTH_FAILED");
  if (!Array.isArray(device.roles) || !device.roles.includes("owner")) fail("HOST_AUTH_FAILED");
  return { deviceId: device.deviceId, tokenHash, roles: ["owner"] };
}

/**
 * The previous release, from independent on-disk evidence.
 *
 * A damaged install may have lost its version directory but keeps the log the
 * running process wrote and/or the surviving package manifest. Disagreement is
 * treated as unknown (never as "take the bigger one"), and the candidate must
 * stay in the same release channel and never go backwards.
 */
export function admitVersionEvidence({ candidateVersion, packageVersion, readyVersion, expectedCurrentVersion }) {
  const evidence = [];
  if (typeof packageVersion === "string" && packageVersion) evidence.push(["package", normalizeVersion(packageVersion)]);
  if (typeof readyVersion === "string" && readyVersion) evidence.push(["readiness", normalizeVersion(readyVersion)]);
  if (evidence.length === 0) fail("HOST_RECOVERY_REQUIRED");
  if (evidence.some(([, version]) => version !== evidence[0][1])) fail("HOST_RECOVERY_REQUIRED");
  const previous = evidence[0][1];
  if (!parseSemver(previous)) fail("HOST_RECOVERY_REQUIRED");
  if (!parseSemver(candidateVersion)) fail("HOST_VERSION_MISMATCH");
  if (expectedCurrentVersion && normalizeVersion(expectedCurrentVersion) !== previous) fail("HOST_VERSION_MISMATCH");
  const promotesToStable = parseSemver(previous).pre !== null && parseSemver(candidateVersion).pre === null;
  if (!promotesToStable && !sameReleaseChannel(candidateVersion, previous)) fail("HOST_VERSION_MISMATCH");
  if (compareVersions(candidateVersion, previous) < 0) fail("HOST_VERSION_MISMATCH");
  return {
    version: previous,
    sources: evidence.map(([source]) => source),
  };
}

/**
 * Admission for a Host whose installed bundle is missing or damaged.
 *
 * There is no live process to ask, so identity, owner credential and the
 * previous release are all taken from durable host state. Any missing piece
 * fails closed: a repair must never mint a new Host or re-pair silently.
 */
export function admitOfflineHost({
  identityText,
  credentialsText,
  expectedHostId,
  expectedDeviceTokenHash,
  requireOwnerDevice = true,
  candidateVersion,
  packageVersion,
  readyVersion,
  expectedCurrentVersion,
}) {
  if (typeof expectedHostId !== "string" || !expectedHostId.trim()) fail("HOST_AUTH_FAILED");
  let identity;
  try { identity = JSON.parse(identityText); } catch { fail("HOST_RECOVERY_REQUIRED"); }
  if (!identity || typeof identity.hostId !== "string" || !identity.hostId) fail("HOST_RECOVERY_REQUIRED");
  if (identity.hostId !== expectedHostId) fail("HOST_AUTH_FAILED");
  let deviceId = null;
  if (requireOwnerDevice || typeof expectedDeviceTokenHash === "string") {
    deviceId = findOwnerDevice(credentialsText, expectedDeviceTokenHash).deviceId;
  }
  const version = admitVersionEvidence({ candidateVersion, packageVersion, readyVersion, expectedCurrentVersion });
  return { hostId: identity.hostId, deviceId, version: version.version, sources: version.sources };
}

/** A granted lease itself reports busy to every other caller. */
export function validateMaintenanceLease(reply, leaseId, now = Date.now()) {
  if (reply?.ok !== true || reply.leaseId !== leaseId || typeof reply.expiresAt !== "string") fail("HOST_MAINTENANCE_UNAVAILABLE");
  const remaining = Date.parse(reply.expiresAt) - now;
  if (!Number.isFinite(remaining) || remaining < 25_000 || remaining > 120_000) fail("HOST_MAINTENANCE_UNAVAILABLE");
}

/** Initial enrollment is permitted only when no previous Host state exists. */
export function admitFreshInstallation({ currentKind, preservePairing, expectedHostId, identityExists, credentialsExist, readyExists, processState }) {
  if (currentKind !== "absent" || preservePairing || expectedHostId || identityExists || credentialsExist || readyExists) fail("HOST_AUTH_FAILED");
  if (processState !== "dead") fail("HOST_PROCESS_UNIDENTIFIED");
}

export function deploymentNeedsPairing(preservePairing) { return preservePairing !== true; }

/** Pairing output uses an ISO expiry; older workers also emitted epoch milliseconds. */
export function parsePairingLine(line) {
  if (typeof line !== "string" || !line.startsWith("PI_HOST_PAIRING_TOKEN ")) return null;
  let value;
  try { value = JSON.parse(line.slice("PI_HOST_PAIRING_TOKEN ".length)); } catch { return null; }
  if (!value || typeof value.token !== "string" || !value.token) return null;
  const expiry = typeof value.expiresAt === "string" ? Date.parse(value.expiresAt) : value.expiresAt;
  if (typeof expiry !== "number" || !Number.isFinite(expiry) || expiry <= 0) return null;
  return { token: value.token, expiresAt: expiry };
}
