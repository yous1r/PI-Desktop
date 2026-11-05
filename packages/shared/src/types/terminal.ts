/**
 * Interactive terminal contract for the work-panel terminal.
 *
 * A terminal is one shell process owned by Electron main (a local PTY or a
 * shell spawned on a paired remote `pi-host`); the renderer only ever holds a
 * `terminalId` and an xterm view. The same contract therefore serves a local
 * workspace and a remote one — the renderer never spawns a process and never
 * opens an SSH connection itself.
 *
 * Every request carries the `TerminalTargetContext` it was created for. The
 * context is captured when the tab opens, so a request that outlives a project
 * or session switch still addresses the workspace it belongs to instead of
 * whatever workspace happens to be active in the renderer. Every later action
 * (write, resize, close, replay, buffer) addresses the `terminalId` alone.
 */

export const TERMINAL_SHELL_FAMILIES = [
  "cmd",
  "powershell",
  "pwsh",
  "bash",
  "zsh",
  "fish",
  "wsl",
  "custom",
] as const;

export type TerminalShellFamily = (typeof TERMINAL_SHELL_FAMILIES)[number];

export function isTerminalShellFamily(value: unknown): value is TerminalShellFamily {
  return (
    typeof value === "string" &&
    (TERMINAL_SHELL_FAMILIES as readonly string[]).includes(value)
  );
}

/** One launchable shell. Availability is probed by main, never asserted here. */
export type TerminalShellProfile = {
  /** Stable id, e.g. `pwsh`, `git-bash`, `wsl`. */
  id: string;
  /** Display name, e.g. `PowerShell 7`. */
  label: string;
  /**
   * Absolute executable path as the owning host sees it. Absent for a remote
   * host that reports a label-only catalog, so the renderer must not assume a
   * local filesystem path here.
   */
  path?: string;
  /** Extra argv entries between the program and the interactive session. */
  args?: string[];
  family: TerminalShellFamily;
  /** Marks the profile the terminal opens when no shell is chosen. */
  isDefault?: boolean;
};

export function isTerminalShellProfile(value: unknown): value is TerminalShellProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return (
    typeof profile.id === "string" &&
    profile.id.length > 0 &&
    typeof profile.label === "string" &&
    profile.label.length > 0 &&
    (profile.path === undefined || typeof profile.path === "string") &&
    isTerminalShellFamily(profile.family) &&
    (profile.args === undefined ||
      (Array.isArray(profile.args) &&
        profile.args.every((arg) => typeof arg === "string")))
  );
}

/**
 * The workspace and tab a terminal request belongs to.
 *
 * `workspaceId` is produced by `terminalWorkspaceId` so the renderer and the
 * router agree on one encoding; `sessionId` is the renderer's session id (a
 * `remote:`-prefixed id for a remote session); `tabId` is the work-panel tab
 * that owns the view, which is also the key a detached view re-attaches with.
 *
 * `workspaceId` is a routing *hint*, never an authorization: a renderer could
 * name any `ssh:<hostKey>:<path>`, so the host resolves the machine and the
 * working directory from the durable session/project record it already owns and
 * refuses a target it cannot confirm. Nothing here grants access to a host.
 */
export type TerminalTargetContext = {
  sessionId?: string;
  workspaceId?: string;
  tabId: string;
};

export function isTerminalTargetContext(value: unknown): value is TerminalTargetContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target.tabId === "string" &&
    target.tabId.length > 0 &&
    (target.sessionId === undefined || typeof target.sessionId === "string") &&
    (target.workspaceId === undefined || typeof target.workspaceId === "string")
  );
}

/**
 * Stable identity of a workspace target, encoded as `local:<path>` or
 * `ssh:<hostKey>:<path>`.
 *
 * `hostKey` never contains `:` (see `makeRemoteSessionId`), and a filesystem
 * path may, so only the host key segment is delimited. Returns `undefined`
 * when the target carries neither a host nor a path, which means "the host the
 * session lives on, its default directory".
 */
export function terminalWorkspaceId(
  target?: { hostKey?: string; path?: string } | null,
): string | undefined {
  const hostKey = target?.hostKey?.trim();
  const path = target?.path;
  if (!hostKey && !path) return undefined;
  return hostKey ? `ssh:${hostKey}:${path ?? ""}` : `local:${path ?? ""}`;
}

export function parseTerminalWorkspaceId(
  workspaceId: string,
): { hostKey?: string; path: string } | null {
  if (workspaceId.startsWith("local:")) {
    return { path: workspaceId.slice("local:".length) };
  }
  if (workspaceId.startsWith("ssh:")) {
    const rest = workspaceId.slice("ssh:".length);
    const separator = rest.indexOf(":");
    if (separator <= 0) return null;
    return {
      hostKey: rest.slice(0, separator),
      path: rest.slice(separator + 1),
    };
  }
  return null;
}

/** Input for `terminalCreate`. */
export type TerminalCreateInput = {
  target: TerminalTargetContext;
  shellId: string;
  cols: number;
  rows: number;
  /** Overrides the workspace root as the working directory on that host. */
  cwd?: string;
};

/** Result of `terminalCreate`: the handle the renderer drives afterwards. */
export type TerminalOpenResult = {
  terminalId: string;
  /** Profile id that produced this terminal, for tab labels and restart. */
  shellId: string;
  cols: number;
  rows: number;
};

export function isTerminalOpenResult(value: unknown): value is TerminalOpenResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.terminalId === "string" &&
    result.terminalId.length > 0 &&
    typeof result.shellId === "string" &&
    typeof result.cols === "number" &&
    typeof result.rows === "number"
  );
}

/**
 * Payload of the `terminalData` event: one base64 output chunk.
 *
 * `sequence` is the host's monotonic chunk counter, incremented for every
 * UTF-8-safe output slice. It is absent on older hosts, and the renderer then
 * cannot order a chunk against a replay snapshot — see
 * `terminalChunksAfterSnapshot`.
 */
export type TerminalDataEvent = {
  terminalId: string;
  data: string;
  sequence?: number;
};

/** Payload of the `terminalExit` event. */
export type TerminalExitEvent = {
  terminalId: string;
  exitCode: number | null;
};

export function isTerminalDataEvent(value: unknown): value is TerminalDataEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.terminalId === "string" &&
    typeof event.data === "string" &&
    (event.sequence === undefined || typeof event.sequence === "number")
  );
}

export function isTerminalExitEvent(value: unknown): value is TerminalExitEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.terminalId === "string" &&
    (event.exitCode === null || typeof event.exitCode === "number")
  );
}

/**
 * Result of `terminalReplay`: raw base64 scrollback of a live terminal, ANSI
 * intact. `data` is null when the process already exited and the tab must
 * start a new one instead of re-attaching.
 */
export type TerminalReplayResult = {
  data: string | null;
  /**
   * Sequence of the last output chunk the snapshot contains. Everything that
   * arrived earlier is already painted; only later chunks may be written after
   * it. Absent on older hosts (and on an empty snapshot from one), which makes
   * the ordering unknowable rather than "zero".
   */
  sequence?: number;
};

export function isTerminalReplayResult(value: unknown): value is TerminalReplayResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    (result.data === null || typeof result.data === "string") &&
    (result.sequence === undefined || typeof result.sequence === "number")
  );
}

/**
 * Output that arrives between subscribing to a terminal and reading its
 * snapshot: main can emit a chunk before the `terminalCreate` response, and
 * around the replay.
 */
export type TerminalBufferedChunk = {
  terminalId: string;
  data: string;
  sequence?: number;
};

/** Chunks held while one snapshot is in flight before the buffer is overflowed. */
export const TERMINAL_PENDING_LIMIT_BYTES = 1024 * 1024;

export type TerminalPendingBuffer = {
  chunks: TerminalBufferedChunk[];
  /** Bytes already buffered, measured on the wire payload (base64 length). */
  bytes: number;
  /** Set once the cap is hit; the attach must then resync instead of painting. */
  overflowed: boolean;
};

export function createTerminalPendingBuffer(): TerminalPendingBuffer {
  return { chunks: [], bytes: 0, overflowed: false };
}

/**
 * Append one pre-attach chunk, refusing silently-nothing: overflow is recorded
 * so the pane can state it and resync from a fresh snapshot. Chunks from a
 * terminal other than the one being attached are dropped once the id is known.
 */
export function terminalBufferChunk(
  buffer: TerminalPendingBuffer,
  chunk: TerminalBufferedChunk,
  knownTerminalId?: string,
  limitBytes: number = TERMINAL_PENDING_LIMIT_BYTES,
): void {
  if (buffer.overflowed) return;
  if (knownTerminalId && chunk.terminalId !== knownTerminalId) return;
  if (buffer.bytes + chunk.data.length > limitBytes) {
    buffer.overflowed = true;
    buffer.chunks = [];
    buffer.bytes = 0;
    return;
  }
  buffer.chunks.push(chunk);
  buffer.bytes += chunk.data.length;
}

/**
 * Which buffered chunks still need painting after a snapshot.
 *
 * - Both sides carry a sequence: the snapshot already contains every chunk up
 *   to `snapshotSequence`, so only later ones are written. This is what stops a
 *   chunk that arrived before the snapshot from being painted twice.
 * - Either side lacks one (older host): the order is unknowable, so the
 *   snapshot wins and the buffered chunks are treated as already included. That
 *   matches the previous behaviour of subscribing after the replay — no chunk is
 *   ever painted twice — while still never losing a chunk that arrives after the
 *   snapshot resolves.
 */
export function terminalChunksAfterSnapshot(
  chunks: readonly TerminalBufferedChunk[],
  snapshotSequence: number | undefined,
): { write: TerminalBufferedChunk[]; alreadyIncluded: number } {
  const write: TerminalBufferedChunk[] = [];
  let alreadyIncluded = 0;
  for (const chunk of chunks) {
    const ordered = chunk.sequence !== undefined && snapshotSequence !== undefined;
    if (ordered && chunk.sequence! > snapshotSequence!) {
      write.push(chunk);
    } else {
      alreadyIncluded += 1;
    }
  }
  return { write, alreadyIncluded };
}

/** Result of `terminalGetBuffer`: plain text scrollback for copying. */
export type TerminalBufferResult = {
  text: string;
  truncated?: boolean;
};

export function isTerminalBufferResult(value: unknown): value is TerminalBufferResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.text === "string" &&
    (result.truncated === undefined || typeof result.truncated === "boolean")
  );
}

/**
 * Stable failure codes a terminal request may carry. The renderer turns these
 * into user-facing state: `TERMINAL_HOST_OFFLINE` is the offline state and
 * keeps the tab re-attachable, everything else is a plain failure.
 */
export const TERMINAL_ERROR_CODES = [
  "TERMINAL_HOST_OFFLINE",
  "TERMINAL_HOST_UNSUPPORTED",
  "TERMINAL_SHELL_UNAVAILABLE",
  "TERMINAL_GONE",
  "TERMINAL_LIMIT_REACHED",
] as const;

export type TerminalErrorCode = (typeof TERMINAL_ERROR_CODES)[number];

export function isTerminalErrorCode(value: unknown): value is TerminalErrorCode {
  return (
    typeof value === "string" &&
    (TERMINAL_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** The host that owns the workspace is unreachable right now. */
export function isTerminalOfflineCode(code: unknown): code is TerminalErrorCode {
  return code === "TERMINAL_HOST_OFFLINE";
}

/**
 * Read the stable code out of an IPC rejection.
 *
 * Main answers twice: the preload envelope exposes an `errorCode`, while a
 * router failure surfaces as `data.errorCode` on the RPC error. Both shapes
 * reach the renderer, so both are read here rather than in each caller.
 */
export function terminalErrorCodeOf(error: unknown): TerminalErrorCode | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as Record<string, unknown>;
  const direct = value.errorCode ?? value.code;
  if (isTerminalErrorCode(direct)) return direct;
  const data = value.data ?? value.details;
  if (data && typeof data === "object") {
    const nested = (data as Record<string, unknown>).errorCode;
    if (isTerminalErrorCode(nested)) return nested;
  }
  return undefined;
}
