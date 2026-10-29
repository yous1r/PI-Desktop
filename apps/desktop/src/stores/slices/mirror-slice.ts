import type {
  MirrorConflict,
  MirrorConflictResolution,
  MirrorInitStatus,
  MirrorSyncStatus,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import type {
  AppState,
  MirrorAction,
  MirrorInvokeFailure,
  MirrorProjectRuntime,
} from "../app-state";
import type { StoreAccess } from "./types";

/** The view of a project the panel reads before its first read lands. */
const EMPTY_MIRROR: MirrorProjectRuntime = {
  status: null,
  init: null,
  conflicts: [],
  resolving: {},
  error: null,
  loading: false,
};

/**
 * A mirror project's renderer snapshot. Unknown projects read as an empty
 * snapshot so a panel can mount before `loadMirror` resolves.
 */
export function mirrorRuntime(
  state: AppState,
  projectGroupId: string,
): MirrorProjectRuntime {
  return state.mirrors?.[projectGroupId] ?? EMPTY_MIRROR;
}

/** Read the host's error code off a rejected invoke. */
function mirrorFailure(caught: unknown, action: MirrorAction): MirrorInvokeFailure {
  const code = (caught as { code?: unknown } | null)?.code;
  return {
    code: typeof code === "string" && code ? code : "INTERNAL",
    message: caught instanceof Error ? caught.message : String(caught),
    action,
  };
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export type MirrorSlice = Pick<
  AppState,
  | "mirrors"
  | "loadMirror"
  | "refreshMirrorConflicts"
  | "startMirrorSync"
  | "stopMirrorSync"
  | "startMirrorInit"
  | "resolveMirrorConflict"
  | "retryMirrorAction"
  | "clearMirrorError"
  | "applyMirrorStatus"
  | "applyMirrorInitProgress"
  | "subscribeMirrorEvents"
>;

/**
 * Remote mirror state: one snapshot and one conflict list per project group.
 *
 * The host owns every mirror resource, so this slice never holds a socket, a
 * token or a remote path. It reads snapshots, applies pushed snapshots, and
 * forwards explicit user decisions. A conflict row leaves the list only after
 * the host accepted the decision, because a lost conflict would silently drop
 * the only place the user could still choose.
 */
export function createMirrorSlice({ get, set }: StoreAccess): MirrorSlice {
  const patch = (
    projectGroupId: string,
    update: (runtime: MirrorProjectRuntime) => Partial<MirrorProjectRuntime>,
  ): void => {
    set((state) => ({
      mirrors: {
        ...(state.mirrors ?? {}),
        [projectGroupId]: {
          ...mirrorRuntime(state, projectGroupId),
          ...update(mirrorRuntime(state, projectGroupId)),
        },
      },
    }));
  };

  const applyMirrorStatus = (status: MirrorSyncStatus): void => {
    const projectGroupId = status?.projectGroupId;
    if (!projectGroupId) return;
    // A pushed snapshot is the whole truth for its project: the host emits one
    // after every change, so replacing beats merging stale counters.
    patch(projectGroupId, () => ({ status }));
  };

  const applyMirrorInitProgress = (status: MirrorInitStatus): void => {
    const projectGroupId = status?.projectGroupId;
    if (!projectGroupId) return;
    patch(projectGroupId, () => ({ init: status }));
  };

  return {
    mirrors: {},

    applyMirrorStatus,
    applyMirrorInitProgress,

    loadMirror: async (projectGroupId) => {
      if (!projectGroupId) return;
      patch(projectGroupId, () => ({ loading: true }));
      try {
        const [status, init, conflicts] = await Promise.all([
          api.mirrorStatusGet(projectGroupId),
          api.mirrorInitStatusGet(projectGroupId),
          api.mirrorConflictList(projectGroupId),
        ]);
        patch(projectGroupId, (runtime) => ({
          status: status ?? runtime.status,
          init: init ?? runtime.init,
          conflicts,
          error: null,
          loading: false,
        }));
      } catch (caught) {
        patch(projectGroupId, () => ({
          error: mirrorFailure(caught, "load"),
          loading: false,
        }));
      }
    },

    refreshMirrorConflicts: async (projectGroupId) => {
      if (!projectGroupId) return;
      try {
        const conflicts = await api.mirrorConflictList(projectGroupId);
        patch(projectGroupId, () => ({ conflicts, error: null }));
      } catch (caught) {
        patch(projectGroupId, () => ({ error: mirrorFailure(caught, "load") }));
      }
    },

    startMirrorSync: async (projectGroupId) => {
      if (!projectGroupId) return;
      patch(projectGroupId, () => ({ loading: true }));
      try {
        const status = await api.mirrorSyncStart(projectGroupId);
        patch(projectGroupId, (runtime) => ({
          status: status ?? runtime.status,
          error: null,
          loading: false,
        }));
      } catch (caught) {
        patch(projectGroupId, () => ({
          error: mirrorFailure(caught, "start"),
          loading: false,
        }));
      }
    },

    stopMirrorSync: async (projectGroupId) => {
      if (!projectGroupId) return;
      patch(projectGroupId, () => ({ loading: true }));
      try {
        const status = await api.mirrorSyncStop(projectGroupId);
        patch(projectGroupId, (runtime) => ({
          status: status ?? runtime.status,
          error: null,
          loading: false,
        }));
      } catch (caught) {
        patch(projectGroupId, () => ({
          error: mirrorFailure(caught, "stop"),
          loading: false,
        }));
      }
    },

    startMirrorInit: async (projectGroupId) => {
      if (!projectGroupId) return;
      // The state machine reports through `mirrorInitProgress`; the optimistic
      // row only tells the panel a run is expected, it never claims a step.
      patch(projectGroupId, (runtime) => ({
        init: runtime.init?.state === "initializing"
          ? runtime.init
          : {
              projectGroupId,
              state: "initializing",
              completedSteps: [],
              step: null,
              error: null,
            },
        error: null,
      }));
      try {
        const init = await api.mirrorInitStart(projectGroupId);
        if (init) patch(projectGroupId, () => ({ init }));
      } catch (caught) {
        patch(projectGroupId, () => ({ error: mirrorFailure(caught, "init") }));
      }
    },

    resolveMirrorConflict: async (projectGroupId, relPath, resolution) => {
      if (!projectGroupId || !relPath) return false;
      patch(projectGroupId, (runtime) => ({
        resolving: { ...runtime.resolving, [relPath]: true },
      }));
      try {
        const conflicts = await api.mirrorConflictResolve(
          projectGroupId,
          relPath,
          resolution,
        );
        patch(projectGroupId, (runtime) => {
          const remaining: MirrorConflict[] =
            conflicts ?? runtime.conflicts.filter((row) => row.relPath !== relPath);
          return {
            conflicts: remaining,
            resolving: withoutKey(runtime.resolving, relPath),
            status: runtime.status
              ? { ...runtime.status, conflictCount: remaining.length }
              : runtime.status,
            error: null,
          };
        });
        return true;
      } catch (caught) {
        patch(projectGroupId, (runtime) => ({
          resolving: withoutKey(runtime.resolving, relPath),
          error: mirrorFailure(caught, "resolve"),
        }));
        return false;
      }
    },

    retryMirrorAction: async (projectGroupId) => {
      if (!projectGroupId) return;
      const action = mirrorRuntime(get(), projectGroupId).error?.action ?? "load";
      if (action === "start") {
        await get().startMirrorSync(projectGroupId);
      } else if (action === "stop") {
        await get().stopMirrorSync(projectGroupId);
      } else if (action === "init") {
        await get().startMirrorInit(projectGroupId);
      } else if (action === "resolve") {
        // A resolve retry needs the user's decision again; re-read the conflicts
        // so the row is present and the choice stays visible.
        await get().refreshMirrorConflicts(projectGroupId);
      } else {
        await get().loadMirror(projectGroupId);
      }
    },

    clearMirrorError: (projectGroupId) => {
      if (!projectGroupId) return;
      patch(projectGroupId, () => ({ error: null }));
    },

    /**
     * Subscribe one consumer to the host's mirror events. Each call owns its
     * listener pair, so a remount or a second panel never steals the stream.
     */
    subscribeMirrorEvents: () => {
      const releases = [
        api.onMirrorStatus(applyMirrorStatus),
        api.onMirrorInitProgress(applyMirrorInitProgress),
      ];
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const release of releases) release();
      };
    },
  };
}
