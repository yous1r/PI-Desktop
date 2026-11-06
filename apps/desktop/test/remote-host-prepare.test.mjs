import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createRemoteHostPreparer } = await import("../electron/main/remote/remote-host-prepare.ts");
const error = code => Object.assign(new Error(code), { errorCode: code });
const record = () => ({ hostKey: "box", label: "Box", url: "ws://127.0.0.1:1", deviceToken: "keep-token",
  metadata: { transport: "ssh", ssh: { host: "box", remotePort: 1, hostId: "keep-id", version: "1.0.0" } } });
function fixture(overrides = {}) {
  let saved = record(), mismatch = true, upgrades = 0;
  const states = [];
  const registry = { list: async () => [saved], upsert: async value => { saved = structuredClone(value); } };
  const service = createRemoteHostPreparer({ version: "1.1.0", registry,
    connect: async () => { if (mismatch) throw Object.assign(error("HOST_VERSION_MISMATCH"), { remoteVersion: "1.0.0" }); },
    upgrade: async (r, run) => { upgrades++; run.progress("downloading"); mismatch = false; return r; },
    summary: r => ({ hostKey: r.hostKey, connected: !mismatch, label: r.label, url: r.url }),
    changed: () => states.push(service.state("box")), ...overrides,
  });
  return { service, states, registry, saved: () => saved, upgrades: () => upgrades, mismatch: () => { mismatch = true; } };
}
test("first download is explicit, later upgrades reuse consent but recheck the live Host", async () => {
  const f = fixture();
  await assert.rejects(f.service.ensureReady("box"), { errorCode: "HOST_DOWNLOAD_REQUIRED" });
  assert.equal(f.service.state("box").phase, "awaiting-download"); assert.equal(f.upgrades(), 0);
  const result = await f.service.prepare({ hostKey: "box", requestId: "picker", allowDownload: true });
  assert.equal(result.connected, true); assert.equal(f.saved().deviceToken, "keep-token");
  assert.equal(f.saved().metadata.piHostPreparationAttempt.succeeded, true);
  f.mismatch(); await f.service.ensureReady("box"); assert.equal(f.upgrades(), 2);
});
test("concurrent callers share one prepare; cancelling one does not cancel the other", async () => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  let upgrades = 0, ready = false, aborted = false;
  const f = fixture({ connect: async () => { if (!ready) throw error("HOST_VERSION_MISMATCH"); },
    upgrade: async (r, run) => { upgrades++; entered.resolve(); await gate.promise; aborted = run.signal.aborted; ready = true; return r; } });
  const a = f.service.prepare({ hostKey: "box", requestId: "a", allowDownload: true });
  const b = f.service.prepare({ hostKey: "box", requestId: "b", allowDownload: true });
  const rejected = assert.rejects(a, { errorCode: "HOST_PREPARATION_CANCELLED" });
  await entered.promise; f.service.cancel("box", "a"); gate.resolve();
  await rejected; await b; assert.equal(upgrades, 1); assert.equal(aborted, false);
});
test("last cancellation stops work and never writes a successful upgrade receipt", async () => {
  const entered = Promise.withResolvers();
  const f = fixture({ upgrade: async (_r, run) => { entered.resolve(); await new Promise(resolve => run.signal.addEventListener("abort", resolve, { once: true })); run.signal.throwIfAborted(); } });
  const pending = f.service.prepare({ hostKey: "box", requestId: "a", allowDownload: true });
  const rejected = assert.rejects(pending, { errorCode: "HOST_PREPARATION_CANCELLED" });
  await entered.promise; f.service.cancel("box", "a"); await rejected; await f.service.dispose();
  assert.notEqual(f.saved().metadata.piHostPreparationAttempt?.succeeded, true);
});
test("auth failures and newer versions never call the installer", async () => {
  for (const code of ["HOST_AUTH_FAILED", "HOST_CLIENT_TOO_OLD", "HOST_VERSION_UNSUPPORTED"]) {
    const f = fixture({ connect: async () => { throw error(code); } });
    await assert.rejects(f.service.prepare({ hostKey: "box", requestId: code, allowDownload: true, retry: true }), { errorCode: code });
    assert.equal(f.upgrades(), 0);
  }
});
test("a failed post-install handshake is not success; explicit retry bypasses cooldown", async () => {
  let installs = 0;
  const f = fixture({ upgrade: async r => { installs++; return r; } });
  await assert.rejects(f.service.prepare({ hostKey: "box", requestId: "a", allowDownload: true }), { errorCode: "HOST_VERSION_MISMATCH" });
  assert.equal(f.saved().metadata.piHostPreparationAttempt.succeeded, false);
  await assert.rejects(f.service.ensureReady("box")); assert.equal(installs, 1);
  await assert.rejects(f.service.prepare({ hostKey: "box", requestId: "b", retry: true })); assert.equal(installs, 2);
});
