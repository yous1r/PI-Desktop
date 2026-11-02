import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HostProcess } from "../../../packages/host-runtime/dist/host-process.js";
import { McpSecurityService } from "../electron/main/mcp-security.ts";

// Run against a host-core built from this checkout; never substitute a mock or skip.
// PI_TEST_HOST_BINARY overrides target/debug or target/release (and CARGO_TARGET_DIR).
const RPC_TIMEOUT_MS = 5_000;
const ENDPOINT = "https://memory.invalid/mcp";
const CHANGED_ENDPOINT = "https://memory.invalid/other-mcp";
const REFERENCE = /^secret:mcp:bearer:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKENS = Object.fromEntries(["saved", "rotated", "moved", "anonymous", "stdio", "endpoint"].map((name) => [name, `synthetic-native-${name}-${randomUUID()}`]));
const TOKEN_BYTES = Object.values(TOKENS).map((token) => Buffer.from(token));

function assertNoTokens(value, context) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value) ?? "");
  // Boolean assertions deliberately keep a leaked credential out of test failure output.
  assert.equal(TOKEN_BYTES.some((token) => bytes.includes(token)), false, `${context} contains a synthetic credential`);
}

function assertPublic(value, context) {
  assertNoTokens(value, context);
  function visit(object) {
    if (!object || typeof object !== "object") return;
    for (const [key, nested] of Object.entries(object)) {
      assert.equal(["token", "bearertoken", "authorization"].includes(key.toLowerCase()), false, `${context} contains a raw credential field`);
      visit(nested);
    }
  }
  visit(value);
}

function nativeBinary() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const target = process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : join(root, "target");
  const name = `pi-desktop-host-core${process.platform === "win32" ? ".exe" : ""}`;
  const override = process.env.PI_TEST_HOST_BINARY?.trim();
  const candidates = override ? [resolve(override)] : [join(target, "debug", name), join(target, "release", name)];
  const binary = candidates.find((path) => {
    try { return statSync(path).isFile(); } catch { return false; }
  });
  assert.ok(binary, `A real compiled host-core is required. Build it from this worktree or set PI_TEST_HOST_BINARY. Tried: ${candidates.join(", ")}. This test is not skipped.`);
  const descriptor = openSync(binary, "r");
  const header = Buffer.alloc(4);
  try { readSync(descriptor, header, 0, header.length, 0); } finally { closeSync(descriptor); }
  const nativeMagic = header.subarray(0, 2).toString("hex") === "4d5a" ||
    ["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(header.toString("hex"));
  assert.equal(nativeMagic, true, `PI_TEST_HOST_BINARY must be a native executable, not a script: ${binary}`);
  return binary;
}

function deadline(promise, milliseconds, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })])
    .finally(() => clearTimeout(timer));
}

function serverInput(id, extra = {}) {
  return { id, label: id, level: "global", transport: "http", url: ENDPOINT, authType: "bearer",
    enabled: false, memoryProjectBindings: { "remote-project:native-fixture": "native-credentials" }, ...extra };
}

async function nativeFixture(t) {
  const binaryPath = nativeBinary();
  const root = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "pi-mcp-native-credentials-"));
  const dirs = Object.fromEntries(["data", "agents", "home", "appdata", "localappdata", "builtin", "tmp", "repo", "xdg-config", "xdg-data", "xdg-cache"].map((name) => [name, join(root, name)]));
  const children = [];
  const f = { root, dirs, host: null, security: null, registryUpserts: 0, beforeSecretDelete: null };
  const killOwnedChildren = () => {
    for (const entry of children) {
      if (!entry.closeInfo && entry.host.child.pid !== undefined) entry.host.child.kill("SIGKILL");
    }
  };
  process.once("exit", killOwnedChildren);

  async function stop(entry) {
    try {
      await entry.host.dispose(); // EOF is the native Host's controlled shutdown signal.
      await deadline(entry.closed, 2_000, "Native Host stdio did not close after disposal");
    } finally {
      if (!entry.closeInfo) {
        entry.host.child.kill("SIGKILL");
        await deadline(entry.closed, 2_000, "Native Host did not close after forced cleanup");
      }
    }
    assert.equal(entry.closeInfo.code, 0, "Native Host must shut down cleanly");
    assert.equal(entry.closeInfo.signal, null, "Native Host must not need a kill signal");
  }

  f.ownedPath = (path) => {
    assert.equal(typeof path, "string", "Native records must expose their configuration path");
    const remainder = relative(root, resolve(path));
    assert.equal(isAbsolute(remainder) || remainder === ".." || remainder.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`), false, "Native state escaped the isolated scratch root");
    return path;
  };
  f.configPath = (record) => f.ownedPath(record.path); // Actual native shape: path, level, projectPath.
  f.secretPath = (reference) => join(dirs.data, "secrets", `${createHash("sha256").update(reference).digest("hex")}.bin`);
  f.assertDisk = () => {
    let files = 0;
    let bytes = 0;
    function scan(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        assert.equal(entry.isSymbolicLink(), false, "Fixture state must not follow links outside scratch");
        const path = join(directory, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (entry.isFile()) {
          files += 1; bytes += statSync(path).size;
          assert.ok(files <= 512 && bytes <= 64 * 1024 * 1024, "Native fixture exceeded its bounded disk scan");
          assertNoTokens(readFileSync(path), "Native disk state");
        }
      }
    }
    scan(root);
    for (const directory of [join(dirs.agents, "servers"), join(dirs.repo, ".agents", "servers")]) {
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory)) {
        if (entry.endsWith(".json")) assertPublic(JSON.parse(readFileSync(join(directory, entry), "utf8")), "Ordinary servers JSON");
      }
    }
  };

  t.after(async () => {
    const failures = [];
    for (const entry of children) {
      try { await stop(entry); } catch (error) { failures.push(error); }
    }
    try {
      for (const entry of children) {
        assert.equal(entry.stderrOverflow, false, "Native Host exceeded the bounded stderr capture");
        assertNoTokens(entry.stderr, "Native Host stderr, including shutdown");
      }
      f.assertDisk();
    } catch (error) { failures.push(error); }
    try { rmSync(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (children.every((entry) => entry.closeInfo)) process.removeListener("exit", killOwnedChildren);
    if (failures.length) throw new AggregateError(failures, "Native credential fixture cleanup or leak check failed");
  });

  for (const directory of Object.values(dirs)) mkdirSync(directory, { recursive: true });
  const env = {
    PI_DESKTOP_AGENTS_DIR: dirs.agents, HOME: dirs.home, USERPROFILE: dirs.home,
    APPDATA: dirs.appdata, LOCALAPPDATA: dirs.localappdata, PI_DESKTOP_BUILTIN_PLUGINS_DIR: dirs.builtin,
    XDG_CONFIG_HOME: dirs["xdg-config"], XDG_DATA_HOME: dirs["xdg-data"], XDG_CACHE_HOME: dirs["xdg-cache"],
    TMP: dirs.tmp, TEMP: dirs.tmp, TMPDIR: dirs.tmp, RUST_LOG: "info", NO_COLOR: "1",
  };
  // A real, existing repository for the explicit global -> project transfer.
  // Ignore inherited Git configuration and templates; git init is entirely offline.
  const gitEnv = Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([name]) => !/^GIT_/i.test(name)));
  const git = spawnSync("git", ["init", "--quiet", `--template=${dirs.builtin}`, "--initial-branch=credential-fixture", dirs.repo], {
    cwd: root, env: { ...gitEnv, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(dirs.home, ".gitconfig"), GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8", timeout: 10_000,
  });
  assert.equal(git.status, 0, `Existing git is required to initialize an isolated repository fixture (${git.error?.code ?? "git init failed"})`);

  f.start = async () => {
    const entry = { stderr: "", stderrOverflow: false, closeInfo: null };
    entry.host = new HostProcess({ binaryPath, dataDir: dirs.data, env, onStderr: (text) => {
      entry.stderrOverflow ||= Buffer.byteLength(entry.stderr) + Buffer.byteLength(text) > 128 * 1024;
      entry.stderr = (entry.stderr + text).slice(0, 128 * 1024);
    } });
    entry.closed = new Promise((done) => entry.host.child.once("close", (code, signal) => { entry.closeInfo = { code, signal }; done(); }));
    children.push(entry);
    f.host = entry.host;
    const nativeCall = entry.host.call.bind(entry.host);
    const call = (method, params = {}) => nativeCall(method, params, RPC_TIMEOUT_MS);
    // Transparent observation only: every response comes from the compiled native process.
    entry.host.call = async (method, params = {}) => {
      if (method.startsWith("mcp.")) assertPublic(params, "Native registry RPC input");
      if (method === "mcp.upsert") f.registryUpserts += 1;
      if (method === "secrets.delete") await f.beforeSecretDelete?.(params, call);
      const result = await call(method, params);
      if (method !== "secrets.getForRuntime") assertNoTokens(result, "Public native RPC result");
      if (method.startsWith("mcp.")) assertPublic(result, "Public native registry result");
      return result;
    };
    await entry.host.handshake();
    assert.equal(entry.host.isAvailable(), true, "Native Host handshake must establish a live process");
    f.security = new McpSecurityService({ getHost: () => f.host, invalidate() {} });
  };
  f.restart = async () => {
    const oldHost = f.host;
    await stop(children.find((entry) => entry.host === oldHost));
    f.host = null;
    await f.start();
    assert.notEqual(f.host.generation, oldHost.generation, "Restart must create a new native Host process");
  };
  f.call = (method, params) => f.host.call(method, params);
  f.upsert = async (input) => {
    const result = await f.security.upsert(input);
    assertPublic(result, "Public McpSecurityService save result");
    return result.server;
  };
  f.describe = async (records) => {
    const result = await f.security.describe(records);
    assertPublic(result, "Public McpSecurityService describe result");
    return result;
  };
  await f.start();
  return f;
}

function assertRecord(f, record, level) {
  assert.equal(record.level, level);
  assert.equal(record.enabled, false, "Disabled synthetic endpoints must never connect");
  const directory = level === "global" ? join(f.dirs.agents, "servers") : join(f.dirs.repo, ".agents", "servers");
  assert.equal(resolve(f.configPath(record)), resolve(join(directory, `${record.id}.json`)));
  if (level === "project") assert.equal(record.projectPath, f.dirs.repo.replaceAll("\\", "/"));
  else assert.equal(record.projectPath, undefined);
}

async function assertManaged(f, record, token, endpoint = ENDPOINT) {
  assert.equal(record.authType, "bearer");
  assert.match(record.credentialRef, REFERENCE);
  assert.equal(record.hasBearerToken, true);
  assert.deepEqual(await f.call("secrets.has", { secretRef: record.credentialRef }), { has: true });
  const runtime = await f.call("secrets.getForRuntime", { secretRef: record.credentialRef });
  assert.equal(typeof runtime.value, "string", "Real Host runtime read must return a protected envelope");
  let envelope;
  try { envelope = JSON.parse(runtime.value); } catch { throw new Error("Native credential envelope must be valid JSON"); }
  assert.equal(Object.keys(envelope).sort().join(","), "endpoint,token,version");
  assert.equal(envelope.version, 1);
  assert.equal(envelope.endpoint, endpoint, "Secret must be bound to the exact endpoint");
  assert.equal(envelope.token === token, true, "Real Host must preserve the current token");
  assert.equal((await f.security.getBearerToken(record)) === token, true, "Runtime-only service read must use the real Host secret");

  const disk = readFileSync(f.secretPath(record.credentialRef));
  assertNoTokens(disk, "Encrypted credential file");
  const blob = Buffer.from(disk.toString("utf8").trim(), "base64");
  assertNoTokens(blob, "Decoded ciphertext (not merely base64 plaintext)");
  assert.ok(blob.length > 28, "Encrypted storage must contain a nonce, ciphertext and authentication tag");
  const key = readFileSync(join(f.dirs.data, "secrets", ".machine-key"));
  assert.equal(key.length, 32);
  // Independently verify the existing file_fallback AES-256-GCM format using only scratch key material.
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(-16));
  const plaintext = Buffer.concat([decipher.update(blob.subarray(12, -16)), decipher.final()]).toString("utf8");
  assert.equal(plaintext === runtime.value, true, "Disk secret must be authenticated encryption of the native runtime value");
  f.assertDisk();
}

async function assertMissing(f, reference) {
  assert.deepEqual(await f.call("secrets.has", { secretRef: reference }), { has: false });
  assert.deepEqual(await f.call("secrets.getForRuntime", { secretRef: reference }), { value: null });
  assert.equal(existsSync(f.secretPath(reference)), false, "Removed credentials must not remain on disk");
}

test("managed MCP credentials cross the real native Host boundary", { timeout: 60_000 }, async (t) => {
  const f = await nativeFixture(t);

  await t.test("save, keep unspecified, rotate, clear, reauthorize and restart persist only protected credentials", async () => {
    const input = serverInput("native-lifecycle");
    const saved = await f.upsert({ ...input, bearerToken: TOKENS.saved });
    assertRecord(f, saved, "global");
    await assertManaged(f, saved, TOKENS.saved);
    const raw = await f.call("mcp.list", { level: "global" });
    const listed = raw.servers.find((record) => record.id === saved.id);
    assert.equal(listed.credentialRef, saved.credentialRef);
    assert.equal(listed.hasBearerToken, undefined, "The native registry holds only the opaque reference");
    const [described] = await f.describe([listed]);
    assert.equal(described.hasBearerToken, true);

    const { authType, ...unspecified } = input;
    const kept = await f.upsert({ ...unspecified, label: "Kept native lifecycle" });
    assert.equal(kept.credentialRef, saved.credentialRef);
    await assertManaged(f, kept, TOKENS.saved);
    const rotated = await f.upsert({ ...unspecified, bearerToken: TOKENS.rotated });
    assert.equal(rotated.credentialRef, saved.credentialRef, "Rotation must reuse the Host-owned reference");
    await assertManaged(f, rotated, TOKENS.rotated);
    const cleared = await f.upsert({ ...unspecified, bearerToken: null });
    assert.equal(cleared.credentialRef, saved.credentialRef);
    assert.equal(cleared.hasBearerToken, false);
    await assertMissing(f, saved.credentialRef);
    await assert.rejects(f.security.getBearerToken(cleared), { errorCode: "MCP_AUTH_REQUIRED" });
    assert.equal((await f.describe([cleared]))[0].hasBearerToken, false);

    const restored = await f.upsert({ ...unspecified, bearerToken: TOKENS.rotated });
    assert.equal(restored.credentialRef, saved.credentialRef);
    const configuration = readFileSync(f.configPath(restored));
    const ciphertext = readFileSync(f.secretPath(restored.credentialRef));
    await f.restart();
    const reopened = (await f.call("mcp.list", { level: "global" })).servers.find((record) => record.id === restored.id);
    assertRecord(f, reopened, "global");
    assert.equal(reopened.credentialRef, saved.credentialRef);
    assert.equal(readFileSync(f.configPath(reopened)).equals(configuration), true, "Restart must preserve configuration");
    assert.equal(readFileSync(f.secretPath(reopened.credentialRef)).equals(ciphertext), true, "Restart must reuse the persisted encrypted secret");
    await assertManaged(f, (await f.describe([reopened]))[0], TOKENS.rotated);
    assertPublic(await f.security.remove({ id: reopened.id, level: "global" }), "Public removal result");
    await assertMissing(f, reopened.credentialRef);
  });

  await t.test("explicit global to project transfer renames conflicts and deletes the secret only after configuration is gone", async () => {
    const input = serverInput("native-move");
    const source = await f.upsert({ ...input, bearerToken: TOKENS.moved });
    const target = await f.upsert({ ...input, level: "project", projectPath: f.dirs.repo, authType: null });
    assertRecord(f, target, "project");
    const targetConfiguration = readFileSync(f.configPath(target));
    const result = await f.security.transfer({ id: source.id, from: { level: "global" }, to: { level: "project", projectPath: f.dirs.repo } });
    assertPublic(result, "Public transfer result");
    const moved = result.server;
    assertRecord(f, moved, "project");
    assert.notEqual(moved.id, source.id, "Conflicting target id must be renamed, not overwritten");
    assert.notEqual(moved.label, source.label, "Conflicting target label must remain distinguishable");
    assert.equal(moved.credentialRef, source.credentialRef);
    assert.deepEqual(moved.memoryProjectBindings, source.memoryProjectBindings);
    assert.equal(existsSync(f.configPath(source)), false);
    assert.equal((await f.call("mcp.list", { level: "global" })).servers.some((record) => record.id === source.id), false);
    const query = { level: "project", projectPath: f.dirs.repo };
    const projectRecords = (await f.call("mcp.list", query)).servers;
    assert.ok(projectRecords.some((record) => record.id === target.id));
    assert.ok(projectRecords.some((record) => record.id === moved.id));
    assert.equal(readFileSync(f.configPath(target)).equals(targetConfiguration), true, "Existing target configuration must survive byte-for-byte");
    await assertManaged(f, moved, TOKENS.moved);

    let observedDeletion = false;
    f.beforeSecretDelete = async ({ secretRef }, nativeCall) => {
      if (secretRef !== moved.credentialRef) return;
      // Observe the real filesystem and real native RPC before forwarding secrets.delete.
      assert.equal(existsSync(f.configPath(moved)), false, "Config file must be gone before deleting its secret");
      const remaining = await nativeCall("mcp.list", query);
      assertPublic(remaining, "Registry observed before secret deletion");
      assert.equal(remaining.servers.some((record) => record.id === moved.id), false);
      assert.deepEqual(await nativeCall("secrets.has", { secretRef }), { has: true });
      observedDeletion = true;
    };
    try {
      const removed = await f.security.remove({ id: moved.id, ...query });
      assertPublic(removed, "Public project removal result");
      assert.deepEqual(removed, { ok: true });
    } finally { f.beforeSecretDelete = null; }
    assert.equal(observedDeletion, true, "Real secret deletion must follow successful config removal");
    await assertMissing(f, moved.credentialRef);
    assert.equal(readFileSync(f.configPath(target)).equals(targetConfiguration), true);
    assert.deepEqual(await f.security.remove({ id: moved.id, ...query }), { ok: false });
    await f.security.remove({ id: target.id, ...query });
    f.assertDisk();
  });

  await t.test("switching managed Bearer to anonymous HTTP or stdio removes the old secret", async () => {
    const input = serverInput("native-auth-switch");
    const bearer = await f.upsert({ ...input, bearerToken: TOKENS.anonymous });
    await assertManaged(f, bearer, TOKENS.anonymous);
    const anonymous = await f.upsert({ ...input, authType: null });
    assert.equal(anonymous.authType, undefined);
    assert.equal(anonymous.credentialRef, undefined);
    assert.equal(anonymous.hasBearerToken, false);
    assert.equal(await f.security.getBearerToken(anonymous), null);
    assert.equal(existsSync(f.configPath(anonymous)), true);
    await assertMissing(f, bearer.credentialRef);

    const managedAgain = await f.upsert({ ...input, bearerToken: TOKENS.stdio });
    assert.notEqual(managedAgain.credentialRef, bearer.credentialRef);
    await assertManaged(f, managedAgain, TOKENS.stdio);
    const stdio = await f.upsert({ id: input.id, label: input.label, level: "global", transport: "stdio", command: process.execPath, args: ["--version"], enabled: false });
    assert.equal(stdio.transport, "stdio");
    assert.equal(stdio.url, undefined);
    assert.equal(stdio.authType, undefined);
    assert.equal(stdio.credentialRef, undefined);
    assert.equal(stdio.hasBearerToken, false);
    assert.equal(await f.security.getBearerToken(stdio), null);
    assert.equal(existsSync(f.configPath(stdio)), true);
    await assertMissing(f, managedAgain.credentialRef);
    await f.security.remove({ id: stdio.id, level: "global" });
    f.assertDisk();
  });

  await t.test("endpoint changes reject before persistence and external native registry tampering fails closed at runtime", async () => {
    const input = serverInput("native-endpoint");
    const saved = await f.upsert({ ...input, bearerToken: TOKENS.endpoint });
    await assertManaged(f, saved, TOKENS.endpoint);
    const configuration = readFileSync(f.configPath(saved));
    const ciphertext = readFileSync(f.secretPath(saved.credentialRef));
    const writes = f.registryUpserts;
    await assert.rejects(f.security.upsert({ ...input, url: CHANGED_ENDPOINT }), { errorCode: "MCP_AUTH_TARGET_CHANGED" });
    assert.equal(f.registryUpserts, writes, "Unauthorized endpoint changes must never reach mcp.upsert");
    assert.equal(readFileSync(f.configPath(saved)).equals(configuration), true, "Rejected endpoint edit must not persist config");
    assert.equal(readFileSync(f.secretPath(saved.credentialRef)).equals(ciphertext), true, "Rejected endpoint edit must not change the secret");
    const unchanged = (await f.call("mcp.list", { level: "global" })).servers.find((record) => record.id === saved.id);
    assert.equal(unchanged.url, ENDPOINT);
    await assertManaged(f, (await f.describe([unchanged]))[0], TOKENS.endpoint);

    // Simulate an external config editor via native RPC, without raw credentials or caller-owned refs.
    const tampered = (await f.call("mcp.upsert", { server: { ...input, url: CHANGED_ENDPOINT } })).server;
    assert.equal(tampered.credentialRef, saved.credentialRef);
    assert.equal(tampered.url, CHANGED_ENDPOINT);
    assert.equal(readFileSync(f.secretPath(saved.credentialRef)).equals(ciphertext), true);
    const [publicTampered] = await f.describe([tampered]);
    assert.equal(publicTampered.hasBearerToken, true, "Presence is public metadata, not endpoint authorization");
    await assert.rejects(f.security.getBearerToken(publicTampered), { errorCode: "MCP_AUTH_TARGET_CHANGED" });
    await f.security.remove({ id: tampered.id, level: "global" });
    await assertMissing(f, saved.credentialRef);
    f.assertDisk();
  });

  assert.deepEqual((await f.call("mcp.active", { projectPath: f.dirs.repo })).servers, [], "No synthetic HTTP or stdio server may be activated");
});
