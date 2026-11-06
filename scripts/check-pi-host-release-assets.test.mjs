import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { DEFAULT_TARGETS, readTarArchive } from "./check-pi-host-release-assets.mjs";

const script = fileURLToPath(new URL("./check-pi-host-release-assets.mjs", import.meta.url));
const version = "0.22.1-beta.6";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

/** One ustar record, as `tar -czf` writes it. */
function tarEntry(name, { content = "", mode = 0o644, type = "0" } = {}) {
  const data = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 100, "utf8");
  header.write(octal(mode, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii");
  header.write(octal(0, 8), 116, 8, "ascii");
  header.write(octal(data.length, 12), 124, 12, "ascii");
  header.write(octal(0, 12), 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}

function gzipTar(entries) {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

/** A release directory: one archive + named sidecar per target, plus feeds. */
function makeRelease(t) {
  const directory = mkdtempSync(join(tmpdir(), "pi-host-assets-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeTarget(directory, target, options = {}) {
  const rootName = options.rootName ?? `pi-host-${version}-${target}`;
  const archiveName = options.archiveName ?? `pi-host-${version}-${target}.tar.gz`;
  const manifest = options.manifest ?? { name: "pi-host", version, type: "module" };
  const entries = [
    tarEntry(`${rootName}/`, { type: "5" }),
    tarEntry(`${rootName}/bin/pi-desktop-host-core`, { content: "host-core\n", mode: 0o755 }),
    tarEntry(`${rootName}/package.json`, { content: `${JSON.stringify(manifest, null, 2)}\n` }),
    ...(options.extraEntries ?? []),
  ];
  const bytes = gzipTar(entries);
  writeFileSync(join(directory, archiveName), bytes);
  const sidecarLeaf = options.sidecarLeaf ?? archiveName;
  const digest = options.digest ?? sha256(bytes);
  writeFileSync(join(directory, `${archiveName}.sha256`), `${digest}  ${sidecarLeaf}\n`);
  return bytes;
}

function writeFeeds(directory, feedVersion = version) {
  for (const name of ["latest-linux.yml", "latest-linux-arm64.yml", "latest-mac.yml"]) {
    writeFileSync(
      join(directory, name),
      `version: ${feedVersion}\nfiles:\n  - url: PI-Desktop-${feedVersion}-x64.AppImage\n`,
    );
  }
}

function runGate(directory, extra = []) {
  try {
    const stdout = execFileSync(
      "node",
      [script, "--dir", directory, "--version", version, ...extra],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

test("a complete release passes the publication gate", (t) => {
  const directory = makeRelease(t);
  for (const target of DEFAULT_TARGETS) writeTarget(directory, target);
  writeFeeds(directory);

  const result = runGate(directory);
  assert.equal(result.code, 0, result.stderr);
  for (const target of DEFAULT_TARGETS) {
    assert.match(result.stdout, new RegExp(`pi-host-${version}-${target}\\.tar\\.gz sha256`));
  }
  assert.match(result.stdout, /updater feed latest-linux\.yml/);
});

test("a pi-host archive built for another version fails until it is rebuilt", (t) => {
  const directory = makeRelease(t);
  // Baseline: the pi-host job packaged 0.22.0, so the tag's own archives are
  // absent and the desktop's bootstrap URL would 404.
  const staleVersion = "0.22.0";
  for (const target of DEFAULT_TARGETS) {
    writeTarget(directory, target, {
      rootName: `pi-host-${staleVersion}-${target}`,
      archiveName: `pi-host-${staleVersion}-${target}.tar.gz`,
      manifest: { name: "pi-host", version: staleVersion, type: "module" },
    });
  }
  writeFeeds(directory);
  const failed = runGate(directory);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, new RegExp(`pi-host-${version}-linux-x64\\.tar\\.gz is missing`));
  assert.match(failed.stderr, new RegExp(`pi-host-${version}-linux-arm64\\.tar\\.gz is missing`));

  rmSync(join(directory, `pi-host-${staleVersion}-linux-x64.tar.gz`));
  rmSync(join(directory, `pi-host-${staleVersion}-linux-x64.tar.gz.sha256`));
  rmSync(join(directory, `pi-host-${staleVersion}-linux-arm64.tar.gz`));
  rmSync(join(directory, `pi-host-${staleVersion}-linux-arm64.tar.gz.sha256`));
  for (const target of DEFAULT_TARGETS) writeTarget(directory, target);
  const repaired = runGate(directory);
  assert.equal(repaired.code, 0, repaired.stderr);
});

test("a release missing one pi-host architecture fails until both exist", (t) => {
  const directory = makeRelease(t);
  writeTarget(directory, "linux-x64");
  writeFeeds(directory);

  const failed = runGate(directory);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, new RegExp(`pi-host-${version}-linux-arm64\\.tar\\.gz is missing`));
  assert.doesNotMatch(failed.stderr, /linux-x64\.tar\.gz is missing/);

  writeTarget(directory, "linux-arm64");
  const repaired = runGate(directory);
  assert.equal(repaired.code, 0, repaired.stderr);
});

test("a sidecar whose digest does not match the archive fails until it is rewritten", (t) => {
  const directory = makeRelease(t);
  for (const target of DEFAULT_TARGETS) writeTarget(directory, target);
  writeFeeds(directory);

  writeTarget(directory, "linux-x64", { digest: "0".repeat(64) });
  const failed = runGate(directory);
  assert.equal(failed.code, 1);
  assert.match(
    failed.stderr,
    new RegExp(`pi-host-${version}-linux-x64\\.tar\\.gz\\.sha256 records 0{64} but .* hashes to`),
  );

  writeTarget(directory, "linux-x64");
  const repaired = runGate(directory);
  assert.equal(repaired.code, 0, repaired.stderr);
});

test("a sidecar that names another artifact fails until it names its own archive", (t) => {
  const directory = makeRelease(t);
  for (const target of DEFAULT_TARGETS) writeTarget(directory, target);
  writeFeeds(directory);

  writeTarget(directory, "linux-arm64", {
    sidecarLeaf: `pi-host-${version}-linux-x64.tar.gz`,
  });
  const failed = runGate(directory);
  assert.equal(failed.code, 1);
  assert.match(
    failed.stderr,
    new RegExp(
      `pi-host-${version}-linux-arm64\\.tar\\.gz\\.sha256 names "pi-host-${version}-linux-x64\\.tar\\.gz"`,
    ),
  );

  writeTarget(directory, "linux-arm64");
  const repaired = runGate(directory);
  assert.equal(repaired.code, 0, repaired.stderr);
});

test("a bundle whose archive root carries another version fails until it is renamed", (t) => {
  const directory = makeRelease(t);
  for (const target of DEFAULT_TARGETS) writeTarget(directory, target);
  writeFeeds(directory);

  // Misnamed package: the tarball is published under the tag name but unpacks
  // to a directory the bootstrap script does not expect.
  writeTarget(directory, "linux-x64", { rootName: "pi-host-0.22.0-linux-x64" });
  const failed = runGate(directory);
  assert.equal(failed.code, 1);
  assert.match(
    failed.stderr,
    new RegExp(
      `pi-host-${version}-linux-x64\\.tar\\.gz unpacks to "pi-host-0\\.22\\.0-linux-x64", ` +
        `expected the "pi-host-${version}-linux-x64" bundle root`,
    ),
  );

  writeTarget(directory, "linux-x64");
  const repaired = runGate(directory);
  assert.equal(repaired.code, 0, repaired.stderr);
});

test("a bundle manifest of another product or version fails until it matches", (t) => {
  const directory = makeRelease(t);
  for (const target of DEFAULT_TARGETS) writeTarget(directory, target);
  writeFeeds(directory);

  writeTarget(directory, "linux-arm64", {
    manifest: { name: "pi-desktop", version, type: "module" },
  });
  const renamed = runGate(directory);
  assert.equal(renamed.code, 1);
  assert.match(renamed.stderr, /package\.json names "pi-desktop", expected "pi-host"/);

  writeTarget(directory, "linux-arm64", {
    manifest: { name: "pi-host", version: "0.22.0", type: "module" },
  });
  const stale = runGate(directory);
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /package\.json version "0\.22\.0" does not match 0\.22\.1-beta\.6/);

  writeTarget(directory, "linux-arm64");
  const repaired = runGate(directory);
  assert.equal(repaired.code, 0, repaired.stderr);
});

test("an archive entry outside the bundle root fails until the archive is rebuilt", (t) => {
  const directory = makeRelease(t);
  for (const target of DEFAULT_TARGETS) writeTarget(directory, target);
  writeFeeds(directory);

  writeTarget(directory, "linux-x64", {
    extraEntries: [tarEntry("package.json", { content: "{}\n" })],
  });
  const failed = runGate(directory);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /contains "package\.json" outside the ".*\/" bundle root/);

  writeTarget(directory, "linux-x64");
  const repaired = runGate(directory);
  assert.equal(repaired.code, 0, repaired.stderr);
});

test("an updater feed for another version fails until the feed matches the tag", (t) => {
  const directory = makeRelease(t);
  for (const target of DEFAULT_TARGETS) writeTarget(directory, target);
  writeFeeds(directory);

  writeFileSync(join(directory, "latest-linux-arm64.yml"), "version: 9.9.9\nfiles: []\n");
  const failed = runGate(directory);
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /latest-linux-arm64\.yml publishes version 9\.9\.9, expected/);

  writeFeeds(directory);
  const repaired = runGate(directory);
  assert.equal(repaired.code, 0, repaired.stderr);
});

function hasSystemTar() {
  try {
    execFileSync("tar", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test(
  "the gate reads the archive format the release pipeline produces",
  { skip: hasSystemTar() ? false : "no system tar available" },
  async (t) => {
    const directory = makeRelease(t);
    const target = "linux-x64";
    const root = `pi-host-${version}-${target}`;
    const staging = join(directory, "staging");
    mkdirSync(join(staging, root, "bin"), { recursive: true });
    writeFileSync(
      join(staging, root, "package.json"),
      `${JSON.stringify({ name: "pi-host", version, type: "module" }, null, 2)}\n`,
    );
    writeFileSync(join(staging, root, "bin/pi-desktop-host-core"), "host-core\n");
    const archiveName = `${root}.tar.gz`;
    // GNU tar on Windows reads an absolute `C:\...` argument as a remote host,
    // so the fixture passes relative paths and anchors them with `cwd`.
    execFileSync("tar", ["-czf", archiveName, "-C", "staging", root], {
      cwd: directory,
      stdio: "ignore",
    });
    const bytes = readFileSync(join(directory, archiveName));
    writeFileSync(join(directory, `${archiveName}.sha256`), `${sha256(bytes)}  ${archiveName}\n`);
    writeFeeds(directory);

    // The streaming reader agrees with GNU tar about the root and the manifest.
    const listing = await readTarArchive(join(directory, archiveName));
    assert.equal(listing.entries[0].name, `${root}/`);
    // GNU tar also records the intermediate `bin/` directory.
    assert.ok(listing.entries.length >= 3, "every archived entry is listed");
    assert.ok(
      listing.entries.some((entry) => entry.name === `${root}/bin/pi-desktop-host-core`),
      "the host-core binary is inside the bundle root",
    );
    const manifest = JSON.parse(listing.files.get(`${root}/package.json`).toString("utf8"));
    assert.equal(manifest.version, version);

    const result = runGate(directory, ["--targets", target]);
    assert.equal(result.code, 0, result.stderr);
  },
);

test("the workflow gates run before publication and track the published targets", async () => {
  const releaseWorkflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const piHostRelease = readFileSync(
    new URL("../apps/desktop/electron/main/remote/pi-host-release.ts", import.meta.url),
    "utf8",
  );

  // The gate's default target list is the desktop's release contract.
  const publishedTargets = [
    ...(piHostRelease.match(/PUBLISHED_TARGETS[^=]*=\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(
      /"([^"]+)"/g,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(DEFAULT_TARGETS, publishedTargets);

  // Version parity runs on the tagged tree before anything is built ...
  assert.match(releaseWorkflow, /- name: Check release version surfaces\n/);
  assert.match(releaseWorkflow, /node scripts\/check-release-versions\.mjs --tag "\$RELEASE_TAG"/);
  // ... and on every pull request, so drift fails before a tag exists.
  assert.match(ciWorkflow, /run: node scripts\/check-release-versions\.mjs\n/);
  assert.match(
    ciWorkflow,
    /node --test scripts\/check-release-versions\.test\.mjs scripts\/check-pi-host-release-assets\.test\.mjs/,
  );

  // The asset gate is a publish-job step that runs before the release exists.
  const publishJob = releaseWorkflow.match(/^  publish:\n[\s\S]*$/m)?.[0] ?? "";
  const gate = publishJob.indexOf("node scripts/check-pi-host-release-assets.mjs");
  const publish = publishJob.indexOf("uses: softprops/action-gh-release@v3");
  assert.ok(gate > 0, "the publish job verifies the assets");
  assert.ok(publish > gate, "the asset gate runs before the GitHub Release is created");
  assert.match(publishJob, /--version "\$\{GITHUB_REF_NAME#v\}"/);
  assert.match(publishJob, /--targets linux-x64,linux-arm64/);
  // The gate needs the tagged scripts, and only the publish job may write.
  assert.match(publishJob, /- uses: actions\/checkout@v7/);
  assert.match(publishJob, /^    permissions:\n      contents: write$/m);
});
