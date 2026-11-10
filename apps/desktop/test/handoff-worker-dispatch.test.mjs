import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import test from "node:test";
import ts from "typescript";

// Same transpiling loader as session-collaboration-service.test.mjs, so these
// cases exercise the real service with only the Host, ledger and AgentHost
// boundary replaced by fixtures.
function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected session collaboration dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

const pluginAgentComplete = load("../electron/main/plugin-agent-complete.ts", {
  "@pi-desktop/agent-runtime": await import("@pi-desktop/agent-runtime"),
  "@pi-desktop/shared": await import("@pi-desktop/shared"),
});

const { createSessionCollaborationService } = load("../electron/main/services/session-collaboration.ts", {
  "node:crypto": crypto,
  "../agent-host-bridge": { DESKTOP_PRINCIPAL: { kind: "desktop" } },
  "../plugin-agent-complete": pluginAgentComplete,
});

const SPAWN_PROVIDERS = [
  {
    id: "provider-a",
    name: "Provider A",
    enabled: true,
    authKind: "none",
    models: [{ id: "default-model" }, { id: "delegable-model", availableForSubagents: true }],
  },
];

/**
 * A Host stand-in that keeps the durable session-collaboration rows this service
 * reads back. It is the external boundary: admission, ledger and permission
 * checks live behind it, exactly as Rust owns them in production.
 */
function createLedgerHost(name = "host-1", generation = "generation-1") {
  const calls = [];
  const rows = new Map();
  const fails = [];
  const settles = [];
  const host = {
    name,
    generation,
    available: true,
    calls,
    rows,
    fails,
    settles,
    isAvailable() {
      return this.available;
    },
    async call(method, params = {}) {
      calls.push({ method, params });
      switch (method) {
        case "session.collaboration.send":
        case "session.collaboration.spawn": {
          const id = `message-${rows.size + 1}`;
          const row = {
            id,
            pluginId: "demo-plugin",
            sourceSessionId: "source-session",
            targetSessionId: params.sessionId ?? "worker-session",
            content: params.content ?? params.task,
            kind: method.endsWith("/spawn") ? "task" : (params.kind ?? "message"),
            status: "queued",
          };
          rows.set(id, row);
          return { message: { ...row } };
        }
        case "session.collaboration.message": {
          const row = rows.get(params.messageId);
          return row ? { message: { ...row } } : {};
        }
        case "session.collaboration.pending":
          return { messages: [...rows.values()].filter((row) => row.status === "queued").map((row) => ({ ...row })) };
        case "session.collaboration.fail": {
          fails.push({ ...params });
          const row = rows.get(params.messageId);
          if (row) row.status = "failed";
          return {};
        }
        case "session.collaboration.settle":
          settles.push({ ...params });
          return {};
        case "providers.list":
          return { providers: SPAWN_PROVIDERS };
        case "settings.get":
          return { defaultProviderId: "provider-a", defaultModelId: "default-model" };
        default:
          return {};
      }
    },
  };
  return host;
}

/** The AgentHost admission surface this service reaches. It records the queued
 * turn request instead of executing anything. */
function createBridge(host) {
  const turns = [];
  return {
    turns,
    queue: {
      list: (sessionId) => turns
        .filter((turn) => turn.sessionId === sessionId)
        .map((turn) => ({ sessionMessageId: turn.input?.sessionMessageId })),
      cancelSessionMessage: async () => true,
    },
    agentHost: {
      async startTurn(principal, params) {
        turns.push({ principal, ...params });
        const row = host.rows.get(params.input?.sessionMessageId);
        if (row && row.status === "queued") row.status = "running";
        return { accepted: true, turn: { id: `turn-${turns.length}` } };
      },
    },
    interruptSessionMessage: async () => true,
  };
}

function createRig(overrides = {}) {
  const logs = [];
  const state = {
    host: overrides.host ?? null,
    bridge: overrides.bridge ?? null,
    // One stable runtime identity, as `mainState.sidecar` is between restarts.
    sidecar: overrides.sidecar === undefined ? {} : overrides.sidecar,
    flush: overrides.flushTranscript ?? (async () => true),
    closed: overrides.isAdmissionClosed,
  };
  const deps = {
    getHost: overrides.getHost ?? (() => state.host),
    getSidecar: overrides.getSidecar ?? (() => state.sidecar),
    getBridge: overrides.getBridge ?? (() => state.bridge),
    getActiveTurn: (sessionId) => (overrides.activeTurns ?? {})[sessionId],
    flushTranscript: () => state.flush(),
    isPluginLoaded: () => overrides.pluginLoaded ?? true,
    isQuitting: () => overrides.quitting ?? false,
    ...(state.closed ? { isAdmissionClosed: () => state.closed() } : {}),
    onChanged: () => {},
    log: (message, data) => logs.push({ message, data }),
  };
  return {
    service: createSessionCollaborationService(deps),
    logs,
    state,
    setFlush(flush) { state.flush = flush; },
  };
}

function queuedRow(host, overrides = {}) {
  const row = {
    id: `message-${host.rows.size + 1}`,
    pluginId: "demo-plugin",
    sourceSessionId: "source-session",
    targetSessionId: "worker-session",
    content: "Please review the diff",
    kind: "task",
    status: "queued",
    ...overrides,
  };
  host.rows.set(row.id, row);
  return row;
}

const pluginContext = {
  pluginId: "demo-plugin",
  sessionId: "source-session",
  turnId: "turn-1",
  invocationId: "invocation-1",
};

function invokeSend(service, args, signal) {
  return service.invoke({
    operation: "session/collaboration/send",
    source: "plugin",
    args: [args],
    pluginContext,
    ...(signal ? { signal } : {}),
  });
}

function invokeSpawn(service, args) {
  return service.invoke({
    operation: "session/collaboration/spawn",
    source: "plugin",
    args: [args],
    pluginContext,
  });
}

// ---------------------------------------------------------------------------
// Admission: a closed gate refuses fresh effects and never terminalizes the
// queued delivery it did not start.
// ---------------------------------------------------------------------------

for (const kind of ["task", "message"]) {
  test(`a queued ${kind} delivery refused by closed admission stays queued for a later drain`, async () => {
    const host = createLedgerHost();
    const row = queuedRow(host, { kind });
    const bridge = createBridge(host);
    let closed = true;
    const rig = createRig({ host, bridge, isAdmissionClosed: () => closed });

    await rig.service.drain();
    assert.deepEqual(bridge.turns, [], "a closed admission must not attempt a turn");
    assert.deepEqual(host.fails, [], "a refused attempt must not persist a delivery failure");
    assert.equal(host.rows.get(row.id).status, "queued", "the durable delivery must stay queued");

    closed = false;
    await rig.service.drain();
    assert.equal(bridge.turns.length, 1, "reopening admission must deliver the retained message");
    assert.equal(host.rows.get(row.id).status, "running");
  });
}

test("an unreadable admission probe is treated as closed, not as permission", async () => {
  const host = createLedgerHost();
  const row = queuedRow(host);
  const bridge = createBridge(host);
  const rig = createRig({
    host, bridge,
    isAdmissionClosed: () => { throw new Error("gate unavailable"); },
  });

  await rig.service.drain();

  assert.deepEqual(bridge.turns, []);
  assert.deepEqual(host.fails, []);
  assert.equal(host.rows.get(row.id).status, "queued");
});

test("an already-admitted settlement finishes while admission is closed, without starting a dispatch", async () => {
  const host = createLedgerHost();
  const bridge = createBridge(host);
  let closed = false;
  const rig = createRig({ host, bridge, isAdmissionClosed: () => closed });
  rig.setFlush(async () => false);
  // A settlement arrives while the transcript cannot be flushed yet.
  await rig.service.settle("worker-session", "turn-old");
  assert.deepEqual(host.settles, []);

  // A delivery is queued at the same time as the closure.
  queuedRow(host);
  closed = true;
  rig.setFlush(async () => true);
  await rig.service.drain();

  assert.deepEqual(host.settles.map((entry) => entry.turnId), ["turn-old"],
    "settling work admitted before the closure must still finish");
  assert.deepEqual(bridge.turns, [], "a closed admission must not start a new dispatch");
  assert.deepEqual(host.fails, []);
});

test("a send is refused before the ledger write when admission is closed", async () => {
  const host = createLedgerHost();
  const bridge = createBridge(host);
  const rig = createRig({ host, bridge, activeTurns: { "source-session": "turn-1" }, isAdmissionClosed: () => true });

  await assert.rejects(
    invokeSend(rig.service, { sessionId: "worker-session", content: "hello" }),
    { code: "HOST_BUSY" },
  );
  assert.deepEqual(host.calls.filter((entry) => entry.method === "session.collaboration.send"), []);
  assert.equal(host.rows.size, 0);
});

test("a spawn is refused before the ledger write when admission is closed", async () => {
  const host = createLedgerHost();
  const bridge = createBridge(host);
  const rig = createRig({ host, bridge, activeTurns: { "source-session": "turn-1" }, isAdmissionClosed: () => true });

  await assert.rejects(invokeSpawn(rig.service, { task: "Review the diff" }), { code: "HOST_BUSY" });
  assert.deepEqual(host.calls.filter((entry) => entry.method === "session.collaboration.spawn"), []);
});

test("an AgentHost busy refusal keeps the queued delivery instead of failing it", async () => {
  // The shared Desktop gate can close between the local check and the Host
  // admission; the Host is still the authority, so its refusal must not
  // terminalize work it never started.
  const host = createLedgerHost();
  const row = queuedRow(host);
  const bridge = createBridge(host);
  bridge.agentHost.startTurn = async () => {
    throw Object.assign(new Error("the Host is entering maintenance"), { errorCode: "HOST_BUSY" });
  };
  const rig = createRig({ host, bridge });

  await rig.service.drain();

  assert.deepEqual(host.fails, []);
  assert.equal(host.rows.get(row.id).status, "queued");
});

// ---------------------------------------------------------------------------
// Original-owner identity: a dispatch started before a restart never lands on
// the replacement, and never writes a failure there.
// ---------------------------------------------------------------------------

test("a send whose Host is replaced after the ledger write never dispatches on the replacement", async () => {
  const previous = createLedgerHost("host-1", "generation-1");
  const replacement = createLedgerHost("host-2", "generation-2");
  const previousBridge = createBridge(previous);
  const replacementBridge = createBridge(replacement);
  const rig = createRig({ host: previous, bridge: previousBridge, activeTurns: { "source-session": "turn-1" } });
  const send = previous.call.bind(previous);
  previous.call = async (method, params) => {
    const result = await send(method, params);
    if (method === "session.collaboration.send") {
      rig.state.host = replacement;
      rig.state.bridge = replacementBridge;
    }
    return result;
  };

  await assert.rejects(
    invokeSend(rig.service, { sessionId: "worker-session", content: "hello" }),
    { code: "HOST_UNAVAILABLE" },
  );
  assert.deepEqual(replacementBridge.turns, [], "a replacement must never run work admitted before it existed");
  assert.deepEqual(replacement.calls.filter((entry) => entry.method === "session.collaboration.message"), []);
  assert.deepEqual(replacement.fails, []);
});

test("a drain whose Host is replaced mid-pass leaves the queued delivery to the next drain", async () => {
  const previous = createLedgerHost("host-1", "generation-1");
  const replacement = createLedgerHost("host-2", "generation-2");
  queuedRow(previous);
  queuedRow(replacement);
  const previousBridge = createBridge(previous);
  const replacementBridge = createBridge(replacement);
  const rig = createRig({ host: previous, bridge: previousBridge });
  const pending = previous.call.bind(previous);
  previous.call = async (method, params) => {
    const result = await pending(method, params);
    if (method === "session.collaboration.pending") {
      rig.state.host = replacement;
      rig.state.bridge = replacementBridge;
    }
    return result;
  };

  await assert.doesNotReject(rig.service.drain(), "an owner change is not a delivery failure");
  assert.deepEqual(previousBridge.turns, []);
  assert.deepEqual(replacementBridge.turns, [], "the interrupted pass must not borrow the replacement");
  assert.deepEqual(replacement.fails, []);

  await rig.service.drain();
  assert.equal(replacementBridge.turns.length, 1, "a new drain owns the replacement");
});

test("the same Host instance with a new generation cannot start a queued delivery", async () => {
  const host = createLedgerHost();
  const row = queuedRow(host);
  const bridge = createBridge(host);
  const rig = createRig({ host, bridge });
  const read = host.call.bind(host);
  host.call = async (method, params) => {
    const result = await read(method, params);
    if (method === "session.collaboration.message") host.generation = "generation-2";
    return result;
  };

  await rig.service.drain();

  assert.deepEqual(bridge.turns, [], "a changed generation is not the original owner");
  assert.deepEqual(host.fails, [], "no failure may be written under an invalid generation");
  assert.equal(host.rows.get(row.id).status, "queued");
});

test("a bridge replaced between the ledger write and the turn is not adopted", async () => {
  const host = createLedgerHost();
  const originalBridge = createBridge(host);
  const lateBridge = createBridge(host);
  const rig = createRig({ host, bridge: originalBridge, activeTurns: { "source-session": "turn-1" } });
  const send = host.call.bind(host);
  host.call = async (method, params) => {
    const result = await send(method, params);
    if (method === "session.collaboration.send") rig.state.bridge = lateBridge;
    return result;
  };

  await assert.rejects(
    invokeSend(rig.service, { sessionId: "worker-session", content: "hello" }),
    { code: "HOST_UNAVAILABLE" },
  );
  assert.deepEqual(lateBridge.turns, [], "a late bridge must not adopt work addressed to the previous runtime");
  assert.deepEqual(originalBridge.turns, []);
  assert.deepEqual(host.fails, []);
});

test("a dispatch failure is only persisted while the original owner is still current", async () => {
  const host = createLedgerHost();
  const row = queuedRow(host);
  const bridge = createBridge(host);
  bridge.agentHost.startTurn = async () => {
    host.generation = "generation-2";
    throw new Error("Agent runtime restarted");
  };
  const rig = createRig({ host, bridge });

  await rig.service.drain();

  assert.deepEqual(host.fails, []);
  assert.equal(host.rows.get(row.id).status, "queued");
  assert.ok(
    rig.logs.some((entry) => entry.message === "Session completion delivery is pending or failed"
      && entry.data.messageId === row.id),
    "a retained failure stays observable instead of being swallowed",
  );
});

test("a genuine delivery failure on the original owner is still persisted", async () => {
  const host = createLedgerHost();
  const row = queuedRow(host);
  const bridge = createBridge(host);
  bridge.agentHost.startTurn = async () => { throw new Error("Agent runtime restarted"); };
  const rig = createRig({ host, bridge });

  await rig.service.drain();

  assert.equal(host.fails.length, 1);
  assert.equal(host.fails[0].messageId, row.id);
  assert.equal(host.fails[0].error, "FAILED: Agent runtime restarted");
  assert.equal(host.rows.get(row.id).status, "failed");
});

test("an aborted caller still cancels the exact turn it started", async () => {
  const host = createLedgerHost();
  const bridge = createBridge(host);
  const cancels = [];
  const read = host.call.bind(host);
  host.call = async (method, params) => {
    if (method === "session.collaboration.cancel") {
      cancels.push({ ...params });
      return {
        sessionId: params.sessionId, cancelled: true, sessionRetained: true,
        messageIds: [params.messageId], runningTurnIds: ["turn-1"],
      };
    }
    return read(method, params);
  };
  const controller = new AbortController();
  bridge.agentHost.startTurn = async () => {
    controller.abort();
    return { accepted: true, turn: { id: "turn-1" } };
  };
  const rig = createRig({ host, bridge, activeTurns: { "source-session": "turn-1" } });

  const delivery = await invokeSend(
    rig.service, { sessionId: "worker-session", content: "hello", idempotencyKey: "key-1" }, controller.signal,
  );

  assert.equal(cancels.length, 1, "the caller's cancellation must stop the turn it started");
  assert.equal(cancels[0].messageId, delivery.messageId);
});

// ---------------------------------------------------------------------------
// Owner report: pending operations and retained work stay visible.
// ---------------------------------------------------------------------------

test("the owner report counts pending operations and retained settlement receipts", async () => {
  const host = createLedgerHost();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const read = host.call.bind(host);
  host.call = async (method, params) => {
    await blocked;
    return read(method, params);
  };
  const rig = createRig({ host, bridge: createBridge(host) });
  assert.deepEqual(Reflect.ownKeys(rig.service.getHandoffActivity()), ["operations", "resources", "uncontainedResources"]);

  const draining = rig.service.drain();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(rig.service.getHandoffActivity(), { operations: 1, resources: 0, uncontainedResources: 0 });
  release();
  await draining;
  assert.deepEqual(rig.service.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 0 });
});

test("the owner report retains an unresolved settlement receipt as work", async () => {
  const host = createLedgerHost();
  const rig = createRig({ host, bridge: createBridge(host) });
  rig.setFlush(async () => false);

  await rig.service.settle("worker-session", "turn-pending");
  assert.deepEqual(rig.service.getHandoffActivity(), { operations: 0, resources: 1, uncontainedResources: 0 });

  rig.setFlush(async () => true);
  await rig.service.drain();
  assert.deepEqual(rig.service.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 0 });
});

test("a durable settlement receipt is replayed by a new drain, not by the interrupted one", async () => {
  const previous = createLedgerHost("host-1", "generation-1");
  const replacement = createLedgerHost("host-2", "generation-2");
  const rig = createRig({ host: previous, bridge: createBridge(previous), flushTranscript: async () => false });
  await rig.service.settle("worker-session", "turn-old");
  assert.deepEqual(previous.settles, []);

  rig.state.bridge = createBridge(replacement);
  rig.setFlush(async () => true);
  const flushDrain = rig.service.drain.bind(rig.service);
  rig.setFlush(async () => {
    rig.state.host = replacement;
    return true;
  });
  await assert.doesNotReject(flushDrain());
  assert.deepEqual(replacement.settles, [], "the interrupted pass must not settle on the replacement");

  rig.setFlush(async () => true);
  await rig.service.drain();
  assert.deepEqual(replacement.settles.map((entry) => entry.turnId), ["turn-old"]);
});

// ---------------------------------------------------------------------------
// Representative delivery paths through Host admission and the ledger.
// ---------------------------------------------------------------------------

test("a spawned queued delivery reaches the recorded AgentHost admission and reads back its ledger result", async () => {
  const host = createLedgerHost();
  const bridge = createBridge(host);
  const rig = createRig({ host, bridge, activeTurns: { "source-session": "turn-1" } });

  const delivery = await invokeSpawn(rig.service, { task: "Review the diff", modelKey: "provider-a/delegable-model" });

  const row = [...host.rows.values()][0];
  assert.equal(bridge.turns.length, 1);
  assert.equal(bridge.turns[0].sessionId, row.targetSessionId);
  assert.equal(bridge.turns[0].admission, "queue");
  assert.equal(bridge.turns[0].idempotencyKey, `session-message:${row.id}`);
  assert.equal(host.rows.get(row.id).status, "running");
  assert.equal(delivery.status, "running");
  assert.equal(delivery.messageId, row.id);
});

test("a sent queued delivery is admitted for its target session and reports the stored outcome", async () => {
  const host = createLedgerHost();
  const bridge = createBridge(host);
  const rig = createRig({ host, bridge, activeTurns: { "source-session": "turn-1" } });

  const delivery = await invokeSend(rig.service, { sessionId: "worker-session", content: "hello", kind: "task" });

  assert.equal(bridge.turns.length, 1);
  assert.equal(bridge.turns[0].input.text, "hello");
  assert.equal(bridge.turns[0].input.sessionMessageId, delivery.messageId);
  assert.equal(delivery.status, "running");
  assert.deepEqual(host.fails, []);
});
