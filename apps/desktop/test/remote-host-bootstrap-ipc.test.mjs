import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
// Electron is the external boundary; handlers and boot dispatch remain real.
register(`data:text/javascript,${encodeURIComponent('export async function resolve(s,c,n){return s === "electron" ? {url:"data:text/javascript,export const app = {};",shortCircuit:true} : n(s,c)}')}`);
const { IPC } = await import("@pi-desktop/shared");
const { registerRemoteHostIpc } = await import("../electron/main/ipc/remote-host-ipc.ts");

test("bootstrap IPC accepts only explicit boolean maintenance consent", async () => {
  const handlers = new Map(), calls = [];
  registerRemoteHostIpc({ registrar: { handle: (name, handler) => handlers.set(name, handler) },
    clientInfo: { name: "test", version: "0.22.2" },
    getRemoteHostsBoot: () => ({ bootstrapHost: async request => { calls.push(request); return { host: { hostKey: "h" } }; } }),
  });
  const bootstrap = handlers.get(IPC.invoke.remoteHostBootstrap);
  for (const value of ["true", 1, null, {}, []]) {
    await assert.rejects(bootstrap({ host: "dev", allowLegacyMaintenance: value }), { errorCode: "INVALID_ARGUMENT" });
  }
  assert.equal(calls.length, 0);
  for (const value of [undefined, false, true]) {
    await bootstrap({ host: " dev ", label: " Test ", ...(value === undefined ? {} : { allowLegacyMaintenance: value }) });
  }
  assert.deepEqual(calls, [
    { host: "dev", label: "Test" },
    { host: "dev", label: "Test", allowLegacyMaintenance: false },
    { host: "dev", label: "Test", allowLegacyMaintenance: true },
  ]);
});
