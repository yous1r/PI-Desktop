import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handoffSourcePlugin } from "./e2e/sidecar-handoff-build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert(process.env.PI_SCRATCH_DIR, "PI_SCRATCH_DIR is required");
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR, "plugin-surfaces-handoff-"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const report = { candidate: git("rev-parse", "HEAD"), base: git("rev-parse", "origin/main"), dirty: !!git("status", "--porcelain"),
  status: "FAIL", originalProcessExitObserved: false, qualifiedNativeFamilyClosure: false, platform: process.platform, node: process.version };
let output = "";
try {
  const provisioned = createRequire(join(root, "packages/agent-runtime/package.json"));
  const { build } = provisioned("esbuild"), electronBinary = provisioned("electron");
  const main = join(directory, "main", "index.mjs"), preload = join(directory, "preload", "plugin-panel.js");
  const mcpSources = { name: "surface-mcp-sources", setup(builder) {
    builder.onResolve({ filter: /^@pi-desktop\/host-runtime\/mcp\/(client|child-process-env)$/ }, ({ path }) =>
      ({ path: join(root, "packages/host-runtime/src/mcp", path.split("/").at(-1) + ".ts") }));
  } };
  const result = await build({ absWorkingDir: root, entryPoints: ["scripts/e2e/plugin-surfaces-handoff.mjs"], outfile: main,
    bundle: true, platform: "node", format: "esm", external: ["electron"], metafile: true, logLevel: "warning",
    banner: { js: "import {createRequire as __surfaceRequire} from 'node:module'; const require=__surfaceRequire(import.meta.url);" },
    plugins: [mcpSources, handoffSourcePlugin(root)] });
  const preloadBuild = await build({ absWorkingDir: root, entryPoints: ["apps/desktop/electron/preload/plugin-panel.ts"], outfile: preload,
    bundle: true, platform: "node", format: "cjs", external: ["electron"], metafile: true, logLevel: "warning", plugins: [handoffSourcePlugin(root)] });
  const paths = [...new Set([...Object.keys(result.metafile.inputs), ...Object.keys(preloadBuild.metafile.inputs),
    "apps/desktop/electron/main/plugin-host-process.mjs", "packages/host-runtime/plugin-host-process.mjs"])].sort();
  const inputs = [];
  for (const path of paths) inputs.push({ path: path.replaceAll("\\", "/"), sha256: hash(await readFile(resolve(root, path))) });
  await writeFile(join(directory, "build-inputs.json"), JSON.stringify(inputs, null, 2) + "\n");
  Object.assign(report, { inputs: inputs.length, inputsSha256: hash(JSON.stringify(inputs)), bundleSha256: hash(await readFile(main)),
    preloadSha256: hash(await readFile(preload)), electronBinarySha256: hash(await readFile(electronBinary)) });
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const name of ["profile", "home", "temp", "appdata", "localappdata", "agents"]) await mkdir(join(directory, name), { recursive: true });
  Object.assign(env, { PLUGIN_SURFACES_ARTIFACT_DIR: directory, PLUGIN_SURFACES_NODE: process.execPath,
    PLUGIN_SURFACES_RUNNER: join(root, "apps/desktop/electron/main/plugin-host-process.mjs"),
    HOME: join(directory, "home"), USERPROFILE: join(directory, "home"), TEMP: join(directory, "temp"), TMP: join(directory, "temp"),
    APPDATA: join(directory, "appdata"), LOCALAPPDATA: join(directory, "localappdata"),
    PI_DESKTOP_DATA_DIR: join(directory, "profile"), PI_DESKTOP_AGENTS_DIR: join(directory, "agents") });
  const child = spawn(electronBinary, [main], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { if (output.length < 2 * 1024 * 1024) output += bytes.toString(); });
  let deadline, confirmation;
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { report.originalProcessExitObserved = child.pid !== undefined && (child.exitCode !== null || child.signalCode !== null); resolve({ code, signal }); });
    deadline = setTimeout(() => { child.kill(); confirmation = setTimeout(() => reject(new Error("Original Electron closure was not confirmed")), 5000); }, 45000);
  }).finally(() => { clearTimeout(deadline); clearTimeout(confirmation); });
  report.exit = exit;
  assert.equal(exit.code, 0, "isolated surface validation failed");
  const native = JSON.parse(await readFile(join(directory, "result.json"), "utf8"));
  assert.equal(native.status, "PASS_WITH_UNQUALIFIED_NATIVE_RESOURCES"); assert.equal(native.passed.length, 4);
  assert(report.originalProcessExitObserved); Object.assign(report, native);
  for (const input of inputs) assert.equal(hash(await readFile(resolve(root, input.path))), input.sha256, input.path);
  report.sourceInputsUnchanged = true; report.endedDirty = !!git("status", "--porcelain");
} catch (error) { report.status = "FAIL"; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  await writeFile(join(directory, "process.log"), output);
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ directory, ...report }, null, 2)); if (process.exitCode) console.error(output);
}
