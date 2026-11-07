import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, rm, readdir, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildBootstrapScript, parseBootstrapOutput } = await import("../electron/main/remote/pi-host-bootstrap-script.ts");
const exec = promisify(execFile);
const linux = { skip: process.platform !== "linux" ? "Linux deployment uses /proc and flock" : false, timeout: 180_000 };
const identity = { hostId: "host_offline_fixture", createdAt: "2026-01-01T00:00:00.000Z" };
const owner = { deviceId: "original-owner", roles: ["owner"], tokenHash: "b".repeat(64), createdAt: identity.createdAt };
const fakeHost = `
const fs = require('node:fs'), crypto = require('node:crypto');
const base = process.env.HOME+'/.pi-desktop/pi-host';
const identity = JSON.parse(fs.readFileSync(base+'/identity.json','utf8'));
const credentials = JSON.parse(fs.readFileSync(base+'/credentials.json','utf8'));
const hostId = fs.existsSync(base+'/wrong-ready-identity') ? 'host_unexpected' : identity.hostId;
console.log('PI_HOST_READY '+JSON.stringify({hostId,host:'127.0.0.1',port:41001,version:'0.22.2'}));
if(process.argv.includes('--pair')){
 const token=crypto.randomBytes(24).toString('hex'),expiresAt=new Date(Date.now()+600000).toISOString();
 credentials.pairings.push({tokenHash:crypto.createHash('sha256').update(token).digest('hex'),expiresAt});
 fs.writeFileSync(base+'/credentials.json',JSON.stringify(credentials));
 console.log('PI_HOST_PAIRING_TOKEN '+JSON.stringify({token,expiresAt}));
}
process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);
`;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const json = async path => JSON.parse(await readFile(path, "utf8"));

async function manifest(directory, prefix = "") {
  const rows = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) rows.push(...await manifest(directory, name + "/"));
    else if (name !== "SHA256SUMS") rows.push(`${digest(await readFile(join(directory, name)))}  ${name}\n`);
  }
  return rows.sort();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-host-offline-enrollment-"));
  const home = join(root, "home"), base = join(home, ".pi-desktop/pi-host"), work = join(base, ".bootstrap");
  const env = { ...process.env, HOME: home, PI_DESKTOP_DATA_DIR: join(home, ".pi-desktop"), NODE_OPTIONS: "", NODE_PATH: "" };
  const run = (command, args, timeout = 30_000) => exec(command, args, { env, timeout, maxBuffer: 128 * 1024 });
  const cleanup = async () => {
    try {
      const pid = Number((await readFile(join(work, "pi-host.pid"), "utf8")).trim());
      const args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
      if (args[0]?.startsWith(base + "/") && args[1] === join(base, "current/pi-host.js")) process.kill(pid, "SIGTERM");
    } catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) throw error; }
    await rm(root, { recursive: true, force: true });
  };
  try {
    await mkdir(work, { recursive: true });
    const bundles = [];
    for (const version of ["0.21.0", "0.22.2"]) {
      const name = `pi-host-${version}-linux-x64`, path = join(root, name);
      await mkdir(join(path, "bin"), { recursive: true });
      await copyFile(process.execPath, join(path, "bin/node"));
      await chmod(join(path, "bin/node"), 0o755);
      for (const name of ["bin/pi-host", "bin/pi-desktop-host-core"]) await writeFile(join(path, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await copyFile(fileURLToPath(new URL("../../pi-host/scripts/install.sh", import.meta.url)), join(path, "install.sh"));
      await chmod(join(path, "install.sh"), 0o755);
      await writeFile(join(path, "package.json"), JSON.stringify({ version }));
      await writeFile(join(path, "pi-host.js"), version === "0.21.0" ? "process.exit(1);\n" : fakeHost);
      await writeFile(join(path, "SHA256SUMS"), (await manifest(path)).join(""));
      bundles.push({ name, path });
    }
    await run("sh", [join(bundles[0].path, "install.sh")]);
    const previous = await readlink(join(base, "current"));
    await writeFile(join(base, "identity.json"), JSON.stringify(identity));
    await writeFile(join(base, "credentials.json"), JSON.stringify({ devices: [owner], pairings: [] }));
    await writeFile(join(home, ".pi-desktop/pi.sqlite"), "persistent database sentinel\n");
    await writeFile(join(work, "pi-host.log"), 'PI_HOST_FAILED {"code":"HOST_UNAVAILABLE"}\n');
    await writeFile(join(work, "pi-host.err"), "database schema version 27 is newer than supported 24\n");
    const upload = join(base, ".upload.fixture"); await mkdir(upload);
    const archive = join(upload, "artifact.tar.gz");
    await run("tar", ["-czf", archive, "-C", root, bundles[1].name]);
    const sha = digest(await readFile(archive));
    const bootstrap = async (options = {}) => {
      const script = join(root, "bootstrap.sh");
      await writeFile(script, buildBootstrapScript({ version: "0.22.2", artifactName: bundles[1].name + ".tar.gz",
        bundleDir: bundles[1].name, artifactUrl: "https://release.invalid/fixture", expectedSha256: sha,
        artifactPath: archive, port: 0, pairingLifetimeMs: 600000, readyTimeoutSec: 10, ...options }));
      try { return parseBootstrapOutput((await run("sh", [script], 45_000)).stdout); }
      catch (error) { return parseBootstrapOutput(error.stdout ?? ""); }
    };
    return { root, home, base, work, previous, bootstrap, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

async function assertPreserved(f) {
  assert.equal(await readFile(join(f.base, "identity.json"), "utf8"), JSON.stringify(identity));
  assert.deepEqual((await json(join(f.base, "credentials.json"))).devices, [owner]);
  assert.equal(await readFile(join(f.home, ".pi-desktop/pi.sqlite"), "utf8"), "persistent database sentinel\n");
}

test("Add SSH upgrades a stopped intact Host with no readiness identity and keeps its data", linux, async () => {
  const f = await fixture();
  try {
    const result = await f.bootstrap();
    assert.equal(result.failure, null);
    assert.equal(result.ready?.hostId, identity.hostId);
    assert.equal(result.ready?.version, "0.22.2");
    assert.ok(result.pairing?.expiresAt > Date.now());
    assert.ok(result.transactionId);
    assert.notEqual(await readlink(join(f.base, "current")), f.previous);
    assert.equal((await json(join(f.work, "deployment-state.json"))).phase, "awaiting-racp");
    await assertPreserved(f);
  } finally { await f.cleanup(); }
});

test("offline re-enrollment refuses unsafe admission before activating", linux, async t => {
  const f = await fixture();
  try {
    const cases = [
      ["saved owner hash does not match", { existingHostId: identity.hostId, preservePairing: true, expectedDeviceTokenHash: "c".repeat(64) }, "HOST_AUTH_FAILED"],
      ["saved identity differs", { existingHostId: "host_other" }, "HOST_AUTH_FAILED"],
    ];
    for (const [name, options, code] of cases) await t.test(name, async () => {
      assert.equal((await f.bootstrap(options)).failure, code);
      assert.equal(await readlink(join(f.base, "current")), f.previous);
      await assertPreserved(f);
    });
    await t.test("revoked saved owner is not re-enrolled", async () => {
      const credentials = { devices: [{ ...owner, revokedAt: identity.createdAt }], pairings: [] };
      await writeFile(join(f.base, "credentials.json"), JSON.stringify(credentials));
      assert.equal((await f.bootstrap({ existingHostId: identity.hostId, preservePairing: true,
        expectedDeviceTokenHash: owner.tokenHash })).failure, "HOST_AUTH_FAILED");
      assert.equal(await readlink(join(f.base, "current")), f.previous);
      assert.deepEqual(await json(join(f.base, "credentials.json")), credentials);
      await writeFile(join(f.base, "credentials.json"), JSON.stringify({ devices: [owner], pairings: [] }));
    });
    await t.test("missing durable identity", async () => {
      await rm(join(f.base, "identity.json"));
      assert.equal((await f.bootstrap()).failure, "HOST_RECOVERY_REQUIRED");
      assert.equal(await readlink(join(f.base, "current")), f.previous);
      await writeFile(join(f.base, "identity.json"), JSON.stringify(identity));
    });
    await t.test("missing device registry is not replaced", async () => {
      await rm(join(f.base, "credentials.json"));
      assert.equal((await f.bootstrap()).failure, "HOST_RECOVERY_REQUIRED");
      assert.equal(await readlink(join(f.base, "current")), f.previous);
      await assert.rejects(readFile(join(f.base, "credentials.json")), { code: "ENOENT" });
      await writeFile(join(f.base, "credentials.json"), JSON.stringify({ devices: [owner], pairings: [] }));
    });
    await t.test("an unidentified process is never stopped", async () => {
      await writeFile(join(f.work, "pi-host.pid"), String(process.pid));
      assert.equal((await f.bootstrap()).failure, "host-process-unidentified");
      process.kill(process.pid, 0);
      assert.equal(await readlink(join(f.base, "current")), f.previous);
      await rm(join(f.work, "pi-host.pid"));
      await assertPreserved(f);
    });
    await t.test("a conflicting readiness identity is not ignored", async () => {
      await writeFile(join(f.work, "pi-host.log"), 'PI_HOST_READY {"hostId":"host_other","host":"127.0.0.1","port":41001,"version":"0.21.0"}\n');
      assert.equal((await f.bootstrap()).failure, "HOST_AUTH_FAILED");
      assert.equal(await readlink(join(f.base, "current")), f.previous);
      await assertPreserved(f);
    });
    await t.test("damaged installation is not taken over", async () => {
      await writeFile(join(f.work, "pi-host.log"), 'PI_HOST_FAILED {"code":"HOST_UNAVAILABLE"}\n');
      await writeFile(join(f.previous, "pi-host.js"), "damaged installation");
      assert.equal((await f.bootstrap()).failure, "HOST_AUTH_FAILED");
      assert.equal(await readlink(join(f.base, "current")), f.previous);
      await assertPreserved(f);
    });
  } finally { await f.cleanup(); }
});

test("re-enrollment rejects a changed startup identity and retains recovery state", linux, async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.base, "wrong-ready-identity"), "yes");
    assert.equal((await f.bootstrap()).failure, "HOST_RECOVERY_REQUIRED");
    assert.equal((await json(join(f.work, "deployment-state.json"))).phase, "recovery-required");
    assert.notEqual(await readlink(join(f.base, "current")), f.previous, "no rollback after the candidate opened data");
    await assertPreserved(f);
  } finally { await f.cleanup(); }
});

test("saved-device offline upgrade preserves its token without new pairing", linux, async () => {
  const f = await fixture();
  try {
    const result = await f.bootstrap({ existingHostId: identity.hostId, preservePairing: true,
      expectedDeviceTokenHash: owner.tokenHash });
    assert.equal(result.failure, null);
    assert.equal(result.ready?.hostId, identity.hostId);
    assert.equal(result.pairing, null);
    assert.deepEqual(await json(join(f.base, "credentials.json")), { devices: [owner], pairings: [] });
    await assertPreserved(f);
  } finally { await f.cleanup(); }
});
