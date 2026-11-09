import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PersistenceOutbox } from "../electron/main/persistence-outbox.ts";
import { InflightCheckpointer } from "../../../packages/host-runtime/src/inflight-checkpoint.ts";
import { DesktopHandoffAdmission } from "../electron/main/runtime/handoff-admission.ts";
import { OwnerHandoffInventorySchema } from "../../../packages/shared/src/owner-handoff.ts";

const silent = () => undefined;
const entry = { key: "message:session:reply", sessionId: "session", message: { id: "reply" } };
const checkpoint = (id = "reply") => ({ sessionId: "session", turnId: "turn", message: {
  id, role: "assistant", content: "Partial response", timestamp: new Date(0).toISOString(),
} });
const idle = { writes: 0, uncontainedResources: 0 };

async function directory(t) {
  const path = await fs.mkdtemp(join(tmpdir(), "handoff-persistence-"));
  t.after(() => fs.rm(path, { recursive: true, force: true }));
  return path;
}
function intercept(t, method, handler) {
  const original = fs[method];
  t.mock.method(fs, method, (...args) => handler(original, ...args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("outbox recovery and waiting callers remain visible before loading completes", async (t) => {
  const dir = await directory(t), entered = Promise.withResolvers(), resume = Promise.withResolvers();
  intercept(t, "readFile", async (original, path, ...args) => {
    if (path === join(dir, "session-message-outbox.json")) { entered.resolve(); await resume.promise; }
    return original(path, ...args);
  });
  const outbox = new PersistenceOutbox(dir, silent);
  const loading = outbox.flush(() => null);
  try {
    await entered.promise;
    assert.ok(outbox.getHandoffActivity().writes > 0);
  } finally { resume.resolve(); await loading; }
  assert.deepEqual(outbox.getHandoffActivity(), idle);
});

test("an invalid outbox recovery never reports confirmed idle", async (t) => {
  const dir = await directory(t);
  await fs.writeFile(join(dir, "session-message-outbox.json"), "invalid json");
  const outbox = new PersistenceOutbox(dir, silent);
  await assert.rejects(outbox.flush(() => null));
  assert.equal(outbox.getHandoffActivity().uncontainedResources, 1);
});

test("dropping a session cannot hide its original Host append", async (t) => {
  const dir = await directory(t), entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const outbox = new PersistenceOutbox(dir, silent);
  const host = { isAvailable: () => true, call: async () => { entered.resolve(); await resume.promise; } };
  await outbox.enqueue(entry, () => host);
  try {
    await entered.promise; await outbox.dropSession(entry.sessionId);
    assert.equal(outbox.size(), 0);
    assert.ok(outbox.getHandoffActivity().writes > 0);
  } finally { resume.resolve(); await outbox.flush(() => host); }
  assert.deepEqual(outbox.getHandoffActivity(), idle);
});

test("an empty outbox stays busy until the actual disk clear completes", async (t) => {
  const dir = await directory(t), entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const outbox = new PersistenceOutbox(dir, silent);
  await outbox.enqueue(entry, () => null); await outbox.flush(() => null);
  intercept(t, "writeFile", async (original, path, data, ...args) => {
    if (path === join(dir, "session-message-outbox.json") && data === "[]\n") { entered.resolve(); await resume.promise; }
    return original(path, data, ...args);
  });
  const dropping = outbox.dropSession(entry.sessionId);
  try {
    await entered.promise;
    assert.equal(outbox.size(), 0);
    assert.ok(outbox.getHandoffActivity().writes > 0);
  } finally { resume.resolve(); await dropping; }
  assert.deepEqual(outbox.getHandoffActivity(), idle);
});

test("a best-effort disk clear failure remains uncertain after ordinary completion", async (t) => {
  const dir = await directory(t), logs = [];
  const outbox = new PersistenceOutbox(dir, (...args) => logs.push(args));
  await outbox.enqueue(entry, () => null); await outbox.flush(() => null);
  intercept(t, "writeFile", async (original, path, data, ...args) => {
    if (path === join(dir, "session-message-outbox.json") && data === "[]\n") throw new Error("disk clear failed");
    return original(path, data, ...args);
  });
  await outbox.dropSession(entry.sessionId);
  assert.equal(outbox.size(), 0);
  assert.equal(outbox.getHandoffActivity().uncontainedResources, 1);
  assert.ok(logs.some(([, message]) => message === "session persistence outbox clear failed"));
});

test("settled and disposed checkpoints retain their original in-flight writes", async () => {
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  const checkpointer = new InflightCheckpointer((value) => value.message.id === "reply" ? first.promise : second.promise);
  try {
    checkpointer.observe(checkpoint());
    const writingFirst = checkpointer.flush("session");
    checkpointer.settle("session");
    checkpointer.observe(checkpoint("newer"));
    const writingSecond = checkpointer.flush("session");
    checkpointer.dispose();
    assert.equal(checkpointer.getHandoffActivity().writes, 2);
    first.resolve(); await writingFirst;
    assert.equal(checkpointer.getHandoffActivity().writes, 1);
    second.resolve(); await writingSecond;
    assert.deepEqual(checkpointer.getHandoffActivity(), idle);
  } finally { first.resolve(); second.resolve(); checkpointer.dispose(); }
});

test("a checkpoint reserves its original write before invoking the save callback", async () => {
  const pending = Promise.withResolvers(); let writes = 0, observed;
  const checkpointer = new InflightCheckpointer(() => {
    writes++;
    observed = checkpointer.getHandoffActivity();
    if (writes === 1) void checkpointer.flush("session");
    return pending.promise;
  });
  try {
    checkpointer.observe(checkpoint());
    assert.equal(writes, 1);
    assert.equal(observed.writes, 1);
    pending.resolve(); await checkpointer.flush("session");
    assert.deepEqual(checkpointer.getHandoffActivity(), idle);
  } finally { pending.resolve(); checkpointer.dispose(); }
});

test("a trailing checkpoint is counted and cancellation removes only unsent work", async () => {
  let clock = 0;
  const checkpointer = new InflightCheckpointer(async () => undefined, 60_000, () => clock);
  try {
    checkpointer.observe(checkpoint()); await checkpointer.flush("session");
    clock = 1; checkpointer.observe(checkpoint());
    assert.equal(checkpointer.getHandoffActivity().writes, 1);
    checkpointer.settle("session");
    assert.deepEqual(checkpointer.getHandoffActivity(), idle);
  } finally { checkpointer.dispose(); }
});

test("failed checkpoints preserve best-effort behavior but refuse idle qualification", async () => {
  let calls = 0;
  const checkpointer = new InflightCheckpointer(async () => { if (++calls === 1) throw new Error("write failed"); });
  try {
    checkpointer.observe(checkpoint()); await checkpointer.flush("session");
    checkpointer.settle("session");
    checkpointer.observe(checkpoint("newer")); await checkpointer.flush("session");
    assert.equal(calls, 2);
    assert.deepEqual(checkpointer.getHandoffActivity(), { writes: 0, uncontainedResources: 1 });
  } finally { checkpointer.dispose(); }
});

test("reentrant flush joins the original append before any Host callback", async (t) => {
  const dir = await directory(t), resume = Promise.withResolvers();
  const outbox = new PersistenceOutbox(dir, silent);
  await outbox.enqueue(entry, () => null); await outbox.flush(() => null);
  let calls = 0, nested;
  const host = { isAvailable: () => true, call: () => {
    calls++;
    if (calls === 1) nested = outbox.flush(() => host);
    return resume.promise;
  } };
  const flushing = outbox.flush(() => host);
  await Promise.resolve(); await Promise.resolve();
  try { assert.equal(calls, 1); }
  finally { resume.resolve(); await flushing; await nested; }
  assert.deepEqual(outbox.getHandoffActivity(), idle);
});

test("an unconfirmed append remains uncertain even after its queue entry is removed", async (t) => {
  const dir = await directory(t);
  const outbox = new PersistenceOutbox(dir, silent);
  await outbox.enqueue(entry, () => null); await outbox.flush(() => null);
  await outbox.flush(() => ({ isAvailable: () => true, call: async () => { throw new Error("Host reply lost"); } }));
  await outbox.dropSession(entry.sessionId);
  assert.deepEqual(outbox.getHandoffActivity(), { writes: 0, uncontainedResources: 1 });
});

test("the Desktop gate refuses actual outbox and retired checkpoint work until both finish", async (t) => {
  const dir = await directory(t), checkpointWrite = Promise.withResolvers(), appendWrite = Promise.withResolvers();
  const appendStarted = Promise.withResolvers();
  const admission = new DesktopHandoffAdmission();
  const outbox = new PersistenceOutbox(dir, silent);
  const checkpointer = new InflightCheckpointer(() => checkpointWrite.promise);
  const host = { isAvailable: () => true, call: async () => { appendStarted.resolve(); await appendWrite.promise; } };
  const inspect = async () => {
    // Other resource families are external boundaries of this persistence fixture.
    const counts = Object.fromEntries(Object.keys(OwnerHandoffInventorySchema.properties).map(key => [key, 0]));
    for (const owner of [outbox, checkpointer]) {
      const activity = owner.getHandoffActivity();
      counts.writes += activity.writes;
      counts.uncontainedResources += activity.uncontainedResources;
    }
    return counts;
  };
  try {
    checkpointer.observe(checkpoint());
    const checkpointDone = checkpointer.flush("session");
    checkpointer.settle("session");
    await outbox.enqueue(entry, () => host); await appendStarted.promise;
    await outbox.dropSession(entry.sessionId);
    await assert.rejects(admission.gate.acquireHandoff("transfer", inspect), { code: "HOST_BUSY" });
    assert.equal(admission.isClosed(), false);
    appendWrite.resolve(); await outbox.flush(() => host);
    await assert.rejects(admission.gate.acquireHandoff("transfer", inspect), { code: "HOST_BUSY" });
    checkpointWrite.resolve(); await checkpointDone;
    const hold = await admission.gate.acquireHandoff("transfer", inspect);
    assert.equal(admission.isClosed(), true);
    await assert.rejects(admission.run(async () => assert.fail("new work must be refused")), { errorCode: "HOST_BUSY" });
    hold.cancel();
    assert.equal(admission.isClosed(), false);
  } finally {
    appendWrite.resolve(); checkpointWrite.resolve();
    await outbox.flush(() => host); checkpointer.dispose(); admission.dispose();
  }
});

test("a synchronous save failure stays observable and does not strand checkpoint accounting", async () => {
  let calls = 0;
  const checkpointer = new InflightCheckpointer(() => {
    if (++calls === 1) throw new Error("synchronous save failure");
    return Promise.resolve();
  });
  try {
    assert.throws(() => checkpointer.observe(checkpoint()), /synchronous save failure/);
    checkpointer.settle("session");
    checkpointer.observe(checkpoint("newer")); await checkpointer.flush("session");
    assert.equal(calls, 2);
    assert.deepEqual(checkpointer.getHandoffActivity(), { writes: 0, uncontainedResources: 1 });
  } finally { checkpointer.dispose(); }
});
