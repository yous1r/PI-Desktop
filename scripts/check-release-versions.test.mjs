import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateReleaseVersions } from "./check-release-versions.mjs";

const script = fileURLToPath(new URL("./check-release-versions.mjs", import.meta.url));
const BETA = "1.2.3-beta.1";

function writeJson(file, value) {
  mkdirSync(file.slice(0, file.lastIndexOf("/")) || ".", { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(file, value) {
  mkdirSync(file.slice(0, file.lastIndexOf("/")) || ".", { recursive: true });
  writeFileSync(file, value);
}

/** A miniature release tree with exactly the surfaces the gate reads. */
function writeTree(root, version = BETA) {
  writeJson(join(root, "package.json"), { name: "fixture", version });
  writeJson(join(root, "docs/package.json"), { name: "@fixture/docs", version });
  writeJson(join(root, "apps/desktop/package.json"), { name: "@fixture/desktop", version });
  writeJson(join(root, "apps/pi-host/package.json"), { name: "@fixture/pi-host", version });
  writeJson(join(root, "packages/shared/package.json"), { name: "@fixture/shared", version });
  writeText(
    join(root, "packages/shared/src/protocol.ts"),
    `export const APP_VERSION = "${version}";\n`,
  );
  writeText(
    join(root, "Cargo.toml"),
    [
      "[workspace]",
      'members = ["crates/host-core"]',
      'resolver = "2"',
      "",
      "[workspace.package]",
      'edition = "2021"',
      `version = "${version}"`,
      "",
    ].join("\n"),
  );
  writeText(
    join(root, "crates/host-core/Cargo.toml"),
    ["[package]", 'name = "host-core"', "version.workspace = true", "edition.workspace = true", ""].join(
      "\n",
    ),
  );
  writeText(
    join(root, "Cargo.lock"),
    ["version = 4", "", "[[package]]", 'name = "host-core"', `version = "${version}"`, ""].join("\n"),
  );
}

function withTree(t, version = BETA) {
  const root = mkdtempSync(join(tmpdir(), "release-versions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeTree(root, version);
  return root;
}

function runCheck(root, extra = []) {
  try {
    const stdout = execFileSync("node", [script, "--root", root, ...extra], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

test("a beta workspace passes without a stable changelog or README surface", () => {
  const root = withTree(test);
  // The fixture has no changelog or README files at all: a prerelease must not
  // be blocked on stable-release documentation, which release.mjs still gates.
  const workspace = runCheck(root);
  assert.equal(workspace.code, 0, workspace.stderr);
  assert.match(workspace.stdout, new RegExp(`Release version check passed for workspace: ${BETA}`));

  const tagged = runCheck(root, ["--tag", `v${BETA}`]);
  assert.equal(tagged.code, 0, tagged.stderr);
  assert.match(tagged.stdout, new RegExp(`Release version check passed for tag v${BETA}: ${BETA}`));
});

test("a pi-host version that lags the desktop fails until it is bumped", () => {
  const root = withTree(test);
  // Baseline: the pi-host bundle names its release archive, so a stale version
  // publishes assets the desktop never downloads.
  writeJson(join(root, "apps/pi-host/package.json"), { name: "@fixture/pi-host", version: "1.2.3-beta.0" });
  const failed = runCheck(root);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /apps\/pi-host\/package\.json is 1\.2\.3-beta\.0/);

  writeJson(join(root, "apps/pi-host/package.json"), { name: "@fixture/pi-host", version: BETA });
  const repaired = runCheck(root);
  assert.equal(repaired.code, 0, repaired.stderr);
});

test("a workspace package that lags the desktop fails until it is bumped", () => {
  const root = withTree(test);
  writeJson(join(root, "packages/shared/package.json"), { name: "@fixture/shared", version: "1.2.3" });
  const failed = runCheck(root);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /packages\/shared\/package\.json is 1\.2\.3, expected/);

  writeJson(join(root, "packages/shared/package.json"), { name: "@fixture/shared", version: BETA });
  const repaired = runCheck(root);
  assert.equal(repaired.code, 0, repaired.stderr);
});

test("Cargo workspace, crate, and lockfile versions must match the desktop", () => {
  const root = withTree(test);
  const cargoToml = readFileSync(join(root, "Cargo.toml"), "utf8");

  writeText(join(root, "Cargo.toml"), cargoToml.replace(`version = "${BETA}"`, 'version = "1.2.2"'));
  const workspaceFailed = runCheck(root);
  assert.equal(workspaceFailed.code, 1);
  assert.match(workspaceFailed.stderr, /Cargo\.toml \[workspace\.package\] is 1\.2\.2/);
  writeText(join(root, "Cargo.toml"), cargoToml);
  assert.equal(runCheck(root).code, 0);

  // A crate that opts out of the workspace version creates a second source of
  // truth, so its own literal is compared too.
  const crate = join(root, "crates/host-core/Cargo.toml");
  writeText(crate, ["[package]", 'name = "host-core"', 'version = "1.2.2"', ""].join("\n"));
  const crateFailed = runCheck(root);
  assert.equal(crateFailed.code, 1);
  assert.match(crateFailed.stderr, /crates\/host-core\/Cargo\.toml is 1\.2\.2/);
  writeText(crate, ["[package]", 'name = "host-core"', "version.workspace = true", ""].join("\n"));
  assert.equal(runCheck(root).code, 0);

  const lock = join(root, "Cargo.lock");
  const lockSource = readFileSync(lock, "utf8");
  writeText(lock, lockSource.replace(`version = "${BETA}"`, 'version = "1.2.2"'));
  const lockFailed = runCheck(root);
  assert.equal(lockFailed.code, 1);
  assert.match(lockFailed.stderr, /Cargo\.lock host-core is 1\.2\.2/);
  writeText(lock, lockSource);
  assert.equal(runCheck(root).code, 0);
});

test("the in-app APP_VERSION must match the desktop version", () => {
  const root = withTree(test);
  const protocol = join(root, "packages/shared/src/protocol.ts");
  writeText(protocol, 'export const APP_VERSION = "1.2.2";\n');
  const failed = runCheck(root);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /protocol\.ts APP_VERSION is 1\.2\.2/);

  writeText(protocol, `export const APP_VERSION = "${BETA}";\n`);
  assert.equal(runCheck(root).code, 0);
});

test("the tag must equal every version surface", () => {
  const root = withTree(test);
  const mismatched = runCheck(root, ["--tag", "v2.0.0"]);
  assert.equal(mismatched.code, 1);
  assert.match(
    mismatched.stderr,
    /tag v2\.0\.0 does not match apps\/desktop\/package\.json version 1\.2\.3-beta\.1/,
  );

  const garbage = runCheck(root, ["--tag", "release-1"]);
  assert.equal(garbage.code, 1);
  assert.match(garbage.stderr, /is not v<major>\.<minor>\.<patch>/);

  const matched = runCheck(root, ["--tag", `v${BETA}`]);
  assert.equal(matched.code, 0, matched.stderr);
});

test("this repository's version surfaces agree today", () => {
  // Guards the real tree, not a fixture: a partial version bump is exactly the
  // drift this gate exists to catch.
  const result = evaluateReleaseVersions();
  assert.deepEqual(result.errors, []);
  const files = result.surfaces.map((surface) => surface.file);
  for (const expected of [
    "apps/desktop/package.json",
    "apps/pi-host/package.json",
    "Cargo.toml [workspace.package]",
    "Cargo.lock host-core",
    "packages/shared/src/protocol.ts APP_VERSION",
  ]) {
    assert.ok(files.includes(expected), `${expected} is not checked`);
  }
  const desktop = result.surfaces.find((surface) => surface.file === "apps/desktop/package.json");
  const piHost = result.surfaces.find((surface) => surface.file === "apps/pi-host/package.json");
  assert.equal(piHost.version, desktop.version, "desktop and pi-host ship the same version");
  // Every kernel-visible version is the tagged one, prerelease included.
  assert.match(result.desktopVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
});
