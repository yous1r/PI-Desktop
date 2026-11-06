import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { parseRemoteHostReady } = await import("../electron/main/remote/remote-host-supervisor.ts");
const { installPiHost } = await import("../electron/main/remote/pi-host-installer.ts");

function probe(version, expected) {
  return parseRemoteHostReady(`PI_HOST_READY ${JSON.stringify({ hostId: "known", host: "127.0.0.1", port: 4567, version })}`,
    { version: expected, expectedHostId: "known" });
}

test("a newer remote release never authorizes downgrading the shared data", () => {
  for (const [remote, desktop] of [["2.0.0", "1.9.0"], ["1.0.0-beta.10", "1.0.0-beta.9"]]) {
    assert.throws(() => probe(remote, desktop), { errorCode: "HOST_CLIENT_TOO_OLD", retriable: false });
  }
  assert.throws(() => probe("1.0.0-beta.9", "1.0.0-beta.10"), { errorCode: "HOST_VERSION_MISMATCH" });
});

test("unknown or cross-channel releases never authorize automatic replacement", () => {
  for (const [remote, desktop] of [["custom", "1.0.0"], ["1.0.0-alpha.1", "1.0.0-beta.1"], ["1.0.0", "2.0.0-beta.1"]]) {
    assert.throws(() => probe(remote, desktop), { errorCode: "HOST_VERSION_UNSUPPORTED", retriable: false });
  }
});

const input = { version: "1.0.0", artifactUrl: "https://github.com/example/pi-host.tar.gz",
  artifactName: "pi-host.tar.gz", bundleDir: "pi-host", expectedSha256: "a".repeat(64),
  port: 0, pairingLifetimeMs: 600000, readyTimeoutSec: 30 };

test("installation uploads verified local bytes before executing the installer", async () => {
  const order = [];
  const transport = { execWithInput: async (_command, script) => {
    order.push("install");
    assert.match(script, /ARTIFACT_PATH='\/home\/test\/\.pi-desktop\/pi-host\/\.upload.ABC123\/artifact.tar.gz'/);
    return { code: 0, stdout: "", stderr: "" };
  } };
  const fetchArtifact = async () => new Response();
  await installPiHost(transport, input, { timeoutMs: 1000, fetchArtifact,
    uploadArtifact: async (_transport, received) => {
      order.push("download-upload");
      assert.equal(received.fetchArtifact, fetchArtifact);
      assert.equal(received.expectedSha256, input.expectedSha256);
      return { path: "/home/test/.pi-desktop/pi-host/.upload.ABC123/artifact.tar.gz", cleanup: async () => { order.push("cleanup"); } };
    },
  });
  assert.deepEqual(order, ["download-upload", "install", "cleanup"]);
});

test("failed Desktop download never falls back to a remote download", async () => {
  let scripts = 0;
  await assert.rejects(installPiHost({ execWithInput: async () => { scripts++; return { code: 0, stdout: "", stderr: "" }; } }, input,
    { timeoutMs: 1000, uploadArtifact: async () => { throw Object.assign(new Error("download unavailable"), { errorCode: "HOST_DOWNLOAD_FAILED" }); } }),
    { errorCode: "HOST_DOWNLOAD_FAILED" });
  assert.equal(scripts, 0);
});
