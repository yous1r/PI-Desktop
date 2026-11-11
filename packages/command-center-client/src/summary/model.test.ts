import { describe, expect, it } from "vitest";
import { commandCenterCanonicalJson, parseCommandCenterTaskSummary, type CommandCenterTaskSummary } from "@pi-desktop/shared";
import golden from "../../../shared/test/fixtures/command-center-summary.json";
import { bindCommandCenterObservationOwner, createCommandCenterObservationContext, invalidateCommandCenterObservationContext } from "../context.js";
import { createCommandCenterMonitorSummary } from "./index.js";

function context() {
  const value = createCommandCenterObservationContext();
  bindCommandCenterObservationOwner(value, { hostId: "summary-host", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14" });
  return value;
}

function row(sessionId = "main"): CommandCenterTaskSummary {
  return parseCommandCenterTaskSummary({
    ...structuredClone(golden.snapshot.rows[0]),
    target: { kind: "session", sessionId },
    execution: { kind: "session", sessionId, turnId: `turn-${sessionId}` },
  });
}

function initial(rows: CommandCenterTaskSummary[] = [row()]) {
  return { cursor: { epoch: "monitor", sequence: 42 }, generatedAt: golden.snapshot.generatedAt, rows };
}

function upsert(sequence: number, value = row(), epoch = "monitor") {
  return { version: 1, epoch, sequence, type: "upsert", row: value };
}

function remove(sequence: number, sessionId = "main", epoch = "monitor") {
  return { version: 1, epoch, sequence, type: "remove", target: { kind: "session", sessionId } };
}

describe("public live monitor summary", () => {
  it("applies consecutive update, insertion and removal after the snapshot cut", () => {
    const model = createCommandCenterMonitorSummary(context(), initial());
    expect(model.getState()).toMatchObject({ status: "ready", projection: initial() });
    const updated = row();
    updated.activity = "Waiting for approval";
    updated.status = "waiting_human";
    updated.pendingApprovals = 1;
    updated.desiredGoalRevision = 6;
    expect(model.apply(upsert(43, updated))).toBe("applied");
    expect(model.getState().projection?.rows[0]).toMatchObject({
      status: "waiting_human", pendingApprovals: 1, desiredGoalRevision: 6, effectiveGoalRevision: 4,
    });
    expect(model.apply(upsert(44, row("child")))).toBe("applied");
    expect(model.getState().projection?.rows).toHaveLength(2);
    expect(model.apply(remove(45))).toBe("applied");
    expect(model.getState()).toMatchObject({ status: "ready", projection: {
      cursor: { epoch: "monitor", sequence: 45 }, generatedAt: golden.snapshot.generatedAt, rows: [row("child")],
    } });
    const beforeRemoveUnknown = model.getState().projection?.rows;
    expect(model.apply(remove(46, "missing"))).toBe("applied");
    expect(model.getState().projection?.cursor.sequence).toBe(46);
    expect(model.getState().projection?.rows).toEqual(beforeRemoveUnknown);
    model.dispose();
  });

  it("supports complete projections beyond the C1 page row limit", () => {
    const rows = Array.from({ length: 205 }, (_, index) => row(`task-${index}`));
    const model = createCommandCenterMonitorSummary(context(), initial(rows));
    expect(model.getState().projection?.rows).toHaveLength(205);
    expect(model.apply(remove(43, "task-102"))).toBe("applied");
    expect(model.getState().projection?.rows).toHaveLength(204);
    model.dispose();
  });

  it("keeps stable snapshot identity for repeated reads and valid duplicate/older changes", () => {
    const model = createCommandCenterMonitorSummary(context(), initial());
    const first = model.getState();
    expect(model.getState()).toBe(first);
    expect(model.apply(upsert(42, row("other")))).toBe("duplicate");
    expect(model.apply(remove(1))).toBe("duplicate");
    expect(model.apply({ version: 1, epoch: "monitor", sequence: 41, type: "resync" })).toBe("duplicate");
    expect(model.getState()).toBe(first);
    expect(model.apply(upsert(43, row("main")))).toBe("applied");
    const second = model.getState();
    expect(second).not.toBe(first);
    expect(model.apply(upsert(43, row("other")))).toBe("duplicate");
    expect(model.getState()).toBe(second);
    model.dispose();
  });

  it.each([
    { change: upsert(44), reason: "sequence_gap" },
    { change: upsert(1, row(), "replacement"), reason: "epoch_mismatch" },
    { change: { version: 1, epoch: "monitor", sequence: 43, type: "resync" }, reason: "source_resync" },
  ])("retains the consistent cut and requires resync for $reason", ({ change, reason }) => {
    const model = createCommandCenterMonitorSummary(context(), initial());
    const prior = model.getState().projection;
    expect(model.apply(change)).toEqual({ resync: reason });
    expect(model.getState()).toEqual({ status: "resync_required", projection: prior, reason });
    expect(model.getState().projection).toBe(prior);
    const stopped = model.getState();
    expect(model.apply(upsert(43))).toEqual({ resync: reason });
    expect(model.getState()).toBe(stopped);
    expect(model.apply({ invalid: true })).toEqual({ rejected: "invalid_change" });
    expect(model.getState()).toBe(stopped);
    model.dispose();
  });

  it("marks explicit resync without replay and recovers only through a new projection model", () => {
    const scope = context();
    const model = createCommandCenterMonitorSummary(scope, initial());
    const original = model.getState().projection;
    model.resync();
    expect(model.getState()).toEqual({ status: "resync_required", projection: original, reason: "requested" });
    const state = model.getState();
    model.resync();
    expect(model.getState()).toBe(state);
    expect(model.apply(upsert(43))).toEqual({ resync: "requested" });
    const replacement = createCommandCenterMonitorSummary(scope, { ...initial([row("new")]), cursor: { epoch: "next", sequence: 1 } });
    expect(replacement.getState().status).toBe("ready");
    model.dispose();
    replacement.dispose();
  });

  it("binds stable delegation keys independently of concrete execution generation", () => {
    const child = parseCommandCenterTaskSummary(structuredClone(golden.snapshot.rows[1]));
    const model = createCommandCenterMonitorSummary(context(), initial([child]));
    if (child.execution?.kind !== "delegation") throw new Error("Expected child execution");
    child.execution.executionGeneration += 1;
    expect(model.apply(upsert(43, child))).toBe("applied");
    expect(model.getState().projection?.rows).toHaveLength(1);
    expect(model.apply({ version: 1, epoch: "monitor", sequence: 44, type: "remove", target: child.target })).toBe("applied");
    expect(model.getState().projection?.rows).toEqual([]);
    model.dispose();
  });

  it("isolates caller mutations and deeply freezes returned cursor, rows and nested fields", () => {
    const snapshot = initial();
    const model = createCommandCenterMonitorSummary(context(), snapshot);
    const originalText = commandCenterCanonicalJson(model.getState());
    snapshot.cursor.sequence = 999;
    snapshot.rows[0].label = "Changed external input";
    snapshot.rows.push(row("new"));
    expect(commandCenterCanonicalJson(model.getState())).toBe(originalText);
    const change = upsert(43, row("next"));
    expect(model.apply(change)).toBe("applied");
    change.row.label = "Changed input";
    change.row.usage!.inputTokens = 0;
    const state = model.getState();
    if (state.projection === null) throw new Error("Expected projection");
    expect(state.projection.rows[1]).toMatchObject({ label: golden.snapshot.rows[0].label, usage: { inputTokens: 4200 } });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.projection)).toBe(true);
    expect(Object.isFrozen(state.projection.rows)).toBe(true);
    expect(Reflect.set(state.projection.cursor, "sequence", 100)).toBe(false);
    expect(Reflect.set(state.projection.rows[1].target, "sessionId", "changed")).toBe(false);
    expect(Reflect.set(state.projection.rows[1].usage!, "inputTokens", 0)).toBe(false);
    model.dispose();
  });

  it.each(["revoke", "dispose"])("clears retained server data and rejects later changes on %s", (action) => {
    const scope = context();
    const model = createCommandCenterMonitorSummary(scope, initial());
    model.apply(upsert(43, row("next")));
    if (action === "revoke") invalidateCommandCenterObservationContext(scope);
    else model.dispose();
    const status = action === "revoke" ? "invalidated" : "disposed";
    const rejected = action === "revoke" ? "context_invalidated" : "disposed";
    const final = model.getState();
    expect(final).toEqual({ status, projection: null });
    expect(model.apply(upsert(44))).toEqual({ rejected });
    model.resync();
    model.dispose();
    expect(model.getState()).toBe(final);
  });

  it("rechecks context after validation accessors revoke it", () => {
    const scope = context();
    const model = createCommandCenterMonitorSummary(scope, initial());
    const change = {
      ...upsert(43),
      get row() { invalidateCommandCenterObservationContext(scope); return row(); },
    };
    expect(model.apply(change)).toEqual({ rejected: "context_invalidated" });
    expect(model.getState()).toEqual({ status: "invalidated", projection: null });
  });

  it("does not override a reentrant valid change while an earlier input is being parsed", () => {
    const model = createCommandCenterMonitorSummary(context(), initial());
    const outer = {
      ...upsert(43, row("outer")),
      get row() { expect(model.apply(upsert(43, row("nested")))).toBe("applied"); return row("outer"); },
    };
    expect(model.apply(outer)).toEqual({ rejected: "state_changed" });
    expect(model.getState().projection?.rows.map((value) => value.target)).toEqual([
      { kind: "session", sessionId: "main" }, { kind: "session", sessionId: "nested" },
    ]);
    expect(model.getState().projection?.cursor.sequence).toBe(43);
    model.dispose();
  });

  it("rejects constructor use of unbound, revoked, or reentrantly revoked contexts", () => {
    const unbound = createCommandCenterObservationContext();
    expect(() => createCommandCenterMonitorSummary(unbound, initial())).toThrow("COMMAND_CENTER_CLIENT_CONTEXT_OWNER_REQUIRED");
    const scope = context();
    invalidateCommandCenterObservationContext(scope);
    expect(() => createCommandCenterMonitorSummary(scope, initial())).toThrow("COMMAND_CENTER_CLIENT_CONTEXT_INVALIDATED");
    const another = context();
    expect(() => createCommandCenterMonitorSummary(another, {
      ...initial(),
      get rows() { invalidateCommandCenterObservationContext(another); return [row()]; },
    })).toThrow("COMMAND_CENTER_CLIENT_CONTEXT_INVALIDATED");
  });
});
