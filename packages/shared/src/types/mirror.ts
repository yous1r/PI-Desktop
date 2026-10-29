/**
 * Wire contract between the Electron main process and the renderer for remote
 * mirror projects (spec `03-runtime/23-remote-mirror-development.md`).
 *
 * The main process owns every mirror resource — watchers, transfers, adapter
 * processes, DAP sessions. The renderer never receives a socket, a token or a
 * remote path it could open itself; it receives snapshots and outcomes only.
 */

/** Where a project sits relative to its mirror environment. */
export type MirrorInitState = "needs-init" | "initializing" | "ready" | "init-failed";

/**
 * Initialization steps, in execution order. The identifiers match the spec
 * table so a failure can name the step that did not pass.
 */
export type MirrorInitStep =
  | "ssh"
  | "helper-dir"
  | "helper-deploy"
  | "helper-start"
  | "env-verify"
  | "adapter-install"
  | "adapter-probe"
  | "forward-self-test"
  | "local-environment"
  | "manifest";

/** A typed failure that has an error code the renderer can localize. */
export interface MirrorFailure {
  code: string;
  message: string;
}

export interface MirrorInitStatus {
  projectGroupId: string;
  state: MirrorInitState;
  /** Steps that produced a valid receipt, in completion order. */
  completedSteps: MirrorInitStep[];
  /** Step currently running, or the step that failed. */
  step: MirrorInitStep | null;
  error: (MirrorFailure & { step: MirrorInitStep }) | null;
}

export type MirrorSyncState = "idle" | "watching" | "syncing" | "paused" | "failed";

/** One snapshot of what the synchronizer is doing for one project. */
export interface MirrorSyncStatus {
  projectGroupId: string;
  state: MirrorSyncState;
  mode: "auto" | "manual";
  /** Paths coalesced and waiting for their debounce window to close. */
  pendingPaths: number;
  /** Files uploaded since the runtime started. */
  uploadedFiles: number;
  /** Remote changes still waiting for a user decision. */
  conflictCount: number;
  /** Files skipped because they exceeded the transfer ceiling. */
  skippedFiles: number;
  lastError: MirrorFailure | null;
}

/**
 * A remote file that diverged from the baseline. Both sides and the baseline are
 * reported so the renderer can show what would be lost either way.
 */
export interface MirrorConflict {
  relPath: string;
  localSize: number;
  localMtimeMs: number;
  remoteSize: number;
  remoteMtimeMs: number;
  /** `null` when the file was never synced, so the remote side is unexpected. */
  baselineSize: number | null;
  baselineMtimeMs: number | null;
}

/**
 * `keep_remote` is the only resolution that writes into the local tree, and it
 * is always an explicit user decision. There is no automatic merge.
 */
export type MirrorConflictResolution = "keep_local" | "keep_remote" | "skip";

export type MirrorRunKind = "build" | "run";

/** One ordered piece of remote command output. */
export interface MirrorRunChunk {
  runId: string;
  projectGroupId: string;
  stream: "stdout" | "stderr";
  text: string;
}

export interface MirrorRunSettled {
  runId: string;
  projectGroupId: string;
  kind: MirrorRunKind;
  status: "succeeded" | "failed" | "cancelled";
  code: number | null;
  /** Bytes the host wrote, including output dropped at the buffer cap. */
  bytes: number;
  truncated: boolean;
}

export interface MirrorRunStarted {
  runId: string;
  projectGroupId: string;
  kind: MirrorRunKind;
}
