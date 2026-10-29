import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REMOTE_RUN_COMMAND_CHARS,
  createRemoteRunManager,
  parseRemoteRunRequest,
  validateRemoteRunCommand,
  validateRemoteRunPath,
} from "../electron/main/mirror/remote-run.ts";

const PROJECT = "project-1";
const HOST = "host-key-1";
const MIRROR = "/srv/mirror/app";

/** A transport seam that records calls and lets the test drive the "host". */
function fakeTransport() {
  const calls = [];
  return {
    calls,
    spawn(target, handlers) {
      const call = { target, handlers, killed: 0, onKill: null };
      calls.push(call);
      return {
        kill() {
          call.killed += 1;
          if (call.onKill) call.onKill();
        },
      };
    },
  };
}

function request(overrides = {}) {
  return {
    projectId: PROJECT,
    hostKey: HOST,
    remotePath: MIRROR,
    command: "pnpm build",
    kind: "build",
    ...overrides,
  };
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.errorCode, code);
    return true;
  });
}

test("streams stdout and stderr in arrival order and settles once", async () => {
  const transport = fakeTransport();
  const manager = createRemoteRunManager({ spawn: transport.spawn, newId: () => "run-1" });
  const handle = await manager.start(request());

  assert.equal(handle.id, "run-1");
  assert.equal(handle.kind, "build");
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(transport.calls[0].target, request());

  const { handlers } = transport.calls[0];
  const collected = [];
  const consumer = (async () => {
    for await (const chunk of handle.chunks) collected.push(chunk);
  })();

  handlers.stdout(Buffer.from("line 1\n"));
  handlers.stderr(Buffer.from("warn\n"));
  handlers.stdout(Buffer.from("line 2\n"));
  handlers.exit(0);

  const outcome = await handle.outcome;
  await consumer;

  assert.deepEqual(collected, [
    { stream: "stdout", text: "line 1\n" },
    { stream: "stderr", text: "warn\n" },
    { stream: "stdout", text: "line 2\n" },
  ]);
  assert.deepEqual(outcome, {
    status: "succeeded",
    code: 0,
    kind: "build",
    bytes: 19,
    truncated: false,
  });
  // The project slot is free again once the run settled.
  await manager.start(request({ kind: "run", command: "pnpm start" }));
});

test("output that arrived before the caller iterated is delivered in order", async () => {
  const transport = fakeTransport();
  const manager = createRemoteRunManager({ spawn: transport.spawn });
  const handle = await manager.start(request());
  const { handlers } = transport.calls[0];

  handlers.stdout(Buffer.from("a"));
  handlers.stderr(Buffer.from("b"));
  handlers.stdout(Buffer.from("c"));
  handlers.exit(0);

  assert.deepEqual(await collect(handle.chunks), [
    { stream: "stdout", text: "a" },
    { stream: "stderr", text: "b" },
    { stream: "stdout", text: "c" },
  ]);
  assert.equal((await handle.outcome).status, "succeeded");
});

test("a multi-byte character split across chunks is reassembled, not mangled", async () => {
  const transport = fakeTransport();
  const manager = createRemoteRunManager({ spawn: transport.spawn });
  const handle = await manager.start(request());
  const { handlers } = transport.calls[0];
  const euro = Buffer.from("€", "utf8");

  handlers.stdout(euro.subarray(0, 1));
  handlers.stdout(euro.subarray(1));
  handlers.exit(0);

  assert.deepEqual(await collect(handle.chunks), [{ stream: "stdout", text: "€" }]);
  const outcome = await handle.outcome;
  assert.equal(outcome.bytes, euro.byteLength);
  assert.equal(outcome.status, "succeeded");
});

test("a non-zero exit is a failed outcome, not a rejected handle", async () => {
  const transport = fakeTransport();
  const manager = createRemoteRunManager({ spawn: transport.spawn });
  const handle = await manager.start(request({ kind: "run", command: "make test" }));

  transport.calls[0].handlers.exit(2);

  assert.deepEqual(await handle.outcome, {
    status: "failed",
    code: 2,
    kind: "run",
    bytes: 0,
    truncated: false,
  });
});

test("rejects unusable requests before anything starts on the host", async () => {
  const transport = fakeTransport();
  const manager = createRemoteRunManager({ spawn: transport.spawn });
  const cases = [
    [{ command: "" }, "INVALID_ARGUMENT"],
    [{ command: "   " }, "INVALID_ARGUMENT"],
    [{ command: "pnpm build\nrm -rf /" }, "INVALID_ARGUMENT"],
    [{ command: "pnpm\u0000build" }, "INVALID_ARGUMENT"],
    [{ command: `pnpm ${"a".repeat(MAX_REMOTE_RUN_COMMAND_CHARS)}` }, "INVALID_ARGUMENT"],
    [{ remotePath: "srv/mirror/app" }, "INVALID_ARGUMENT"],
    [{ remotePath: "" }, "INVALID_ARGUMENT"],
    [{ remotePath: "//srv/mirror/app" }, "INVALID_ARGUMENT"],
    [{ remotePath: "/srv/../../etc" }, "REMOTE_PATH_ESCAPE"],
    [{ remotePath: "/srv/mirror\\app" }, "REMOTE_PATH_ESCAPE"],
    [{ remotePath: "/srv/mirror/app\n" }, "REMOTE_PATH_ESCAPE"],
    [{ kind: "test" }, "INVALID_ARGUMENT"],
    [{ projectId: "  " }, "INVALID_ARGUMENT"],
    [{ hostKey: "" }, "INVALID_ARGUMENT"],
  ];

  for (const [overrides, code] of cases) {
    await rejectsWithCode(manager.start(request(overrides)), code);
  }
  assert.equal(transport.calls.length, 0, "no rejected request reaches the host");
});

test("validators keep an absolute mirror root and trim the command", () => {
  assert.equal(validateRemoteRunPath("/home/user/My Projects/app"), "/home/user/My Projects/app");
  assert.equal(validateRemoteRunCommand("  pnpm build  "), "pnpm build");
  assert.deepEqual(parseRemoteRunRequest(request({ command: " pnpm build " })), {
    projectId: PROJECT,
    hostKey: HOST,
    remotePath: MIRROR,
    command: "pnpm build",
    kind: "build",
  });
  // `..` is refused rather than normalised, and a relative root is refused outright.
  assert.throws(() => validateRemoteRunPath("/srv/../etc"), { errorCode: "REMOTE_PATH_ESCAPE" });
  assert.throws(() => validateRemoteRunPath("srv/app"), { errorCode: "INVALID_ARGUMENT" });
});

test("a second start for the same project rejects instead of queueing", async () => {
  const transport = fakeTransport();
  const manager = createRemoteRunManager({ spawn: transport.spawn });
  const first = await manager.start(request());

  await rejectsWithCode(manager.start(request({ kind: "run", command: "pnpm start" })), "CONFLICT");
  assert.equal(transport.calls.length, 1, "the rejected start never reached the host");

  // A different project is a different slot.
  await manager.start(request({ projectId: "project-2" }));
  assert.equal(transport.calls.length, 2);

  transport.calls[0].handlers.exit(0);
  await first.outcome;
  // Once settled, the project may run again.
  await manager.start(request());
});

test("the memory cap keeps streaming and then marks the run truncated", async () => {
  const transport = fakeTransport();
  const manager = createRemoteRunManager({ spawn: transport.spawn, maxBufferedBytes: 64 });
  const handle = await manager.start(request());
  const { handlers } = transport.calls[0];

  const kept = "x".repeat(40);
  handlers.stdout(Buffer.from(kept));
  handlers.stdout(Buffer.from("y".repeat(40)));
  handlers.stdout(Buffer.from("z"));
  handlers.exit(0);

  assert.deepEqual(await collect(handle.chunks), [{ stream: "stdout", text: kept }]);
  const outcome = await handle.outcome;
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.bytes, 81, "the byte count still reflects everything the host wrote");
  assert.equal(outcome.status, "succeeded");
});

test("output nobody consumes is bounded by the cap", async () => {
  const transport = fakeTransport();
  const manager = createRemoteRunManager({ spawn: transport.spawn, maxBufferedBytes: 1_000 });
  const handle = await manager.start(request());
  const { handlers } = transport.calls[0];

  for (let index = 0; index < 200; index += 1) handlers.stdout(Buffer.from("a".repeat(100)));
  handlers.exit(0);

  const delivered = await collect(handle.chunks);
  const retained = delivered.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text, "utf8"), 0);
  assert.ok(retained <= 1_000, `retained ${retained} bytes`);
  assert.ok(delivered.length > 0, "the first chunks are still delivered");
  assert.equal((await handle.outcome).truncated, true);
});

test("cancel terminates the remote command and settles the handle once", async () => {
  const transport = fakeTransport();
  const manager = createRemoteRunManager({ spawn: transport.spawn });
  const handle = await manager.start(request({ kind: "run", command: "pnpm start" }));
  const call = transport.calls[0];

  const collected = [];
  const consumer = (async () => {
    for await (const chunk of handle.chunks) collected.push(chunk);
  })();
  call.handlers.stdout(Buffer.from("listening\n"));
  call.onKill = () => call.handlers.exit(143);

  await handle.cancel();
  await handle.cancel();

  assert.equal(call.killed, 1, "kill reaches the transport exactly once");
  assert.deepEqual(await handle.outcome, {
    status: "cancelled",
    code: 143,
    kind: "run",
    bytes: 10,
    truncated: false,
  });
  await consumer;
  assert.deepEqual(collected, [{ stream: "stdout", text: "listening\n" }]);

  // A cancelled run frees the project slot too.
  await manager.start(request());
});

test("a transport failure is a typed error that never quotes the command", async () => {
  const transport = fakeTransport();
  const manager = createRemoteRunManager({ spawn: transport.spawn });
  const handle = await manager.start(request({ command: "pnpm --filter secret-token build" }));
  const { handlers } = transport.calls[0];

  handlers.stdout(Buffer.from("partial\n"));
  handlers.fail();

  await assert.rejects(handle.outcome, (error) => {
    assert.equal(error.errorCode, "REMOTE_CONNECTION_FAILED");
    assert.ok(!error.message.includes("pnpm"), "the command line is not leaked");
    assert.ok(!error.message.includes(MIRROR), "the remote path is not leaked");
    return true;
  });
  // The buffered output is still delivered, then the same typed error ends it.
  await assert.rejects(collect(handle.chunks), { errorCode: "REMOTE_CONNECTION_FAILED" });
});

test("a spawn that throws rejects with a typed error and releases the project slot", async () => {
  let attempts = 0;
  const transport = fakeTransport();
  const manager = createRemoteRunManager({
    spawn(target, handlers) {
      attempts += 1;
      if (attempts === 1) throw new Error(`ssh -i /home/u/.ssh/id_ed25519 root@host ${target.command}`);
      return transport.spawn(target, handlers);
    },
  });

  await assert.rejects(manager.start(request()), (error) => {
    assert.equal(error.errorCode, "REMOTE_CONNECTION_FAILED");
    assert.ok(!error.message.includes("id_ed25519"), "ssh argv is not leaked");
    return true;
  });

  const handle = await manager.start(request());
  assert.equal(transport.calls.length, 1);
  transport.calls[0].handlers.exit(0);
  assert.equal((await handle.outcome).status, "succeeded");
});

test("dispose cancels every live run and refuses new starts", async () => {
  const transport = fakeTransport();
  const manager = createRemoteRunManager({ spawn: transport.spawn });
  const first = await manager.start(request());
  const second = await manager.start(request({ projectId: "project-2", kind: "run", command: "pnpm start" }));
  for (const call of transport.calls) call.onKill = () => call.handlers.exit(143);

  await manager.dispose();
  await manager.dispose();

  assert.equal(transport.calls[0].killed, 1);
  assert.equal(transport.calls[1].killed, 1);
  assert.equal((await first.outcome).status, "cancelled");
  assert.equal((await second.outcome).status, "cancelled");
  await rejectsWithCode(manager.start(request()), "HOST_SHUTTING_DOWN");
});
