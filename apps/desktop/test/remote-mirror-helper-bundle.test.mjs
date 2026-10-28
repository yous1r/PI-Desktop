import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
const importedTypeScript = await import(process.env.PI_DESKTOP_TEST_TYPESCRIPT ?? "typescript");
const ts = importedTypeScript.default ?? importedTypeScript;
const nodeRequire = createRequire(import.meta.url);

const sourcePath = new URL("../electron/main/mirror/helper-bundle.ts", import.meta.url);
const source = await readFile(sourcePath, "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const module = { exports: {} };
vm.runInNewContext(outputText, {
  module,
  exports: module.exports,
  require: nodeRequire,
  process,
  Buffer,
  console,
  setTimeout,
  clearTimeout,
  URL,
});
const { helperTargetFromRemote, parseHelperManifest, resolveBundledHelper } = module.exports;
const digest = (contents) => createHash("sha256").update(contents).digest("hex");
const bootstrapSource = await readFile(new URL("../electron/main/mirror/helper-bootstrap.ts", import.meta.url), "utf8");
const { outputText: bootstrapOutputText } = ts.transpileModule(bootstrapSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const bootstrapModule = { exports: {} };
const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
const bootstrapRequire = (specifier) => specifier === "../remote/pi-host-bootstrap-script.js"
  ? { shellQuote }
  : nodeRequire(specifier);
vm.runInNewContext(bootstrapOutputText, {
  module: bootstrapModule,
  exports: bootstrapModule.exports,
  require: bootstrapRequire,
  process,
  Buffer,
  console,
  URL,
});
const { buildHelperBootstrapScript, deployBundledHelper, parseHelperReady } = bootstrapModule.exports;

 test("maps only supported Linux architectures to bundled musl targets", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(helperTargetFromRemote("Linux", "x86_64"))), {
    target: "x86_64-unknown-linux-musl",
    arch: "x64",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(helperTargetFromRemote("Linux", "aarch64"))), {
    target: "aarch64-unknown-linux-musl",
    arch: "arm64",
  });
  assert.equal(helperTargetFromRemote("Darwin", "arm64"), null);
  assert.equal(helperTargetFromRemote("Linux", "i686"), null);
});

test("rejects helper manifests with wrong target, version, filename, or digest", () => {
  const target = { target: "x86_64-unknown-linux-musl", arch: "x64" };
  const manifest = {
    schemaVersion: 1,
    version: "0.22.0-beta.1",
    target: target.target,
    arch: target.arch,
    file: "pi-helper-linux-x64",
    sha256: "a".repeat(64),
  };
  assert.equal(parseHelperManifest(manifest, target, manifest.version).sha256, manifest.sha256);
  for (const invalid of [
    { ...manifest, version: "0.0.1" },
    { ...manifest, target: "aarch64-unknown-linux-musl" },
    { ...manifest, file: "../../outside" },
    { ...manifest, sha256: "not-a-digest" },
    null,
  ]) {
    assert.throws(() => parseHelperManifest(invalid, target, manifest.version));
  }
});

test("loads only a bundle whose bytes match its manifest digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-helper-bundle-test-"));
  try {
    const resourcesPath = join(directory, "resources");
    const helperDirectory = join(resourcesPath, "pi-helper");
    await mkdir(helperDirectory, { recursive: true });
    const binary = Buffer.from([0, 255, 1, 2, 3]);
    const manifest = {
      schemaVersion: 1,
      version: "0.22.0-beta.1",
      target: "x86_64-unknown-linux-musl",
      arch: "x64",
      file: "pi-helper-linux-x64",
      sha256: digest(binary),
    };
    await writeFile(join(helperDirectory, manifest.file), binary);
    await writeFile(join(helperDirectory, `${manifest.file}.manifest.json`), JSON.stringify(manifest));

    const resolved = await resolveBundledHelper(
      { target: manifest.target, arch: manifest.arch },
      { resourcesPath, desktopVersion: manifest.version },
    );
    assert.equal(resolved.manifest.sha256, digest(binary));

    await writeFile(join(helperDirectory, manifest.file), Buffer.from("tampered"));
    await assert.rejects(
      resolveBundledHelper(
        { target: manifest.target, arch: manifest.arch },
        { resourcesPath, desktopVersion: manifest.version },
      ),
      /SHA-256/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("helper bootstrap uploads once, verifies the bundle, and starts only the fixed helper command", async () => {
  const token = "c".repeat(64);
  const readyLine = [
    `PI_HELPER_READY ${JSON.stringify({ port: 43127, version: "0.22.0-beta.1", protocol: 1 })}`,
    `PI_HELPER_TOKEN ${token}`,
  ].join("\n");
  const calls = [];
  const artifact = {
    path: "C:/bundle/pi-helper-linux-x64",
    manifest: {
      schemaVersion: 1,
      version: "0.22.0-beta.1",
      target: "x86_64-unknown-linux-musl",
      arch: "x64",
      file: "pi-helper-linux-x64",
      sha256: "b".repeat(64),
    },
  };
  const result = await deployBundledHelper({
    transport: {
      execWithFile: async (command, path, options) => {
        calls.push({ command, path, options });
        return { stdout: readyLine, stderr: "", code: 0 };
      },
    },
    artifact,
    desktopVersion: "0.22.0-beta.1",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { port: 43127, version: "0.22.0-beta.1", protocol: 1, token });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, artifact.path);
  assert.equal(calls[0].options.timeoutMs, 90_000);
  assert.match(calls[0].command, /sh -c/);
  assert.match(calls[0].command, /sha256sum/);
  assert.ok(calls[0].command.includes('cat > "$stage"'));
  assert.match(calls[0].command, /nohup.*serve --root.*--port 0/s);
  assert.doesNotMatch(calls[0].command, /curl|wget|rsync/);
});

test("helper ready parsing requires a matching version and one valid protocol line", () => {
  const token = "d".repeat(64);
  const readyLine = (version) => [
    `PI_HELPER_READY ${JSON.stringify({ port: 23001, version, protocol: 1 })}`,
    `PI_HELPER_TOKEN ${token}`,
  ].join("\n");
  const ready = parseHelperReady(readyLine("0.22.0-beta.1"), "0.22.0-beta.1");
  assert.deepEqual(JSON.parse(JSON.stringify(ready)), { port: 23001, version: "0.22.0-beta.1", protocol: 1, token });
  assert.throws(() => parseHelperReady("PI_HELPER_READY {}", "0.22.0-beta.1"), (error) => error.errorCode === "HELPER_START_FAILED");
  assert.throws(() => parseHelperReady(readyLine("0.22.0"), "0.22.0-beta.1"), (error) => error.errorCode === "HELPER_VERSION_MISMATCH");
  assert.throws(() => parseHelperReady(`noise\n${readyLine("0.22.0-beta.1")}`, "0.22.0-beta.1"), (error) => error.errorCode === "HELPER_START_FAILED");
});