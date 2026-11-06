import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSshBootstrap } = await import("../electron/main/remote/ssh-bootstrap.ts");
const { createSshTunnelManager } = await import("../electron/main/remote/ssh-tunnel.ts");
const { parseRemoteHostReady } = await import("../electron/main/remote/remote-host-supervisor.ts");
const transactionId = "a".repeat(32);
const ready = 'PI_HOST_READY {"hostId":"enrolled","host":"127.0.0.1","port":41000,"version":"1.2.0"}';
const output = `${ready}\nPI_HOST_DEPLOYMENT_TRANSACTION ${transactionId}\n`;
function fixture({ denied = false, code = 0 } = {}) {
  const events = [];
  const transport = {
    exec: async () => ({ stdout: "Linux\nx86_64", stderr: "", code: 0 }),
    execWithInput: async (_command, script) => {
      if (script.includes(" --complete ")) { events.push("complete"); return { stdout: `PI_HOST_DEPLOYMENT_COMPLETE ${transactionId}\n`, stderr: "", code: 0 }; }
      events.push("install"); return { stdout: output, stderr: "", code };
    },
    forward: async () => ({ localPort: 42000, close: async () => { events.push("close"); } }),
    dispose() {},
  };
  const bootstrap = createSshBootstrap({ version: "1.2.0", buildTransport: () => transport,
    fetchChecksum: async () => "a".repeat(64), reservePort: async () => 42000,
    uploadArtifact: async () => ({ path: "/home/test/.pi-desktop/pi-host/.upload.ABC123/artifact.tar.gz", cleanup: async () => {} }),
    exchangePairing: () => assert.fail("upgrade must not pair"),
    verifyConnection: async input => {
      events.push("authenticate"); assert.equal(input.deviceToken, "original-token");
      if (denied) throw Object.assign(new Error("denied"), { errorCode: "HOST_AUTH_FAILED" });
    },
  });
  const run = () => bootstrap.bootstrap({ host: "test", label: "Test" }, {
    existing: { hostId: "enrolled", deviceToken: "original-token", version: "1.1.0" },
  });
  return { run, events };
}
test("deployment receipt is confirmed only after the enrolled token authenticates", async () => {
  const f = fixture(); const result = await f.run();
  assert.deepEqual(f.events, ["install", "authenticate", "complete"]);
  assert.equal(result.deviceToken, "original-token");
  const rejected = fixture({ denied: true });
  await assert.rejects(rejected.run(), { errorCode: "HOST_AUTH_FAILED" });
  assert.deepEqual(rejected.events, ["install", "authenticate", "close"]);
});
test("nonzero deployment cannot be accepted even with a ready line", async () => {
  const f = fixture({ code: 1 });
  await assert.rejects(f.run(), { errorCode: "HOST_BOOTSTRAP_FAILED" });
  assert.deepEqual(f.events, ["install"]);
});
test("recovered tunnel exposes confirmation separately from unauthenticated readiness", async () => {
  let confirmations = 0;
  const tunnels = createSshTunnelManager({ reservePort: async () => 42000, buildTransport: () => ({
    execWithInput: async (_command, script) => {
      if (script.includes(" --complete ")) { confirmations++; return { code: 0, stdout: `PI_HOST_DEPLOYMENT_COMPLETE ${transactionId}`, stderr: "" }; }
      return { code: 0, stdout: output, stderr: "" };
    },
    forward: async () => ({ localPort: 42000, close: async () => {} }), dispose() {},
  }) });
  const tunnel = await tunnels.open("h", { host: "test", version: "1.2.0", remotePort: 41000, hostId: "enrolled" });
  assert.equal(confirmations, 0);
  await tunnel.completePreparation();
  assert.equal(confirmations, 1);
  assert.equal(tunnel.completePreparation, undefined);
  await tunnels.dispose();
  assert.throws(() => parseRemoteHostReady(`${ready}\nPI_HOST_DEPLOYMENT_TRANSACTION ../../bad`, { version: "1.2.0" }));
});
