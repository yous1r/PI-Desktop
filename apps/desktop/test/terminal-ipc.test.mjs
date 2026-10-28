import assert from "node:assert/strict";
import test from "node:test";

const { registerTerminalIpc } = await import("../electron/main/ipc/terminal-ipc.ts");

/**
 * The IPC layer owns sender authentication, argument validation, and error-code
 * mapping; the PTY service and shell registry are stubbed so these tests
 * describe the wire contract the renderer depends on.
 */

const CMD = { id: "cmd", label: "Command Prompt", path: "C:\\cmd.exe", family: "cmd" };
const MAIN_WINDOW = { id: 1 };

function harness(overrides = {}) {
  const handlers = new Map();
  const calls = [];
  const denied = [];
  const registry = {
    listShells: (refresh) => {
      calls.push(["listShells", refresh]);
      return [CMD];
    },
    find: (id) => (id === "cmd" ? CMD : undefined),
    ...overrides.registry,
  };
  const service = {
    create: (profile, cwd, size) => {
      calls.push(["create", profile.id, cwd, size]);
      return { terminalId: "term_1", shellId: profile.id, cols: size.cols, rows: size.rows };
    },
    write: (id, data) => calls.push(["write", id, data]),
    resize: (id, cols, rows) => calls.push(["resize", id, cols, rows]),
    close: (id) => calls.push(["close", id]),
    getBuffer: (id, maxBytes) => {
      calls.push(["getBuffer", id, maxBytes]);
      return "buffered";
    },
    ...overrides.service,
    replay: (id, maxBytes) => {
      calls.push(["replay", id, maxBytes]);
      return overrides.replayResult === undefined ? "cmVwbGF5" : overrides.replayResult;
    },
  };

  registerTerminalIpc({
    registrar: {
      handle: () => {
        throw new Error("terminal channels must authenticate the sender");
      },
      handleWithEvent: (channel, handler) => handlers.set(channel, handler),
      assertMainWindowSender: (event) => {
        if (event !== MAIN_WINDOW) {
          denied.push(event);
          throw Object.assign(new Error("renderer is not the main window"), {
            errorCode: "PERMISSION_DENIED",
          });
        }
      },
      ipcMain: {},
    },
    registry,
    service,
    defaultCwd: overrides.defaultCwd ?? (() => "C:\\workspace"),
    isAllowedCwd: overrides.isAllowedCwd,
  });

  const invoke = (channel, input, event = MAIN_WINDOW) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `channel ${channel} must be registered`);
    return handler(event, input);
  };
  return { invoke, calls, handlers, denied };
}

const CH = {
  listShells: "pi-desktop/terminal/listShells",
  create: "pi-desktop/terminal/create",
  write: "pi-desktop/terminal/write",
  resize: "pi-desktop/terminal/resize",
  close: "pi-desktop/terminal/close",
  getBuffer: "pi-desktop/terminal/getBuffer",
  replay: "pi-desktop/terminal/replay",
};

test("every terminal channel is registered and authenticates the sender", async () => {
  const { invoke, handlers, denied } = harness();
  for (const channel of Object.values(CH)) {
    assert.ok(handlers.has(channel), `${channel} must be registered`);
  }
  // A launcher or widget window shares the preload but never owns a terminal.
  for (const channel of Object.values(CH)) {
    await assert.rejects(
      () => invoke(channel, { terminalId: "term_1", shellId: "cmd", data: "x" }, { id: 99 }),
      (error) => error.errorCode === "PERMISSION_DENIED",
    );
  }
  assert.equal(denied.length, Object.values(CH).length);
});

test("listShells caches unless the caller asks for a refresh", async () => {
  const { invoke, calls } = harness();

  await invoke(CH.listShells, undefined);
  await invoke(CH.listShells, { refresh: false });
  await invoke(CH.listShells, { refresh: true });

  assert.deepEqual(calls, [
    ["listShells", false],
    ["listShells", false],
    ["listShells", true],
  ]);
});

test("create resolves the requested shell and passes the size", async () => {
  const { invoke, calls } = harness();

  const result = await invoke(CH.create, { shellId: "cmd", cols: 100, rows: 30 });

  assert.equal(result.terminalId, "term_1");
  assert.deepEqual(calls, [["create", "cmd", "C:\\workspace", { cols: 100, rows: 30 }]]);
});

test("create prefers an explicit cwd inside the workspace", async () => {
  const { invoke, calls } = harness({ isAllowedCwd: () => true });
  await invoke(CH.create, { shellId: "cmd", cwd: "C:\\workspace\\src", cols: 80, rows: 24 });
  assert.deepEqual(calls, [["create", "cmd", "C:\\workspace\\src", { cols: 80, rows: 24 }]]);
});

test("create refuses a cwd outside the workspace", async () => {
  const { invoke, calls } = harness({ isAllowedCwd: () => false });

  await assert.rejects(
    () => invoke(CH.create, { shellId: "cmd", cwd: "C:\\Windows\\System32", cols: 80, rows: 24 }),
    (error) => error.errorCode === "PERMISSION_REQUIRED",
  );
  assert.deepEqual(calls, [], "an out-of-workspace cwd must not reach the pty");
});

test("create defaults to 80x24 when the renderer omits a size", async () => {
  const { invoke, calls } = harness();
  await invoke(CH.create, { shellId: "cmd" });
  assert.deepEqual(calls, [["create", "cmd", "C:\\workspace", { cols: 80, rows: 24 }]]);
});

test("create rejects an unknown shell id with NOT_FOUND", async () => {
  const { invoke } = harness();
  await assert.rejects(
    () => invoke(CH.create, { shellId: "nope", cols: 80, rows: 24 }),
    (error) => error.errorCode === "NOT_FOUND",
  );
});

test("create rejects a missing shell id with INVALID_ARGUMENT", async () => {
  const { invoke } = harness();
  await assert.rejects(
    () => invoke(CH.create, {}),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
});

test("create rejects a nonsensical size before reaching the pty", async () => {
  const { invoke, calls } = harness();
  await assert.rejects(
    () => invoke(CH.create, { shellId: "cmd", cols: 0, rows: 24 }),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
  assert.deepEqual(calls, []);
});

test("write forwards empty keystrokes but rejects a non-string payload", async () => {
  const { invoke, calls } = harness();

  await invoke(CH.write, { terminalId: "term_1", data: "ls\r" });
  assert.deepEqual(calls, [["write", "term_1", "ls\r"]]);

  await invoke(CH.write, { terminalId: "term_1", data: "" });
  assert.deepEqual(calls.at(-1), ["write", "term_1", ""]);

  await assert.rejects(
    () => invoke(CH.write, { terminalId: "term_1" }),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
  await assert.rejects(
    () => invoke(CH.write, { data: "ls" }),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
});

test("resize forwards cols and rows", async () => {
  const { invoke, calls } = harness();
  await invoke(CH.resize, { terminalId: "term_1", cols: 132, rows: 43 });
  assert.deepEqual(calls, [["resize", "term_1", 132, 43]]);
});

test("close forwards the terminal id", async () => {
  const { invoke, calls } = harness();
  await invoke(CH.close, { terminalId: "term_1" });
  assert.deepEqual(calls, [["close", "term_1"]]);
});

test("getBuffer clamps maxBytes to the ring ceiling", async () => {
  const { invoke, calls } = harness();

  await invoke(CH.getBuffer, { terminalId: "term_1", maxBytes: 1024 });
  assert.deepEqual(calls.at(-1), ["getBuffer", "term_1", 1024]);

  await invoke(CH.getBuffer, { terminalId: "term_1", maxBytes: 10 * 1024 * 1024 });
  assert.deepEqual(calls.at(-1), ["getBuffer", "term_1", 256 * 1024]);

  await invoke(CH.getBuffer, { terminalId: "term_1" });
  assert.deepEqual(calls.at(-1), ["getBuffer", "term_1", undefined]);
});

test("getBuffer ignores a sub-byte maxBytes instead of returning nothing", async () => {
  const { invoke, calls } = harness();
  await invoke(CH.getBuffer, { terminalId: "term_1", maxBytes: 0.5 });
  assert.deepEqual(calls.at(-1), ["getBuffer", "term_1", undefined]);
});

test("getBuffer requires a terminal id", async () => {
  const { invoke } = harness();
  await assert.rejects(
    () => invoke(CH.getBuffer, {}),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
});

test("replay returns the raw base64 buffer so a re-attached view can restore colors", async () => {
  const { invoke, calls } = harness();

  const result = await invoke(CH.replay, { terminalId: "term_1", maxBytes: 2048 });

  assert.deepEqual(calls.at(-1), ["replay", "term_1", 2048]);
  assert.deepEqual(result, { data: "cmVwbGF5" });
});

test("replay clamps maxBytes to the ring ceiling", async () => {
  const { invoke, calls } = harness();
  await invoke(CH.replay, { terminalId: "term_1", maxBytes: 10 * 1024 * 1024 });
  assert.deepEqual(calls.at(-1), ["replay", "term_1", 256 * 1024]);
});

test("replay passes a null through so the renderer knows to restart the shell", async () => {
  const { invoke } = harness({ replayResult: null });
  const result = await invoke(CH.replay, { terminalId: "term_gone" });
  assert.deepEqual(result, { data: null });
});

test("replay requires a terminal id", async () => {
  const { invoke } = harness();
  await assert.rejects(
    () => invoke(CH.replay, {}),
    (error) => error.errorCode === "INVALID_ARGUMENT",
  );
});
