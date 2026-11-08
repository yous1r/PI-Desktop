import { describe, expect, it } from "vitest";
import { SidecarHandoff } from "../../agent-runtime/src/sidecar-handoff.js";
import { SidecarHandoffClient } from "./sidecar-handoff-client.js";
import type { AgentSidecar } from "./agent-sidecar.js";

const identity = { version: 1 as const, transferId: "11111111-1111-4111-8111-111111111111", sourceEpoch: "22222222-2222-4222-8222-222222222222", revision: 1 };
const idle = () => ({ turns: 0, children: 0, tools: 0, inputs: 0, settlements: 0, nativeSessions: 0, unqualifiedResources: 0 });
function fixture() {
  const gate = new SidecarHandoff(idle);
  const requests: unknown[] = [];
  let loseReply = false;
  const sidecar: Pick<AgentSidecar, "call"> = {
    async call<T>(method: string, params: unknown, timeout?: number): Promise<T> {
      expect(method).toBe("sidecar.handoff"); expect(timeout).toBe(5000);
      requests.push(params);
      const result = gate.control(params);
      if (loseReply) { loseReply = false; throw new Error("reply lost"); }
      return result as T;
    },
  };
  return { gate, requests, client: new SidecarHandoffClient(sidecar, identity), loseReply: () => { loseReply = true; } };
}

describe("sidecar handoff consumer", () => {
  it("queries a lost acquire reply without replaying it, then confirms cancellation", async () => {
    const f = fixture();
    f.loseReply();
    await expect(f.client.acquire()).rejects.toThrow("reply lost");
    expect(f.requests).toHaveLength(1);
    const held = await f.client.status();
    expect(held.state).toBe("held");
    expect(f.requests).toEqual([{ ...identity, operation: "acquire" }, { ...identity, operation: "status" }]);
    expect((await f.client.cancel(held.holdId)).state).toBe("cancelled");
    expect((await f.client.status(held.holdId)).state).toBe("cancelled");
  });

  it("reconciles a lost seal without allowing cancellation or execution", async () => {
    const f = fixture();
    const held = await f.client.acquire();
    f.loseReply();
    await expect(f.client.seal(held.holdId)).rejects.toThrow("reply lost");
    expect((await f.client.status(held.holdId)).state).toBe("sealed");
    await expect(f.client.cancel(held.holdId)).rejects.toMatchObject({ errorCode: "HANDOFF_BUSY" });
    await expect(f.gate.run("agent.prompt", async () => true)).rejects.toMatchObject({ errorCode: "HANDOFF_BUSY" });
  });

  it("rejects response identity, shape, counters and operation state mismatches", async () => {
    const f = fixture();
    const held = await f.client.acquire();
    for (const response of [null, { ...held, sourceEpoch: identity.transferId }, { ...held, revision: 2 },
      { ...held, state: "ready" }, { ...held, extra: true }, { ...held, counts: { ...held.counts, requests: 1 } },
      { ...held, counts: { ...held.counts, children: undefined } }, { ...held, state: "cancelled" }]) {
      const sidecar: Pick<AgentSidecar, "call"> = { async call<T>() { return response as T; } };
      await expect(new SidecarHandoffClient(sidecar, identity).acquire()).rejects.toThrow("HANDOFF_INVALID_RESPONSE");
    }
    const sidecar: Pick<AgentSidecar, "call"> = { async call<T>() { return held as T; } };
    const client = new SidecarHandoffClient(sidecar, identity);
    await expect(client.seal(held.holdId)).rejects.toThrow("HANDOFF_INVALID_RESPONSE");
    await expect(client.cancel(held.holdId)).rejects.toThrow("HANDOFF_INVALID_RESPONSE");
    await expect(client.status(identity.sourceEpoch)).rejects.toThrow("HANDOFF_INVALID_RESPONSE");
  });

  it("rejects invalid requests before sending and snapshots its operation identity", async () => {
    const f = fixture();
    await expect(f.client.cancel("not-a-hold")).rejects.toThrow("HANDOFF_INVALID_REQUEST");
    expect(f.requests).toEqual([]);
    const mutable = { ...identity };
    const gate = new SidecarHandoff(idle);
    const sidecar: Pick<AgentSidecar, "call"> = { async call<T>(_method: string, params: unknown) { return gate.control(params) as T; } };
    const client = new SidecarHandoffClient(sidecar, mutable);
    mutable.revision = 2;
    expect((await client.acquire()).revision).toBe(1);
    expect(() => new SidecarHandoffClient(sidecar, { ...identity, revision: 0 })).toThrow("HANDOFF_INVALID_REQUEST");
  });
});
