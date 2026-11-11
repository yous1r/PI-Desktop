import type { CommandCenterReceiptStatus, CommandCenterTaskState } from "@pi-desktop/shared";

/**
 * i18next namespace of this fragment. The locale files stay nested JSON so a
 * registration can hand them to i18next unchanged; keys are addressed with the
 * repository's usual dotted form (`overview.title`).
 *
 * The parent integration registers `locales/en.json` and `locales/zh-CN.json`
 * as resources of this namespace next to the existing renderer catalogs. Until
 * then every page keeps accepting an explicit `t` from its caller.
 */
export const COMMAND_CENTER_I18N_NAMESPACE = "commandCenter";

/** Static status keys; a literal map keeps the label scan test simple. */
export const COMMAND_CENTER_STATUS_LABEL_KEYS: Readonly<Record<CommandCenterTaskState, string>> = Object.freeze({
  reserved: "status.reserved",
  starting: "status.starting",
  running: "status.running",
  waiting_tool: "status.waiting_tool",
  waiting_human: "status.waiting_human",
  stopping: "status.stopping",
  outcome_unknown: "status.outcome_unknown",
  completed: "status.completed",
  aborted: "status.aborted",
  failed: "status.failed",
  launch_failed: "status.launch_failed",
});

export const COMMAND_CENTER_RECEIPT_LABEL_KEYS: Readonly<Record<CommandCenterReceiptStatus, string>> = Object.freeze({
  recorded: "receiptStatus.recorded",
  accepted: "receiptStatus.accepted",
  consumed: "receiptStatus.consumed",
  completed: "receiptStatus.completed",
  rejected: "receiptStatus.rejected",
  conflicted: "receiptStatus.conflicted",
  interrupted: "receiptStatus.interrupted",
  outcome_unknown: "receiptStatus.outcome_unknown",
});

export const COMMAND_CENTER_OPERATION_LABEL_KEYS = Object.freeze({
  append: "operation.append",
  steer: "operation.steer",
  reviseGoal: "operation.reviseGoal",
  stop: "operation.stop",
} as const);

/** Badge tone per task state; colour never carries the only meaning. */
export function commandCenterStatusTone(
  status: CommandCenterTaskState,
): "neutral" | "success" | "error" | "warning" {
  switch (status) {
    case "waiting_human":
    case "waiting_tool":
    case "outcome_unknown":
      return "warning";
    case "completed":
      return "success";
    case "aborted":
    case "failed":
    case "launch_failed":
      return "error";
    default:
      return "neutral";
  }
}
