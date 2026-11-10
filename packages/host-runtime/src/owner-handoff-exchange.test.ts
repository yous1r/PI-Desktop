import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerHandoffExchangeOptions } from "./owner-handoff-exchange.js";
import { bindOwnerHandoffExchange } from "./owner-handoff-exchange.js";
import { OWNER_HANDOFF_EXCHANGE_METHOD, OWNER_HANDOFF_COMPLETE_METHOD, type OwnerHandoffCompletion } from "@pi-desktop/shared";
const fixture = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/owner-handoff-exchange.json", import.meta.url), "utf8"));
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup(overrides: Partial<OwnerHandoffExchangeOptions> = {}) {
  const handlers = new Set<(method: string, value: unknown) => void>(), exits = new Set<() => void>();
  const completed = deferred<OwnerHandoffCompletion>();
  const host = { generation: "original", isAvailable: vi.fn(() => true),
    onNotification: (handler: (method: string, value: unknown) => void) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
    onExit: (handler: () => void) => { exits.add(handler); return () => { exits.delete(handler); }; },
    call: vi.fn(async <T>(_method: string, value?: unknown): Promise<T> => { const completion = value as OwnerHandoffCompletion;
      completed.resolve(completion); return { ...fixture.ack, exchangeId: completion.request.exchangeId } as T; }),
  };
  const options = { host, isCurrent: vi.fn(() => true), exchange: vi.fn(async () => structuredClone(fixture.success.outcome.report)), unavailable: vi.fn(), ...overrides };
  const channel = bindOwnerHandoffExchange(options);
  const emit = (value: unknown = structuredClone(fixture.notification), method = OWNER_HANDOFF_EXCHANGE_METHOD) => {
    for (const handler of handlers) handler(method, value);
  };
  return { host, options, channel, emit, handlers, exits, completed };
}
afterEach(() => vi.useRealTimers());
describe("original stdio handoff exchange", () => {
  it("does no startup queries and sends one validated completion on the notifying original", async () => {
    const f = setup(); expect(f.host.call).not.toHaveBeenCalled(); expect(f.options.exchange).not.toHaveBeenCalled();
    f.emit(undefined, "ordinary.event"); expect(f.options.exchange).not.toHaveBeenCalled();
    f.emit(); expect(await f.completed.promise).toEqual(fixture.success);
    expect(f.host.call).toHaveBeenCalledWith(OWNER_HANDOFF_COMPLETE_METHOD, fixture.success, 2000);
    f.channel.dispose(); expect(f.handlers.size + f.exits.size).toBe(0);
  });
  for (const [input, output] of [["HOST_BUSY", "HANDOFF_BUSY"], ["HANDOFF_BUSY", "HANDOFF_BUSY"], ["HANDOFF_OWNER_CHANGED", "HANDOFF_OWNER_CHANGED"], ["secret/path", "HANDOFF_UNAVAILABLE"]]) {
    it(`maps ${input} to a payload-free completion`, async () => {
      const f = setup({ exchange: async () => { throw Object.assign(new Error("secret"), { errorCode: input }); } });
      f.emit(); expect((await f.completed.promise).outcome).toEqual({ error: { code: output } }); f.channel.dispose();
    });
  }
  it("refuses malformed notification without querying owners", () => {
    const f = setup(); expect(() => f.emit({ ...fixture.notification, extra: true })).not.toThrow();
    expect(f.options.exchange).not.toHaveBeenCalled(); expect(f.host.call).not.toHaveBeenCalled();
    expect(f.handlers.size + f.exits.size).toBe(0); expect(f.options.unavailable).toHaveBeenCalledOnce();
  });
  it("reserves before coordinator reentry and never sends either duplicate completion", async () => {
    const f = setup(); f.options.exchange.mockImplementation(async () => { f.emit(); return fixture.success.outcome.report; });
    f.emit(); await Promise.resolve(); await Promise.resolve();
    expect(f.options.exchange).toHaveBeenCalledOnce(); expect(f.host.call).not.toHaveBeenCalled();
    expect(f.options.unavailable).toHaveBeenCalledOnce();
  });
  for (const change of ["generation", "current", "exit", "dispose"] as const) {
    it(`does not complete after original ${change} changes during an await`, async () => {
      const work = deferred<typeof fixture.success.outcome.report>(); const f = setup({ exchange: () => work.promise });
      f.emit();
      if (change === "generation") f.host.generation = "replacement";
      if (change === "current") f.options.isCurrent.mockReturnValue(false);
      if (change === "exit") for (const handler of f.exits) handler();
      if (change === "dispose") f.channel.dispose();
      work.resolve(fixture.success.outcome.report); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(f.host.call).not.toHaveBeenCalled(); expect(f.options.unavailable).toHaveBeenCalledOnce();
    });
  }
  it("observes late rejection after coordinator timeout and sends no completion", async () => {
    vi.useFakeTimers(); const work = deferred<typeof fixture.success.outcome.report>(); const f = setup({ exchange: () => work.promise });
    f.emit(); await vi.advanceTimersByTimeAsync(25000); expect(f.options.unavailable).toHaveBeenCalledOnce();
    work.reject(new Error("late secret")); await vi.runAllTimersAsync(); expect(f.host.call).not.toHaveBeenCalled();
  });
  it("bounds the complete RPC including overload retries and observes late failure", async () => {
    vi.useFakeTimers(); const rpc = deferred<unknown>(); const f = setup(); f.host.call.mockImplementation(() => rpc.promise as Promise<never>);
    f.emit(); await vi.advanceTimersByTimeAsync(2500); expect(f.options.unavailable).toHaveBeenCalledOnce();
    rpc.reject(new Error("late secret")); await vi.runAllTimersAsync(); expect(f.host.call).toHaveBeenCalledOnce();
  });
  it("invalid reports and wrong acknowledgements permanently close the channel", async () => {
    vi.useFakeTimers(); const f = setup(); f.host.call.mockResolvedValue({ ...fixture.ack, exchangeId: "wrong" });
    f.emit(); await vi.runAllTimersAsync(); expect(f.options.unavailable).toHaveBeenCalledOnce();
    const bad = setup({ exchange: async () => ({ ...fixture.success.outcome.report, counts: {} }) });
    bad.emit(); await vi.runAllTimersAsync(); expect(bad.host.call).not.toHaveBeenCalled(); expect(bad.options.unavailable).toHaveBeenCalledOnce();
  });
  it("does not leak synchronous coordinator or cleanup failure into Host notification dispatch", async () => {
    vi.useFakeTimers(); const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const f = setup({ exchange: () => { throw new Error("secret"); }, unavailable: () => { throw new Error("secret"); } });
      expect(() => f.emit()).not.toThrow(); await vi.runAllTimersAsync(); expect((await f.completed.promise).outcome).toEqual({ error: { code: "HANDOFF_UNAVAILABLE" } });
      expect(() => f.channel.dispose()).not.toThrow(); expect(warn).toHaveBeenCalledWith("[owner-handoff] channel cleanup failed");
    } finally { warn.mockRestore(); }
  });
});

it("maps the real maintenance code field without exposing its error payload", async () => {
  const f = setup({ exchange: async () => { throw Object.assign(new Error("private inventory"), { code: "HOST_BUSY" }); } });
  f.emit(); expect((await f.completed.promise).outcome).toEqual({ error: { code: "HANDOFF_BUSY" } }); f.channel.dispose();
});
it("reserves the channel before a synchronous current-owner callback reenters", async () => {
  const f = setup(); f.options.isCurrent.mockImplementation(() => { f.emit(); return true; });
  expect(() => f.emit()).not.toThrow(); await Promise.resolve();
  expect(f.options.exchange).not.toHaveBeenCalled(); expect(f.host.call).not.toHaveBeenCalled();
  expect(f.options.unavailable).toHaveBeenCalledOnce();
});
it("revokes the original continuation assertion after the channel deadline", async () => {
  vi.useFakeTimers(); let original!: () => void; const work = deferred<never>();
  const f = setup({ exchange: (_request, assertCurrent) => { original = assertCurrent; return work.promise; } });
  f.emit(); await vi.advanceTimersByTimeAsync(25000);
  expect(() => original()).toThrow("HANDOFF_OWNER_CHANGED"); work.reject(new Error("late")); await vi.runAllTimersAsync();
  expect(f.host.call).not.toHaveBeenCalled();
});

function followingNotification() {
  const next = structuredClone(fixture.notification);
  next.request = { ...next.request, operation: "inspect", holdId: fixture.success.outcome.report.holdId,
    exchangeId: "55555555-5555-4555-8555-555555555555" };
  return next;
}
async function awaitingAcknowledgement() {
  vi.useFakeTimers();
  const f = setup(), ack = deferred<unknown>();
  f.options.exchange.mockImplementation(async notification => ({ ...fixture.success.outcome.report,
    exchangeId: notification.request.exchangeId }));
  f.host.call.mockImplementationOnce(() => ack.promise as Promise<never>);
  f.emit(); await vi.advanceTimersByTimeAsync(0);
  expect(f.host.call).toHaveBeenCalledOnce();
  return { ...f, ack, next: followingNotification() };
}

describe("notifications preceding the previous completion acknowledgement", () => {
  it("holds one immutable next notification until ACK, then continues through the original coordinator", async () => {
    const f = await awaitingAcknowledgement();
    const expected = structuredClone(f.next);
    f.emit(f.next);
    f.next.request.sourceEpoch = "66666666-6666-4666-8666-666666666666";
    expect(f.options.exchange).toHaveBeenCalledOnce();
    expect(f.options.unavailable).not.toHaveBeenCalled();
    f.ack.resolve(fixture.ack); await vi.advanceTimersByTimeAsync(0);
    expect(f.options.exchange).toHaveBeenCalledTimes(2);
    expect(f.options.exchange.mock.calls[1]?.[0]).toEqual(expected);
    expect(f.host.call).toHaveBeenCalledTimes(2);
    expect(f.host.call.mock.calls[1]?.[1]).toMatchObject({ request: expected.request });
    expect(f.options.unavailable).not.toHaveBeenCalled();
    f.channel.dispose();
  });

  for (const reason of ["bad-ack", "rejected-ack", "timeout", "generation", "current", "exit", "dispose",
    "overflow", "duplicate", "queued-duplicate", "malformed", "profile", "epoch", "reentry"] as const) {
    it(`discards a waiting notification after ${reason} without another coordinator effect`, async () => {
      const f = await awaitingAcknowledgement();
      if (reason === "duplicate") f.next.request.exchangeId = fixture.notification.request.exchangeId;
      if (reason === "malformed") f.next.extra = true;
      if (reason === "profile") f.next.profileId = "b".repeat(64);
      if (reason === "epoch") f.next.request.sourceEpoch = "66666666-6666-4666-8666-666666666666";
      if (reason === "reentry") f.options.isCurrent.mockImplementationOnce(() => { f.emit(f.next); return true; });
      f.emit(f.next);
      if (reason === "overflow") f.emit({ ...f.next, request: { ...f.next.request, exchangeId: "77777777-7777-4777-8777-777777777777" } });
      if (reason === "queued-duplicate") f.emit(f.next);
      if (reason === "generation") f.host.generation = "replacement";
      if (reason === "current") f.options.isCurrent.mockReturnValue(false);
      if (reason === "exit") for (const handler of f.exits) handler();
      if (reason === "dispose") f.channel.dispose();
      if (reason === "timeout") await vi.advanceTimersByTimeAsync(2500);
      if (reason === "rejected-ack") f.ack.reject(new Error("late acknowledgement failure"));
      else f.ack.resolve(reason === "bad-ack" ? { ...fixture.ack, accepted: false } : fixture.ack);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.options.exchange).toHaveBeenCalledOnce();
      expect(f.host.call).toHaveBeenCalledOnce();
      expect(f.options.unavailable).toHaveBeenCalledOnce();
      expect(f.handlers.size + f.exits.size).toBe(0);
    });
  }

  it("refuses another notification while the coordinator itself is still running", async () => {
    vi.useFakeTimers(); const work = deferred<typeof fixture.success.outcome.report>();
    const f = setup({ exchange: () => work.promise });
    f.emit(); f.emit(followingNotification());
    work.resolve(fixture.success.outcome.report); await vi.advanceTimersByTimeAsync(0);
    expect(f.host.call).not.toHaveBeenCalled();
    expect(f.options.unavailable).toHaveBeenCalledOnce();
  });

  it("charges acknowledgement waiting time to the next notification deadline", async () => {
    const f = await awaitingAcknowledgement(), work = deferred<typeof fixture.success.outcome.report>();
    f.emit(f.next); await vi.advanceTimersByTimeAsync(2000);
    f.options.exchange.mockImplementationOnce(() => work.promise);
    f.ack.resolve(fixture.ack); await vi.advanceTimersByTimeAsync(0);
    expect(f.options.exchange).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(22999);
    expect(f.options.unavailable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.options.unavailable).toHaveBeenCalledOnce();
    work.reject(new Error("late next operation")); await vi.advanceTimersByTimeAsync(0);
    expect(f.host.call).toHaveBeenCalledOnce();
  });
});
