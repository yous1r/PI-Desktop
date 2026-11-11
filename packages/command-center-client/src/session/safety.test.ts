import { describe, expect, it, vi } from "vitest";
import { parseCommandCenterTaskSummary } from "@pi-desktop/shared";
import golden from "../../../shared/test/fixtures/command-center-summary.json";
import { bindCommandCenterObservationOwner, createCommandCenterObservationContext, invalidateCommandCenterObservationContext } from "../context.js";
import { createCommandCenterMonitorSession, type CommandCenterMonitorSession, type CommandCenterMonitorSessionOptions } from "./index.js";

const reply = { ok: true, serverTime: "2026-11-11T00:00:00.000Z" };

function context() {
  const value = createCommandCenterObservationContext();
  bindCommandCenterObservationOwner(value, { hostId: "session", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14" });
  return value;
}

function page(ids = ["main"]) {
  return {
    version: 1, cursor: { epoch: "monitor", sequence: 42 }, generatedAt: golden.snapshot.generatedAt,
    rows: ids.map((id) => parseCommandCenterTaskSummary({
      ...structuredClone(golden.snapshot.rows[0]), target: { kind: "session", sessionId: id },
      execution: { kind: "session", sessionId: id, turnId: "turn" },
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function options(): CommandCenterMonitorSessionOptions {
  return { clock: { now: () => 0 }, scheduler: { schedule: () => () => {} }, loadPage: async () => page(), ping: async () => reply };
}

describe("monitor session safety edges", () => {
  it("requires a bound active context before constructing child resources", () => {
    const input = options();
    const loadPage = vi.fn(input.loadPage);
    const ping = vi.fn(input.ping);
    const schedule = vi.fn(input.scheduler.schedule);
    input.loadPage = loadPage;
    input.ping = ping;
    input.scheduler.schedule = schedule;
    expect(() => createCommandCenterMonitorSession(createCommandCenterObservationContext(), input)).toThrow("COMMAND_CENTER_CLIENT_CONTEXT_OWNER_REQUIRED");
    const scope = context();
    invalidateCommandCenterObservationContext(scope);
    expect(() => createCommandCenterMonitorSession(scope, input)).toThrow("COMMAND_CENTER_CLIENT_CONTEXT_INVALIDATED");
    expect(loadPage).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it.each([
    { reader: { maxRows: 0 } },
    { summary: { maxRows: 0 } },
    { maxPendingPings: 3 },
  ])("rejects invalid child limits and cleans partially constructed children: %j", (limits) => {
    const input = { ...options(), limits } as CommandCenterMonitorSessionOptions;
    const scope = context();
    expect(() => createCommandCenterMonitorSession(scope, input)).toThrow();
    // Invalid construction leaves the context usable and its revocation cleanup safe.
    const valid = createCommandCenterMonitorSession(scope, options());
    invalidateCommandCenterObservationContext(scope);
    expect(valid.getState().status).toBe("invalidated");
  });

  it("keeps copied limits for summaries recreated after publication", async () => {
    const limits = { summary: { maxRows: 1 } };
    const session = createCommandCenterMonitorSession(context(), { ...options(), loadPage: async () => page(["one", "two"]), limits });
    limits.summary.maxRows = 100;
    session.connect();
    expect(await session.refresh()).toEqual({ kind: "failed", reason: "summary_rejected" });
    expect(session.getState()).toMatchObject({ summary: null, summaryReady: false, fresh: false, health: { resynchronized: false } });
    session.dispose();
  });

  it("does not overwrite a nested resume cycle with the token returned by an older connect", async () => {
    let session: CommandCenterMonitorSession;
    let calls = 0;
    const older = deferred<unknown>();
    const current = deferred<unknown>();
    session = createCommandCenterMonitorSession(context(), {
      ...options(),
      ping() {
        calls += 1;
        if (calls === 1) { session.resume(); return older.promise; }
        return current.promise;
      },
    });
    session.connect();
    current.resolve(reply);
    await current.promise;
    expect(await session.refresh()).toMatchObject({ kind: "published" });
    expect(session.getState().fresh).toBe(true);
    session.dispose();
    older.resolve(reply);
    await older.promise;
  });

  it("clears the composed state if scope revocation occurs during health completion", async () => {
    const scope = context();
    let revoke = false;
    const ping = deferred<unknown>();
    const session = createCommandCenterMonitorSession(scope, {
      ...options(), ping: () => ping.promise,
      clock: { now() { if (revoke) invalidateCommandCenterObservationContext(scope); return 0; } },
    });
    session.connect();
    ping.resolve(reply);
    await ping.promise;
    revoke = true;
    expect(await session.refresh()).toEqual({ kind: "cancelled", reason: "context_invalidated" });
    expect(session.getState()).toMatchObject({ status: "invalidated", monitor: { projection: null }, summary: { projection: null }, fresh: false });
  });

  it("normalizes scope closure even when a reader abort callback reads state before other context listeners", async () => {
    const scope = context();
    const pending = deferred<unknown>();
    let session: CommandCenterMonitorSession;
    let observed: ReturnType<CommandCenterMonitorSession["getState"]> | undefined;
    session = createCommandCenterMonitorSession(scope, {
      ...options(),
      loadPage(_token, signal) {
        signal.addEventListener("abort", () => { observed = session.getState(); }, { once: true });
        return pending.promise;
      },
    });
    session.connect();
    const refresh = session.refresh();
    invalidateCommandCenterObservationContext(scope);
    expect(await refresh).toEqual({ kind: "cancelled", reason: "context_invalidated" });
    expect(observed).toMatchObject({ status: "invalidated", health: { status: "invalidated" }, monitor: { status: "invalidated", projection: null }, summary: { status: "invalidated", projection: null } });
    expect(session.getState()).toBe(observed);
    pending.resolve(page());
    await pending.promise;
    expect(session.getState()).toBe(observed);
  });

  it("handles disposal reentered from the injected page adapter without late publication", async () => {
    let session: CommandCenterMonitorSession;
    session = createCommandCenterMonitorSession(context(), {
      ...options(), loadPage() { session.dispose(); return Promise.resolve(page()); },
    });
    expect(await session.refresh()).toEqual({ kind: "cancelled", reason: "disposed" });
    expect(session.getState()).toMatchObject({ status: "disposed", monitor: { projection: null }, summary: { projection: null } });
  });
});
