import {
  COMMAND_CENTER_QUOTA,
  commandCenterCapabilityAvailable,
  commandCenterTaskKey,
  type CommandCenterCapabilities,
  type CommandCenterExecutionTarget,
  type CommandCenterMonitorSnapshot,
  type CommandCenterOperation,
  type CommandCenterReceipt,
  type CommandCenterReceiptStatus,
  type CommandCenterTaskState,
  type CommandCenterTaskSummary,
  type CommandCenterTaskTarget,
  type CommandCenterWorkspace,
} from "@pi-desktop/shared";

/**
 * Local, device-only view model for the command-center overview and workspace
 * pages.
 *
 * Nothing here owns execution: navigating, remembering a focused workspace,
 * keeping a draft or merging local history never starts, stops or reassigns a
 * task. Every identity is taken from the committed C1 contracts, and summary
 * rows are read-only projections. Reducer and selectors are pure so the pages
 * can be exercised without a Host, a store or an Electron process.
 */

/** Task states that keep their execution slot until authoritative evidence. */
const CAPACITY_STATES: ReadonlySet<CommandCenterTaskState> = new Set<CommandCenterTaskState>([
  "reserved", "starting", "running", "waiting_tool", "waiting_human", "stopping", "outcome_unknown",
]);

/** Attention first, then live work, then terminal rows. */
const STATUS_ORDER: Readonly<Record<CommandCenterTaskState, number>> = Object.freeze({
  waiting_human: 0,
  running: 1,
  waiting_tool: 2,
  stopping: 3,
  starting: 4,
  reserved: 5,
  outcome_unknown: 6,
  failed: 7,
  launch_failed: 8,
  aborted: 9,
  completed: 10,
});

/** Bounded client-side history; the Host journal is not copied here. */
export const COMMAND_CENTER_HISTORY_LIMIT = 20;
/** Bounded local draft; the renderer never retains more than this per target. */
export const COMMAND_CENTER_MAX_DRAFT_CHARS = 8000;
/** Receipts shown at once; the durable journal stays authoritative. */
export const COMMAND_CENTER_RECEIPT_LIMIT = 5;

export interface CommandCenterHostStatus {
  readonly label: string;
  readonly state: "connected" | "stale" | "offline";
}

export type CommandCenterDestination =
  | { readonly kind: "overview" }
  | { readonly kind: "history" }
  | { readonly kind: "workspace"; readonly workspaceId: string };

/**
 * One local recall entry. `target` is the stable goal owner, so revisiting a
 * continued delegation merges instead of appending a second row.
 */
export interface CommandCenterHistoryEntry {
  readonly target: CommandCenterTaskTarget;
  readonly label: string;
  readonly workspaceId: string;
  readonly workspaceName?: string;
  readonly status?: CommandCenterTaskState;
  /** Local monotonic visit counter; never a Host ordering claim. */
  readonly visitedAt: number;
}

export interface CommandCenterViewState {
  readonly destination: CommandCenterDestination;
  /** Remembered workspace, so Overview can return to the same entry. */
  readonly lastWorkspaceId: string | null;
  /** Drafts keyed by `commandCenterDraftKey`. */
  readonly drafts: Readonly<Record<string, string>>;
  readonly history: readonly CommandCenterHistoryEntry[];
  readonly visitSequence: number;
}

export type CommandCenterViewAction =
  | { readonly type: "open-overview" }
  | { readonly type: "open-workspace"; readonly workspaceId: string }
  | { readonly type: "open-history" }
  | { readonly type: "open-history-entry"; readonly entry: CommandCenterHistoryEntry }
  | { readonly type: "record-visit"; readonly entry: Omit<CommandCenterHistoryEntry, "visitedAt"> }
  | { readonly type: "update-draft"; readonly key: string; readonly text: string };

export function createCommandCenterViewState(
  initial?: Partial<Pick<CommandCenterViewState, "destination" | "lastWorkspaceId">>,
): CommandCenterViewState {
  return {
    destination: initial?.destination ?? { kind: "overview" },
    lastWorkspaceId: initial?.lastWorkspaceId ?? null,
    drafts: {},
    history: [],
    visitSequence: 0,
  };
}

/**
 * Drafts are scoped to the operational group and, once a task is selected, to
 * that task's stable key. Switching workspace, task or page keeps the text and
 * never re-points it at another target.
 */
export function commandCenterDraftKey(workspaceId: string, taskKey?: string): string {
  return JSON.stringify(taskKey === undefined ? ["draft", workspaceId] : ["draft", workspaceId, taskKey]);
}

/**
 * Merge recall entries by canonical task identity. A later visit updates the
 * existing row instead of adding a duplicate; equal visit counters keep the
 * incoming observation, so the result is deterministic for any input order.
 */
export function mergeCommandCenterHistory(
  history: readonly CommandCenterHistoryEntry[],
  incoming: readonly CommandCenterHistoryEntry[],
): CommandCenterHistoryEntry[] {
  const byTask = new Map<string, CommandCenterHistoryEntry>();
  for (const entry of [...incoming, ...history]) {
    const key = commandCenterTaskKey(entry.target);
    const current = byTask.get(key);
    if (current === undefined || entry.visitedAt > current.visitedAt) byTask.set(key, entry);
  }
  return [...byTask.entries()]
    .sort(([keyA, a], [keyB, b]) => b.visitedAt - a.visitedAt || keyA.localeCompare(keyB))
    .map(([, entry]) => entry)
    .slice(0, COMMAND_CENTER_HISTORY_LIMIT);
}

export function reduceCommandCenterView(
  state: CommandCenterViewState,
  action: CommandCenterViewAction,
): CommandCenterViewState {
  switch (action.type) {
    case "open-overview":
      // Returning to the overview is a view change only.
      if (state.destination.kind === "overview") return state;
      return { ...state, destination: { kind: "overview" } };
    case "open-workspace": {
      if (typeof action.workspaceId !== "string" || action.workspaceId.length === 0) return state;
      if (state.destination.kind === "workspace" && state.destination.workspaceId === action.workspaceId) {
        return state.lastWorkspaceId === action.workspaceId
          ? state
          : { ...state, lastWorkspaceId: action.workspaceId };
      }
      return {
        ...state,
        destination: { kind: "workspace", workspaceId: action.workspaceId },
        lastWorkspaceId: action.workspaceId,
      };
    }
    case "open-history":
      if (state.destination.kind === "history") return state;
      return { ...state, destination: { kind: "history" } };
    case "record-visit": {
      if (action.entry.workspaceId.length === 0) return state;
      const visitSequence = state.visitSequence + 1;
      const history = mergeCommandCenterHistory(state.history, [{ ...action.entry, visitedAt: visitSequence }]);
      return { ...state, history, visitSequence };
    }
    case "open-history-entry": {
      if (action.entry.workspaceId.length === 0) return state;
      const visitSequence = state.visitSequence + 1;
      const history = mergeCommandCenterHistory(state.history, [{ ...action.entry, visitedAt: visitSequence }]);
      return {
        ...state,
        history,
        visitSequence,
        destination: { kind: "workspace", workspaceId: action.entry.workspaceId },
        lastWorkspaceId: action.entry.workspaceId,
      };
    }
    case "update-draft": {
      if (action.key.length === 0) return state;
      const text = action.text.slice(0, COMMAND_CENTER_MAX_DRAFT_CHARS);
      if (text.length === 0) {
        if (state.drafts[action.key] === undefined) return state;
        const drafts = { ...state.drafts };
        delete drafts[action.key];
        return { ...state, drafts };
      }
      if (state.drafts[action.key] === text) return state;
      return { ...state, drafts: { ...state.drafts, [action.key]: text } };
    }
    default:
      return state;
  }
}

export interface CommandCenterWorkspaceEntry {
  readonly workspaceId: string;
  /** Design position A/B/C, not a stored identifier. */
  readonly letter: "A" | "B" | "C";
  readonly name: string;
  readonly activeAgents: number;
  readonly maxAgents: number;
}

const ENTRY_LETTERS = ["A", "B", "C"] as const;

function rowsForWorkspace(
  snapshot: CommandCenterMonitorSnapshot | undefined,
  workspaceId?: string,
): readonly CommandCenterTaskSummary[] {
  if (snapshot === undefined) return [];
  return workspaceId === undefined
    ? snapshot.rows
    : snapshot.rows.filter((row) => row.commandWorkspaceId === workspaceId);
}

function activeAgentCount(snapshot: CommandCenterMonitorSnapshot | undefined, workspaceId: string): number {
  return rowsForWorkspace(snapshot, workspaceId).filter((row) => CAPACITY_STATES.has(row.status)).length;
}

/**
 * Entry previews for at most three enabled workspaces, labelled by real
 * workspace names. A disabled or over-quota extra workspace is not previewed.
 */
export function selectWorkspaceEntries(
  workspaces: readonly CommandCenterWorkspace[],
  snapshot?: CommandCenterMonitorSnapshot,
): CommandCenterWorkspaceEntry[] {
  return workspaces
    .filter((workspace) => workspace.enabled)
    .slice(0, COMMAND_CENTER_QUOTA.maxEnabledWorkspaces)
    .map((workspace, index) => ({
      workspaceId: workspace.id,
      letter: ENTRY_LETTERS[index],
      name: workspace.name,
      activeAgents: activeAgentCount(snapshot, workspace.id),
      maxAgents: COMMAND_CENTER_QUOTA.maxAgentsPerWorkspace,
    }));
}

export interface CommandCenterTaskRowView {
  /** Stable JSON-tuple task key from C1, not a joined string. */
  readonly key: string;
  readonly target: CommandCenterTaskTarget;
  readonly execution?: CommandCenterExecutionTarget;
  readonly label: string;
  readonly detail?: string;
  readonly status: CommandCenterTaskState;
  readonly needsHuman: boolean;
  readonly pendingCount: number;
  readonly updatedAt: string;
  readonly active: boolean;
  readonly workspaceId: string;
}

function taskRowView(row: CommandCenterTaskSummary): CommandCenterTaskRowView {
  const pendingCount = row.pendingApprovals + row.pendingInputs;
  return {
    workspaceId: row.commandWorkspaceId,
    key: commandCenterTaskKey(row.target),
    target: row.target,
    execution: row.execution,
    label: row.label,
    detail: row.waitingReason ?? row.activity,
    status: row.status,
    needsHuman: pendingCount > 0 || row.status === "waiting_human",
    pendingCount,
    updatedAt: row.updatedAt,
    active: CAPACITY_STATES.has(row.status),
  };
}

/** Monitor rows, attention first, with a stable order for identical rows. */
export function selectTaskRows(
  snapshot: CommandCenterMonitorSnapshot | undefined,
  workspaceId?: string,
): CommandCenterTaskRowView[] {
  return rowsForWorkspace(snapshot, workspaceId)
    .map(taskRowView)
    .sort((a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.updatedAt === b.updatedAt ? 0 : a.updatedAt < b.updatedAt ? 1 : -1) ||
      a.key.localeCompare(b.key),
    );
}

export interface CommandCenterOverviewView {
  readonly totalTasks: number;
  readonly activeTasks: number;
  readonly attentionCount: number;
  /** Bounded preview rows; the overview never lists every task. */
  readonly rows: readonly CommandCenterTaskRowView[];
}

export const COMMAND_CENTER_OVERVIEW_ROWS = 3;

export function selectOverviewView(
  snapshot?: CommandCenterMonitorSnapshot,
): CommandCenterOverviewView {
  const rows = selectTaskRows(snapshot);
  return {
    totalTasks: rows.length,
    activeTasks: rows.filter((row) => row.active).length,
    attentionCount: rows.filter((row) => row.needsHuman).length,
    rows: rows.slice(0, COMMAND_CENTER_OVERVIEW_ROWS),
  };
}

export interface CommandCenterWorkspaceView {
  readonly workspaceId: string;
  readonly name: string;
  readonly entries: readonly CommandCenterWorkspaceEntry[];
  readonly rows: readonly CommandCenterTaskRowView[];
  readonly attentionCount: number;
  readonly liveAgents: number;
  readonly maxAgents: number;
}

/** Undefined means the operational group is gone; the surface says so. */
export function selectWorkspaceView(input: {
  readonly workspaceId: string;
  readonly workspaces: readonly CommandCenterWorkspace[];
  readonly snapshot?: CommandCenterMonitorSnapshot;
}): CommandCenterWorkspaceView | undefined {
  const workspace = input.workspaces.find((candidate) => candidate.id === input.workspaceId);
  if (workspace === undefined) return undefined;
  const rows = selectTaskRows(input.snapshot, workspace.id);
  return {
    workspaceId: workspace.id,
    name: workspace.name,
    entries: selectWorkspaceEntries(input.workspaces, input.snapshot),
    rows,
    attentionCount: rows.filter((row) => row.needsHuman).length,
    liveAgents: rows.filter((row) => row.active).length,
    maxAgents: COMMAND_CENTER_QUOTA.maxAgentsPerWorkspace,
  };
}

export type CommandCenterReceiptTone = "neutral" | "success" | "error" | "warning";

export interface CommandCenterReceiptView {
  readonly requestId: string;
  readonly operation: CommandCenterOperation;
  readonly status: CommandCenterReceiptStatus;
  /** Receipt revision that won the local merge; never shown as goal progress. */
  readonly revision: number;
  readonly tone: CommandCenterReceiptTone;
}

export function commandCenterReceiptTone(status: CommandCenterReceiptStatus): CommandCenterReceiptTone {
  switch (status) {
    case "completed":
      return "success";
    case "rejected":
    case "conflicted":
    case "interrupted":
      return "error";
    case "outcome_unknown":
      return "warning";
    default:
      return "neutral";
  }
}

/**
 * Latest retained receipt per request. A delayed event with an older revision
 * must not roll the visible status back.
 */
export function selectReceiptViews(
  receipts: readonly CommandCenterReceipt[],
  limit: number = COMMAND_CENTER_RECEIPT_LIMIT,
): CommandCenterReceiptView[] {
  const latest = new Map<string, CommandCenterReceipt>();
  for (const receipt of receipts) {
    const current = latest.get(receipt.requestId);
    if (current === undefined || receipt.revision > current.revision) latest.set(receipt.requestId, receipt);
  }
  return [...latest.entries()]
    .sort(([requestA, a], [requestB, b]) => b.revision - a.revision || requestA.localeCompare(requestB))
    .slice(0, limit)
    .map(([, receipt]) => ({
      requestId: receipt.requestId,
      operation: receipt.operation,
      status: receipt.status,
      revision: receipt.revision,
      tone: commandCenterReceiptTone(receipt.status),
    }));
}

/**
 * Local recall entry for one selected task. It reads the row the surface
 * already renders, so history can never record a target, label or workspace the
 * Host did not report. An unknown target produces no entry.
 */
export function commandCenterVisitEntry(input: {
  readonly target: CommandCenterTaskTarget;
  readonly rows: readonly CommandCenterTaskRowView[];
  readonly workspaces: readonly CommandCenterWorkspace[];
}): Omit<CommandCenterHistoryEntry, "visitedAt"> | undefined {
  const key = commandCenterTaskKey(input.target);
  const row = input.rows.find((candidate) => candidate.key === key);
  if (row === undefined) return undefined;
  return {
    target: row.target,
    label: row.label,
    workspaceId: row.workspaceId,
    workspaceName: input.workspaces.find((workspace) => workspace.id === row.workspaceId)?.name,
    status: row.status,
  };
}

export interface CommandCenterControlAvailability {
  readonly monitor: boolean;
  readonly workspaceList: boolean;
  readonly interventions: boolean;
}

/**
 * A control is available only when the peer advertises it and the capability
 * path exists. Under committed C1 no capability is implemented, so every
 * control stays unavailable even if a flag claims otherwise.
 */
export function commandCenterControlAvailability(
  capabilities?: CommandCenterCapabilities,
): CommandCenterControlAvailability {
  return {
    monitor: commandCenterCapabilityAvailable(capabilities, "monitor"),
    workspaceList: commandCenterCapabilityAvailable(capabilities, "workspaceList"),
    interventions: commandCenterCapabilityAvailable(capabilities, "interventions"),
  };
}

export type CommandCenterDraftSubmitBlocker = "capability" | "handler";

export interface CommandCenterDraftSubmission {
  readonly available: boolean;
  readonly blocker?: CommandCenterDraftSubmitBlocker;
}

/**
 * Sending requires both an implemented capability and an explicit submit port.
 * A missing callback is reported separately so the page can say why.
 */
export function commandCenterDraftSubmission(
  availability: CommandCenterControlAvailability,
  onSubmitDraft: unknown,
): CommandCenterDraftSubmission {
  if (!availability.interventions) return { available: false, blocker: "capability" };
  if (onSubmitDraft === undefined || onSubmitDraft === null) return { available: false, blocker: "handler" };
  return { available: true };
}
