import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { IPC } = await import("@pi-desktop/shared");
const { registerRemoteSessionIpc } = await import("../electron/main/ipc/remote-session-ipc.ts");

function fixture() {
  const handlers = new Map(), calls = [];
  registerRemoteSessionIpc({ handle: (name, handler) => handlers.set(name, handler) }, () => ({
    prepareHost: async request => { calls.push(request); return { hostKey: request.hostKey }; },
    cancelPreparation: (...args) => calls.push(args),
  }));
  return { calls, prepare: handlers.get(IPC.invoke.remoteHostPrepare), cancel: handlers.get(IPC.invoke.remoteHostPrepareCancel) };
}
test("prepare IPC preserves explicit consent, retry and independent cancellation ownership", async () => {
  const f = fixture();
  assert.deepEqual(await f.prepare({ hostKey: " host ", requestId: "one", allowDownload: true,
    allowLegacyMaintenance: true, retry: true }), { host: { hostKey: "host" } });
  assert.deepEqual(f.calls[0], { hostKey: "host", requestId: "one", allowDownload: true,
    allowLegacyMaintenance: true, retry: true });
  assert.deepEqual(await f.cancel({ hostKey: "host", requestId: "two" }), { ok: true });
  assert.deepEqual(f.calls[1], ["host", "two"]);
});
test("prepare IPC refuses malformed or expanded capabilities before dispatch", async () => {
  const f = fixture();
  for (const request of [null, [], {}, { hostKey: "h", requestId: "" },
    { hostKey: "h:a", requestId: "x" }, { hostKey: "h", requestId: "x".repeat(129) },
    { hostKey: "h", requestId: "x\n" }, { hostKey: "h", requestId: "x", allowDownload: "yes" },
    { hostKey: "h", requestId: "x", allowLegacyMaintenance: 1 },
    { hostKey: "h", requestId: "x", retry: null },
    { hostKey: "h", requestId: "x", proxy: "http://untrusted" }]) {
    await assert.rejects(f.prepare(request), { errorCode: "INVALID_ARGUMENT" });
  }
  await assert.rejects(f.cancel({ hostKey: "h", requestId: "x", all: true }), { errorCode: "INVALID_ARGUMENT" });
  assert.deepEqual(f.calls, []);
});
