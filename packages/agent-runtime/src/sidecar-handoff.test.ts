import { describe, expect, it } from "vitest";
import { SidecarHandoff } from "./sidecar-handoff.js";

const identity = { version: 1 as const, transferId: "11111111-1111-4111-8111-111111111111", sourceEpoch: "22222222-2222-4222-8222-222222222222", revision: 1 };
const idle = () => ({ turns: 0, children: 0, tools: 0, inputs: 0, settlements: 0, nativeSessions: 0, unqualifiedResources: 0 });
const acquire = () => ({ ...identity, operation: "acquire" });
const request = (holdId: string, operation: string) => ({ ...identity, holdId, operation });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe("sidecar handoff boundary", () => {
  it("closes ordinary RPC before returning a hold, preserves health and cancels explicitly", async () => {
    const gate = new SidecarHandoff(idle);
    const hold = gate.control(acquire());
    expect(hold.state).toBe("held");
    expect(gate.control(acquire())).toEqual(hold);
    for (const method of ["agent.prompt", "agent.steer", "agent.compact", "extensions.command.prepare", "native.session.list", "future.mutation", "agent.shutdown"]) {
      await expect(gate.run(method, async () => { throw new Error("must not dispatch"); })).rejects.toMatchObject({ errorCode: "HANDOFF_BUSY" });
    }
    await expect(gate.run("sidecar.health", async () => "healthy")).resolves.toBe("healthy");
    expect(gate.control(request(hold.holdId, "cancel")).state).toBe("cancelled");
    expect(gate.control(request(hold.holdId, "status")).state).toBe("cancelled");
    await expect(gate.run("agent.prompt", async () => "accepted")).resolves.toBe("accepted");
  });

  it("refuses a pending request even before a runtime has been registered", async () => {
    const gate = new SidecarHandoff(idle);
    const barrier = deferred();
    const running = gate.run("extensions.command.prepare", () => barrier.promise);
    expect(() => gate.control(acquire())).toThrowError(expect.objectContaining({ errorCode: "HANDOFF_BUSY" }));
    barrier.resolve(); await running;
    expect(gate.control(acquire()).state).toBe("held");
  });

  it("retains an acknowledged background operation until its actual promise settles", async () => {
    const gate = new SidecarHandoff(idle);
    const barrier = deferred();
    let background!: Promise<void>;
    await gate.run("agent.prompt", async () => { background = gate.track(() => barrier.promise); return { accepted: true }; });
    expect(() => gate.control(acquire())).toThrowError(expect.objectContaining({ errorCode: "HANDOFF_BUSY" }));
    barrier.resolve(); await background;
    expect(gate.control(acquire()).state).toBe("held");
  });

  it("rejects every busy or unknown owner field without changing admission", async () => {
    for (const key of Object.keys(idle())) {
      for (const value of [1, undefined, -1, NaN, Infinity, 0.5]) {
        const gate = new SidecarHandoff(() => ({ ...idle(), [key]: value }));
        expect(() => gate.control(acquire())).toThrowError(expect.objectContaining({ errorCode: value === 1 ? "HANDOFF_BUSY" : "HANDOFF_UNAVAILABLE" }));
        await expect(gate.run("agent.prompt", async () => true)).resolves.toBe(true);
      }
    }
  });

  it("rejects malformed identities, revisions and unknown operation fields", () => {
    const gate = new SidecarHandoff(idle);
    for (const invalid of [{ ...acquire(), pid: 1 }, { ...acquire(), version: 2 }, { ...acquire(), revision: 0 },
      { ...acquire(), revision: Number.MAX_SAFE_INTEGER + 1 }, { ...acquire(), sourceEpoch: "0".repeat(32) },
      { ...acquire(), transferId: "00000000-0000-0000-0000-000000000000" }, { ...acquire(), operation: "cancel" }]) {
      expect(() => gate.control(invalid)).toThrowError(expect.objectContaining({ errorCode: "HANDOFF_INVALID_REQUEST" }));
    }
  });

  it("requires the exact hold identity and keeps a stale cancellation from releasing a new hold", () => {
    const gate = new SidecarHandoff(idle);
    const first = gate.control(acquire());
    for (const wrong of [{ ...request(first.holdId, "cancel"), revision: 2 },
      { ...request(first.holdId, "cancel"), sourceEpoch: identity.transferId },
      request(identity.sourceEpoch, "cancel")]) {
      expect(() => gate.control(wrong)).toThrowError(expect.objectContaining({ errorCode: "HANDOFF_STALE" }));
    }
    gate.control(request(first.holdId, "cancel"));
    const next = gate.control(acquire());
    expect(next.holdId).not.toBe(first.holdId);
    expect(gate.control(request(first.holdId, "cancel")).state).toBe("cancelled");
    expect(gate.control(request(next.holdId, "status")).state).toBe("held");
  });

  it("seals before teardown and never reopens after cancellation, shutdown or failed shutdown", async () => {
    const gate = new SidecarHandoff(idle);
    const hold = gate.control(acquire());
    expect(gate.control(request(hold.holdId, "seal")).state).toBe("sealed");
    expect(gate.control(request(hold.holdId, "seal")).state).toBe("sealed");
    expect(() => gate.control(request(hold.holdId, "cancel"))).toThrowError(expect.objectContaining({ errorCode: "HANDOFF_BUSY" }));
    await expect(gate.run("agent.shutdown", async () => { gate.dispose(); throw new Error("cleanup failed"); })).rejects.toThrow("cleanup failed");
    await expect(gate.run("agent.prompt", async () => true)).rejects.toMatchObject({ errorCode: "HANDOFF_UNAVAILABLE" });
    expect(() => gate.control(acquire())).toThrowError(expect.objectContaining({ errorCode: "HANDOFF_UNAVAILABLE" }));
  });

  it("keeps admission closed when inspection throws or returns an invalid shape during a held status", async () => {
    let unavailable = false;
    const gate = new SidecarHandoff(() => { if (unavailable) throw new Error("owner gone"); return idle(); });
    const hold = gate.control(acquire()); unavailable = true;
    expect(() => gate.control(request(hold.holdId, "status"))).toThrowError(expect.objectContaining({ errorCode: "HANDOFF_UNAVAILABLE" }));
    await expect(gate.run("agent.prompt", async () => true)).rejects.toMatchObject({ errorCode: "HANDOFF_BUSY" });
  });
});

it("reconciles a lost acquisition reply by identity without acquiring or reopening", () => {
  const gate = new SidecarHandoff(idle);
  const status = { ...identity, operation: "status" };
  expect(() => gate.control(status)).toThrowError(expect.objectContaining({ errorCode: "HANDOFF_STALE" }));
  const held = gate.control(acquire());
  expect(gate.control(status)).toEqual(held);
  gate.control(request(held.holdId, "seal"));
  expect(gate.control(status).state).toBe("sealed");
  expect(() => gate.control({ ...status, revision: 2 })).toThrowError(expect.objectContaining({ errorCode: "HANDOFF_STALE" }));
});
