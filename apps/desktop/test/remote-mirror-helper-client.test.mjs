import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { connectHelper } from "../electron/main/mirror/helper-client.ts";

const TOKEN = "a".repeat(64);
const CONTROL = 0x01;

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(5);
  header[0] = CONTROL;
  header.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
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
