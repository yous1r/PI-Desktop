#!/usr/bin/env node
/**
 * Publication gate for the release assets the remote-host bootstrap installs
 * (D375 / ADR 0284 / ADR 0338; `docs/spec/06-delivery/07-remote-control-rollout.md`
 * §6 acceptance 4).
 *
 * The desktop never uploads executable bytes. It resolves
 * `pi-host-<version>-linux-<arch>.tar.gz` and its `.sha256` sidecar at *its own*
 * version on the GitHub Release, keeps the published digest as the trust
 * anchor, and hands both to a bootstrap script that runs on the remote machine.
 * A release that is missing an architecture, whose sidecar names or hashes a
 * different file, or whose bundle declares another version therefore produces a
 * remote host that either cannot download or is refused after downloading.
 *
 * This gate runs on the merged artifact directory just before the GitHub
 * Release is created, so it validates the exact bytes that are about to be
 * published instead of the workflow's intent. It depends on nothing outside
 * Node: the tar reader below is a bounded, read-only ustar/GNU/pax walker over
 * `zlib`, because the publish job must not need a toolchain to verify itself.
 *
 * Usage:
 *   node scripts/check-pi-host-release-assets.mjs --dir dist --version 0.22.1 \
 *     [--targets linux-x64,linux-arm64]
 */
import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";

/**
 * Linux targets the desktop's release matrix publishes. The workflow passes the
 * same list explicitly; `scripts/check-pi-host-release-assets.test.mjs` keeps it
 * in lockstep with `PUBLISHED_TARGETS` in
 * `apps/desktop/electron/main/remote/pi-host-release.ts`.
 */
export const DEFAULT_TARGETS = ["linux-x64", "linux-arm64"];

/** Name `apps/pi-host/scripts/bundle.mjs` writes into the bundle manifest. */
const BUNDLE_PACKAGE_NAME = "pi-host";
const UPDATE_FEED_PATTERN = /^latest.*\.yml$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const TAR_BLOCK = 512;
/** Bounds for the archive walk: a release bundle stays far below these. */
const MAX_TAR_ENTRIES = 50_000;
const MAX_TAR_BYTES = 1024 * 1024 * 1024;
/** A bundle manifest is a few hundred bytes; anything larger is not one. */
const MAX_MANIFEST_BYTES = 64 * 1024;

/** Archive, sidecar, and unpacked-root names for one target. */
export function piHostAssetNames(version, target) {
  const root = `pi-host-${version}-${target}`;
  return { root, archive: `${root}.tar.gz`, sidecar: `${root}.tar.gz.sha256` };
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Read the digest out of a `sha256sum` record. `release.yml` writes
 * `<digest>  <name>`; the name is required and must be the artifact itself, so
 * a sidecar copied from another file can never be mistaken for this one.
 */
export function parseSidecarDigest(text, artifactName) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) {
    return { digest: null, reason: `records ${lines.length} checksums, expected exactly one` };
  }
  const [rawDigest, ...rest] = lines[0].split(/\s+/);
  const digest = String(rawDigest ?? "").toLowerCase();
  if (!SHA256_HEX.test(digest)) return { digest: null, reason: `has no sha256 digest ("${rawDigest}")` };
  const named = rest.join(" ").replace(/^\*/, "").split("/").pop() ?? "";
  if (!named) return { digest: null, reason: "names no artifact" };
  if (named !== artifactName) {
    return { digest: null, reason: `names "${named}" instead of "${artifactName}"` };
  }
  return { digest, reason: null };
}

/** Byte source over a chunk iterator that keeps at most one chunk buffered. */
class ChunkReader {
  constructor(chunks) {
    this.chunks = chunks[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.finished = false;
    this.bytes = 0;
  }

  async pull() {
    if (this.finished) return false;
    const { value, done } = await this.chunks.next();
    if (done) {
      this.finished = true;
      return false;
    }
    this.bytes += value.length;
    this.buffer = this.buffer.length === 0 ? value : Buffer.concat([this.buffer, value]);
    return true;
  }

  async take(count) {
    while (this.buffer.length < count && (await this.pull()));
    if (this.buffer.length < count) return null;
    const taken = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return taken;
  }

  async skip(count) {
    let remaining = count;
    while (remaining > 0) {
      if (this.buffer.length > 0) {
        const taken = Math.min(remaining, this.buffer.length);
        this.buffer = this.buffer.subarray(taken);
        remaining -= taken;
      } else if (!(await this.pull())) {
        return false;
      }
    }
    return true;
  }
}

function tarText(header, offset, length) {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString("utf8");
}

function tarNumber(header, offset, length) {
  const text = tarText(header, offset, length).trim();
  if (text.length === 0) return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid tar field "${text}"`);
  return value;
}

function tarPath(buffer) {
  const text = buffer.toString("utf8").replace(/\0[\s\S]*$/, "").trim();
  return text.length > 0 ? text : null;
}

function paxPath(buffer) {
  for (const record of buffer.toString("utf8").split("\n")) {
    const match = record.match(/^\d+ path=(.*)$/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Walk a gzipped tar archive without extracting it: every entry name plus the
 * contents of any `package.json` small enough to be a manifest. Paths supplied
 * by GNU (`L`) and pax (`x`) extension records are applied to the entry that
 * follows them, which is how long bundle paths are actually stored.
 */
export async function readTarArchive(archive, options = {}) {
  const maxEntries = options.maxEntries ?? MAX_TAR_ENTRIES;
  const maxBytes = options.maxBytes ?? MAX_TAR_BYTES;
  const reader = new ChunkReader(createReadStream(archive).pipe(createGunzip()));
  const entries = [];
  const files = new Map();
  let pendingPath = null;

  while (true) {
    const header = await reader.take(TAR_BLOCK);
    if (!header) break;
    if (header.every((byte) => byte === 0)) break;
    const size = tarNumber(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0x30);
    const prefix = tarText(header, 345, 155);
    const name = tarText(header, 0, 100);
    const padding = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;

    if (typeflag === "x" || typeflag === "g" || typeflag === "L" || typeflag === "K") {
      const data = size <= MAX_MANIFEST_BYTES ? await reader.take(size) : null;
      if (data && typeflag === "x") pendingPath = paxPath(data) ?? pendingPath;
      if (data && typeflag === "L") pendingPath = tarPath(data) ?? pendingPath;
      // `take` already consumed the header payload, so only its padding is left.
      await reader.skip(data ? padding : size + padding);
      if (reader.bytes > maxBytes) {
        throw new Error(`archive expands past ${maxBytes} bytes`);
      }
      continue;
    }

    const entryName = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
    pendingPath = null;
    if (entries.length >= maxEntries) throw new Error(`archive lists more than ${maxEntries} entries`);
    entries.push({ name: entryName, size, typeflag });
    if (path.posix.basename(entryName) === "package.json" && size <= MAX_MANIFEST_BYTES) {
      const data = await reader.take(size);
      if (data) files.set(entryName, data);
      await reader.skip(padding);
    } else {
      await reader.skip(size + padding);
    }
    if (reader.bytes > maxBytes) throw new Error(`archive expands past ${maxBytes} bytes`);
  }

  return { entries, files, scannedBytes: reader.bytes };
}

async function isRegularFile(file) {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/**
 * Every `latest*.yml` electron-updater feed in the merged artifact directory
 * must describe this release. Feeds that this matrix does not produce are
 * simply absent and are not required.
 */
async function collectUpdateFeeds(directory, version, errors) {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && UPDATE_FEED_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const feeds = [];
  for (const name of names) {
    const text = await readFile(path.join(directory, name), "utf8");
    const value =
      text
        .match(/^version:[ \t]*(.+)$/m)?.[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, "") ?? null;
    if (!value) errors.push(`${name} has no version field`);
    else if (value !== version) errors.push(`${name} publishes version ${value}, expected ${version}`);
    else feeds.push({ name, version: value });
  }
  if (feeds.length === 0 && errors.length === 0) {
    errors.push(`no desktop updater feed (latest*.yml) was published for ${version}`);
  }
  return feeds;
}

/**
 * Verify both published `pi-host` archives, their named sidecars, the bytes
 * they hash to, the bundle root, the manifest version, and every updater feed
 * this release publishes.
 */
export async function checkPiHostReleaseAssets({ directory, version, targets = DEFAULT_TARGETS }) {
  const errors = [];
  const verified = [];
  for (const target of targets) {
    const names = piHostAssetNames(version, target);
    const archivePath = path.join(directory, names.archive);
    const sidecarPath = path.join(directory, names.sidecar);
    if (!(await isRegularFile(archivePath))) {
      errors.push(`${names.archive} is missing; the ${target} remote bootstrap has nothing to download`);
      continue;
    }
    if (!(await isRegularFile(sidecarPath))) {
      errors.push(`${names.sidecar} is missing; the ${target} download cannot be verified`);
      continue;
    }

    const recorded = parseSidecarDigest(await readFile(sidecarPath, "utf8"), names.archive);
    if (!recorded.digest) {
      errors.push(`${names.sidecar} ${recorded.reason}`);
      continue;
    }
    const actual = await sha256File(archivePath);
    if (actual !== recorded.digest) {
      errors.push(`${names.sidecar} records ${recorded.digest} but ${names.archive} hashes to ${actual}`);
      continue;
    }

    let listing;
    try {
      listing = await readTarArchive(archivePath);
    } catch (error) {
      errors.push(`${names.archive} cannot be read: ${error.message}`);
      continue;
    }
    const normalized = (entryName) => entryName.replace(/\/+$/, "");
    if (listing.entries.length === 0) {
      errors.push(`${names.archive} contains no entries`);
      continue;
    }
    const first = normalized(listing.entries[0].name);
    if (first !== names.root) {
      errors.push(
        `${names.archive} unpacks to "${first}", expected the "${names.root}" bundle root`,
      );
      continue;
    }
    const outside = listing.entries.find(
      (entry) => normalized(entry.name) !== names.root && !entry.name.startsWith(`${names.root}/`),
    );
    if (outside) {
      errors.push(`${names.archive} contains "${outside.name}" outside the "${names.root}/" bundle root`);
      continue;
    }
    const manifestSource = listing.files.get(`${names.root}/package.json`);
    if (!manifestSource) {
      errors.push(`${names.archive} has no ${names.root}/package.json`);
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(manifestSource.toString("utf8"));
    } catch {
      errors.push(`${names.archive} contains a ${names.root}/package.json that is not valid JSON`);
      continue;
    }
    if (manifest.name !== BUNDLE_PACKAGE_NAME) {
      errors.push(
        `${names.archive} package.json names "${manifest.name}", expected "${BUNDLE_PACKAGE_NAME}"`,
      );
      continue;
    }
    if (manifest.version !== version) {
      errors.push(
        `${names.archive} package.json version "${manifest.version}" does not match ${version}`,
      );
      continue;
    }
    verified.push({
      target,
      archive: names.archive,
      digest: actual,
      entries: listing.entries.length,
      scannedBytes: listing.scannedBytes,
    });
  }

  const feeds = await collectUpdateFeeds(directory, version, errors);
  return { errors, verified, feeds };
}

function parseArgs(argv) {
  const options = { directory: "", version: "", targets: DEFAULT_TARGETS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--dir" || arg === "--directory") options.directory = argv[++index] || "";
    else if (arg.startsWith("--dir=")) options.directory = arg.slice("--dir=".length);
    else if (arg === "--version") options.version = argv[++index] || "";
    else if (arg.startsWith("--version=")) options.version = arg.slice("--version=".length);
    else if (arg === "--targets") options.targets = splitTargets(argv[++index] || "");
    else if (arg.startsWith("--targets=")) options.targets = splitTargets(arg.slice("--targets=".length));
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function splitTargets(value) {
  return value
    .split(",")
    .map((target) => target.trim())
    .filter((target) => target.length > 0);
}

function usage() {
  console.error(
    "Usage: node scripts/check-pi-host-release-assets.mjs --dir <artifact-dir> --version <x.y.z> " +
      "[--targets linux-x64,linux-arm64]",
  );
}

const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
    } else {
      const version = options.version.trim().replace(/^v/, "");
      if (!options.directory) throw new Error("--dir requires a value");
      if (!version) throw new Error("--version requires a value");
      if (!SEMVER.test(version)) throw new Error(`--version "${options.version}" is not a release version`);
      if (options.targets.length === 0) throw new Error("--targets requires at least one target");
      for (const target of options.targets) {
        if (!/^[a-z0-9]+-(?:x64|arm64)$/.test(target)) {
          throw new Error(`--targets entry "${target}" is not a <platform>-<arch> target`);
        }
      }

      const result = await checkPiHostReleaseAssets({ ...options, version });
      if (result.errors.length) {
        for (const error of result.errors) console.error(`::error::${error}`);
        console.error(`Release asset check failed for ${version}: ${result.errors.length} problem(s).`);
        process.exitCode = 1;
      } else {
        console.log(`Release asset check passed for ${version}:`);
        for (const asset of result.verified) {
          console.log(
            `  ${asset.archive} sha256 ${asset.digest} (${asset.entries} entries)`,
          );
        }
        for (const feed of result.feeds) console.log(`  updater feed ${feed.name}: ${feed.version}`);
      }
    }
  } catch (error) {
    usage();
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
