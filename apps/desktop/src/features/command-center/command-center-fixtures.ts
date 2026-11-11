import {
  COMMAND_CENTER_QUOTA,
  type CommandCenterMonitorSnapshot,
  type CommandCenterReceipt,
  type CommandCenterWorkspace,
} from "@pi-desktop/shared";

/**
 * Deterministic preview data for the mounted V3 command-center route.
 *
 * This module is data only: it opens no transport, registers no RACP operation
 * and does not pretend to be a live Host producer. The route uses it as the
 * default data provider and renders exactly these rows so the surface, its
 * navigation and its local state can be used and tested without a Host;
 * `capabilities` stays absent, so every control that would need a live path
 * remains explicitly unavailable. An injected provider may supply live data.
 */
export const COMMAND_CENTER_PREVIEW_WORKSPACES: readonly CommandCenterWorkspace[] = Object.freeze([
  {
    id: "1a2b3c4d-5e6f-4a70-8b91-0c1d2e3f4a50",
    name: "Delivery",
    enabled: true,
    revision: 4,
  },
  {
    id: "2b3c4d5e-6f70-4b81-9ca2-1d2e3f4a5b61",
    name: "Research",
    enabled: true,
    revision: 2,
  },
  {
    id: "3c4d5e6f-7081-4c92-adb3-2e3f4a5b6c72",
    name: "Operations",
    enabled: true,
    revision: 1,
  },
]);

export const COMMAND_CENTER_PREVIEW_SNAPSHOT: CommandCenterMonitorSnapshot = {
  version: 1,
  cursor: { epoch: "monitor-preview-0001", sequence: 3 },
  generatedAt: "2026-01-01T00:00:00.000Z",
  rows: [
    {
      target: { kind: "delegation", parentSessionId: "sess-preview-1", delegationId: "del-preview-1" },
      execution: {
        kind: "delegation",
        parentSessionId: "sess-preview-1",
        parentTurnId: "turn-preview-4",
        delegationId: "del-preview-1",
        executionGeneration: 2,
      },
      commandWorkspaceId: COMMAND_CENTER_PREVIEW_WORKSPACES[0].id,
      label: "Review child fixtures",
      status: "waiting_human",
      waitingReason: "approval pending",
      desiredGoalRevision: 2,
      effectiveGoalRevision: 2,
      pendingApprovals: 1,
      pendingInputs: 0,
      updatedAt: "2026-01-01T00:00:01.000Z",
    },
    {
      target: { kind: "session", sessionId: "sess-preview-2" },
      execution: { kind: "session", sessionId: "sess-preview-2", turnId: "turn-preview-5" },
      commandWorkspaceId: COMMAND_CENTER_PREVIEW_WORKSPACES[0].id,
      label: "Deliver control contracts",
      status: "running",
      activity: "Editing shared schemas",
      desiredGoalRevision: 5,
      effectiveGoalRevision: 4,
      pendingApprovals: 0,
      pendingInputs: 0,
      updatedAt: "2026-01-01T00:00:02.000Z",
    },
    {
      target: { kind: "session", sessionId: "sess-preview-3" },
      commandWorkspaceId: COMMAND_CENTER_PREVIEW_WORKSPACES[1].id,
      label: "Settled audit",
      status: "completed",
      desiredGoalRevision: 3,
      effectiveGoalRevision: 3,
      pendingApprovals: 0,
      pendingInputs: 0,
      updatedAt: "2026-01-01T00:00:03.000Z",
    },
  ],
};

const RECEIPT_FINGERPRINT =
  "9f2c4e6a8b0d1f3a5c7e9b0d2f4a6c8e0b1d3f5a7c9e1b2d4f6a8c0e2b4d6f8a";

/** Retained control receipts for the previewed delegation, oldest revision last. */
export const COMMAND_CENTER_PREVIEW_RECEIPTS: readonly CommandCenterReceipt[] = Object.freeze([
  {
    version: 1,
    requestId: "b4a1c8d2-5e6f-4a70-8b93-1c2d3e4f5a60",
    fingerprint: RECEIPT_FINGERPRINT,
    target: {
      kind: "delegation",
      parentSessionId: "sess-preview-1",
      parentTurnId: "turn-preview-4",
      delegationId: "del-preview-1",
      executionGeneration: 2,
    },
    operation: "append",
    status: "accepted",
    revision: 2,
    desiredGoalRevision: 2,
    effectiveGoalRevision: 2,
  },
  {
    version: 1,
    requestId: "c5b2d9e3-6f70-4b81-9ca4-2d3e4f5a6b71",
    fingerprint: RECEIPT_FINGERPRINT,
    target: {
      kind: "delegation",
      parentSessionId: "sess-preview-1",
      parentTurnId: "turn-preview-4",
      delegationId: "del-preview-1",
      executionGeneration: 2,
    },
    operation: "steer",
    status: "recorded",
    revision: 1,
    desiredGoalRevision: 2,
    effectiveGoalRevision: 2,
  },
]);

/** Enabled-workspace and agent quotas the preview data is required to respect. */
export const COMMAND_CENTER_PREVIEW_QUOTA = COMMAND_CENTER_QUOTA;
