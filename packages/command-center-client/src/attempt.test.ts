import { afterEach, describe, expect, it, vi } from "vitest";
import control from "../../shared/test/fixtures/command-center-control.json";
import {
  createCommandCenterInterventionAttempt,
  createCommandCenterObservationContext,
  invalidateCommandCenterObservationContext,
  type CommandCenterInterventionAttempt,
  type CommandCenterObservationContext,
} from "./index.js";

function active(attempt: CommandCenterInterventionAttempt) {
  const state = attempt.getState();
  expect(state.kind).toBe("active");
  if (state.kind !== "active") throw new Error("Expected active model");
  return state;
}

async function setup(input: unknown = control.request) {
  const context = createCommandCenterObservationContext();
  const attempt = await createCommandCenterInterventionAttempt(context, input);
  return { context, attempt };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("public intervention attempt observation", () => {
  it("follows create, accepted, disconnect, receipt recovery and late old receipt without replay", async () => {
    const { context, attempt } = await setup();
    expect(active(attempt)).toMatchObject({
      request: control.request, fingerprint: control.fingerprint,
      receipt: null, observation: "awaiting_receipt", settled: false,
    });
    expect(attempt.observeReceipt(context, control.receipts.accepted)).toEqual({ kind: "applied" });
    const accepted = active(attempt);
    expect(accepted.receipt).toMatchObject({ status: "accepted", desiredGoalRevision: 5, effectiveGoalRevision: 4 });
    expect(accepted.settled).toBe(false);

    expect(attempt.markDisconnected(context)).toEqual({ kind: "applied" });
    expect(active(attempt)).toMatchObject({ observation: "outcome_unknown", receipt: control.receipts.accepted });
    expect(accepted.observation).toBe("current");
    expect(attempt.observeReceipt(context, control.receipts.completed)).toEqual({ kind: "applied" });
    const completed = active(attempt);
    expect(completed).toMatchObject({ observation: "current", receipt: control.receipts.completed, settled: true });
    expect(attempt.observeReceipt(context, control.receipts.accepted)).toEqual({ kind: "ignored_stale" });
    expect(attempt.getState()).toBe(completed);
    expect(completed.request).toBe(accepted.request);
    expect(completed.fingerprint).toBe(control.fingerprint);
    // Reconnection is observation only: no dispatch or retry API exists.
    attempt.markDisconnected(context);
    expect(attempt.getState()).toBe(completed);
    attempt.dispose();
  });

  it("resolves response loss with the identical authoritative receipt at the same revision", async () => {
    const { context, attempt } = await setup();
    attempt.markDisconnected(context);
    expect(active(attempt)).toMatchObject({ receipt: null, observation: "outcome_unknown", settled: false });
    attempt.observeReceipt(context, control.receipt);
    attempt.markDisconnected(context);
    const reordered = { ...control.receipt, target: { ...control.receipt.target } };
    expect(attempt.observeReceipt(context, reordered)).toEqual({ kind: "duplicate" });
    expect(active(attempt)).toMatchObject({ observation: "current", receipt: control.receipt });
    attempt.dispose();
  });

  it("accepts missing legal intermediate observations but rejects backwards status and goal movement", async () => {
    const { context, attempt } = await setup();
    attempt.observeReceipt(context, control.receipt);
    expect(attempt.observeReceipt(context, control.receipts.consumed)).toEqual({ kind: "applied" });
    const state = attempt.getState();
    expect(attempt.observeReceipt(context, { ...control.receipts.accepted, revision: 4, effectiveGoalRevision: 5 }))
      .toEqual({ kind: "rejected", reason: "invalid_progression" });
    expect(attempt.observeReceipt(context, { ...control.receipts.completed, effectiveGoalRevision: 4 }))
      .toEqual({ kind: "rejected", reason: "goal_revision_regression" });
    expect(attempt.observeReceipt(context, { ...control.receipts.completed, desiredGoalRevision: 4, effectiveGoalRevision: 4 }))
      .toEqual({ kind: "rejected", reason: "goal_revision_regression" });
    expect(attempt.getState()).toBe(state);
    attempt.dispose();
  });

  it.each([
    { status: "accepted" },
    { desiredGoalRevision: 6 },
    { effectiveGoalRevision: 5 },
  ])("rejects inconsistent equal revisions: %j", async (change) => {
    const { context, attempt } = await setup();
    attempt.observeReceipt(context, control.receipt);
    const state = attempt.getState();
    expect(attempt.observeReceipt(context, { ...control.receipt, ...change }))
      .toEqual({ kind: "rejected", reason: "inconsistent_revision" });
    expect(attempt.getState()).toBe(state);
    attempt.dispose();
  });

  it.each(["completed", "rejected", "conflicted", "interrupted"])("treats %s as settled and never reopens it", async (status) => {
    const { context, attempt } = await setup();
    const receipt = {
      ...control.receipt, status,
      ...(status === "rejected" || status === "conflicted" ? { error: { code: "CONFLICT", message: "Unavailable target" } } : {}),
    };
    expect(attempt.observeReceipt(context, receipt)).toEqual({ kind: "applied" });
    expect(active(attempt).settled).toBe(true);
    const state = attempt.getState();
    expect(attempt.observeReceipt(context, { ...control.receipts.accepted, revision: 10 }))
      .toEqual({ kind: "rejected", reason: "invalid_progression" });
    expect(attempt.observeReceipt(context, { ...receipt, revision: 2 }))
      .toEqual({ kind: "rejected", reason: "invalid_progression" });
    attempt.markDisconnected(context);
    expect(attempt.getState()).toBe(state);
    attempt.dispose();
  });

  it.each(["recorded", "accepted", "consumed", "outcome_unknown"])("does not classify %s as settled", async (status) => {
    const { context, attempt } = await setup();
    expect(attempt.observeReceipt(context, { ...control.receipt, status })).toEqual({ kind: "applied" });
    expect(active(attempt).settled).toBe(false);
    attempt.dispose();
  });

  it("keeps authoritative outcome_unknown unresolved and absorbing under committed C1", async () => {
    const { context, attempt } = await setup();
    attempt.observeReceipt(context, control.receipts.accepted);
    const unknown = { ...control.receipts.accepted, status: "outcome_unknown", revision: 3 };
    expect(attempt.observeReceipt(context, unknown)).toEqual({ kind: "applied" });
    expect(active(attempt)).toMatchObject({ observation: "current", settled: false, receipt: unknown });
    attempt.markDisconnected(context);
    expect(attempt.observeReceipt(context, control.receipts.completed))
      .toEqual({ kind: "rejected", reason: "invalid_progression" });
    expect(attempt.observeReceipt(context, unknown)).toEqual({ kind: "duplicate" });
    expect(active(attempt)).toMatchObject({ observation: "current", settled: false, receipt: unknown });
    attempt.dispose();
  });

  it("waits for actual Stop completion, keeps goal revisions distinct, and rejects Stop consumption", async () => {
    const { context, attempt } = await setup(control.stopRequest);
    expect(active(attempt).fingerprint).toBe(control.stopFingerprint);
    attempt.observeReceipt(context, control.stopReceipt);
    expect(active(attempt)).toMatchObject({ settled: false, receipt: { desiredGoalRevision: 5, effectiveGoalRevision: 4 } });
    expect(attempt.observeReceipt(context, { ...control.stopReceipt, status: "consumed", revision: 3 }))
      .toEqual({ kind: "rejected", reason: "invalid_receipt" });
    expect(attempt.observeReceipt(context, { ...control.stopReceipt, status: "completed", revision: 3 }))
      .toEqual({ kind: "applied" });
    expect(active(attempt).settled).toBe(true);
    expect(active(attempt).request).not.toHaveProperty("expectedGoalRevision");
    attempt.dispose();
  });

  it("invalidates old async observations and leaves a replacement context isolated", async () => {
    const { context, attempt } = await setup();
    attempt.observeReceipt(context, control.receipts.accepted);
    let resolveReceipt!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { resolveReceipt = resolve; });
    const observation = pending.then((receipt) => attempt.observeReceipt(context, receipt));
    invalidateCommandCenterObservationContext(context);
    const replacement = await setup();
    resolveReceipt(control.receipts.completed);
    expect(await observation).toEqual({ kind: "rejected", reason: "context_invalidated" });
    expect(attempt.getState()).toEqual({ kind: "invalidated" });
    expect(active(replacement.attempt).receipt).toBeNull();
    expect(replacement.attempt.observeReceipt(context, control.receipts.completed))
      .toEqual({ kind: "rejected", reason: "invalid_context" });
    await expect(createCommandCenterInterventionAttempt(context, control.request))
      .rejects.toThrow("COMMAND_CENTER_CLIENT_CONTEXT_INVALIDATED");
    invalidateCommandCenterObservationContext(context);
    replacement.attempt.dispose();
  });

  it("rejects a different or forged context, including local disconnect observations", async () => {
    const { context, attempt } = await setup();
    const wrong = createCommandCenterObservationContext();
    const forged = {} as CommandCenterObservationContext;
    for (const other of [wrong, forged]) {
      expect(attempt.observeReceipt(other, control.receipt)).toEqual({ kind: "rejected", reason: "invalid_context" });
      expect(attempt.markDisconnected(other)).toEqual({ kind: "rejected", reason: "invalid_context" });
    }
    await expect(createCommandCenterInterventionAttempt(forged, control.request))
      .rejects.toThrow("COMMAND_CENTER_CLIENT_INVALID_CONTEXT");
    expect(() => invalidateCommandCenterObservationContext(forged)).toThrow("COMMAND_CENTER_CLIENT_INVALID_CONTEXT");
    expect(active(attempt).receipt).toBeNull();
    attempt.dispose();
    attempt.dispose();
    expect(attempt.markDisconnected(context)).toEqual({ kind: "rejected", reason: "context_invalidated" });
    expect(attempt.observeReceipt(context, control.receipt)).toEqual({ kind: "rejected", reason: "context_invalidated" });
  });

  it("clears every model owned by a revoked scope without affecting another scope", async () => {
    const context = createCommandCenterObservationContext();
    const first = await createCommandCenterInterventionAttempt(context, control.request);
    const second = await createCommandCenterInterventionAttempt(context, control.stopRequest);
    const other = await setup();
    first.observeReceipt(context, control.receipt);
    second.observeReceipt(context, control.stopReceipt);
    invalidateCommandCenterObservationContext(context);
    expect(first.getState()).toEqual({ kind: "invalidated" });
    expect(second.getState()).toEqual({ kind: "invalidated" });
    expect(active(other.attempt).receipt).toBeNull();
    other.attempt.dispose();
  });
});
