import { readFileSync } from "node:fs";
import * as Value from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  COMMAND_CENTER_QUOTA, CommandCenterExecutionTargetSchema, CommandCenterFenceSchema,
  CommandCenterTaskTargetSchema, CommandCenterWorkspaceListSchema,
  commandCenterExecutionBelongsToTask, commandCenterExecutionKey, commandCenterTaskKey,
  parseCommandCenterExecutionTarget, parseCommandCenterTaskTarget, parseCommandCenterWorkspaceList,
} from "./identity.js";

const summaryFixture = JSON.parse(readFileSync(new URL("../../test/fixtures/command-center-summary.json", import.meta.url), "utf8"));
const controlFixture = JSON.parse(readFileSync(new URL("../../test/fixtures/command-center-control.json", import.meta.url), "utf8"));
const targets = controlFixture.targets;

describe("command-center identity and workspace contracts", () => {
  it("accepts three enabled workspaces plus inactive saved ones", () => {
    const list = parseCommandCenterWorkspaceList(summaryFixture.workspaces);
    expect(list.workspaces).toHaveLength(4);
    expect(list.workspaces.filter((workspace) => workspace.enabled)).toHaveLength(3);
    expect(list.quota).toEqual(COMMAND_CENTER_QUOTA);
    expect(Value.Check(CommandCenterWorkspaceListSchema, summaryFixture.workspaces)).toBe(true);
  });

  it("rejects a fourth enabled workspace and duplicate workspace ids", () => {
    const fourthEnabled = structuredClone(summaryFixture.workspaces);
    fourthEnabled.workspaces[3].enabled = true;
    expect(() => parseCommandCenterWorkspaceList(fourthEnabled)).toThrow("COMMAND_CENTER_INVALID_WORKSPACES");

    const duplicate = structuredClone(summaryFixture.workspaces);
    duplicate.workspaces[1].id = duplicate.workspaces[0].id;
    expect(() => parseCommandCenterWorkspaceList(duplicate)).toThrow("COMMAND_CENTER_INVALID_WORKSPACES");
  });

  it("rejects paths, nil ids and unknown fields in workspace identity", () => {
    const list = structuredClone(summaryFixture.workspaces);
    list.workspaces[0].id = "C:/Users/Administrator/project";
    expect(Value.Check(CommandCenterWorkspaceListSchema, list)).toBe(false);

    const nil = structuredClone(summaryFixture.workspaces);
    nil.workspaces[0].id = "00000000-0000-0000-0000-000000000000";
    expect(Value.Check(CommandCenterWorkspaceListSchema, nil)).toBe(false);

    const unknown = structuredClone(summaryFixture.workspaces);
    unknown.workspaces[0].path = "C:/Users/Administrator/project";
    expect(Value.Check(CommandCenterWorkspaceListSchema, unknown)).toBe(false);
  });

  it("separates a stable task target from a concrete turn or native generation", () => {
    const task = parseCommandCenterTaskTarget(targets.task);
    expect(JSON.parse(commandCenterTaskKey(task))).toEqual(["delegation", "sess-parent-1", "del-chain-7"]);
    expect(JSON.parse(commandCenterExecutionKey(targets.execution)).at(-1)).toBe(2);
    expect(JSON.parse(commandCenterExecutionKey(targets.replacementExecution)).at(-1)).toBe(3);
    expect(commandCenterExecutionBelongsToTask(targets.execution, task)).toBe(true);
    expect(commandCenterExecutionBelongsToTask(targets.replacementExecution, task)).toBe(true);
    // Same stable owner, different concrete generation: controls must not alias.
    expect(commandCenterExecutionKey(targets.execution)).not.toBe(commandCenterExecutionKey(targets.replacementExecution));

    const otherTask = { kind: "session" as const, sessionId: "sess-main-1" };
    expect(commandCenterExecutionBelongsToTask(targets.execution, otherTask)).toBe(false);
  });

  it("does not let a settled session fabricate an active turn", () => {
    expect(Value.Check(CommandCenterTaskTargetSchema, { kind: "session", sessionId: "sess-main-1" })).toBe(true);
    expect(Value.Check(CommandCenterTaskTargetSchema, { kind: "session", sessionId: "sess-main-1", turnId: "turn-main-4" })).toBe(false);
    expect(Value.Check(CommandCenterExecutionTargetSchema, { kind: "session", sessionId: "sess-main-1" })).toBe(false);
    expect(Value.Check(CommandCenterExecutionTargetSchema, {
      kind: "delegation", parentSessionId: "sess-parent-1", parentTurnId: "turn-parent-3", delegationId: "del-chain-7",
    })).toBe(false);
    expect(() => parseCommandCenterExecutionTarget({ kind: "session", sessionId: "sess-main-1", turnId: "" })).toThrow("COMMAND_CENTER_INVALID_TARGET");
  });

  it("requires the Host/epoch/workspace/membership fence on mutations", () => {
    expect(Value.Check(CommandCenterFenceSchema, {
      hostId: "host_7c1e0a93b4d2f681",
      expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14",
      commandWorkspaceId: "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31",
      expectedMembershipRevision: 7,
    })).toBe(true);
    for (const fence of [
      { hostId: "C:/Users/Administrator", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14", commandWorkspaceId: "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31", expectedMembershipRevision: 7 },
      { hostId: "host x", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14", commandWorkspaceId: "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31", expectedMembershipRevision: 7 },
      { hostId: "host_7c1e0a93b4d2f681", expectedHostEpoch: "not-an-epoch", commandWorkspaceId: "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31", expectedMembershipRevision: 7 },
      { hostId: "host_7c1e0a93b4d2f681", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14", commandWorkspaceId: "Delivery", expectedMembershipRevision: 7 },
      { hostId: "host_7c1e0a93b4d2f681", expectedHostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14", commandWorkspaceId: "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31", expectedMembershipRevision: 0 },
    ]) expect(Value.Check(CommandCenterFenceSchema, fence)).toBe(false);
  });
});

it("keeps opaque identifier boundaries distinct in task and execution keys", () => {
  const firstTask = parseCommandCenterTaskTarget({ kind: "delegation", parentSessionId: "parent:part", delegationId: "child" });
  const otherTask = parseCommandCenterTaskTarget({ kind: "delegation", parentSessionId: "parent", delegationId: "part:child" });
  expect(commandCenterTaskKey(firstTask)).not.toBe(commandCenterTaskKey(otherTask));
  const first = parseCommandCenterExecutionTarget({ kind: "session", sessionId: "session:part", turnId: "turn" });
  const other = parseCommandCenterExecutionTarget({ kind: "session", sessionId: "session", turnId: "part:turn" });
  expect(commandCenterExecutionKey(first)).not.toBe(commandCenterExecutionKey(other));
  const child = parseCommandCenterExecutionTarget({ kind: "delegation", parentSessionId: "parent:part", parentTurnId: "turn", delegationId: "child", executionGeneration: 1 });
  const otherChild = parseCommandCenterExecutionTarget({ kind: "delegation", parentSessionId: "parent", parentTurnId: "part:turn", delegationId: "child", executionGeneration: 1 });
  expect(commandCenterExecutionKey(child)).not.toBe(commandCenterExecutionKey(otherChild));
});

it("pins task and execution tuple encodings for Rust producers", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/command-center-identities.json", import.meta.url), "utf8"));
  for (const { target, key } of fixture.tasks) expect(commandCenterTaskKey(parseCommandCenterTaskTarget(target))).toBe(key);
  for (const { target, key } of fixture.executions) expect(commandCenterExecutionKey(parseCommandCenterExecutionTarget(target))).toBe(key);
});
