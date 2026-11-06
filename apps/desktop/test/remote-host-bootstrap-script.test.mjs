import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { buildBootstrapScript, parseBootstrapOutput, redactBootstrapOutput, shellQuote } = await import(
  "../electron/main/remote/pi-host-bootstrap-script.ts"
);

const VERSION = "0.15.1-beta.5";
const BUNDLE_DIR = `pi-host-${VERSION}-linux-x64`;
const ARTIFACT_NAME = `${BUNDLE_DIR}.tar.gz`;
const ARTIFACT_URL = `https://github.com/yous1r/PI-Desktop/releases/download/v${VERSION}/${ARTIFACT_NAME}`;
const DIGEST = "0123456789abcdef".repeat(4);
const UPLOADED = "/home/user/.pi-desktop/pi-host/.upload.abc123/artifact.tar.gz";

/**
 * The generated script targets Linux and requires `flock`. Windows/MSYS has no
 * `flock`, so the runtime fail-closed cases can only run on the product host.
 */
const NO_FLOCK = process.platform === "win32"
  ? "the generated script requires Linux flock, which this test host does not provide"
  : false;

/** Inputs every scenario starts from; callers override individual fields. */
function scriptInput(overrides = {}) {
  return {
    version: VERSION,
    artifactUrl: ARTIFACT_URL,
    artifactName: ARTIFACT_NAME,
    bundleDir: BUNDLE_DIR,
    expectedSha256: DIGEST,
    artifactPath: UPLOADED,
    port: 0,
    pairingLifetimeMs: 600_000,
    readyTimeoutSec: 30,
    ...overrides,
  };
}

async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("shellQuote produces a single-quoted literal that cannot escape", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  // The one character a single-quoted string cannot contain ends the literal,
  // emits an escaped quote, and reopens it — the POSIX `'\''` dance.
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  // Command substitution and variable expansion are inert inside quotes; a
  // caller-supplied URL must never execute.
  assert.equal(shellQuote("$(touch /tmp/pwned)"), "'$(touch /tmp/pwned)'");
});

test("the script interpolates every input as a quoted shell literal", () => {
  const script = buildBootstrapScript(scriptInput());
  assert.ok(script.startsWith("#!/bin/sh\n"), "the script is uploaded and run by `sh`");
  for (const [name, value] of Object.entries({
    VERSION,
    ARTIFACT_URL,
    ARTIFACT_NAME,
    BUNDLE_DIR,
    EXPECTED_SHA256: DIGEST,
    ARTIFACT_PATH: UPLOADED,
    PORT: "0",
    PAIRING_LIFETIME_MS: "600000",
    READY_TIMEOUT_SEC: "30",
    ALLOW_LEGACY_MAINTENANCE: "false",
    PRESERVE_PAIRING: "false",
    EXPECTED_DEVICE_TOKEN_HASH: "",
  })) {
    assert.ok(script.includes(`${name}='${value}'`), `${name} must be a quoted assignment`);
  }
  // Optional identity inputs are present but empty until an upgrade pins them.
  assert.ok(script.includes("EXISTING_HOST_ID=''"));
  assert.ok(script.includes("EXPECTED_CURRENT_VERSION=''"));
  assert.ok(script.includes("EXPECTED_DEVICE_TOKEN_HASH=''"));
  // Every `${…}` that reaches the shell must be deliberate.
  const interpolations = [...script.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1]);
  assert.deepEqual(interpolations, ["HOME:-", "#EXPECTED_SHA256", "#transaction_id"]);
});

test("the upgrade identity inputs are interpolated from the new fields", () => {
  const script = buildBootstrapScript(
    scriptInput({
      existingHostId: "host_abc",
      expectedCurrentVersion: "0.15.0",
      allowLegacyMaintenance: true,
      preservePairing: true,
      expectedDeviceTokenHash: "c".repeat(64),
    }),
  );
  assert.ok(script.includes("EXISTING_HOST_ID='host_abc'"));
  assert.ok(script.includes("EXPECTED_CURRENT_VERSION='0.15.0'"));
  assert.ok(script.includes("ALLOW_LEGACY_MAINTENANCE='true'"));
  assert.ok(script.includes("PRESERVE_PAIRING='true'"));
  assert.ok(script.includes(`EXPECTED_DEVICE_TOKEN_HASH='${"c".repeat(64)}'`));
  assert.ok(script.includes("PI_TX_EXPECTED_DEVICE_TOKEN_HASH"));
  assert.ok(!script.includes("ppt1."), "only the token hash is interpolated");
});

test("the generated script never downloads executable bytes on the remote host", () => {
  const script = buildBootstrapScript(scriptInput());
  // Desktop uploads the exact checksum-verified archive; the remote verifies
  // it locally and refuses to continue without it.
  assert.ok(script.includes("upload-required"));
  assert.ok(!/\bcurl\b/.test(script), "no remote HTTP client may appear in the script");
  assert.ok(!/\bwget\b/.test(script));
  assert.ok(!script.includes("ARTIFACT_URL=\"$"), "the artifact URL is diagnostic only");
  assert.ok(script.includes('case "$ARTIFACT_PATH" in "$base"/.upload.*/artifact.tar.gz)'));
});

test("the generated script refuses to start while a previous deployment is unresolved", () => {
  const script = buildBootstrapScript(scriptInput());
  assert.ok(script.includes("HOST_RECOVERY_REQUIRED"));
  assert.ok(/deployment-state\.json/.test(script));
  // Only a finished or safely-failed record may be replaced by a new attempt.
  assert.ok(script.includes("complete|failed-safe"));
});

test("the generated script is valid POSIX shell, even with hostile inputs", async () => {
  const { dir, cleanup } = await tempDir("pi-host-script-syntax-");
  try {
    const plain = join(dir, "plain.sh");
    await writeFile(plain, buildBootstrapScript(scriptInput()));
    execFileSync("sh", ["-n", plain]);

    // Quoting is the only thing standing between a caller-supplied host or
    // label and the remote shell, so the syntax check runs on those too.
    const hostile = join(dir, "hostile.sh");
    await writeFile(
      hostile,
      buildBootstrapScript(
        scriptInput({
          version: "1.0.0'; touch \"$HOME/pwned\"; echo '",
          artifactUrl: "https://example.invalid/a'b",
          artifactName: "a b'c.tar.gz",
          bundleDir: "d'est",
          existingHostId: "host'; rm -rf $HOME; echo '",
          expectedCurrentVersion: "1.0.0`id`",
          expectedDeviceTokenHash: "x'; rm -rf $HOME; echo '",
        }),
      ),
    );
    execFileSync("sh", ["-n", hostile]);
  } finally {
    await cleanup();
  }
});

test("a hostile version stays one literal value when the assignments run", async () => {
  const { dir, cleanup } = await tempDir("pi-host-script-quote-");
  try {
    const hostileVersion = "1.0.0'; touch \"$HOME/pwned\"; echo '";
    const script = buildBootstrapScript(scriptInput({ version: hostileVersion }));
    const assignments = script.split("\n").filter((line) => /^[A-Z_]+='/.test(line));
    assert.ok(
      assignments.some((line) => line.startsWith("VERSION=")),
      "the assignment block must be visible to this test",
    );

    const echoed = execFileSync("sh", ["-c", `${assignments.join("\n")}\nprintf '%s' "$VERSION"`], {
      encoding: "utf8",
      env: { ...process.env, HOME: dir },
    });
    assert.equal(echoed, hostileVersion);
    assert.equal(existsSync(join(dir, "pwned")), false, "the injected command must not have run");
  } finally {
    await cleanup();
  }
});

test("the generated script fails closed without an uploaded artifact", { skip: NO_FLOCK }, async () => {
  const { dir, cleanup } = await tempDir("pi-host-script-upload-");
  try {
    const scriptPath = join(dir, "bootstrap.sh");
    await writeFile(scriptPath, buildBootstrapScript(scriptInput({ artifactPath: undefined })));
    let failure;
    try {
      execFileSync("sh", [scriptPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: dir },
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "the script must exit non-zero");
    assert.match(String(failure.stderr), /PI_HOST_BOOTSTRAP_FAILED upload-required/);
  } finally {
    await cleanup();
  }
});

test("the generated script fails closed on a malformed digest before extraction", { skip: NO_FLOCK }, async () => {
  const { dir, cleanup } = await tempDir("pi-host-script-digest-");
  try {
    const scriptPath = join(dir, "bootstrap.sh");
    await writeFile(scriptPath, buildBootstrapScript(scriptInput({ expectedSha256: "not-a-digest" })));
    let failure;
    try {
      execFileSync("sh", [scriptPath], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: dir },
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, "the script must exit non-zero");
    assert.match(String(failure.stderr), /invalid-checksum/);
  } finally {
    await cleanup();
  }
});

test("parseBootstrapOutput reads the ready and pairing lines", () => {
  const output = parseBootstrapOutput(
    [
      "PI_HOST_BOOTSTRAP verify",
      'PI_HOST_READY {"hostId":"host_x","host":"127.0.0.1","port":41234,"version":"0.15.1-beta.5"}',
      'PI_HOST_PAIRING_TOKEN {"token":"ppt1.abc","expiresAt":123}',
      "PI_HOST_DEPLOYMENT_TRANSACTION 0123456789abcdef0123456789abcdef",
      "PI_HOST_BOOTSTRAP ready",
    ].join("\n"),
  );
  assert.deepEqual(output.ready, {
    hostId: "host_x",
    host: "127.0.0.1",
    port: 41234,
    version: "0.15.1-beta.5",
  });
  assert.deepEqual(output.pairing, { token: "ppt1.abc", expiresAt: 123 });
  assert.deepEqual(output.steps, ["verify", "ready"]);
  assert.equal(output.transactionId, "0123456789abcdef0123456789abcdef");
  assert.equal(output.failure, null);
});

test("a preserved-pairing restart reports readiness without a pairing token", () => {
  const output = parseBootstrapOutput(
    [
      'PI_HOST_READY {"hostId":"host_x","host":"127.0.0.1","port":41234,"version":"0.15.1"}',
      "PI_HOST_DEPLOYMENT_TRANSACTION 0123456789abcdef0123456789abcdef",
      "PI_HOST_BOOTSTRAP ready",
    ].join("\n"),
  );
  assert.equal(output.failure, null);
  assert.equal(output.pairing, null);
  assert.equal(output.ready?.hostId, "host_x");
  assert.equal(output.transactionId, "0123456789abcdef0123456789abcdef");
});

test("parseBootstrapOutput collects step lines and ignores interleaved noise", () => {
  const output = parseBootstrapOutput(
    [
      "Warning: Permanently added 'host' (ED25519) to the list of known hosts.",
      "PI_HOST_BOOTSTRAP verify",
      "",
      "PI_HOST_BOOTSTRAP   stage  ",
      "some other chatter",
      "PI_HOST_BOOTSTRAP deploy",
    ].join("\n"),
  );
  assert.deepEqual(output.steps, ["verify", "stage", "deploy"]);
  assert.equal(output.ready, null);
  assert.equal(output.pairing, null);
});

test("parseBootstrapOutput reports the failing step and ignores unrelated failures", () => {
  const busy = parseBootstrapOutput('PI_HOST_BOOTSTRAP_FAILED HOST_BUSY\nPI_HOST_FAILED {"code":"HOST_BUSY","step":"HOST_BUSY"}');
  assert.equal(busy.failure, "HOST_BUSY");

  // The bootstrap's own typed line keeps the legacy `step` extraction.
  const timedOut = parseBootstrapOutput(
    ['PI_HOST_BOOTSTRAP await-ready', 'PI_HOST_FAILED {"code":"HOST_BOOTSTRAP_FAILED","step":"ready-timeout"}'].join("\n"),
  );
  assert.equal(timedOut.failure, "ready-timeout");

  // The first failure wins.
  const mismatch = parseBootstrapOutput(
    ["PI_HOST_BOOTSTRAP_FAILED checksum-mismatch", "PI_HOST_BOOTSTRAP_FAILED deployment-failed"].join("\n"),
  );
  assert.equal(mismatch.failure, "checksum-mismatch");

  assert.equal(parseBootstrapOutput("PI_HOST_FAILED {not json").failure, null);
  assert.equal(parseBootstrapOutput("PI_HOST_DEPLOYMENT_TRANSACTION not-a-transaction").transactionId, undefined);
});

test("parseBootstrapOutput refuses a ready line with an unusable port", () => {
  const ready = (payload) => parseBootstrapOutput(`PI_HOST_READY ${JSON.stringify(payload)}`);
  const valid = { hostId: "host_x", host: "127.0.0.1", port: 41234, version: "0.15.1" };
  assert.equal(ready({ ...valid, port: 0 }).ready, null, "port 0 means the host never bound");
  assert.equal(ready({ ...valid, port: 41234.5 }).ready, null, "a fractional port is not a port");
  assert.equal(ready({ ...valid, port: "41234" }).ready, null, "a string port is not a port");
  assert.equal(ready({ ...valid, hostId: "" }).ready, null);
  assert.equal(ready({ ...valid, port: 65536 }).ready, null);
  assert.equal(ready({ ...valid, host: "0.0.0.0" }).ready, null);
  assert.equal(ready({ ...valid, host: "example.com" }).ready, null);
  assert.equal(parseBootstrapOutput("PI_HOST_READY {not json").ready, null);

  // The pairing line tolerates a missing expiry rather than dropping the token.
  const pairing = parseBootstrapOutput('PI_HOST_PAIRING_TOKEN {"token":"ppt1.abc"}');
  assert.deepEqual(pairing.pairing, { token: "ppt1.abc", expiresAt: 0 });
  assert.equal(parseBootstrapOutput('PI_HOST_PAIRING_TOKEN {"expiresAt":1}').pairing, null);
});

test("redactBootstrapOutput removes a live pairing token from diagnostics", () => {
  const redacted = redactBootstrapOutput(
    [
      'PI_HOST_READY {"hostId":"host_x","host":"127.0.0.1","port":1,"version":"1"}',
      'PI_HOST_PAIRING_TOKEN {"token":"{{SECRET_live}}","expiresAt":1}',
    ].join("\n"),
  );
  assert.ok(!redacted.includes("{{SECRET_live}}"));
  assert.match(redacted, /^PI_HOST_PAIRING_TOKEN <redacted>$/m);
});

test("the generated script is a stable artifact for identical inputs", () => {
  assert.equal(buildBootstrapScript(scriptInput()), buildBootstrapScript(scriptInput()));
  const script = buildBootstrapScript(scriptInput());
  // The transaction record contract the desktop and supervisor share.
  for (const phase of ["complete|failed-safe", "awaiting-racp", "PI_HOST_DEPLOYMENT_TRANSACTION"]) {
    assert.ok(script.includes(phase), `${phase} must be part of the generated contract`);
  }
  assert.ok(!script.includes("ps -p"), "process identity is decided by the worker, not `ps` output");
});
