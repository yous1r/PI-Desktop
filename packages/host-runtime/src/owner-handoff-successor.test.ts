import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { OwnerHandoffResponse } from "@pi-desktop/shared";
import {
  OwnerHandoffSuccessor,
  HANDOFF_EVENT_EPOCH_MISMATCH,
  HANDOFF_EVENT_EPOCH_UNAVAILABLE,
  HANDOFF_RECORD_MISMATCH,
  HANDOFF_RECORD_NOT_READY,
  HANDOFF_RECORD_UNAVAILABLE,
  HANDOFF_SUCCESSOR_DISPOSED,
} from "./owner-handoff-successor.js";
import {
  HANDOFF_TARGET_READY_UNAVAILABLE,
  OwnerHandoffTargetSupervisor,
  type OwnerHandoffReadyOutcome,
  type OwnerHandoffTargetEnvelope,
  type OwnerHandoffTargetReadyRequest,
  type OwnerHandoffTargetTransport,
} from "./owner-handoff-target.js";

const fixture = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/owner-handoff.json", import.meta.url), "utf8"));
const base = fixture.response.record;
const claim = fixture.bootstrap[1];
const target = { transferId: base.id, sourceEpoch: base.sourceEpoch, profileId: base.profile };
const targetBuild = base.targetBuild;
const releasePending = { ...base, phase: "release_pending", revision: claim.expected_revision };
const readyRecord = { ...base, phase: "ready", revision: claim.expected_revision + 2 };
const readyOutcome: OwnerHandoffReadyOutcome = {
  record: readyRecord,
  ready: { ...fixture.ready, recordRevision: readyRecord.revision },
};

class FakeTransport implements OwnerHandoffTargetTransport {
  readonly calls: OwnerHandoffTargetEnvelope[] = [];
  readonly readyCalls: OwnerHandoffTargetReadyRequest[] = [];
  disposed = 0;
  confirmations = 0;
  exitConfirmed = true;
  private claimed?: OwnerHandoffReadyOutcome["record"];
  constructor(private readonly withReady = true) {}
  call(request: OwnerHandoffTargetEnvelope): Promise<OwnerHandoffResponse> {
    this.calls.push(request);
    const command = request.command;
    const record = { ...base, id: command.transfer_id, profile: request.profileId, sourceEpoch: command.source_epoch,
      targetEpoch: command.target_epoch, revision: command.expected_revision + 1, phase: "target_claimed" as const,
      targetBuild: request.targetBuild };
    this.claimed = record;
    return Promise.resolve({ version: 1, record });
  }
  ready(request: OwnerHandoffTargetReadyRequest): Promise<OwnerHandoffReadyOutcome> {
    this.readyCalls.push(request);
    if (!this.withReady || !this.claimed) {
      return Promise.reject(Object.assign(new Error(HANDOFF_TARGET_READY_UNAVAILABLE), { errorCode: HANDOFF_TARGET_READY_UNAVAILABLE }));
    }
    const record = { ...this.claimed, phase: "ready" as const, revision: this.claimed.revision + 1 };
    return Promise.resolve({ record, ready: { ...readyOutcome.ready, recordRevision: record.revision } });
  }
  confirmExit(): Promise<boolean> { this.confirmations += 1; return Promise.resolve(this.exitConfirmed); }
  hasProcess(): boolean { return true; }
  dispose(): Promise<void> { this.disposed += 1; return Promise.resolve(); }
}

function successor(options: {
  records?: Array<ReturnType<typeof baseRecord> | null>;
  withReady?: boolean;
  epoch?: string | null;
} = {}) {
  const records = [...(options.records ?? [baseRecord("release_pending", claim.expected_revision), baseRecord("ready", readyRecord.revision)])];
  const transport = new FakeTransport(options.withReady ?? true);
  const instance = new OwnerHandoffSuccessor({
    target, claim, targetBuild,
    readOriginal: async () => {
      const next = records.length > 1 ? records.shift() : records[0];
      return next === null || next === undefined ? null : { version: 1, record: next };
    },
    eventEpoch: async () => options.epoch === undefined ? readyOutcome.ready.eventEpoch : options.epoch,
    launch: context => new OwnerHandoffTargetSupervisor({
      transport, profileId: context.profileId, targetBuild: context.targetBuild, claim: context.claim,
    }),
  });
  return { instance, transport };
}
function baseRecord(phase: "release_pending" | "ready", revision: number) {
  return { ...base, phase, revision };
}

describe("OwnerHandoffSuccessor", () => {
  it("launches the prepared target, exposes claim identity and returns strict record + Ready", async () => {
    const { instance, transport } = successor();
    const outcome = await instance.ensureStarted();
    expect(outcome.record.phase).toBe("ready");
    expect(instance.state).toBe("ready");
    expect(instance.identity()).toEqual({ profileId: base.profile, ownerEpoch: claim.target_epoch, protocolVersion: 11 });
    const status = await instance.readStatus(target, new AbortController().signal);
    expect(status.response.record).toMatchObject({ id: base.id, phase: "ready", revision: readyRecord.revision });
    expect(status.ready).toEqual(readyOutcome.ready);
    expect(transport.calls).toHaveLength(1);
    expect(transport.readyCalls).toHaveLength(1);
    await instance.dispose();
    expect(transport.disposed).toBe(1);
    expect(transport.confirmations).toBeGreaterThan(0);
  });

  it("fails closed when the original record is missing", async () => {
    const { instance } = successor({ records: [null] });
    await expect(instance.ensureStarted()).rejects.toMatchObject({ errorCode: HANDOFF_RECORD_UNAVAILABLE });
    expect(instance.state).toBe("error");
    expect(() => instance.identity()).toThrow();
  });

  it("refuses a record that is not release-ready", async () => {
    const { instance } = successor({ records: [{ ...base, phase: "prepared", revision: claim.expected_revision }] });
    await expect(instance.ensureStarted()).rejects.toMatchObject({ errorCode: HANDOFF_RECORD_NOT_READY });
  });

  it("fails closed when the target publishes no Ready", async () => {
    const { instance } = successor({ withReady: false });
    await expect(instance.ensureStarted()).rejects.toMatchObject({ errorCode: HANDOFF_TARGET_READY_UNAVAILABLE });
  });

  it("refuses a status read before the target is ready", async () => {
    const { instance } = successor();
    await expect(instance.readStatus(target, new AbortController().signal)).rejects.toMatchObject({ errorCode: HANDOFF_TARGET_READY_UNAVAILABLE });
  });

  it("refuses an event epoch that is not the target's live stream", async () => {
    const { instance } = successor({ epoch: "epoch_other_stream",
      records: [baseRecord("release_pending", claim.expected_revision), baseRecord("ready", readyRecord.revision)] });
    await instance.ensureStarted();
    await expect(instance.readStatus(target, new AbortController().signal)).rejects.toMatchObject({ errorCode: HANDOFF_EVENT_EPOCH_MISMATCH });
  });

  it("refuses a missing target event stream and a drifted original record", async () => {
    const missing = successor({ epoch: null });
    await missing.instance.ensureStarted();
    await expect(missing.instance.readStatus(target, new AbortController().signal)).rejects.toMatchObject({ errorCode: HANDOFF_EVENT_EPOCH_UNAVAILABLE });

    const drifted = successor({ records: [baseRecord("release_pending", claim.expected_revision), { ...baseRecord("ready", readyRecord.revision + 1) }] });
    await drifted.instance.ensureStarted();
    await expect(drifted.instance.readStatus(target, new AbortController().signal)).rejects.toMatchObject({ errorCode: HANDOFF_RECORD_MISMATCH });
  });

  it("disposes the child once and refuses further observation", async () => {
    const { instance, transport } = successor();
    await instance.ensureStarted();
    const first = instance.dispose();
    const second = instance.dispose();
    expect(second).toBe(first);
    await first;
    expect(transport.disposed).toBe(1);
    expect(instance.state).toBe("disposed");
    expect(() => instance.identity()).toThrow();
    await expect(instance.readStatus(target, new AbortController().signal)).rejects.toMatchObject({ errorCode: HANDOFF_SUCCESSOR_DISPOSED });
  });
});
