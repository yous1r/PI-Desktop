import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const require = createRequire(new URL("../packages/agent-runtime/package.json", import.meta.url));
const { build } = require("esbuild");
const temporary = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "host-download-proxy-"));
try {
  const output = join(temporary, "runner.cjs");
  await build({ entryPoints: [join(root, "apps/desktop/test/fixtures/host-download-proxy-runner.mjs")],
    outfile: output, platform: "node", format: "cjs", bundle: true, external: ["electron"],
    alias: {
      "@pi-desktop/agent-runtime/system-proxy-relay": join(root, "packages/agent-runtime/src/system-proxy-relay.ts"),
      "@pi-desktop/agent-runtime": join(root, "packages/agent-runtime/src/authenticated-proxy-relay.ts"),
    } });
  const env = { ...process.env, PI_PROXY_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(resolveElectronBinary(root).electronBinary,
    [`--user-data-dir=${join(temporary, "profile")}`, output], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 45_000);
  const exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }).finally(() => clearTimeout(timer));
  assert.equal(exit, 0, `${stdout}\n${stderr}`);
  assert.match(stdout, /PASS: HTTP/);
  console.log(stdout.trim());
} finally { await rm(temporary, { recursive: true, force: true }); }
