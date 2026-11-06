#!/usr/bin/env node
/**
 * Release version-parity gate (D164 + D260 version-surface table,
 * `docs/spec/06-delivery/06-release-runbook.md` §4.1).
 *
 * Every shipped artifact is stamped with `apps/desktop/package.json`: the
 * installers, the in-app About panel (`APP_VERSION`), the Rust sidecar
 * (`[workspace.package]`), and the `pi-host` bundle the SSH bootstrap installs
 * on a remote machine (`apps/pi-host/package.json`, which names the release
 * archive). A surface that lags the desktop publishes a release whose parts
 * disagree about their own version, which is only discovered by a user whose
 * remote host refuses to start.
 *
 * The gate is intentionally narrow: it checks version *numbers* only. The
 * stable-release changelog/README preflight lives in
 * `scripts/check-release-docs.mjs` and is run by `scripts/release.mjs` before a
 * stable tag, so a prerelease (`x.y.z-beta.N`) is never blocked here on stable
 * changelog entries it must not carry.
 *
 * Usage:
 *   node scripts/check-release-versions.mjs                 # every surface agrees
 *   node scripts/check-release-versions.mjs --tag v0.22.1   # ... and matches the tag
 *   node scripts/check-release-versions.mjs --root <dir>
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DESKTOP_PACKAGE = "apps/desktop/package.json";
const PROTOCOL_SOURCE = "packages/shared/src/protocol.ts";
const CARGO_MANIFEST = "Cargo.toml";
const CARGO_LOCK = "Cargo.lock";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const readText = (file) => readFileSync(file, "utf8");

/**
 * `scripts/release.mjs` bumps the root manifest, the third workspace root
 * `docs`, and one manifest per directory under `apps/` and `packages/`, so the
 * gate enumerates the same set instead of keeping a list that can drift.
 */
function listWorkspacePackageFiles(root) {
  const files = ["package.json", "docs/package.json"];
  for (const group of ["apps", "packages"]) {
    const directory = path.join(root, group);
    if (!existsSync(directory)) continue;
    const names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      const relative = `${group}/${name}/package.json`;
      if (existsSync(path.join(root, relative))) files.push(relative);
    }
  }
  return files;
}

function packageVersionSurfaces(root) {
  return listWorkspacePackageFiles(root).map((relative) => {
    const manifest = JSON.parse(readText(path.join(root, relative)));
    return {
      file: relative,
      version: typeof manifest.version === "string" ? manifest.version : null,
    };
  });
}

/** Body of a TOML table, up to the next table header. */
function tomlSection(source, header) {
  const start = source.indexOf(header);
  if (start < 0) return null;
  const body = source.slice(start + header.length);
  const next = body.search(/\n\[/);
  return next < 0 ? body : body.slice(0, next);
}

function cargoVersionSurfaces(root) {
  const errors = [];
  const surfaces = [];
  const manifestPath = path.join(root, CARGO_MANIFEST);
  if (!existsSync(manifestPath)) {
    return {
      surfaces,
      errors: [`${CARGO_MANIFEST} is missing; the Rust workspace version cannot be checked`],
    };
  }

  const manifest = readText(manifestPath);
  const workspacePackage = tomlSection(manifest, "[workspace.package]") ?? "";
  const workspaceVersion = workspacePackage.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
  surfaces.push({ file: `${CARGO_MANIFEST} [workspace.package]`, version: workspaceVersion });

  const workspace = tomlSection(manifest, "[workspace]") ?? "";
  const membersSource = workspace.match(/^\s*members\s*=\s*\[([\s\S]*?)\]/m)?.[1] ?? "";
  const members = [...membersSource.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const crateNames = [];
  for (const member of members) {
    const relative = path.posix.join(member, "Cargo.toml");
    const cratePath = path.join(root, relative);
    if (!existsSync(cratePath)) {
      errors.push(`workspace member ${member} has no Cargo.toml`);
      continue;
    }
    const crate = readText(cratePath);
    const packageSection = tomlSection(crate, "[package]") ?? "";
    const name = packageSection.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? member;
    crateNames.push(name);
    // An inherited version cannot drift on its own, so it is reported at the
    // inherited value instead of adding an unfixable duplicate surface. Both
    // spellings Cargo accepts are read: `version.workspace = true` and
    // `version = { workspace = true }`.
    const inherits =
      /^\s*version(?:\.workspace\s*=\s*true|\s*=\s*\{\s*workspace\s*=\s*true\s*\})/m.test(
        packageSection,
      );
    const own = packageSection.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    surfaces.push({
      file: `${relative}${inherits ? " (version.workspace = true)" : ""}`,
      version: inherits ? workspaceVersion : own,
    });
  }

  const lockPath = path.join(root, CARGO_LOCK);
  if (!existsSync(lockPath)) {
    errors.push(`${CARGO_LOCK} is missing; the locked crate versions cannot be checked`);
  } else {
    const blocks = readText(lockPath)
      .split(/^\[\[package\]\]$/m)
      .slice(1);
    for (const crateName of crateNames) {
      const block = blocks.find(
        (candidate) => (candidate.match(/^\s*name = "([^"]+)"/m)?.[1] ?? "") === crateName,
      );
      const version = block?.match(/^\s*version = "([^"]+)"/m)?.[1] ?? null;
      surfaces.push({ file: `${CARGO_LOCK} ${crateName}`, version });
    }
  }
  return { surfaces, errors };
}

function protocolVersionSurface(root) {
  const protocolPath = path.join(root, PROTOCOL_SOURCE);
  if (!existsSync(protocolPath)) {
    return { file: `${PROTOCOL_SOURCE} APP_VERSION`, version: null };
  }
  const version =
    readText(protocolPath).match(/^\s*export const APP_VERSION = "([^"]+)";?/m)?.[1] ?? null;
  return { file: `${PROTOCOL_SOURCE} APP_VERSION`, version };
}

/**
 * Compare every version surface with the desktop version and, on a tag build,
 * with the tag itself. Pure: it reads files under `root` and returns errors.
 */
export function evaluateReleaseVersions({ root = DEFAULT_ROOT, tag } = {}) {
  const errors = [];
  const desktopPath = path.join(root, DESKTOP_PACKAGE);
  let desktopVersion = null;
  if (!existsSync(desktopPath)) {
    errors.push(`${DESKTOP_PACKAGE} is missing; there is no reference version to compare`);
  } else {
    const manifest = JSON.parse(readText(desktopPath));
    desktopVersion = typeof manifest.version === "string" ? manifest.version : null;
    if (!desktopVersion) errors.push(`${DESKTOP_PACKAGE} has no version`);
    else if (!SEMVER.test(desktopVersion)) {
      errors.push(`${DESKTOP_PACKAGE} version "${desktopVersion}" is not a semver version`);
    }
  }

  let tagVersion = null;
  if (tag !== undefined && tag !== null && String(tag).trim() !== "") {
    tagVersion = String(tag).trim().replace(/^v/, "");
    if (!SEMVER.test(tagVersion)) {
      errors.push(`release tag "${tag}" is not v<major>.<minor>.<patch>[-prerelease]`);
      tagVersion = null;
    } else if (desktopVersion && tagVersion !== desktopVersion) {
      errors.push(`tag v${tagVersion} does not match ${DESKTOP_PACKAGE} version ${desktopVersion}`);
    }
  }

  const cargo = cargoVersionSurfaces(root);
  errors.push(...cargo.errors);
  const surfaces = [
    ...packageVersionSurfaces(root),
    ...cargo.surfaces,
    protocolVersionSurface(root),
  ];
  const expected = tagVersion ?? desktopVersion;
  for (const surface of surfaces) {
    if (surface.version === null) {
      errors.push(`${surface.file} has no version`);
    } else if (expected && surface.version !== expected) {
      errors.push(`${surface.file} is ${surface.version}, expected ${expected}`);
    }
  }

  return { desktopVersion, tagVersion, expected, surfaces, errors };
}

function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, tag: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--root") options.root = argv[++index] || "";
    else if (arg.startsWith("--root=")) options.root = arg.slice("--root=".length);
    else if (arg === "--tag") options.tag = argv[++index] ?? "";
    else if (arg.startsWith("--tag=")) options.tag = arg.slice("--tag=".length);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  console.error(
    "Usage: node scripts/check-release-versions.mjs [--tag vX.Y.Z] [--root <dir>]",
  );
}

export { DEFAULT_ROOT };

const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
    } else if (!options.root) {
      throw new Error("--root requires a value");
    } else {
      const result = evaluateReleaseVersions(options);
      if (result.errors.length) {
        for (const error of result.errors) console.error(`::error::${error}`);
        console.error(
          `Release version check failed: ${result.errors.length} surface(s) disagree ` +
            `(expected ${result.expected ?? "a consistent version"}).`,
        );
        process.exitCode = 1;
      } else {
        const scope = result.tagVersion ? ` tag v${result.tagVersion}` : " workspace";
        console.log(`Release version check passed for${scope}: ${result.expected}`);
        for (const surface of result.surfaces) {
          console.log(`  ${surface.file}: ${surface.version}`);
        }
      }
    }
  } catch (error) {
    usage();
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
