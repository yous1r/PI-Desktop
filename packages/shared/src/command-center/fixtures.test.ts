import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMAND_CENTER_CAPABILITIES, parseCommandCenterCapabilities } from "./capabilities.js";
import {
  applyCommandCenterConsumption, parseCommandCenterConsumption, parseCommandCenterGoalHead,
} from "./goal.js";
import {
  COMMAND_CENTER_QUOTA, commandCenterExecutionBelongsToTask, commandCenterTaskKey,
  parseCommandCenterExecutionTarget, parseCommandCenterTaskTarget, parseCommandCenterWorkspaceList,
} from "./identity.js";
import { commandCenterCanonicalPayload, parseCommandCenterInterventionRequest } from "./intervention.js";
import {
  COMMAND_CENTER_MAX_RECEIPT_BYTES, COMMAND_CENTER_MAX_REQUEST_BYTES, COMMAND_CENTER_MAX_SUMMARY_PAGE_BYTES,
  COMMAND_CENTER_VERSION, commandCenterWithinBytes,
} from "./primitives.js";
import {
  COMMAND_CENTER_RECEIPT_STATUSES, COMMAND_CENTER_RECEIPT_TRANSITIONS, commandCenterReceiptBindsRequest,
  commandCenterReceiptCanTransition, parseCommandCenterReceipt,
} from "./receipt.js";
import { parseCommandCenterMonitorSnapshot } from "./summary.js";

const control = JSON.parse(readFileSync(new URL("../../test/fixtures/command-center-control.json", import.meta.url), "utf8"));
const summary = JSON.parse(readFileSync(new URL("../../test/fixtures/command-center-summary.json", import.meta.url), "utf8"));
const receipts = Object.entries(control.receipts) as [string, Record<string, unknown>][];

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      keys.add(key);
      collectKeys(item, keys);
    }
  }
  return keys;
}

describe("command-center producer/consumer fixtures", () => {
  it("versions every fixture block at the current contract version", () => {
    expect(control.version).toBe(COMMAND_CENTER_VERSION);
    expect(summary.version).toBe(COMMAND_CENTER_VERSION);
    const blocks = [
      control.request, control.stopRequest, control.goalHead, control.consumption,
      control.receipt, control.stopReceipt, ...receipts.map(([, receipt]) => receipt),
      summary.workspaces, summary.snapshot,
    ];
    for (const block of blocks) expect(block.version).toBe(COMMAND_CENTER_VERSION);
  });

  it("parses every block through its public consumer entry point", () => {
    const request = parseCommandCenterInterventionRequest(control.request);
    const stop = parseCommandCenterInterventionRequest(control.stopRequest);
    expect(request.intent.kind).toBe("reviseGoal");
    expect(stop.intent).toEqual({ kind: "stop", scope: "subtree" });

    const head = parseCommandCenterGoalHead(control.goalHead);
    const consumption = parseCommandCenterConsumption(control.consumption);
    const workspaces = parseCommandCenterWorkspaceList(summary.workspaces);
    const snapshot = parseCommandCenterMonitorSnapshot(summary.snapshot);

    expect(workspaces.quota).toEqual(COMMAND_CENTER_QUOTA);
    expect(snapshot.rows).toHaveLength(3);
    expect(head.desiredRevision).toBeGreaterThan(head.effectiveRevision);
    expect(commandCenterWithinBytes(control.request, COMMAND_CENTER_MAX_REQUEST_BYTES)).toBe(true);
    expect(commandCenterWithinBytes(summary.snapshot, COMMAND_CENTER_MAX_SUMMARY_PAGE_BYTES)).toBe(true);
  });

  it("keeps the canonical payload and fingerprint vectors byte-stable", () => {
    expect(commandCenterCanonicalPayload(control.request)).toBe(control.canonicalPayload);
    expect(createHash("sha256").update(control.canonicalPayload, "utf8").digest("hex")).toBe(control.fingerprint);
    expect(commandCenterCanonicalPayload(control.stopRequest)).toBe(control.stopCanonicalPayload);
    expect(createHash("sha256").update(control.stopCanonicalPayload, "utf8").digest("hex")).toBe(control.stopFingerprint);
    // The two intents are distinct attempts and must never share a fingerprint.
    expect(control.fingerprint).not.toBe(control.stopFingerprint);
  });

  it("binds every golden receipt to the request that produced it", () => {
    for (const [status, receipt] of receipts) {
      const parsed = parseCommandCenterReceipt(receipt);
      expect(commandCenterReceiptBindsRequest(parsed, control.request)).toBe(true);
      expect(parsed.status).toBe(status);
      expect(parsed.operation).toBe("reviseGoal");
      expect(commandCenterWithinBytes(receipt, COMMAND_CENTER_MAX_RECEIPT_BYTES)).toBe(true);
    }
    expect(commandCenterReceiptBindsRequest(parseCommandCenterReceipt(control.stopReceipt), control.stopRequest)).toBe(true);
  });

  it("replays the lifecycle fixture as legal, ordered transitions", () => {
    expect(Object.keys(COMMAND_CENTER_RECEIPT_TRANSITIONS).sort()).toEqual([...COMMAND_CENTER_RECEIPT_STATUSES].sort());
    const lifecycle = ["recorded", "accepted", "consumed", "completed"] as const;
    const byStatus: Record<string, Record<string, unknown>> = {
      recorded: control.receipt,
      accepted: control.receipts.accepted,
      consumed: control.receipts.consumed,
      completed: control.receipts.completed,
    };
    for (let index = 1; index < lifecycle.length; index += 1) {
      expect(commandCenterReceiptCanTransition(lifecycle[index - 1], lifecycle[index])).toBe(true);
    }
    const revisions = lifecycle.map((status) => byStatus[status].revision as number);
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
    expect(new Set(revisions).size).toBe(revisions.length);
    for (let index = 1; index < lifecycle.length; index += 1) {
      const previous = byStatus[lifecycle[index - 1]];
      const next = byStatus[lifecycle[index]];
      expect(next.effectiveGoalRevision).toBeGreaterThanOrEqual(previous.effectiveGoalRevision as number);
      expect(next.desiredGoalRevision).toBeGreaterThanOrEqual(previous.desiredGoalRevision as number);
    }
    expect(commandCenterReceiptCanTransition("completed", "accepted")).toBe(false);
    expect(commandCenterReceiptCanTransition("conflicted", "recorded")).toBe(false);
  });

  it("advances effective revision only through the consumption acknowledgement", () => {
    const head = parseCommandCenterGoalHead(control.goalHead);
    const consumed = control.receipts.consumed;
    const advanced = applyCommandCenterConsumption(head, control.consumption);
    expect(control.consumption.requestId).toBe(control.request.requestId);
    expect(advanced.effectiveRevision).toBe(control.consumption.consumedRevision);
    expect(advanced.effectiveRevision).toBe(consumed.effectiveGoalRevision);
    expect(advanced.desiredRevision).toBe(consumed.desiredGoalRevision);
    // The same acknowledgement replayed, and an older revision, cannot move it back.
    expect(applyCommandCenterConsumption(advanced, control.consumption).effectiveRevision).toBe(advanced.effectiveRevision);
    expect(() => applyCommandCenterConsumption(advanced, {
      ...control.consumption, consumedRevision: head.effectiveRevision,
    })).toThrow("COMMAND_CENTER_CONSUMPTION_STALE");
  });

  it("keeps summary rows on the same stable owners as the control fixtures", () => {
    const workspaces = parseCommandCenterWorkspaceList(summary.workspaces);
    const ids = new Set(workspaces.workspaces.map((workspace) => workspace.id));
    const snapshot = parseCommandCenterMonitorSnapshot(summary.snapshot);
    expect(new Set(snapshot.rows.map((row) => commandCenterTaskKey(row.target))).size).toBe(snapshot.rows.length);
    for (const row of snapshot.rows) {
      expect(ids.has(row.commandWorkspaceId)).toBe(true);
      if (row.execution !== undefined) {
        expect(() => parseCommandCenterExecutionTarget(row.execution)).not.toThrow();
        expect(commandCenterExecutionBelongsToTask(row.execution, row.target)).toBe(true);
      }
      expect(row.effectiveGoalRevision).toBeLessThanOrEqual(row.desiredGoalRevision);
    }
    // Settled work keeps its owner and dies without a fabricated turn.
    const settled = snapshot.rows.find((row) => row.status === "completed");
    expect(settled?.execution).toBeUndefined();
    // The live session row and the control fixture describe the same execution.
    const live = snapshot.rows[0];
    const liveExecution = parseCommandCenterExecutionTarget(live.execution);
    expect(liveExecution).toEqual(control.targets.sessionExecution);
    expect(commandCenterExecutionBelongsToTask(liveExecution, parseCommandCenterTaskTarget(control.targets.task))).toBe(false);
  });

  it("carries no caller principal, role or capability grant", () => {
    const keys = collectKeys(control);
    for (const key of collectKeys(summary)) keys.add(key);
    for (const forbidden of ["principal", "subject", "role", "roles", "permissions", "accessToken", "secret"]) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(parseCommandCenterCapabilities(control.capabilities.advertised)).toEqual([]);
    // Every advertised name in the fixture must already be a contract capability.
    for (const name of Object.keys(control.capabilities.advertised)) {
      expect(COMMAND_CENTER_CAPABILITIES).toContain(name);
    }
  });
});
