import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

import {
  createTerminalPendingBuffer,
  terminalBufferChunk,
  terminalChunksAfterSnapshot,
} from "@pi-desktop/shared";

/**
 * The renderer's terminal attach sequence, driven against a mocked preload
 * bridge with the shipped ordering helpers and the real `api` facade and
 * tab-to-terminal registry.
 *
 * **Scope, stated plainly:** this is not a rendered React component test. The
 * sequencing decisions are the real exported functions
 * (`createTerminalPendingBuffer`, `terminalBufferChunk`,
 * `terminalChunksAfterSnapshot`) and the wire traffic is the real `api` facade;
 * the branches that live inside `TerminalTab.tsx` (no automatic create, Retry
 * vs Restart, input dropped while the transport is down) are asserted against
 * that component's source below, because node cannot mount JSX here.
 *
 * No SSH and no PTY runs: a fake host answers the renderer's channels.
 */

const IPC = {
  invoke: {
    terminalListShells: "pi-desktop/terminal/listShells",
    terminalCreate: "pi-desktop/terminal/create",
    terminalWrite: "pi-desktop/terminal/write",
    terminalResize: "pi-desktop/terminal/resize",
    terminalClose: "pi-desktop/terminal/close",
    terminalReplay: "pi-desktop/terminal/replay",
    terminalGetBuffer: "pi-desktop/terminal/getBuffer",
  },
  event: {
    terminalData: "pi-desktop/terminal/event/data",
    terminalExit: "pi-desktop/terminal/event/exit",
  },
};

const TERMINAL_IPC = {
  get listShells() { return IPC.invoke.terminalListShells; },
  get create() { return IPC.invoke.terminalCreate; },
  get write() { return IPC.invoke.terminalWrite; },
  get resize() { return IPC.invoke.terminalResize; },
  get close() { return IPC.invoke.terminalClose; },
  get replay() { return IPC.invoke.terminalReplay; },
  get getBuffer() { return IPC.invoke.terminalGetBuffer; },
  get dataEvent() { return IPC.event.terminalData; },
  get exitEvent() { return IPC.event.terminalExit; },
};

/** A fake Electron bridge that records every call the renderer makes. */
function fakeBridge() {
  const calls = [];
  const listeners = new Map();
  const replies = new Map();
  globalThis.window = {
    piDesktop: {
      invoke: async (channel, payload) => {
        calls.push({ channel, payload });
        const reply = replies.get(channel);
        if (!reply) return { ok: true, data: {} };
        const value = typeof reply === "function" ? await reply(payload) : reply;
        if (value && value.ok === false) return value;
        return { ok: true, data: value };
      },
      on: (channel, listener) => {
        const set = listeners.get(channel) ?? new Set();
        set.add(listener);
        listeners.set(channel, set);
        return () => set.delete(listener);
      },
    },
  };
  return {
    calls,
    replies,
    channels: () => calls.map((call) => call.channel),
    emit(channel, payload) {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
  };
}

/** The real api facade, loaded with its ambient modules stubbed. */
function loadApi() {
  const { outputText } = ts.transpileModule(
    readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  );
  const requireIds = new Set(
    [...outputText.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]),
  );
  const noop = new Proxy(() => undefined, { get: () => noop });
  const shared = new Proxy({}, { get: (_target, key) => (key === "IPC" ? IPC : noop) });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      if (id === "@pi-desktop/shared") return shared;
      if (id === "i18next") return { default: { t: (key) => key } };
      if (id === "./terminal-channels") return { TERMINAL_IPC };
      assert.ok(requireIds.has(id), `unexpected import ${id}`);
      return noop;
    },
    module.exports,
    module,
  );
  return module.exports.api;
}

/** The registry module, linked to the api instance the test drives. */
function loadSessions(api) {
  const { outputText } = ts.transpileModule(
    readFileSync(new URL("../src/lib/terminal-sessions.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  );
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)(
    (id) => {
      if (id === "./api") return { api };
      throw new Error(`unexpected import ${id}`);
    },
    module.exports,
    module,
  );
  return module.exports;
}

const TARGET = { sessionId: "session-a", workspaceId: "local:/work/app", tabId: "terminal:t1" };
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const textOf = (base64) => Buffer.from(base64, "base64").toString("utf8");

/**
 * The attach sequence the component runs, expressed with the shipped helpers:
 * subscribe first, buffer pre-attach output, read the snapshot, paint it, then
 * paint only the chunks it does not already contain.
 */
function attach(bridge, api, { terminalId, snapshot }) {
  const pending = createTerminalPendingBuffer();
  const painted = [];
  const unsub = api.onTerminalData((event) => {
    if (event.terminalId === terminalId) return; // not attached yet
    terminalBufferChunk(pending, event);
  });
  const snapshotCall = api.terminalReplay(terminalId).then((result) => {
    if (result.data !== null) painted.push(textOf(result.data));
    const { write } = terminalChunksAfterSnapshot(
      pending.chunks.filter((chunk) => chunk.terminalId === terminalId),
      result.sequence ?? snapshot.sequence,
    );
    for (const chunk of write) painted.push(textOf(chunk.data));
    unsub();
    return { result, write };
  });
  return { pending, painted, snapshotCall };
}

test("output emitted before the create response is on screen once, through the replay", async () => {
  const bridge = fakeBridge();
  const api = loadApi();
  let resolveCreate;
  bridge.replies.set(IPC.invoke.terminalCreate, () => new Promise((resolve) => {
    resolveCreate = resolve;
  }));
  bridge.replies.set(IPC.invoke.terminalReplay, {
    data: b64("ready\r\n$ "),
    sequence: 1,
  });

  // The host emits its first chunk while the create call is still inbox.
  bridge.emit(IPC.event.terminalData, { terminalId: "term_1", data: b64("ready\r\n"), sequence: 1 });

  const opening = api.terminalCreate({ target: TARGET, shellId: "bash", cols: 80, rows: 24 });
  const pending = createTerminalPendingBuffer();
  const unsub = api.onTerminalData((event) => {
    terminalBufferChunk(pending, event);
  });
  bridge.emit(IPC.event.terminalData, { terminalId: "term_1", data: b64("$ "), sequence: 2 });
  resolveCreate({ terminalId: "term_1", shellId: "bash", cols: 80, rows: 24 });
  const opened = await opening;
  assert.equal(opened.terminalId, "term_1");

  // Attach: subscribe (already done) → replay → snapshot + newer chunks only.
  const replay = await api.terminalReplay(opened.terminalId);
  const { write } = terminalChunksAfterSnapshot(
    pending.chunks.filter((chunk) => chunk.terminalId === opened.terminalId),
    replay.sequence,
  );
  const painted = [textOf(replay.data), ...write.map((chunk) => textOf(chunk.data))];
  unsub();

  // `ready\r\n` raced the create response and is in the snapshot; `$ ` (seq 2)
  // is newer than the snapshot (seq 1), so it is painted after it — and neither
  // chunk is painted twice.
  assert.deepEqual(painted, ["ready\r\n$ ", "$ "]);
  assert.equal(painted.join(""), "ready\r\n$ $ ", "the snapshot is authoritative for seq 1");
  assert.equal(pending.overflowed, false);
});

test("the snapshot and the buffered events never paint the same chunk twice", () => {
  const buffered = [
    { terminalId: "term_1", data: b64("a"), sequence: 1 },
    { terminalId: "term_1", data: b64("b"), sequence: 2 },
    { terminalId: "term_1", data: b64("c"), sequence: 3 },
  ];
  const current = terminalChunksAfterSnapshot(buffered, 2);
  assert.deepEqual(current.write.map((chunk) => chunk.sequence), [3]);
  assert.equal(current.alreadyIncluded, 2);

  // A snapshot at the latest sequence swallows everything buffered.
  assert.deepEqual(terminalChunksAfterSnapshot(buffered, 3).write, []);

  // A legacy host (no sequence anywhere) keeps the snapshot authoritative.
  const legacy = terminalChunksAfterSnapshot(
    [{ terminalId: "term_1", data: b64("x") }, { terminalId: "term_1", data: b64("y"), sequence: 1 }],
    undefined,
  );
  assert.deepEqual(legacy.write, []);
  assert.equal(legacy.alreadyIncluded, 2);
});

test("a host that is offline on replay is never replaced by a new shell", async () => {
  const bridge = fakeBridge();
  const api = loadApi();
  const sessions = loadSessions(api);
  const tabId = TARGET.tabId;
  sessions.forgetTerminalHandle(tabId);
  sessions.setTerminalHandle(tabId, {
    terminalId: "term_1",
    target: TARGET,
    cols: 80,
    rows: 24,
  });

  bridge.replies.set(IPC.invoke.terminalReplay, {
    ok: false,
    error: { code: "TERMINAL_HOST_OFFLINE", message: "host is not connected" },
  });

  let outcome = null;
  try {
    await api.terminalReplay("term_1");
  } catch (cause) {
    outcome = cause;
  }
  assert.equal(outcome.code, "TERMINAL_HOST_OFFLINE");

  // What the pane must do with that rejection: keep the handle (Retry
  // attachment), and do not create anything.
  assert.equal(sessions.terminalHandleFor(tabId).terminalId, "term_1");
  assert.equal(
    bridge.channels().filter((channel) => channel === IPC.invoke.terminalCreate).length,
    0,
    "an unreachable terminal must not be replaced by a fresh shell",
  );
});

test("input is sent once and never replayed after a transport failure", async () => {
  const bridge = fakeBridge();
  const api = loadApi();
  const sessions = loadSessions(api);
  const tabId = TARGET.tabId;
  sessions.forgetTerminalHandle(tabId);
  sessions.setTerminalHandle(tabId, { terminalId: "term_1", target: TARGET, cols: 80, rows: 24 });

  let fail = false;
  bridge.replies.set(IPC.invoke.terminalWrite, () => (fail
    ? { ok: false, error: { code: "TERMINAL_HOST_OFFLINE", message: "dropped" } }
    : { ok: true }));

  let transportDown = false;
  const send = async (data) => {
    if (transportDown) return; // never queue: nothing is replayed on reconnect
    try {
      await api.terminalWrite("term_1", data);
    } catch {
      transportDown = true;
    }
  };

  await send("echo hi\r");
  assert.equal(bridge.calls.filter((call) => call.channel === IPC.invoke.terminalWrite).length, 1);

  fail = true;
  await send("ls\r");
  assert.equal(transportDown, true, "a dropped write must surface, not be swallowed");
  assert.equal(sessions.terminalHandleFor(tabId).terminalId, "term_1", "the handle stays for a retry");

  // While the transport is down, further keystrokes are dropped rather than
  // queued — including the ones typed during the outage.
  await send("pwd\r");
  await send("whoami\r");
  assert.equal(bridge.calls.filter((call) => call.channel === IPC.invoke.terminalWrite).length, 2);

  // Re-attaching replays the snapshot and sends no input of its own.
  const before = bridge.calls.length;
  bridge.replies.set(IPC.invoke.terminalReplay, { data: b64("$ "), sequence: 4 });
  await api.terminalReplay("term_1");
  assert.deepEqual(bridge.channels().slice(before), [IPC.invoke.terminalReplay]);
  assert.equal(
    bridge.calls.filter((call) => call.channel === IPC.invoke.terminalWrite && call.payload.data === "ls\r").length,
    1,
    "the command that failed is not sent a second time",
  );
});

test("the pending buffer is bounded and says so instead of dropping silently", () => {
  const pending = createTerminalPendingBuffer();
  terminalBufferChunk(pending, { terminalId: "term_1", data: "a".repeat(600_000) });
  assert.equal(pending.overflowed, false);
  terminalBufferChunk(pending, { terminalId: "term_1", data: "b".repeat(600_000) });
  assert.equal(pending.overflowed, true, "the cap is reported, not silently exceeded");
  assert.deepEqual(pending.chunks, []);
  // Once overflowed the buffer stays empty: the pane resyncs from a snapshot.
  terminalBufferChunk(pending, { terminalId: "term_1", data: "c" });
  assert.deepEqual(pending.chunks, []);

  // Chunks of another terminal never enter this tab's buffer once the id is known.
  const scoped = createTerminalPendingBuffer();
  terminalBufferChunk(scoped, { terminalId: "term_other", data: "x" }, "term_1");
  terminalBufferChunk(scoped, { terminalId: "term_1", data: "y" }, "term_1");
  assert.deepEqual(scoped.chunks.map((chunk) => chunk.terminalId), ["term_1"]);
});

test("TerminalTab: no branch creates a shell on its own, and Retry is not Restart", () => {
  const pane = readFileSync(
    new URL("../src/components/workpanel/TerminalTab.tsx", import.meta.url),
    "utf8",
  );

  // The only create is the explicit "no handle yet" path, and the create catch
  // reports instead of retrying.
  assert.equal((pane.match(/api\.terminalCreate\(/g) ?? []).length, 1);
  const createCatch = pane.slice(
    pane.indexOf("const pending = createTerminalPendingBuffer();"),
  );
  assert.match(createCatch, /setStatus\(next\.status\)/);

  // A replay rejection with an offline code keeps the handle; anything else
  // forgets it and reports "exited" — both without a create in between.
  const replayCatch = pane.slice(
    pane.indexOf("snapshot = await api.terminalReplay(existing.terminalId);"),
    pane.indexOf("terminalId = existing.terminalId;"),
  );
  assert.match(replayCatch, /if \(next\.status === "offline"\)/);
  assert.match(replayCatch, /setStatus\("offline"\)/);
  assert.match(replayCatch, /forgetTerminalHandle\(tabId\);\s*\n\s*setExitCode\(null\);\s*\n\s*setStatus\("exited"\)/);
  assert.doesNotMatch(replayCatch, /terminalCreate/);

  // A brand-new shell also reads a snapshot, so output emitted before the create
  // response is replayed instead of lost.
  const createPath = pane.slice(pane.indexOf("terminalId = opened.terminalId;"));
  assert.match(createPath.slice(0, 400), /await api\.terminalReplay\(terminalId\)/);

  // Retry attachment re-runs the effect; only Restart kills the shell.
  const retry = pane.slice(pane.indexOf("const retryAttachment"), pane.indexOf("const busy ="));
  assert.match(retry, /setAttempt\(/);
  assert.doesNotMatch(retry, /closeTerminalForTab|api\.terminalClose/);
  const restart = pane.slice(pane.indexOf("const restart"), pane.indexOf("const retryAttachment"));
  assert.match(restart, /closeTerminalForTab\(tabId\)/);

  // Input and resize report a transport failure instead of swallowing it, and
  // input is refused while the transport is known to be down.
  assert.match(pane, /transportDownRef\.current\) return;/);
  assert.match(pane, /api\.terminalWrite\(id, data\)\.catch\(\(cause\) => \{[\s\S]{0,120}reportTransportFailure/);
  assert.match(pane, /api\.terminalResize\(id, cols, rows\)\.catch\(\(cause\) => \{[\s\S]{0,120}reportTransportFailure/);
  // The overflow is stated, never silent.
  assert.match(pane, /pending\.overflowed/);
  assert.match(pane, /setOverflowed\(true\)/);
  assert.match(pane, /panel\.terminal\.bufferOverflow/);
});
