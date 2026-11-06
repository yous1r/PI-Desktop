import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { uploadSshArtifact } = await import("../electron/main/remote/ssh-artifact-transfer.ts");
const { createSshBootstrap } = await import("../electron/main/remote/ssh-bootstrap.ts");
const { acquirePiHostArtifact, piHostCachePaths } = await import("../electron/main/remote/pi-host-artifact-cache.ts");
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
test("upload consumes a verified cached path without redownloading or deleting its borrowed file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-host-upload-cache-"));
  try {
    const cachedPath = join(directory, "verified.tar.gz");
    await writeFile(cachedPath, bytes, { mode: 0o600 });
    let fetches = 0;
    const f = transferFixture();
    const artifact = await uploadSshArtifact(f.transport, { url, expectedSha256: digest,
      artifactPath: cachedPath, fetchArtifact: async () => { fetches++; throw new Error("must use cache"); } });
    assert.deepEqual(f.uploads[0].data, bytes);
    assert.equal(fetches, 0);
    await assert.doesNotReject(readFile(cachedPath));
    await artifact.cleanup();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
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
const cacheVersion = "1.2.3";
const cacheArtifact = `pi-host-${cacheVersion}-linux-x64.tar.gz`;
const cacheUrl = `https://github.com/yous1r/PI-Desktop/releases/download/v${cacheVersion}/${cacheArtifact}`;
const cacheChecksum = `${digest}  ${cacheArtifact}\n`;
async function acquireCache(directory, overrides = {}) {
  return acquirePiHostArtifact({ directory, url: cacheUrl, artifactName: cacheArtifact,
    fetchChecksum: async () => cacheChecksum, fetchArtifact: async () => new Response(bytes), ...overrides });
}
test("verified archive cache survives a new instance and hit avoids checksum/artifact network", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-host-cache-"));
  try {
    let checksumFetches = 0, artifactFetches = 0;
    const first = await acquireCache(directory, {
      fetchChecksum: async () => { checksumFetches++; return cacheChecksum; },
      fetchArtifact: async () => { artifactFetches++; return new Response(bytes); },
    });
    await first.release();
    const second = await acquireCache(directory, {
      fetchChecksum: async () => { checksumFetches++; throw new Error("cache hit requested checksum"); },
      fetchArtifact: async () => { artifactFetches++; throw new Error("cache hit requested artifact"); },
    });
    assert.equal(second.expectedSha256, digest);
    assert.deepEqual(await readFile(second.path), bytes);
    assert.deepEqual([checksumFetches, artifactFetches], [1, 1]);
    await second.release();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("cache identities separate version and platform release URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-host-cache-"));
  try {
    const base = await acquireCache(directory); await base.release();
    const armName = `pi-host-${cacheVersion}-linux-arm64.tar.gz`;
    const armUrl = `https://github.com/yous1r/PI-Desktop/releases/download/v${cacheVersion}/${armName}`;
    let fetches = 0;
    const arm = await acquirePiHostArtifact({ directory, url: armUrl, artifactName: armName,
      fetchChecksum: async () => { fetches++; return `${digest}  ${armName}\n`; },
      fetchArtifact: async () => { fetches++; return new Response(bytes); } });
    await arm.release();
    const nextVersion = "1.2.4", nextName = `pi-host-${nextVersion}-linux-x64.tar.gz`;
    const nextUrl = `https://github.com/yous1r/PI-Desktop/releases/download/v${nextVersion}/${nextName}`;
    const next = await acquirePiHostArtifact({ directory, url: nextUrl, artifactName: nextName,
      fetchChecksum: async () => { fetches++; return `${digest}  ${nextName}\n`; },
      fetchArtifact: async () => { fetches++; return new Response(bytes); } });
    assert.notEqual(piHostCachePaths(directory, cacheUrl, cacheArtifact).manifest,
      piHostCachePaths(directory, armUrl, armName).manifest);
    assert.notEqual(piHostCachePaths(directory, cacheUrl, cacheArtifact).manifest,
      piHostCachePaths(directory, nextUrl, nextName).manifest);
    assert.equal(fetches, 4);
    await next.release();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("corrupt cached bytes are never returned and are refreshed only against published digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-host-cache-"));
  try {
    const first = await acquireCache(directory); const cachedPath = first.path; await first.release();
    await writeFile(cachedPath, "corruption");
    let checksumFetches = 0, artifactFetches = 0;
    const refreshed = await acquireCache(directory, {
      fetchChecksum: async () => { checksumFetches++; return cacheChecksum; },
      fetchArtifact: async () => { artifactFetches++; return new Response(bytes); },
    });
    assert.deepEqual(await readFile(refreshed.path), bytes);
    assert.deepEqual([checksumFetches, artifactFetches], [1, 1]);
    await refreshed.release();
    await writeFile(refreshed.path, "again-corrupt");
    await assert.rejects(acquireCache(directory, { fetchChecksum: async () => `${"0".repeat(64)}  ${cacheArtifact}\n`,
      fetchArtifact: async () => new Response(bytes) }), { errorCode: "HOST_INTEGRITY_FAILED" });
    await assert.rejects(readFile(refreshed.path), { code: "ENOENT" });
    const files = await readdir(join(directory, "archives"));
    assert.ok(files.every(name => !name.startsWith(".partial-")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("invalid cached release metadata is discarded before a verified refresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-host-cache-"));
  try {
    const first = await acquireCache(directory); await first.release();
    const { manifest } = piHostCachePaths(directory, cacheUrl, cacheArtifact);
    const metadata = JSON.parse(await readFile(manifest, "utf8"));
    await writeFile(manifest, JSON.stringify({ ...metadata, url: "https://invalid.example/archive" }));
    let downloads = 0;
    const refreshed = await acquireCache(directory, { fetchArtifact: async () => {
      downloads++; return new Response(bytes);
    } });
    try { assert.equal(downloads, 1); assert.deepEqual(await readFile(refreshed.path), bytes); }
    finally { await refreshed.release(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("failed or cancelled artifact downloads leave no partial or reusable manifest", async () => {
  for (const mode of ["failure", "abort"]) {
    const directory = await mkdtemp(join(tmpdir(), "pi-host-cache-"));
    try {
      const controller = new AbortController();
      const fetchArtifact = async () => {
        if (mode === "failure") return new Response(new ReadableStream({
          start(stream) { stream.enqueue(bytes.subarray(0, 3)); stream.error(new Error("network interrupted")); },
        }));
        return new Response(new ReadableStream({
          start(stream) { stream.enqueue(bytes.subarray(0, 3)); controller.abort(); },
        }));
      };
      await assert.rejects(acquireCache(directory, { fetchArtifact, signal: controller.signal }),
        mode === "abort" ? { name: "AbortError" } : { errorCode: "HOST_DOWNLOAD_FAILED" });
      const releases = await readdir(join(directory, "releases"));
      const archives = await readdir(join(directory, "archives"));
      assert.deepEqual(releases, []); assert.ok(archives.every(name => !name.startsWith(".partial-")));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
test("concurrent callers serialize safely and the waiter reuses the verified result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-host-cache-"));
  try {
    let artifactFetches = 0;
    const first = await acquireCache(directory, { fetchArtifact: async () => {
      artifactFetches++; return new Response(bytes);
    } });
    let secondFetches = 0;
    const secondPending = acquireCache(directory, { fetchChecksum: async () => {
      secondFetches++; return cacheChecksum;
    }, fetchArtifact: async () => { secondFetches++; return new Response(bytes); } });
    await new Promise(resolvePromise => setImmediate(resolvePromise));
    await first.release();
    const second = await secondPending;
    assert.equal(artifactFetches, 1); assert.equal(secondFetches, 0); assert.equal(first.path, second.path);
    await second.release();
  } finally { await rm(directory, { recursive: true, force: true }); }
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

test("cache retention stays bounded and keeps the just-acquired archive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-host-cache-bound-"));
  try {
    let latest;
    for (let patch = 0; patch < 10; patch++) {
      const version = `2.0.${patch}`, artifactName = `pi-host-${version}-linux-x64.tar.gz`;
      const content = Buffer.from(`release-${patch}`), hash = createHash("sha256").update(content).digest("hex");
      const lease = await acquirePiHostArtifact({ directory, artifactName,
        url: `https://github.com/yous1r/PI-Desktop/releases/download/v${version}/${artifactName}`,
        fetchChecksum: async () => `${hash}  ${artifactName}`,
        fetchArtifact: async () => new Response(content),
      });
      try { assert.deepEqual(await readFile(lease.path), content); latest = lease.path; }
      finally { await lease.release(); }
    }
    assert.equal((await readdir(join(directory, "releases"))).length, 8);
    assert.equal((await readdir(join(directory, "archives"))).length, 8);
    assert.deepEqual(await readFile(latest), Buffer.from("release-9"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
