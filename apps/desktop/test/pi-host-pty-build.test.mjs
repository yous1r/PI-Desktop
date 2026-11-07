import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ARCHITECTURES,
  PTY_RUNTIME_ENTRIES,
  assertAddonMatchesArch,
  assertFreshAddon,
  assertHeadersDigest,
  assertHeadersMatchVersion,
  assertImageArchitecture,
  assertIsolatedTree,
  assertNodeVersion,
  assertRuntimeTreeComplete,
  containerScript,
  dockerMounts,
  dockerRunArguments,
  headerVersion,
  headersArchiveName,
  headersUrl,
  manylinuxImage,
  nodeGypArguments,
  parseArguments,
  parseElfHeader,
  parseShasums,
  readNodeVersion,
  resolveBuildInputs,
  resolveOptions,
  run,
  shasumsUrl,
  stageNodeAddonApi,
  stagePtySource,
  writeIsolatedTree,
} from "../../../apps/pi-host/scripts/build-compatible-pty.mjs";

const piHostRequire = createRequire(new URL("../../../apps/pi-host/package.json", import.meta.url));
/** Resolve node-pty and node-addon-api exactly the way binding.gyp does. */
const nodePtyPackagePath = piHostRequire.resolve("node-pty/package.json");
const nodePtyDir = dirname(nodePtyPackagePath);
const nodeAddonApiDir = dirname(
  createRequire(nodePtyPackagePath).resolve("node-addon-api/package.json"),
);

const scratchRoot = process.env.PI_SCRATCH_DIR || tmpdir();
const temporaryDirectories = [];

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(join(scratchRoot, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test.after(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Minimal tree with the layout node-pty's loader expects. */
function ptyTreeFixture() {
  const root = temporaryDirectory("pi-host-pty-tree-");
  const tree = join(root, "node-pty");
  write(join(tree, "package.json"), JSON.stringify({ name: "node-pty", main: "./lib/index.js" }));
  write(join(tree, "lib/index.js"), 'module.exports = require("./unixTerminal");\n');
  write(
    join(tree, "lib/unixTerminal.js"),
    'const native = require("../build/Release/pty.node");\nmodule.exports = native;\n',
  );
  write(join(tree, "build/Release/pty.node"), "fake addon bytes");
  return tree;
}

test("each native architecture maps to one manylinux_2_28 image", () => {
  assert.equal(manylinuxImage("x64"), "quay.io/pypa/manylinux_2_28_x86_64");
  assert.equal(manylinuxImage("arm64"), "quay.io/pypa/manylinux_2_28_aarch64");
  assert.notEqual(manylinuxImage("x64"), manylinuxImage("arm64"));
  for (const image of Object.values(ARCHITECTURES).map((arch) => arch.image)) {
    assert.match(image, /^quay\.io\/pypa\/manylinux_2_28_/);
  }
  assert.throws(() => manylinuxImage("ia32"), /unsupported architecture ia32/);
});

test("the build refuses to run anywhere but the native Linux runner", () => {
  assert.throws(
    () => resolveOptions({ argv: ["--arch", "x64", "--out", "out"], hostPlatform: "win32" }),
    /not supported \(run it on the release runner\)/,
  );
  assert.throws(
    () =>
      resolveOptions({
        argv: ["--arch", "arm64", "--out", "out"],
        hostPlatform: "linux",
        hostArch: "x64",
      }),
    /does not match the runner architecture x64/,
  );
  assert.throws(() => resolveOptions({ argv: ["--out", "out"], hostPlatform: "linux" }), /--arch is required/);
  assert.throws(
    () => resolveOptions({ argv: ["--arch", "x64"], hostPlatform: "linux", hostArch: "x64" }),
    /--out is required/,
  );
  assert.throws(
    () =>
      resolveOptions({
        argv: ["--arch", "x64", "--out", "out", "--node-dir", "x"],
        hostPlatform: "linux",
        hostArch: "x64",
      }),
    /unknown option --node-dir/,
  );
  // --help must stay usable to read the contract from any machine.
  assert.deepEqual(resolveOptions({ argv: ["--help"], hostPlatform: "darwin" }), { help: true });
});

test("the CLI explains itself on a machine that cannot build", async () => {
  const lines = [];
  const result = await run(["--help"], { hostPlatform: "win32", log: (line) => lines.push(line) });
  assert.deepEqual(result, { help: true });
  assert.match(lines.join("\n"), /--arch <x64\|arm64>/);
  // Nothing may be spawned for help: a Docker check here would fail on Windows.
  await assert.rejects(
    run(["--arch", "x64", "--out", "out"], { hostPlatform: "win32", log: () => {} }),
    /not supported \(run it on the release runner\)/,
  );
});

test("the resolved request keeps the bundled Node version and the target arch", () => {
  const options = resolveOptions({
    argv: ["--arch", "x64", "--out", "out/pty", "--keep-work"],
    hostPlatform: "linux",
    hostArch: "x64",
    execPath: process.execPath,
    nodeVersion: "24.12.0",
  });
  assert.equal(options.arch, "x64");
  assert.equal(options.nodeVersion, "24.12.0");
  assert.equal(options.keepWork, true);
  assert.equal(options.image, manylinuxImage("x64"));
  assert.match(options.out, /out[/\\]pty$/);
  assert.throws(() => assertNodeVersion("24.12"), /unusable version/);
  assert.throws(() => assertNodeVersion("v24.12.0"), /unusable version/);
});

test("arguments are parsed without a shell and reject missing values", () => {
  assert.deepEqual(parseArguments(["--arch", "arm64", "--out", "o", "--keep-work"]), {
    arch: "arm64",
    out: "o",
    keepWork: true,
  });
  assert.throws(() => parseArguments(["--arch"]), /--arch needs a value/);
  assert.throws(() => parseArguments(["--arch", "--out"]), /--arch needs a value/);
  assert.throws(() => parseArguments(["positional"]), /unexpected argument: positional/);
});

test("the container build is offline, unprivileged, and reuses provisioned dependencies", () => {
  const workDir = "/home/runner/work/_temp/pi-host-pty-abc123";
  const nodeBinary = "/opt/hostedtoolcache/node/24.12.0/x64/bin/node";
  const nodeModulesRoot = "/home/runner/work/PI-Desktop/PI-Desktop/node_modules";
  const mounts = dockerMounts({ workDir, nodeBinary, nodeModulesRoot });
  assert.deepEqual(mounts, [
    `${workDir}:${workDir}`,
    `${nodeBinary}:${nodeBinary}:ro`,
    `${nodeModulesRoot}:${nodeModulesRoot}:ro`,
  ]);
  // A read-only work directory could not receive the compiled addon.
  assert.doesNotMatch(mounts[0], /:ro$/);

  const script = containerScript({
    nodeBinary,
    nodeGypScript: `${nodeModulesRoot}/.pnpm/node-gyp@12.4.0/node_modules/node-gyp/bin/node-gyp.js`,
    ptyDir: `${workDir}/node-pty`,
    gypArguments: nodeGypArguments({ arch: "x64", headersDir: `${workDir}/node-v24.12.0` }),
  });
  const args = dockerRunArguments({
    image: manylinuxImage("x64"),
    uid: 1001,
    gid: 1001,
    homeDir: `${workDir}/home`,
    mounts,
    workdir: `${workDir}/node-pty`,
    script,
  });

  assert.deepEqual(args.slice(0, 2), ["run", "--rm"]);
  assert.equal(args[args.indexOf("--network") + 1], "none", "the container must not need the network");
  assert.equal(args[args.indexOf("--user") + 1], "1001:1001", "root build output would be unreadable");
  assert.equal(args[args.indexOf("--env") + 1], `HOME=${workDir}/home`);
  assert.ok(args.includes("--volume"), "the staged source must be mounted");
  assert.equal(args.at(-3), "/bin/bash");
  assert.equal(args.at(-2), "-lc");
  assert.equal(args.at(-1), script);
  assert.ok(args.includes(manylinuxImage("x64")));
  for (const forbidden of ["--privileged", "--cap-add", "--device", "--network=host"]) {
    assert.ok(!args.includes(forbidden), `${forbidden} must never be requested`);
  }
  assert.throws(
    () => dockerRunArguments({ image: "x", uid: undefined, gid: 1, homeDir: "", mounts, workdir: "", script: "" }),
    /unknown user/,
  );
});

test("node-gyp rebuilds from source against the pinned headers", () => {
  const args = nodeGypArguments({ arch: "arm64", headersDir: "/work/node-v24.12.0" });
  assert.deepEqual(args, [
    "rebuild",
    "--release",
    "--arch=arm64",
    "--nodedir=/work/node-v24.12.0",
  ]);
  // `rebuild` (not `build`) is what removes any stale addon before compiling.
  assert.equal(args[0], "rebuild");
  assert.throws(() => nodeGypArguments({ arch: "riscv64", headersDir: "/x" }), /unsupported architecture/);
});

test("the container script runs the bundled Node, not the image's", () => {
  const script = containerScript({
    nodeBinary: "/opt/hostedtoolcache/node/24.12.0/x64/bin/node",
    nodeGypScript: "/work/nodes/node-gyp/bin/node-gyp.js",
    ptyDir: "/work/pi-host-pty-abc/node-pty",
    gypArguments: nodeGypArguments({ arch: "x64", headersDir: "/work/pi-host-pty-abc/node-v24.12.0" }),
  });
  const lines = script.split("\n");
  assert.equal(lines[0], "set -euo pipefail");
  assert.equal(lines[1], `export PATH='/opt/hostedtoolcache/node/24.12.0/x64/bin':"$PATH"`);
  assert.equal(lines[2], "cd '/work/pi-host-pty-abc/node-pty'");
  assert.match(lines[3], /^node '\/work\/nodes\/node-gyp\/bin\/node-gyp\.js' 'rebuild' /);
  assert.match(lines[3], /'--nodedir=\/work\/pi-host-pty-abc\/node-v24\.12\.0'$/);
});

test("headers come from nodejs.org for the exact bundled Node version", () => {
  assert.equal(headersArchiveName("24.12.0"), "node-v24.12.0-headers.tar.gz");
  assert.equal(headersUrl("24.12.0"), "https://nodejs.org/dist/v24.12.0/node-v24.12.0-headers.tar.gz");
  assert.equal(shasumsUrl("24.12.0"), "https://nodejs.org/dist/v24.12.0/SHASUMS256.txt");

  const digest = "a".repeat(64);
  const shasums = [
    `${"b".repeat(64)}  node-v24.12.0-linux-x64.tar.gz`,
    `${digest}  node-v24.12.0-headers.tar.gz`,
    `${"c".repeat(64)}  node-v24.11.0-headers.tar.gz`,
  ].join("\n");
  assert.equal(parseShasums(shasums, "node-v24.12.0-headers.tar.gz"), digest);
  assert.equal(parseShasums(`${digest} *node-v24.12.0-headers.tar.gz`, "node-v24.12.0-headers.tar.gz"), digest);
  assert.throws(() => parseShasums(shasums, "node-v23.0.0-headers.tar.gz"), /no digest/);
  assert.equal(assertHeadersDigest(digest, digest, "headers"), digest);
  assert.throws(() => assertHeadersDigest(digest, "d".repeat(64), "headers"), /digest mismatch/);
  assert.throws(() => assertHeadersDigest("", digest, "headers"), /empty digest/);
});

test("extracted headers must describe the Node version the bundle ships", () => {
  const headersRoot = temporaryDirectory("pi-host-node-headers-");
  const version = "24.12.0";
  write(
    join(headersRoot, "include/node/node_version.h"),
    [
      "#define NODE_MAJOR_VERSION 24",
      "#define NODE_MINOR_VERSION 12",
      "#define NODE_PATCH_VERSION 0",
      "#define NODE_VERSION_IS_LTS 0",
      "",
    ].join("\n"),
  );
  for (const name of ["node.h", "node_api.h", "js_native_api.h", "common.gypi", "config.gypi"]) {
    write(join(headersRoot, "include/node", name), "fixture\n");
  }
  assert.equal(headerVersion(headersRoot), version);
  assert.equal(assertHeadersMatchVersion(headersRoot, version), version);
  assert.throws(
    () => assertHeadersMatchVersion(headersRoot, "24.11.0"),
    /headers are for v24\.12\.0, but the bundle ships v24\.11\.0/,
  );
  rmSync(join(headersRoot, "include/node/node_api.h"));
  assert.throws(
    () => assertHeadersMatchVersion(headersRoot, version),
    /node_api\.h is missing/,
  );
});

test("the build reuses the dependency tree the workspace already installed", () => {
  const inputs = resolveBuildInputs();
  assert.ok(existsSync(join(inputs.ptyDir, "binding.gyp")), "node-pty must resolve to its source package");
  assert.ok(existsSync(inputs.nodeGypScript), "node-gyp must be installed");
  assert.equal(inputs.nodeModulesRoot.split(sep).at(-1), "node_modules");
  for (const [label, path] of Object.entries(inputs)) {
    if (label === "nodeModulesRoot") continue;
    assert.ok(path === inputs.nodeModulesRoot || path.startsWith(inputs.nodeModulesRoot + sep),
      `${label} (${path}) must sit inside ${inputs.nodeModulesRoot}`);
  }
});

test("the staged source never carries the host build or foreign prebuilds", () => {
  const destination = join(temporaryDirectory("pi-host-pty-stage-"), "node-pty");
  stagePtySource(nodePtyDir, destination);
  assert.ok(existsSync(join(destination, "binding.gyp")));
  assert.ok(existsSync(join(destination, "src/unix/pty.cc")), "the Linux NAPI source is required");
  assert.ok(existsSync(join(destination, "lib/index.js")));
  assert.equal(existsSync(join(destination, "build")), false, "the runner's addon must not be copied");
  assert.equal(existsSync(join(destination, "prebuilds")), false, "foreign addons must not be copied");
  assert.equal(existsSync(join(destination, "node_modules")), false);
  const addons = readdirSync(destination, { recursive: true }).filter((name) =>
    String(name).endsWith(".node"),
  );
  assert.deepEqual(addons, []);
  // The installed package really does hold those directories, so the
  // assertions above prove the filter and not an empty fixture.
  assert.equal(existsSync(join(nodePtyDir, "prebuilds")), true);

  const addonApi = stageNodeAddonApi(nodeAddonApiDir, destination);
  assert.ok(existsSync(join(addonApi, "napi.h")));
  assert.ok(existsSync(join(addonApi, "node_api.gyp")));
});

test("the published tree is a complete node-pty package with one addon", () => {
  const fixture = ptyTreeFixture();
  const destination = join(temporaryDirectory("pi-host-pty-out-"), "node-pty");
  const addonPath = join(fixture, "build/Release/pty.node");
  const tree = writeIsolatedTree({ sourceDir: nodePtyDir, addonPath, destination });

  const files = readdirSync(tree, { recursive: true }).map((name) => String(name).split(sep).join("/"));
  for (const entry of PTY_RUNTIME_ENTRIES) {
    assert.ok(
      files.some((file) => file === entry || file.startsWith(`${entry}/`)),
      `runtime entry ${entry} is missing`,
    );
  }
  assert.deepEqual(
    files.filter((file) => file.endsWith(".node")),
    ["build/Release/pty.node"],
  );
  assert.equal(existsSync(join(tree, "prebuilds")), false);
  assert.equal(existsSync(join(tree, "binding.gyp")), false, "build inputs stay out of the bundle");
  assertIsolatedTree(tree);
  assertRuntimeTreeComplete(tree);
  // node-pty's loader tries build/Release first; the layout must stay aligned.
  assert.match(readFileSync(join(tree, "lib/utils.js"), "utf8"), /build\/Release/);

  const withPrebuilds = ptyTreeFixture();
  write(join(withPrebuilds, "prebuilds/linux-x64/pty.node"), "foreign");
  assert.throws(() => assertIsolatedTree(withPrebuilds), /must hold exactly build\/Release\/pty\.node/);

  const missingAddon = ptyTreeFixture();
  rmSync(join(missingAddon, "build/Release/pty.node"));
  assert.throws(() => assertRuntimeTreeComplete(missingAddon), /requires \.\.\/build\/Release\/pty\.node/);
  assert.throws(
    () => writeIsolatedTree({ sourceDir: nodePtyDir, addonPath: join(missingAddon, "absent.node"), destination }),
    /compiled node-pty addon is missing/,
  );
});

test("a copied host addon is rejected instead of shipped", () => {
  const digest = "e".repeat(64);
  assert.equal(assertFreshAddon({ producedSha256: "f".repeat(64), hostSha256: digest, hostPath: "/x" }), "f".repeat(64));
  assert.equal(assertFreshAddon({ producedSha256: digest, hostSha256: undefined, hostPath: "/x" }), digest);
  assert.throws(
    () => assertFreshAddon({ producedSha256: digest, hostSha256: digest, hostPath: "/host/pty.node" }),
    /identical to the host build at \/host\/pty\.node/,
  );
});

test("the produced addon must be an ELF shared object for the target architecture", () => {
  const header = (overrides) =>
    [
      "ELF Header:",
      "  Magic:   7f 45 4c 46 02 01 01 00 00 00 00 00 00 00 00 00",
      "  Class:                             ELF64",
      "  Data:                              2's complement, little endian",
      "  Version:                           1 (current)",
      "  OS/ABI:                            UNIX - System V",
      "  ABI Version:                       0",
      `  Type:                              ${overrides.type ?? "DYN (Shared object file)"}`,
      `  Machine:                           ${overrides.machine ?? "Advanced Micro Devices X86-64"}`,
      "  Version:                           0x1",
      "  Entry point address:               0x0",
      "",
    ].join("\n");

  assert.deepEqual(parseElfHeader(header({})), {
    class: "ELF64",
    data: "2's complement, little endian",
    type: "DYN (Shared object file)",
    machine: "Advanced Micro Devices X86-64",
  });
  assert.equal(assertAddonMatchesArch({ report: header({}), arch: "x64" }).machine, "Advanced Micro Devices X86-64");
  assert.equal(
    assertAddonMatchesArch({ report: header({ machine: "AArch64" }), arch: "arm64" }).machine,
    "AArch64",
  );
  assert.throws(
    () => assertAddonMatchesArch({ report: header({ machine: "AArch64" }), arch: "x64" }),
    /expected x86-64 for linux-x64/,
  );
  assert.throws(
    () => assertAddonMatchesArch({ report: header({ type: "EXEC (Executable file)" }), arch: "x64" }),
    /expected a shared object/,
  );
  assert.throws(
    () => assertAddonMatchesArch({ report: header({}).replace("ELF64", "ELF32"), arch: "x64" }),
    /expected ELF64/,
  );
});

test("a container image for the other architecture is rejected", () => {
  assert.equal(assertImageArchitecture("amd64\n", "x64"), "amd64");
  assert.equal(assertImageArchitecture("arm64", "arm64"), "arm64");
  assert.throws(() => assertImageArchitecture("arm64", "x64"), /refusing to emulate another architecture/);
  assert.throws(() => assertImageArchitecture("", "x64"), /refusing to emulate another architecture/);
});

test("the bundled Node binary reports the version the headers must match", () => {
  assert.equal(readNodeVersion(process.execPath), process.versions.node);
});

test("the release lane builds, bundles, then verifies the pi-host runtime", () => {
  const workflow = readFileSync(
    fileURLToPath(new URL("../../../.github/workflows/release.yml", import.meta.url)),
    "utf8",
  );
  const start = workflow.indexOf("\n  pi-host-bundle:");
  const end = workflow.indexOf("\n  publish:");
  assert.ok(start > 0 && end > start, "the pi-host-bundle lane is missing");
  const lane = workflow.slice(start, end);

  const at = (needle) => lane.indexOf(needle);
  assert.ok(at("node apps/pi-host/scripts/build-compatible-pty.mjs --arch ${{ matrix.arch }}") > 0,
    "the lane builds node-pty on the baseline image");
  assert.ok(at("pnpm install --frozen-lockfile") < at("build-compatible-pty.mjs"),
    "the baseline build reuses the installed dependencies");
  assert.ok(at("--pty") > at("build-compatible-pty.mjs"),
    "the bundle must consume the baseline node-pty tree");
  assert.ok(at("node scripts/check-linux-pi-host-runtime.mjs") > at("apps/pi-host/scripts/bundle.mjs"),
    "the bundled runtime ABI is verified after the bundle exists");
  assert.ok(at("Archive bundle with checksum") > at("node scripts/check-linux-pi-host-runtime.mjs"),
    "an unverified runtime must not be archived");
  // The static musl host-core checks stay in place.
  assert.match(lane, /node scripts\/check-linux-host-static\.mjs target\/musl-host-core\/pi-desktop-host-core/);
  assert.match(lane, /apps\/pi-host\/scripts\/bundle\.mjs --platform linux --arch \$\{\{ matrix\.arch \}\}/);
});
