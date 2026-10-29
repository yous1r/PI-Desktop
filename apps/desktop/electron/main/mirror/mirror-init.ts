/**
 * Mirror environment initialization (spec 23 §4).
 *
 * One project group goes from `needs-init` to `ready` through ten ordered steps,
 * each a real side effect on the remote host or in host-core. The order of writes
 * is what makes the sequence resumable: `initializing` with the running step is
 * stored before a step runs, the step's receipt after it passes. The resume point
 * is therefore the first step without a receipt — never "start over", never the
 * step the state row happens to name.
 *
 * Nothing here owns a resource: the SSH transport, the helper client and the
 * bundle are injected ports, so every step's pass and fail path is reachable
 * without a real remote host. Two §4 steps have no implementation in this build
 * (the forward self-test, and `env.json` plus the baseline scan); without their
 * port they report their §4 failure code rather than a receipt for work that
 * never happened.
 */

import type {
  MirrorFailure,
  MirrorInitState,
  MirrorInitStatus,
  MirrorInitStep,
} from "@pi-desktop/shared";
import type { SshTransport } from "../remote/ssh-transport.js";
import {
  createHelperAdapters,
  type AdapterManifestEntry,
  type HelperAdapters,
} from "./helper-adapters.ts";
import { deployBundledHelper } from "./helper-bootstrap.ts";
import type { HelperArtifact } from "./helper-bundle.ts";
import type { HelperClient } from "./helper-client.ts";

/** The §4 failure codes a step may report. */
export type MirrorInitFailureCode =
  | "REMOTE_CONNECTION_FAILED"
  | "HELPER_DIR_UNWRITABLE"
  | "HELPER_DEPLOY_FAILED"
  | "HELPER_START_FAILED"
  | "MIRROR_INIT_FAILED"
  | "DEBUG_ADAPTER_INSTALL_FAILED"
  | "DEBUG_ADAPTER_VERSION_MISMATCH"
  | "REMOTE_FORWARD_FAILED";

/** The ten steps in execution order; host-core validates against the same order. */
export const MIRROR_INIT_STEPS: readonly MirrorInitStep[] = [
  "ssh",
  "helper-dir",
  "helper-deploy",
  "helper-start",
  "env-verify",
  "adapter-install",
  "adapter-probe",
  "forward-self-test",
  "local-environment",
  "manifest",
];

const INIT_STATES: readonly MirrorInitState[] = ["needs-init", "initializing", "ready", "init-failed"];

/**
 * What a step reports when it did not pass. The message is fixed per step, so no
 * transport text, token or remote path can reach the renderer, a receipt or the
 * host database.
 */
const STEP_FAILURES: Record<MirrorInitStep, { code: MirrorInitFailureCode; message: string }> = {
  ssh: { code: "REMOTE_CONNECTION_FAILED", message: "The remote host did not answer over SSH." },
  "helper-dir": { code: "HELPER_DIR_UNWRITABLE", message: "The remote helper directory is missing, not writable, or below the disk budget." },
  "helper-deploy": { code: "HELPER_DEPLOY_FAILED", message: "The bundled remote helper could not be installed." },
  "helper-start": { code: "HELPER_START_FAILED", message: "The remote helper did not start or did not complete its handshake." },
  "env-verify": { code: "MIRROR_INIT_FAILED", message: "The remote helper could not verify its environment." },
  "adapter-install": { code: "DEBUG_ADAPTER_INSTALL_FAILED", message: "The bundled debug adapter could not be installed." },
  "adapter-probe": { code: "DEBUG_ADAPTER_VERSION_MISMATCH", message: "The installed debug adapter does not match the pinned manifest." },
  "forward-self-test": { code: "REMOTE_FORWARD_FAILED", message: "A loopback forward to the remote helper could not be opened." },
  "local-environment": { code: "MIRROR_INIT_FAILED", message: "The local part of this mirror project is not usable." },
  manifest: { code: "MIRROR_INIT_FAILED", message: "The mirror manifest or baseline could not be recorded." },
};

const SSH_TIMEOUT_MS = 30_000;
const QUERY_TIMEOUT_MS = 15_000;
/** §4 step 2: at least 500 MB free on the helper directory's filesystem. */
const MIN_HELPER_FREE_KB = 500 * 1024;

/**
 * §4 step 2 in one bounded command. The bootstrap script creates the directory
 * anyway; preparing it here makes an unwritable root or a full disk fail as
 * `HELPER_DIR_UNWRITABLE` before a byte of the binary is uploaded.
 */
const HELPER_ROOT_SCRIPT = `set -eu
umask 077
fail() { printf 'PI_HELPER_DIR_FAIL %s\\n' "$1"; exit 1; }
[ -n "\${HOME:-}" ] || fail no-home
base="$HOME/.pi-desktop-helper"
[ -L "$base" ] && fail unsafe-root
[ -e "$base" ] && [ ! -d "$base" ] && fail not-directory
mkdir -p "$base" || fail create
chmod 700 "$base" || fail mode
[ -L "$base" ] && fail unsafe-root
probe="$base/.init-probe"
( : > "$probe" ) || fail not-writable
rm -f -- "$probe"
free_kb=$(df -Pk "$base" 2>/dev/null | awk 'NR==2 {print $4}')
case "$free_kb" in ''|*[!0-9]*) fail no-disk-report ;; esac
[ "$free_kb" -ge ${MIN_HELPER_FREE_KB} ] || fail disk-budget
printf 'PI_HELPER_DIR_OK free_kb=%s\\n' "$free_kb"
`;

/** The reason tokens of that script: the only host-side text this module repeats. */
const HELPER_ROOT_REASONS = new Set([
  "no-home",
  "unsafe-root",
  "not-directory",
  "create",
  "mode",
  "not-writable",
  "no-disk-report",
  "disk-budget",
]);

/** The host RPC surface this service needs; `host.call` is the whole contract. */
export type MirrorInitHost = {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

/**
 * A ready client or a provider for one. Production needs the provider: the
 * connection can only exist once the helper runs (step 3), and after a crash the
 * provider is what re-reads the ready line and token without redeploying.
 */
export type MirrorInitClientSource = HelperClient | (() => Promise<HelperClient>);

export type MirrorInitLogger = {
  warn(message: string, data?: Record<string, unknown>): void;
};

export type MirrorInitServiceOptions = {
  host: MirrorInitHost;
  client: MirrorInitClientSource;
  logger?: MirrorInitLogger;
  /** Injected clock so receipts and state writes stay deterministic in tests. */
  now?: () => number;
  /** SSH exec for the steps that run before the helper exists. */
  transport?: SshTransport;
  /** Desktop release version the deployed helper must match. */
  desktopVersion?: string;
  /** Bundled helper binary, resolved lazily because a resume may not need it. */
  helperArtifact?: () => Promise<HelperArtifact>;
  /**
   * The project's mirror root on the host. Step 5 registers it with the helper,
   * so a missing directory, or one that overlaps the helper directory, fails
   * initialization instead of the first sync. The path is never logged.
   */
  mirrorRoot?: string;
  /** Called immediately after an idempotent deploy returns its port and token. */
  onHelperReady?: (ready: import("./helper-bootstrap.ts").HelperReady) => void;
  /** Releases an injected SSH transport when this init run closes its client. */
  onClose?: () => void;
  /** Adapters the bundled manifest pins for this remote target. */
  adapterManifest?: readonly AdapterManifestEntry[];
  /** Bundled payload of one pinned entry: a local path or its bytes. */
  adapterPayload?: (entry: AdapterManifestEntry) => string | Uint8Array;
  /** Opens one loopback forward to the helper, connects, and closes it again. */
  forwardSelfTest?: () => Promise<void>;
  /** Writes `env.json` atomically over SSH and reports its digest. */
  writeEnvManifest?: () => Promise<{ sha256: string }>;
  /** Stores the baseline scan in host-core and reports the entry count. */
  storeBaseline?: () => Promise<{ entries: number }>;
  /** Pushes each persisted state transition to the main-process owner. */
  onProgress?: (status: MirrorInitStatus) => void;
};

const defaultLogger: MirrorInitLogger = {
  warn(message, data) {
    // The main-process logger is unavailable during early boot and shutdown, so
    // the sink that always works is the console.
    console.warn(`[mirror-init] ${message}`, data ?? {});
  },
};

/**
 * A step failure this module built. Only these carry a message into the stored
 * `error`: a transport or helper error can quote an ssh diagnostic or a remote
 * path, and neither may reach the renderer, a receipt or the database (§10.7).
 */
class MirrorInitStepError extends Error {
  readonly errorCode: MirrorInitFailureCode;

  constructor(message: string, errorCode: MirrorInitFailureCode) {
    super(message);
    this.name = "MirrorInitStepError";
    this.errorCode = errorCode;
  }
}

function stepError(message: string, errorCode: MirrorInitFailureCode): MirrorInitStepError {
  return new MirrorInitStepError(message, errorCode);
}

/** The §4 failure of one step, optionally naming one of this module's reasons. */
function fail(step: MirrorInitStep, reason?: string | null): MirrorInitStepError {
  const planned = STEP_FAILURES[step];
  return stepError(reason ? `${planned.message} (${reason})` : planned.message, planned.code);
}

function errorCodeOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const code = (value as { errorCode?: unknown }).errorCode;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function isFailureCode(value: string): value is MirrorInitFailureCode {
  return Object.values(STEP_FAILURES).some((failure) => failure.code === value);
}

function isState(value: unknown): value is MirrorInitState {
  return typeof value === "string" && (INIT_STATES as readonly string[]).includes(value);
}

function isStep(value: unknown): value is MirrorInitStep {
  return typeof value === "string" && (MIRROR_INIT_STEPS as readonly string[]).includes(value);
}

function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw stepError(`The host reported an invalid ${what}`, "MIRROR_INIT_FAILED");
  }
  return value as Record<string, unknown>;
}

/**
 * Reads a `mirror.init.status` payload into the wire `MirrorInitStatus`, field by
 * field: a host reporting a state or step this module does not know would
 * otherwise drive the sequence from an invented value.
 */
export function parseMirrorInitStatus(raw: unknown, projectGroupId: string): MirrorInitStatus {
  const record = recordOf(raw, "mirror init status");
  if (!isState(record.state)) throw stepError("The host reported an unknown mirror init state", "MIRROR_INIT_FAILED");
  const step = record.step ?? null;
  if (step !== null && !isStep(step)) throw stepError("The host reported an unknown mirror init step", "MIRROR_INIT_FAILED");
  if (!Array.isArray(record.completedSteps)) throw stepError("The host reported no completed steps", "MIRROR_INIT_FAILED");
  const completedSteps: MirrorInitStep[] = [];
  for (const entry of record.completedSteps) {
    if (!isStep(entry)) throw stepError("The host reported an unknown mirror init step", "MIRROR_INIT_FAILED");
    completedSteps.push(entry);
  }
  let error: (MirrorFailure & { step: MirrorInitStep }) | null = null;
  if (record.error !== null && record.error !== undefined) {
    const failure = recordOf(record.error, "mirror init failure");
    if (typeof failure.code !== "string" || !failure.code) throw stepError("The host reported a failure without a code", "MIRROR_INIT_FAILED");
    if (typeof failure.message !== "string" || !failure.message) throw stepError("The host reported a failure without a message", "MIRROR_INIT_FAILED");
    // A failure without a step cannot say where a retry resumes (§4).
    const failureStep = isStep(failure.step) ? failure.step : step;
    if (failureStep === null) throw stepError("The host reported a failure without a step", "MIRROR_INIT_FAILED");
    error = { code: failure.code, message: failure.message, step: failureStep };
  }
  return {
    projectGroupId:
      typeof record.projectGroupId === "string" && record.projectGroupId.length > 0
        ? record.projectGroupId
        : projectGroupId,
    state: record.state,
    step,
    completedSteps,
    error,
  };
}

/**
 * Drives §4 for one project group at a time. `start` joins the in-flight sequence
 * of the same project instead of running a second one, and a run whose steps all
 * have receipts only rewrites `ready`.
 */
export class MirrorInitService {
  private readonly host: MirrorInitHost;
  private readonly clientSource: MirrorInitClientSource;
  private readonly logger: MirrorInitLogger;
  private readonly now: () => number;
  private readonly transport: SshTransport | undefined;
  private readonly desktopVersion: string | undefined;
  private readonly helperArtifact: (() => Promise<HelperArtifact>) | undefined;
  private readonly mirrorRoot: string | undefined;
  private readonly adapterManifest: readonly AdapterManifestEntry[];
  private readonly adapterPayload: ((entry: AdapterManifestEntry) => string | Uint8Array) | undefined;
  private readonly forwardSelfTest: (() => Promise<void>) | undefined;
  private readonly writeEnvManifest: (() => Promise<{ sha256: string }>) | undefined;
  private readonly storeBaseline: (() => Promise<{ entries: number }>) | undefined;
  private readonly onHelperReady: MirrorInitServiceOptions["onHelperReady"];
  private readonly onClose: MirrorInitServiceOptions["onClose"];
  private readonly onProgress: MirrorInitServiceOptions["onProgress"];
  private readonly pending = new Map<string, Promise<MirrorInitStatus>>();
  private connection: Promise<HelperClient> | null = null;
  private adapters: HelperAdapters | null = null;

  constructor(options: MirrorInitServiceOptions) {
    this.host = options.host;
    this.clientSource = options.client;
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? Date.now;
    this.onHelperReady = options.onHelperReady;
    this.onClose = options.onClose;
    this.onProgress = options.onProgress;
    this.transport = options.transport;
    this.desktopVersion = options.desktopVersion;
    this.helperArtifact = options.helperArtifact;
    this.mirrorRoot = options.mirrorRoot;
    this.adapterManifest = options.adapterManifest ?? [];
    this.adapterPayload = options.adapterPayload;
    this.forwardSelfTest = options.forwardSelfTest;
    this.writeEnvManifest = options.writeEnvManifest;
    this.storeBaseline = options.storeBaseline;
  }

  /** The stored initialization status of one project group. */
  async status(projectGroupId: string): Promise<MirrorInitStatus> {
    const key = requireGroupId(projectGroupId);
    return parseMirrorInitStatus(await this.host.call("mirror.init.status", { projectId: key }), key);
  }

  /**
   * Runs or resumes initialization and reports the state it settled in.
   *
   * Resolves with `init-failed` for a step failure, because a failed step is a
   * normal outcome. Rejects only when host-core cannot be reached: then there is
   * no truthful status to report and no resume point to return.
   */
  start(projectGroupId: string): Promise<MirrorInitStatus> {
    const key = requireGroupId(projectGroupId);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const run = this.runSequence(key);
    // Registered before returning, so a second caller in the same tick joins
    // this sequence instead of starting another against the same receipts.
    this.pending.set(key, run);
    void run
      .finally(() => {
        if (this.pending.get(key) === run) this.pending.delete(key);
      })
      .catch(() => undefined);
    return run;
  }

  /** Releases the helper connection this service opened; injected ports stay owned by the caller. */
  close(): void {
    const connection = this.connection;
    this.connection = null;
    this.adapters = null;
    if (connection) void connection.then((client) => client.close()).catch(() => undefined);
    try {
      this.onClose?.();
    } catch {
      // Closing a helper client is already best effort; cleanup may not make a
      // truthful initialization outcome less truthful.
    }
  }

  private async runSequence(key: string): Promise<MirrorInitStatus> {
    const current = await this.status(key);
    // Receipts, not the state row, decide what is done: a receipt is only written
    // after a step passed, so this set is the exact resume point.
    const completed = new Set<MirrorInitStep>(current.completedSteps);
    for (const step of MIRROR_INIT_STEPS) {
      if (completed.has(step)) continue;
      await this.writeState(key, "initializing", step, null);
      let receipt: Record<string, unknown>;
      try {
        receipt = await this.runStep(key, step);
      } catch (error) {
        return await this.recordFailure(key, step, error);
      }
      await this.host.call("mirror.init.receipt.upsert", {
        projectId: key,
        step,
        receipt,
        updatedAt: this.now(),
      });
    }
    // The initialization connection is not the synchronization transport, so it
    // is not kept open past the step that needed it.
    this.close();
    return await this.writeState(key, "ready", null, null);
  }

  private async recordFailure(key: string, step: MirrorInitStep, error: unknown): Promise<MirrorInitStatus> {
    const own = error instanceof MirrorInitStepError;
    const reported = errorCodeOf(error);
    const code = own
      ? error.errorCode
      : reported !== null && isFailureCode(reported)
        ? reported
        : STEP_FAILURES[step].code;
    // Only the code and the step are logged: a transport message can quote an ssh
    // diagnostic or a remote path (spec 23 §10.7).
    this.warn("mirror initialization step failed", { projectGroupId: key, step, code });
    // A failed step can leave a half-open connection behind; the retry reconnects.
    this.close();
    const message = own ? error.message : STEP_FAILURES[step].message;
    return await this.writeState(key, "init-failed", step, { code, message, step });
  }

  private async writeState(
    key: string,
    state: MirrorInitState,
    step: MirrorInitStep | null,
    error: (MirrorFailure & { step: MirrorInitStep }) | null,
  ): Promise<MirrorInitStatus> {
    const params: Record<string, unknown> = { projectId: key, state };
    if (step !== null) params.step = step;
    if (error !== null) params.error = { code: error.code, message: error.message, step: error.step };
    const status = parseMirrorInitStatus(await this.host.call("mirror.init.state", params), key);
    try {
      this.onProgress?.(status);
    } catch {
      // A dead renderer cannot invalidate the state already persisted in the host.
    }
    return status;
  }

  private runStep(key: string, step: MirrorInitStep): Promise<Record<string, unknown>> {
    switch (step) {
      case "ssh":
        return this.checkSsh();
      case "helper-dir":
        return this.checkHelperRoot();
      case "helper-deploy":
        return this.deployHelper();
      case "helper-start":
        return this.handshakeHelper();
      case "env-verify":
        return this.verifyEnvironment();
      case "adapter-install":
        return this.installAdapters();
      case "adapter-probe":
        return this.probeAdapters();
      case "forward-self-test":
        return this.selfTestForward();
      case "local-environment":
        return this.verifyLocalEnvironment(key);
      case "manifest":
        return this.recordManifest();
    }
  }

  /** Step 1: one `exec` returning 0 proves reachability and the host key. */
  private async checkSsh(): Promise<Record<string, unknown>> {
    const transport = this.transport;
    if (!transport) throw fail("ssh");
    const result = await transport.exec("true", { timeoutMs: SSH_TIMEOUT_MS });
    if (result.code !== 0) throw fail("ssh");
    return { completedAt: this.now(), exitCode: 0 };
  }

  /** Step 2: helper root exists, is 0700, is writable, and has the disk budget. */
  private async checkHelperRoot(): Promise<Record<string, unknown>> {
    const transport = this.transport;
    if (!transport) throw fail("helper-dir");
    const result = await transport.exec(HELPER_ROOT_SCRIPT, { timeoutMs: SSH_TIMEOUT_MS });
    // Only this module's own reason token is repeated; the host's text is not.
    if (result.code !== 0) throw fail("helper-dir", helperRootReason(result.stdout));
    const freeKb = helperFreeKb(result.stdout);
    if (freeKb === null) throw fail("helper-dir");
    return { completedAt: this.now(), freeKb };
  }

  /**
   * Step 3: install the bundled binary and read its ready line.
   * `deployBundledHelper` is idempotent (§3.2) — a matching running instance is
   * reused and a mismatched one replaced — so re-running this step after a crash
   * is the supported path and not a second installation.
   */
  private async deployHelper(): Promise<Record<string, unknown>> {
    const transport = this.transport;
    const desktopVersion = this.desktopVersion;
    const resolveArtifact = this.helperArtifact;
    if (!transport || !desktopVersion || !resolveArtifact) throw fail("helper-deploy");
    const artifact = await resolveArtifact();
    const ready = await deployBundledHelper({ transport, artifact, desktopVersion });
    this.onHelperReady?.(ready);
    return { completedAt: this.now(), version: ready.version, digest: artifact.manifest.sha256 };
  }

  /**
   * Step 4: the helper answers `version` over the open forward. The client
   * provider owns the topology — it reuses the running helper, reads its token and
   * connects through a loopback forward — so one round trip is forward and
   * handshake together.
   */
  private async handshakeHelper(): Promise<Record<string, unknown>> {
    const desktopVersion = this.desktopVersion;
    if (!desktopVersion) throw fail("helper-start");
    const version = await this.request("helper-start", "version");
    if (version.protocol !== 1 || version.version !== desktopVersion) throw fail("helper-start");
    return { completedAt: this.now(), version: desktopVersion, protocol: 1 };
  }

  /**
   * Step 5: `env.verify`, then `root.register` for this project's mirror root.
   * The helper reports readiness, protocol, its root, the project root count and
   * its capabilities — no permissions, disk budget or toolchain list — so the
   * receipt records only what was observed. Registering here makes a missing
   * remote directory, or one that contains the helper directory, fail this step
   * with the helper's own reason instead of the first sync.
   */
  private async verifyEnvironment(): Promise<Record<string, unknown>> {
    const result = await this.request("env-verify", "env.verify");
    const projectRootCount = result.projectRootCount;
    if (
      result.ready !== true ||
      result.protocol !== 1 ||
      typeof projectRootCount !== "number" ||
      !Number.isInteger(projectRootCount) ||
      projectRootCount < 0 ||
      !Array.isArray(result.capabilities)
    ) {
      throw fail("env-verify");
    }
    const capabilities: string[] = [];
    for (const entry of result.capabilities) {
      if (typeof entry !== "string") throw fail("env-verify");
      capabilities.push(entry);
    }
    if (!capabilities.includes("root.register")) throw fail("env-verify", "root-register-unavailable");
    await this.registerMirrorRoot();
    return { completedAt: this.now(), ready: true, protocol: 1, projectRootCount, capabilities };
  }

  /** Registers the mirror root; a refusal carries the helper's code, never the path. */
  private async registerMirrorRoot(): Promise<void> {
    const mirrorRoot = this.mirrorRoot;
    if (!mirrorRoot) throw fail("env-verify", "mirror-root-unavailable");
    let result: Record<string, unknown>;
    try {
      result = await (await this.connect()).request("root.register", { path: mirrorRoot }, QUERY_TIMEOUT_MS);
    } catch (error) {
      throw fail("env-verify", errorCodeOf(error) ?? "root-register-failed");
    }
    if (typeof result.root !== "string" || result.root.length === 0) {
      throw fail("env-verify", "root-register-invalid");
    }
  }

  /**
   * Step 6: install every adapter the bundled manifest pins for this target. An
   * empty manifest is a reported gap, not a pass (§5 rule 7): a host with no
   * pinned payload cannot offer the adapter.
   */
  private async installAdapters(): Promise<Record<string, unknown>> {
    const entries = this.adapterManifest;
    const payload = this.adapterPayload;
    if (entries.length === 0) return { completedAt: this.now(), adapters: [] };
    if (!payload) throw fail("adapter-install");
    const adapters = await this.adapterSurface("adapter-install");
    const installed: Record<string, unknown>[] = [];
    for (const entry of entries) {
      const result = await adapters.install(entry, payload(entry)).catch(() => Promise.reject(fail("adapter-install")));
      if (result.version !== entry.version || result.sha256.toLowerCase() !== entry.sha256.toLowerCase()) {
        throw fail("adapter-install");
      }
      installed.push({ kind: result.kind, version: result.version, sha256: result.sha256, size: result.size });
    }
    return { completedAt: this.now(), adapters: installed };
  }

  /** Step 7: the installed version and digest equal the pinned manifest entry. */
  private async probeAdapters(): Promise<Record<string, unknown>> {
    const entries = this.adapterManifest;
    if (entries.length === 0) return { completedAt: this.now(), adapters: [] };
    const adapters = await this.adapterSurface("adapter-probe");
    const probed: Record<string, unknown>[] = [];
    for (const entry of entries) {
      const result = await adapters.probe(entry.kind).catch(() => Promise.reject(fail("adapter-probe")));
      if (
        result.installed !== true ||
        result.version !== entry.version ||
        (result.sha256 ?? "").toLowerCase() !== entry.sha256.toLowerCase()
      ) {
        throw fail("adapter-probe");
      }
      probed.push({ kind: result.kind, version: result.version, sha256: result.sha256 });
    }
    return { completedAt: this.now(), adapters: probed };
  }

  /**
   * Step 8: one loopback forward connects and closes. This build has no forward
   * opener to hand to a self-test, so without the port the step reports
   * `REMOTE_FORWARD_FAILED` rather than a receipt for a forward never opened.
   */
  private async selfTestForward(): Promise<Record<string, unknown>> {
    const selfTest = this.forwardSelfTest;
    if (!selfTest) throw fail("forward-self-test");
    await selfTest().catch(() => Promise.reject(fail("forward-self-test")));
    return { completedAt: this.now() };
  }

  /**
   * Step 9: the project is registered locally with its mirror binding. Spec §4
   * names `workspace.get`, but that RPC answers with the single-window workspace;
   * the project group record is the per-project source of the local root. The
   * receipt records the facts checked and no path, because it is read back on the
   * wire.
   */
  private async verifyLocalEnvironment(key: string): Promise<Record<string, unknown>> {
    const payload = recordOf(await this.host.call("project.groups.list", {}), "project group list");
    if (!Array.isArray(payload.groups)) throw fail("local-environment");
    let registered = false;
    for (const entry of payload.groups) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const group = entry as Record<string, unknown>;
      if (group.id !== key) continue;
      const primaryPath = group.primaryPath;
      if (typeof primaryPath !== "string" || primaryPath.trim().length === 0) throw fail("local-environment");
      if (!group.mirror || typeof group.mirror !== "object") throw fail("local-environment");
      registered = true;
      break;
    }
    if (!registered) throw fail("local-environment");
    return { completedAt: this.now(), projectRegistered: true, mirrorBound: true, localRootPresent: true };
  }

  /**
   * Step 10: `env.json` and the baseline scan. Both halves need an owner this
   * build does not have yet, so they are ports; without them the step fails rather
   * than recording a receipt for a manifest that was never written (§4: a failed
   * initialization writes no `env.json`).
   */
  private async recordManifest(): Promise<Record<string, unknown>> {
    const writeEnv = this.writeEnvManifest;
    const storeBaseline = this.storeBaseline;
    if (!writeEnv || !storeBaseline) throw fail("manifest");
    const env = await writeEnv();
    if (!/^[a-f0-9]{64}$/.test(env.sha256 ?? "")) throw fail("manifest");
    const baseline = await storeBaseline();
    if (!Number.isInteger(baseline.entries) || baseline.entries < 0) throw fail("manifest");
    return { completedAt: this.now(), envSha256: env.sha256, baselineEntries: baseline.entries };
  }

  /** One control request on the helper connection, normalised to the step's code. */
  private async request(step: MirrorInitStep, op: string): Promise<Record<string, unknown>> {
    try {
      return await (await this.connect()).request(op, {}, QUERY_TIMEOUT_MS);
    } catch {
      throw fail(step);
    }
  }

  private async adapterSurface(step: MirrorInitStep): Promise<HelperAdapters> {
    if (this.adapters) return this.adapters;
    let client: HelperClient;
    try {
      client = await this.connect();
    } catch {
      throw fail(step);
    }
    this.adapters = createHelperAdapters(client);
    return this.adapters;
  }

  private connect(): Promise<HelperClient> {
    if (this.connection) return this.connection;
    const source = this.clientSource;
    const connection = typeof source === "function" ? source() : Promise.resolve(source);
    this.connection = connection;
    // A provider that failed must be retried by the next step, not replayed from
    // a rejected promise.
    void connection.catch(() => {
      if (this.connection === connection) this.connection = null;
    });
    return connection;
  }

  private warn(message: string, data?: Record<string, unknown>): void {
    try {
      this.logger.warn(message, data);
    } catch {
      // A logging sink must never turn a step failure into an exception.
    }
  }
}

function requireGroupId(projectGroupId: string): string {
  const key = projectGroupId.trim();
  if (!key) throw stepError("A mirror project group id is required", "MIRROR_INIT_FAILED");
  return key;
}

/** `PI_HELPER_DIR_FAIL <reason>` → the reason, when it is one of this module's. */
function helperRootReason(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^PI_HELPER_DIR_FAIL ([a-z-]+)$/.exec(line.trim());
    if (match && HELPER_ROOT_REASONS.has(match[1])) return match[1];
  }
  return null;
}

/** `PI_HELPER_DIR_OK free_kb=<n>` → the free kilobytes, or null when unproven. */
function helperFreeKb(stdout: string): number | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^PI_HELPER_DIR_OK free_kb=(\d+)$/.exec(line.trim());
    if (!match) continue;
    const value = Number.parseInt(match[1], 10);
    return Number.isFinite(value) && value >= MIN_HELPER_FREE_KB ? value : null;
  }
  return null;
}
