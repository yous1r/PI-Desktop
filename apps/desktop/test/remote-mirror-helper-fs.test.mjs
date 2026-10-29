/**
 * Root scoping of the desktop helper client and the helper environment manifest.
 *
 * Every file operation must name the canonical mirror root the helper returned
 * from `root.register`; the helper refuses anything else and never resolves a
 * file operation into its own directory. `env.json` is host state, so it is
 * written over SSH into the helper directory rather than through `fs.put`.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import test from "node:test";

// Main-process sources use bundler-style `.js` specifiers that only exist as
// `.ts` on disk; the shared hook resolves them for `node --test`.
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { createHelperFs, registerHelperRoot, validateProjectRoot } = await import(
  "../electron/main/mirror/helper-fs.ts"
);
const { writeHelperEnvManifest } = await import("../electron/main/mirror/helper-bootstrap.ts");

const ROOT = "/srv/projects/app";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A client that records every request and answers streams immediately. */
function recordingClient(answers = {}) {
  const requests = [];
  const streams = [];
  let nextStream = 1;
  return {
    requests,
    streams,
    async request(op, params = {}) {
      requests.push({ op, params });
      const answer = answers[op];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(params) : (answer ?? {});
    },
    beginStream({ op, params, onData }) {
      const streamId = nextStream++;
      streams.push({ op, params });
      const response =
        op === "fs.get.begin"
          ? Promise.resolve({ streamId, size: 3 })
          : Promise.resolve({ path: params.path, size: params.size, sha256: params.sha256 });
      const completed = (async () => {
        if (op === "fs.get.begin") await onData(Buffer.from("abc"));
      })();
      return { streamId, response, completed };
    },
    async writeStreamData() {},
    async writeStreamEnd() {},
    closeStream() {},
    abandonStream() {},
    close() {},
  };
}

test("every file operation names the registered mirror root", async () => {
  const client = recordingClient({
    "fs.stat": { entries: [{ path: "bin/run.sh", exists: false }] },
    "fs.hash": { sha256: "a".repeat(64) },
    "fs.mkdirs": { paths: ["bin"] },
  });
  const fs = createHelperFs(client, ROOT);

  await fs.stat(["bin/run.sh"]);
  await fs.hash("bin/run.sh");
  await fs.mkdirs("bin");
  await fs.putFile("bin/run.sh", Buffer.from("#!/bin/sh\n"));
  const chunks = [];
  await fs.getFile("bin/run.sh", (bytes) => chunks.push(bytes));

  assert.deepEqual(
    client.requests.map(({ op, params }) => [op, params.root]),
    [
      ["fs.stat", ROOT],
      ["fs.hash", ROOT],
      ["fs.mkdirs", ROOT],
    ],
  );
  assert.deepEqual(
    client.streams.map(({ op, params }) => [op, params.root, params.path]),
    [
      ["fs.put.begin", ROOT, "bin/run.sh"],
      ["fs.get.begin", ROOT, "bin/run.sh"],
    ],
  );
  assert.equal(Buffer.concat(chunks).toString(), "abc");
});

test("a helper fs cannot be built on a root the host could misread", () => {
  for (const root of ["", "srv/app", "/srv/../etc", "C:\\srv", "/srv\0/app", 42, null]) {
    assert.throws(() => createHelperFs(recordingClient(), root), { errorCode: "INVALID_ARGUMENT" }, String(root));
  }
  assert.equal(validateProjectRoot("/srv/app.v2/..data"), "/srv/app.v2/..data");
});

test("root registration returns the helper's canonical root and refuses a malformed answer", async () => {
  const client = recordingClient({ "root.register": { root: "/data/projects/app" } });
  assert.equal(await registerHelperRoot(client, "/srv/projects/app"), "/data/projects/app");
  assert.deepEqual(client.requests, [{ op: "root.register", params: { path: "/srv/projects/app" } }]);

  for (const answer of [{}, { root: "relative" }, { root: "/a/../b" }, { root: 7 }]) {
    await assert.rejects(registerHelperRoot(recordingClient({ "root.register": answer }), ROOT), {
      errorCode: "HELPER_PROTOCOL_ERROR",
    });
  }
  await assert.rejects(registerHelperRoot(recordingClient(), "relative/root"), { errorCode: "INVALID_ARGUMENT" });
});

test("a refused registration keeps the helper's own code", async () => {
  const refused = Object.assign(new Error("refused"), { errorCode: "REMOTE_PATH_FORBIDDEN" });
  await assert.rejects(registerHelperRoot(recordingClient({ "root.register": refused }), ROOT), {
    errorCode: "REMOTE_PATH_FORBIDDEN",
  });
});

const MANIFEST = {
  schemaVersion: 1,
  helperRoot: "/home/deploy/.pi-desktop-helper",
  helperVersion: "0.21.0",
  protocol: 1,
  desktopVersion: "0.21.0",
  adapters: [],
};

test("env.json is written atomically over SSH into the helper directory", async () => {
  const calls = [];
  const transport = {
    async execWithInput(command, input, options) {
      calls.push({ command, input, options });
      return { code: 0, stdout: "PI_HELPER_ENV_WRITTEN\n", stderr: "" };
    },
  };

  const written = await writeHelperEnvManifest(transport, MANIFEST);
  assert.equal(calls.length, 1);
  const [{ command, input }] = calls;
  assert.deepEqual(JSON.parse(input), MANIFEST);
  assert.equal(written.sha256, sha256(input));
  assert.equal(written.size, Buffer.byteLength(input));
  assert.match(command, /^sh -c '/);
  assert.match(command, /target="\$base\/env\.json"/);
  // A private sibling, a size check, then the rename: never a partial manifest.
  assert.match(command, /mktemp "\$base\/\.env\.json\.XXXXXXXX"/);
  assert.match(command, new RegExp(`-eq ${written.size} \\]`));
  assert.ok(command.indexOf("mktemp") < command.indexOf("mv -f"));
  assert.match(command, /\[ ! -L "\$target" \]/);
});

test("an env.json write that is not confirmed fails the step", async () => {
  const outcomes = [
    async () => {
      throw Object.assign(new Error("ssh failed"), { errorCode: "HOST_BOOTSTRAP_FAILED" });
    },
    async () => ({ code: 0, stdout: "", stderr: "" }),
    async () => ({ code: 1, stdout: "PI_HELPER_ENV_WRITTEN\n", stderr: "" }),
  ];
  for (const execWithInput of outcomes) {
    await assert.rejects(writeHelperEnvManifest({ execWithInput }, MANIFEST), { errorCode: "MIRROR_INIT_FAILED" });
  }
});
