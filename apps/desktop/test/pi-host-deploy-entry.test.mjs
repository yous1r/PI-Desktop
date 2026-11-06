import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("deployment CLI executes through the current directory link", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-deploy-entry-"));
  try {
    const current = join(root, "current");
    const scripts = fileURLToPath(new URL("../../pi-host/scripts/", import.meta.url));
    await symlink(scripts, current, process.platform === "win32" ? "junction" : "dir");
    const result = spawnSync(process.execPath, [join(current, "deploy.mjs"), "--invalid-operation"], {
      encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 1, "the linked CLI must execute instead of silently succeeding");
    assert.match(result.stderr, /DEPLOYMENT_FAILED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
