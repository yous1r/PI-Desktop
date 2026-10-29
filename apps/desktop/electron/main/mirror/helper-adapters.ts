import { createHash } from "node:crypto";
import { open, stat as statLocalPath } from "node:fs/promises";
import {
  DEFAULT_TRANSFER_TIMEOUT_MS,
  MAX_TRANSFER_BYTES,
  TRANSFER_CHUNK_BYTES,
  helperFailure,
  type HelperClient,
  type HelperFailure,
} from "./helper-client.ts";

const DEFAULT_QUERY_TIMEOUT_MS = 15_000;
/** Adapter payloads obey the same per-file ceiling as the file data plane. */
const MAX_ADAPTER_BYTES = MAX_TRANSFER_BYTES;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,31}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

/** Adapter kinds this desktop release can install; the helper has its own allowlist. */
export const ADAPTER_KINDS = ["python-debugpy"] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

/** Control operations the helper must advertise before an adapter call is attempted. */
export const ADAPTER_OPERATIONS = ["adapter.install", "adapter.probe", "adapter.start", "adapter.stop"] as const;

/** One pinned manifest entry: the only source of adapter identity and version. */
export type AdapterManifestEntry = {
  kind: AdapterKind;
  version: string;
  /** SHA-256 of the bundled payload, pinned in the desktop manifest. */
  sha256: string;
};

export type AdapterCallOptions = { timeoutMs?: number };

export type AdapterInstallResult = {
  kind: AdapterKind;
  version: string;
  sha256: string;
  size: number;
  bundlePath: string;
  installedAt: number;
};

export type AdapterProbeResult = {
  kind: AdapterKind;
  installed: boolean;
  version: string | null;
  sha256: string | null;
  installedAt: number | null;
};

export type AdapterStartResult = { kind: AdapterKind; port: number; pid: number; version: string };
export type AdapterStopResult = { kind: AdapterKind; stopped: boolean };

export type HelperAdapters = {
  install(
    entry: AdapterManifestEntry,
    source: Uint8Array | string,
    options?: AdapterCallOptions,
  ): Promise<AdapterInstallResult>;
  probe(kind: AdapterKind, options?: AdapterCallOptions): Promise<AdapterProbeResult>;
  start(kind: AdapterKind, options?: AdapterCallOptions): Promise<AdapterStartResult>;
  stop(kind: AdapterKind, options?: AdapterCallOptions): Promise<AdapterStopResult>;
};

type PayloadSource = { kind: "bytes"; bytes: Uint8Array } | { kind: "path"; path: string };

function failure(message: string, errorCode: string): HelperFailure {
  return helperFailure(message, errorCode);
}

function errorCodeOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const code = (value as { errorCode?: unknown }).errorCode;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/**
 * Normalises a helper failure for the adapter surface.
 *
 * A helper that answers `HELPER_OPERATION_UNAVAILABLE` predates the adapter
 * operations, which is a version mismatch rather than a request defect: the
 * desktop has to redeploy the bundled helper before debugging can work.
 */
function asAdapterError(value: unknown): HelperFailure {
  const code = errorCodeOf(value);
  if (code === "HELPER_OPERATION_UNAVAILABLE") {
    return failure("The remote helper does not implement adapter operations", "HELPER_VERSION_MISMATCH");
  }
  if (value instanceof Error && code !== null) return value as HelperFailure;
  if (value instanceof Error) {
    return Object.assign(value, { errorCode: "HELPER_INTERNAL_ERROR" }) as HelperFailure;
  }
  return failure("The helper adapter operation failed", "HELPER_INTERNAL_ERROR");
}

function validateKind(value: unknown): AdapterKind {
  if (typeof value !== "string" || !(ADAPTER_KINDS as readonly string[]).includes(value)) {
    throw failure("The debug adapter kind is not supported", "HELPER_PROTOCOL_ERROR");
  }
  return value as AdapterKind;
}

function validateVersion(value: unknown): string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw failure("The debug adapter version is not a pinned manifest version", "HELPER_PROTOCOL_ERROR");
  }
  return value;
}

function validateDigest(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw failure("The pinned adapter digest is not a SHA-256 value", "HELPER_PROTOCOL_ERROR");
  }
  return value.toLowerCase();
}

/** The helper accepts exactly one install directory per manifest entry. */
function installDirectory(kind: AdapterKind, version: string): string {
  return `adapters/${kind}/${version}`;
}

function normaliseSource(source: Uint8Array | string): PayloadSource {
  if (typeof source === "string") {
    if (source.length === 0) throw failure("The adapter bundle path is empty", "DEBUG_ADAPTER_INSTALL_FAILED");
    return { kind: "path", path: source };
  }
  if (source instanceof Uint8Array) return { kind: "bytes", bytes: source };
  throw failure("The adapter bundle is not a byte array or a local path", "DEBUG_ADAPTER_INSTALL_FAILED");
}

async function* payloadChunks(source: PayloadSource, size: number): AsyncGenerator<Uint8Array> {
  if (source.kind === "bytes") {
    for (let offset = 0; offset < source.bytes.byteLength; offset += TRANSFER_CHUNK_BYTES) {
      yield source.bytes.subarray(offset, offset + TRANSFER_CHUNK_BYTES);
    }
    return;
  }
  const handle = await open(source.path, "r").catch(() => null);
  if (!handle) throw failure("The bundled adapter payload could not be read", "DEBUG_ADAPTER_INSTALL_FAILED");
  try {
    const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK_BYTES);
    let remaining = size;
    while (remaining > 0) {
      const read = await handle.read(buffer, 0, Math.min(TRANSFER_CHUNK_BYTES, remaining), null).catch(() => null);
      if (!read || read.bytesRead === 0) {
        throw failure("The bundled adapter payload changed while it was read", "DEBUG_ADAPTER_INSTALL_FAILED");
      }
      remaining -= read.bytesRead;
      yield Buffer.from(buffer.subarray(0, read.bytesRead));
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function measureSource(source: PayloadSource): Promise<number> {
  if (source.kind === "bytes") return source.bytes.byteLength;
  const stats = await statLocalPath(source.path).catch(() => null);
  if (!stats || !stats.isFile()) throw failure("The bundled adapter payload could not be read", "DEBUG_ADAPTER_INSTALL_FAILED");
  return stats.size;
}

async function digestSource(source: PayloadSource, size: number): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of payloadChunks(source, size)) hash.update(chunk);
  return hash.digest("hex");
}

function record(value: unknown, errorCode: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure("The helper reported an invalid adapter result", errorCode);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, errorCode: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw failure("The helper reported an invalid adapter result", errorCode);
  }
  return value;
}

function optionalString(value: unknown, errorCode: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, errorCode);
}

function optionalNumber(value: unknown, errorCode: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw failure("The helper reported an invalid adapter result", errorCode);
  }
  return value;
}

function integer(value: unknown, errorCode: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw failure("The helper reported an invalid adapter result", errorCode);
  }
  return value;
}

export function createHelperAdapters(client: HelperClient): HelperAdapters {
  let supported: Promise<void> | null = null;

  /**
   * Refuses to call adapter operations against a helper that does not advertise
   * them, so a stale deployment fails as a version mismatch with a clear cause.
   */
  function ensureSupported(): Promise<void> {
    if (supported) return supported;
    supported = (async () => {
      const version = record(await client.request("version"), "HELPER_PROTOCOL_ERROR");
      const capabilities = version.capabilities;
      if (!Array.isArray(capabilities) || capabilities.some((entry) => typeof entry !== "string")) {
        throw failure("The helper did not advertise its capabilities", "HELPER_PROTOCOL_ERROR");
      }
      const advertised = capabilities as string[];
      const missing = ADAPTER_OPERATIONS.filter((op) => !advertised.includes(op));
      if (missing.length > 0) {
        throw failure(
          "The remote helper does not implement adapter operations",
          "HELPER_VERSION_MISMATCH",
        );
      }
    })();
    // A failed probe is not cached: redeploying the helper must be able to
    // succeed on the next call within the same client.
    supported.catch(() => {
      supported = null;
    });
    return supported;
  }

  async function install(
    entry: AdapterManifestEntry,
    source: Uint8Array | string,
    options: AdapterCallOptions = {},
  ): Promise<AdapterInstallResult> {
    if (!entry || typeof entry !== "object") {
      throw failure("The adapter manifest entry is invalid", "HELPER_PROTOCOL_ERROR");
    }
    const kind = validateKind(entry.kind);
    const version = validateVersion(entry.version);
    const sha256 = validateDigest(entry.sha256);
    const payload = normaliseSource(source);
    const size = await measureSource(payload);
    if (size === 0) throw failure("The adapter bundle is empty", "DEBUG_ADAPTER_INSTALL_FAILED");
    if (size > MAX_ADAPTER_BYTES) {
      throw failure("The adapter bundle exceeds the transfer ceiling", "MIRROR_FILE_TOO_LARGE");
    }
    // The pinned digest is checked against the local payload before any byte
    // is sent, so a mismatched bundle never reaches the remote host.
    const local = await digestSource(payload, size);
    if (local !== sha256) {
      throw failure("The adapter bundle does not match the pinned digest", "DEBUG_ADAPTER_INSTALL_FAILED");
    }
    await ensureSupported();

    const stream = client.beginStream({
      op: "adapter.install",
      params: { kind, version, sha256, path: installDirectory(kind, version) },
      timeoutMs: options.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS,
    });
    const outcome = stream.response.catch((error: unknown) => {
      throw asAdapterError(error);
    });
    void outcome.catch(() => undefined);
    try {
      for await (const chunk of payloadChunks(payload, size)) {
        await client.writeStreamData(stream.streamId, chunk);
      }
      await client.writeStreamEnd(stream.streamId);
      const result = record(await outcome, "DEBUG_ADAPTER_INSTALL_FAILED");
      return {
        kind,
        version: requiredString(result.version, "DEBUG_ADAPTER_INSTALL_FAILED"),
        sha256: validateDigest(result.sha256),
        size: integer(result.size, "DEBUG_ADAPTER_INSTALL_FAILED"),
        bundlePath: requiredString(result.bundlePath, "DEBUG_ADAPTER_INSTALL_FAILED"),
        installedAt: integer(result.installedAt, "DEBUG_ADAPTER_INSTALL_FAILED"),
      };
    } catch (error) {
      // A stream that never reaches END leaves no committed payload behind.
      client.abandonStream(stream.streamId, asAdapterError(error));
      throw asAdapterError(error);
    } finally {
      client.closeStream(stream.streamId);
    }
  }

  async function probe(kind: AdapterKind, options: AdapterCallOptions = {}): Promise<AdapterProbeResult> {
    const target = validateKind(kind);
    await ensureSupported();
    try {
      const result = record(
        await client.request("adapter.probe", { kind: target }, options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS),
        "HELPER_PROTOCOL_ERROR",
      );
      const version = optionalString(result.version, "HELPER_PROTOCOL_ERROR");
      return {
        kind: target,
        installed: result.installed === true,
        version,
        sha256: optionalString(result.sha256, "HELPER_PROTOCOL_ERROR"),
        installedAt: optionalNumber(result.installedAt, "HELPER_PROTOCOL_ERROR"),
      };
    } catch (error) {
      throw asAdapterError(error);
    }
  }

  async function start(kind: AdapterKind, options: AdapterCallOptions = {}): Promise<AdapterStartResult> {
    const target = validateKind(kind);
    await ensureSupported();
    try {
      const result = record(
        await client.request("adapter.start", { kind: target }, options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS),
        "HELPER_PROTOCOL_ERROR",
      );
      const port = integer(result.port, "HELPER_PROTOCOL_ERROR");
      if (port < 1 || port > 65_535) {
        throw failure("The helper reported an invalid adapter port", "HELPER_PROTOCOL_ERROR");
      }
      const pid = integer(result.pid, "HELPER_PROTOCOL_ERROR");
      if (pid < 1) throw failure("The helper reported an invalid adapter pid", "HELPER_PROTOCOL_ERROR");
      return { kind: target, port, pid, version: requiredString(result.version, "HELPER_PROTOCOL_ERROR") };
    } catch (error) {
      throw asAdapterError(error);
    }
  }

  async function stop(kind: AdapterKind, options: AdapterCallOptions = {}): Promise<AdapterStopResult> {
    const target = validateKind(kind);
    await ensureSupported();
    try {
      const result = record(
        await client.request("adapter.stop", { kind: target }, options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS),
        "HELPER_PROTOCOL_ERROR",
      );
      return { kind: target, stopped: result.stopped === true };
    } catch (error) {
      throw asAdapterError(error);
    }
  }

  return { install, probe, start, stop };
}
