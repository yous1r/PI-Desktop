import assert from "node:assert/strict";
import test from "node:test";

const {
  TerminalService,
  shellEnv,
  stripAnsiCodes,
  TERMINAL_MAX_PER_WINDOW,
} = await import("../electron/main/terminal/terminal-service.ts");

const PROFILE = {
  id: "cmd",
  label: "Command Prompt",
  path: "C:\\Windows\\System32\\cmd.exe",
  family: "cmd",
};

/**
 * A controllable node-pty stand-in: the test drives output and exit, and
 * asserts on what the service wrote back to the child process.
 */
function fakePty() {
  const dataListeners = new Set();
  const exitListeners = new Set();
  const pty = {
    pid: 4242,
    written: [],
    resized: [],
    killed: false,
    write(data) {
      pty.written.push(data);
    },
    resize(cols, rows) {
      pty.resized.push([cols, rows]);
    },
    kill() {
      pty.killed = true;
    },
    onData(listener) {
      dataListeners.add(listener);
      return {
        dispose() {
          dataListeners.delete(listener);
        },
      };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return {
        dispose() {
          exitListeners.delete(listener);
        },
      };
    },
  };
  return {
    pty,
    emitData: (text) => [...dataListeners].forEach((listener) => listener(text)),
    emitExit: (exitCode) => [...exitListeners].forEach((listener) => listener({ exitCode })),
    listenerCounts: () => ({ data: dataListeners.size, exit: exitListeners.size }),
  };
}

function harness(options = {}) {
  const sent = [];
  const spawns = [];
  const handle = fakePty();
  const service = new TerminalService({
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
    }),
    loadPty: () => ({
      spawn(file, args, spawnOptions) {
        spawns.push({ file, args, spawnOptions });
        return handle.pty;
      },
    }),
    ...options,
  });
  return { service, sent, spawns, handle };
}

test("create spawns the resolved profile with a clamped size and registers it", () => {
  const { service, spawns } = harness();
  const opened = service.create(PROFILE, "C:\\work", { cols: 120, rows: 40 });

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].file, PROFILE.path);
  assert.deepEqual(spawns[0].args, []);
  assert.equal(spawns[0].spawnOptions.cols, 120);
  assert.equal(spawns[0].spawnOptions.rows, 40);
  assert.equal(spawns[0].spawnOptions.cwd, "C:\\work");
  assert.equal(spawns[0].spawnOptions.name, "xterm-256color");

  assert.equal(opened.shellId, "cmd");
  assert.equal(opened.cols, 120);
  assert.match(opened.terminalId, /^term_/);
  assert.deepEqual(service.list(), [
    { id: opened.terminalId, shellId: "cmd", cols: 120, rows: 40 },
  ]);
});

test("the child shell never inherits app-private environment variables", () => {
  const { service, spawns } = harness();
  service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });

  const env = spawns[0].spawnOptions.env;
  assert.equal(env.TERM, "xterm-256color");
  for (const key of Object.keys(env)) {
    assert.equal(key.startsWith("PI_DESKTOP_"), false, `${key} must not leak into the shell`);
  }
});

test("shellEnv keeps ordinary variables and forces TERM", () => {
  const env = shellEnv({
    PATH: "/usr/bin",
    HOME: "/home/user",
    PI_DESKTOP_PROXY_JSON: '{"proxy":"http://user:pass@host"}',
    PI_DESKTOP_DATA_DIR: "C:\\data",
    TERM: "dumb",
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/home/user");
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.PI_DESKTOP_PROXY_JSON, undefined);
  assert.equal(env.PI_DESKTOP_DATA_DIR, undefined);
});

test("create clamps an out-of-range size instead of trusting the renderer", () => {
  const { service, spawns } = harness();
  service.create(PROFILE, undefined, { cols: 0, rows: 10_000 });
  assert.equal(spawns[0].spawnOptions.cols, 2);
  assert.equal(spawns[0].spawnOptions.rows, 300);
});

test("create falls back to the process cwd when no workspace is active", () => {
  const { service, spawns } = harness();
  service.create(PROFILE, undefined, { cols: 80, rows: 24 });
  assert.equal(spawns[0].spawnOptions.cwd, process.cwd());
});

test("pty output is forwarded as one base64 event per chunk", () => {
  const { service, sent, handle } = harness();
  const { terminalId } = service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });

  handle.emitData("hello");
  handle.emitData(" world");

  assert.equal(sent.length, 2);
  assert.equal(sent[0].payload.terminalId, terminalId);
  assert.equal(Buffer.from(sent[0].payload.data, "base64").toString("utf8"), "hello");
  assert.equal(Buffer.from(sent[1].payload.data, "base64").toString("utf8"), " world");
});

test("getBuffer replays the ring with ANSI sequences stripped", () => {
  const { service, handle } = harness();
  const { terminalId } = service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });

  handle.emitData("\u001b[32mgreen\u001b[0m");
  handle.emitData("\r\nplain");

  const text = service.getBuffer(terminalId);
  assert.equal(text.includes("\u001b"), false);
  assert.match(text, /green/);
  assert.match(text, /plain/);
});

test("replay returns raw bytes with ANSI intact so a re-attached view keeps colors", () => {
  const { service, handle } = harness();
  const { terminalId } = service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });

  handle.emitData("\u001b[32mgreen\u001b[0m");
  handle.emitData("\r\nplain");

  const data = service.replay(terminalId);
  assert.equal(typeof data, "string");
  const raw = Buffer.from(data, "base64").toString("utf8");
  // The whole point of `replay` over `getBuffer`: escapes survive, so the
  // re-attached terminal renders the same colors it had before detaching.
  assert.equal(raw.includes("\u001b[32m"), true, `replay must keep ANSI: ${raw}`);
  assert.match(raw, /green/);
  assert.match(raw, /plain/);
  assert.equal(service.getBuffer(terminalId).includes("\u001b"), false);
});

test("replay is null once the shell exited, so the tab starts a fresh one", () => {
  const { service, handle } = harness();
  const { terminalId } = service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });
  handle.emitData("output");

  handle.emitExit(0);

  assert.equal(service.replay(terminalId), null);
});

test("replay is null for an unknown terminal instead of throwing", () => {
  const { service } = harness();
  assert.equal(service.replay("term_missing"), null);
});

test("replay honors a byte limit by keeping the newest tail", () => {
  const { service, handle } = harness({ ringBytes: 64 });
  const { terminalId } = service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });
  handle.emitData("0123456789");

  const data = service.replay(terminalId, 4);
  assert.equal(Buffer.from(data, "base64").toString("utf8"), "6789");
});

test("isAlive reports a live terminal and stops reporting after exit", () => {
  const { service, handle } = harness();
  const { terminalId } = service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });

  assert.equal(service.isAlive(terminalId), true);
  handle.emitExit(0);
  assert.equal(service.isAlive(terminalId), false);
  assert.equal(service.isAlive("term_missing"), false);
});

test("the ring is bounded: oldest bytes are dropped, newest survive", () => {
  const { service, handle } = harness({ ringBytes: 16 });
  const { terminalId } = service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });

  handle.emitData("aaaaaaaaaa");
  handle.emitData("bbbbbbbbbb");
  handle.emitData("cccccccccc");

  const text = service.getBuffer(terminalId, 1024);
  assert.equal(text.includes("a"), false, "the first chunk must be evicted");
  assert.match(text, /cccccccccc$/);
});

test("a chunk larger than the ring keeps only the newest tail", () => {
  const { service, handle } = harness({ ringBytes: 8 });
  const { terminalId } = service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });

  handle.emitData("0123456789abcdef");

  const text = service.getBuffer(terminalId, 1024);
  assert.equal(text.length <= 8, true, `ring must stay bounded, got ${text.length}`);
  assert.match(text, /abcdef$/);
});

test("a truncated ring tail never splits a multi-byte character", () => {
  const { service, handle } = harness({ ringBytes: 8 });
  const { terminalId } = service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });

  // Four 3-byte characters: a naive 8-byte cut lands mid-character.
  handle.emitData("你好你好");

  const text = service.getBuffer(terminalId, 1024);
  assert.equal(text.includes("\uFFFD"), false, `replay must not corrupt UTF-8: ${text}`);
  assert.match(text, /你好$/);
});

test("the live event always carries the whole chunk even when the ring truncates", () => {
  const { service, sent, handle } = harness({ ringBytes: 8 });
  service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });

  handle.emitData("0123456789abcdef");

  const live = Buffer.from(sent[0].payload.data, "base64").toString("utf8");
  assert.equal(live, "0123456789abcdef", "the renderer must never see a truncated frame");
});

test("getBuffer honors a smaller byte limit by keeping the tail", () => {
  const { service, handle } = harness();
  const { terminalId } = service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });

  handle.emitData("0123456789");
  assert.equal(service.getBuffer(terminalId, 4), "6789");
});

test("write and resize reach the pty; resize stores the clamped size", () => {
  const { service, handle } = harness();
  const { terminalId } = service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });

  service.write(terminalId, "dir\r");
  service.resize(terminalId, 1, 999);

  assert.deepEqual(handle.pty.written, ["dir\r"]);
  assert.deepEqual(handle.pty.resized, [[2, 300]]);
  assert.equal(service.list()[0].cols, 2);
  assert.equal(service.list()[0].rows, 300);
});

test("exit removes the terminal, drops its listeners, and emits the exit event", () => {
  const { service, sent, handle } = harness();
  const { terminalId } = service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });

  handle.emitExit(0);

  assert.deepEqual(service.list(), []);
  const exitEvent = sent.find((entry) => entry.payload.exitCode === 0);
  assert.ok(exitEvent, "the renderer must learn the shell exited");
  assert.equal(exitEvent.payload.terminalId, terminalId);
  assert.deepEqual(handle.listenerCounts(), { data: 0, exit: 0 }, "listeners must be released");
  assert.equal(service.getBuffer(terminalId), "");
});

test("close kills the pty, drops its listeners, and stays silent", () => {
  const { service, sent, handle } = harness();
  const { terminalId } = service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });
  const before = sent.length;

  service.close(terminalId);
  assert.equal(handle.pty.killed, true);
  assert.deepEqual(service.list(), []);
  assert.deepEqual(handle.listenerCounts(), { data: 0, exit: 0 });
  // The kill provokes a real exit in production; a closed tab must not hear it.
  handle.emitExit(1);
  handle.emitData("late");
  assert.equal(sent.length, before, "a closed terminal must not emit events");
  service.close(terminalId);
});

test("operations on an unknown terminal fail with NOT_FOUND", () => {
  const { service } = harness();
  for (const operation of [
    () => service.write("term_missing", "x"),
    () => service.resize("term_missing", 80, 24),
  ]) {
    assert.throws(operation, (error) => error.errorCode === "NOT_FOUND");
  }
  assert.equal(service.getBuffer("term_missing"), "");
});

test("writing to a pty that died mid-session reports NOT_FOUND", () => {
  const handle = fakePty();
  const service = new TerminalService({
    getWindow: () => null,
    loadPty: () => ({ spawn: () => handle.pty }),
  });
  const { terminalId } = service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });
  handle.pty.write = () => {
    throw new Error("closed");
  };

  assert.throws(
    () => service.write(terminalId, "x"),
    (error) => error.errorCode === "NOT_FOUND",
  );
  // A resize on the same dying pty stays a no-op instead of failing the caller.
  handle.pty.resize = () => {
    throw new Error("closed");
  };
  service.resize(terminalId, 100, 40);
});

test("the per-window terminal cap is enforced", () => {
  const { service } = harness({ maxTerminals: 2 });
  service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });
  service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });

  assert.throws(
    () => service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 }),
    (error) => error.errorCode === "RATE_LIMITED",
  );
  assert.equal(TERMINAL_MAX_PER_WINDOW, 8);
});

test("a build without node-pty reports INTERNAL instead of crashing", () => {
  const service = new TerminalService({
    getWindow: () => null,
    loadPty: () => null,
  });

  assert.throws(
    () => service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 }),
    (error) => error.errorCode === "INTERNAL",
  );
});

test("a spawn failure becomes a typed INTERNAL error without leaking the path", () => {
  const service = new TerminalService({
    getWindow: () => null,
    loadPty: () => ({
      spawn() {
        throw new Error("ENOENT: C:\\Users\\secret\\pwsh.exe");
      },
    }),
  });

  assert.throws(
    () => service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 }),
    (error) =>
      error.errorCode === "INTERNAL" &&
      !error.message.includes("secret") &&
      /cmd/.test(error.message),
  );
  assert.deepEqual(service.list(), [], "a failed spawn must not leave a record");
});

test("a failed listener registration kills the child instead of leaking it", () => {
  const handle = fakePty();
  handle.pty.onData = () => {
    throw new Error("registration failed");
  };
  const service = new TerminalService({
    getWindow: () => null,
    loadPty: () => ({ spawn: () => handle.pty }),
  });

  assert.throws(
    () => service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 }),
    (error) => error.errorCode === "INTERNAL",
  );
  assert.equal(handle.pty.killed, true, "the orphaned child must be killed");
  assert.deepEqual(service.list(), []);
});

test("closeAll kills every terminal but keeps the service usable", () => {
  const { service, handle } = harness();
  service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });

  service.closeAll();
  assert.equal(handle.pty.killed, true);
  assert.deepEqual(service.list(), []);

  // Closing the window is not quitting: a reopened window must get terminals.
  const reopened = service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });
  assert.ok(reopened.terminalId);
});

test("dispose kills every terminal and refuses further creation", () => {
  const { service, handle } = harness();
  service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });

  service.dispose();
  assert.equal(handle.pty.killed, true);
  assert.throws(
    () => service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 }),
    (error) => error.errorCode === "INTERNAL",
  );
});

test("a destroyed window does not break output forwarding", () => {
  const sent = [];
  const handle = fakePty();
  const service = new TerminalService({
    getWindow: () => ({
      isDestroyed: () => true,
      webContents: { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) },
    }),
    loadPty: () => ({ spawn: () => handle.pty }),
  });

  service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });
  handle.emitData("ignored");
  assert.equal(sent.length, 0);
  assert.match(service.getBuffer(service.list()[0].id), /ignored/);
});

test("a destroyed webContents is skipped rather than throwing", () => {
  const handle = fakePty();
  const service = new TerminalService({
    getWindow: () => ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => true, send: () => {
        throw new Error("Object has been destroyed");
      } },
    }),
    loadPty: () => ({ spawn: () => handle.pty }),
  });

  service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });
  handle.emitData("ignored");
  assert.match(service.getBuffer(service.list()[0].id), /ignored/);
});

test("stripAnsiCodes removes SGR and OSC sequences but keeps text", () => {
  assert.equal(stripAnsiCodes("\u001b[1;31mred\u001b[0m plain"), "red plain");
  assert.equal(stripAnsiCodes("\u001b]0;title\u0007body"), "body");
});

test("launch overrides append argv after the profile and layer env over the sanitized base", () => {
  const { service, spawns } = harness();
  service.create(
    { ...PROFILE, args: ["-NoProfile"] },
    "C:\\work",
    { cols: 80, rows: 24 },
    { launchArgs: "-NoLogo --flag \"a b\"", env: "MY_VAR=1\n# note\nBROKEN" },
  );

  // The profile's own argv stays in front: a shell's required flags must not be
  // reordered by a user preference.
  assert.deepEqual(spawns[0].args, ["-NoProfile", "-NoLogo", "--flag", "a b"]);
  const env = spawns[0].spawnOptions.env;
  assert.equal(env.MY_VAR, "1");
  assert.equal(env.TERM, "xterm-256color");
  // A malformed line is skipped rather than aborting the launch.
  assert.equal(env.BROKEN, undefined);
});

test("no overrides keeps the previous spawn shape exactly", () => {
  const { service, spawns } = harness();
  service.create(PROFILE, "C:\\work", { cols: 80, rows: 24 });
  assert.deepEqual(spawns[0].args, []);
  assert.equal(spawns[0].spawnOptions.env.MY_VAR, undefined);
  assert.equal(spawns[0].spawnOptions.env.TERM, "xterm-256color");
});
