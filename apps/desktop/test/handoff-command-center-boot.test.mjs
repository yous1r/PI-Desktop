import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { readFile } from "node:fs/promises";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const {
  createCommandCenterHandoffBoot,
  disposeCommandCenterHandoffBeforeRemoteHosts,
  getActiveCommandCenterHandoffBoot,
  setActiveCommandCenterHandoffBoot,
  registerCommandCenterHandoffTransfer,
  HANDOFF_SUCCESSOR_AUTHORITY_UNAVAILABLE,
  HANDOFF_SUCCESSOR_CLAIM_UNAVAILABLE,
  HANDOFF_SUCCESSOR_EPOCH_UNAVAILABLE,
  HANDOFF_SUCCESSOR_BUILD_UNAVAILABLE,
  HANDOFF_SUCCESSOR_ALREADY_REGISTERED,
  HANDOFF_SUCCESSOR_DISPOSED,
} = await import("../electron/main/bootstrap/command-center-handoff.ts");
const golden = JSON.parse(await readFile(new URL("../../../packages/shared/test/fixtures/owner-handoff.json", import.meta.url), "utf8"));

const authority = {
  host: { generation: 1, isAvailable: () => true, call: async () => ({}) },
  sourceEpoch: golden.response.record.sourceEpoch,
  profileId: golden.response.record.profile,
};
const bindingFor = (hostKey = "successor") => ({
  hostKey,
  authority,
  claim: { ...golden.bootstrap[1] },
  targetBuild: golden.response.record.targetBuild,
  sessionId: "s1",
  eventEpoch: async () => "epoch_target_stream",
  launch: () => { throw new Error("the launcher runs only when the successor starts"); },
});
const host = hostKey => ({ hostKey, client: {} });

test("startup constructs an idle root; it observes nothing until the handoff command registers a transfer", async () => {
  const boot = createCommandCenterHandoffBoot({ dataDir: "fixture" });
  assert.equal(boot.state, "idle");
  assert.deepEqual(boot.registrations(), []);
  assert.equal(boot.handoffAttachment(host("any")), undefined);
  await boot.dispose();
  assert.equal(boot.state, "disposed");
  assert.equal(boot.handoffAttachment(host("any")), undefined);
  await assert.rejects(async () => boot.register(bindingFor()), error => error.code === HANDOFF_SUCCESSOR_DISPOSED);
});

test("registration refuses each missing binding part with its own explicit code", async () => {
  const boot = createCommandCenterHandoffBoot({ dataDir: "fixture" });
  await assert.rejects(async () => boot.register({ ...bindingFor(), authority: undefined }),
    error => error.code === HANDOFF_SUCCESSOR_AUTHORITY_UNAVAILABLE);
  await assert.rejects(async () => boot.register({ ...bindingFor(), hostKey: "" }),
    error => error.code === HANDOFF_SUCCESSOR_AUTHORITY_UNAVAILABLE);
  await assert.rejects(async () => boot.register({ ...bindingFor(), claim: { ...golden.bootstrap[1], operation: "status" } }),
    error => error.code === HANDOFF_SUCCESSOR_CLAIM_UNAVAILABLE);
  await assert.rejects(async () => boot.register({ ...bindingFor(), eventEpoch: undefined }),
    error => error.code === HANDOFF_SUCCESSOR_EPOCH_UNAVAILABLE);
  await assert.rejects(async () => boot.register({ ...bindingFor(), targetBuild: undefined }),
    error => error.code === HANDOFF_SUCCESSOR_BUILD_UNAVAILABLE);
  assert.deepEqual(boot.registrations(), []);
  await boot.dispose();
});

test("registration binds the original Host authority and exposes only its host key", async () => {
  const boot = createCommandCenterHandoffBoot({ dataDir: "fixture" });
  const registration = boot.register(bindingFor("successor"));
  assert.equal(boot.state, "active");
  assert.equal(registration.hostKey, "successor");
  assert.equal(boot.handoffAttachment(host("other")), undefined);
  const request = boot.handoffAttachment(host("successor"));
  assert.ok(request?.successor);
  assert.equal(request.sessionId, "s1");
  assert.deepEqual(request.target, {
    transferId: golden.response.record.id,
    sourceEpoch: golden.response.record.sourceEpoch,
    profileId: golden.response.record.profile,
  });
  await assert.rejects(async () => boot.register(bindingFor("successor")),
    error => error.code === HANDOFF_SUCCESSOR_ALREADY_REGISTERED);
  await registration.dispose();
  assert.deepEqual(boot.registrations(), []);
  assert.equal(boot.handoffAttachment(host("successor")), undefined);
  await boot.dispose();
});

test("the existing handoff command entry refuses without a startup root and registers on the active one", async () => {
  setActiveCommandCenterHandoffBoot(null);
  await assert.rejects(async () => registerCommandCenterHandoffTransfer(bindingFor()),
    error => error.code === HANDOFF_SUCCESSOR_AUTHORITY_UNAVAILABLE);
  const boot = createCommandCenterHandoffBoot({ dataDir: "fixture" });
  setActiveCommandCenterHandoffBoot(boot);
  const registration = registerCommandCenterHandoffTransfer(bindingFor("successor"));
  assert.equal(getActiveCommandCenterHandoffBoot(), boot);
  assert.equal(boot.registrations().length, 1);
  assert.equal(registration.hostKey, "successor");
  await boot.dispose();
  setActiveCommandCenterHandoffBoot(null);
  assert.equal(getActiveCommandCenterHandoffBoot(), null);
});

test("shutdown stops the successor children before the paired remote hosts close", async () => {
  const order = [];
  await disposeCommandCenterHandoffBeforeRemoteHosts(
    { dispose: async () => { order.push("handoff"); } },
    async () => { order.push("remote-hosts"); },
  );
  assert.deepEqual(order, ["handoff", "remote-hosts"]);
  const withoutHandoff = [];
  await disposeCommandCenterHandoffBeforeRemoteHosts(null, async () => { withoutHandoff.push("remote-hosts"); });
  assert.deepEqual(withoutHandoff, ["remote-hosts"]);
});

test("a failing handoff dispose still closes the remote hosts and propagates the failure", async () => {
  const order = [];
  const failure = new Error("fixture successor cleanup failed");
  await assert.rejects(disposeCommandCenterHandoffBeforeRemoteHosts(
    { dispose: async () => { order.push("handoff"); throw failure; } },
    async () => { order.push("remote-hosts"); },
  ), error => error === failure);
  assert.deepEqual(order, ["handoff", "remote-hosts"]);
});
