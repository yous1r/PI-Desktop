/**
 * Gate that makes "open a saved remote project" an explicit preparation instead
 * of a passive Host boot.
 *
 * Ordinary remote projects are local project groups whose primary path is
 * `remote-project:<groupId>` and whose workspace carries `remote {hostKey,path}`;
 * they are opened through the same `activateProject` entry point as a local
 * folder. This module owns the workflow for that entry point: resolve the Host
 * that backs the path, prepare it, and only then let the caller activate the
 * project. A preparation that stops for consent or maintenance keeps both the
 * exact project and the caller's promise pending, so the user's Download /
 * Confirm idle / Retry continues the open they actually started.
 *
 * Nothing here runs on hydration, restoration, a `projectPath` reveal or a host
 * list refresh: the only trigger is a caller passing a user activation.
 */
import type { ProjectWorkspace } from "@pi-desktop/shared";
import { api } from "./api";
import {
  remoteHostPreparation,
  type RemoteHostPrepareOptions,
} from "./remote-host-preparation";

/** The Host an ordinary remote project group is bound to. */
export type RemoteProjectHostBinding = { hostKey: string; label?: string };

/** Cache of `remote-project:<id>` → Host, filled from the local group catalog. */
let groupBindings: Map<string, RemoteProjectHostBinding> | null = null;
/** Paths already looked up with a cache miss, so a deleted id cannot loop. */
const refreshed = new Set<string>();

async function loadGroupBindings(): Promise<Map<string, RemoteProjectHostBinding>> {
  const bindings = new Map<string, RemoteProjectHostBinding>();
  try {
    const { groups } = await api.listProjectGroups();
    for (const group of groups) {
      if (!group.remote?.hostKey) continue;
      const binding = { hostKey: group.remote.hostKey, ...(group.name ? { label: group.name } : {}) };
      bindings.set(group.primaryPath, binding);
      for (const root of group.roots) bindings.set(root.path, binding);
    }
  } catch {
    // A catalog that cannot be read is not a reason to block opening a project;
    // it only means this renderer cannot gate on the Host before activation.
    return groupBindings ?? bindings;
  }
  return bindings;
}

/**
 * Which Host backs `path`, or `null` for anything that is not a remote project.
 * Local folders short-circuit before any IPC, so a normal project switch pays
 * nothing for this gate.
 */
export async function resolveRemoteProjectHost(
  path: string,
  known: readonly { path: string; remote?: { hostKey: string } }[] = [],
): Promise<RemoteProjectHostBinding | null> {
  if (!path.startsWith("remote-project:")) return null;
  for (const project of known) {
    if (project.path === path && project.remote?.hostKey) {
      return { hostKey: project.remote.hostKey };
    }
  }
  if (groupBindings?.has(path)) return groupBindings.get(path)!;
  if (refreshed.has(path)) return null;
  refreshed.add(path);
  groupBindings = await loadGroupBindings();
  return groupBindings.get(path) ?? null;
}

/** Forget the catalog cache; the next remote project open refills it once. */
export function forgetRemoteProjectHosts(): void {
  groupBindings = null;
  refreshed.clear();
}

export type RemoteProjectActivationOutcome =
  | { status: "opened"; workspace: ProjectWorkspace | null }
  /** Not a remote project: the caller keeps its ordinary activation path. */
  | { status: "not-remote" }
  /** The gate stopped this attempt; `stoppedFor(path)` stays true for it. */
  | { status: "stopped"; code: string | null; reason: "blocked" | "stale" | "dismissed" };

export type RemoteProjectActivationRequest = {
  /** Project path the user picked. */
  path: string;
  /** Projects this renderer already knows, so a cached binding is not needed. */
  known?: readonly { path: string; remote?: { hostKey: string } }[];
  /** Binding the caller already resolved (a group it just created). */
  hostKey?: string;
  label?: string;
  /** Activate the project through the public entry point, once the Host is ready. */
  activate: (path: string) => Promise<ProjectWorkspace | null>;
  /** The navigation that triggered this open is still the current one. */
  isCurrent: () => boolean;
  /** The user has not switched to another project since this open started. */
  isStillWanted: () => boolean;
};

export type PendingRemoteProject = {
  path: string;
  hostKey: string;
  label?: string;
  /** Main reported work in flight (downloading, installing, connecting…). */
  working: boolean;
};

export type RemoteProjectActivationSnapshot = {
  /** The project waiting on the user, or `null` when nothing is pending. */
  pending: PendingRemoteProject | null;
};

type Pending = {
  token: number;
  request: RemoteProjectActivationRequest;
  hostKey: string;
  /** Preparation callers this gate opened; cancelling releases only these. */
  requests: Set<string>;
  revealed: boolean;
  working: boolean;
  /** The caller waiting for this open to finish or be abandoned. */
  settle: (outcome: RemoteProjectActivationOutcome) => void;
  outcome: Promise<RemoteProjectActivationOutcome>;
};

export type RemoteProjectActivationService = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): RemoteProjectActivationSnapshot;
  /**
   * Prepare, then activate. The promise settles only when the project opens or
   * the attempt is abandoned, so the caller's original action can continue.
   */
  open(request: RemoteProjectActivationRequest): Promise<RemoteProjectActivationOutcome>;
  /** The user's answer to a stop: consent, maintenance confirmation or retry. */
  resume(options?: RemoteHostPrepareOptions): Promise<RemoteProjectActivationOutcome>;
  /** Drop this gate's wait; the pending project is not activated. */
  cancel(): void;
  /** Drop the pending project if the user has since selected another one. */
  syncStillWanted(): void;
  /** True while `path` is the project this gate last stopped on. */
  stoppedFor(path: string): boolean;
};

export function createRemoteProjectActivationService(): RemoteProjectActivationService {
  let snapshot: RemoteProjectActivationSnapshot = { pending: null };
  let pending: Pending | null = null;
  let token = 0;
  let stopped: string | null = null;
  const listeners = new Set<() => void>();

  const publish = () => {
    const next: RemoteProjectActivationSnapshot = {
      pending: !pending || !pending.revealed
        ? null
        : {
            path: pending.request.path,
            hostKey: pending.hostKey,
            ...(pending.request.label ? { label: pending.request.label } : {}),
            working: pending.working,
          },
    };
    if (
      snapshot.pending?.path === next.pending?.path
      && snapshot.pending?.hostKey === next.pending?.hostKey
      && snapshot.pending?.label === next.pending?.label
      && snapshot.pending?.working === next.pending?.working
    ) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  /** Release only the preparation callers this gate opened for one project. */
  const release = (current: Pending) => {
    for (const requestId of current.requests) {
      remoteHostPreparation.cancel(current.hostKey, requestId);
    }
    current.requests.clear();
  };

  /** Finish one attempt: stop waiting, release its callers, answer its caller. */
  const settle = (current: Pending, outcome: RemoteProjectActivationOutcome) => {
    if (pending !== current) return;
    pending = null;
    token += 1;
    release(current);
    publish();
    current.settle(outcome);
  };

  const abandon = (reason: "stale" | "dismissed", code: string | null = null) => {
    const current = pending;
    if (!current) return;
    stopped = current.request.path;
    settle(current, { status: "stopped", code, reason });
  };

  const startPrepare = (current: Pending, options?: RemoteHostPrepareOptions) => {
    const handle = remoteHostPreparation.prepare(current.hostKey, options);
    current.requests.add(handle.requestId);
    void handle.outcome.finally(() => { current.requests.delete(handle.requestId); });
    return handle;
  };

  const current = (entry: Pending) => pending === entry && entry.token === token;

  async function run(entry: Pending, options?: RemoteHostPrepareOptions) {
    entry.working = true;
    publish();
    const outcome = await startPrepare(entry, options).outcome;
    // A newer open replaced this attempt; that one answers its own caller.
    if (!current(entry)) return;
    if (!entry.request.isCurrent() || !entry.request.isStillWanted()) {
      abandon("stale", outcome.ok ? null : outcome.code);
      return;
    }
    if (!outcome.ok) {
      // A stop is the user's next decision, not a failure of the open: keep the
      // project and the caller waiting until Download / Confirm idle / Retry.
      entry.working = false;
      entry.revealed = true;
      stopped = entry.request.path;
      publish();
      return;
    }
    // Ready: leave the gate before activating so nothing can resume twice.
    entry.working = false;
    pending = null;
    token += 1;
    release(entry);
    publish();
    let workspace: ProjectWorkspace | null = null;
    try {
      workspace = await entry.request.activate(entry.request.path);
    } catch (error) {
      entry.settle({
        status: "stopped",
        code: error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : null,
        reason: "blocked",
      });
      return;
    }
    entry.settle({ status: "opened", workspace });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,
    async open(request) {
      const binding = request.hostKey
        ? { hostKey: request.hostKey, ...(request.label ? { label: request.label } : {}) }
        : await resolveRemoteProjectHost(request.path, request.known ?? []);
      if (!request.isCurrent() || !request.isStillWanted()) return { status: "stopped", code: null, reason: "stale" };
      if (!binding) return { status: "not-remote" };
      // A second pick supersedes the first: the older caller is told it stopped.
      abandon("dismissed");
      stopped = null;
      const entry = {
        token: ++token,
        request: request.label || !binding.label ? request : { ...request, label: binding.label },
        hostKey: binding.hostKey,
        requests: new Set<string>(),
        revealed: true,
        working: false,
      } as Pending;
      entry.outcome = new Promise<RemoteProjectActivationOutcome>((resolve) => {
        entry.settle = resolve;
      });
      pending = entry;
      publish();
      void run(entry);
      return entry.outcome;
    },
    resume(options) {
      const entry = pending;
      if (!entry) {
        return Promise.resolve<RemoteProjectActivationOutcome>({
          status: "stopped",
          code: null,
          reason: "dismissed",
        });
      }
      if (entry.working) return entry.outcome;
      if (!entry.request.isStillWanted() || !entry.request.isCurrent()) {
        abandon("stale");
        return Promise.resolve<RemoteProjectActivationOutcome>({
          status: "stopped",
          code: null,
          reason: "stale",
        });
      }
      entry.revealed = true;
      publish();
      void run(entry, options);
      // The original caller and this answer both settle with the same outcome.
      return entry.outcome;
    },
    cancel() {
      abandon("dismissed");
    },
    syncStillWanted() {
      if (pending && !pending.request.isStillWanted()) abandon("stale");
    },
    stoppedFor: (path) => stopped !== null && stopped === path,
  };
}

/**
 * One gate for the whole renderer: the switcher, the sidebar and the project
 * archive all reach the same entry point, so they share one pending project and
 * one preparation instead of one dialog each.
 */
export const remoteProjectActivation = createRemoteProjectActivationService();
