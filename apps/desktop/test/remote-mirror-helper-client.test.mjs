import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import test from "node:test";
import { connectHelper } from "../electron/main/mirror/helper-client.ts";

const TOKEN = "a".repeat(64);
const CONTROL = 0x01;
const DATA = 0x02;
const END = 0x03;

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(5);
  header[0] = CONTROL;
  header.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
}

function typedFrame(kind, payload) {
  const header = Buffer.alloc(5);
  header[0] = kind;
  header.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
}

function dataFrame(streamId, bytes) {
  const payload = Buffer.alloc(4 + bytes.byteLength);
  payload.writeUInt32BE(streamId, 0);
  Buffer.from(bytes).copy(payload, 4);
  return typedFrame(DATA, payload);
}

function endFrame(streamId) {
  const payload = Buffer.alloc(4);
  payload.writeUInt32BE(streamId, 0);
  return typedFrame(END, payload);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readClientFrame(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength < 5) return;
      const size = buffer.readUInt32BE(1);
      if (buffer.byteLength < 5 + size) return;
      socket.off("data", onData);
      resolve(JSON.parse(buffer.subarray(5, 5 + size).toString("utf8")));
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

/** Parses every client frame, keeping both a queue and the full observation log. */
function frameReader(socket) {
  const observed = [];
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
      observed.push(parsed);
      const waiter = waiters.shift();
      if (waiter) waiter(parsed);
      else queue.push(parsed);
    }
  });
  return {
    observed,
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
      assert.equal(next.kind, CONTROL);
      assert.equal(next.value.op, op);
      return next.value;
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

test("helper client authenticates once and maps protocol responses", async () => {
  const server = createServer((socket) => {
    void (async () => {
      const auth = await readClientFrame(socket);
      assert.equal(auth.op, "auth");
      assert.equal(auth.token, TOKEN);
      socket.write(frame({ id: String(auth.id), ok: true, result: { authenticated: true } }));
      const version = await readClientFrame(socket);
      socket.write(frame({ id: String(version.id), ok: true, result: { version: "0.22.0-beta.1", protocol: 1 } }));
      socket.end(frame({ id: "server-close", ok: false, error: { code: "HELPER_OPERATION_UNAVAILABLE" } }));
    })().catch(() => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  try {
    const client = await connectHelper({ port: address.port, token: TOKEN });
    const version = await client.request("version");
    assert.deepEqual(JSON.parse(JSON.stringify(version)), { version: "0.22.0-beta.1", protocol: 1 });
    await assert.rejects(client.request("auth"), (error) => error.errorCode === "HELPER_PROTOCOL_ERROR");
    client.close();
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

test("helper client fails closed on a wrong token and on malformed frames", async () => {
  const sockets = new Set();
  const rejecting = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.destroy();
  });
  await new Promise((resolve) => rejecting.listen(0, "127.0.0.1", resolve));
  const address = rejecting.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  try {
    await assert.rejects(connectHelper({ port: address.port, token: TOKEN }), (error) => error.errorCode === "HELPER_AUTH_FAILED");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => rejecting.close(() => resolve()));
  }

  const malformedScope = new Set();
  const malformed = createServer((socket) => {
    malformedScope.add(socket);
    socket.once("close", () => malformedScope.delete(socket));
    socket.write(Buffer.from([0x7f, 0, 0, 0, 0]));
    socket.end();
  });
  await new Promise((resolve) => malformed.listen(0, "127.0.0.1", resolve));
  const malformedAddress = malformed.address();
  if (!malformedAddress || typeof malformedAddress === "string") throw new Error("test server did not bind");
  try {
    await assert.rejects(connectHelper({ port: malformedAddress.port, token: TOKEN }), (error) => error.errorCode === "HELPER_AUTH_FAILED");
  } finally {
    for (const socket of malformedScope) socket.destroy();
    await new Promise((resolve) => malformed.close(() => resolve()));
  }
});

test("helper client validates token, port, and operation boundaries before connecting", async () => {
  await assert.rejects(connectHelper({ port: 1, token: "bad" }), (error) => error.errorCode === "HELPER_AUTH_FAILED");
  await assert.rejects(connectHelper({ port: 0, token: TOKEN }), (error) => error.errorCode === "HELPER_AUTH_FAILED");
});

test("helper client streams an upload as DATA frames and resolves the final response", async () => {
  const content = Buffer.from([0x00, 0xff, 0x41, 0x00, 0x42, 0xff, 0x00]);
  let reassembled = null;
  const server = await startServer(async (socket) => {
    const reader = frameReader(socket);
    const auth = await reader.nextControl("auth");
    socket.write(frame({ id: auth.id, ok: true, result: { authenticated: true } }));
    const begin = await reader.nextControl("fs.put.begin");
    assert.equal(begin.streamId, 7);
    assert.equal(begin.path, "src/a.bin");
    assert.equal(begin.size, content.byteLength);
    assert.equal(begin.sha256, sha256(content));
    const chunks = [];
    for (;;) {
      const next = await reader.next();
      if (next.kind === DATA) {
        assert.equal(next.payload.readUInt32BE(0), 7);
        chunks.push(next.payload.subarray(4));
        continue;
      }
      assert.equal(next.kind, END);
      assert.equal(next.payload.byteLength, 4);
      assert.equal(next.payload.readUInt32BE(0), 7);
      break;
    }
    reassembled = Buffer.concat(chunks);
    socket.write(frame({ id: begin.id, ok: true, result: { size: content.byteLength, sha256: sha256(content) } }));
  });
  const client = await connectHelper({ port: server.port, token: TOKEN });
  try {
    const stream = client.beginStream({
      op: "fs.put.begin",
      params: { path: "src/a.bin", size: content.byteLength, sha256: sha256(content) },
      streamId: 7,
    });
    await client.writeStreamData(7, content.subarray(0, 3));
    await client.writeStreamData(7, content.subarray(3));
    await client.writeStreamEnd(7);
    const result = await stream.response;
    assert.equal(result.size, content.byteLength);
    assert.deepEqual(reassembled, content);
    client.closeStream(7);
  } finally {
    client.close();
    await server.close();
  }
});

test("helper client demultiplexes download frames in order and stays usable", async () => {
  const parts = [Buffer.from([0x00, 0xff]), Buffer.from("mid"), Buffer.from([0x00])];
  const server = await startServer(async (socket) => {
    const reader = frameReader(socket);
    const auth = await reader.nextControl("auth");
    socket.write(frame({ id: auth.id, ok: true, result: { authenticated: true } }));
    const begin = await reader.nextControl("fs.get.begin");
    assert.equal(begin.path, "src/a.bin");
    const streamId = begin.streamId;
    assert.ok(Number.isInteger(streamId) && streamId >= 1);
    const expected = Buffer.concat(parts);
    socket.write(frame({ id: begin.id, ok: true, result: { size: expected.byteLength, sha256: sha256(expected) } }));
    // A frame split across two writes proves the client buffers partial frames.
    const second = dataFrame(streamId, parts[1]);
    socket.write(Buffer.concat([dataFrame(streamId, parts[0]), second.subarray(0, 3)]));
    socket.write(Buffer.concat([second.subarray(3), dataFrame(streamId, parts[2]), endFrame(streamId)]));
    const version = await reader.nextControl("version");
    socket.write(frame({ id: version.id, ok: true, result: { version: "0.22.0-beta.1", protocol: 1 } }));
  });
  const client = await connectHelper({ port: server.port, token: TOKEN });
  try {
    const chunks = [];
    const stream = client.beginStream({
      op: "fs.get.begin",
      params: { path: "src/a.bin" },
      onData: (bytes) => {
        chunks.push(Buffer.from(bytes));
      },
    });
    const begin = await stream.response;
    assert.equal(begin.size, 6);
    await stream.completed;
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat(parts));
    client.closeStream(stream.streamId);
    const version = await client.request("version");
    assert.equal(version.protocol, 1);
  } finally {
    client.close();
    await server.close();
  }
});

test("helper client fails closed when END names a stream that is not open", async () => {
  const server = await startServer(async (socket) => {
    const reader = frameReader(socket);
    const auth = await reader.nextControl("auth");
    socket.write(frame({ id: auth.id, ok: true, result: { authenticated: true } }));
    const begin = await reader.nextControl("fs.get.begin");
    socket.write(frame({ id: begin.id, ok: true, result: { size: 1 } }));
    socket.write(endFrame(12));
  });
  const client = await connectHelper({ port: server.port, token: TOKEN });
  try {
    const stream = client.beginStream({ op: "fs.get.begin", params: { path: "a.txt" }, streamId: 11 });
    await stream.response;
    await assert.rejects(stream.completed, (error) => error.errorCode === "HELPER_PROTOCOL_ERROR");
    await assert.rejects(client.request("version"));
  } finally {
    client.close();
    await server.close();
  }
});

test("helper client fails closed when DATA names a stream that is not open", async () => {
  const server = await startServer(async (socket) => {
    const reader = frameReader(socket);
    const auth = await reader.nextControl("auth");
    socket.write(frame({ id: auth.id, ok: true, result: { authenticated: true } }));
    const begin = await reader.nextControl("fs.get.begin");
    socket.write(frame({ id: begin.id, ok: true, result: { size: 3 } }));
    socket.write(dataFrame(99, Buffer.from("abc")));
  });
  const client = await connectHelper({ port: server.port, token: TOKEN });
  try {
    const stream = client.beginStream({ op: "fs.get.begin", params: { path: "a.txt" }, streamId: 11 });
    await stream.response;
    await assert.rejects(stream.completed, (error) => error.errorCode === "HELPER_PROTOCOL_ERROR");
    await assert.rejects(client.request("version"));
  } finally {
    client.close();
    await server.close();
  }
});

test("helper client drops frames for an abandoned stream and keeps the connection", async () => {
  let releaseServer = () => undefined;
  const serverGate = new Promise((resolve) => {
    releaseServer = resolve;
  });
  let firstChunk = null;
  const firstChunkReceived = new Promise((resolve) => {
    firstChunk = resolve;
  });
  const server = await startServer(async (socket) => {
    const reader = frameReader(socket);
    const auth = await reader.nextControl("auth");
    socket.write(frame({ id: auth.id, ok: true, result: { authenticated: true } }));
    const begin = await reader.nextControl("fs.get.begin");
    socket.write(frame({ id: begin.id, ok: true, result: { size: 6 } }));
    socket.write(dataFrame(21, Buffer.from("abc")));
    await serverGate;
    socket.write(Buffer.concat([dataFrame(21, Buffer.from("def")), endFrame(21)]));
    const version = await reader.nextControl("version");
    socket.write(frame({ id: version.id, ok: true, result: { version: "0.22.0-beta.1", protocol: 1 } }));
  });
  const client = await connectHelper({ port: server.port, token: TOKEN });
  try {
    const chunks = [];
    const stream = client.beginStream({
      op: "fs.get.begin",
      params: { path: "a.txt" },
      streamId: 21,
      onData: (bytes) => {
        chunks.push(Buffer.from(bytes));
        firstChunk();
      },
    });
    await stream.response;
    await firstChunkReceived;
    client.abandonStream(21, Object.assign(new Error("cancelled"), { errorCode: "REMOTE_TRANSFER_FAILED" }));
    await assert.rejects(stream.completed, (error) => error.errorCode === "REMOTE_TRANSFER_FAILED");
    releaseServer();
    const version = await client.request("version");
    assert.equal(version.protocol, 1);
    assert.equal(Buffer.concat(chunks).toString("utf8"), "abc");
  } finally {
    client.close();
    await server.close();
  }
});

test("helper client rejects invalid stream boundaries without sending frames", async () => {
  const server = await startServer(async (socket) => {
    const reader = frameReader(socket);
    const auth = await reader.nextControl("auth");
    socket.write(frame({ id: auth.id, ok: true, result: { authenticated: true } }));
  });
  const client = await connectHelper({ port: server.port, token: TOKEN });
  try {
    assert.throws(() => client.beginStream({ op: "auth", streamId: 3 }), (error) => error.errorCode === "HELPER_PROTOCOL_ERROR");
    assert.throws(() => client.beginStream({ op: "fs.get.begin", streamId: 0 }), (error) => error.errorCode === "HELPER_PROTOCOL_ERROR");
    await assert.rejects(client.writeStreamData(42, Buffer.from("x")), (error) => error.errorCode === "HELPER_PROTOCOL_ERROR");
    await assert.rejects(client.writeStreamEnd(42), (error) => error.errorCode === "HELPER_PROTOCOL_ERROR");
  } finally {
    client.close();
    await server.close();
  }
});
