#!/usr/bin/env node
/**
 * Build the `node-pty` addon the pi-host bundle ships against a fixed glibc
 * baseline (manylinux_2_28 / glibc 2.28) instead of the release runner's.
 *
 * `pnpm install` compiles node-pty on the runner (Ubuntu 22.04/24.04), so the
 * `pty.node` in the workspace needs GLIBC_2.32/2.34. That file is what the
 * bundle used to ship, and a remote machine on an older distribution only
 * fails at `dlopen` time: the user sees "terminals are disabled" long after the
 * install reported success.
 *
 * Only the addon has that problem. The official Node 24 runtime already starts
 * on glibc 2.28 and host-core is a static musl binary, so the runtime stays as
 * it is and just this module is rebuilt on the baseline.
 *
 * The build is deliberately boring and reproducible:
 *   1. copy the pristine node-pty source and node-addon-api into a work dir
 *      (never `build/` or `prebuilds/`, so no host or foreign-ABI addon can
 *      reach the output),
 *   2. download the Node headers for the exact Node version the bundle copies,
 *      verified against nodejs.org SHASUMS256,
 *   3. let the workspace's installed node-gyp compile `src/unix/pty.cc` inside
 *      a `--network none` manylinux_2_28 container, using the Node binary the
 *      bundle ships and the provisioned dependency tree read-only,
 *   4. publish a standalone node-pty tree (runtime files plus the freshly
 *      compiled addon) to `--out`.
 *
 * Usage:
 *   node apps/pi-host/scripts/build-compatible-pty.mjs --arch x64 --out /tmp/pty
 *
 * On success it prints `PI_HOST_PTY_DIR=<out>`; the release workflow passes
 * that path to `apps/pi-host/scripts/bundle.mjs --pty <out>`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const root = resolve(app, "../..");
const require = createRequire(import.meta.url);

/**
 * One entry per native Linux architecture the release publishes. The image
 * arch and the Docker arch are spelled out so a mislabelled or emulated runner
 * fails instead of producing an addon for the other architecture.
 */
export const ARCHITECTURES = {
  x64: {
    image: "quay.io/pypa/manylinux_2_28_x86_64",
    dockerArch: "amd64",
    elfMachine: /Advanced Micro Devices X86-64/,
    elfMachineName: "x86-64",
  },
  arm64: {
    image: "quay.io/pypa/manylinux_2_28_aarch64",
    dockerArch: "arm64",
    elfMachine: /AArch64/,
    elfMachineName: "AArch64",
  },
};

/** Everything node-pty needs at runtime; build inputs and sources stay behind. */
export const PTY_RUNTIME_ENTRIES = ["package.json", "LICENSE", "lib", "typings"];

/** Directories that must never be copied from the workspace's installed package. */
const PTY_SOURCE_EXCLUSIONS = new Set(["build", "prebuilds", "node_modules"]);

const USAGE = `Usage: node apps/pi-host/scripts/build-compatible-pty.mjs --arch <x64|arm64> --out <dir> [options]

  --arch <x64|arm64>  bundle architecture to build for (must be the runner's own)
  --out <dir>         destination for the standalone node-pty tree
  --node <path>       Node binary the bundle ships (default: process.execPath)
  --image <ref>       Linux container image (default: the manylinux_2_28 image)
  --keep-work         keep the temporary work directory and print its path
  --help              print this message`;

/** Parse `--flag value` / `--flag` pairs without a shell. */
export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!argument.startsWith("--") || argument.length <= 2) {
      throw new Error(`unexpected argument: ${argument}\n\n${USAGE}`);
    }
    const name = argument.slice(2);
    if (name === "keep-work") {
      options.keepWork = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} needs a value\n\n${USAGE}`);
    }
    options[name] = value;
    index += 1;
  }
  return options;
}

function assertLinuxHost(platform) {
  if (platform !== "linux") {
    throw new Error(
      `this builder compiles a Linux addon inside a Linux container; ${platform} is not supported (run it on the release runner)`,
    );
  }
}

/** `24.12.0` style version reported by the bundled Node binary. */
export function assertNodeVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version ?? ""))) {
    throw new Error(
      `the bundled Node reported an unusable version (${version}); the headers must match it exactly`,
    );
  }
  return String(version);
}

/**
 * Resolve and validate the build request. Every check here fails before a
 * single byte is downloaded or a container starts, so a wrong runner or a typo
 * costs seconds instead of a full image pull.
 */
export function resolveOptions({
  argv,
  hostPlatform = process.platform,
  hostArch = process.arch,
  execPath = process.execPath,
  nodeVersion,
}) {
  const parsed = parseArguments(argv);
  if (parsed.help) return { help: true };
  assertLinuxHost(hostPlatform);
  const arch = parsed.arch;
  if (!arch) throw new Error(`--arch is required (${Object.keys(ARCHITECTURES).join(", ")})`);
  manylinuxImage(arch);
  if (arch !== hostArch) {
    throw new Error(
      `--arch ${arch} does not match the runner architecture ${hostArch}; the addon is built natively, never by emulation`,
    );
  }
  const out = parsed.out;
  if (!out) throw new Error("--out is required");
  for (const name of Object.keys(parsed)) {
    if (!["arch", "out", "node", "image", "keepWork"].includes(name)) {
      throw new Error(`unknown option --${name}\n\n${USAGE}`);
    }
  }
  return {
    help: false,
    arch,
    out: resolve(out),
    nodeBinary: realpathSync(resolve(parsed.node ?? execPath)),
    nodeVersion: assertNodeVersion(nodeVersion ?? process.versions.node),
    image: parsed.image ?? manylinuxImage(arch),
    keepWork: Boolean(parsed.keepWork),
  };
}

/** The container image for one native architecture. */
export function manylinuxImage(arch) {
  const architecture = ARCHITECTURES[arch];
  if (!architecture) {
    throw new Error(
      `unsupported architecture ${arch}; the pi-host bundle is built for ${Object.keys(ARCHITECTURES).join(", ")}`,
    );
  }
  return architecture.image;
}

/** Header artifacts for the Node version the bundle copies into `bin/node`. */
export function headersArchiveName(version) {
  assertNodeVersion(version);
  return `node-v${version}-headers.tar.gz`;
}

export function headersUrl(version) {
  return `https://nodejs.org/dist/v${assertNodeVersion(version)}/${headersArchiveName(version)}`;
}

export function shasumsUrl(version) {
  return `https://nodejs.org/dist/v${assertNodeVersion(version)}/SHASUMS256.txt`;
}

/** Extract the published digest for one artifact out of SHASUMS256.txt. */
export function parseShasums(text, fileName) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})\s+\*?(\S.*?)\s*$/);
    if (match && match[2] === fileName) return match[1];
  }
  throw new Error(`SHASUMS256.txt has no digest for ${fileName}`);
}

export function assertHeadersDigest(expected, actual, fileName) {
  if (!/^[0-9a-f]{64}$/.test(String(expected ?? ""))) {
    throw new Error(`refusing to trust an empty digest for ${fileName}`);
  }
  if (expected !== actual) {
    throw new Error(
      `${fileName} digest mismatch: nodejs.org published ${expected}, the download hashed to ${actual}`,
    );
  }
  return actual;
}

/** Version recorded in the extracted headers' node_version.h. */
export function headerVersion(headersRoot) {
  const file = join(headersRoot, "include/node/node_version.h");
  const text = readFileSync(file, "utf8");
  const read = (name) => {
    const match = text.match(new RegExp(`^#define ${name} (\\d+)$`, "m"));
    if (!match) throw new Error(`${file} does not define ${name}`);
    return match[1];
  };
  return `${read("NODE_MAJOR_VERSION")}.${read("NODE_MINOR_VERSION")}.${read("NODE_PATCH_VERSION")}`;
}

/**
 * Prove the headers describe the Node version the bundle ships. The addon is
 * N-API, but a header/runtime mismatch still bakes the wrong API level into it.
 */
export function assertHeadersMatchVersion(headersRoot, version) {
  const expected = assertNodeVersion(version);
  for (const name of [
    "include/node/node.h",
    "include/node/node_api.h",
    "include/node/js_native_api.h",
    "include/node/common.gypi",
    "include/node/config.gypi",
  ]) {
    if (!existsSync(join(headersRoot, name))) {
      throw new Error(`Node ${expected} headers are incomplete: ${name} is missing`);
    }
  }
  const found = headerVersion(headersRoot);
  if (found !== expected) {
    throw new Error(
      `Node headers are for v${found}, but the bundle ships v${expected}; download the matching headers`,
    );
  }
  return found;
}

/**
 * Copy the pristine node-pty source. `build/` holds the runner's addon and
 * `prebuilds/` holds other platforms' addons, so neither may travel with it.
 */
export function stagePtySource(sourceDir, destination) {
  const source = resolve(sourceDir);
  for (const required of ["binding.gyp", "package.json", "src/unix/pty.cc"]) {
    if (!existsSync(join(source, required))) {
      throw new Error(`node-pty source is incomplete: ${join(source, required)} is missing`);
    }
  }
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (from) => {
      const path = relative(source, from);
      if (!path) return true;
      return !PTY_SOURCE_EXCLUSIONS.has(path.split(sep)[0]);
    },
  });
  return destination;
}

/** binding.gyp resolves node-addon-api from the package it builds, so copy it in. */
export function stageNodeAddonApi(addonApiDir, ptyDir) {
  const source = resolve(addonApiDir);
  for (const required of ["package.json", "napi.h", "node_api.gyp"]) {
    if (!existsSync(join(source, required))) {
      throw new Error(`node-addon-api is incomplete: ${join(source, required)} is missing`);
    }
  }
  const destination = join(ptyDir, "node_modules/node-addon-api");
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true, dereference: true });
  return destination;
}

/** node-gyp arguments: a clean rebuild against the pinned headers and arch. */
export function nodeGypArguments({ arch, headersDir }) {
  if (!ARCHITECTURES[arch]) throw new Error(`unsupported architecture ${arch}`);
  return ["rebuild", "--release", `--arch=${arch}`, `--nodedir=${headersDir}`];
}

/**
 * The in-container command. Node is prepended to PATH because binding.gyp
 * shells out to `node -p` while gyp generates the makefiles.
 */
export function containerScript({ nodeBinary, nodeGypScript, ptyDir, gypArguments }) {
  const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  return [
    "set -euo pipefail",
    `export PATH=${quote(dirname(nodeBinary))}:"$PATH"`,
    `cd ${quote(ptyDir)}`,
    `node ${quote(nodeGypScript)} ${gypArguments.map(quote).join(" ")}`,
  ].join("\n");
}

/**
 * Bind mounts: the work directory (staged source, headers, HOME, build output)
 * stays writable, the bundled Node binary and the provisioned dependency tree
 * are read-only, and every mount keeps its own path so the generated makefiles
 * are valid inside and outside the container.
 */
export function dockerMounts({ workDir, nodeBinary, nodeModulesRoot }) {
  return [
    `${workDir}:${workDir}`,
    `${nodeBinary}:${nodeBinary}:ro`,
    `${nodeModulesRoot}:${nodeModulesRoot}:ro`,
  ];
}

/** Offline, unprivileged, and running as the runner's own user. */
export function dockerRunArguments({ image, uid, gid, homeDir, mounts, workdir, script }) {
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error(`refusing to build as an unknown user (${uid}:${gid})`);
  }
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    `${uid}:${gid}`,
    "--env",
    `HOME=${homeDir}`,
  ];
  for (const mount of mounts) args.push("--volume", mount);
  args.push("--workdir", workdir, image, "/bin/bash", "-lc", script);
  return args;
}

/** Docker reports `amd64`/`arm64`; the release matrix speaks `x64`/`arm64`. */
export function assertImageArchitecture(reported, arch) {
  const architecture = ARCHITECTURES[arch];
  if (!architecture) throw new Error(`unsupported architecture ${arch}`);
  if (String(reported).trim() !== architecture.dockerArch) {
    throw new Error(
      `${architecture.image} resolved to ${reported}, expected ${architecture.dockerArch}; refusing to emulate another architecture`,
    );
  }
  return architecture.dockerArch;
}

/** Fields of `readelf -h` that identify the produced shared object. */
export function parseElfHeader(report) {
  const field = (name) => {
    const match = String(report).match(new RegExp(`^\\s*${name}:\\s+(.+?)\\s*$`, "m"));
    if (!match) throw new Error(`readelf output has no ${name} line`);
    return match[1];
  };
  return {
    class: field("Class"),
    data: field("Data"),
    type: field("Type"),
    machine: field("Machine"),
  };
}

/** A N-API addon for the target architecture and nothing else. */
export function assertAddonMatchesArch({ report, arch }) {
  const architecture = ARCHITECTURES[arch];
  if (!architecture) throw new Error(`unsupported architecture ${arch}`);
  const header = parseElfHeader(report);
  if (header.class !== "ELF64") throw new Error(`pty.node is ${header.class}, expected ELF64`);
  if (!/little endian/.test(header.data)) {
    throw new Error(`pty.node is ${header.data}, expected little endian`);
  }
  if (!/^DYN\b/.test(header.type)) {
    throw new Error(`pty.node is ${header.type}, expected a shared object (DYN)`);
  }
  if (!architecture.elfMachine.test(header.machine)) {
    throw new Error(
      `pty.node is ${header.machine}, expected ${architecture.elfMachineName} for linux-${arch}`,
    );
  }
  return header;
}

/**
 * A byte-identical copy of the runner's own addon means the compile was skipped
 * and the host-ABI binary was reused, which is the whole failure this script
 * exists to prevent.
 */
export function assertFreshAddon({ producedSha256, hostSha256, hostPath }) {
  if (hostSha256 && producedSha256 === hostSha256) {
    throw new Error(
      `the produced pty.node is identical to the host build at ${hostPath}; the container did not compile it`,
    );
  }
  return producedSha256;
}

function walkFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(directory);
  return files;
}

/**
 * Every relative `require` in the shipped JavaScript must resolve inside the
 * tree. This is what catches a future node-pty release that starts importing a
 * top-level file the runtime entry list does not copy.
 */
export function assertRuntimeTreeComplete(treeDir) {
  const tree = resolve(treeDir);
  const manifestPath = join(tree, "package.json");
  if (!existsSync(manifestPath)) throw new Error(`node-pty tree is missing package.json: ${tree}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "node-pty") {
    throw new Error(
      `expected the node-pty package in ${tree}, found ${manifest.name ?? "no name"}`,
    );
  }
  const lib = join(tree, "lib");
  if (!existsSync(lib) || !statSync(lib).isDirectory()) {
    throw new Error(`node-pty tree is missing lib/: ${tree}`);
  }
  const entry = resolve(tree, manifest.main ?? "index.js");
  if (!existsSync(entry)) throw new Error(`node-pty main entry is missing: ${entry}`);
  for (const file of walkFiles(lib)) {
    if (/\.(?:map|d\.ts)$|\.test\.js$/.test(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\brequire\(\s*(['"])(\.[^'"]*)\1\s*\)/g)) {
      const target = resolve(dirname(file), match[2]);
      const candidates = [target, `${target}.js`, join(target, "index.js")];
      if (!candidates.some((candidate) => existsSync(candidate))) {
        throw new Error(`node-pty tree is incomplete: ${file} requires ${match[2]}`);
      }
    }
  }
}

/** Exactly one native addon, at the path node-pty's loader tries first. */
export function assertIsolatedTree(treeDir) {
  assertRuntimeTreeComplete(treeDir);
  const addons = walkFiles(treeDir)
    .filter((file) => file.endsWith(".node"))
    .map((file) => relative(treeDir, file).split(sep).join("/"));
  if (addons.length !== 1 || addons[0] !== "build/Release/pty.node") {
    throw new Error(
      `node-pty tree must hold exactly build/Release/pty.node, found ${addons.join(", ") || "none"}`,
    );
  }
  if (existsSync(join(treeDir, "prebuilds"))) {
    throw new Error(`node-pty tree still carries prebuilds/: ${treeDir}`);
  }
  return treeDir;
}

/**
 * Publish the standalone node-pty tree: runtime files plus the addon built
 * here, with no build inputs and no other platform's binaries.
 */
export function writeIsolatedTree({ sourceDir, addonPath, destination }) {
  const source = resolve(sourceDir);
  const tree = resolve(destination);
  if (!existsSync(addonPath) || !statSync(addonPath).isFile()) {
    throw new Error(`compiled node-pty addon is missing: ${addonPath}`);
  }
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  for (const entry of PTY_RUNTIME_ENTRIES) {
    if (existsSync(join(source, entry))) {
      cpSync(join(source, entry), join(tree, entry), { recursive: true, dereference: true });
    }
  }
  mkdirSync(join(tree, "build/Release"), { recursive: true });
  cpSync(addonPath, join(tree, "build/Release/pty.node"));
  assertIsolatedTree(tree);
  return tree;
}

function runCommand(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `${command} is not installed; the baseline node-pty build needs Docker, tar, and binutils on the runner`,
      );
    }
    throw error;
  }
}

/** Read the version of the exact binary the bundle copies. */
export function readNodeVersion(binary) {
  const version = runCommand(binary, ["-p", "process.versions.node"], {
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  }).trim();
  return assertNodeVersion(version);
}

async function downloadText(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

/** Fetch the headers for the bundled Node, published-digest verified. */
async function installHeaders({ version, workDir, log }) {
  const archive = headersArchiveName(version);
  const expected = parseShasums(await downloadText(shasumsUrl(version)), archive);
  const response = await fetch(headersUrl(version), { redirect: "follow" });
  if (!response.ok) throw new Error(`${headersUrl(version)} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assertHeadersDigest(expected, createHash("sha256").update(bytes).digest("hex"), archive);
  const tarPath = join(workDir, archive);
  writeFileSync(tarPath, bytes);
  runCommand("tar", ["-xzf", tarPath, "-C", workDir]);
  const headersRoot = join(workDir, `node-v${version}`);
  if (!existsSync(headersRoot)) {
    throw new Error(`extracted headers do not contain node-v${version}`);
  }
  // node-gyp reads include/node/{config,common}.gypi; published tarballs keep
  // them at the root in some releases, so normalize instead of guessing.
  for (const name of ["config.gypi", "common.gypi"]) {
    const target = join(headersRoot, "include/node", name);
    if (!existsSync(target) && existsSync(join(headersRoot, name))) {
      cpSync(join(headersRoot, name), target);
    }
  }
  assertHeadersMatchVersion(headersRoot, version);
  rmSync(tarPath, { force: true });
  log(`Node v${version} headers ${archive} sha256 ${expected.slice(0, 16)}… verified`);
  return headersRoot;
}

/** Deepest path shared by every resolved package. */
function commonAncestor(paths) {
  const parts = paths.map((path) => resolve(path).split(sep));
  const longest = Math.min(...parts.map((entry) => entry.length));
  let length = 0;
  while (length < longest && parts.every((entry) => entry[length] === parts[0][length])) {
    length += 1;
  }
  return parts[0].slice(0, length).join(sep);
}

/**
 * Docker mounts one dependency root, and pnpm's layout puts the real packages
 * in `<root>/node_modules/.pnpm/...`, so the root is the node_modules directory
 * above every resolved package rather than the first one below it.
 */
function nodeModulesRootOf(paths) {
  const ancestor = commonAncestor(paths);
  let current = ancestor;
  while (basename(current) !== "node_modules") {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `${ancestor} is not inside a node_modules tree; the build reuses the installed dependencies`,
      );
    }
    current = parent;
  }
  return current;
}

/**
 * Resolve the same packages binding.gyp and node-gyp would resolve, and make
 * sure all of them come from one mounted dependency tree.
 */
export function resolveBuildInputs() {
  const ptyPackagePath = require.resolve("node-pty/package.json");
  const ptyDir = realpathSync(dirname(ptyPackagePath));
  const ptyRequire = createRequire(ptyPackagePath);
  const addonApiDir = realpathSync(dirname(ptyRequire.resolve("node-addon-api/package.json")));
  const nodeGypScript = realpathSync(
    createRequire(join(root, "package.json")).resolve("node-gyp/bin/node-gyp.js"),
  );
  const nodeModulesRoot = nodeModulesRootOf([ptyDir, addonApiDir, nodeGypScript]);
  for (const [label, path] of [
    ["node-pty", ptyDir],
    ["node-addon-api", addonApiDir],
    ["node-gyp", nodeGypScript],
  ]) {
    if (path !== nodeModulesRoot && !path.startsWith(nodeModulesRoot + sep)) {
      throw new Error(
        `${label} resolves outside ${nodeModulesRoot} (${path}); the build reuses the installed dependencies`,
      );
    }
  }
  return { ptyDir, addonApiDir, nodeGypScript, nodeModulesRoot };
}

function sha256Of(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Build one architecture. Returns the published tree; throws on any deviation
 * from the offline, native, from-source path.
 */
export async function run(argv, overrides = {}) {
  const log = overrides.log ?? ((message) => console.log(message));
  const hostPlatform = overrides.hostPlatform ?? process.platform;
  const hostArch = overrides.hostArch ?? process.arch;
  const execPath = overrides.execPath ?? process.execPath;
  const parsed = parseArguments(argv);
  // `--help` must work on any machine, so it is answered before the platform
  // check and before anything is spawned or downloaded.
  if (parsed.help) {
    log(USAGE);
    return { help: true };
  }
  assertLinuxHost(hostPlatform);
  // The headers must describe the binary this bundle copies, which is
  // `process.execPath` unless the caller names another one.
  const bundledNodeVersion =
    overrides.nodeVersion ?? readNodeVersion(realpathSync(resolve(parsed.node ?? execPath)));
  const options = resolveOptions({
    argv,
    hostPlatform,
    hostArch,
    execPath,
    nodeVersion: bundledNodeVersion,
  });
  runCommand("docker", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  const inputs = resolveBuildInputs();
  const workDir = realpathSync(
    mkdtempSync(join(overrides.tempDir ?? process.env.RUNNER_TEMP ?? tmpdir(), "pi-host-pty-")),
  );
  if (options.out === workDir || options.out.startsWith(workDir + sep)) {
    throw new Error(`--out must not be inside the temporary work directory ${workDir}`);
  }
  const ptyDir = join(workDir, "node-pty");
  const homeDir = join(workDir, "home");
  const uid = overrides.uid ?? process.getuid?.();
  const gid = overrides.gid ?? process.getgid?.();
  try {
    mkdirSync(homeDir, { recursive: true });
    const headersDir = await installHeaders({ version: options.nodeVersion, workDir, log });
    stagePtySource(inputs.ptyDir, ptyDir);
    stageNodeAddonApi(inputs.addonApiDir, ptyDir);

    log(`building linux-${options.arch} node-pty in ${options.image} (--network none)`);
    runCommand("docker", ["pull", options.image], { stdio: ["ignore", "pipe", "inherit"] });
    const reported = runCommand("docker", [
      "image",
      "inspect",
      "--format",
      "{{.Architecture}}",
      options.image,
    ]);
    assertImageArchitecture(
      String(reported)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .pop(),
      options.arch,
    );
    runCommand(
      "docker",
      dockerRunArguments({
        image: options.image,
        uid,
        gid,
        homeDir,
        mounts: dockerMounts({
          workDir,
          nodeBinary: options.nodeBinary,
          nodeModulesRoot: inputs.nodeModulesRoot,
        }),
        workdir: ptyDir,
        script: containerScript({
          nodeBinary: options.nodeBinary,
          nodeGypScript: inputs.nodeGypScript,
          ptyDir,
          gypArguments: nodeGypArguments({ arch: options.arch, headersDir }),
        }),
      }),
      { stdio: "inherit", encoding: "utf8" },
    );

    const addonPath = join(ptyDir, "build/Release/pty.node");
    if (!existsSync(addonPath)) {
      throw new Error(`the container finished without producing ${addonPath}`);
    }
    const produced = assertAddonMatchesArch({
      report: runCommand("readelf", ["-h", addonPath]),
      arch: options.arch,
    });
    const producedSha256 = sha256Of(addonPath);
    const hostAddon = join(realpathSync(inputs.ptyDir), "build/Release/pty.node");
    assertFreshAddon({
      producedSha256,
      hostSha256: existsSync(hostAddon) ? sha256Of(hostAddon) : undefined,
      hostPath: hostAddon,
    });
    const tree = writeIsolatedTree({
      sourceDir: inputs.ptyDir,
      addonPath,
      destination: options.out,
    });
    log(
      `wrote ${tree}: pty.node sha256 ${producedSha256} (${statSync(addonPath).size} bytes, ${produced.class} ${produced.machine})`,
    );
    console.log(`PI_HOST_PTY_DIR=${tree}`);
    return { tree, addonSha256: producedSha256, addon: produced };
  } finally {
    if (options.keepWork) log(`kept the work directory ${workDir}`);
    else rmSync(workDir, { recursive: true, force: true });
  }
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.env.GITHUB_ACTIONS) {
    process.stdout.write(`::error::${message.replace(/\r?\n/g, " | ")}\n`);
  }
  process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  run(process.argv.slice(2)).catch(fail);
}
