import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { uploadSshArtifact } = await import("../electron/main/remote/ssh-artifact-transfer.ts");
const { createSshBootstrap } = await import("../electron/main/remote/ssh-bootstrap.ts");
const { createSystemSshTransport } = await import("../electron/main/remote/ssh-transport.ts");
const bytes = Buffer.from([0, 255, 10, 13, 42, 0, 123]);
const digest = createHash("sha256").update(bytes).digest("hex");
const url = "https://github.com/example/release/artifact.tar.gz";
const remoteDir = "/home/test/.pi-desktop/pi-host/.upload.ABC123";
function transferFixture(overrides = {}) {
  const commands = [], uploads = [];
  const transport = {
    async exec(command) { commands.push(command); return { stdout: `${remoteDir}\n`, stderr: "", code: 0 }; },
    async execWithFile(command, path) {
      uploads.push({ command, path, data: await readFile(path), mode: (await stat(path)).mode & 0o777 });
      return { stdout: "", stderr: "", code: 0 };
    }, ...overrides,
  };
  return { transport, commands, uploads };
}
test("verified bytes stream over SSH, temporary local bytes are removed, cleanup is idempotent", async () => {
  const f = transferFixture();
  const artifact = await uploadSshArtifact(f.transport, { url, expectedSha256: digest,
    fetchArtifact: async () => new Response(bytes) });
  assert.equal(artifact.path, `${remoteDir}/artifact.tar.gz`);
  assert.deepEqual(f.uploads[0].data, bytes);
  if (process.platform !== "win32") assert.equal(f.uploads[0].mode, 0o600);
  await assert.rejects(stat(f.uploads[0].path), { code: "ENOENT" });
  await artifact.cleanup(); await artifact.cleanup();
  assert.equal(f.commands.length, 2);
  assert.match(f.commands[1], /case.*HOME/);
});
test("tampering is refused before any remote command", async () => {
  const f = transferFixture();
  await assert.rejects(uploadSshArtifact(f.transport, { url, expectedSha256: digest,
    fetchArtifact: async () => new Response("tampered") }), { errorCode: "HOST_INTEGRITY_FAILED" });
  assert.equal(f.commands.length, 0); assert.equal(f.uploads.length, 0);
});
test("unsafe deletion paths from remote stdout are never used", async () => {
  const f = transferFixture({ exec: async () => ({ stdout: "/home/test\n", stderr: "", code: 0 }) });
  await assert.rejects(uploadSshArtifact(f.transport, { url, expectedSha256: digest,
    fetchArtifact: async () => new Response(bytes) }), { errorCode: "HOST_UPLOAD_FAILED" });
  assert.equal(f.uploads.length, 0);
});
test("a failed upload cleans its own remote directory without leaking diagnostics", async () => {
  const f = transferFixture({ execWithFile: async () => { throw new Error("private-token-sentinel"); } });
  await assert.rejects(uploadSshArtifact(f.transport, { url, expectedSha256: digest,
    fetchArtifact: async () => new Response(bytes) }), error => error.errorCode === "HOST_UPLOAD_FAILED"
      && !error.message.includes("private-token-sentinel"));
  assert.equal(f.commands.length, 2);
});
test("already cancelled transfer does not fetch or create remote state", async () => {
  const f = transferFixture();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(uploadSshArtifact(f.transport, { url, expectedSha256: digest, signal: controller.signal,
    fetchArtifact: () => assert.fail("must not fetch") }), { name: "AbortError" });
  assert.equal(f.commands.length, 0);
});
test("release, network, integrity and upload failures keep distinct safe codes", async () => {
  for (const [fetchArtifact, expected] of [
    [async () => new Response("missing", { status: 404 }), "HOST_RELEASE_UNAVAILABLE"],
    [async () => { throw new Error("private-proxy-password"); }, "HOST_DOWNLOAD_FAILED"],
    [async () => new Response("corrupt"), "HOST_INTEGRITY_FAILED"],
  ]) {
    const f = transferFixture();
    await assert.rejects(uploadSshArtifact(f.transport, { url, expectedSha256: digest, fetchArtifact }),
      error => error.errorCode === expected && !error.message.includes("private-proxy-password"));
    assert.equal(f.commands.length, 0);
  }
  const f = transferFixture({ execWithFile: async () => ({ code: 1, stdout: "", stderr: "secret" }) });
  await assert.rejects(uploadSshArtifact(f.transport, { url, expectedSha256: digest,
    fetchArtifact: async () => new Response(bytes) }), { errorCode: "HOST_UPLOAD_FAILED" });
});
function bootstrapFixture(step) {
  const scripts = [], uploads = [], paired = [];
  let cleanups = 0, disposed = 0, forwarded = 0;
  const bootstrap = createSshBootstrap({ version: "1.0.0", fetchChecksum: async () => digest,
    reservePort: async () => 40000,
    buildTransport: () => ({
      exec: async () => ({ stdout: "Linux\nx86_64\n", stderr: "", code: 0 }),
      execWithInput: async (_command, script) => {
        scripts.push(script);
        if (step) throw Object.assign(new Error("remote install failed"), {
          stdout: `PI_HOST_BOOTSTRAP_FAILED ${step}\n`, stderr: "" });
        return { stdout: 'PI_HOST_READY {"hostId":"fixture","host":"127.0.0.1","port":41000,"version":"1.0.0"}\nPI_HOST_PAIRING_TOKEN {"token":"test","expiresAt":1}\n', stderr: "", code: 0 };
      },
      forward: async () => { forwarded++; return { localPort: 40000, close: async () => {} }; },
      dispose: () => { disposed++; },
    }),
    uploadArtifact: async (_transport, input) => { uploads.push(input); return {
      path: `${remoteDir}/artifact.tar.gz`, cleanup: async () => { cleanups++; },
    }; },
    exchangePairing: async input => { paired.push(input); return "device"; },
  });
  return { bootstrap, scripts, uploads, paired, counts: () => ({ cleanups, disposed, forwarded }) };
}
test("one verified local upload installs and pairs without a remote download attempt", async () => {
  const f = bootstrapFixture();
  const result = await f.bootstrap.bootstrap({ host: "test", label: "test" });
  assert.equal(result.deviceToken, "device");
  assert.equal(f.uploads.length, 1); assert.equal(f.scripts.length, 1); assert.equal(f.paired.length, 1);
  assert.equal(f.uploads[0].expectedSha256, digest);
  assert.match(f.scripts[0], /ARTIFACT_PATH='\/home\/test\/\.pi-desktop\/pi-host\/\.upload.ABC123\/artifact.tar.gz'/);
  assert.deepEqual(f.counts(), { cleanups: 1, disposed: 0, forwarded: 1 });
});
test("checksum failure never falls back or forwards", async () => {
  const f = bootstrapFixture("checksum-mismatch");
  await assert.rejects(f.bootstrap.bootstrap({ host: "test", label: "test" }), error => error.step === "checksum-mismatch");
  assert.equal(f.uploads.length, 1); assert.equal(f.paired.length, 0);
  assert.deepEqual(f.counts(), { cleanups: 1, disposed: 1, forwarded: 0 });
});
test("cancellation while checksum waits cannot resume installation", async () => {
  const gate = Promise.withResolvers(); const controller = new AbortController();
  let installs = 0;
  const bootstrap = createSshBootstrap({ version: "1", fetchChecksum: () => gate.promise,
    exchangePairing: () => assert.fail("must not pair"), buildTransport: () => ({
      exec: async () => ({ stdout: "Linux\nx86_64\n", stderr: "", code: 0 }),
      execWithInput: async () => { installs++; }, dispose() {},
    }) });
  const pending = bootstrap.bootstrap({ host: "test", label: "test" }, { signal: controller.signal });
  controller.abort(); gate.resolve(digest);
  await assert.rejects(pending, { name: "AbortError" }); assert.equal(installs, 0);
});
test("system SSH file transport preserves binary stdin", { skip: process.platform === "win32" ? "POSIX executable fixture requires a Linux/macOS runner" : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ssh-file-stream-"));
  const binary = join(dir, "ssh"), source = join(dir, "source"), dest = join(dir, "dest");
  await writeFile(binary, '#!/bin/sh\nfor arg do command="$arg"; done\nexec sh -c "$command"\n', { mode: 0o755 });
  await writeFile(source, bytes);
  const transport = createSystemSshTransport({ host: "fixture" }, { binary });
  try {
    await transport.execWithFile(`cat > '${dest}'`, source);
    assert.deepEqual(await readFile(dest), bytes);
    await assert.rejects(transport.execWithFile("cat >/dev/null", join(dir, "missing")), { errorCode: "HOST_BOOTSTRAP_FAILED" });
  } finally { transport.dispose(); await rm(dir, { recursive: true, force: true }); }
});
