import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createRemoteHostsBoot } = await import("../electron/main/bootstrap/remote-hosts.ts");
const { createSshTunnelManager } = await import("../electron/main/remote/ssh-tunnel.ts");
const { createBackendRouter } = await import("../electron/main/remote/backend-router.ts");
const { createRemoteHostRealigner } = await import("../electron/main/remote/remote-host-realign.ts");
const VERSION = "1.1.0";
const failure = code => Object.assign(new Error(code), { errorCode: code });
const record = () => ({ hostKey: "box", label: "Box", url: "ws://127.0.0.1:4000/v1/racp/ws", deviceToken: "original-token", sshSecret: "ssh-password",
  metadata: { transport: "ssh", ssh: { host: "box", remotePort: 4000, version: "1.0.0", hostId: "known-id", auth: "password" } } });
function adapter(fixture) {
  let state = "disconnected";
  return { state: () => state, connect: async () => { if (fixture.authError) throw failure("HOST_AUTH_FAILED"); state = "connected"; },
    close: async () => { state = "disconnected"; },
    workspaceCapabilities: () => ({ workspaceTools: !fixture.badCapabilities, workspaceFiles: true }),
    client: { request: async method => method === "session/list" ? { sessions: [] }
      : method === "project/browse" ? { path: "/project", entries: [] }
      : { subscriptionId: "s", starting: { epoch: "e", sequence: 1 }, replayComplete: true }, subscribe: () => () => {} },
  };
}
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "prepare-user-path-"));
  const state = { version: "1.0.0", installs: 0, paired: 0, badCapabilities: false, authError: false, hostId: "known-id", downloadError: false };
  const ready = () => `PI_HOST_READY ${JSON.stringify({ hostId: state.hostId, host: "127.0.0.1", port: 4100, version: state.version })}\n`;
  const forward = () => ({ localPort: 4200, close: async () => {} });
  const transport = { exec: async () => ({ stdout: "Linux\nx86_64\n", stderr: "", code: 0 }),
    execWithInput: async () => { state.installs++; state.version = VERSION; return { stdout: ready(), stderr: "", code: 0 }; },
    forward: async () => forward(), dispose() {} };
  const boot = createRemoteHostsBoot({ dataDir,
    encryption: { isAvailable: () => true, encryptString: s => Buffer.from(`enc:${s}`), decryptString: b => b.toString().slice(4) },
    router: createBackendRouter(), emit() {}, clientInfo: { name: "test", version: VERSION },
    buildAdapter: () => adapter(state),
    tunnels: createSshTunnelManager({ reservePort: async () => 4200,
      buildTransport: () => ({ ...transport, execWithInput: async () => ({ stdout: ready(), stderr: "", code: 0 }) }) }),
    sshBootstrap: { buildTransport: () => transport, reservePort: async () => 4200,
      fetchChecksum: async () => "a".repeat(64), uploadArtifact: async () => {
        if (state.downloadError) throw failure("HOST_DOWNLOAD_FAILED");
        return { path: "/home/test/.pi-desktop/pi-host/.upload.ABC123/artifact.tar.gz", cleanup: async () => {} };
      },
      exchangePairing: async () => { state.paired++; return "new-token"; },
      verifyConnection: async ({ deviceToken, expectedHostId }) => {
        assert.equal(deviceToken, "original-token"); assert.equal(expectedHostId, "known-id");
        if (state.badCapabilities) throw failure("HOST_VERSION_MISMATCH");
      },
    },
  });
  await boot.registry.upsert(record());
  t.after(async () => { await boot.closeAll(); await rm(dataDir, { recursive: true, force: true }); });
  return { boot, state };
}

test("startup does not install; explicit project preparation upgrades and keeps identity and credentials", async t => {
  const { boot, state } = await fixture(t);
  assert.equal(await boot.open(), 0); assert.equal(state.installs, 0);
  await assert.rejects(boot.browseProjects("box"), { errorCode: "HOST_DOWNLOAD_REQUIRED" });
  assert.equal((await boot.list())[0].preparation.phase, "awaiting-download");
  const host = await boot.prepareHost({ hostKey: "box", requestId: "picker", allowDownload: true, allowLegacyMaintenance: true });
  assert.equal(host.connected, true); assert.equal(host.preparation.phase, "ready");
  assert.equal(state.installs, 1); assert.equal(state.paired, 0);
  const saved = (await boot.registry.list())[0];
  assert.equal(saved.deviceToken, "original-token"); assert.equal(saved.sshSecret, "ssh-password");
  assert.equal(saved.metadata.ssh.hostId, "known-id"); assert.equal(saved.metadata.ssh.version, VERSION);
  await boot.ensureReady("box"); assert.equal(state.installs, 1);
});

test("newer Host and changed identity never start installation even after explicit retry", async t => {
  const { boot, state } = await fixture(t);
  state.version = "2.0.0";
  await assert.rejects(boot.prepareHost({ hostKey: "box", requestId: "a", allowDownload: true, retry: true }), { errorCode: "HOST_CLIENT_TOO_OLD" });
  state.version = "1.0.0"; state.hostId = "other-id";
  await assert.rejects(boot.prepareHost({ hostKey: "box", requestId: "b", allowDownload: true, retry: true }), { errorCode: "HOST_AUTH_FAILED" });
  assert.equal(state.installs, 0);
});

test("revoked device token is refused before download or installation", async t => {
  const { boot, state } = await fixture(t); state.authError = true;
  await assert.rejects(boot.prepareHost({ hostKey: "box", requestId: "a", allowDownload: true }), { errorCode: "HOST_AUTH_FAILED" });
  assert.equal(state.installs, 0);
});

test("download error remains actionable and retry can recover without removing the Host", async t => {
  const { boot, state } = await fixture(t); state.downloadError = true;
  await assert.rejects(boot.prepareHost({ hostKey: "box", requestId: "a", allowDownload: true }), { errorCode: "HOST_DOWNLOAD_FAILED" });
  assert.equal((await boot.list())[0].preparation.errorCode, "HOST_DOWNLOAD_FAILED");
  assert.equal(state.installs, 0); state.downloadError = false;
  const host = await boot.prepareHost({ hostKey: "box", requestId: "b", retry: true });
  assert.equal(host.connected, true); assert.equal(state.installs, 1);
});

test("failed capability verification never writes a successful receipt", async t => {
  const { boot, state } = await fixture(t); state.badCapabilities = true;
  await assert.rejects(boot.prepareHost({ hostKey: "box", requestId: "a", allowDownload: true }), { errorCode: "HOST_VERSION_MISMATCH" });
  assert.equal(state.installs, 1);
  assert.equal((await boot.registry.list())[0].metadata.piHostPreparationAttempt.succeeded, false);
  await assert.rejects(boot.ensureReady("box")); assert.equal(state.installs, 1);
});

test("realigner never replaces a saved identity and closes an unadopted forward", async () => {
  let closes = 0, writes = 0;
  const upgrade = createRemoteHostRealigner({ upsert: async () => { writes++; }, bootstrap: async () => ({
    url: "ws://127.0.0.1:2", deviceToken: "original-token", ssh: { ...record().metadata.ssh, hostId: "changed" }, forward: { close: async () => { closes++; } },
  }) });
  await assert.rejects(upgrade(record(), { signal: new AbortController().signal, allowLegacyMaintenance: false, progress() {} }), { errorCode: "HOST_AUTH_FAILED" });
  assert.equal(closes, 1); assert.equal(writes, 0);
});
