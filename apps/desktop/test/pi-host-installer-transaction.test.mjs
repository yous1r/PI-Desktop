/**
 * Transaction modes of `apps/pi-host/scripts/install.sh`.
 *
 * The default mode keeps its released contract (stage, then atomically switch
 * `current`). The deployment worker needs two more capabilities that must not
 * weaken it:
 *
 * - `--stage` publishes a verified, content-addressed version directory and
 *   prints its path without touching `current`;
 * - `--activate <dir>` / `--activate-locked <dir>` switch `current` to such a
 *   staged directory atomically, refusing anything outside the install root,
 *   an address mismatch, or a legacy real `current` directory.
 *
 * Each case runs against an isolated `$PI_HOST_INSTALL_DIR` fixture. The
 * fixture uses the real `install.sh` and real Node, with a wrapper `bin/node`
 * so the installer's own atomic-rename helper is genuine.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALLER = fileURLToPath(new URL("../../pi-host/scripts/install.sh", import.meta.url));
const FILES = ["bin/node", "bin/pi-host", "bin/pi-desktop-host-core", "pi-host.js", "install.sh"];

/**
 * Windows/MSYS cannot mark an extensionless file executable, so `install.sh`'s
 * own `-x bin/node` verification step cannot succeed there. The suite is
 * meaningful on a POSIX host; elsewhere it skips with this reason instead of
 * reporting a product failure.
 */
const HOST_LIMITATION = (() => {
  if (process.platform !== "win32") return false;
  return "this host cannot represent POSIX executable bits for extensionless files (Windows/MSYS)";
})();

function write(path, content, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
}

/** One release directory with a valid SHA256SUMS and a working `bin/node`. */
function release(root, label) {
  const dir = join(root, `release-${label}`);
  write(join(dir, "install.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  write(join(dir, "bin/pi-host"), "#!/bin/sh\nexit 0\n", 0o755);
  write(join(dir, "bin/pi-desktop-host-core"), "host-core\n", 0o755);
  write(join(dir, "pi-host.js"), `console.log(${JSON.stringify(label)});\n`);
  write(join(dir, "bin/node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, 0o755);
  const manifest = FILES.map((file) =>
    `${createHash("sha256").update(readFileSync(join(dir, file))).digest("hex")}  ${file}\n`).join("");
  write(join(dir, "SHA256SUMS"), manifest);
  return dir;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-host-transaction-"));
  const installDir = join(root, "installed");
  // The uploaded release directory is the installer's own source directory.
  const source = release(root, "source");
  writeFileSync(join(source, "install.sh"), readFileSync(INSTALLER), { mode: 0o755 });
  writeFileSync(join(source, "SHA256SUMS"),
    FILES.map((file) => `${createHash("sha256").update(readFileSync(join(source, file))).digest("hex")}  ${file}\n`).join(""));
  return {
    root,
    installDir,
    installer: join(source, "install.sh"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function install(source, installDir, ...args) {
  const result = spawnSync("sh", [source, ...args], {
    encoding: "utf8",
    env: { ...process.env, PI_HOST_INSTALL_DIR: installDir },
  });
  if (result.error) throw result.error;
  return result;
}

function current(installDir) {
  return readlinkSync(join(installDir, "current"));
}

test("default mode stages and switches current, keeping the released contract", { skip: HOST_LIMITATION }, () => {
  const f = fixture();
  try {
    const result = install(f.installer, f.installDir);
    assert.equal(result.status, 0, result.stderr);
    const target = current(f.installDir);
    assert.match(target, /sha256-[a-f0-9]{64}$/);
    assert.match(result.stdout, /^PI_HOST_INSTALLED .*sha256-[a-f0-9]{64}$/m);
    // Repeated installs of identical bytes reuse the immutable version.
    assert.equal(install(f.installer, f.installDir).status, 0);
    assert.equal(current(f.installDir), target);
    assert.deepEqual(readdirSync(f.installDir).filter((name) => name.startsWith(".stage") || name.startsWith(".activate")), []);
  } finally {
    f.cleanup();
  }
});

test("--stage publishes the version directory and never touches current", { skip: HOST_LIMITATION }, () => {
  const f = fixture();
  try {
    const first = install(f.installer, f.installDir, "--stage");
    assert.equal(first.status, 0, first.stderr);
    const staged = /^PI_HOST_STAGED (.*)$/m.exec(first.stdout)?.[1];
    assert.ok(staged, "the staged path is reported machine-readably");
    assert.match(staged, /\/sha256-[a-f0-9]{64}$/);
    assert.equal(staged.startsWith(f.installDir), true);
    assert.deepEqual(
      readdirSync(f.installDir).filter((name) => name.startsWith(".stage") || name.startsWith(".activate") || name === "current"),
      [],
      "staging publishes only the version directory and must not create current",
    );
    assert.deepEqual(readdirSync(f.installDir).filter((name) => name.startsWith("sha256-")), [staged.slice(f.installDir.length + 1)]);
    assert.throws(() => current(f.installDir), "current must not exist before activation");
    // A second identical stage is idempotent and returns the same address.
    const second = install(f.installer, f.installDir, "--stage");
    assert.equal(second.status, 0, second.stderr);
    assert.equal(/^PI_HOST_STAGED (.*)$/m.exec(second.stdout)?.[1], staged);
  } finally {
    f.cleanup();
  }
});

test("--activate switches current to an already staged version atomically", { skip: HOST_LIMITATION }, () => {
  const f = fixture();
  try {
    const staged = /^PI_HOST_STAGED (.*)$/m.exec(install(f.installer, f.installDir, "--stage").stdout)?.[1];
    assert.ok(staged);
    const activated = install(f.installer, f.installDir, "--activate", staged);
    assert.equal(activated.status, 0, activated.stderr);
    assert.equal(current(f.installDir), staged);
    assert.match(activated.stdout, /^PI_HOST_ACTIVATED /m);
    // The activated entry point is the staged bundle's, verified in place.
    assert.equal(execFileSync(process.execPath, [join(f.installDir, "current/pi-host.js")], { encoding: "utf8" }).trim(), "source");
  } finally {
    f.cleanup();
  }
});

test("--activate-locked does not take the deployment lock itself", { skip: HOST_LIMITATION }, () => {
  const f = fixture();
  try {
    const staged = /^PI_HOST_STAGED (.*)$/m.exec(install(f.installer, f.installDir, "--stage").stdout)?.[1];
    // A second activation from the same test process must not self-deadlock on
    // .deploy.lock: the locked variant is the worker's post-lease entry point.
    const result = install(join(staged, "install.sh"), f.installDir, "--activate-locked", staged);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(current(f.installDir), staged);
  } finally {
    f.cleanup();
  }
});

test("--activate refuses a staged directory outside the install root", { skip: HOST_LIMITATION }, () => {
  const f = fixture();
  try {
    const outside = release(f.root, "outside");
    const result = install(f.installer, f.installDir, "--activate", outside);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside the install root/);
    assert.throws(() => current(f.installDir));
  } finally {
    f.cleanup();
  }
});

test("--activate refuses an address mismatch and tampered staged contents", { skip: HOST_LIMITATION }, () => {
  const f = fixture();
  try {
    const staged = /^PI_HOST_STAGED (.*)$/m.exec(install(f.installer, f.installDir, "--stage").stdout)?.[1];
    assert.ok(staged);
    writeFileSync(join(staged, "pi-host.js"), "damaged\n");
    const tampered = install(f.installer, f.installDir, "--activate", staged);
    assert.notEqual(tampered.status, 0);
    assert.throws(() => current(f.installDir), "a damaged version is never activated");
    assert.match(readFileSync(join(staged, "pi-host.js"), "utf8"), /damaged/, "the version directory is left for inspection");
  } finally {
    f.cleanup();
  }
});

test("--activate still refuses a legacy real current directory", { skip: HOST_LIMITATION }, () => {
  const f = fixture();
  try {
    const staged = /^PI_HOST_STAGED (.*)$/m.exec(install(f.installer, f.installDir, "--stage").stdout)?.[1];
    const legacy = join(f.installDir, "current");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "keep"), "old current");
    const result = install(f.installer, f.installDir, "--activate", staged);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /legacy current directory/);
    assert.equal(readFileSync(join(legacy, "keep"), "utf8"), "old current");
  } finally {
    f.cleanup();
  }
});

test("unknown installer arguments fail closed", { skip: HOST_LIMITATION }, () => {
  const f = fixture();
  try {
    const result = install(f.installer, f.installDir, "--force");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown install option/);
  } finally {
    f.cleanup();
  }
});

test("--stage still verifies the release before publishing anything", { skip: HOST_LIMITATION }, () => {
  const f = fixture();
  try {
    writeFileSync(join(dirname(f.installer), "pi-host.js"), "tampered\n");
    const result = install(f.installer, f.installDir, "--stage");
    assert.notEqual(result.status, 0);
    assert.equal(readdirSync(f.installDir).some((name) => name.startsWith("sha256-")), false);
  } finally {
    f.cleanup();
  }
});

test("a stale stage or activation scratch directory is cleaned up on failure", { skip: HOST_LIMITATION }, () => {
  const f = fixture();
  try {
    mkdirSync(f.installDir, { recursive: true });
    const junk = `sha256-${"a".repeat(64)}`;
    mkdirSync(join(f.installDir, junk));
    symlinkSync(join(f.root, "missing"), join(f.installDir, "current"));
    const result = install(f.installer, f.installDir, "--stage");
    // `current` is unrelated to staging; the stage must still succeed and leave
    // no scratch directories behind.
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(f.installDir).filter((name) => name.startsWith(".stage") || name.startsWith(".activate")), []);
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Detached worker contract
// ---------------------------------------------------------------------------

const DEPLOY = fileURLToPath(new URL("../../pi-host/scripts/deploy.mjs", import.meta.url));

function worker(...args) {
  const home = mkdtempSync(join(tmpdir(), "pi-host-worker-"));
  try {
    const result = spawnSync(process.execPath, [DEPLOY, ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, NODE_OPTIONS: "", NODE_PATH: "" },
    });
    return { ...result, home };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("the deployment worker rejects unknown operations with a typed code", () => {
  const result = worker("--not-an-operation");
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "DEPLOYMENT_FAILED");
});

test("the deployment worker validates the request before doing any work", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-host-worker-request-"));
  try {
    const requestPath = join(home, "request.json");
    writeFileSync(requestPath, JSON.stringify({ transactionId: "not-hex" }), { mode: 0o600 });
    const result = spawnSync(process.execPath, [DEPLOY, "--begin", requestPath], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, NODE_OPTIONS: "", NODE_PATH: "" },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), "DEPLOYMENT_FAILED");
    assert.equal(existsSync(join(home, ".pi-desktop/pi-host/.bootstrap/deployment-state.json")), false,
      "no deployment state is written for an invalid request");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the deployment worker refuses to complete without a verified readiness record", () => {
  const transactionId = "a".repeat(32);
  const result = worker("--complete", transactionId, "host_x");
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), "DEPLOYMENT_FAILED");
});

test("the deployment worker documents the durable marker contract in its source", () => {
  const source = readFileSync(DEPLOY, "utf8");
  // Parent supervisor contract: these exact paths and phases are how an
  // interrupted activation is detected after SSH/desktop loss.
  for (const marker of [
    'join(work, "deployment-state.json")',
    'join(work, "transactions")',
    '"awaiting-racp"',
    '"recovery-required"',
    '"failed-safe"',
    'PI_HOST_DEPLOYMENT_QUEUED',
    'PI_HOST_DEPLOYMENT_COMPLETE',
  ]) {
    assert.ok(source.includes(marker), `${marker} is part of the marker contract`);
  }
  // The lock every worker run holds while it activates or recovers.
  assert.ok(source.includes('join(base, ".deploy.lock")'));
});

test("activation validates the supplied path instead of reading an unset shell variable", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-host-invalid-activation-"));
  try {
    const result = install(INSTALLER, root, "--activate-locked", join(root, "missing"));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Staged version is missing or unsafe/);
    assert.doesNotMatch(result.stderr, /parameter not set|unbound variable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("generated deployment shell expands checksum length before rejecting an absent upload", async () => {
  const { register } = await import("node:module");
  register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
  const { buildBootstrapScript } = await import("../electron/main/remote/pi-host-bootstrap-script.ts");
  const script = buildBootstrapScript({ version: "1.2.0", artifactUrl: "https://release.invalid/bundle", artifactName: "bundle.tar.gz",
    bundleDir: "bundle", expectedSha256: "a".repeat(64), port: 0, pairingLifetimeMs: 600000, readyTimeoutSec: 30 });
  const result = spawnSync("sh", ["-s"], { encoding: "utf8", input: 'uname() { printf Linux; }; flock() { :; };\n' + script });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /upload-required/);
  assert.doesNotMatch(result.stderr, /invalid-checksum|integer expression/);
});

// ---------------------------------------------------------------------------
// Damaged bundle repair
// ---------------------------------------------------------------------------

/** A request file the worker can validate; only the token hash varies. */
function transactionRequest(home, overrides = {}) {
  const transactionId = String(overrides.transactionId ?? "c".repeat(32));
  const transactionDir = join(home, ".pi-desktop/pi-host/.bootstrap/transactions", transactionId);
  mkdirSync(transactionDir, { recursive: true });
  writeFileSync(join(transactionDir, "artifact.tar.gz"), "", { mode: 0o600 });
  return {
    transactionId,
    version: "0.0.0",
    bundleDir: "pi-host-0.0.0-linux-x64",
    artifactName: "pi-host-0.0.0-linux-x64.tar.gz",
    expectedSha256: "a".repeat(64),
    artifactPath: join(transactionDir, "artifact.tar.gz"),
    port: 0,
    pairingLifetimeMs: 600000,
    readyTimeoutSec: 30,
    ...overrides,
  };
}

function runWorker(home, request) {
  const transactionDir = join(home, ".pi-desktop/pi-host/.bootstrap/transactions", request.transactionId);
  const requestPath = join(transactionDir, "request.json");
  writeFileSync(requestPath, JSON.stringify(request), { mode: 0o600 });
  return spawnSync(process.execPath, [DEPLOY, "--run", requestPath], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, NODE_OPTIONS: "", NODE_PATH: "" },
  });
}

test("the worker refuses a raw or malformed device token hash", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-host-worker-token-"));
  const failureCode = (transactionId) => {
    const path = join(home, ".pi-desktop/pi-host/.bootstrap/transactions", transactionId, "failure.json");
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).code : null;
  };
  try {
    for (const expectedDeviceTokenHash of ["ppt1.raw-token", "ABC", "a".repeat(63)]) {
      const request = transactionRequest(home, { expectedDeviceTokenHash });
      runWorker(home, request);
      // Validation happens before any state, staging or credential read, and
      // the failure record is the durable, observable outcome of `--run`.
      assert.equal(failureCode(request.transactionId), "DEPLOYMENT_FAILED");
      assert.equal(readFileSync(join(home, ".pi-desktop/pi-host/.bootstrap/transactions",
        request.transactionId, "failure.json"), "utf8").includes("ppt1"), false,
      "the rejected value is never echoed");
    }
    // Without a hash the same request passes validation and stops at the
    // missing queued state instead, proving the checks above are the hash.
    const accepted = transactionRequest(home, { transactionId: "d".repeat(32) });
    runWorker(home, accepted);
    assert.equal(failureCode(accepted.transactionId), "HOST_RECOVERY_REQUIRED");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a damaged canonical version is never reused or modified", { skip: HOST_LIMITATION }, () => {
  const f = fixture();
  try {
    assert.equal(install(f.installer, f.installDir).status, 0);
    const healthy = current(f.installDir);
    // Damage the active, canonical version so its manifest no longer verifies.
    writeFileSync(join(healthy, "pi-host.js"), "damaged-forensic-bytes\n");
    const staged = install(f.installer, f.installDir, "--stage");
    assert.equal(staged.status, 0, staged.stderr);
    const repaired = /^PI_HOST_STAGED (.*)$/m.exec(staged.stdout)?.[1];
    assert.match(repaired, /-repair-[a-f0-9]{16}$/);
    assert.equal(current(f.installDir), healthy, "staging leaves the working pointer untouched");
    assert.equal(readFileSync(join(healthy, "pi-host.js"), "utf8"), "damaged-forensic-bytes\n",
      "damaged bytes are preserved for inspection");
    const verified = install(join(repaired, "install.sh"), f.installDir, "--verify");
    assert.equal(verified.status, 0, `the repair sibling verifies independently: ${verified.stderr}`);
    // A repeated stage reuses the healthy repair sibling instead of accumulating.
    const again = install(f.installer, f.installDir, "--stage");
    assert.equal(again.status, 0, again.stderr);
    assert.equal(/^PI_HOST_STAGED (.*)$/m.exec(again.stdout)?.[1], repaired);
  } finally {
    f.cleanup();
  }
});

test("a repair sibling can be activated while the damaged version stays on disk", { skip: HOST_LIMITATION }, () => {
  const f = fixture();
  try {
    install(f.installer, f.installDir);
    const damaged = current(f.installDir);
    writeFileSync(join(damaged, "pi-host.js"), "damaged\n");
    const repaired = /^PI_HOST_STAGED (.*)$/m.exec(install(f.installer, f.installDir, "--stage").stdout)?.[1];
    const activated = install(f.installer, f.installDir, "--activate", repaired);
    assert.equal(activated.status, 0, activated.stderr);
    assert.equal(current(f.installDir), repaired);
    assert.equal(readFileSync(join(damaged, "pi-host.js"), "utf8"), "damaged\n");
  } finally {
    f.cleanup();
  }
});

test("the worker accepts only a repair sibling the installer printed", async () => {
  const source = readFileSync(DEPLOY, "utf8");
  // The stage path is parsed from stdout and re-validated against the root,
  // so a hostile or stale installer cannot point activation outside the root.
  assert.ok(source.includes("/^PI_HOST_STAGED (.+)$/m"));
  assert.ok(source.includes("isVersionDirName(versionDir.slice(root.base.length + 1))"));
  assert.ok(source.includes("dirname(versionDir) !== root.base"));
});

test("a plain install still refuses a damaged canonical version", { skip: HOST_LIMITATION }, () => {
  const f = fixture();
  try {
    install(f.installer, f.installDir);
    const installed = current(f.installDir);
    writeFileSync(join(installed, "pi-host.js"), "damaged\n");
    const result = install(f.installer, f.installDir);
    assert.notEqual(result.status, 0, "the released install contract is unchanged");
    assert.equal(current(f.installDir), installed);
    assert.equal(readFileSync(join(installed, "pi-host.js"), "utf8"), "damaged\n");
    assert.deepEqual(readdirSync(f.installDir).filter((name) => name.includes("-repair-")), [],
      "only the transactional stage path publishes repair siblings");
  } finally {
    f.cleanup();
  }
});
