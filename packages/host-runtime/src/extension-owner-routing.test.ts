import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSidecar, type TrustedExtensionSidecarBridge } from "./agent-sidecar.js";
const sidecars: AgentSidecar[] = [];
afterEach(async () => { await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.dispose())); });

function sidecar(bridge: TrustedExtensionSidecarBridge, shutdownReply = true) {
  const source = `
    const rl = require('node:readline').createInterface({input: process.stdin});
    const pending = new Map();
    rl.on('line', line => {
      const msg = JSON.parse(line);
      if (msg.method === 'proxy') {
        pending.set('host-' + msg.id, msg.id);
        console.log(JSON.stringify({jsonrpc:'2.0',id:'host-' + msg.id,method:'host.proxy',params:msg.params}));
      } else if (msg.method === 'agent.shutdown') {
        ${shutdownReply ? "console.log(JSON.stringify({id:msg.id,result:{ok:true}}));" : ""}
      } else if (pending.has(msg.id)) {
        console.log(JSON.stringify({id:pending.get(msg.id), ...(msg.error ? {error:msg.error} : {result:msg.result})}));
        pending.delete(msg.id);
      }
    });`;
  const client = new AgentSidecar({ launch: { command: process.execPath, args: ["-e", source] }, onStderr: () => {} });
  sidecars.push(client);
  client.setTrustedExtensionBridge(bridge);
  return client;
}
function legacyBridge(): TrustedExtensionSidecarBridge {
  return { publishCommands: vi.fn(), publishDiagnostics: vi.fn(), requestUi: vi.fn(async () => ({ kind: "notify" })),
    configureModel: vi.fn(async () => ({ ok: true })), queuePush: vi.fn(async () => ({ ok: true })),
    queuePrioritize: vi.fn(async () => ({ ok: true })) };
}
describe("owner stdio routing", () => {
  it("routes declared owner endpoints through the embedding bridge", async () => {
    const bridge = legacyBridge();
    const operations = ["callOwner", "cancelOwner", "registerRuntime", "retireRuntime"] as const;
    for (const name of operations) bridge[name] = vi.fn(async (params) => ({ endpoint: name, params }));
    const client = sidecar(bridge);
    for (const [index, suffix] of ["call", "cancel", "registerRuntime", "retireRuntime"].entries()) {
      const params = { sessionId: "s1", extensionId: "e1", runtimeId: "r1", requestId: "q1" };
      expect(await client.call("proxy", { method: `extensions.owner.${suffix}`, params }))
        .toEqual({ endpoint: operations[index], params });
    }
    expect(bridge.requestUi).not.toHaveBeenCalled();
    await expect(client.call("proxy", { method: "extensions.owner.arbitrary", params: {} })).rejects.toThrow();
  });
  it("fails closed on old embedding hosts while preserving their existing UI calls", async () => {
    const bridge = legacyBridge(); const client = sidecar(bridge);
    await expect(client.call("proxy", { method: "extensions.owner.call", params: {} })).rejects.toThrow(/unavailable/);
    expect(await client.call("proxy", { method: "extensions.ui.request", params: {} })).toEqual({ kind: "notify" });
    await client.shutdown();
    await expect(client.call("proxy", {})).rejects.toThrow(/unavailable/);
  });
  it("terminates a nonresponsive legacy child after the bounded shutdown deadline", async () => {
    const client = sidecar(legacyBridge(), false);
    // An explicit ready exchange separates process startup from the shutdown deadline.
    await client.call("proxy", { method: "extensions.ui.request", params: {} });
    await expect(client.shutdown(30)).rejects.toThrow(/timeout/);
    await expect(client.call("proxy", {})).rejects.toThrow(/unavailable/);
  });
});
