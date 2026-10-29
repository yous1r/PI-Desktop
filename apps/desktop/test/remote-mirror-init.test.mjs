/**
 * Behavioral tests for the mirror initialization state machine (spec 23 §4).
 *
 * The service is driven with injected ports only: an in-memory host RPC store
 * that applies the same state/step/error rule host-core enforces, a fake SSH
 * transport, and a real framed helper server reached through the production
 * helper client, so the deploy, handshake, env.verify and adapter steps run
 * their real code paths without a remote host.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { register } from "node:module";
import test from "node:test";

// The main-process sources use bundler-style `.js` specifiers that only exist as
// `.ts` on disk; the shared hook resolves them for `node --test`.
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { MirrorInitService, MIRROR_INIT_STEPS, parseMirrorInitStatus } = await import(
  "../electron/main/mirror/mirror-init.ts"
);
const { connectHelper } = await import("../electron/main/mirror/helper-client.ts");

const GROUP = "group-1";
const OTHER_GROUP = "group-2";
const NOW = 1_700_000_000_000;
const TOKEN = "b".repeat(64);
const DESKTOP_VERSION = "0.21.0";
const PAYLOAD = Buffer.from("pinned python-debugpy payload", "utf8");
const CAPABILITIES = ["auth", "version", "health", "adapter.install", "adapter.probe", "adapter.start", "adapter.stop"];
const CONTROL = 0x01;
const DATA = 0x02;
const END = 0x03;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const ADAPTER = { kind: "python-debugpy", version: "1.8.5", sha256: sha256(PAYLOAD) };

const ARTIFACT = {
  path: "C:/bundle/pi-helper-linux-x64",
  manifest: {
    schemaVersion: 1,
    version: DESKTOP_VERSION,
    target: "x86_64-unknown-linux-musl",
    arch: "x64",
    file: "pi-helper-linux-x64",
    sha256: "c".repeat(64),
  },
};

const READY_LINE = [
  `PI_HELPER_READY ${JSON.stringify({ port: 43127, version: DESKTOP_VERSION, protocol: 1 })}`,
  `PI_HELPER_TOKEN ${TOKEN}`,
].join("\n");

// ── Host double ─────────────────────────────────────────────────────────────

/**
 * In-memory `mirror.init.*` + `project.groups.list` store. It rejects the same
 * inconsistent transitions host-core rejects, so a malformed write fails here
 * instead of silently shaping the next resume.
 */
function createHost(options = {}) {
  const calls = [];
  const receipts = new Map(Object.entries(options.receipts ?? {}));
  let stored = options.state ?? { state: "needs-init", step: null, error: null };
  const groups = options.groups ?? [
    { id: GROUP, primaryPath: "D:/work/group", mirror: { hostKey: "devbox", remotePath: "/srv/app", mode: "auto" } },
  ];

  function statusPayload() {
    return {
      projectGroupId: GROUP,
      state: stored.state,
      step: stored.step,
      error: stored.error,
      completedSteps: [...receipts.keys()],
      receipts: [...receipts].map(([step, receipt]) => ({ step, receipt, updatedAt: NOW })),
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  const host = {
    async call(method, params = {}) {
      calls.push({ method, params });
      if (method === "mirror.init.status") {
        assert.equal(params.projectId, GROUP);
        return statusPayload();
      }
      if (method === "mirror.init.receipt.upsert") {
        assert.equal(params.projectId, GROUP);
        assert.ok(params.receipt && typeof params.receipt === "object");
        // host-core stores the receipt as a JSON blob and refuses anything else.
        assert.equal(typeof JSON.parse(JSON.stringify(params.receipt)), "object");
        receipts.set(params.step, params.receipt);
        return { step: params.step, receipt: params.receipt, updatedAt: params.updatedAt };
      }
      if (method === "mirror.init.state") {
        const step = params.step ?? params.error?.step ?? null;
        const error = params.error ?? null;
        if (params.state === "initializing" && (step === null || error !== null)) {
          throw new Error("initializing needs a step and no error");
        }
        if (params.state === "init-failed" && (step === null || error === null || error.step !== step)) {
          throw new Error("init-failed needs a failure naming its step");
        }
        if (params.state === "ready" && error !== null) throw new Error("ready carries no error");
        stored = { state: params.state, step, error };
        return statusPayload();
      }
      if (method === "project.groups.list") return { groups };
      throw new Error(`unexpected host method ${method}`);
    },
  };

  return {
    host,
    calls,
    receipts,
    state: () => stored,
    callsOf: (method) => calls.filter((call) => call.method === method),
  };
}

// ── SSH transport double ────────────────────────────────────────────────────

function createTransport(options = {}) {
  const calls = [];
  return {
    calls,
    async exec(command, settings = {}) {
      calls.push({ command, settings });
      if (options.exec) return options.exec(command);
      return { stdout: `PI_HELPER_DIR_OK free_kb=${900 * 1024}\n`, stderr: "", code: 0 };
    },
    async execWithFile(command, path, settings) {
      calls.push({ command, path, settings });
      if (options.execWithFile) return options.execWithFile(command, path);
      return { stdout: READY_LINE, stderr: "", code: 0 };
    },
  };
}

// ── Framed helper server ────────────────────────────────────────────────────

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(5);
  header[0] = CONTROL;
  header.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
}

function frameReader(socket) {
  const queue = [];
  const waiters = [];
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.byteLength < 5) break;
      const kind = buffer[0];
      const size = buffer.readUInt32BE(1);
      if (buffer.byteLength < 5 + size) break;
      const payload = Buffer.from(buffer.subarray(5, 5 + size));
      buffer = buffer.subarray(5 + size);
      const parsed = kind === CONTROL ? { kind, value: JSON.parse(payload.toString("utf8")) } : { kind, payload };
      const waiter = waiters.shift();
      if (waiter) waiter(parsed);
      else queue.push(parsed);
    }
  });
  return {
    next(timeoutMs = 4000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a client frame")), timeoutMs);
        timer.unref?.();
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
    async nextControl() {
      const next = await this.next();
      assert.equal(next.kind, CONTROL, `expected a control frame, got ${next.kind}`);
      return next.value;
    },
    async drainStream(streamId) {
      const chunks = [];
      for (;;) {
        const next = await this.next();
        if (next.kind === DATA) {
          assert.equal(next.payload.readUInt32BE(0), streamId);
          chunks.push(next.payload.subarray(4));
          continue;
        }
        assert.equal(next.kind, END);
        assert.equal(next.payload.readUInt32BE(0), streamId);
        return Buffer.concat(chunks);
      }
    },
  };
}

async function startServer(handler) {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    Promise.resolve(handler(socket)).catch(() => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/** A helper that authenticates, then answers `version`, `env.verify` and adapters. */
async function helperServer(answers = {}) {
  const operations = [];
  const server = await startServer(async (socket) => {
    const reader = frameReader(socket);
    const auth = await reader.nextControl();
    socket.write(frame({ id: auth.id, ok: true, result: { authenticated: true } }));
    for (;;) {
      const request = await reader.nextControl();
      operations.push(request.op);
      if (request.op === "version") {
        const answer = answers.version ?? { version: DESKTOP_VERSION, protocol: 1 };
        socket.write(frame({ id: request.id, ok: true, result: { capabilities: CAPABILITIES, ...answer } }));
        continue;
      }
      if (request.op === "env.verify") {
        const answer = answers.env ?? { ready: true, protocol: 1, projectRootCount: 1 };
        socket.write(
          frame({
            id: request.id,
            ok: true,
            result: { root: "/home/deploy/.pi-desktop-helper", capabilities: CAPABILITIES, ...answer },
          }),
        );
        continue;
      }
      if (request.op === "adapter.install") {
        const bytes = await reader.drainStream(request.streamId);
        const answer = answers.install ?? { version: ADAPTER.version, sha256: ADAPTER.sha256 };
        socket.write(
          frame({
            id: request.id,
            ok: true,
            result: {
              kind: request.kind,
              size: bytes.byteLength,
              bundlePath: `adapters/${request.kind}/${answer.version}`,
              installedAt: NOW,
              ...answer,
            },
          }),
        );
        continue;
      }
      if (request.op === "adapter.probe") {
        const answer = answers.probe ?? { installed: true, version: ADAPTER.version, sha256: ADAPTER.sha256 };
        socket.write(frame({ id: request.id, ok: true, result: { kind: request.kind, installedAt: NOW, ...answer } }));
        continue;
      }
      socket.write(frame({ id: request.id, ok: false, error: { code: "HELPER_OPERATION_UNAVAILABLE" } }));
    }
  });
  return { port: server.port, operations, close: server.close };
}

// ── Service harness ─────────────────────────────────────────────────────────

async function harness(options = {}) {
  const host = createHost(options.host);
  const helper = await helperServer(options.answers);
  const transport = createTransport(options.transport);
  const warnings = [];
  const service = new MirrorInitService({
    host: host.host,
    client: async () => connectHelper({ port: helper.port, token: TOKEN }),
    logger: {
      warn(message, data) {
        warnings.push({ message, data });
      },
    },
    now: () => NOW,
    transport,
    desktopVersion: options.desktopVersion ?? DESKTOP_VERSION,
    helperArtifact: async () => ARTIFACT,
    adapterManifest: options.adapterManifest ?? [ADAPTER],
    adapterPayload: () => PAYLOAD,
    forwardSelfTest: options.forwardSelfTest,
    // `null` means "this build has no such port", which must fail honestly.
    writeEnvManifest: options.writeEnvManifest === null ? undefined : (options.writeEnvManifest ?? (async () => ({ sha256: "e".repeat(64) }))),
    storeBaseline: options.storeBaseline === null ? undefined : (options.storeBaseline ?? (async () => ({ entries: 3 }))),
  });
  const close = async () => {
    service.close();
    await helper.close();
  };
  return { host, helper, transport, service, warnings, close };
}

/** Receipts for the first `count` steps, as a resumed project would have them. */
function seededReceipts(count) {
  const seeded = {};
  for (const step of MIRROR_INIT_STEPS.slice(0, count)) seeded[step] = { completedAt: NOW - 1000 };
  return seeded;
}

// ── Status ──────────────────────────────────────────────────────────────────

test("status maps the stored row and the receipts of a failed project", async () => {
  const { host, service, close } = await harness({
    host: {
      receipts: seededReceipts(2),
      state: {
        state: "init-failed",
        step: "helper-deploy",
        error: { code: "HELPER_DEPLOY_FAILED", message: "The bundled remote helper could not be installed.", step: "helper-deploy" },
      },
    },
  });
  try {
    const status = await service.status(GROUP);
    assert.equal(status.projectGroupId, GROUP);
    assert.equal(status.state, "init-failed");
    assert.equal(status.step, "helper-deploy");
    assert.deepEqual(status.completedSteps, ["ssh", "helper-dir"]);
    assert.equal(status.error.code, "HELPER_DEPLOY_FAILED");
    assert.equal(status.error.step, "helper-deploy");
    assert.equal(host.callsOf("mirror.init.status")[0].params.projectId, GROUP);
  } finally {
    await close();
  }
});

test("status refuses a payload with a step this build does not know", () => {
  assert.throws(
    () => parseMirrorInitStatus({ state: "initializing", step: "compile-remote", completedSteps: [] }, GROUP),
    (error) => error?.errorCode === "MIRROR_INIT_FAILED",
  );
  assert.throws(
    () => parseMirrorInitStatus({ state: "lost", step: null, completedSteps: [] }, GROUP),
    (error) => error?.errorCode === "MIRROR_INIT_FAILED",
  );
});

// ── The full sequence ───────────────────────────────────────────────────────

test("start drives all ten steps, writing state before and a receipt after each", async () => {
  const { host, helper, transport, service, close } = await harness({
    forwardSelfTest: async () => undefined,
  });
  try {
    const status = await service.start(GROUP);
    assert.equal(status.state, "ready");
    assert.equal(status.step, null);
    assert.deepEqual(status.completedSteps, [...MIRROR_INIT_STEPS]);
    assert.deepEqual([...host.receipts.keys()], [...MIRROR_INIT_STEPS]);
    assert.equal(host.state().state, "ready");

    // Every step is announced with `initializing` before its receipt exists, so
    // a crash between the two resumes at that step.
    const writes = host.calls.filter(
      (call) => call.method === "mirror.init.state" || call.method === "mirror.init.receipt.upsert",
    );
    for (const step of MIRROR_INIT_STEPS) {
      const announced = writes.findIndex(
        (call) => call.method === "mirror.init.state" && call.params.state === "initializing" && call.params.step === step,
      );
      const received = writes.findIndex(
        (call) => call.method === "mirror.init.receipt.upsert" && call.params.step === step,
      );
      assert.ok(announced >= 0, `${step} is announced before it runs`);
      assert.ok(received > announced, `${step} receipt follows its announcement`);
    }

    // The injected ports really ran, in the shape the spec describes.
    // One reachability probe, one helper-root script, one artifact upload.
    assert.equal(transport.calls.filter((call) => call.command === "true").length, 1);
    assert.equal(transport.calls.length, 3);
    assert.deepEqual(helper.operations.filter((op) => op !== "version"), ["env.verify", "adapter.install", "adapter.probe"]);
    assert.deepEqual(host.receipts.get("helper-deploy"), {
      completedAt: NOW,
      version: DESKTOP_VERSION,
      digest: ARTIFACT.manifest.sha256,
    });
    assert.deepEqual(host.receipts.get("helper-dir"), { completedAt: NOW, freeKb: 900 * 1024 });
    assert.deepEqual(host.receipts.get("env-verify"), {
      completedAt: NOW,
      ready: true,
      protocol: 1,
      projectRootCount: 1,
      capabilities: CAPABILITIES,
    });
    assert.deepEqual(host.receipts.get("adapter-probe"), {
      completedAt: NOW,
      adapters: [{ kind: ADAPTER.kind, version: ADAPTER.version, sha256: ADAPTER.sha256 }],
    });
    assert.deepEqual(host.receipts.get("local-environment"), {
      completedAt: NOW,
      projectRegistered: true,
      mirrorBound: true,
      localRootPresent: true,
    });
    assert.deepEqual(host.receipts.get("manifest"), {
      completedAt: NOW,
      envSha256: "e".repeat(64),
      baselineEntries: 3,
    });
  } finally {
    await close();
  }
});

test("start resumes at the first step without a receipt instead of restarting", async () => {
  const { host, helper, transport, service, close } = await harness({
    host: { receipts: seededReceipts(5), state: { state: "initializing", step: "env-verify", error: null } },
    forwardSelfTest: async () => undefined,
  });
  try {
    const status = await service.start(GROUP);
    assert.equal(status.state, "ready");
    assert.deepEqual(status.completedSteps, [...MIRROR_INIT_STEPS]);
    // Steps 1..5 kept their receipts: no SSH exec, no handshake, no env.verify.
    assert.equal(transport.calls.length, 0);
    assert.deepEqual(helper.operations.filter((op) => op !== "version"), ["adapter.install", "adapter.probe"]);
    const firstAnnouncement = host.calls.find(
      (call) => call.method === "mirror.init.state" && call.params.state === "initializing",
    );
    assert.equal(firstAnnouncement.params.step, "adapter-install");
    assert.equal(host.receipts.get("ssh").completedAt, NOW - 1000, "a completed step keeps its original receipt");
  } finally {
    await close();
  }
});

test("a project whose steps all have receipts only rewrites ready", async () => {
  const { host, helper, transport, service, close } = await harness({
    host: { receipts: seededReceipts(10), state: { state: "ready", step: null, error: null } },
  });
  try {
    const status = await service.start(GROUP);
    assert.equal(status.state, "ready");
    assert.equal(transport.calls.length, 0);
    assert.deepEqual(helper.operations, []);
    assert.equal(host.callsOf("mirror.init.receipt.upsert").length, 0);
    assert.equal(host.callsOf("mirror.init.state").length, 1);
  } finally {
    await close();
  }
});

// ── Per-step failures ───────────────────────────────────────────────────────

test("an unreachable host fails step 1 with REMOTE_CONNECTION_FAILED and no receipt", async () => {
  const { host, transport, service, close } = await harness({
    transport: {
      exec: () => ({ stdout: "", stderr: "/home/deploy/.ssh/id_ed25519: permission denied", code: 255 }),
    },
  });
  try {
    const status = await service.start(GROUP);
    assert.equal(status.state, "init-failed");
    assert.equal(status.step, "ssh");
    assert.equal(status.error.code, "REMOTE_CONNECTION_FAILED");
    assert.equal(status.error.step, "ssh");
    assert.equal(host.receipts.has("ssh"), false);
    assert.equal(transport.calls.length, 1);
  } finally {
    await close();
  }
});

test("an unwritable helper root fails step 2 and leaks neither stderr nor a path", async () => {
  const { host, transport, service, warnings, close } = await harness({
    transport: {
      exec: (command) =>
        command === "true"
          ? { stdout: "", stderr: "", code: 0 }
          : {
              stdout: "PI_HELPER_DIR_FAIL disk-budget",
              stderr: "df: /home/deploy/.pi-desktop-helper: no space; token " + TOKEN,
              code: 1,
            },
    },
  });
  try {
    const status = await service.start(GROUP);
    assert.equal(status.state, "init-failed");
    assert.equal(status.step, "helper-dir");
    assert.equal(status.error.code, "HELPER_DIR_UNWRITABLE");
    assert.match(status.error.message, /disk-budget/);
    assert.equal(host.receipts.has("helper-dir"), false);
    // Receipts, the state error and the log line must not carry host text.
    const rendered = JSON.stringify(status) + JSON.stringify(host.state()) + JSON.stringify(warnings);
    for (const secret of ["/home", "token", TOKEN, "no space"]) {
      assert.equal(rendered.includes(secret), false, `${secret} is not repeated`);
    }
    assert.equal(transport.calls.length, 2);
  } finally {
    await close();
  }
});

test("a helper that cannot be uploaded fails step 3 with HELPER_DEPLOY_FAILED", async () => {
  const { host, service, close } = await harness({
    transport: { execWithFile: () => ({ stdout: "", stderr: "upload refused", code: 1 }) },
  });
  try {
    const status = await service.start(GROUP);
    assert.equal(status.state, "init-failed");
    assert.equal(status.step, "helper-deploy");
    assert.equal(status.error.code, "HELPER_DEPLOY_FAILED");
    assert.equal(host.receipts.has("helper-deploy"), false);
  } finally {
    await close();
  }
});

test("a helper version mismatch fails step 4 with HELPER_START_FAILED", async () => {
  const { host, helper, service, close } = await harness({
    answers: { version: { version: "9.9.9", protocol: 1 } },
  });
  try {
    const status = await service.start(GROUP);
    assert.equal(status.state, "init-failed");
    assert.equal(status.step, "helper-start");
    assert.equal(status.error.code, "HELPER_START_FAILED");
    assert.deepEqual(helper.operations.filter((op) => op !== "version"), []);
    assert.equal(host.receipts.has("helper-start"), false);
  } finally {
    await close();
  }
});

test("a helper that is not ready fails step 5 with MIRROR_INIT_FAILED", async () => {
  const { host, service, close } = await harness({
    answers: { env: { ready: false, protocol: 1, projectRootCount: 0 } },
  });
  try {
    const status = await service.start(GROUP);
    assert.equal(status.step, "env-verify");
    assert.equal(status.error.code, "MIRROR_INIT_FAILED");
    assert.equal(host.receipts.has("env-verify"), false);
  } finally {
    await close();
  }
});

test("an adapter the helper installed with another digest fails step 6", async () => {
  const { host, service, close } = await harness({
    answers: { install: { version: ADAPTER.version, sha256: "d".repeat(64) } },
  });
  try {
    const status = await service.start(GROUP);
    assert.equal(status.step, "adapter-install");
    assert.equal(status.error.code, "DEBUG_ADAPTER_INSTALL_FAILED");
    assert.equal(host.receipts.has("adapter-install"), false);
  } finally {
    await close();
  }
});

test("an installed adapter that differs from the pin fails step 7", async () => {
  const { host, service, close } = await harness({
    answers: { probe: { installed: true, version: "1.8.4", sha256: ADAPTER.sha256 } },
  });
  try {
    const status = await service.start(GROUP);
    assert.equal(status.step, "adapter-probe");
    assert.equal(status.error.code, "DEBUG_ADAPTER_VERSION_MISMATCH");
    assert.equal(host.receipts.has("adapter-probe"), false);
  } finally {
    await close();
  }
});

test("a target with no pinned adapter is a reported gap, not a silent pass", async () => {
  const { host, service, close } = await harness({ adapterManifest: [] });
  try {
    const status = await service.start(GROUP);
    assert.equal(status.step, "adapter-install");
    assert.equal(status.error.code, "DEBUG_ADAPTER_INSTALL_FAILED");
    assert.equal(host.receipts.has("adapter-install"), false);
  } finally {
    await close();
  }
});

test("the local environment is judged by the project group record", async () => {
  const { host, service, close } = await harness({
    host: { groups: [{ id: OTHER_GROUP, primaryPath: "D:/work/other", mirror: { hostKey: "devbox" } }] },
    forwardSelfTest: async () => undefined,
  });
  try {
    const status = await service.start(GROUP);
    assert.equal(status.step, "local-environment");
    assert.equal(status.error.code, "MIRROR_INIT_FAILED");
    assert.equal(host.receipts.has("local-environment"), false);
  } finally {
    await close();
  }
});

// ── Honest failures for steps this build cannot perform ─────────────────────

test("without a forward opener step 8 fails instead of recording a forward", async () => {
  const { host, service, close } = await harness();
  try {
    const status = await service.start(GROUP);
    assert.equal(status.state, "init-failed");
    assert.equal(status.step, "forward-self-test");
    assert.equal(status.error.code, "REMOTE_FORWARD_FAILED");
    assert.deepEqual([...host.receipts.keys()], MIRROR_INIT_STEPS.slice(0, 7));
    assert.equal(
      host.calls.some((call) => call.method === "mirror.init.state" && call.params.step === "local-environment"),
      false,
    );
  } finally {
    await close();
  }
});

test("a forward self-test that rejects also fails step 8", async () => {
  const { service, close } = await harness({
    forwardSelfTest: async () => {
      throw new Error("connect ECONNREFUSED /home/deploy");
    },
  });
  try {
    const status = await service.start(GROUP);
    assert.equal(status.step, "forward-self-test");
    assert.equal(status.error.code, "REMOTE_FORWARD_FAILED");
    assert.equal(status.error.message.includes("/home"), false);
  } finally {
    await close();
  }
});

test("without a manifest writer and baseline store step 10 fails honestly", async () => {
  const { host, service, close } = await harness({
    forwardSelfTest: async () => undefined,
    writeEnvManifest: null,
    storeBaseline: null,
  });
  try {
    const status = await service.start(GROUP);
    assert.equal(status.step, "manifest");
    assert.equal(status.error.code, "MIRROR_INIT_FAILED");
    assert.deepEqual([...host.receipts.keys()], MIRROR_INIT_STEPS.slice(0, 9));
  } finally {
    await close();
  }
});

// ── Concurrency and input guards ────────────────────────────────────────────

test("a second start for the same project joins the in-flight sequence", async () => {
  const { host, transport, service, close } = await harness({
    forwardSelfTest: async () => undefined,
  });
  try {
    const first = service.start(GROUP);
    const second = service.start(GROUP);
    assert.equal(first, second, "the second caller receives the same promise");
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.state, "ready");
    assert.deepEqual(b, a);
    // One sequence means one SSH probe and one receipt per step.
    assert.equal(transport.calls.filter((call) => call.command === "true").length, 1);
    assert.equal(host.callsOf("mirror.init.receipt.upsert").length, MIRROR_INIT_STEPS.length);
  } finally {
    await close();
  }
});

test("a blank project group id is refused before any host call", async () => {
  const { host, service, close } = await harness();
  try {
    assert.throws(() => service.start("   "), (error) => error?.errorCode === "MIRROR_INIT_FAILED");
    await assert.rejects(() => service.status(""), (error) => error?.errorCode === "MIRROR_INIT_FAILED");
    assert.equal(host.calls.length, 0);
  } finally {
    await close();
  }
});
