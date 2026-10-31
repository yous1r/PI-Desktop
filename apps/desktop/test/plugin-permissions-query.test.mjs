import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const hostEntry = join(here, "../electron/main/plugin-host-process.mjs");

for (const granted of [["agent.prompt.inject"], []]) {
  test(`plugin permission metadata reports effective grants ${JSON.stringify(granted)}, never declarations`, async () => {
    const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-permission-query-"));
    const exits = [];
    const runtime = new PluginRuntime({
      hostEntry,
      spawnProcess: ({ entry }) => {
        const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
        exits.push(new Promise((resolve) => child.once("close", resolve)));
        return {
          postMessage: (message) => { if (child.connected) child.send(message); },
          onMessage: (handler) => child.on("message", handler),
          onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
          kill: () => child.kill(),
        };
      },
    });
    try {
      await writeFile(join(dir, "manifest.json"), JSON.stringify({
        schemaVersion: 1, id: "fixture.permissions", name: "Permissions fixture", version: "1.0.0", main: "main.cjs",
        permissions: ["agent.prompt.inject", "agent.tool.register"],
      }));
      await writeFile(join(dir, "main.cjs"), `module.exports = {
        async onLoad() {
          const first = await pi.plugin.getPermissions();
          first.push("forged-permission");
          const second = await pi.plugin.getPermissions();
          await pi.ui.showToast(JSON.stringify(second));
        },
      };`);
      await runtime.loadFromPath(dir, granted);
      assert.deepEqual(runtime.drainToasts(), [JSON.stringify(granted)]);
    } finally {
      await runtime.unload("fixture.permissions");
      await Promise.all(exits);
      await rm(dir, { recursive: true, force: true });
    }
  });
}
