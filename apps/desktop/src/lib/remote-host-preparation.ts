/**
 * Renderer half of on-demand Host preparation.
 *
 * Main owns the work: it downloads (through the local global proxy), verifies,
 * uploads over SSH, installs, restarts, and connects. This module owns only
 * what the renderer must own — which callers are waiting, what phase the user
 * should see, and which single action (download / stop remote work / retry)
 * that phase allows. It deliberately holds no workflow inside the app store:
 * the same service is used by the folder picker, the project launcher and
 * Settings, and every caller cancels only its own `requestId`.
 */
import type {
  RemoteHostPreparationPhase,
  RemoteHostPreparationState,
  RemoteHostSummary,
} from "@pi-desktop/shared";
import { api } from "./api";

/** Phases that mean the Host is being worked on right now. */
const ACTIVE_PHASES: ReadonlySet<RemoteHostPreparationPhase> = new Set([
  "checking",
  "awaiting-download",
  "downloading",
  "uploading",
  "installing",
  "awaiting-maintenance",
  "starting",
  "connecting",
]);

/** Terminal phases describe a state the user may act on, not work in flight. */
const TERMINAL_PHASES: ReadonlySet<RemoteHostPreparationPhase> = new Set([
  "ready",
  "failed",
  "cancelled",
]);

export function preparationIsActive(phase: RemoteHostPreparationPhase | undefined): boolean {
  return phase !== undefined && ACTIVE_PHASES.has(phase);
}

export function preparationIsTerminal(phase: RemoteHostPreparationPhase | undefined): boolean {
  return phase !== undefined && TERMINAL_PHASES.has(phase);
}

/** Phases that wait for the user, not for the desktop. */
export function preparationNeedsConsent(phase: RemoteHostPreparationPhase | undefined): boolean {
  return phase === "awaiting-download" || phase === "awaiting-maintenance";
}

export type RemoteHostPreparationView = {
  hostKey: string;
  phase: RemoteHostPreparationPhase;
  /** Release this desktop installs; empty until Main reported one. */
  targetVersion: string;
  /** Version the Host runs now, when Main knows it. */
  currentVersion?: string;
  errorCode?: string;
  /** This renderer is waiting on `remoteHostPrepare` for the Host. */
  pending: boolean;
  /** The one legacy maintenance attempt has already been spent. */
  legacyAttempted: boolean;
};

export type RemoteHostPreparationSnapshot = Readonly<
  Record<string, RemoteHostPreparationView>
>;

export type RemoteHostPrepareOptions = {
  /** Explicit first-download consent; later upgrades reuse Main's receipt. */
  allowDownload?: boolean;
  /** One attempt only, for a Host that predates maintenance admission. */
  allowLegacyMaintenance?: boolean;
  /** Ignore Main's failed-attempt throttle for this release. */
  retry?: boolean;
};

export type RemoteHostPreparationOutcome =
  | { ok: true; host: RemoteHostSummary }
  | { ok: false; code: string; cancelled: boolean };

export type RemoteHostPreparationHandle = {
  requestId: string;
  outcome: Promise<RemoteHostPreparationOutcome>;
};

export type RemoteHostPreparationService = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): RemoteHostPreparationSnapshot;
  /** Take Main's own view of every Host; a Host with a local wait keeps it. */
  adopt(hosts: readonly RemoteHostSummary[]): void;
  prepare(hostKey: string, options?: RemoteHostPrepareOptions): RemoteHostPreparationHandle;
  /** Release one caller; another caller waiting on the same Host is untouched. */
  cancel(hostKey: string, requestId: string): void;
  forget(hostKey: string): void;
};

/** Failure codes are the only thing that decides the next action. */
function phaseForFailure(code: string): RemoteHostPreparationPhase {
  if (code === "HOST_PREPARATION_CANCELLED") return "cancelled";
  if (code === "HOST_DOWNLOAD_REQUIRED") return "awaiting-download";
  if (code === "HOST_MAINTENANCE_REQUIRED") return "awaiting-maintenance";
  if (code === "HOST_BUSY") return "waiting-idle";
  return "failed";
}

function codeOf(error: unknown): string {
  if (error && typeof error === "object") {
    const fields = error as { errorCode?: unknown; code?: unknown };
    const code = fields.errorCode ?? fields.code;
    if (typeof code === "string" && code) return code;
  }
  return "HOST_PREPARATION_FAILED";
}

function viewFromState(
  state: RemoteHostPreparationState,
  previous?: RemoteHostPreparationView,
): RemoteHostPreparationView {
  return {
    hostKey: state.hostKey,
    phase: state.phase,
    targetVersion: state.targetVersion,
    ...(state.currentVersion ? { currentVersion: state.currentVersion } : {}),
    ...(state.errorCode ? { errorCode: state.errorCode } : {}),
    pending: false,
    legacyAttempted: previous?.legacyAttempted === true,
  };
}

let fallbackRequestCounter = 0;

function newRequestId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  fallbackRequestCounter += 1;
  return `prep-${Date.now().toString(36)}-${fallbackRequestCounter.toString(36)}`;
}

export function createRemoteHostPreparationService(): RemoteHostPreparationService {
  let snapshot: RemoteHostPreparationSnapshot = {};
  const listeners = new Set<() => void>();
  /** requestId → host, so a cancel can only ever release its own caller. */
  const outstanding = new Map<string, { hostKey: string }>();

  const publish = (next: Record<string, RemoteHostPreparationView>) => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };
  const write = (view: RemoteHostPreparationView) => {
    publish({ ...snapshot, [view.hostKey]: view });
  };
  const waitsOn = (hostKey: string) => {
    for (const entry of outstanding.values()) if (entry.hostKey === hostKey) return true;
    return false;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,
    adopt(hosts) {
      let next: Record<string, RemoteHostPreparationView> | null = null;
      for (const host of hosts) {
        const pending = waitsOn(host.hostKey);
        const previous = snapshot[host.hostKey];
        const state = host.preparation;
        if (!state) continue;
        if (pending && preparationIsTerminal(state.phase)) continue;
        const adopted = viewFromState(state, previous);
        adopted.pending = pending;
        if (
          previous
          && previous.phase === adopted.phase
          && previous.targetVersion === adopted.targetVersion
          && previous.currentVersion === adopted.currentVersion
          && previous.errorCode === adopted.errorCode
          && previous.pending === adopted.pending
          && previous.legacyAttempted === adopted.legacyAttempted
        ) continue;
        next = { ...(next ?? snapshot), [host.hostKey]: adopted };
      }
      if (next) publish(next);
    },
    prepare(hostKey, options = {}) {
      const requestId = newRequestId();
      outstanding.set(requestId, { hostKey });
      const previous = snapshot[hostKey];
      write({
        hostKey,
        phase: "checking",
        targetVersion: previous?.targetVersion ?? "",
        ...(previous?.currentVersion ? { currentVersion: previous.currentVersion } : {}),
        pending: true,
        legacyAttempted: previous?.legacyAttempted === true || options.allowLegacyMaintenance === true,
      });
      const outcome = api
        .prepareRemoteHost({
          hostKey,
          requestId,
          ...(options.allowDownload === true ? { allowDownload: true } : {}),
          ...(options.allowLegacyMaintenance === true ? { allowLegacyMaintenance: true } : {}),
          ...(options.retry === true ? { retry: true } : {}),
        })
        .then((result): RemoteHostPreparationOutcome => {
          if (!outstanding.has(requestId)) return { ok: false, code: "HOST_PREPARATION_CANCELLED", cancelled: true };
          outstanding.delete(requestId);
          const state = result.host.preparation;
          const settled = state
            ? viewFromState(state, snapshot[hostKey])
            : {
                hostKey,
                phase: "ready" as const,
                targetVersion: snapshot[hostKey]?.targetVersion ?? "",
                pending: false,
                legacyAttempted: snapshot[hostKey]?.legacyAttempted === true,
              };
          // A later caller that already started owns the visible phase.
          if (!waitsOn(hostKey)) write(settled);
          return { ok: true, host: result.host };
        })
        .catch((error: unknown): RemoteHostPreparationOutcome => {
          if (!outstanding.has(requestId)) return { ok: false, code: "HOST_PREPARATION_CANCELLED", cancelled: true };
          const code = codeOf(error);
          outstanding.delete(requestId);
          if (!waitsOn(hostKey)) {
            const current = snapshot[hostKey];
            write({
              hostKey,
              phase: phaseForFailure(code),
              targetVersion: current?.targetVersion ?? "",
              ...(current?.currentVersion ? { currentVersion: current.currentVersion } : {}),
              errorCode: code,
              pending: false,
              legacyAttempted: current?.legacyAttempted === true,
            });
          }
          return { ok: false, code, cancelled: code === "HOST_PREPARATION_CANCELLED" };
        });
      return { requestId, outcome };
    },
    cancel(hostKey, requestId) {
      const entry = outstanding.get(requestId);
      if (!entry || entry.hostKey !== hostKey) return;
      outstanding.delete(requestId);
      // Main releases this waiter only; the job itself keeps running for others
      // and the phase keeps arriving through the host list.
      void api.cancelRemoteHostPreparation({ hostKey, requestId }).catch(() => undefined);
      if (waitsOn(hostKey)) return;
      const current = snapshot[hostKey];
      write({
        hostKey,
        phase: "cancelled",
        targetVersion: current?.targetVersion ?? "",
        ...(current?.currentVersion ? { currentVersion: current.currentVersion } : {}),
        pending: false,
        legacyAttempted: current?.legacyAttempted === true,
      });
    },
    forget(hostKey) {
      if (!snapshot[hostKey]) return;
      const next = { ...snapshot };
      delete next[hostKey];
      publish(next);
    },
  };
}

/**
 * One service for the whole renderer. Views are keyed by Host, so two surfaces
 * looking at the same Host see the same phase while each keeps its own caller.
 */
export const remoteHostPreparation = createRemoteHostPreparationService();
