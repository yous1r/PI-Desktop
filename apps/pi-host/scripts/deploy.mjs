#!/usr/bin/env node
/** Detached Linux deployment worker for a locally verified pi-host artifact. */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, closeSync, copyFileSync, createReadStream, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  admitOfflineHost, compareVersions, isVersionDirName, lastReady, normalizeVersion,
  admitFreshInstallation, validateMaintenanceLease, deploymentNeedsPairing,
  parseReadyLine, parsePairingLine, sameReleaseChannel, admitInterruptedDeployment, pairingRecordUsable,
} from "./deploy-recovery.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const PROTOCOL = 1;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const FAILURE_CODES = new Set([
  "HOST_BUSY", "HOST_AUTH_FAILED", "HOST_MAINTENANCE_UNAVAILABLE", "HOST_VERSION_MISMATCH",
  "HOST_RECOVERY_REQUIRED", "DEPLOYMENT_FAILED", "HOST_PROCESS_UNIDENTIFIED", "HOST_STOP_TIMEOUT",
]);
export class DeploymentError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new DeploymentError(code); };
function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { fail("DEPLOYMENT_FAILED"); }
}
function exists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  // Directory fsync aids durability on POSIX and is best effort elsewhere:
  // it must never fail the write or hide an already-durable record.
  try {
    const directoryFd = openSync(dirname(path), "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch { /* best effort */ }
}
function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("DEPLOYMENT_FAILED");
  chmodSync(path, 0o700);
}
function paths(home) {
  if (typeof home !== "string" || !isAbsolute(home)) fail("DEPLOYMENT_FAILED");
  const base = resolve(home, ".pi-desktop", "pi-host"), work = join(base, ".bootstrap");
  privateDirectory(base); privateDirectory(work);
  const transactions = join(work, "transactions"); privateDirectory(transactions);
  return { base, work, transactions, state: join(work, "deployment-state.json"), lock: join(base, ".deploy.lock") };
}
/** Classify `current` read-only: repairable (absent/broken) vs a legacy directory. */
function inspectCurrent(base) {
  const current = join(base, "current");
  if (!exists(current)) return { kind: "absent" };
  if (!lstatSync(current).isSymbolicLink()) return { kind: "unsafe" };
  let target;
  try { target = realpathSync(current); } catch { return { kind: "broken" }; }
  const relative = target.startsWith(`${base}/`) ? target.slice(base.length + 1) : "";
  if (!isVersionDirName(relative) || !lstatSync(target).isDirectory()) return { kind: "broken" };
  return { kind: "ready", dir: target };
}
/** Version named by a surviving package manifest; `null` when unreadable. */
function directoryVersion(dir) {
  try {
    const version = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
    return typeof version === "string" && version ? version : null;
  } catch { return null; }
}
function readText(path) {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", timeout: options.timeout ?? 30_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" }, ...options,
  });
  if (result.error || result.status !== 0) fail(options.code ?? "DEPLOYMENT_FAILED");
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function sha256(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256"), stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}
function saveState(root, tx, phase, details = {}) {
  const value = {
    protocol: PROTOCOL, transactionId: tx.transactionId, phase, version: tx.version,
    oldVersion: tx.oldVersion ?? null, hostId: tx.hostId ?? tx.expectedHostId ?? null,
    updatedAt: new Date().toISOString(), ...details,
  };
  writeJsonAtomic(root.state, value);
  writeJsonAtomic(join(tx.transactionDir, "transaction.json"), value);
  return value;
}
function validateRequest(request, root, requestPath) {
  const transactionDir = dirname(requestPath);
  if (resolve(transactionDir) !== resolve(root.transactions, request.transactionId) ||
      !/^[a-f0-9]{32}$/.test(request.transactionId) || !lstatSync(transactionDir).isDirectory() ||
      lstatSync(transactionDir).isSymbolicLink()) fail("DEPLOYMENT_FAILED");
  if (!/^pi-host-[A-Za-z0-9.+-]+-linux-(?:x64|arm64)$/.test(request.bundleDir) ||
      !Number.isInteger(request.port) || request.port < 0 || request.port > 65535 ||
      !Number.isInteger(request.readyTimeoutSec) || request.readyTimeoutSec < 1 || request.readyTimeoutSec > 300 ||
      !Number.isInteger(request.pairingLifetimeMs) || request.pairingLifetimeMs < 1 || request.pairingLifetimeMs > 86_400_000 ||
      typeof request.version !== "string" || typeof request.artifactName !== "string" ||
      !/^[a-f0-9]{64}$/.test(request.expectedSha256) || typeof request.artifactPath !== "string") fail("DEPLOYMENT_FAILED");
  const artifact = realpathSync(request.artifactPath);
  if (resolve(artifact) !== resolve(transactionDir, "artifact.tar.gz") || !lstatSync(artifact).isFile() ||
      statSync(artifact).size > MAX_ARTIFACT_BYTES) fail("DEPLOYMENT_FAILED");
  if (request.expectedHostId !== undefined && (typeof request.expectedHostId !== "string" || !request.expectedHostId.trim())) fail("DEPLOYMENT_FAILED");
  if (request.expectedCurrentVersion !== undefined && typeof request.expectedCurrentVersion !== "string") fail("DEPLOYMENT_FAILED");
  // Only a SHA-256 of the desktop's device token ever reaches the host. A raw
  // token would be a credential leak in the request file, logs and state.
  if (request.expectedDeviceTokenHash !== undefined &&
      (typeof request.expectedDeviceTokenHash !== "string" || !/^[a-f0-9]{64}$/.test(request.expectedDeviceTokenHash))) {
    fail("DEPLOYMENT_FAILED");
  }
  if (request.preservePairing === true && !request.expectedHostId) fail("HOST_AUTH_FAILED");
  return { ...request, transactionDir };
}
function runMaintenance(node, entry, op, expectedHostId, leaseId) {
  const input = { op, expectedHostId, ...(leaseId ? { leaseId } : {}) };
  const result = spawnSync(node, [entry, "maintenance"], {
    input: `${JSON.stringify(input)}\n`, encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024,
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  });
  const stdout = String(result.stdout ?? "");
  if (result.error || result.status !== 0) {
    if (/HOST_BUSY/.test(stdout)) fail("HOST_BUSY");
    if (/HOST_AUTH_FAILED/.test(stdout)) fail("HOST_AUTH_FAILED");
    fail("HOST_MAINTENANCE_UNAVAILABLE");
  }
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length !== 1 || !lines[0].startsWith("PI_HOST_MAINTENANCE ")) fail("HOST_MAINTENANCE_UNAVAILABLE");
  let reply;
  try { reply = JSON.parse(lines[0].slice("PI_HOST_MAINTENANCE ".length)); }
  catch { fail("HOST_MAINTENANCE_UNAVAILABLE"); }
  if (reply?.ok !== true) {
    // The host CLI answers `{ ok: false, code }`; older shapes used `error`.
    const code = reply?.code ?? reply?.error;
    if (code === "HOST_BUSY") fail("HOST_BUSY");
    if (code === "HOST_AUTH_FAILED") fail("HOST_AUTH_FAILED");
    fail("HOST_MAINTENANCE_UNAVAILABLE");
  }
  if (reply.protocol !== PROTOCOL || typeof reply.hostId !== "string" || !reply.hostId ||
      typeof reply.version !== "string" || typeof reply.busy !== "boolean") fail("HOST_MAINTENANCE_UNAVAILABLE");
  if (expectedHostId && reply.hostId !== expectedHostId) fail("HOST_AUTH_FAILED");
  return reply;
}
function hasMaintenance(currentDir, node, entry) {
  try { if (JSON.parse(readFileSync(join(currentDir, "package.json"), "utf8")).maintenanceProtocol === PROTOCOL) return true; }
  catch { /* Probe the explicit CLI marker, never an unrecognized server command. */ }
  const probe = spawnSync(node, [entry, "--help"], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 32 * 1024,
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  });
  return probe.status === 0 && /(?:^|\n)\s*maintenance\s+\(protocol\s+1\)/i.test(String(probe.stdout ?? ""));
}
function exactHost(pid, node, entry) {
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`).toString().split("\0").filter(Boolean);
    const uid = /^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];
    return (typeof process.getuid !== "function" || uid === String(process.getuid())) && args.length >= 2 &&
      realpathSync(args[0]) === realpathSync(node) && realpathSync(args[1]) === realpathSync(entry);
  } catch { return false; }
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}
/** `live` is provably this install; `unidentified` must never be signalled. */
function inspectProcess(pidPath, node, entry) {
  const text = readText(pidPath)?.trim();
  if (!text || !/^[1-9]\d*$/.test(text)) return { state: "dead" };
  const pid = Number(text);
  if (!processAlive(pid)) return { state: "dead" };
  return node && entry && exactHost(pid, node, entry) ? { state: "live", pid } : { state: "unidentified", pid };
}
function stopHost(pid, node, entry) {
  if (!exactHost(pid, node, entry)) fail("HOST_PROCESS_UNIDENTIFIED");
  try { process.kill(pid, "SIGTERM"); }
  catch (error) { if (error.code === "ESRCH") return; fail("HOST_PROCESS_UNIDENTIFIED"); }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; }
    if (!exactHost(pid, node, entry)) fail("HOST_PROCESS_UNIDENTIFIED");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  fail("HOST_STOP_TIMEOUT");
}
/**
 * Verify the uploaded archive, stage it, and trust only the path the installer
 * printed. A damaged canonical version makes the installer publish a verified
 * `-repair-<nonce>` sibling instead of touching the damaged bytes.
 */
async function stageArchive(tx, root) {
  if (await sha256(tx.artifactPath) !== tx.expectedSha256) fail("DEPLOYMENT_FAILED");
  const unpack = join(tx.transactionDir, "unpack"); privateDirectory(unpack);
  run("tar", ["--no-same-owner", "--no-same-permissions", "-xzf", tx.artifactPath, "-C", unpack], { timeout: 600_000 });
  const bundle = join(unpack, tx.bundleDir);
  if (!exists(bundle) || !lstatSync(bundle).isDirectory() || lstatSync(bundle).isSymbolicLink()) fail("DEPLOYMENT_FAILED");
  run("sh", [join(bundle, "install.sh"), "--verify"], { timeout: 120_000 });
  const staged = run("sh", [join(bundle, "install.sh"), "--stage"], {
    timeout: 600_000, env: { ...process.env, PI_HOST_INSTALL_DIR: root.base },
  });
  const printed = /^PI_HOST_STAGED (.+)$/m.exec(staged.stdout)?.[1]?.trim();
  if (!printed) fail("DEPLOYMENT_FAILED");
  const versionDir = resolve(printed);
  if (dirname(versionDir) !== root.base || !isVersionDirName(versionDir.slice(root.base.length + 1))) fail("DEPLOYMENT_FAILED");
  if (!exists(versionDir) || !lstatSync(versionDir).isDirectory() || lstatSync(versionDir).isSymbolicLink()) fail("DEPLOYMENT_FAILED");
  run("sh", [join(versionDir, "install.sh"), "--verify"], { timeout: 120_000 });
  return versionDir;
}
// Always switch with the new installer: an older bundle's install.sh predates
// --activate-locked, which would make a rollback impossible.
function activate(installerDir, targetDir, root) {
  run("sh", [join(installerDir, "install.sh"), "--activate-locked", targetDir], {
    timeout: 120_000, env: { ...process.env, PI_HOST_INSTALL_DIR: root.base },
  });
}
/** Strict readiness check for the Host this deployment expects to have started. */
function parseReady(line, version, expectedHostId) {
  const ready = parseReadyLine(line);
  if (!ready || normalizeVersion(ready.version) !== normalizeVersion(version) ||
      (expectedHostId !== undefined && ready.hostId !== expectedHostId)) fail("HOST_RECOVERY_REQUIRED");
  return ready;
}
function startHost(node, entry, args, root) {
  const log = join(root.work, "pi-host.log"), errorLog = join(root.work, "pi-host.err"), pidPath = join(root.work, "pi-host.pid");
  writeFileSync(log, "", { mode: 0o600 }); writeFileSync(errorLog, "", { mode: 0o600 });
  const outFd = openSync(log, "a", 0o600), errFd = openSync(errorLog, "a", 0o600);
  try {
    const child = spawn(node, [entry, ...args], {
      detached: true, stdio: ["ignore", outFd, errFd], env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    });
    // A spawn error is emitted asynchronously; without a listener it would take
    // the worker down and leave the durable state mid-flight. Record it instead
    // so the readiness wait fails with an observable reason.
    child.on("error", (error) => {
      try { writeFileSync(errorLog, `spawn-error ${error?.code ?? "UNKNOWN"}\n`, { flag: "a", mode: 0o600 }); } catch { /* best effort */ }
    });
    if (!child.pid) fail("HOST_RECOVERY_REQUIRED");
    writeFileSync(`${pidPath}.tmp`, `${child.pid}\n`, { mode: 0o600 });
    renameSync(`${pidPath}.tmp`, pidPath); child.unref();
    return child.pid;
  } catch { fail("HOST_RECOVERY_REQUIRED"); }
  finally { closeSync(outFd); closeSync(errFd); }
}
async function awaitReady(pid, node, entry, tx, root, pairingRequired) {
  const log = join(root.work, "pi-host.log"), errorLog = join(root.work, "pi-host.err");
  const deadline = Date.now() + tx.readyTimeoutSec * 1000;
  // The child's /proc entry can lag the spawn by a few milliseconds; a lasting
  // mismatch is still fatal, never an unrelated process adopted as the Host.
  const identityGraceUntil = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!exactHost(pid, node, entry)) {
      if (Date.now() > identityGraceUntil || !processAlive(pid)) fail("HOST_RECOVERY_REQUIRED");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      continue;
    }
    const lines = readFileSync(log, "utf8").split(/\r?\n/);
    const readyLine = lines.find((line) => line.startsWith("PI_HOST_READY "));
    const pairingLine = lines.find((line) => line.startsWith("PI_HOST_PAIRING_TOKEN "));
    if (readyLine && (!pairingRequired || pairingLine)) {
      const ready = parseReady(readyLine, tx.version, tx.expectedHostId);
      if (pairingRequired) {
        if (!parsePairingLine(pairingLine)) fail("HOST_RECOVERY_REQUIRED");
      } else if (pairingLine) fail("HOST_RECOVERY_REQUIRED");
      writeFileSync(join(tx.transactionDir, "result.txt"), `${readyLine}\n${pairingLine ?? ""}\n`, { mode: 0o600 });
      return ready;
    }
    const stderrText = readFileSync(errorLog, "utf8");
    if (stderrText.includes("spawn-error") || stderrText.includes("PI_HOST_FAILED") ||
        lines.some((line) => line.startsWith("PI_HOST_FAILED "))) fail("HOST_RECOVERY_REQUIRED");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  fail("HOST_RECOVERY_REQUIRED");
}
/** Does the installed directory still pass its own manifest and file checks? */
function directoryHealthy(dir) {
  for (const required of ["install.sh", "pi-host.js", "bin/node"]) {
    if (!exists(join(dir, required))) return false;
  }
  const result = spawnSync("sh", [join(dir, "install.sh"), "--verify"], {
    encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024,
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  });
  return !result.error && result.status === 0;
}
/** Host data directory; the desktop and host-core share this environment. */
function dataDirectory(home) {
  const configured = process.env.PI_DESKTOP_DATA_DIR;
  if (configured) {
    if (!isAbsolute(configured)) fail("DEPLOYMENT_FAILED");
    return resolve(configured);
  }
  return join(home, ".pi-desktop");
}
/** Durable admission without a trusted CLI: identity, saved owner, version. */
function offlineAdmission(tx, oldDir, recorded, { requireOwnerDevice }) {
  const data = dataDirectory(process.env.HOME);
  const identityText = readText(join(data, "pi-host", "identity.json"));
  if (identityText === null) fail("HOST_RECOVERY_REQUIRED");
  const credentialsText = readText(join(data, "pi-host", "credentials.json"));
  const expectedDeviceTokenHash = tx.expectedDeviceTokenHash;
  const needsDevice = requireOwnerDevice || typeof expectedDeviceTokenHash === "string";
  if (needsDevice && credentialsText === null) fail("HOST_MAINTENANCE_UNAVAILABLE");
  try {
    return admitOfflineHost({
      identityText,
      credentialsText: credentialsText ?? '{"devices":[]}',
      expectedHostId: tx.expectedHostId ?? recorded?.hostId,
      expectedDeviceTokenHash,
      requireOwnerDevice: needsDevice,
      candidateVersion: tx.version,
      packageVersion: oldDir ? directoryVersion(oldDir) : null,
      readyVersion: recorded?.version,
      expectedCurrentVersion: tx.expectedCurrentVersion,
    });
  } catch (error) {
    if (typeof error?.code === "string") fail(error.code);
    throw error;
  }
}
async function runTransaction(requestPath) {
  const root = paths(process.env.HOME), request = readJson(requestPath);
  const tx = { ...validateRequest(request, root, requestPath), root };
  const queued = exists(root.state) ? readJson(root.state) : null;
  if (queued?.transactionId !== tx.transactionId || queued.phase !== "queued") fail("HOST_RECOVERY_REQUIRED");
  const inspected = inspectCurrent(root.base);
  if (inspected.kind === "unsafe") fail("DEPLOYMENT_FAILED");
  const oldDir = inspected.kind === "ready" ? inspected.dir : null;
  const oldNode = oldDir && join(oldDir, "bin", "node"), oldEntry = oldDir && join(oldDir, "pi-host.js");
  const recorded = lastReady(readText(join(root.work, "pi-host.log")));
  // A directory that no longer verifies is a repair, not an upgrade: its CLI
  // cannot be trusted to report identity, version or busy state.
  const damagedPrevious = oldDir ? !directoryHealthy(oldDir) : true;
  let leaseId, leaseHeld = false, activated = false, newProcessMayHaveStarted = false;
  let versionDir;
  try {
    saveState(root, tx, "verifying", { step: "artifact" });
    versionDir = await stageArchive(tx, root);
    tx.oldVersion = oldDir ? directoryVersion(oldDir) : null;
    saveState(root, tx, "staged", { stagedVersionDir: versionDir, damagedPrevious });
    if (oldDir && !damagedPrevious) {
      if (!oldNode || !oldEntry) fail("HOST_MAINTENANCE_UNAVAILABLE");
      const process = inspectProcess(join(root.work, "pi-host.pid"), oldNode, oldEntry);
      const claimedHostId = tx.expectedHostId ?? recorded?.hostId;
      if (process.state === "unidentified") fail("HOST_PROCESS_UNIDENTIFIED");
      if (process.state === "dead") {
        // The install is intact but nothing runs. Durable identity and version
        // evidence still gate the upgrade; no pairing state is re-minted.
        if (!claimedHostId) fail("HOST_AUTH_FAILED");
        const admission = offlineAdmission(tx, oldDir, recorded, { requireOwnerDevice: tx.preservePairing === true });
        tx.hostId = admission.hostId; tx.oldVersion = admission.version;
        saveState(root, tx, "offline-admitted", { deviceId: admission.deviceId, evidence: admission.sources });
      } else if (hasMaintenance(oldDir, oldNode, oldEntry)) {
        if (!claimedHostId) fail("HOST_AUTH_FAILED");
        // Identity, version and busy are read again directly before the lease.
        const first = runMaintenance(oldNode, oldEntry, "status", claimedHostId, undefined);
        if (first.busy) fail("HOST_BUSY");
        if (tx.expectedCurrentVersion && normalizeVersion(first.version) !== normalizeVersion(tx.expectedCurrentVersion)) fail("HOST_VERSION_MISMATCH");
        if (compareVersions(tx.version, first.version) < 0) fail("HOST_VERSION_MISMATCH");
        const second = runMaintenance(oldNode, oldEntry, "status", claimedHostId, undefined);
        if (second.hostId !== first.hostId || second.version !== first.version) fail("HOST_AUTH_FAILED");
        if (second.busy) fail("HOST_BUSY");
        tx.hostId = second.hostId; tx.oldVersion = second.version;
        leaseId = randomBytes(16).toString("hex");
        const lease = runMaintenance(oldNode, oldEntry, "acquire", second.hostId, leaseId);
        validateMaintenanceLease(lease, leaseId);
        leaseHeld = true; saveState(root, tx, "maintenance-acquired", { leaseId });
      } else {
        // Explicit legacy upgrade: the old CLI has no gate, so no busy client can
        // be detected. Only the recorded readiness is used, and a missing or
        // unknown identity still fails rather than being re-minted.
        if (tx.allowLegacyMaintenance !== true) fail("HOST_MAINTENANCE_UNAVAILABLE");
        if (!recorded) fail("HOST_MAINTENANCE_UNAVAILABLE");
        if (tx.expectedHostId && recorded.hostId !== tx.expectedHostId) fail("HOST_AUTH_FAILED");
        if (tx.expectedCurrentVersion && normalizeVersion(recorded.version) !== normalizeVersion(tx.expectedCurrentVersion)) fail("HOST_VERSION_MISMATCH");
        if (compareVersions(tx.version, recorded.version) < 0) fail("HOST_VERSION_MISMATCH");
        tx.hostId = recorded.hostId; tx.oldVersion = recorded.version;
        saveState(root, tx, "legacy-maintenance", { leaseId: null });
      }
      if (process.state === "live") {
        stopHost(process.pid, oldNode, oldEntry); leaseHeld = false;
        saveState(root, tx, "old-stopped");
      }
    } else if (tx.preservePairing !== true && !tx.expectedHostId) {
      const data = dataDirectory(process.env.HOME);
      admitFreshInstallation({ currentKind: inspected.kind, preservePairing: tx.preservePairing,
        expectedHostId: tx.expectedHostId, identityExists: exists(join(data, "pi-host", "identity.json")),
        credentialsExist: exists(join(data, "pi-host", "credentials.json")), readyExists: recorded !== null,
        processState: inspectProcess(join(root.work, "pi-host.pid"), null, null).state });
    } else {
      // Missing, dangling or damaged install. Identity, the active owner device
      // and the previous version must all be proven from durable state; a live
      // or unidentifiable pid is never killed or taken over.
      if (tx.preservePairing !== true || !tx.expectedHostId) fail("HOST_AUTH_FAILED");
      const process = inspectProcess(join(root.work, "pi-host.pid"), null, null);
      if (process.state !== "dead") fail("HOST_PROCESS_UNIDENTIFIED");
      const admission = offlineAdmission(tx, oldDir, recorded, { requireOwnerDevice: true });
      tx.hostId = admission.hostId; tx.oldVersion = admission.version;
      saveState(root, tx, "offline-admitted", {
        deviceId: admission.deviceId, evidence: admission.sources, repair: true,
      });
    }
    saveState(root, tx, "activating");
    activate(versionDir, versionDir, root); activated = true;
    saveState(root, tx, "activated", { previousVersionDir: oldDir });
    const node = join(root.base, "current/bin/node"), entry = join(root.base, "current/pi-host.js");
    const pairingRequired = deploymentNeedsPairing(tx.preservePairing);
    const args = ["--port", String(tx.port)];
    if (pairingRequired) args.push("--pair", "--pairing-lifetime-ms", String(tx.pairingLifetimeMs));
    saveState(root, tx, "starting", { pairing: pairingRequired ? "required" : "preserved" });
    newProcessMayHaveStarted = true;
    const pid = startHost(node, entry, args, root);
    const ready = await awaitReady(pid, node, entry, tx, root, pairingRequired);
    saveState(root, tx, "awaiting-racp", { hostId: ready.hostId, port: ready.port, readyVersion: ready.version });
  } catch (error) {
    const code = FAILURE_CODES.has(error?.code) ? error.code : "DEPLOYMENT_FAILED";
    if (leaseHeld && oldNode && oldEntry) {
      try { runMaintenance(oldNode, oldEntry, "release", tx.expectedHostId ?? tx.hostId, leaseId); }
      catch { /* Expiring maintenance lease is the safe fallback. */ }
    }
    if (activated && !newProcessMayHaveStarted && oldDir) {
      try { activate(versionDir, oldDir, root); saveState(root, tx, "failed-safe", { failureCode: code, restoredCurrent: oldDir }); }
      catch { saveState(root, tx, "recovery-required", { failureCode: "HOST_RECOVERY_REQUIRED" }); }
    } else if (activated || newProcessMayHaveStarted) {
      saveState(root, tx, "recovery-required", { failureCode: "HOST_RECOVERY_REQUIRED" });
    } else saveState(root, tx, "failed-safe", { failureCode: code });
    writeJsonAtomic(join(tx.transactionDir, "failure.json"), { code, transactionId: tx.transactionId });
  }
}
function queue(requestPath) {
  const root = paths(process.env.HOME), request = readJson(requestPath), tx = validateRequest(request, root, requestPath);
  if (exists(root.state) && !["failed-safe", "complete"].includes(readJson(root.state).phase)) fail("HOST_RECOVERY_REQUIRED");
  saveState(root, tx, "queued");
  const child = spawn("flock", ["-w", "120", root.lock, process.execPath, SCRIPT, "--run", requestPath], {
    detached: true, stdio: "ignore", env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  });
  // Without a listener an async spawn failure would crash this process and
  // leave the transaction looking queued forever.
  child.on("error", () => undefined);
  if (!child.pid) {
    saveState(root, tx, "failed-safe", { failureCode: "DEPLOYMENT_FAILED" });
    fail("DEPLOYMENT_FAILED");
  }
  child.unref(); process.stdout.write(`PI_HOST_DEPLOYMENT_QUEUED ${tx.transactionId}\n`);
}
function begin(requestPath) {
  const root = paths(process.env.HOME);
  const result = spawnSync("flock", ["-w", "120", root.lock, process.execPath, SCRIPT, "--queue", requestPath], {
    encoding: "utf8", timeout: 130_000, maxBuffer: 32 * 1024,
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  });
  if (result.error || result.status !== 0) {
    const code = [...FAILURE_CODES].find((candidate) => String(result.stderr ?? "").includes(candidate)) ?? "DEPLOYMENT_FAILED";
    fail(code);
  }
  process.stdout.write(result.stdout ?? "");
}
/** Queue recovery under the same lock, retaining its runtime after SSH exits. */
function beginRecovery(args) {
  const root = paths(process.env.HOME), record = readJson(root.state);
  if (!/^[a-f0-9]{32}$/.test(record.transactionId ?? "") ||
      !["recovery-required", "awaiting-racp"].includes(record.phase)) fail("HOST_RECOVERY_REQUIRED");
  const txdir = join(root.transactions, record.transactionId);
  if (!lstatSync(txdir).isDirectory() || lstatSync(txdir).isSymbolicLink()) fail("HOST_RECOVERY_REQUIRED");
  const job = `recovery-${randomBytes(16).toString("hex")}`, jobdir = join(txdir, job);
  privateDirectory(jobdir);
  copyFileSync(process.execPath, join(jobdir, "node")); chmodSync(join(jobdir, "node"), 0o700);
  for (const name of ["deploy.mjs", "deploy-recovery.mjs"]) copyFileSync(join(dirname(SCRIPT), name), join(jobdir, name));
  const out = openSync(join(jobdir, "output.txt"), "wx", 0o600), err = openSync(join(jobdir, "error.txt"), "wx", 0o600);
  try {
    const child = spawn("flock", ["-w", "120", root.lock, join(jobdir, "node"), join(jobdir, "deploy.mjs"),
      "--recover", ...args, record.transactionId], { detached: true, stdio: ["ignore", out, err],
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" } });
    child.on("error", () => { writeJsonAtomic(join(jobdir, "failure.json"), { code: "HOST_RECOVERY_REQUIRED" }); });
    if (!child.pid) fail("HOST_RECOVERY_REQUIRED");
    child.unref();
  } finally { closeSync(out); closeSync(err); }
  process.stdout.write(`PI_HOST_RECOVERY_JOB ${record.transactionId}/${job}\n`);
}

/** Called under the deployment lock after Desktop verifies the release archive. */
async function recover(version, expectedHostId, deviceHash, preservePairing, expectedSha256, expectedTransactionId) {
  const root = paths(process.env.HOME), record = readJson(root.state);
  if (record.transactionId !== expectedTransactionId) fail("HOST_RECOVERY_REQUIRED");
  if (!/^[a-f0-9]{32}$/.test(record.transactionId ?? "") || !["true", "false"].includes(preservePairing) ||
      !/^[a-f0-9]{64}$/.test(expectedSha256)) fail("HOST_RECOVERY_REQUIRED");
  const requestPath = join(root.transactions, record.transactionId, "request.json");
  const tx = { ...validateRequest(readJson(requestPath), root, requestPath), oldVersion: record.oldVersion };
  if (tx.expectedSha256 !== expectedSha256) fail("HOST_RECOVERY_REQUIRED");
  const inspected = inspectCurrent(root.base);
  if (inspected.kind !== "ready" || !directoryHealthy(inspected.dir)) fail("HOST_RECOVERY_REQUIRED");
  const node = join(inspected.dir, "bin/node"), entry = join(inspected.dir, "pi-host.js");
  const live = inspectProcess(join(root.work, "pi-host.pid"), node, entry);
  if (live.state !== "live") fail("HOST_PROCESS_UNIDENTIFIED");
  const log = readText(join(root.work, "pi-host.log"));
  const ready = lastReady(log), data = dataDirectory(process.env.HOME);
  const credentialsText = readText(join(data, "pi-host/credentials.json"));
  const admission = admitInterruptedDeployment({ record, request: tx,
    identity: readJson(join(data, "pi-host/identity.json")), ready, targetVersion: version,
    expectedHostId, preservePairing: preservePairing === "true", expectedDeviceTokenHash: deviceHash,
    credentialsText });
  // Prove the running installation is the verified archive's staged content,
  // not merely a self-consistent directory claiming the same version.
  const staged = await stageArchive(tx, root);
  if (realpathSync(staged) !== inspected.dir || !exactHost(live.pid, node, entry)) fail("HOST_RECOVERY_REQUIRED");
  const status = runMaintenance(node, entry, "status", admission.hostId);
  if (normalizeVersion(status.version) !== normalizeVersion(version)) fail("HOST_VERSION_MISMATCH");
  tx.hostId = admission.hostId; tx.expectedHostId = admission.hostId;
  const pairingRequired = preservePairing !== "true";
  let pairingLine = log.split(/\r?\n/).filter(line => line.startsWith("PI_HOST_PAIRING_TOKEN ")).at(-1);
  const pairing = parsePairingLine(pairingLine);
  const tokenHash = pairing ? createHash("sha256").update(pairing.token).digest("hex") : "";
  let currentReady = ready;
  if (pairingRequired && !pairingRecordUsable(pairing, readJson(join(data, "pi-host/credentials.json")), tokenHash)) {
    if (status.busy) fail("HOST_BUSY");
    const leaseId = randomBytes(16).toString("hex");
    const lease = runMaintenance(node, entry, "acquire", admission.hostId, leaseId);
    validateMaintenanceLease(lease, leaseId);
    let stopped = false;
    try {
      stopHost(live.pid, node, entry); stopped = true;
      saveState(root, tx, "starting", { pairing: "required", recovering: true });
      const pid = startHost(node, entry, ["--port", String(ready.port), "--pair", "--pairing-lifetime-ms", String(tx.pairingLifetimeMs)], root);
      currentReady = await awaitReady(pid, node, entry, tx, root, true);
      pairingLine = readFileSync(join(tx.transactionDir, "result.txt"), "utf8").split(/\r?\n/)[1];
    } catch (error) {
      if (!stopped) {
        try { runMaintenance(node, entry, "release", admission.hostId, leaseId); } catch { /* The lease expires. */ }
      }
      saveState(root, tx, "recovery-required", { failureCode: "HOST_RECOVERY_REQUIRED" });
      throw error;
    }
  }
  const output = `PI_HOST_READY ${JSON.stringify(currentReady)}\n${pairingRequired ? pairingLine : ""}\n`;
  writeFileSync(join(tx.transactionDir, "result.txt"), output, { mode: 0o600 });
  saveState(root, tx, "awaiting-racp", { hostId: admission.hostId, port: currentReady.port,
    readyVersion: currentReady.version, recovered: true });
  rmSync(join(tx.transactionDir, "failure.json"), { force: true });
  process.stdout.write(`${output}PI_HOST_DEPLOYMENT_TRANSACTION ${tx.transactionId}\n`);
}

function complete(transactionId, expectedHostId) {
  const root = paths(process.env.HOME), record = readJson(root.state);
  if (record.phase !== "awaiting-racp" || record.transactionId !== transactionId || record.hostId !== expectedHostId) fail("HOST_RECOVERY_REQUIRED");
  writeJsonAtomic(root.state, { ...record, phase: "complete", completedAt: new Date().toISOString() });
  rmSync(join(root.transactions, transactionId), { recursive: true, force: true });
  rmSync(root.state, { force: true });
  process.stdout.write(`PI_HOST_DEPLOYMENT_COMPLETE ${transactionId}\n`);
}
function main() {
  const [operation, ...args] = process.argv.slice(2);
  try {
    if (operation === "--begin" && args.length === 1) begin(resolve(args[0]));
    else if (operation === "--queue" && args.length === 1) queue(resolve(args[0]));
    else if (operation === "--run" && args.length === 1) runTransaction(resolve(args[0])).catch((error) => {
      const code = FAILURE_CODES.has(error?.code) ? error.code : "DEPLOYMENT_FAILED";
      try {
        const root = paths(process.env.HOME), request = readJson(args[0]);
        const tx = { ...request, transactionDir: dirname(args[0]) };
        saveState(root, tx, "failed-safe", { failureCode: code });
        writeJsonAtomic(join(tx.transactionDir, "failure.json"), { code, transactionId: tx.transactionId });
      } catch { /* Preserve the last durable marker if status persistence fails. */ }
    });
    else if (operation === "--complete" && args.length === 2 && /^[a-f0-9]{32}$/.test(args[0])) complete(args[0], args[1]);
    else if (operation === "--begin-recovery" && args.length === 5) beginRecovery(args);
    else if (operation === "--recover" && args.length === 6) recover(...args).then(() => {
      writeJsonAtomic(join(dirname(SCRIPT), "done.json"), { ok: true });
    }).catch((error) => {
      const code = FAILURE_CODES.has(error?.code) ? error.code : "DEPLOYMENT_FAILED";
      writeJsonAtomic(join(dirname(SCRIPT), "failure.json"), { code });
      process.stderr.write(`${code}\n`); process.exitCode = 1;
    });
    else fail("DEPLOYMENT_FAILED");
  } catch (error) {
    const code = FAILURE_CODES.has(error?.code) ? error.code : "DEPLOYMENT_FAILED";
    process.stderr.write(`${code}\n`); process.exitCode = 1;
  }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === SCRIPT) main();
