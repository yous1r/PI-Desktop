import { readFileSync } from "node:fs";
import {
  COMMAND_CENTER_RECEIPT_TRANSITIONS,
  type CommandCenterReceipt,
  type CommandCenterReceiptStatus,
} from "@pi-desktop/shared";
import { describe, expect, it } from "vitest";
import {
  bindCommandCenterObservationOwner,
  createCommandCenterInterventionAttempt,
  createCommandCenterObservationContext,
  invalidateCommandCenterObservationContext,
  type CommandCenterAttemptState,
  type CommandCenterObservationResult,
} from "./index.js";

/**
 * Seeded model-based check of receipt observation. Legal chains are generated
 * from the committed C1 transition table, and every step is compared with an
 * independent expectation: monotonic revision, exact content, settlement only
 * for terminal statuses and no resurrection of terminals.
 */

const control = JSON.parse(
  readFileSync(new URL("../../shared/test/fixtures/command-center-control.json", import.meta.url), "utf8"),
);
const request = control.request;
const fingerprint = control.receipt.fingerprint;
const terminal = new Set<CommandCenterReceiptStatus>(["completed", "rejected", "conflicted", "interrupted", "outcome_unknown"]);

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 2 ** 32;
  };
}

function receipt(status: CommandCenterReceiptStatus, revision: number): CommandCenterReceipt {
  const needsError = status === "rejected" || status === "conflicted";
  return {
    version: 1,
    requestId: request.requestId,
    fingerprint,
    target: request.target,
    operation: "reviseGoal",
    status,
    revision,
    desiredGoalRevision: 5,
    effectiveGoalRevision: status === "completed" ? 5 : 4,
    ...(needsError ? { error: { code: "CONFLICT", message: "seeded conflict" } } : {}),
  };
}

function legalChain(next: () => number): CommandCenterReceipt[] {
  const chain: CommandCenterReceipt[] = [receipt("recorded", 1)];
  let current: CommandCenterReceiptStatus = "recorded";
  for (let revision = 2; !terminal.has(current) && revision < 8; revision += 1) {
    const options: readonly CommandCenterReceiptStatus[] = COMMAND_CENTER_RECEIPT_TRANSITIONS[current];
    const chosen: CommandCenterReceiptStatus = options[Math.floor(next() * options.length)] ?? current;
    chain.push(receipt(chosen, revision));
    current = chosen;
  }
  if (!terminal.has(current)) chain.push(receipt("completed", chain.length + 1));
  return chain;
}

function context() {
  const value = createCommandCenterObservationContext();
  bindCommandCenterObservationOwner(value, {
    hostId: request.hostId, expectedHostEpoch: request.expectedHostEpoch,
  });
  return value;
}

function active(state: CommandCenterAttemptState) {
  if (state.kind !== "active") throw new Error(`Unexpected attempt state: ${state.kind}`);
  return state;
}

function applied(result: CommandCenterObservationResult): void {
  expect(result.kind).toBe("applied");
}

function rejected(result: CommandCenterObservationResult, reason: string): void {
  expect(result).toMatchObject({ kind: "rejected", reason });
}

describe("intervention receipt observation model-based chains", () => {
  it.each([0, 3, 9, 21])("walks a seeded legal chain and against stale/duplicate/inconsistent input (seed %i)", async (seed) => {
    const next = seeded(seed + 1);
    const bound = context();
    const attempt = await createCommandCenterInterventionAttempt(bound, request);
    expect(active(attempt.getState()).fingerprint).toBe(fingerprint);
    const chain = legalChain(next);

    let previousRevision = 0;
    for (const step of chain) {
      const before = attempt.getState();
      applied(attempt.observeReceipt(bound, step));
      const state = active(attempt.getState());
      expect(state.receipt).toEqual(step);
      expect(state.receipt?.revision).toBe(previousRevision + 1);
      expect(state.settled).toBe(
        step.status === "completed" || step.status === "rejected" ||
        step.status === "conflicted" || step.status === "interrupted",
      );
      // A late, older receipt can never rewind the published state.
      if (previousRevision > 0) {
        expect(attempt.observeReceipt(bound, chain[0]).kind).toBe("ignored_stale");
        expect(attempt.getState()).toBe(state);
      }
      // Re-reading the same revision is a duplicate, not a change.
      expect(attempt.observeReceipt(bound, step).kind).toBe("duplicate");
      expect(active(attempt.getState()).receipt).toEqual(step);
      expect(attempt.getState()).not.toBe(before);
      previousRevision = step.revision;
    }

    const last = chain.at(-1)!;
    rejected(attempt.observeReceipt(bound, { ...last, desiredGoalRevision: 6 }), "inconsistent_revision");
    expect(active(attempt.getState()).receipt).toEqual(last);
    rejected(attempt.observeReceipt(bound, { ...last, target: control.targets.sessionExecution }), "request_mismatch");
    rejected(attempt.observeReceipt(bound, { ...last, fingerprint: "0".repeat(64) }), "fingerprint_mismatch");
    rejected(attempt.observeReceipt(bound, { ...last, providerPayload: "secret" }), "invalid_receipt");

    invalidateCommandCenterObservationContext(bound);
    expect(attempt.getState().kind).toBe("invalidated");
  });

  it("keeps authoritative outcome_unknown absorbing under the current C1 contract", async () => {
    const bound = context();
    const attempt = await createCommandCenterInterventionAttempt(bound, request);
    const accepted = receipt("accepted", 2);
    const unknown = receipt("outcome_unknown", 3);
    applied(attempt.observeReceipt(bound, receipt("recorded", 1)));
    applied(attempt.observeReceipt(bound, accepted));
    attempt.markDisconnected(bound);
    expect(active(attempt.getState()).observation).toBe("outcome_unknown");
    expect(active(attempt.getState()).settled).toBe(false);
    applied(attempt.observeReceipt(bound, unknown));
    expect(active(attempt.getState()).settled).toBe(false);
    rejected(attempt.observeReceipt(bound, receipt("completed", 4)), "invalid_progression");
    expect(active(attempt.getState()).receipt).toEqual(unknown);
    invalidateCommandCenterObservationContext(bound);
  });

  it("never treats local disconnection as an authoritative receipt", async () => {
    const bound = context();
    const attempt = await createCommandCenterInterventionAttempt(bound, request);
    const accepted = receipt("accepted", 2);
    applied(attempt.observeReceipt(bound, receipt("recorded", 1)));
    applied(attempt.observeReceipt(bound, accepted));
    attempt.markDisconnected(bound);
    const state = active(attempt.getState());
    expect(state.receipt).toEqual(accepted);
    expect(state.observation).toBe("outcome_unknown");
    expect(state.settled).toBe(false);
    // A same-revision authoritative re-read resolves the local uncertainty.
    expect(attempt.observeReceipt(bound, accepted).kind).toBe("duplicate");
    expect(active(attempt.getState()).observation).toBe("current");
    invalidateCommandCenterObservationContext(bound);
  });
});
