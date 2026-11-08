import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handoffSourcePlugin } from "./e2e/sidecar-handoff-build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = process.env.PI_SCRATCH_DIR;
assert(scratch, "PI_SCRATCH_DIR is required for isolated browser artifacts");
const directory = await mkdtemp(join(scratch, "browser-handoff-"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = { candidate: git("rev-parse", "HEAD"), base: git("rev-parse", "origin/main"),
  dirty: Boolean(git("status", "--porcelain")), status: "FAIL", originalProcessExitObserved: false,
  qualifiedNativeFamilyClosure: false, platform: process.platform, node: process.version };
let output = "";
try {
  const dependencyRoot = process.env.E2E_DEPENDENCY_ROOT || root;
  const provisioned = createRequire(join(dependencyRoot, "packages/agent-runtime/package.json"));
  const { build } = provisioned("esbuild");
  const electronBinary = provisioned("electron");
  const main = join(directory, "main.cjs");
  const result = await build({ absWorkingDir: root, entryPoints: ["scripts/e2e/browser-handoff.ts"],
    outfile: main, bundle: true, platform: "node", format: "cjs", external: ["electron"],
    metafile: true, plugins: [handoffSourcePlugin(root)], logLevel: "warning" });
  const inputs = [];
  for (const path of Object.keys(result.metafile.inputs).sort()) {
    inputs.push({ path: path.replaceAll("\\", "/"), sha256: sha256(await readFile(resolve(root, path))) });
  }
  await writeFile(join(directory, "build-inputs.json"), JSON.stringify(inputs, null, 2) + "\n");
  Object.assign(report, { inputs: inputs.length, inputsSha256: sha256(JSON.stringify(inputs)),
    bundleSha256: sha256(await readFile(main)), electronBinarySha256: sha256(await readFile(electronBinary)) });
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const name of ["profile", "home", "temp", "appdata", "localappdata"]) await mkdir(join(directory, name), { recursive: true });
  Object.assign(env, { BROWSER_HANDOFF_ARTIFACT_DIR: directory, HOME: join(directory, "home"),
    USERPROFILE: join(directory, "home"), TEMP: join(directory, "temp"), TMP: join(directory, "temp"),
    APPDATA: join(directory, "appdata"), LOCALAPPDATA: join(directory, "localappdata") });
  const child = spawn(electronBinary, [main], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    if (output.length < 2 * 1024 * 1024) output += chunk.toString();
  });
  let timeout, confirmation;
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timeout); clearTimeout(confirmation);
      report.originalProcessExitObserved = child.pid !== undefined && (child.exitCode !== null || child.signalCode !== null);
      resolve({ code, signal });
    });
    timeout = setTimeout(() => {
      // Only this retained ChildProcess is signalled. No PID/name-based family cleanup.
      child.kill();
      confirmation = setTimeout(() => reject(new Error("Original Electron child closure was not confirmed")), 5_000);
    }, 45_000);
  }).finally(() => { clearTimeout(timeout); clearTimeout(confirmation); });
  Object.assign(report, { exit });
  assert.equal(exit.code, 0, "isolated Chromium handoff validation failed");
  const native = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
  assert.equal(native.status, "PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES");
  assert.equal(native.passed.length, 4);
  assert(report.originalProcessExitObserved);
  Object.assign(report, { ...native, endedDirty: Boolean(git("status", "--porcelain")) });
  for (const input of inputs) assert.equal(sha256(await readFile(resolve(root, input.path))), input.sha256, input.path);
  report.sourceInputsUnchanged = true;
} catch (error) {
  report.status = "FAIL";
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await writeFile(join(directory, "process.log"), output);
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ directory, ...report }, null, 2));
  if (process.exitCode) console.error(output);
}
