import { randomUUID } from "node:crypto";
import type { RemoteHostPrepareRequest, RemoteHostPreparationPhase, RemoteHostPreparationState, RemoteHostSummary } from "@pi-desktop/shared";
import type { RemoteHostRecord, RemoteHostRegistry } from "./remote-host-registry.js";
import { sshMetadataOf } from "./remote-host-metadata.js";

export type PreparationRunOptions = {
  signal: AbortSignal;
  allowLegacyMaintenance: boolean;
  currentVersion?: string;
  progress: (phase: RemoteHostPreparationPhase) => void;
};
type Options = {
  version: string;
  registry: Pick<RemoteHostRegistry, "list" | "upsert">;
  connect(record: RemoteHostRecord, signal: AbortSignal): Promise<void>;
  upgrade(record: RemoteHostRecord, options: PreparationRunOptions): Promise<RemoteHostRecord>;
  summary(record: RemoteHostRecord): RemoteHostSummary;
  changed(): void;
  now?: () => number;
  track?<T>(action: () => Promise<T>): Promise<T>;
};
type Job = { controller: AbortController; callers: Set<string>; promise: Promise<RemoteHostSummary> };
const RETRY_AFTER_MS = 10 * 60 * 1000;
const repairable = new Set(["HOST_VERSION_MISMATCH", "HOST_NOT_INSTALLED", "HOST_INSTALL_DAMAGED"]);
const expectedStops = new Set(["HOST_DOWNLOAD_REQUIRED", "HOST_MAINTENANCE_REQUIRED", "HOST_BUSY"]);
export function preparationErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "HOST_BOOTSTRAP_FAILED";
  if ("name" in error && error.name === "AbortError") return "HOST_PREPARATION_CANCELLED";
  const code = "errorCode" in error ? error.errorCode : "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,80}$/.test(code) ? code : "HOST_BOOTSTRAP_FAILED";
}
function fail(code: string): Error {
  return Object.assign(new Error(code), { errorCode: code });
}
function versionFrom(error: unknown): string | undefined {
  if (error && typeof error === "object" && "remoteVersion" in error && typeof error.remoteVersion === "string") return error.remoteVersion;
  return undefined;
}

/** Owns only preparation: connection/catalog business stays with the boot facade. */
export function createRemoteHostPreparer(options: Options) {
  const jobs = new Map<string, Job>();
  const waiters = new Map<string, { hostKey: string; cancel(): void }>();
  const states = new Map<string, RemoteHostPreparationState>();
  const now = options.now ?? Date.now;
  let disposed = false;
  const state = (hostKey: string, phase: RemoteHostPreparationPhase, currentVersion?: string, errorCode?: string) => {
    states.set(hostKey, { hostKey, targetVersion: options.version, phase,
      ...(currentVersion ? { currentVersion } : {}), ...(errorCode ? { errorCode } : {}) });
    if (!disposed) options.changed();
  };
  const run = async (request: RemoteHostPrepareRequest, signal: AbortSignal) => {
    let record: RemoteHostRecord | undefined;
    let currentVersion: string | undefined;
    let attempted = false;
    try {
      signal.throwIfAborted();
      record = (await options.registry.list()).find(item => item.hostKey === request.hostKey);
      signal.throwIfAborted();
      if (!record) throw fail("AGENT_UNAVAILABLE");
      state(record.hostKey, "checking");
      try {
        await options.connect(record, signal);
        signal.throwIfAborted();
        state(record.hostKey, "ready", options.version);
        return options.summary(record);
      } catch (error) {
        signal.throwIfAborted();
        if (!repairable.has(preparationErrorCode(error))) throw error;
        currentVersion = versionFrom(error) ?? (preparationErrorCode(error) === "HOST_VERSION_MISMATCH" ? sshMetadataOf(record)?.version : undefined);
        if (!sshMetadataOf(record)) throw error;
        if (sshMetadataOf(record)?.auth === "password" && !record.sshSecret) throw fail("SSH_AUTH_FAILED");
      }
      if (!request.allowDownload && record.metadata?.piHostDownloadConsent !== true) throw fail("HOST_DOWNLOAD_REQUIRED");
      const receipt = record.metadata?.piHostPreparationAttempt;
      if (!request.retry && receipt && typeof receipt === "object") {
        const r = receipt as Record<string, unknown>;
        if (r.version === options.version && typeof r.at === "number" && r.succeeded === false && now() - r.at < RETRY_AFTER_MS) {
          throw fail(typeof r.errorCode === "string" && /^[A-Z_]+$/.test(r.errorCode) ? r.errorCode : "HOST_BOOTSTRAP_FAILED");
        }
      }
      record = { ...record, metadata: { ...record.metadata, piHostDownloadConsent: true } };
      await options.registry.upsert(record);
      signal.throwIfAborted();
      attempted = true;
      const updated = await options.upgrade(record, { signal, currentVersion,
        allowLegacyMaintenance: request.allowLegacyMaintenance === true,
        progress: phase => { if (!signal.aborted) state(request.hostKey, phase, currentVersion); },
      });
      signal.throwIfAborted();
      state(record.hostKey, "connecting", currentVersion);
      await options.connect(updated, signal);
      signal.throwIfAborted();
      const verified = { ...updated, metadata: { ...updated.metadata, piHostDownloadConsent: true,
        piHostPreparationAttempt: { version: options.version, at: now(), succeeded: true } } };
      await options.registry.upsert(verified);
      signal.throwIfAborted();
      state(record.hostKey, "ready", options.version);
      return options.summary(verified);
    } catch (error) {
      const code = signal.aborted ? "HOST_PREPARATION_CANCELLED" : preparationErrorCode(error);
      const phase = code === "HOST_DOWNLOAD_REQUIRED" ? "awaiting-download"
        : code === "HOST_MAINTENANCE_REQUIRED" ? "awaiting-maintenance"
        : code === "HOST_BUSY" ? "waiting-idle" : signal.aborted ? "cancelled" : "failed";
      state(request.hostKey, phase, currentVersion, code);
      if (record && attempted && !signal.aborted && !expectedStops.has(code)) {
        // Do not overwrite a refreshed descriptor if deployment succeeded but reconnect failed.
        const latest = (await options.registry.list()).find(item => item.hostKey === request.hostKey);
        if (latest) await options.registry.upsert({ ...latest, metadata: { ...latest.metadata,
          piHostPreparationAttempt: { version: options.version, at: now(), succeeded: false, errorCode: code } } });
      }
      if (signal.aborted) throw fail("HOST_PREPARATION_CANCELLED");
      throw error;
    }
  };

  function prepare(request: RemoteHostPrepareRequest): Promise<RemoteHostSummary> {
    if (disposed) return Promise.reject(fail("AGENT_UNAVAILABLE"));
    const id = `${request.hostKey}\0${request.requestId}`;
    if (waiters.has(id) || waiters.size >= 128) return Promise.reject(fail("INVALID_ARGUMENT"));
    let job = jobs.get(request.hostKey);
    if (job?.controller.signal.aborted) return Promise.reject(fail("HOST_BUSY"));
    if (!job) {
      const controller = new AbortController();
      job = { controller, callers: new Set(), promise: options.track
        ? options.track(() => Promise.resolve().then(() => run(request, controller.signal)))
        : Promise.resolve().then(() => run(request, controller.signal)) };
      jobs.set(request.hostKey, job);
      const owned = job;
      void job.promise.finally(() => { if (jobs.get(request.hostKey) === owned) jobs.delete(request.hostKey); }).catch(() => undefined);
    }
    const active = job;
    active.callers.add(id);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, result?: RemoteHostSummary) => {
        if (settled) return;
        settled = true;
        active.callers.delete(id);
        waiters.delete(id);
        if (error) reject(error); else resolve(result!);
      };
      waiters.set(id, { hostKey: request.hostKey, cancel() {
        finish(fail("HOST_PREPARATION_CANCELLED"));
        if (active.callers.size === 0) active.controller.abort();
      } });
      void active.promise.then(result => finish(undefined, result), error => finish(error));
    });
  }
  return {
    prepare,
    ensureReady: (hostKey: string) => prepare({ hostKey, requestId: randomUUID() }),
    state: (hostKey: string) => states.get(hostKey),
    cancel: (hostKey: string, requestId: string) => waiters.get(`${hostKey}\0${requestId}`)?.cancel(),
    async forget(hostKey: string) {
      for (const waiter of [...waiters.values()]) if (waiter.hostKey === hostKey) waiter.cancel();
      await jobs.get(hostKey)?.promise.catch(() => undefined);
      states.delete(hostKey);
    },
    async dispose() {
      disposed = true;
      for (const waiter of [...waiters.values()]) waiter.cancel();
      for (const job of jobs.values()) job.controller.abort();
      await Promise.allSettled([...jobs.values()].map(job => job.promise));
    },
  };
}
