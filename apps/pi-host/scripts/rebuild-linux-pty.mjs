#!/usr/bin/env node
/** Rebuild only the remote bundle's PTY at Node's Linux glibc 2.28 floor. */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writePackageManifest } from "./package-integrity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const bundle = resolve(process.argv[2] ?? "");
if (!process.argv[2] || process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) {
  throw new Error("Usage on a native Linux x64/arm64 runner: node rebuild-linux-pty.mjs <bundle>");
}
const node = join(bundle, "bin/node");
const pty = join(bundle, "node_modules/node-pty");
const metadata = JSON.parse(execFileSync(node, ["-p", "JSON.stringify({platform:process.platform,arch:process.arch})"], {
  encoding: "utf8", timeout: 10_000, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
}));
if (metadata.platform !== process.platform || metadata.arch !== process.arch) throw new Error("Bundle Node does not match the native runner");
if (!existsSync(join(pty, "src/unix/pty.cc"))) throw new Error("Bundle is missing node-pty sources");
// npm ships node-gyp with its complete JS dependency tree. Reuse setup-node's
// toolchain rather than resolving a second set of build dependencies from npm.
const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000 }).trim();
const npm = realpathSync(join(npmRoot, "npm"));
const ptyRequire = createRequire(require.resolve("node-pty/package.json"));
const addonApi = dirname(ptyRequire.resolve("node-addon-api/package.json"));
if (!existsSync(join(npm, "node_modules/node-gyp/bin/node-gyp.js"))) throw new Error("npm's node-gyp is unavailable");
const expectedVersion = JSON.parse(readFileSync(join(pty, "package.json"), "utf8")).version;
const work = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "pi-host-pty-"));
try {
  const copy = join(work, "pty");
  cpSync(pty, copy, { recursive: true, dereference: true });
  // Never admit a cached addon or prebuild instead of this native compilation.
  for (const name of ["build", "prebuilds", "node_modules"]) rmSync(join(copy, name), { recursive: true, force: true });
  cpSync(addonApi, join(copy, "node_modules/node-addon-api"), { recursive: true, dereference: true });
  cpSync(join(here, "verify-pty.mjs"), join(work, "verify-pty.mjs"));
  const mounts = [
    [work, "/work", false], [node, "/toolchain/node", true], [npm, "/toolchain/npm", true],
  ].flatMap(([source, target, readOnly]) => ["--mount", `type=bind,src=${source},dst=${target}${readOnly ? ",readonly" : ""}`]);
  execFileSync("docker", ["run", "--rm", ...mounts, "almalinux:8", "bash", "-euc", `
    test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.28"
    dnf -q -y install gcc-toolset-14-gcc-c++ make python3.11 binutils
    export PATH=/opt/rh/gcc-toolset-14/root/usr/bin:/toolchain:/usr/bin:/bin
    export CC=gcc CXX=g++ LDFLAGS='-static-libstdc++ -static-libgcc'
    node /toolchain/npm/node_modules/node-gyp/bin/node-gyp.js rebuild \\
      --directory=/work/pty --devdir=/work/headers --python=/usr/bin/python3.11
    node /work/verify-pty.mjs /work/pty
  `], { stdio: "inherit", timeout: 15 * 60_000 });
  if (JSON.parse(readFileSync(join(copy, "package.json"), "utf8")).version !== expectedVersion) throw new Error("node-pty source version changed");
  // Publish only after the real floor runtime has loaded and exercised the addon.
  const destination = join(pty, "build/Release/pty.node");
  cpSync(join(copy, "build/Release/pty.node"), destination);
  // Optional build copies are never candidates for runtime loading; remove them
  // so the archive does not retain an incompatible second native binary.
  rmSync(join(pty, "build/Release/obj.target/pty.node"), { force: true });
  rmSync(join(pty, "build/Debug"), { recursive: true, force: true });
  rmSync(join(pty, `prebuilds/linux-${process.arch}`), { recursive: true, force: true });
  writePackageManifest(bundle);
  console.log(`Verified ${expectedVersion} PTY for Linux ${process.arch}, glibc 2.28; refreshed SHA256SUMS`);
} finally {
  // Container output belongs to root on hosted runners; remove only this unique
  // task-owned build directory through the same container user when necessary.
  try { rmSync(work, { recursive: true, force: true }); }
  catch {
    execFileSync("docker", ["run", "--rm", "--mount", `type=bind,src=${work},dst=/work`, "almalinux:8", "sh", "-c", "rm -rf /work/*"], { stdio: "inherit", timeout: 60_000 });
    rmSync(work, { recursive: true, force: true });
  }
}
