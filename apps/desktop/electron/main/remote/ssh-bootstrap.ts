/**
 * SSH bootstrap: install and pair a `pi-host` on a machine the user already
 * reaches over SSH (spec `02-architecture/05-remote-agent-control.md` §5.2,
 * security `05-security/02-remote-control-security.md` §3.4).
 *
 * Resolve the exact client release, download and verify on Desktop using its
 * global network settings, upload over SSH, and prepare the remote installation.
 * New hosts pair once; upgrades retain and authenticate the enrolled identity.
 *
 * Everything that touches the outside world is injected, so the whole flow is
 * exercised in tests against a fake transport and a fake pairing exchange.
 */
import { createHash } from "node:crypto";
import {
  ErrorCodes,
  type RemoteHostBootstrapRequest,
  type RemoteHostSshMetadata,
} from "@pi-desktop/shared";
import {
  type PiHostBootstrapScriptInput,
  parseBootstrapOutput,
} from "./pi-host-bootstrap-script.js";
import {
  isPublishedTarget,
  parseChecksumFile,
  piHostArtifactName,
  piHostArtifactUrls,
  piHostBundleDir,
  resolveTarget,
  targetKey,
  versionsMatch,
} from "./pi-host-release.js";
import {
  assertSshArgument,
  createSystemSshTransport,
  reserveLocalPort,
  type SshForward,
  type SshTarget,
  type SshExecResult,
  type SshTransport,
} from "./ssh-transport.js";
import { assertSshPassword } from "./ssh-askpass.js";
import { racpUrlForLocalPort } from "./ssh-tunnel.js";
import { installPiHost } from "./pi-host-installer.js";
import type { uploadSshArtifact } from "./ssh-artifact-transfer.js";
import { completeHostDeployment } from "./remote-host-deployment.js";
import { acquirePiHostArtifact } from "./pi-host-artifact-cache.js";

/** Progress the Settings surface can render while a bootstrap runs. */
export type SshBootstrapStep =
  | "probe"
  | "resolve-release"
  | "download-checksum"
  | "download"
  | "start"
  | "install"
  | "upload"
  | "forward"
  | "pair";

export type SshBootstrapDeps = {
  /** Release version the desktop runs; the bundle must exist for this tag. */
  version: string;
  /** Build the SSH transport for one target. Defaults to the system `ssh`. */
  buildTransport?: (target: SshTarget) => SshTransport;
  /** Read the published `.sha256` text. Defaults to an HTTPS GET. */
  fetchChecksum?: (url: string, signal?: AbortSignal) => Promise<string>;
  /** Production injects Electron fetch after the global proxy has been applied. */
  fetchArtifact?: typeof fetch;
  /** Optional private persistent cache for verified pi-host release archives. */
  artifactCacheDir?: string;
  beforeDownload?: () => Promise<void>;
  verifyConnection?: (input: { url: string; deviceToken: string; expectedHostId: string }) => Promise<void>;
  uploadArtifact?: typeof uploadSshArtifact;
  /** Reserve the loopback port the forward binds. */
  reservePort?: () => Promise<number>;
  /**
   * Exchange the single-use pairing token for a durable device token over the
   * forwarded port. The boot layer injects this because it owns the RACP
   * client factory.
   */
  exchangePairing: (input: {
    url: string;
    pairingToken: string;
    label: string;
    expectedHostId: string;
  }) => Promise<string>;
  /** Called once per completed step, in order. */
  onProgress?: (step: SshBootstrapStep) => void;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
  /** How long the script waits for the ready and pairing lines. */
  readyTimeoutSec?: number;
  /** Budget for the whole remote script, download included. */
  installTimeoutMs?: number;
};

export type SshBootstrapOutcome = {
  hostKey: string;
  label: string;
  /** Live forward; the caller adopts it and owns closing it. */
  forward: SshForward;
  /** The loopback RACP endpoint the pairing exchange used. */
  url: string;
  deviceToken: string;
  ssh: RemoteHostSshMetadata;
  /**
   * The login password the forward was opened with, when the user chose
   * password auth. The caller persists it encrypted; it is never placed in
   * `ssh` (which is echoed back to the renderer) and never logged.
   */
  sshSecret?: string;
  /** Steps that completed, in order. */
  steps: SshBootstrapStep[];
};

export type SshBootstrapOptions = {
  signal?: AbortSignal;
  existing?: { hostId: string; deviceToken: string; version: string };
  allowLegacyMaintenance?: boolean;
  onProgress?: (step: SshBootstrapStep) => void;
};
export type SshBootstrap = {
  bootstrap(request: RemoteHostBootstrapRequest, options?: SshBootstrapOptions): Promise<SshBootstrapOutcome>;
};

const DEFAULT_READY_TIMEOUT_SEC = 120;
/** Includes upload, bounded remote deployment, and readiness verification. */
const DEFAULT_INSTALL_TIMEOUT_MS = 900_000;

function fail(message: string, errorCode: string, data?: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { errorCode, ...(data ?? {}), data });
}

const REMOTE_STEP_MESSAGES: Record<string, string> = {
  "missing-node": "the remote machine has no Node.js; pi-host needs Node.js 22 or newer",
  "node-too-old": "the remote Node.js is too old; pi-host needs Node.js 22 or newer",
  "download-failed": "the remote machine could not download the pi-host bundle from GitHub",
  "checksum-mismatch": "the downloaded pi-host bundle did not match the published SHA-256",
  "missing-tar": "the remote machine has no tar",
  "install-failed": "the remote pi-host install.sh failed",
  "ready-timeout": "the remote pi-host started but did not become ready in time",
  "host-exited": "the remote pi-host process exited before it became ready",
  "host-start-failed": "the remote pi-host process failed to start",
};

function bootstrapFailureCode(step: string): string {
  if (step === "HOST_MAINTENANCE_UNAVAILABLE") return "HOST_MAINTENANCE_REQUIRED";
  if (["HOST_BUSY", "HOST_AUTH_FAILED", "HOST_RECOVERY_REQUIRED", "HOST_VERSION_MISMATCH"].includes(step)) return step;
  if (["host-stop-timeout", "host-process-unidentified", "deployment-timeout"].includes(step)) return "HOST_RECOVERY_REQUIRED";
  if (["bundle-verification-failed", "unexpected-archive-layout", "invalid-checksum"].includes(step)) return "HOST_INTEGRITY_FAILED";
  if (["maintenance-required", "maintenance-unavailable"].includes(step)) return "HOST_MAINTENANCE_REQUIRED";
  if (["host-busy", "deployment-busy", "maintenance-busy"].includes(step)) return "HOST_BUSY";
  if (["host-identity-mismatch", "host-auth-failed", "identity-mismatch"].includes(step)) return "HOST_AUTH_FAILED";
  if (["recovery-required", "host-recovery-required"].includes(step)) return "HOST_RECOVERY_REQUIRED";
  if (["checksum-mismatch", "installed-verification-failed", "extract-failed"].includes(step)) return "HOST_INTEGRITY_FAILED";
  if (["host-start-failed", "host-exited", "ready-timeout"].includes(step)) return "HOST_START_FAILED";
  return "HOST_BOOTSTRAP_FAILED";
}

function remoteStepMessage(step: string): string {
  return REMOTE_STEP_MESSAGES[step] ?? "The remote Host could not be prepared";
}

/**
 * Stable routing key for a bootstrapped host. It lands inside
 * `remote:<hostKey>:<hostSessionId>`, so a colon would break the id — an IPv6
 * literal is folded to dashes rather than rejected, because the user typed it
 * in good faith and the key is only a routing label.
 */
export function synthesizeSshHostKey(ssh: SshTarget, label: string): string {
  const host = ssh.host.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const base = host ? `ssh-${host}` : "ssh-host";
  return slug ? `${base}-${slug}` : base;
}

/** Translate the renderer request into the descriptor that gets persisted. */
export function sshMetadataFromTarget(target: SshTarget): Omit<RemoteHostSshMetadata, "remotePort" | "version"> {
  return {
    host: target.host,
    ...(target.port !== undefined ? { port: target.port } : {}),
    ...(target.user ? { user: target.user } : {}),
    ...(target.identityFile ? { identityFile: target.identityFile } : {}),
    // Only recorded when it is not the default: a key-authenticated descriptor
    // keeps exactly the shape it had before password auth existed, so no
    // existing `remote-hosts.json` entry changes on its next write. A later
    // launch reads the field to know a secret is needed, so it can say so
    // plainly instead of failing as a bare authentication error.
    ...(target.password !== undefined ? { auth: "password" as const } : {}),
  };
}

export async function fetchReleaseChecksum(url: string, signal?: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<string> {
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw fail("Published Host checksum is unavailable",
      response.status === 404 ? "HOST_RELEASE_UNAVAILABLE" : "HOST_DOWNLOAD_FAILED");
    if (!response.body || (response.url && new URL(response.url).protocol !== "https:")) {
      throw fail("Invalid Host checksum response", "HOST_INTEGRITY_FAILED");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 16 * 1024) throw fail("Host checksum response exceeds limit", "HOST_INTEGRITY_FAILED");
        chunks.push(chunk.value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally { await reader.cancel(); reader.releaseLock(); }
  } catch (error) {
    signal?.throwIfAborted();
    const code = (error as { errorCode?: string }).errorCode;
    throw fail("Published Host checksum could not be downloaded or verified",
      code && ["HOST_RELEASE_UNAVAILABLE", "HOST_INTEGRITY_FAILED", "HOST_NETWORK_NOT_READY"].includes(code) ? code : "HOST_DOWNLOAD_FAILED");
  }
}

function validateTarget(request: RemoteHostBootstrapRequest): SshTarget {
  const host = assertSshArgument(String(request?.host ?? ""), "host");
  const target: SshTarget = { host };
  if (request?.port !== undefined && request.port !== null) {
    const port = Number(request.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw fail("port must be an integer between 1 and 65535", ErrorCodes.INVALID_ARGUMENT, {
        field: "port",
      });
    }
    target.port = port;
  }
  if (request?.user) target.user = assertSshArgument(String(request.user), "user");
  if (request?.identityFile) {
    target.identityFile = assertSshArgument(String(request.identityFile), "identityFile");
  }
  // The one secret in the request. It is validated here rather than trusted
  // because it cannot survive a line break through the askpass helper, and a
  // value that cannot work should be refused before a remote script runs.
  if (request?.password !== undefined && request.password !== null) {
    target.password = assertSshPassword(request.password);
  }
  return target;
}

/**
 * The port `pi-host` binds on the remote machine. Absent or `0` means "pick a
 * free one and report it", which is what the bootstrap normally wants; a
 * pinned port is range-checked here so it cannot reach the script as an
 * argument like `--port -5`.
 */
function resolveRemotePort(request: RemoteHostBootstrapRequest): number {
  const raw = request?.remotePort;
  if (raw === undefined || raw === null) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw fail(
      "remotePort must be an integer between 0 and 65535",
      ErrorCodes.INVALID_ARGUMENT,
      { field: "remotePort" },
    );
  }
  return port;
}

export function createSshBootstrap(deps: SshBootstrapDeps): SshBootstrap {
  const log = deps.log ?? (() => undefined);
  const buildTransport =
    deps.buildTransport ??
    ((target: SshTarget) =>
      createSystemSshTransport(target, {
        log: (level, message, data) => log(level, message, data),
      }));
  const fetchChecksum = deps.fetchChecksum ?? ((url, signal) => fetchReleaseChecksum(url, signal, deps.fetchArtifact));
  const reservePort = deps.reservePort ?? reserveLocalPort;
  const readyTimeoutSec = deps.readyTimeoutSec ?? DEFAULT_READY_TIMEOUT_SEC;
  const installTimeoutMs = deps.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;

  return {
    async bootstrap(request, options = {}) {
      const signal = options.signal;
      signal?.throwIfAborted();
      const label = String(request?.label ?? "").trim() || "remote host";
      const target = validateTarget(request);
      const remotePort = resolveRemotePort(request);
      const hostKey = (request?.hostKey ?? "").trim() || synthesizeSshHostKey(target, label);
      if (hostKey.includes(":")) {
        throw fail("hostKey must not contain ':'", ErrorCodes.INVALID_ARGUMENT, { field: "hostKey" });
      }

      const steps: SshBootstrapStep[] = [];
      const mark = (step: SshBootstrapStep): void => {
        steps.push(step);
        deps.onProgress?.(step);
        options.onProgress?.(step);
      };

      const transport = buildTransport(target);
      const abort = () => transport.dispose();
      signal?.addEventListener("abort", abort, { once: true });
      let completed = false;
      try {
        // 1. Ask the remote machine what it is.
        mark("probe");
        const probe = await transport.exec("uname -s && uname -m");
        signal?.throwIfAborted();
        const remoteTarget = resolveTarget(probe.stdout);
        if (!remoteTarget) {
          throw fail(
            "the remote platform could not be identified",
            ErrorCodes.HOST_BOOTSTRAP_FAILED,
            { uname: probe.stdout.trim().slice(0, 200) },
          );
        }
        if (!isPublishedTarget(remoteTarget)) {
          throw fail(
            `no pi-host bundle is published for ${targetKey(remoteTarget)}`,
            ErrorCodes.HOST_BOOTSTRAP_FAILED,
            { target: targetKey(remoteTarget) },
          );
        }
        // 2. Resolve and verify an exact release; the optional cache eliminates all release requests on a verified hit.
        mark("resolve-release");
        const urls = piHostArtifactUrls(deps.version, remoteTarget);
        const artifactName = piHostArtifactName(deps.version, remoteTarget);
        let expectedSha256: string;
        let artifactPath: string | undefined;
        let releaseArtifact: (() => Promise<void>) | undefined;
        if (deps.artifactCacheDir) {
          const artifact = await acquirePiHostArtifact({
            directory: deps.artifactCacheDir,
            url: urls.tarball,
            artifactName,
            signal,
            fetchChecksum,
            fetchArtifact: deps.fetchArtifact,
            beforeDownload: deps.beforeDownload,
            onChecksumDownload: () => mark("download-checksum"),
            onDownload: () => mark("download"),
          });
          expectedSha256 = artifact.expectedSha256;
          artifactPath = artifact.path;
          releaseArtifact = artifact.release;
        } else {
          await deps.beforeDownload?.();
          signal?.throwIfAborted();
          mark("download-checksum");
          expectedSha256 = parseChecksumFile(await fetchChecksum(urls.checksum, signal), artifactName) ?? "";
          signal?.throwIfAborted();
          if (!expectedSha256) {
            throw fail(`no usable SHA-256 published for ${artifactName}`, "HOST_INTEGRITY_FAILED", { url: urls.checksum });
          }
        }

        const scriptInput: PiHostBootstrapScriptInput = {
          version: deps.version,
          artifactUrl: urls.tarball,
          artifactName,
          bundleDir: piHostBundleDir(deps.version, remoteTarget),
          expectedSha256,
          port: remotePort,
          pairingLifetimeMs: 600_000,
          readyTimeoutSec,
          ...(options.existing ? { existingHostId: options.existing.hostId,
            expectedCurrentVersion: options.existing.version, preservePairing: true,
            expectedDeviceTokenHash: createHash("sha256").update(options.existing.deviceToken, "utf8").digest("hex") } : {}),
          allowLegacyMaintenance: options.allowLegacyMaintenance === true,
        };
        let result: SshExecResult;
        try {
          result = await installPiHost(transport, scriptInput, {
            timeoutMs: installTimeoutMs, signal, uploadArtifact: deps.uploadArtifact, fetchArtifact: deps.fetchArtifact,
            ...(artifactPath ? { artifactPath } : {}),
            onDownload: () => { if (!deps.artifactCacheDir) mark("download"); },
            onUpload: () => mark("upload"), onInstall: () => mark("install"), log,
          });
        } catch (error) {
          const reported = parseBootstrapOutput(String((error as { stdout?: unknown }).stdout ?? ""));
          if (!reported.failure) throw error;
          throw fail(remoteStepMessage(reported.failure), bootstrapFailureCode(reported.failure), { step: reported.failure });
        } finally {
          await releaseArtifact?.();
        }
        const parsed = parseBootstrapOutput(result.stdout);
        if (parsed.failure) throw fail(remoteStepMessage(parsed.failure), bootstrapFailureCode(parsed.failure), { step: parsed.failure });
        if (result.code !== 0) throw fail("Remote Host deployment failed", "HOST_BOOTSTRAP_FAILED");
        if (!parsed.ready || (!options.existing && !parsed.pairing)) {
          throw fail("the remote bootstrap produced no ready/pairing output", "HOST_START_FAILED");
        }
        if (options.existing && parsed.ready.hostId !== options.existing.hostId) {
          throw fail("Remote Host identity changed during upgrade", "HOST_AUTH_FAILED");
        }
        if (!versionsMatch(parsed.ready.version, deps.version)) {
          throw fail(`the remote host runs ${parsed.ready.version}; this desktop runs ${deps.version}`,
            ErrorCodes.HOST_VERSION_MISMATCH, { remote: parsed.ready.version, local: deps.version });
        }


        // 4. Forward a loopback port to the host's loopback port.
        mark("forward");
        const localPort = await reservePort();
        signal?.throwIfAborted();
        const forward = await transport.forward({
          localPort,
          remoteHost: "127.0.0.1",
          remotePort: parsed.ready.port,
        });
        const url = racpUrlForLocalPort(localPort);

        // 5. New installs pair; upgrades authenticate with the existing device token.
        if (!options.existing) mark("pair");
        let deviceToken: string;
        try {
          signal?.throwIfAborted();
          if (options.existing) {
            deviceToken = options.existing.deviceToken;
            if (!deps.verifyConnection) throw fail("Host verification is unavailable", "HOST_AUTH_FAILED");
            await deps.verifyConnection({ url, deviceToken, expectedHostId: options.existing.hostId });
          } else {
            deviceToken = await deps.exchangePairing({ url, pairingToken: parsed.pairing!.token,
              label, expectedHostId: parsed.ready.hostId });
          }
          signal?.throwIfAborted();
          if (parsed.transactionId) await completeHostDeployment(transport, parsed.transactionId, parsed.ready.hostId);
          signal?.throwIfAborted();
        } catch (error) {
          await forward.close().catch(() => undefined);
          throw error;
        }

        const ssh: RemoteHostSshMetadata = {
          ...sshMetadataFromTarget(target),
          remotePort: parsed.ready.port,
          version: parsed.ready.version,
          hostId: parsed.ready.hostId,
        };
        completed = true;
        log("info", "ssh bootstrap completed", {
          hostKey,
          url,
          version: ssh.version,
          auth: ssh.auth,
        });
        return {
          hostKey,
          label,
          forward,
          url,
          deviceToken,
          ssh,
          // Handed to the caller to encrypt, never logged and never returned
          // to the renderer.
          ...(target.password !== undefined ? { sshSecret: target.password } : {}),
          steps,
        };
      } catch (error) {
        log("error", "ssh bootstrap failed", {
          errorCode: (error as { errorCode?: string }).errorCode,
          step: (error as { step?: string }).step,
        });
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        // On success the caller adopts the forward, which is a child of this
        // transport — disposing here would tear down the tunnel it just got.
        if (!completed) transport.dispose();
      }
    },
  };
}
