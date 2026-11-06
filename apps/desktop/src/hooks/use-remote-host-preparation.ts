/**
 * React bindings for `lib/remote-host-preparation`: one subscription per
 * surface, and every request this component opened is released on unmount.
 * Requests opened by another surface are never cancelled from here.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { RemoteProjectEntry } from "../lib/remote-project-catalog";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import {
  remoteHostPreparation,
  type RemoteHostPrepareOptions,
  type RemoteHostPreparationHandle,
  type RemoteHostPreparationSnapshot,
  type RemoteHostPreparationView,
} from "../lib/remote-host-preparation";

export type RemoteHostPreparationControls = {
  snapshot: RemoteHostPreparationSnapshot;
  view: (hostKey: string) => RemoteHostPreparationView | undefined;
  prepare: (hostKey: string, options?: RemoteHostPrepareOptions) => RemoteHostPreparationHandle;
  /** Release this surface's wait on one Host; other waiters stay untouched. */
  cancel: (hostKey: string) => void;
};

/** Subscribe to preparation state and track the waits this component opened. */
export function useRemoteHostPreparation(): RemoteHostPreparationControls {
  const snapshot = useSyncExternalStore(
    remoteHostPreparation.subscribe,
    remoteHostPreparation.getSnapshot,
    remoteHostPreparation.getSnapshot,
  );
  const opened = useRef(new Map<string, string>());

  const prepare = useCallback((hostKey: string, options?: RemoteHostPrepareOptions) => {
    const handle = remoteHostPreparation.prepare(hostKey, options);
    opened.current.set(handle.requestId, hostKey);
    void handle.outcome.finally(() => { opened.current.delete(handle.requestId); });
    return handle;
  }, []);

  const cancel = useCallback((hostKey: string) => {
    for (const [requestId, host] of opened.current) {
      if (host !== hostKey) continue;
      opened.current.delete(requestId);
      remoteHostPreparation.cancel(hostKey, requestId);
    }
  }, []);

  // Unmounting (closing the picker, leaving Settings, switching project) must
  // not leave Main waiting on this caller — but only this caller.
  useEffect(() => {
    const mine = opened.current;
    return () => {
      for (const [requestId, hostKey] of [...mine.entries()]) {
        mine.delete(requestId);
        remoteHostPreparation.cancel(hostKey, requestId);
      }
    };
  }, []);

  const view = useCallback(
    (hostKey: string) => snapshot[hostKey],
    [snapshot],
  );

  return { snapshot, view, prepare, cancel };
}

/**
 * Keep the service aligned with Main's own view. Main reports each phase by
 * refreshing the host list (`sessions:changed` with a `remote.` reason), so this
 * adopts those summaries; it never starts a preparation by itself.
 */
export function useRemoteHostPreparationSync(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let live = true;
    let generation = 0;
    const adopt = async () => {
      const request = ++generation;
      try {
        const { hosts } = await api.listRemoteHosts();
        if (live && request === generation) remoteHostPreparation.adopt(hosts);
      } catch {
        // An unreadable host list changes nothing here; each surface reports its
        // own failure through the channel that owns it.
      }
    };
    void adopt();
    const unsubscribe = api.onSessionsChanged((event) => {
      if (event?.reason && !event.reason.startsWith("remote.")) return;
      void adopt();
    });
    return () => { live = false; unsubscribe(); };
  }, [active]);
}

export type RemoteProjectLaunchState = {
  /** Host this surface is preparing or stopped on, if any. */
  hostKey: string | null;
  /** Failure this surface saw itself, when Main's summary carries none. */
  errorCode: string | null;
  /** The saved project the user asked for, kept for the retry action. */
  project: RemoteProjectEntry | null;
};

const IDLE_LAUNCH: RemoteProjectLaunchState = { hostKey: null, errorCode: null, project: null };

/**
 * Open a saved remote project because the user asked for it — never at
 * startup. Preparation runs first, so a missing release becomes one visible
 * action instead of a failed session creation.
 */
export function useRemoteProjectLaunch() {
  const preparation = useRemoteHostPreparation();
  const [state, setState] = useState<RemoteProjectLaunchState>(IDLE_LAUNCH);
  const pending = useRef<RemoteProjectEntry | null>(null);
  const activeProjectPath = useAppStore(state => state.activeProjectPath);
  useEffect(() => () => {
    const project = pending.current;
    pending.current = null;
    if (project) preparation.cancel(project.hostKey);
  }, [activeProjectPath, preparation.cancel]);

  const run = useCallback(
    async (
      project: RemoteProjectEntry,
      options?: RemoteHostPrepareOptions,
    ): Promise<{ ok: boolean; code: string | null }> => {
      if (pending.current) return { ok: false, code: null };
      pending.current = project;
      setState({ hostKey: project.hostKey, errorCode: null, project });
      const failure = (code: string | null) => {
        setState({ hostKey: project.hostKey, errorCode: code, project });
        return { ok: false, code };
      };
      try {
        const outcome = await preparation.prepare(project.hostKey, options).outcome;
        if (pending.current !== project) return { ok: false, code: null };
        if (!outcome.ok) return failure(outcome.code);
        await useAppStore.getState().newSession({ remoteProject: project });
        if (pending.current === project) setState(IDLE_LAUNCH);
        return { ok: true, code: null };
      } catch (error) {
        const code = error && typeof error === "object"
          ? (error as { errorCode?: unknown }).errorCode ?? (error as { code?: unknown }).code
          : undefined;
        return failure(typeof code === "string" ? code : null);
      } finally {
        if (pending.current === project) pending.current = null;
      }
    },
    [preparation],
  );

  /** The user's answer to a visible stop: consent, maintenance or a retry. */
  const resume = useCallback(
    (options: RemoteHostPrepareOptions) =>
      state.project ? run(state.project, options) : Promise.resolve({ ok: false, code: null }),
    [run, state.project],
  );

  return {
    state,
    view: preparation.view,
    /** Prepare, then open. A stop resolves `ok: false` with a visible state. */
    open: (project: RemoteProjectEntry) => run(project),
    resume,
    /** Release this surface's wait without touching another caller's. */
    cancel: (hostKey: string) => {
      if (pending.current?.hostKey === hostKey) pending.current = null;
      preparation.cancel(hostKey);
    },
    dismiss: () => {
      if (pending.current) preparation.cancel(pending.current.hostKey);
      pending.current = null;
      setState(IDLE_LAUNCH);
    },
  };
}
