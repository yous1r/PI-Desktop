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
const MAX_REMOTE_PATH_CHARS = 4096;
const MAX_BATCH_PATHS = 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type RemoteStatEntry = {
  path: string;
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  mode?: number;
};

export type RemoteDigest = { path: string; sha256: string };

export type TransferOptions = { signal?: AbortSignal; timeoutMs?: number };

export type PutFileOptions = TransferOptions & {
  /** Caller-known digest of the local content; a mismatch fails before any transfer. */
  expectedSha256?: string;
  streamId?: number;
};

export type GetFileOptions = TransferOptions & {
  streamId?: number;
  expectedSize?: number;
};

export type PutFileResult = { path: string; size: number; sha256: string; result: Record<string, unknown> };
export type GetFileResult = { path: string; size: number; sha256: string; result: Record<string, unknown> };

export type FileSink =
  | ((bytes: Buffer) => void | Promise<void>)
  | { write(bytes: Buffer): void | Promise<void>; end?(): void | Promise<void> };

export type HelperFs = {
  stat(paths: string | readonly string[], options?: TransferOptions): Promise<RemoteStatEntry[]>;
  hash(path: string, options?: TransferOptions): Promise<RemoteDigest>;
  mkdirs(paths: string | readonly string[], options?: TransferOptions): Promise<string[]>;
  putFile(remotePath: string, source: Uint8Array | string, options?: PutFileOptions): Promise<PutFileResult>;
  getFile(remotePath: string, sink: FileSink, options?: GetFileOptions): Promise<GetFileResult>;
};

type FileWriter = { write(bytes: Buffer): void | Promise<void>; end?(): void | Promise<void> };

type PutSource = { kind: "bytes"; bytes: Uint8Array } | { kind: "path"; path: string };

type AbortGuard = {
  race<T>(value: Promise<T>): Promise<T>;
  dispose(): void;
};

/**
 * Rejects a remote path the client must never send: absolute paths, `..`
 * segments, backslashes, and NUL bytes are refused instead of being normalised.
 */
export function validateRemotePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REMOTE_PATH_CHARS) {
    throw helperFailure("The remote path is not a usable relative path", "REMOTE_PATH_ESCAPE");
  }
  if (value.includes("\0") || value.includes("\\")) {
    throw helperFailure("The remote path contains a refused separator", "REMOTE_PATH_ESCAPE");
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw helperFailure("The remote path must stay relative to the project root", "REMOTE_PATH_ESCAPE");
  }
  for (const segment of value.split("/")) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw helperFailure("The remote path contains a refused segment", "REMOTE_PATH_ESCAPE");
    }
  }
  return value;
}

function abortFailure(): HelperFailure {
  const error = helperFailure("The transfer was cancelled", "REMOTE_TRANSFER_FAILED");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortFailure();
}

function abortGuard(signal: AbortSignal | undefined): AbortGuard {
  if (!signal) {
    return {
      race(value) {
        return value;
      },
      dispose() {
        return undefined;
      },
    };
  }
  let listener: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(abortFailure());
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
  });
  void aborted.catch(() => undefined);
  return {
    race(value) {
      return Promise.race([value, aborted]);
    },
    dispose() {
      if (listener) signal.removeEventListener("abort", listener);
      listener = null;
    },
  };
}

function asTransferError(value: unknown): HelperFailure {
  if (value instanceof Error) {
    const code = (value as { errorCode?: unknown }).errorCode;
    if (typeof code === "string" && code.length > 0) return value as HelperFailure;
    return Object.assign(value, { errorCode: "REMOTE_TRANSFER_FAILED" }) as HelperFailure;
  }
  return helperFailure("The transfer failed", "REMOTE_TRANSFER_FAILED");
}

function remotePathList(value: string | readonly string[]): string[] {
  const list = typeof value === "string" ? [value] : [...value];
  if (list.length === 0 || list.length > MAX_BATCH_PATHS) {
    throw helperFailure("The helper path batch is out of bounds", "HELPER_PROTOCOL_ERROR");
  }
  return list.map((entry) => validateRemotePath(entry));
}

function normaliseExpectedSha256(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value.toLowerCase())) {
    throw helperFailure("The expected digest is not a SHA-256 value", "HELPER_PROTOCOL_ERROR");
  }
  return value.toLowerCase();
}

function normalisePutSource(source: Uint8Array | string): PutSource {
  if (typeof source === "string") {
    if (source.length === 0) throw helperFailure("The local file path is empty", "REMOTE_TRANSFER_FAILED");
    return { kind: "path", path: source };
  }
  if (source instanceof Uint8Array) return { kind: "bytes", bytes: source };
  throw helperFailure("The transfer source is not a byte array or a local path", "REMOTE_TRANSFER_FAILED");
}

function normaliseSink(sink: FileSink): FileWriter {
  if (typeof sink === "function") return { write: sink };
  if (!sink || typeof sink.write !== "function") {
    throw helperFailure("The transfer sink is not writable", "REMOTE_TRANSFER_FAILED");
  }
  const end = sink.end;
  if (typeof end === "function") return { write: (bytes) => sink.write(bytes), end: () => end.call(sink) };
  return { write: (bytes) => sink.write(bytes) };
}

async function* bytesChunks(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += TRANSFER_CHUNK_BYTES) {
    yield bytes.subarray(offset, offset + TRANSFER_CHUNK_BYTES);
  }
}

async function* readLocalChunks(localPath: string, size: number): AsyncGenerator<Uint8Array> {
  const handle = await open(localPath, "r").catch(() => null);
  if (!handle) throw helperFailure("The local file could not be read", "REMOTE_TRANSFER_FAILED");
  try {
    const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK_BYTES);
    let remaining = size;
    while (remaining > 0) {
      const read = await handle.read(buffer, 0, Math.min(TRANSFER_CHUNK_BYTES, remaining), null).catch(() => null);
      if (!read || read.bytesRead === 0) {
        throw helperFailure("The local file changed while it was being read", "REMOTE_TRANSFER_FAILED");
      }
      remaining -= read.bytesRead;
      yield Buffer.from(buffer.subarray(0, read.bytesRead));
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function measureSource(source: PutSource): Promise<number> {
  if (source.kind === "bytes") return source.bytes.byteLength;
  const stats = await statLocalPath(source.path).catch(() => null);
  if (!stats) throw helperFailure("The local file could not be read", "REMOTE_TRANSFER_FAILED");
  if (!stats.isFile()) throw helperFailure("The local path is not a regular file", "REMOTE_TRANSFER_FAILED");
  return stats.size;
}

async function digestSource(source: PutSource, size: number): Promise<string> {
  const hash = createHash("sha256");
  if (source.kind === "bytes") {
    hash.update(source.bytes);
    return hash.digest("hex");
  }
  for await (const chunk of readLocalChunks(source.path, size)) hash.update(chunk);
  return hash.digest("hex");
}

function entryArray(result: Record<string, unknown>): unknown[] {
  for (const key of ["entries", "stats", "files"]) {
    const value = result[key];
    if (Array.isArray(value)) return value;
  }
  throw helperFailure("The helper reported an invalid stat result", "HELPER_PROTOCOL_ERROR");
}

function normaliseStatEntry(value: unknown): RemoteStatEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw helperFailure("The helper reported an invalid stat entry", "HELPER_PROTOCOL_ERROR");
  }
  const record = value as Record<string, unknown>;
  const path = record.path;
  if (typeof path !== "string" || path.length === 0) {
    throw helperFailure("The helper reported an invalid stat entry", "HELPER_PROTOCOL_ERROR");
  }
  const size = typeof record.size === "number" ? record.size : undefined;
  const mtimeMs = typeof record.mtimeMs === "number" ? record.mtimeMs : undefined;
  const mode = typeof record.mode === "number" ? record.mode : undefined;
  const exists = typeof record.exists === "boolean" ? record.exists : size !== undefined || mtimeMs !== undefined;
  return { path, exists, size, mtimeMs, mode };
}

/**
 * Accepts the canonical mirror root `root.register` returned. Remote hosts are
 * POSIX, so the root is absolute and free of `..`, backslashes and NUL bytes;
 * the helper still checks it against its own registry on every request.
 */
export function validateProjectRoot(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_REMOTE_PATH_CHARS ||
    !value.startsWith("/") ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "..")
  ) {
    throw helperFailure("The mirror root is not a usable absolute path", "INVALID_ARGUMENT");
  }
  return value;
}

/**
 * Registers a mirror root with the helper and returns the canonical form every
 * later file operation names. Registration is idempotent on the helper side, so
 * each new connection may repeat it.
 */
export async function registerHelperRoot(
  client: HelperClient,
  mirrorRoot: string,
  options: TransferOptions = {},
): Promise<string> {
  const requested = validateProjectRoot(mirrorRoot);
  const result = await client.request(
    "root.register",
    { path: requested },
    options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
  );
  try {
    return validateProjectRoot(result.root);
  } catch {
    throw helperFailure("The helper reported an invalid mirror root", "HELPER_PROTOCOL_ERROR");
  }
}

/**
 * File operations against one registered mirror root. `root` is the canonical
 * value `registerHelperRoot` returned; the helper refuses any other, and never
 * resolves a file operation into its own directory.
 */
export function createHelperFs(client: HelperClient, root: string): HelperFs {
  const projectRoot = validateProjectRoot(root);
  async function putFile(remotePath: string, source: Uint8Array | string, options: PutFileOptions = {}): Promise<PutFileResult> {
    const path = validateRemotePath(remotePath);
    const expected = normaliseExpectedSha256(options.expectedSha256);
    const input = normalisePutSource(source);
    throwIfAborted(options.signal);
    const size = await measureSource(input);
    if (size > MAX_TRANSFER_BYTES) {
      throw helperFailure("The file exceeds the 50 MB transfer ceiling", "MIRROR_FILE_TOO_LARGE");
    }
    const sha256 = await digestSource(input, size);
    if (expected !== null && expected !== sha256) {
      throw helperFailure("The local content does not match the expected digest", "REMOTE_TRANSFER_FAILED");
    }
    throwIfAborted(options.signal);
    const guard = abortGuard(options.signal);
    // fs.put.chunk and fs.put.end exist in the operation table as the stream
    // stages; on the wire the bytes travel as DATA frames and the stream is
    // terminated by an END frame, so only fs.put.begin is a control request.
    const stream = client.beginStream({
      op: "fs.put.begin",
      params: { root: projectRoot, path, size, sha256 },
      streamId: options.streamId,
      timeoutMs: options.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS,
    });
    const state: { failure: HelperFailure | null } = { failure: null };
    const outcome = stream.response.catch((error: unknown) => {
      state.failure = asTransferError(error);
      throw state.failure;
    });
    void outcome.catch(() => undefined);
    try {
      const chunks: AsyncIterable<Uint8Array> = input.kind === "bytes"
        ? bytesChunks(input.bytes)
        : readLocalChunks(input.path, size);
      for await (const chunk of chunks) {
        throwIfAborted(options.signal);
        if (state.failure) throw state.failure;
        await guard.race(client.writeStreamData(stream.streamId, chunk));
      }
      throwIfAborted(options.signal);
      if (state.failure) throw state.failure;
      await guard.race(client.writeStreamEnd(stream.streamId));
      const result = await guard.race(outcome);
      return { path, size, sha256, result };
    } catch (error) {
      // The peer keeps no committed file: an upload that never reaches END is
      // discarded, so cancellation abandons the stream instead of ending it.
      client.abandonStream(stream.streamId, asTransferError(error));
      throw asTransferError(error);
    } finally {
      guard.dispose();
      client.closeStream(stream.streamId);
    }
  }

  async function getFile(remotePath: string, sink: FileSink, options: GetFileOptions = {}): Promise<GetFileResult> {
    const path = validateRemotePath(remotePath);
    const writer = normaliseSink(sink);
    throwIfAborted(options.signal);
    const guard = abortGuard(options.signal);
    const hash = createHash("sha256");
    let received = 0;
    const stream = client.beginStream({
      op: "fs.get.begin",
      params: { root: projectRoot, path },
      streamId: options.streamId,
      timeoutMs: options.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS,
      onData: async (bytes) => {
        received += bytes.byteLength;
        if (received > MAX_TRANSFER_BYTES) {
          throw helperFailure("The helper sent more than the 50 MB transfer ceiling", "MIRROR_FILE_TOO_LARGE");
        }
        hash.update(bytes);
        await writer.write(bytes);
      },
    });
    try {
      const begin = await guard.race(stream.response);
      const declared = typeof begin.size === "number" ? begin.size : null;
      if (declared !== null && declared > MAX_TRANSFER_BYTES) {
        throw helperFailure("The remote file exceeds the 50 MB transfer ceiling", "MIRROR_FILE_TOO_LARGE");
      }
      await guard.race(stream.completed);
      if (writer.end) await guard.race(Promise.resolve(writer.end()));
      if (declared !== null && declared !== received) {
        throw helperFailure("The helper delivered a different byte count than it announced", "REMOTE_TRANSFER_FAILED");
      }
      if (options.expectedSize !== undefined && options.expectedSize !== received) {
        throw helperFailure("The downloaded size does not match the expected size", "REMOTE_TRANSFER_FAILED");
      }
      const reported = typeof begin.sha256 === "string" ? begin.sha256.toLowerCase() : "";
      const sha256 = SHA256_PATTERN.test(reported) ? reported : hash.digest("hex");
      return { path, size: received, sha256, result: begin };
    } catch (error) {
      client.abandonStream(stream.streamId, asTransferError(error));
      throw asTransferError(error);
    } finally {
      guard.dispose();
      client.closeStream(stream.streamId);
    }
  }

  async function stat(paths: string | readonly string[], options: TransferOptions = {}): Promise<RemoteStatEntry[]> {
    const list = remotePathList(paths);
    const result = await client.request("fs.stat", { root: projectRoot, paths: list }, options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS);
    return entryArray(result).map((entry) => normaliseStatEntry(entry));
  }

  async function hashRemote(path: string, options: TransferOptions = {}): Promise<RemoteDigest> {
    const target = validateRemotePath(path);
    const result = await client.request("fs.hash", { root: projectRoot, path: target }, options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS);
    const reported = typeof result.sha256 === "string" ? result.sha256 : typeof result.hash === "string" ? result.hash : "";
    if (!SHA256_PATTERN.test(reported.toLowerCase())) {
      throw helperFailure("The helper reported an invalid digest", "HELPER_PROTOCOL_ERROR");
    }
    return { path: target, sha256: reported.toLowerCase() };
  }

  async function mkdirs(paths: string | readonly string[], options: TransferOptions = {}): Promise<string[]> {
    const list = remotePathList(paths);
    const result = await client.request("fs.mkdirs", { root: projectRoot, paths: list }, options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS);
    for (const key of ["created", "directories", "paths"]) {
      const value = result[key];
      if (!Array.isArray(value)) continue;
      if (value.some((entry) => typeof entry !== "string")) break;
      return value as string[];
    }
    throw helperFailure("The helper reported an invalid mkdir result", "HELPER_PROTOCOL_ERROR");
  }

  return { stat, hash: hashRemote, mkdirs, putFile, getFile };
}
