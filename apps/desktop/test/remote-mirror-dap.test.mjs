import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
  encodeDapMessage,
  DapDecoder,
  MAX_DAP_MESSAGE_BYTES,
  MAX_DAP_HEADER_BYTES,
} from "../electron/main/debug/dap-framing.ts";
import {
  mapRemoteToLocal,
  mapLocalToRemote,
  translateRemoteSource,
  translateRemotePath,
} from "../electron/main/debug/dap-paths.ts";
import {
  DapClient,
  createDapClient,
} from "../electron/main/debug/dap-client.ts";

// Helper to spawn an in-memory TCP server on loopback
function startMockDapServer(connectionHandler) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    let currentSocket = null;
    const waiters = [];

    const server = createServer((socket) => {
      sockets.add(socket);
      currentSocket = socket;
      socket.once("close", () => sockets.delete(socket));
      for (const w of waiters) {
        w(socket);
      }
      waiters.length = 0;
      if (connectionHandler) {
        connectionHandler(socket);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        waitForConnection: () => {
          if (currentSocket) return Promise.resolve(currentSocket);
          return new Promise((res) => waiters.push(res));
        },
        close: () =>
          new Promise((res) => {
            for (const s of sockets) {
              s.destroy();
            }
            sockets.clear();
            server.close(() => res());
          }),
      });
    });
    server.once("error", reject);
  });
}

// -----------------------------------------------------------------------------
// DAP Framing Tests
// -----------------------------------------------------------------------------

test("framing: round-trip encodes and decodes DAP messages with UTF-8 content", () => {
  const decoder = new DapDecoder();

  const originalRequest = {
    seq: 1,
    type: "request",
    command: "initialize",
    arguments: {
      clientID: "pi-desktop",
      adapterID: "python",
      unicodeTest: "断点调试 🚀 utf8",
    },
  };

  const wireBytes = encodeDapMessage(originalRequest);
  assert.ok(wireBytes.length > 0);
  assert.ok(wireBytes.toString("utf8").startsWith("Content-Length: "));

  const parsed = decoder.push(wireBytes);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], originalRequest);
  assert.equal(decoder.bufferedBytes, 0);
});

test("framing: survives split chunks across header, separator, and body boundaries", () => {
  const decoder = new DapDecoder();

  const message = {
    seq: 42,
    type: "event",
    event: "stopped",
    body: { reason: "breakpoint", threadId: 1 },
  };

  const wireBytes = encodeDapMessage(message);

  // Split in half
  const splitPoint = Math.floor(wireBytes.length / 2);
  const chunk1 = wireBytes.subarray(0, splitPoint);
  const chunk2 = wireBytes.subarray(splitPoint);

  const parsed1 = decoder.push(chunk1);
  assert.equal(parsed1.length, 0);
  assert.equal(decoder.bufferedBytes, chunk1.length);

  const parsed2 = decoder.push(chunk2);
  assert.equal(parsed2.length, 1);
  assert.deepEqual(parsed2[0], message);
  assert.equal(decoder.bufferedBytes, 0);

  // Single byte by byte feed
  const decoderByteByByte = new DapDecoder();
  let byteResult = [];
  for (let i = 0; i < wireBytes.length; i++) {
    const res = decoderByteByByte.push(wireBytes.subarray(i, i + 1));
    if (res.length > 0) {
      byteResult.push(...res);
    }
  }
  assert.equal(byteResult.length, 1);
  assert.deepEqual(byteResult[0], message);
  assert.equal(decoderByteByByte.bufferedBytes, 0);
});

test("framing: parses multiple merged messages in a single chunk with remainder", () => {
  const decoder = new DapDecoder();

  const msg1 = { seq: 1, type: "request", command: "threads" };
  const msg2 = { seq: 2, type: "response", request_seq: 1, success: true, command: "threads", body: { threads: [] } };
  const msg3 = { seq: 3, type: "event", event: "terminated" };
  const msg4 = { seq: 4, type: "event", event: "exited", body: { exitCode: 0 } };

  const buf1 = encodeDapMessage(msg1);
  const buf2 = encodeDapMessage(msg2);
  const buf3 = encodeDapMessage(msg3);
  const buf4 = encodeDapMessage(msg4);

  // Merge msg1, msg2, msg3, plus first 10 bytes of msg4
  const merged = Buffer.concat([buf1, buf2, buf3, buf4.subarray(0, 10)]);

  const parsedBatch = decoder.push(merged);
  assert.equal(parsedBatch.length, 3);
  assert.deepEqual(parsedBatch[0], msg1);
  assert.deepEqual(parsedBatch[1], msg2);
  assert.deepEqual(parsedBatch[2], msg3);
  assert.equal(decoder.bufferedBytes, 10);

  // Feed remainder of msg4
  const remainder = decoder.push(buf4.subarray(10));
  assert.equal(remainder.length, 1);
  assert.deepEqual(remainder[0], msg4);
  assert.equal(decoder.bufferedBytes, 0);
});

test("framing: parses messages with optional Content-Type header and case-insensitive Content-Length", () => {
  const decoder = new DapDecoder();

  const bodyJson = JSON.stringify({ seq: 7, type: "event", event: "continued", body: { threadId: 1 } });
  const rawBytes = Buffer.from(
    `content-length: ${Buffer.byteLength(bodyJson, "utf8")}\r\n` +
    `Content-Type: application/json; charset=utf-8\r\n\r\n` +
    bodyJson,
    "utf8"
  );

  const parsed = decoder.push(rawBytes);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].seq, 7);
  assert.equal(parsed[0].event, "continued");
});

test("framing: rejects declared length exceeding 8 MiB before allocating payload", () => {
  const decoder = new DapDecoder();

  const oversizedLength = MAX_DAP_MESSAGE_BYTES + 1; // 8 MiB + 1 byte
  const headerOnly = Buffer.from(`Content-Length: ${oversizedLength}\r\n\r\n`, "utf8");

  assert.throws(
    () => {
      decoder.push(headerOnly);
    },
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /exceeds 8388608 byte limit/);
      return true;
    }
  );

  // Decoder buffer should be reset after error
  assert.equal(decoder.bufferedBytes, 0);
});

test("framing: rejects invalid or missing Content-Length header", () => {
  const decoder = new DapDecoder();

  assert.throws(
    () => {
      decoder.push(Buffer.from("X-Custom-Header: value\r\n\r\n{}", "utf8"));
    },
    /Missing or invalid Content-Length header/
  );

  assert.throws(
    () => {
      decoder.push(Buffer.from("Content-Length: not-a-number\r\n\r\n{}", "utf8"));
    },
    /Missing or invalid Content-Length header/
  );
});

test("framing: guards against unbounded header buffers without separator", () => {
  const decoder = new DapDecoder();

  const largeBogusHeader = Buffer.alloc(MAX_DAP_HEADER_BYTES + 10, "A");
  assert.throws(
    () => {
      decoder.push(largeBogusHeader);
    },
    /exceeded limit of 65536 bytes/
  );
  assert.equal(decoder.bufferedBytes, 0);
});

// -----------------------------------------------------------------------------
// Path Mapping Tests
// -----------------------------------------------------------------------------

test("path mapping: translates remote Linux paths to local paths", () => {
  const mappings = [
    {
      localRoot: "D:\\Packages\\project",
      remoteRoot: "/home/user/project",
    },
  ];

  // Exact root match
  assert.equal(
    mapRemoteToLocal("/home/user/project", mappings),
    "D:\\Packages\\project"
  );

  // Subpath match
  assert.equal(
    mapRemoteToLocal("/home/user/project/src/index.ts", mappings),
    "D:\\Packages\\project\\src\\index.ts"
  );

  // Sibling directory with shared prefix does NOT match (boundary protection)
  assert.equal(
    mapRemoteToLocal("/home/user/project-sibling/file.ts", mappings),
    null
  );
});

test("path mapping: translates local paths to remote Linux paths", () => {
  const mappings = [
    {
      localRoot: "D:\\Packages\\project",
      remoteRoot: "/home/user/project",
    },
  ];

  assert.equal(
    mapLocalToRemote("D:\\Packages\\project\\src\\main.py", mappings),
    "/home/user/project/src/main.py"
  );

  // Case-insensitive drive letter on Windows
  assert.equal(
    mapLocalToRemote("d:/packages/project/utils/helper.py", mappings),
    "/home/user/project/utils/helper.py"
  );

  // Unrelated local path returns null
  assert.equal(
    mapLocalToRemote("C:\\Windows\\System32\\cmd.exe", mappings),
    null
  );
});

test("path mapping: prefers the most specific mapping when roots nest", () => {
  const mappings = [
    { localRoot: "/local/root", remoteRoot: "/remote/root" },
    { localRoot: "/local/root/packages/sub", remoteRoot: "/remote/root/packages/sub" },
  ];

  assert.equal(
    mapRemoteToLocal("/remote/root/packages/sub/file.ts", mappings),
    "/local/root/packages/sub/file.ts"
  );
  assert.equal(
    mapRemoteToLocal("/remote/root/other/file.ts", mappings),
    "/local/root/other/file.ts"
  );
});

test("path mapping: returns unmapped paths as read-only remote sources rather than guessing", () => {
  const mappings = [
    {
      localRoot: "D:\\Packages\\project",
      remoteRoot: "/home/user/project",
    },
  ];

  const unmappedRemotePath = "/usr/lib/python3.10/json/__init__.py";

  const result = translateRemotePath(unmappedRemotePath, mappings);
  assert.equal(result.mapped, false);
  assert.equal(result.remotePath, unmappedRemotePath);
  assert.deepEqual(result.readOnlySource, {
    name: "__init__.py",
    path: unmappedRemotePath,
    readOnly: true,
    origin: "read-only remote source",
    presentationHint: "deemphasize",
  });

  // Test translateRemoteSource on unmapped source
  const unmappedSource = {
    name: "__init__.py",
    path: unmappedRemotePath,
  };
  const translatedUnmapped = translateRemoteSource(unmappedSource, mappings);
  assert.equal(translatedUnmapped.readOnly, true);
  assert.equal(translatedUnmapped.path, unmappedRemotePath);
  assert.equal(translatedUnmapped.origin, "read-only remote source");

  // Test translateRemoteSource on mapped source
  const mappedSource = {
    name: "index.ts",
    path: "/home/user/project/src/index.ts",
  };
  const translatedMapped = translateRemoteSource(mappedSource, mappings);
  assert.equal(translatedMapped.readOnly, false);
  assert.equal(translatedMapped.path, "D:\\Packages\\project\\src\\index.ts");
});

// -----------------------------------------------------------------------------
// DAP Client: Sequence Numbers, Correlation, and Lifecycle
// -----------------------------------------------------------------------------

test("client: sequence numbers increment from 1 and correlate to responses out of order", async () => {
  const decoder = new DapDecoder();
  const requestsReceived = [];

  const server = await startMockDapServer((socket) => {
    socket.on("data", (chunk) => {
      const msgs = decoder.push(chunk);
      for (const msg of msgs) {
        requestsReceived.push(msg);
        if (msg.command === "disconnect") {
          socket.write(
            encodeDapMessage({
              seq: 99,
              type: "response",
              request_seq: msg.seq,
              command: "disconnect",
              success: true,
            })
          );
        }
      }
    });
  });

  const client = new DapClient();
  await client.connect({ port: server.port });
  const serverSocket = await server.waitForConnection();
  assert.equal(client.currentState, "connected");

  // Send two concurrent requests
  const promise1 = client.threads();
  const promise2 = client.scopes({ frameId: 100 });

  // Wait until server has received both requests
  while (requestsReceived.length < 2) {
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.equal(requestsReceived[0].seq, 1);
  assert.equal(requestsReceived[0].command, "threads");
  assert.equal(requestsReceived[1].seq, 2);
  assert.equal(requestsReceived[1].command, "scopes");

  // Server answers seq 2 FIRST (out of order)
  serverSocket.write(
    encodeDapMessage({
      seq: 10,
      type: "response",
      request_seq: 2,
      command: "scopes",
      success: true,
      body: { scopes: [{ name: "Locals", variablesReference: 1, expensive: false }] },
    })
  );

  // Server answers seq 1 SECOND
  serverSocket.write(
    encodeDapMessage({
      seq: 11,
      type: "response",
      request_seq: 1,
      command: "threads",
      success: true,
      body: { threads: [{ id: 1, name: "main" }] },
    })
  );

  const [res1, res2] = await Promise.all([promise1, promise2]);

  assert.deepEqual(res1, { threads: [{ id: 1, name: "main" }] });
  assert.deepEqual(res2, {
    scopes: [{ name: "Locals", variablesReference: 1, expensive: false }],
  });
  assert.equal(client.pendingCount, 0);

  await client.disconnect();
  await server.close();
});

test("client: never leaks a pending entry on request timeout settlement", async () => {
  const server = await startMockDapServer((socket) => {
    // Deliberately do not reply to requests
  });

  const client = new DapClient({ defaultTimeoutMs: 50 });
  await client.connect({ port: server.port });

  assert.equal(client.pendingCount, 0);

  await assert.rejects(
    () => client.threads(),
    (err) => {
      assert.match(err.message, /timed out after 50ms/);
      return true;
    }
  );

  // Assert pending entry is purged cleanly
  assert.equal(client.pendingCount, 0);

  await client.disconnect();
  await server.close();
});

test("client: rejects in-flight requests and cleans up without leaking when socket closes", async () => {
  const server = await startMockDapServer(() => {});

  const client = new DapClient({ defaultTimeoutMs: 5_000 });
  await client.connect({ port: server.port });
  const serverSocket = await server.waitForConnection();

  const inFlight = client.threads();
  assert.equal(client.pendingCount, 1);

  // Server abruptly destroys socket
  serverSocket.destroy();

  await assert.rejects(
    () => inFlight,
    (err) => {
      assert.match(err.message, /DAP socket closed|ECONNRESET/);
      return true;
    }
  );

  assert.equal(client.pendingCount, 0);
  assert.equal(client.currentState, "disconnected");

  await client.close();
  await server.close();
});

test("client: enforces hard cap on concurrent pending requests", async () => {
  const server = await startMockDapServer(() => {});

  const client = new DapClient({ maxPendingRequests: 3, defaultTimeoutMs: 5_000 });
  await client.connect({ port: server.port });

  const p1 = client.threads();
  const p2 = client.threads();
  const p3 = client.threads();

  assert.equal(client.pendingCount, 3);

  // 4th request must immediately reject due to concurrency limit
  await assert.rejects(
    () => client.threads(),
    /Maximum concurrent pending DAP requests reached \(3\)/
  );

  assert.equal(client.pendingCount, 3);

  await client.close();
  // In-flight promises should reject on close
  await Promise.allSettled([p1, p2, p3]);
  assert.equal(client.pendingCount, 0);
  await server.close();
});

test("client: full session lifecycle and SSH forward closure", async () => {
  const decoder = new DapDecoder();
  const receivedCommands = [];

  const server = await startMockDapServer((socket) => {
    socket.on("data", (chunk) => {
      for (const msg of decoder.push(chunk)) {
        receivedCommands.push(msg.command);
        if (msg.command === "initialize") {
          socket.write(
            encodeDapMessage({
              seq: 100,
              type: "response",
              request_seq: msg.seq,
              command: "initialize",
              success: true,
              body: { supportsConfigurationDoneRequest: true },
            })
          );
        } else if (msg.command === "setBreakpoints") {
          assert.equal(msg.arguments.source.path, "/remote/root/src/app.py");
          socket.write(
            encodeDapMessage({
              seq: 101,
              type: "response",
              request_seq: msg.seq,
              command: "setBreakpoints",
              success: true,
              body: {
                breakpoints: [
                  {
                    id: 1,
                    verified: true,
                    line: 10,
                    source: { path: "/remote/root/src/app.py" },
                  },
                ],
              },
            })
          );
        } else if (msg.command === "configurationDone") {
          socket.write(
            encodeDapMessage({
              seq: 102,
              type: "response",
              request_seq: msg.seq,
              command: "configurationDone",
              success: true,
              body: {},
            })
          );
        } else if (msg.command === "continue") {
          socket.write(
            encodeDapMessage({
              seq: 103,
              type: "response",
              request_seq: msg.seq,
              command: "continue",
              success: true,
              body: { allThreadsContinued: true },
            })
          );
        } else if (msg.command === "disconnect") {
          socket.write(
            encodeDapMessage({
              seq: 104,
              type: "response",
              request_seq: msg.seq,
              command: "disconnect",
              success: true,
            })
          );
        }
      }
    });
  });

  let forwardClosed = false;
  const mockSshForward = {
    localPort: server.port,
    async close() {
      forwardClosed = true;
    },
  };

  const pathMappings = [
    { localRoot: "D:\\code\\app", remoteRoot: "/remote/root" },
  ];

  const client = createDapClient({
    forward: mockSshForward,
    pathMappings,
  });

  // 1. connect
  await client.connect();
  assert.equal(client.currentState, "connected");

  // 2. initialize
  const capabilities = await client.initialize();
  assert.equal(client.currentState, "initialized");
  assert.equal(capabilities.supportsConfigurationDoneRequest, true);

  // 3. setBreakpoints (local path translated to remote)
  const bpResult = await client.setBreakpoints({
    source: { path: "D:\\code\\app\\src\\app.py" },
    breakpoints: [{ line: 10 }],
  });
  assert.equal(bpResult.breakpoints.length, 1);
  assert.equal(bpResult.breakpoints[0].verified, true);
  // Source returned translated back to local path
  assert.equal(bpResult.breakpoints[0].source.path, "D:\\code\\app\\src\\app.py");

  // 4. configurationDone
  await client.configurationDone();
  assert.equal(client.currentState, "configured");

  // 5. run
  await client.run(1);
  assert.equal(client.currentState, "running");

  // 6. disconnect
  await client.disconnect();
  assert.equal(client.currentState, "disconnected");
  assert.equal(forwardClosed, true);

  assert.deepEqual(receivedCommands, [
    "initialize",
    "setBreakpoints",
    "configurationDone",
    "continue",
    "disconnect",
  ]);

  await server.close();
});

test("client: handles events and translates output/stackTrace paths correctly", async () => {
  const decoder = new DapDecoder();

  const server = await startMockDapServer((socket) => {
    socket.on("data", (chunk) => {
      for (const msg of decoder.push(chunk)) {
        if (msg.command === "disconnect") {
          socket.write(
            encodeDapMessage({
              seq: 201,
              type: "response",
              request_seq: msg.seq,
              command: "disconnect",
              success: true,
            })
          );
        } else if (msg.command === "stackTrace") {
          socket.write(
            encodeDapMessage({
              seq: 200,
              type: "response",
              request_seq: msg.seq,
              command: "stackTrace",
              success: true,
              body: {
                totalFrames: 2,
                stackFrames: [
                  {
                    id: 1,
                    name: "calculate",
                    line: 25,
                    column: 5,
                    source: {
                      name: "calc.ts",
                      path: "/var/remote/src/calc.ts",
                    },
                  },
                  {
                    id: 2,
                    name: "<module>",
                    line: 102,
                    column: 1,
                    source: {
                      name: "loader.py",
                      path: "/usr/lib/python3.10/loader.py",
                    },
                  },
                ],
              },
            })
          );
        }
      }
    });
  });

  const pathMappings = [
    { localRoot: "/workspace/my-app", remoteRoot: "/var/remote" },
  ];

  const client = new DapClient({ pathMappings });
  await client.connect({ port: server.port });
  const serverSocket = await server.waitForConnection();
  const events = [];
  client.onStopped((body) => events.push({ type: "stopped", body }));
  client.onOutput((body) => events.push({ type: "output", body }));
  client.onContinued((body) => events.push({ type: "continued", body }));

  // Send stopped event from server
  serverSocket.write(
    encodeDapMessage({
      seq: 50,
      type: "event",
      event: "stopped",
      body: { reason: "breakpoint", threadId: 1 },
    })
  );

  // Send output event with unmapped source
  serverSocket.write(
    encodeDapMessage({
      seq: 51,
      type: "event",
      event: "output",
      body: {
        category: "stdout",
        output: "Debug log line\n",
        source: { path: "/usr/lib/python3.10/os.py" },
      },
    })
  );

  // Send continued event
  serverSocket.write(
    encodeDapMessage({
      seq: 52,
      type: "event",
      event: "continued",
      body: { threadId: 1 },
    })
  );

  // Wait for events to be processed
  while (events.length < 3) {
    await new Promise((r) => setTimeout(r, 10));
  }

  assert.equal(events[0].type, "stopped");
  assert.equal(events[0].body.reason, "breakpoint");
  assert.equal(client.currentState, "running"); // transitioned stopped -> continued

  assert.equal(events[1].type, "output");
  assert.equal(events[1].body.source.readOnly, true);
  assert.equal(events[1].body.source.path, "/usr/lib/python3.10/os.py");

  // Call stackTrace and verify frame path translations
  const stack = await client.stackTrace({ threadId: 1 });
  assert.equal(stack.stackFrames.length, 2);

  // Frame 1 is mapped
  assert.equal(stack.stackFrames[0].source.path, "/workspace/my-app/src/calc.ts");
  assert.equal(stack.stackFrames[0].source.readOnly, false);

  // Frame 2 is unmapped -> read-only remote source
  assert.equal(stack.stackFrames[1].source.path, "/usr/lib/python3.10/loader.py");
  assert.equal(stack.stackFrames[1].source.readOnly, true);
  assert.equal(stack.stackFrames[1].source.origin, "read-only remote source");

  await client.disconnect();
  await server.close();
});
