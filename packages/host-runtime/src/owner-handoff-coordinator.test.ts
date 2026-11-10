import { readFileSync } from "node:fs";
import { MaintenanceAdmission } from "@pi-desktop/agent-host";
import type { OwnerHandoffInventory, OwnerHandoffQuiescenceRequest } from "@pi-desktop/shared";
import { describe, expect, it } from "vitest";
import { SidecarHandoff } from "../../agent-runtime/src/sidecar-handoff.js";
import { type OwnerHandoffBinding, OwnerHandoffCoordinator } from "./owner-handoff-coordinator.js";

const fixture = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/owner-handoff.json", import.meta.url), "utf8"));
const hold: OwnerHandoffQuiescenceRequest = { version: 1, operation: "hold", exchangeId: "44444444-4444-4444-8444-444444444444",
  transferId: fixture.response.record.id, sourceEpoch: fixture.response.record.sourceEpoch, revision: 1 };
const idle = (): OwnerHandoffInventory => ({ clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0,
  terminals: 0, plugins: 0, admissions: 0, finalizations: 0, writes: 0, children: 0, workers: 0, schedules: 0,
  approvals: 0, inputs: 0, nativeSessions: 0, mcp: 0, uncontainedResources: 0 });
function deferred<T>() { let resolve!: (value: T) => void;const promise = new Promise<T>(yes => { resolve = yes; });return { promise, resolve }; }
function build() {
  const gate = new MaintenanceAdmission();
  const sidecarGate = new SidecarHandoff(() => ({ turns: 0, children: 0, tools: 0, inputs: 0, settlements: 0, nativeSessions: 0, unqualifiedResources: 0 }));
  const sent: string[] = [];
  let loseReply: string | undefined;
  let inventory: () => Promise<OwnerHandoffInventory> = async () => idle();
  let journalPhase = "prepared";
  let beforeJournal: () => Promise<void> = async () => {};
  let beforeNative: () => Promise<void> = async () => {};
  let beforeSidecar: (operation: string) => Promise<void> = async () => {};
  let generation = "66666666-6666-4666-8666-666666666666";
  const sidecar = {
    async call<T>(_method: string, request: unknown): Promise<T> {
      const operation = (request as { operation: string }).operation;
      await beforeSidecar(operation);
      sent.push(operation);
      const reply = sidecarGate.control(request);
      if (loseReply === operation) { loseReply = undefined; throw new Error("lost response"); }
      return reply as T;
    },
    async executionStatus() { await beforeNative(); return { generation, state: "running" as const, activeProcesses: 2, rootExited: false, confirmed: false }; },
  };
  let hostGeneration = "88888888-8888-4888-8888-888888888888";
  const host: OwnerHandoffBinding["host"] = { get generation() { return hostGeneration; }, isAvailable: () => true };
  let binding: OwnerHandoffBinding = { sourceEpoch: hold.sourceEpoch, profileId: fixture.response.record.profile, generation, host, sidecar };
  const coordinator = new OwnerHandoffCoordinator({ gate, current: () => binding,
    inspect: () => inventory(),
    readTransfer: async () => { await beforeJournal(); return { version: 1 as const, record: { ...fixture.response.record, phase: journalPhase } }; },
  });
  const request = (operation: "inspect" | "cancel" | "seal", holdId: string): OwnerHandoffQuiescenceRequest => ({ ...hold, operation, holdId });
  return { gate, sidecarGate, coordinator, sent, request,
    inspect: (read: typeof inventory) => { inventory = read; },
    beforeJournal: (callback: () => Promise<void>) => { beforeJournal = callback; },
    beforeNative: (callback: () => Promise<void>) => { beforeNative = callback; },
    beforeSidecar: (callback: (operation: string) => Promise<void>) => { beforeSidecar = callback; },
    cancelJournal: () => { journalPhase = "cancelled"; },
    lose: (operation: string) => { loseReply = operation; },
    fencingJournal: () => { journalPhase = "source_fencing"; },
    replace: () => { binding = { ...binding, host: { ...host, generation: "99999999-9999-4999-8999-999999999999" } }; },
    replaceGeneration: () => { generation = "77777777-7777-4777-8777-777777777777"; },
    restartHost: () => { hostGeneration = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; },
  };
}

describe("original coordinator handoff", () => {
  it("closes local admission before awaiting inventory and reports a held contained sidecar", async () => {
    const f = build(); const pending = deferred<OwnerHandoffInventory>(); f.inspect(() => pending.promise);
    const exchange = f.coordinator.exchange(hold);
    expect(f.gate.isClosed()).toBe(true);
    await expect(f.coordinator.exchange(hold)).rejects.toMatchObject({ errorCode: "HANDOFF_BUSY" });
    pending.resolve(idle());const result = await exchange;
    expect(result.state).toBe("held");expect(Object.values(result.counts).every(value => value === 0)).toBe(true);
    await expect(f.sidecarGate.run("agent.prompt", async () => true)).rejects.toMatchObject({ errorCode: "HANDOFF_BUSY" });
    f.coordinator.dispose();
  });
  it("rejects a busy owner before sidecar effects and restores the unchanged source admission", async () => {
    const f = build();f.inspect(async () => ({ ...idle(), schedules: 1 }));
    await expect(f.coordinator.exchange(hold)).rejects.toMatchObject({ code: "HOST_BUSY" });
    expect(f.gate.isClosed()).toBe(false);expect(f.sent).toEqual([]);f.coordinator.dispose();
  });
  it("keeps an ambiguous acquire closed and reconciles through status without resending acquire", async () => {
    const f = build();f.lose("acquire");
    await expect(f.coordinator.exchange(hold)).rejects.toThrow("lost response");
    expect(f.gate.isClosed()).toBe(true);
    const result = await f.coordinator.exchange(hold);
    expect(result.state).toBe("held");expect(f.sent.filter(value => value === "acquire")).toHaveLength(1);
    f.coordinator.dispose();
  });
  it("requires durable cancellation before reopening either gate", async () => {
    const f = build();const result = await f.coordinator.exchange(hold);
    await expect(f.coordinator.exchange(f.request("cancel", result.holdId))).rejects.toMatchObject({ errorCode: "HANDOFF_CANCEL_UNCONFIRMED" });
    expect(f.gate.isClosed()).toBe(true);
    f.cancelJournal();expect((await f.coordinator.exchange(f.request("cancel", result.holdId))).state).toBe("cancelled");
    expect(f.gate.isClosed()).toBe(false);
    await expect(f.sidecarGate.run("agent.prompt", async () => true)).resolves.toBe(true);f.coordinator.dispose();
  });
  it("keeps a lost cancel response closed until explicit reconciliation confirms its durable result", async () => {
    const f = build();const result = await f.coordinator.exchange(hold);f.cancelJournal();f.lose("cancel");
    await expect(f.coordinator.exchange(f.request("cancel", result.holdId))).rejects.toThrow("lost response");
    expect(f.gate.isClosed()).toBe(true);
    expect((await f.coordinator.exchange(f.request("inspect", result.holdId))).state).toBe("cancelled");
    expect(f.gate.isClosed()).toBe(false);expect(f.sent.filter(value => value === "cancel")).toHaveLength(1);f.coordinator.dispose();
  });
  it("seals locally before sidecar effects and never permits cancellation after a lost seal", async () => {
    const f = build();const result = await f.coordinator.exchange(hold);f.fencingJournal();f.lose("seal");
    await expect(f.coordinator.exchange(f.request("seal", result.holdId))).rejects.toThrow("lost response");
    f.cancelJournal();
    await expect(f.coordinator.exchange(f.request("cancel", result.holdId))).rejects.toMatchObject({ errorCode: "HANDOFF_BUSY" });
    expect((await f.coordinator.exchange(f.request("inspect", result.holdId))).state).toBe("sealed");
    expect(f.gate.isClosed()).toBe(true);f.coordinator.dispose();
  });
  it("rejects stale epoch/hold and detects a replaced native generation without new side effects", async () => {
    const f = build();await expect(f.coordinator.exchange({ ...hold, sourceEpoch: hold.transferId })).rejects.toMatchObject({ errorCode: "HANDOFF_STALE" });
    const result = await f.coordinator.exchange(hold);
    await expect(f.coordinator.exchange(f.request("cancel", hold.transferId))).rejects.toMatchObject({ errorCode: "HANDOFF_STALE" });
    f.replaceGeneration();
    await expect(f.coordinator.exchange(f.request("inspect", result.holdId))).rejects.toMatchObject({ errorCode: "HANDOFF_OWNER_CHANGED" });
    expect(f.gate.isClosed()).toBe(true);f.coordinator.dispose();
  });
  it("does not reopen admission or touch replacement owners after a change during inspection", async () => {
    const f = build();const pending = deferred<OwnerHandoffInventory>();f.inspect(() => pending.promise);
    const exchange = f.coordinator.exchange(hold);f.replace();pending.resolve(idle());
    await expect(exchange).rejects.toMatchObject({ errorCode: "HANDOFF_OWNER_CHANGED" });
    expect(f.gate.isClosed()).toBe(true);expect(f.sent).toEqual([]);f.coordinator.dispose();
  });
  it("never lets a late cancellation of an old hold reopen a later hold", async () => {
    const f = build();const first = await f.coordinator.exchange(hold);f.cancelJournal();await f.coordinator.exchange(f.request("cancel", first.holdId));
    const second = await f.coordinator.exchange(hold);
    expect(second.holdId).not.toBe(first.holdId);
    expect((await f.coordinator.exchange(f.request("cancel", first.holdId))).state).toBe("cancelled");
    expect(f.gate.isClosed()).toBe(true);f.coordinator.dispose();
  });
  it("disposal during inspection fences late completion and cannot grant a hold", async () => {
    const f = build();const pending = deferred<OwnerHandoffInventory>();f.inspect(() => pending.promise);
    const exchange = f.coordinator.exchange(hold);f.coordinator.dispose();pending.resolve(idle());
    await expect(exchange).rejects.toMatchObject({ errorCode: "HANDOFF_UNAVAILABLE" });
    expect(f.gate.isClosed()).toBe(true);expect(f.sent).toEqual([]);
  });
});

it("does not retain an incomplete transfer when an ordinary maintenance lease owns the gate", async () => {
  const f = build();await f.gate.acquire("maintenance", async () => idle());
  await expect(f.coordinator.exchange(hold)).rejects.toMatchObject({ errorCode: "HANDOFF_BUSY" });
  f.gate.release("maintenance");
  expect((await f.coordinator.exchange(hold)).state).toBe("held");f.coordinator.dispose();
});

it("rechecks resources after asynchronous journal confirmation before sealing", async () => {
  const f = build();const result = await f.coordinator.exchange(hold);f.fencingJournal();
  const entered = deferred<void>();const journal = deferred<void>();
  f.beforeJournal(async () => { entered.resolve();await journal.promise; });
  const sealing = f.coordinator.exchange(f.request("seal", result.holdId));
  await entered.promise;f.inspect(async () => ({ ...idle(), plugins: 1 }));journal.resolve();
  await expect(sealing).rejects.toMatchObject({ errorCode: "HANDOFF_BUSY" });
  expect(f.sent).not.toContain("seal");expect(f.gate.isClosed()).toBe(true);f.coordinator.dispose();
});

it("refuses sealing before Rust has committed fencing intent", async () => {
  const f = build();const result = await f.coordinator.exchange(hold);
  await expect(f.coordinator.exchange(f.request("seal", result.holdId))).rejects.toMatchObject({ errorCode: "HANDOFF_FENCING_UNCONFIRMED" });
  expect(f.sent).not.toContain("seal");f.coordinator.dispose();
});

it("rejects a restarted Host wrapper while the original inventory is pending", async () => {
  const f = build(); const pending = deferred<OwnerHandoffInventory>();
  f.inspect(() => pending.promise);
  const exchange = f.coordinator.exchange(hold);
  f.restartHost(); pending.resolve(idle());
  await expect(exchange).rejects.toMatchObject({ errorCode: "HANDOFF_OWNER_CHANGED" });
  expect(f.gate.isClosed()).toBe(true); expect(f.sent).toEqual([]);
  f.coordinator.dispose();
});

it("keeps admission closed when a restarted owner's inventory rejects", async () => {
  const f = build(); const entered = deferred<void>(); const resumed = deferred<void>();
  f.inspect(async () => { entered.resolve(); await resumed.promise; throw new Error("inventory failed"); });
  const exchange = f.coordinator.exchange(hold);
  await entered.promise; f.restartHost(); resumed.resolve();
  await expect(exchange).rejects.toMatchObject({ errorCode: "HANDOFF_OWNER_CHANGED" });
  expect(f.gate.isClosed()).toBe(true); expect(f.sent).toEqual([]);
  f.coordinator.dispose();
});

it("never cancels a held source through a restarted Host wrapper", async () => {
  const f = build(); const held = await f.coordinator.exchange(hold); f.cancelJournal();
  const entered = deferred<void>(); const resumed = deferred<void>();
  f.beforeJournal(async () => { entered.resolve(); await resumed.promise; });
  const cancelling = f.coordinator.exchange(f.request("cancel", held.holdId));
  await entered.promise; f.restartHost(); resumed.resolve();
  await expect(cancelling).rejects.toMatchObject({ errorCode: "HANDOFF_OWNER_CHANGED" });
  expect(f.gate.isClosed()).toBe(true); expect(f.sent).not.toContain("cancel");
  f.coordinator.dispose();
});

for (const boundary of ["native", "journal", "status", "cancel", "seal"] as const) {
  it(`rejects a changed original owner even when ${boundary} fails`, async () => {
    const f = build(); const held = await f.coordinator.exchange(hold);
    const entered = deferred<void>(); const resumed = deferred<void>();
    const fail = async () => { entered.resolve(); await resumed.promise; throw new Error("original operation failed"); };
    let operation: "inspect" | "cancel" | "seal" = "inspect";
    if (boundary === "native") f.beforeNative(fail);
    else if (boundary === "journal") { f.cancelJournal(); operation = "cancel"; f.beforeJournal(fail); }
    else {
      f.beforeSidecar(async current => { if (current === boundary) await fail(); });
      if (boundary === "cancel") { f.cancelJournal(); operation = "cancel"; }
      if (boundary === "seal") { f.fencingJournal(); operation = "seal"; }
    }
    const pending = f.coordinator.exchange(f.request(operation, held.holdId));
    const rejected = expect(pending).rejects.toMatchObject({ errorCode: "HANDOFF_OWNER_CHANGED" });
    await entered.promise; f.restartHost(); resumed.resolve();
    await rejected;
    expect(f.gate.isClosed()).toBe(true);
    if (boundary === "journal" || boundary === "cancel") expect(f.sent).not.toContain("cancel");
    if (boundary === "seal") expect(f.sent).not.toContain("seal");
    f.coordinator.dispose();
  });
}

it("never substitutes the first observed native generation for the captured binding", async () => {
  const f = build(); f.replaceGeneration();
  await expect(f.coordinator.exchange(hold)).rejects.toMatchObject({ errorCode: "HANDOFF_OWNER_CHANGED" });
  expect(f.sent).toEqual([]); expect(f.gate.isClosed()).toBe(true); f.coordinator.dispose();
});
