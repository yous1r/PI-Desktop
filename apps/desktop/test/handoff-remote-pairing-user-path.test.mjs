import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { bindRacpWebSocket, newPairingToken, hashToken } = await import("@pi-desktop/racp");
const { harness } = await import("@pi-desktop/racp/test-harness");
const { exchangePairingToken } = await import("../electron/main/remote/racp-remote-host-client.ts");
const { RemoteBootActivity } = await import("../electron/main/remote/remote-boot-activity.ts");
const noTunnels = { getHandoffActivity: () => ({ operations: 0, resources: 0, uncontainedResources: 0 }) };

async function fixture(t) {
  const host = await harness({ operations: {
    workspaceTools: { shell: async () => ({ id: "bash" }), execute: async () => ({ ok: true, content: "fixture" }), abort: async () => {}, disconnect: async () => {} },
    workspaceFiles: { read: async () => ({ content: "fixture" }) },
  } });
  const pairingToken = newPairingToken();
  await host.store.savePairing({ tokenHash: hashToken(pairingToken), expiresAt: new Date(Date.now() + 60000).toISOString() });
  const binding = await bindRacpWebSocket({ server: host.server, authenticator: host.authenticator, port: 0, log: () => {} });
  const activity = new RemoteBootActivity(() => {});
  t.after(async () => { await activity.closeTemporary(); await binding.close(); });
  const exchange = () => exchangePairingToken({ url: `ws://127.0.0.1:${binding.address.port}/v1/racp/ws`,
    pairingToken, label: "fixture-desktop", clientInfo: { name: "fixture", version: "1" }, expectedHostId: "host_test",
    requireWorkspace: true, useClient: (client, work) => activity.useTemporary(client, work) });
  return { host, activity, exchange };
}

test("local WebSocket pairing keeps one-use token semantics and retains native uncertainty", async t => {
  const { host, activity, exchange } = await fixture(t);
  const token = await exchange();
  assert.ok(await host.store.findDeviceByTokenHash(hashToken(token)));
  await assert.rejects(exchange());
  await activity.drain();
  const snapshot = activity.snapshot(noTunnels);
  assert.equal(snapshot.operations, 0);
  assert.ok(snapshot.uncontainedResources > 0);
});

test("local pairing teardown closes its original socket while an admitted peer write finishes", async t => {
  const { host, activity, exchange } = await fixture(t);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const saved = Promise.withResolvers();
  const save = host.store.saveDevice.bind(host.store);
  host.store.saveDevice = async record => { started.resolve(); await release.promise; await save(record); saved.resolve(); };
  const pairing = exchange().then(value => ({ value }), error => ({ error }));
  await started.promise;
  assert.ok(activity.snapshot(noTunnels).operations > 0);
  await activity.closeTemporary();
  const outcome = await pairing;
  release.resolve();
  await saved.promise;
  await activity.drain();
  assert.ok(outcome.error);
  assert.equal(activity.snapshot(noTunnels).operations, 0);
  assert.ok(activity.snapshot(noTunnels).uncontainedResources > 0);
});
