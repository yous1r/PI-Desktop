import { expect, it } from "vitest";
import { MaintenanceAdmission } from "@pi-desktop/agent-host";
import { RacpServer } from "./server.js";
import { buildHost, credentialStore, fakeOperations, MemoryLink, OWNER_TOKEN } from "./test-harness.js";

it("maintenance closes client admission before async inspection and reopens after release", async () => {
  const { host, sessions } = buildHost();
  const { authenticator } = await credentialStore();
  const gate = new MaintenanceAdmission();
  const server = new RacpServer({ agentHost: host, operations: fakeOperations(sessions), authenticator,
    hostId: "host_test", serverVersion: "1.0.0", log: () => {}, admission: gate });
  const auth = await authenticator.authenticate({ authorization: `Bearer ${OWNER_TOKEN}`, urlHasToken: false, connectionId: "pending" });
  if (!auth) throw new Error("fixture authentication failed");
  let finish!: () => void;
  const inspection = new Promise<void>(resolve => { finish = resolve; });
  try {
    const lease = gate.acquire("deployment", async () => {
      await inspection;
      return { clients: server.connectionCount(), turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0, terminals: 0, plugins: 0 };
    });
    expect(server.accept(auth, new MemoryLink().serverSide())).toBeNull();
    expect(server.connectionCount()).toBe(0);
    finish(); await lease;
    expect(server.accept(auth, new MemoryLink().serverSide())).toBeNull();
    gate.release("deployment");
    expect(server.accept(auth, new MemoryLink().serverSide())).not.toBeNull();
    expect(server.connectionCount()).toBe(1);
  } finally { server.close(); gate.dispose(); }
});
