import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";
import { connectHelper } from "../electron/main/mirror/helper-client.ts";
import { createHelperAdapters } from "../electron/main/mirror/helper-adapters.ts";

const TOKEN = "a".repeat(64);
const KIND = "python-debugpy";
const VERSION = "1.8.5";
const CONTROL = 0x01;
const DATA = 0x02;
const END = 0x03;
const CAPABILITIES = ["auth", "version", "health", "adapter.install", "adapter.probe", "adapter.start", "adapter.stop"];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(5);
  header[0] = CONTROL;
  header.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
}

/** Parses every client frame into a queue plus what the server observed. */
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
    async nextControl(op) {
      const next = await this.next();
      assert.equal(next.kind, CONTROL, `expected a control frame, got ${next.kind}`);
      if (op !== undefined) assert.equal(next.value.op, op);
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

/** A fake helper that authenticates and then defers every request to `respond`. */
async function helperServer(respond, capabilities = CAPABILITIES) {
  return startServer(async (socket) => {
    const reader = frameReader(socket);
    const auth = await reader.nextControl("auth");
    socket.write(frame({ id: auth.id, ok: true, result: { authenticated: true } }));
    for (;;) {
      const request = await reader.nextControl();
      const outcome = await respond(request, reader, socket);
      if (!outcome) continue;
      socket.write(frame({ id: request.id, ok: outcome.ok, result: outcome.result, error: outcome.error }));
    }
  });
}

async function connect(port) {
  return connectHelper({ port, token: TOKEN });
}

test("adapter install streams the verified bundle into the pinned install directory", async () => {
  const bytes = Buffer.from([0x00, 0xff, 0x50, 0x4b, 0x00, 0x41]);
  let received = null;
  const server = await helperServer(async (request, reader) => {
    if (request.op === "version") {
      return { ok: true, result: { version: "0.21.0", protocol: 1, capabilities: CAPABILITIES } };
    }
    assert.equal(request.op, "adapter.install");
    assert.equal(request.kind, KIND);
    assert.equal(request.version, VERSION);
    assert.equal(request.sha256, sha256(bytes));
    assert.equal(request.path, `adapters/${KIND}/${VERSION}`);
    assert.ok(Number.isInteger(request.streamId));
    received = await reader.drainStream(request.streamId);
    return {
      ok: true,
      result: {
        kind: KIND,
        version: VERSION,
        sha256: sha256(bytes),
        size: bytes.byteLength,
        bundlePath: `adapters/${KIND}/${VERSION}/bundle`,
        installedAt: 1_700_000_000_000,
      },
    };
  });
  const client = await connect(server.port);
  try {
    const adapters = createHelperAdapters(client);
    const result = await adapters.install(
      { kind: KIND, version: VERSION, sha256: sha256(bytes) },
      bytes,
    );
    assert.equal(result.kind, KIND);
    assert.equal(result.version, VERSION);
    assert.equal(result.sha256, sha256(bytes));
    assert.equal(result.size, bytes.byteLength);
    assert.equal(result.bundlePath, `adapters/${KIND}/${VERSION}/bundle`);
    assert.equal(result.installedAt, 1_700_000_000_000);
    assert.deepEqual(received, bytes);
  } finally {
    client.close();
    await server.close();
  }
});

test("adapter install refuses a bundle that does not match the pinned digest without sending frames", async () => {
  const observed = [];
  const server = await helperServer(async (request) => {
    observed.push(request.op);
    if (request.op === "version") {
      return { ok: true, result: { version: "0.21.0", protocol: 1, capabilities: CAPABILITIES } };
    }
    throw new Error("the helper must not receive an install for a mismatched payload");
  });
  const client = await connect(server.port);
  try {
    const adapters = createHelperAdapters(client);
    await assert.rejects(
      adapters.install(
        { kind: KIND, version: VERSION, sha256: sha256(Buffer.from("other")) },
        Buffer.from("payload"),
      ),
      (error) => error.errorCode === "DEBUG_ADAPTER_INSTALL_FAILED",
    );
    assert.deepEqual(observed, []);
  } finally {
    client.close();
    await server.close();
  }
});

test("adapter helpers reject unsupported kinds, versions and digests before contacting the helper", async () => {
  const observed = [];
  const server = await helperServer(async (request) => {
    observed.push(request.op);
    return { ok: true, result: { version: "0.21.0", protocol: 1, capabilities: CAPABILITIES } };
  });
  const client = await connect(server.port);
  try {
    const adapters = createHelperAdapters(client);
    const payload = Buffer.from("payload");
    await assert.rejects(
      adapters.install({ kind: "go-dlv", version: VERSION, sha256: sha256(payload) }, payload),
      (error) => error.errorCode === "HELPER_PROTOCOL_ERROR",
    );
    await assert.rejects(
      adapters.install({ kind: KIND, version: "../escape", sha256: sha256(payload) }, payload),
      (error) => error.errorCode === "HELPER_PROTOCOL_ERROR",
    );
    await assert.rejects(
      adapters.install({ kind: KIND, version: VERSION, sha256: "not-a-digest" }, payload),
      (error) => error.errorCode === "HELPER_PROTOCOL_ERROR",
    );
    await assert.rejects(adapters.probe("node-inspector"), (error) => error.errorCode === "HELPER_PROTOCOL_ERROR");
    assert.deepEqual(observed, []);
  } finally {
    client.close();
    await server.close();
  }
});

test("adapter probe raises a version mismatch the helper reports as such", async () => {
  const server = await helperServer(async (request) => {
    if (request.op === "version") {
      return { ok: true, result: { version: "0.21.0", protocol: 1, capabilities: CAPABILITIES } };
    }
    assert.equal(request.op, "adapter.probe");
    assert.equal(request.kind, KIND);
    return { ok: false, error: { code: "DEBUG_ADAPTER_VERSION_MISMATCH" } };
  });
  const client = await connect(server.port);
  try {
    const adapters = createHelperAdapters(client);
    await assert.rejects(
      adapters.probe(KIND),
      (error) => error.errorCode === "DEBUG_ADAPTER_VERSION_MISMATCH",
    );
  } finally {
    client.close();
    await server.close();
  }
});

test("adapter probe reports the installed version and tolerates an absent adapter", async () => {
  let installed = null;
  const server = await helperServer(async (request) => {
    if (request.op === "version") {
      return { ok: true, result: { version: "0.21.0", protocol: 1, capabilities: CAPABILITIES } };
    }
    assert.equal(request.op, "adapter.probe");
    return {
      ok: true,
      result: installed === null
        ? { kind: request.kind, installed: false, version: null, sha256: null, installedAt: null }
        : { kind: request.kind, installed: true, ...installed },
    };
  });
  const client = await connect(server.port);
  try {
    const adapters = createHelperAdapters(client);
    const absent = await adapters.probe(KIND);
    assert.equal(absent.installed, false);
    assert.equal(absent.version, null);
    assert.equal(absent.sha256, null);

    installed = { version: VERSION, sha256: sha256(Buffer.from("bundle")), installedAt: 42 };
    const present = await adapters.probe(KIND);
    assert.equal(present.installed, true);
    assert.equal(present.version, VERSION);
    assert.equal(present.installedAt, 42);
  } finally {
    client.close();
    await server.close();
  }
});

test("adapter start reports the loopback port and adapter stop stays idempotent", async () => {
  let stops = 0;
  const server = await helperServer(async (request) => {
    if (request.op === "version") {
      return { ok: true, result: { version: "0.21.0", protocol: 1, capabilities: CAPABILITIES } };
    }
    assert.equal(request.kind, KIND);
    if (request.op === "adapter.start") {
      return { ok: true, result: { kind: KIND, port: 40_123, pid: 4242, version: VERSION } };
    }
    assert.equal(request.op, "adapter.stop");
    stops += 1;
    return { ok: true, result: { kind: KIND, stopped: stops === 1 } };
  });
  const client = await connect(server.port);
  try {
    const adapters = createHelperAdapters(client);
    const started = await adapters.start(KIND);
    assert.deepEqual({ ...started }, { kind: KIND, port: 40_123, pid: 4242, version: VERSION });
    const stopped = await adapters.stop(KIND);
    assert.equal(stopped.stopped, true);
    const again = await adapters.stop(KIND);
    assert.equal(again.stopped, false);
  } finally {
    client.close();
    await server.close();
  }
});

test("adapter start rejects a malformed helper result instead of trusting it", async () => {
  const server = await helperServer(async (request) => {
    if (request.op === "version") {
      return { ok: true, result: { version: "0.21.0", protocol: 1, capabilities: CAPABILITIES } };
    }
    assert.equal(request.op, "adapter.start");
    return { ok: true, result: { kind: KIND, port: 70_000, pid: 1, version: VERSION } };
  });
  const client = await connect(server.port);
  try {
    const adapters = createHelperAdapters(client);
    await assert.rejects(adapters.start(KIND), (error) => error.errorCode === "HELPER_PROTOCOL_ERROR");
  } finally {
    client.close();
    await server.close();
  }
});

test("a helper without adapter capabilities is reported as a version mismatch", async () => {
  const server = await helperServer(
    async (request) => {
      if (request.op === "version") {
        return { ok: true, result: { version: "0.21.0", protocol: 1, capabilities: ["auth", "version", "health"] } };
      }
      throw new Error(`unexpected operation ${request.op}`);
    },
  );
  const client = await connect(server.port);
  try {
    const adapters = createHelperAdapters(client);
    await assert.rejects(adapters.probe(KIND), (error) => error.errorCode === "HELPER_VERSION_MISMATCH");
  } finally {
    client.close();
    await server.close();
  }
});

test("an unimplemented adapter operation maps to a version mismatch", async () => {
  const server = await helperServer(async (request) => {
    if (request.op === "version") {
      return { ok: true, result: { version: "0.21.0", protocol: 1, capabilities: CAPABILITIES } };
    }
    return { ok: false, error: { code: "HELPER_OPERATION_UNAVAILABLE" } };
  });
  const client = await connect(server.port);
  try {
    const adapters = createHelperAdapters(client);
    await assert.rejects(adapters.stop(KIND), (error) => error.errorCode === "HELPER_VERSION_MISMATCH");
  } finally {
    client.close();
    await server.close();
  }
});
