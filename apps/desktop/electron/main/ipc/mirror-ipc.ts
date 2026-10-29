import { ErrorCodes, IPC, type MirrorConflict, type MirrorConflictResolution, type MirrorInitStatus, type MirrorRunChunk, type MirrorRunKind, type MirrorRunSettled, type MirrorRunStarted, type MirrorSyncStatus, type ProjectGroupRecord } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { MirrorInitService } from "../mirror/mirror-init";
import type { MirrorRuntimeOptions } from "../mirror/mirror-runtime";
import { mirrorRuntimeRegistry, type MirrorRuntimeRegistry } from "../mirror/mirror-runtime";
import type { RemoteRunHandle, RemoteRunManager } from "../mirror/remote-run";
import type { IpcRegistrar } from "./types";

/** A runtime factory owns the helper client and SSH forward until dispose. */
export type MirrorRuntimeCreation = {
  sync: MirrorRuntimeOptions;
  runManager: RemoteRunManager;
};

export type MirrorIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  sendToRenderer: (channel: string, payload?: unknown) => void;
  /** Creates a project runtime only after the mirror has passed initialization. */
  createRuntime: (group: ProjectGroupRecord) => Promise<MirrorRuntimeCreation>;
  /** A service owns the durable init state machine for one project group. */
  getInitService: (
    group: ProjectGroupRecord,
    onProgress?: (status: MirrorInitStatus) => void,
  ) => Promise<MirrorInitService> | MirrorInitService,
  runtimeRegistry?: MirrorRuntimeRegistry;
};

type MirrorGroup = ProjectGroupRecord & {
  mirror: NonNullable<ProjectGroupRecord["mirror"]>;
};

type StartRunInput = {
  projectGroupId?: unknown;
  kind?: unknown;
  command?: unknown;
};

const MAX_COMMAND_CHARS = 4096;

function invalid(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.INVALID_ARGUMENT });
}

function unavailable(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.HELPER_OPERATION_UNAVAILABLE });
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { errorCode: ErrorCodes.CONFLICT });
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value) {
    throw invalid(`${name} must be a non-empty string`);
  }
  return value;
}

function runKind(value: unknown): MirrorRunKind {
  if (value !== "build" && value !== "run") throw invalid("kind must be build or run");
  return value;
}

function runCommand(value: unknown): string {
  if (typeof value !== "string") throw invalid("command must be a string");
  const command = value.trim();
  if (!command || command.length > MAX_COMMAND_CHARS || /[\u0000-\u001f\u007f]/.test(command)) {
    throw invalid("command is empty, too long, or contains control characters");
  }
  return command;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "errorCode" in error) {
    const code = (error as { errorCode?: unknown }).errorCode;
    if (typeof code === "string" && code) return code;
  }
  return ErrorCodes.INTERNAL;
}

function emit(send: MirrorIpcDependencies["sendToRenderer"], channel: string, payload: unknown): void {
  try {
    send(channel, payload);
  } catch {
    // A renderer can disappear between the state change and the broadcast.
    // The caller still gets the invoke result, and a remounted panel reloads it.
  }
}

/**
 * Registers the main-process half of remote mirror IPC. Handler logic is kept
 * separate from Electron window wiring so the behavior can be tested with a
 * fake `IpcRegistrar` and a fake host; the renderer never gets a client, token,
 * SSH target, or remote path from this module.
 */
export function registerMirrorIpc({
  registrar,
  getHost,
  sendToRenderer,
  createRuntime,
  getInitService,
  runtimeRegistry = mirrorRuntimeRegistry,
}: MirrorIpcDependencies): void {
  const runtimeInFlight = new Map<string, Promise<MirrorRuntimeCreation>>();
  const runHandles = new Map<string, Map<string, RemoteRunHandle>>();

  const host = (): HostProcess => {
    const current = getHost();
    if (!current) throw unavailable("host unavailable");
    return current;
  };

  const getGroup = async (projectGroupId: string): Promise<ProjectGroupRecord> => {
    const current = host();
    const response = (await current.call("project.groups.list")) as {
      groups?: ProjectGroupRecord[];
    };
    const group = response?.groups?.find((candidate) => candidate.id === projectGroupId);
    if (!group) {
      throw Object.assign(new Error("mirror project group not found"), {
        errorCode: ErrorCodes.REMOTE_PATH_NOT_FOUND,
      });
    }
    return group;
  };

  const getMirrorGroup = async (rawId: unknown): Promise<MirrorGroup> => {
    const projectGroupId = requiredText(rawId, "projectGroupId");
    const group = await getGroup(projectGroupId);
    if (!group.mirror) throw invalid("project group is not a mirror project");
    if (group.remote) throw invalid("mirror and remote project bindings are mutually exclusive");
    return group as MirrorGroup;
  };

  const requireReady = async (group: MirrorGroup): Promise<MirrorInitStatus> => {
    const service = await getInitService(group);
    try {
      const status = await service.status(group.id);
      if (status.state !== "ready") {
        throw Object.assign(new Error("mirror initialization must complete before this operation"), {
          errorCode: ErrorCodes.MIRROR_INIT_FAILED,
          data: { step: status.step, state: status.state },
        });
      }
      return status;
    } finally {
      service.close();
    }
  };

  const ensureRuntime = async (group: MirrorGroup): Promise<void> => {
    if (runtimeRegistry.hasRuntime(group.id)) return;
    const pending = runtimeInFlight.get(group.id);
    if (pending) {
      await pending;
      return;
    }
    const creation = createRuntime(group);
    runtimeInFlight.set(group.id, creation);
    try {
      const { sync, runManager } = await creation;
      runtimeRegistry.ensureRuntime(group.id, sync);
      runtimeRegistry.ensureRunManager(group.id, () => runManager);
    } finally {
      if (runtimeInFlight.get(group.id) === creation) runtimeInFlight.delete(group.id);
    }
  };

  const statusFor = async (group: MirrorGroup): Promise<MirrorSyncStatus> => {
    const current = runtimeRegistry.getStatus(group.id);
    if (current) return current;
    return {
      projectGroupId: group.id,
      state: "idle",
      mode: group.mirror.mode,
      pendingPaths: 0,
      uploadedFiles: 0,
      conflictCount: 0,
      skippedFiles: 0,
      lastError: null,
    };
  };

  const emitStatus = async (group: MirrorGroup): Promise<MirrorSyncStatus> => {
    const status = await statusFor(group);
    emit(sendToRenderer, IPC.event.mirrorStatus, status);
    return status;
  };

  registrar.handle(IPC.invoke.mirrorStatusGet, async (input: { projectGroupId?: unknown } = {}) => {
    const group = await getMirrorGroup(input.projectGroupId);
    return { status: await statusFor(group) };
  });

  registrar.handle(IPC.invoke.mirrorSyncStart, async (input: { projectGroupId?: unknown } = {}) => {
    const group = await getMirrorGroup(input.projectGroupId);
    await requireReady(group);
    await ensureRuntime(group);
    const status = runtimeRegistry.startSync(group.id) ?? (await statusFor(group));
    emit(sendToRenderer, IPC.event.mirrorStatus, status);
    return { status };
  });

  registrar.handle(IPC.invoke.mirrorSyncStop, async (input: { projectGroupId?: unknown } = {}) => {
    const group = await getMirrorGroup(input.projectGroupId);
    const status = runtimeRegistry.stopSync(group.id) ?? (await statusFor(group));
    emit(sendToRenderer, IPC.event.mirrorStatus, status);
    return { status };
  });

  registrar.handle(IPC.invoke.mirrorConflictList, async (input: { projectGroupId?: unknown } = {}) => {
    const group = await getMirrorGroup(input.projectGroupId);
    const conflicts = runtimeRegistry.listConflicts(group.id);
    return { conflicts };
  });

  registrar.handle(
    IPC.invoke.mirrorConflictResolve,
    async (input: {
      projectGroupId?: unknown;
      relPath?: unknown;
      resolution?: unknown;
    } = {}) => {
      const group = await getMirrorGroup(input.projectGroupId);
      const relPath = requiredText(input.relPath, "relPath");
      if (
        input.resolution !== "keep_local" &&
        input.resolution !== "keep_remote" &&
        input.resolution !== "skip"
      ) {
        throw invalid("resolution must be keep_local, keep_remote, or skip");
      }
      const resolution: MirrorConflictResolution = input.resolution;
      await requireReady(group);
      const status = await runtimeRegistry.resolveConflict(group.id, relPath, resolution);
      if (!status) throw unavailable("mirror synchronization is not running");
      const conflicts = runtimeRegistry.listConflicts(group.id);
      emit(sendToRenderer, IPC.event.mirrorStatus, status);
      return { conflicts };
    },
  );
  registrar.handle(IPC.invoke.mirrorInitStatusGet, async (input: { projectGroupId?: unknown } = {}) => {
    const group = await getMirrorGroup(input.projectGroupId);
    const service = await getInitService(group);
    try {
      return { init: await service.status(group.id) };
    } finally {
      service.close();
    }
  });

  registrar.handle(IPC.invoke.mirrorInitStart, async (input: { projectGroupId?: unknown } = {}) => {
    const group = await getMirrorGroup(input.projectGroupId);
    const service = await getInitService(group, (status) => {
      emit(sendToRenderer, IPC.event.mirrorInitProgress, status);
    });
    const init = await service.start(group.id);
    emit(sendToRenderer, IPC.event.mirrorInitProgress, init);
    return { init };
  });

  registrar.handle(IPC.invoke.mirrorRunStart, async (input: StartRunInput = {}) => {
    const group = await getMirrorGroup(input.projectGroupId);
    // A refused request must not open a helper connection or a forward, so the
    // caller's own input is checked before any resource is created.
    const kind = runKind(input.kind);
    const command = runCommand(input.command);
    await requireReady(group);
    await ensureRuntime(group);
    const manager = runtimeRegistry.getRunManager(group.id);
    if (!manager) throw unavailable("remote run manager is not available");
    const handle = await manager.start({
      projectId: group.id,
      hostKey: group.mirror.hostKey,
      remotePath: group.mirror.remotePath,
      kind,
      command,
    });
    const started: MirrorRunStarted = {
      runId: handle.id,
      projectGroupId: group.id,
      kind,
    };
    let handles = runHandles.get(group.id);
    if (!handles) {
      handles = new Map();
      runHandles.set(group.id, handles);
    }
    handles.set(handle.id, handle);
    void publishRun(handle, group.id, kind, handles, runHandles, sendToRenderer);
    return started;
  });

  registrar.handle(
    IPC.invoke.mirrorRunCancel,
    async (input: { projectGroupId?: unknown; runId?: unknown } = {}) => {
      const group = await getMirrorGroup(input.projectGroupId);
      const runId = requiredText(input.runId, "runId");
      const handle = runHandles.get(group.id)?.get(runId);
      // Idempotent: a settled or already forgotten run needs no second action.
      if (!handle) return { ok: true };
      await handle.cancel();
      return { ok: true };
    },
  );
}

async function publishRun(
  handle: RemoteRunHandle,
  projectGroupId: string,
  kind: MirrorRunKind,
  handles: Map<string, RemoteRunHandle>,
  allHandles: Map<string, Map<string, RemoteRunHandle>>,
  sendToRenderer: MirrorIpcDependencies["sendToRenderer"],
): Promise<void> {
  try {
    for await (const chunk of handle.chunks) {
      const event: MirrorRunChunk = {
        runId: handle.id,
        projectGroupId,
        stream: chunk.stream,
        text: chunk.text,
      };
      emit(sendToRenderer, IPC.event.mirrorRunChunk, event);
    }
    const outcome = await handle.outcome;
    const settled: MirrorRunSettled = {
      runId: handle.id,
      projectGroupId,
      kind,
      status: outcome.status,
      code: outcome.code,
      bytes: outcome.bytes,
      truncated: outcome.truncated,
    };
    emit(sendToRenderer, IPC.event.mirrorRunSettled, settled);
  } catch (error) {
    const settled: MirrorRunSettled = {
      runId: handle.id,
      projectGroupId,
      kind,
      status: "failed",
      code: null,
      bytes: 0,
      truncated: false,
    };
    emit(sendToRenderer, IPC.event.mirrorRunSettled, settled);
    // Keep the failure typed and diagnosable on the invoke channel without
    // exposing the command line or credentials through the event payload.
    void errorCode(error);
  } finally {
    handles.delete(handle.id);
    if (handles.size === 0) allHandles.delete(projectGroupId);
  }
}

/** Exported for the unit test: it asserts the payload does not grow accidental fields. */
export function mirrorConflictSnapshot(rows: readonly MirrorConflict[]): MirrorConflict[] {
  return rows.map((row) => ({ ...row }));
}
