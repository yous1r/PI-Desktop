import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { buildBootstrapScript } = await import("../electron/main/remote/pi-host-bootstrap-script.ts");

test("Desktop carries its deployment worker independently of published archive scripts", async () => {
  const script = buildBootstrapScript({ version: "0.22.2", artifactUrl: "https://release.invalid/bundle",
    artifactName: "pi-host-0.22.2-linux-x64.tar.gz", bundleDir: "pi-host-0.22.2-linux-x64",
    expectedSha256: "a".repeat(64), artifactPath: "/home/test/.pi-desktop/pi-host/.upload.ABC123/artifact.tar.gz",
    port: 0, pairingLifetimeMs: 600000, readyTimeoutSec: 30 });
  for (const name of ["deploy.mjs", "deploy-recovery.mjs"]) {
    const source = await readFile(new URL(`../../pi-host/scripts/${name}`, import.meta.url));
    assert.ok(script.includes(source.toString("base64")), `${name} must travel with Desktop`);
    assert.ok(!script.includes(`cp "$bundle/${name}"`), "published workers must not override the client worker");
  }
});
