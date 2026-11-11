import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_CENTER_MAX_RECEIPT_BYTES, commandCenterCanonicalPayload } from "@pi-desktop/shared";
import control from "../../shared/test/fixtures/command-center-control.json";
import identities from "../../shared/test/fixtures/command-center-identities.json";
import {
  createCommandCenterInterventionAttempt,
  createCommandCenterObservationContext,
  invalidateCommandCenterObservationContext,
} from "./index.js";

async function setup(input: unknown = control.request) {
  const context = createCommandCenterObservationContext();
  const attempt = await createCommandCenterInterventionAttempt(context, input);
  return { context, attempt };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("public intervention input and snapshot safety", () => {
  it("captures all request fields before asynchronous hashing and freezes returned nested state", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(control.canonicalPayload));
    let resolveDigest!: (value: ArrayBuffer) => void;
    vi.spyOn(crypto.subtle, "digest").mockReturnValueOnce(new Promise((resolve) => { resolveDigest = resolve; }));
    const request = structuredClone(control.request);
    const context = createCommandCenterObservationContext();
    const pending = createCommandCenterInterventionAttempt(context, request);
    request.requestId = control.stopRequest.requestId;
    request.expectedHostEpoch = control.stopRequest.requestId;
    request.target.executionGeneration = 99;
    request.intent.constraints.push("Changed while hashing");
    resolveDigest(digest);
    const attempt = await pending;
    const state = attempt.getState();
    if (state.kind !== "active") throw new Error("Expected active model");
    expect(state.request).toEqual(control.request);
    expect(state.fingerprint).toBe(control.fingerprint);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.request)).toBe(true);
    expect(Object.isFrozen(state.request.target)).toBe(true);
    expect(Object.isFrozen(state.request.intent)).toBe(true);
    expect(Reflect.set(state.request, "requestId", control.stopRequest.requestId)).toBe(false);
    expect(Reflect.set(state.request.target, "executionGeneration", 99)).toBe(false);
    if (state.request.intent.kind !== "reviseGoal") throw new Error("Expected goal request");
    expect(Object.isFrozen(state.request.intent.constraints)).toBe(true);
    expect(Reflect.set(state.request.intent.constraints, "0", "Changed snapshot")).toBe(false);
    expect(attempt.observeReceipt(context, control.receipt)).toEqual({ kind: "applied" });
    expect(state.receipt).toBeNull();
    attempt.dispose();
  });

  it("rejects a context revoked while hashing and never creates a model in the replacement scope", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(control.canonicalPayload));
    let resolveDigest!: (value: ArrayBuffer) => void;
    vi.spyOn(crypto.subtle, "digest").mockReturnValueOnce(new Promise((resolve) => { resolveDigest = resolve; }));
    const context = createCommandCenterObservationContext();
    const pending = createCommandCenterInterventionAttempt(context, control.request);
    invalidateCommandCenterObservationContext(context);
    resolveDigest(digest);
    await expect(pending).rejects.toThrow("COMMAND_CENTER_CLIENT_CONTEXT_INVALIDATED");
    const replacement = await setup();
    expect(replacement.attempt.getState()).toMatchObject({ kind: "active", receipt: null });
    replacement.attempt.dispose();
  });

  it.each([
    { hostId: "other-host" },
    { expectedHostEpoch: control.stopRequest.requestId },
  ])("pins one owner before concurrent creation can borrow its context: %j", async (change) => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(control.canonicalPayload));
    let resolveDigest!: (value: ArrayBuffer) => void;
    vi.spyOn(crypto.subtle, "digest").mockReturnValueOnce(new Promise((resolve) => { resolveDigest = resolve; }));
    const context = createCommandCenterObservationContext();
    const first = createCommandCenterInterventionAttempt(context, control.request);
    await expect(createCommandCenterInterventionAttempt(context, { ...control.request, ...change }))
      .rejects.toThrow("COMMAND_CENTER_CLIENT_CONTEXT_OWNER_MISMATCH");
    const sameOwner = await createCommandCenterInterventionAttempt(context, control.stopRequest);
    expect(sameOwner.getState()).toMatchObject({ fingerprint: control.stopFingerprint });
    resolveDigest(digest);
    const original = await first;
    expect(original.getState()).toMatchObject({ fingerprint: control.fingerprint });
    invalidateCommandCenterObservationContext(context);
    expect(original.getState()).toEqual({ kind: "invalidated" });
    expect(sameOwner.getState()).toEqual({ kind: "invalidated" });
  });

  it("retains the first owner fence after hashing fails, but does not bind an invalid request", async () => {
    const context = createCommandCenterObservationContext();
    await expect(createCommandCenterInterventionAttempt(context, { ...control.request, hostId: "invalid/host" }))
      .rejects.toThrow("COMMAND_CENTER_INVALID_REQUEST");
    vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("Hash unavailable"));
    await expect(createCommandCenterInterventionAttempt(context, control.request)).rejects.toThrow("Hash unavailable");
    await expect(createCommandCenterInterventionAttempt(context, { ...control.request, hostId: "other-host" }))
      .rejects.toThrow("COMMAND_CENTER_CLIENT_CONTEXT_OWNER_MISMATCH");
    const attempt = await createCommandCenterInterventionAttempt(context, control.request);
    expect(attempt.getState()).toMatchObject({ fingerprint: control.fingerprint });
    attempt.dispose();
  });

  it("copies receipt inputs and freezes nested error/target values returned to callers", async () => {
    const { context, attempt } = await setup();
    const receipt = structuredClone(control.receipts.conflicted);
    attempt.observeReceipt(context, receipt);
    receipt.error.message = "Changed input";
    receipt.target.executionGeneration = 99;
    const state = attempt.getState();
    if (state.kind !== "active" || !state.receipt?.error) throw new Error("Expected conflicted receipt");
    expect(state.receipt).toEqual(control.receipts.conflicted);
    expect(Reflect.set(state.receipt, "status", "accepted")).toBe(false);
    expect(Reflect.set(state.receipt.error, "message", "Changed output")).toBe(false);
    expect(Reflect.set(state.receipt.target, "executionGeneration", 99)).toBe(false);
    expect(attempt.getState()).toBe(state);
    attempt.dispose();
  });

  it.each([
    { fingerprint: "0".repeat(64) },
    { requestId: control.stopRequest.requestId },
    { operation: "steer" },
    { target: control.targets.replacementExecution },
    { target: { ...control.targets.execution, executionGeneration: 3 } },
    { target: { ...control.targets.execution, parentTurnId: "other-turn" } },
    { target: { ...control.targets.execution, parentSessionId: "other-session" } },
    { target: { ...control.targets.execution, delegationId: "other-child" } },
  ])("rejects misbound receipts even when their revision is older: %j", async (change) => {
    const { context, attempt } = await setup();
    attempt.observeReceipt(context, control.receipts.accepted);
    const before = attempt.getState();
    expect(attempt.observeReceipt(context, { ...control.receipt, ...change })).toEqual({
      kind: "rejected", reason: "fingerprint" in change ? "fingerprint_mismatch" : "request_mismatch",
    });
    expect(attempt.getState()).toBe(before);
    attempt.dispose();
  });

  it.each([
    { hostId: "other-host" },
    { expectedHostEpoch: control.stopRequest.requestId },
    { commandWorkspaceId: control.stopRequest.requestId },
    { expectedMembershipRevision: 8 },
    { expectedGoalRevision: 5 },
    { intent: { kind: "reviseGoal", objective: "Different", constraints: [] } },
  ])("binds request fences and payload through the fingerprint: %j", async (change) => {
    const original = await setup();
    const other = await setup({ ...control.request, ...change });
    const state = other.attempt.getState();
    if (state.kind !== "active") throw new Error("Expected active model");
    expect(state.fingerprint).not.toBe(control.fingerprint);
    expect(original.attempt.observeReceipt(original.context, { ...control.receipt, fingerprint: state.fingerprint }))
      .toEqual({ kind: "rejected", reason: "fingerprint_mismatch" });
    original.attempt.dispose();
    other.attempt.dispose();
  });

  it("keeps canonical session tuple boundaries and exact turn binding", async () => {
    const first = identities.executions[0].target;
    const { context, attempt } = await setup({ ...control.request, target: first });
    const state = attempt.getState();
    if (state.kind !== "active") throw new Error("Expected active model");
    const receipt = { ...control.receipt, target: first, fingerprint: state.fingerprint };
    expect(attempt.observeReceipt(context, { ...receipt, target: identities.executions[1].target }))
      .toEqual({ kind: "rejected", reason: "request_mismatch" });
    expect(attempt.observeReceipt(context, receipt)).toEqual({ kind: "applied" });
    attempt.dispose();
  });

  it.each([
    null,
    { ...control.receipt, principal: "owner" },
    { ...control.receipt, revision: 0 },
    { ...control.receipt, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...control.receipt, effectiveGoalRevision: 6 },
    { ...control.receipt, status: "rejected" },
    { ...control.receipt, fingerprint: "xyz" },
    { ...control.receipt, extra: "x".repeat(COMMAND_CENTER_MAX_RECEIPT_BYTES + 1) },
    { ...control.receipt, status: "rejected", error: { code: "CONFLICT", message: "界".repeat(COMMAND_CENTER_MAX_RECEIPT_BYTES) } },
  ])("rejects malformed or oversized receipts without changing state (%#)", async (input) => {
    const { context, attempt } = await setup();
    const state = attempt.getState();
    expect(attempt.observeReceipt(context, input)).toEqual({ kind: "rejected", reason: "invalid_receipt" });
    expect(attempt.getState()).toBe(state);
    attempt.dispose();
  });

  it.each([
    { ...control.request, role: "owner" },
    { ...control.request, target: control.targets.task },
    { ...control.stopRequest, expectedGoalRevision: 4 },
    { ...control.request, intent: { kind: "steer", text: " " } },
    { ...control.request, intent: { kind: "steer", text: "x".repeat(256 * 1024) } },
  ])("uses strict C1 request parsing at creation (%#)", async (input) => {
    await expect(createCommandCenterInterventionAttempt(createCommandCenterObservationContext(), input))
      .rejects.toThrow("COMMAND_CENTER_INVALID_REQUEST");
  });

  it("rechecks revocation triggered while reading an external receipt", async () => {
    const { context, attempt } = await setup();
    const receipt = {
      ...control.receipt,
      get target() {
        invalidateCommandCenterObservationContext(context);
        return control.receipt.target;
      },
    };
    expect(attempt.observeReceipt(context, receipt)).toEqual({ kind: "rejected", reason: "context_invalidated" });
    expect(attempt.getState()).toEqual({ kind: "invalidated" });
  });

  it.each(["append", "steer"])("observes the existing C1 %s intent without a transport", async (kind) => {
    const { context, attempt } = await setup({ ...control.request, intent: { kind, text: "Apply this correction" } });
    const state = attempt.getState();
    if (state.kind !== "active") throw new Error("Expected active model");
    expect(attempt.observeReceipt(context, { ...control.receipt, operation: kind, fingerprint: state.fingerprint }))
      .toEqual({ kind: "applied" });
    attempt.dispose();
  });

  it("keeps the golden canonical encoding independently of request key order", async () => {
    const request = Object.fromEntries(Object.entries(control.request).reverse());
    expect(commandCenterCanonicalPayload(request)).toBe(control.canonicalPayload);
    const { attempt } = await setup(request);
    expect(attempt.getState()).toMatchObject({ fingerprint: control.fingerprint });
    attempt.dispose();
  });
});
