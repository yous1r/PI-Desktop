/** Bounded persistent cache for verified pi-host release archives. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { checksumMatches, normalizeChecksum, parseChecksumFile } from "./pi-host-release.js";

export const MAX_PI_HOST_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_RELEASES = 8;
const MAX_CACHE_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_RELEASE_VERSION_LENGTH = 128;
// Invalidate pre-republish archives whose PTY exceeded the glibc 2.28 baseline.
const CACHE_SCHEMA_VERSION = 2;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const cacheTails = new Map<string, Promise<void>>();

type ReleaseIdentity = { url: string; artifactName: string; key: string };
type CacheManifest = {
  schemaVersion: typeof CACHE_SCHEMA_VERSION;
  url: string;
  artifactName: string;
  sha256: string;
  size: number;
};
export type PiHostArtifactLease = {
  path: string;
  expectedSha256: string;
  /** Keep the cache entry stable until the upload has finished reading it. */
  release(): Promise<void>;
};
export type AcquirePiHostArtifactInput = {
  directory: string;
  url: string;
  artifactName: string;
  signal?: AbortSignal;
  fetchChecksum: (url: string, signal?: AbortSignal) => Promise<string>;
  fetchArtifact?: typeof fetch;
  beforeDownload?: () => Promise<void>;
  onChecksumDownload?: () => void;
  onDownload?: () => void;
};

function failure(errorCode: string): Error {
  return Object.assign(new Error("The pi-host release artifact could not be verified"), { errorCode });
}

function errorCodeOf(error: unknown): string | undefined {
  return (error as { errorCode?: string } | null)?.errorCode;
}

function identityFor(urlValue: string, artifactName: string): ReleaseIdentity {
  let url: URL;
  try { url = new URL(urlValue); } catch { throw failure("HOST_INTEGRITY_FAILED"); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password
    || url.port || url.search || url.hash || url.href !== urlValue) {
    throw failure("HOST_INTEGRITY_FAILED");
  }
  const segments = url.pathname.split("/");
  if (segments.length !== 7 || segments[1] !== "yous1r" || segments[2] !== "PI-Desktop"
    || segments[3] !== "releases" || segments[4] !== "download") {
    throw failure("HOST_INTEGRITY_FAILED");
  }
  const version = segments[5]?.startsWith("v") ? segments[5].slice(1) : "";
  const nameMatch = /^pi-host-(.+)-linux-(x64|arm64)\.tar\.gz$/.exec(artifactName);
  if (!version || version.length > MAX_RELEASE_VERSION_LENGTH || !VERSION_PATTERN.test(version)
    || !nameMatch || nameMatch[1] !== version || segments[6] !== artifactName) {
    throw failure("HOST_INTEGRITY_FAILED");
  }
  return { url: urlValue, artifactName, key: createHash("sha256").update(urlValue, "utf8").digest("hex") };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolvePromise(value); },
      error => { signal.removeEventListener("abort", onAbort); rejectPromise(error); },
    );
  });
}

/** Serialize cache mutations and archive staging within one process; waiters cancel independently. */
async function acquireCacheLock(directory: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  signal?.throwIfAborted();
  const previous = cacheTails.get(directory) ?? Promise.resolve();
  let unlock!: () => void;
  const held = new Promise<void>(resolvePromise => { unlock = resolvePromise; });
  const tail = previous.then(() => held);
  cacheTails.set(directory, tail);
  try {
    await waitFor(previous, signal);
    signal?.throwIfAborted();
  } catch (error) {
    unlock();
    void tail.then(() => { if (cacheTails.get(directory) === tail) cacheTails.delete(directory); });
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    unlock();
    await tail;
    if (cacheTails.get(directory) === tail) cacheTails.delete(directory);
  };
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure("HOST_INTEGRITY_FAILED");
  await chmod(path, 0o700);
}

function manifestPath(releasesDir: string, key: string): string {
  return join(releasesDir, `${key}.json`);
}
function archivePath(archivesDir: string, digest: string): string {
  return join(archivesDir, `${digest}.tar.gz`);
}

function isManifest(value: unknown, identity: ReleaseIdentity): value is CacheManifest {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CacheManifest>;
  return item.schemaVersion === CACHE_SCHEMA_VERSION
    && item.url === identity.url
    && item.artifactName === identity.artifactName
    && typeof item.sha256 === "string" && SHA256_PATTERN.test(item.sha256)
    && typeof item.size === "number" && Number.isSafeInteger(item.size)
    && item.size > 0 && item.size <= MAX_PI_HOST_ARTIFACT_BYTES;
}

async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

async function readManifest(path: string, identity: ReleaseIdentity): Promise<CacheManifest | null> {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES) {
    await removeFile(path);
    return null;
  }
  await chmod(path, 0o600);
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) { await removeFile(path); return null; }
    throw error;
  }
  if (!isManifest(parsed, identity) || normalizeChecksum(parsed.sha256) !== parsed.sha256) {
    await removeFile(path);
    return null;
  }
  return parsed;
}

async function hashFile(path: string, signal?: AbortSignal): Promise<{ digest: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_PI_HOST_ARTIFACT_BYTES) { callback(failure("HOST_INTEGRITY_FAILED")); return; }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(createReadStream(path), verifier, new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    ...(signal ? [{ signal }] : []));
  return { digest: hash.digest("hex"), size };
}

async function findCachedArtifact(
  identity: ReleaseIdentity,
  releasesDir: string,
  archivesDir: string,
  signal?: AbortSignal,
): Promise<{ manifest: CacheManifest; path: string } | null> {
  const path = manifestPath(releasesDir, identity.key);
  const manifest = await readManifest(path, identity);
  if (!manifest) return null;
  const cachedPath = archivePath(archivesDir, manifest.sha256);
  let info;
  try { info = await lstat(cachedPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { await removeFile(path); return null; }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== manifest.size
    || info.size <= 0 || info.size > MAX_PI_HOST_ARTIFACT_BYTES) {
    await removeFile(path);
    await removeFile(cachedPath);
    return null;
  }
  await chmod(cachedPath, 0o600);
  const actual = await hashFile(cachedPath, signal);
  if (actual.size !== manifest.size || !checksumMatches(actual.digest, manifest.sha256)) {
    await removeFile(path);
    await removeFile(cachedPath);
    return null;
  }
  return { manifest, path: cachedPath };
}

async function downloadVerifiedArchive(input: {
  identity: ReleaseIdentity;
  digest: string;
  archivesDir: string;
  signal?: AbortSignal;
  fetchArtifact?: typeof fetch;
  onDownload?: () => void;
}): Promise<{ path: string; size: number }> {
  const timeoutSignal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(600_000)])
    : AbortSignal.timeout(600_000);
  let temporaryPath: string | undefined;
  try {
    input.signal?.throwIfAborted();
    input.onDownload?.();
    const response = await (input.fetchArtifact ?? fetch)(input.identity.url, {
      signal: timeoutSignal,
      redirect: "follow",
    });
    if (response.status === 404) throw failure("HOST_RELEASE_UNAVAILABLE");
    if (!response.ok || !response.body) throw failure("HOST_DOWNLOAD_FAILED");
    if (response.url) {
      let finalUrl: URL;
      try { finalUrl = new URL(response.url); } catch { throw failure("HOST_INTEGRITY_FAILED"); }
      if (finalUrl.protocol !== "https:" || finalUrl.username || finalUrl.password) throw failure("HOST_INTEGRITY_FAILED");
    }
    temporaryPath = join(input.archivesDir, `.partial-${process.pid}-${createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 16)}`);
    const hash = createHash("sha256");
    let size = 0;
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_PI_HOST_ARTIFACT_BYTES) { callback(failure("HOST_INTEGRITY_FAILED")); return; }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    const reader = response.body.getReader();
    const chunks = (async function* () {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          yield chunk.value;
        }
      } finally {
        try { await reader.cancel(); }
        finally { reader.releaseLock(); }
      }
    })();
    await pipeline(Readable.from(chunks), verify,
      createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }), { signal: timeoutSignal });
    if (size === 0 || !checksumMatches(hash.digest("hex"), input.digest)) throw failure("HOST_INTEGRITY_FAILED");
    input.signal?.throwIfAborted();
    const verifiedPath = temporaryPath;
    temporaryPath = undefined;
    return { path: verifiedPath, size };
  } catch (error) {
    if (input.signal?.aborted) input.signal.throwIfAborted();
    const code = errorCodeOf(error);
    if (code && ["HOST_RELEASE_UNAVAILABLE", "HOST_DOWNLOAD_FAILED", "HOST_INTEGRITY_FAILED", "HOST_NETWORK_NOT_READY"].includes(code)) {
      throw error;
    }
    throw failure("HOST_DOWNLOAD_FAILED");
  } finally {
    if (temporaryPath) await removeFile(temporaryPath);
  }
}

async function pruneCache(releasesDir: string, archivesDir: string, protectedDigests: ReadonlySet<string> = new Set()): Promise<void> {
  const manifests: Array<{ key: string; path: string; modified: number; digest?: string; size?: number }> = [];
  for (const name of await readdir(releasesDir)) {
    const match = /^([0-9a-f]{64})\.json$/.exec(name);
    if (!match) continue;
    const path = manifestPath(releasesDir, match[1]!);
    const info = await lstat(path);
    let document: unknown;
    try {
      if (info.isFile() && !info.isSymbolicLink() && info.size <= MAX_MANIFEST_BYTES) {
        document = JSON.parse(await readFile(path, "utf8"));
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const value = document as Partial<CacheManifest> | undefined;
    let identity: ReleaseIdentity | null = null;
    if (typeof value?.url === "string" && typeof value.artifactName === "string") {
      try { identity = identityFor(value.url, value.artifactName); }
      catch (error) { if (errorCodeOf(error) !== "HOST_INTEGRITY_FAILED") throw error; }
    }
    if (identity?.key === match[1] && isManifest(value, identity)) {
      manifests.push({ key: match[1]!, path, modified: info.mtimeMs, digest: value.sha256, size: value.size });
    } else {
      await removeFile(path);
    }
  }
  manifests.sort((left, right) => left.modified - right.modified || left.key.localeCompare(right.key));
  let totalBytes = manifests.reduce((sum, item) => sum + (item.size ?? 0), 0);
  while (manifests.length > MAX_CACHE_RELEASES || totalBytes > MAX_CACHE_BYTES) {
    const removableIndex = manifests.findIndex(item => !item.digest || !protectedDigests.has(item.digest));
    if (removableIndex < 0) break;
    const [removed] = manifests.splice(removableIndex, 1);
    if (!removed) break;
    totalBytes -= removed.size ?? 0;
    await removeFile(removed.path);
  }
  const referenced = new Set(manifests.map(item => item.digest).filter((digest): digest is string => Boolean(digest)));
  for (const name of await readdir(archivesDir)) {
    const match = /^([0-9a-f]{64})\.tar\.gz$/.exec(name);
    if (match && !referenced.has(match[1]!)) await removeFile(archivePath(archivesDir, match[1]!));
    else if (name.startsWith(".partial-")) await removeFile(join(archivesDir, name));
  }
}

async function publishManifest(path: string, manifest: CacheManifest): Promise<void> {
  const temporaryPath = `${path}.partial-${process.pid}-${createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 16)}`;
  try {
    await writeFile(temporaryPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await removeFile(temporaryPath);
  }
}

/**
 * Return a private verified archive lease. Cache hits rehash bytes before they
 * can be staged for upload. Misses use the injected Desktop network policy and
 * publish an archive/manifest only after the published checksum matches.
 */
export async function acquirePiHostArtifact(input: AcquirePiHostArtifactInput): Promise<PiHostArtifactLease> {
  const identity = identityFor(input.url, input.artifactName);
  const root = resolve(input.directory);
  const releaseLock = await acquireCacheLock(root, input.signal);
  let keepLock = false;
  let partialPath: string | undefined;
  try {
    input.signal?.throwIfAborted();
    await ensurePrivateDirectory(root);
    const releasesDir = join(root, "releases");
    const archivesDir = join(root, "archives");
    await ensurePrivateDirectory(releasesDir);
    await ensurePrivateDirectory(archivesDir);
    await pruneCache(releasesDir, archivesDir);
    const cached = await findCachedArtifact(identity, releasesDir, archivesDir, input.signal);
    if (cached) {
      input.signal?.throwIfAborted();
      keepLock = true;
      return { path: cached.path, expectedSha256: cached.manifest.sha256, release: releaseLock };
    }

    input.signal?.throwIfAborted();
    await input.beforeDownload?.();
    input.signal?.throwIfAborted();
    input.onChecksumDownload?.();
    const checksumText = await input.fetchChecksum(`${identity.url}.sha256`, input.signal);
    input.signal?.throwIfAborted();
    const digest = parseChecksumFile(checksumText, identity.artifactName);
    if (!digest) throw failure("HOST_INTEGRITY_FAILED");

    const downloaded = await downloadVerifiedArchive({
      identity,
      digest,
      archivesDir,
      signal: input.signal,
      fetchArtifact: input.fetchArtifact,
      onDownload: input.onDownload,
    });
    partialPath = downloaded.path;
    input.signal?.throwIfAborted();

    const finalArchivePath = archivePath(archivesDir, digest);
    await removeFile(finalArchivePath);
    await rename(partialPath, finalArchivePath);
    partialPath = undefined;
    const manifest: CacheManifest = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      url: identity.url,
      artifactName: identity.artifactName,
      sha256: digest,
      size: downloaded.size,
    };
    try {
      await publishManifest(manifestPath(releasesDir, identity.key), manifest);
    } catch (error) {
      await removeFile(finalArchivePath);
      throw error;
    }
    await pruneCache(releasesDir, archivesDir, new Set([digest]));
    input.signal?.throwIfAborted();
    keepLock = true;
    return { path: finalArchivePath, expectedSha256: digest, release: releaseLock };
  } finally {
    try { if (partialPath) await removeFile(partialPath); }
    finally { if (!keepLock) await releaseLock(); }
  }
}

/** Metadata paths are derived from the validated URL, never from manifest contents. */
export function piHostCachePaths(directory: string, url: string, artifactName: string): { manifest: string; archiveDirectory: string } {
  const identity = identityFor(url, artifactName);
  const root = resolve(directory);
  return {
    manifest: join(root, "releases", `${identity.key}.json`),
    archiveDirectory: join(root, "archives"),
  };
}
