import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerHandoffResponse } from "@pi-desktop/shared";
import {
  HANDOFF_CANCELLED,
  HANDOFF_DISPOSED,
  HANDOFF_TARGET_READY_TIMEOUT,
  HANDOFF_TARGET_READY_UNAVAILABLE,
  OwnerHandoffTargetSupervisor,
  validateOwnerHandoffTargetClaimReceipt,
  validateOwnerHandoffTargetReadyOutcome,
  type OwnerHandoffReadyOutcome,
  type OwnerHandoffTargetEnvelope,
  type OwnerHandoffTargetReadyResources,
  type OwnerHandoffTargetTransport,
} from "./owner-handoff-target.js";

const fixture = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/owner-handoff.json", import.meta.url), "utf8"));
const claim = fixture.bootstrap[1];
const profileId: string = fixture.response.record.profile;
const targetBuild = fixture.response.record.targetBuild;
const claimedRecord = {
  ...fixture.response.record,
  phase: "target_claimed",
  revision: claim.expected_revision + 1,
};
const readyRecord = { ...claimedRecord, phase: "ready", revision: claimedRecord.revision + 1 };
const readyOutcome: OwnerHandoffReadyOutcome = {
  record: readyRecord,
  ready: { ...fixture.ready, recordRevision: readyRecord.revision },
};

type Responder = (request: OwnerHandoffTargetEnvelope) => Promise<OwnerHandoffResponse>;
class FakeTransport implements OwnerHandoffTargetTransport {
  readonly calls: OwnerHandoffTargetEnvelope[] = [];
  readonly timeouts: number[] = [];
  disposed = 0;
  confirmed = 0;
  exitConfirmed = true;
  disposeFailure?: Error;
  constructor(private readonly responder: Responder = () => Promise.resolve({ version: 1, record: claimedRecord })) {}
  call(request: OwnerHandoffTargetEnvelope, timeoutMs: number): Promise<OwnerHandoffResponse> {
    this.calls.push(request);
    this.timeouts.push(timeoutMs);
    return this.responder(request);
  }
  confirmExit(_timeoutMs?: number): Promise<boolean> {
    this.confirmed += 1;
    return Promise.resolve(this.exitConfirmed);
  }
  dispose(): Promise<void> {
    this.disposed += 1;
    return this.disposeFailure ? Promise.reject(this.disposeFailure) : Promise.resolve();
  }
}
function build(overrides: Partial<ConstructorParameters<typeof OwnerHandoffTargetSupervisor>[0]> = {}) {
  const transport = overrides.transport ?? new FakeTransport();
  const states: string[] = [];
  const supervisor = new OwnerHandoffTargetSupervisor({
    transport,
    profileId,
    targetBuild,
    claim,
    onState: (state) => states.push(state),
    ...overrides,
  });
  return { transport: transport as FakeTransport, states, supervisor };
}
function pending(): { promise: Promise<OwnerHandoffResponse>; resolve: (value: OwnerHandoffResponse) => void } {
  let resolve!: (value: OwnerHandoffResponse) => void;
  const promise = new Promise<OwnerHandoffResponse>((done) => { resolve = done; });
  return { promise, resolve };
}
function ready(extra: Partial<OwnerHandoffReadyOutcome> = {}): OwnerHandoffTargetReadyResources {
  return { publishReady: () => ({ ...readyOutcome, ...extra }) };
}
afterEach(() => vi.useRealTimers());

describe("restricted target supervisor", () => {
  it("sends the committed envelope once and publishes Ready only through the injected resources", async () => {
    const publication: Array<{ request: unknown; receipt: unknown }> = [];
    const { transport, states, supervisor } = build({
      readyResources: {
        publishReady: (value) => { publication.push(value); return readyOutcome; },
      },
    });
    expect(supervisor.state).toBe("spawned");
    await expect(supervisor.start()).resolves.toEqual(readyOutcome);
    expect(transport.calls).toEqual([{ version: 1, profileId, targetBuild, command: claim }]);
    expect(transport.timeouts).toEqual([15_000]);
    expect(publication).toEqual([{ request: claim, receipt: claimedRecord }]);
    expect(states).toEqual(["claim-sent", "claimed", "ready"]);
    expect(supervisor.state).toBe("ready");
    expect(supervisor.claimed).toEqual(claimedRecord);
    expect(supervisor.ready).toEqual(readyOutcome);
    // A published Ready retains the serving child until the owner disposes it.
    expect(transport.disposed).toBe(0);
    await supervisor.dispose();
    expect(transport.disposed).toBe(1);
    expect(supervisor.state).toBe("ready");
  });

  it("refuses a receipt with any profile, transfer, epoch, revision, phase or build drift", async () => {
    const variants = [
      { ...claimedRecord, profile: "f".repeat(64) },
      { ...claimedRecord, id: claim.request_id },
      { ...claimedRecord, sourceEpoch: claim.request_id },
      { ...claimedRecord, targetEpoch: claim.request_id },
      { ...claimedRecord, revision: claim.expected_revision },
      { ...claimedRecord, phase: "release_pending" },
      { ...claimedRecord, targetBuild: { ...targetBuild, sha256: "d".repeat(64) } },
    ];
    for (const record of variants) {
      const { transport, supervisor } = build({
        transport: new FakeTransport(() => Promise.resolve({ version: 1, record })),
        readyResources: ready(),
      });
      await expect(supervisor.start()).rejects.toMatchObject({ errorCode: "HANDOFF_RESPONSE_MISMATCH" });
      expect(supervisor.state).toBe("ready-refused");
      expect(supervisor.ready).toBeUndefined();
      expect(transport.disposed).toBe(1);
      expect(await transport.confirmExit(0)).toBe(true);
    }
  });

  it("refuses malformed receipts and classified native refusals without publishing Ready", async () => {
    const cases: Array<[OwnerHandoffResponse, string]> = [
      [{ version: 1, record: {} } as unknown as OwnerHandoffResponse, "HANDOFF_INVALID_RESPONSE"],
      [{ version: 1, error: { code: "HANDOFF_RECOVERY_REQUIRED" } }, "HANDOFF_RECOVERY_REQUIRED"],
    ];
    for (const [response, code] of cases) {
      const { transport, supervisor } = build({
        transport: new FakeTransport(() => Promise.resolve(response)),
        readyResources: ready(),
      });
      await expect(supervisor.start()).rejects.toMatchObject({ errorCode: code });
      expect(supervisor.state).toBe("ready-refused");
      expect(transport.disposed).toBe(1);
    }
  });

  it("times out a silent claim and disposes the original child", async () => {
    vi.useFakeTimers();
    const call = pending();
    const { transport, supervisor } = build({
      transport: new FakeTransport(() => call.promise),
      claimTimeoutMs: 25,
      readyResources: ready(),
    });
    const started = supervisor.start();
    const rejected = expect(started).rejects.toMatchObject({ errorCode: "HANDOFF_IO_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(supervisor.state).toBe("ready-refused");
    expect(transport.disposed).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed when the child exits instead of answering the claim", async () => {
    const { transport, supervisor } = build({
      transport: new FakeTransport(() => Promise.reject(
        Object.assign(new Error("HANDOFF_TRANSPORT_CLOSED"), { errorCode: "HANDOFF_TRANSPORT_CLOSED" }),
      )),
      readyResources: ready(),
    });
    await expect(supervisor.start()).rejects.toMatchObject({ errorCode: "HANDOFF_TRANSPORT_CLOSED" });
    expect(supervisor.state).toBe("ready-refused");
    expect(transport.disposed).toBe(1);
    expect(transport.confirmed).toBeGreaterThanOrEqual(1);
    expect(supervisor.ready).toBeUndefined();
  });

  it("cancels an outstanding claim and cleans up exactly once", async () => {
    const call = pending();
    const { transport, supervisor } = build({
      transport: new FakeTransport(() => call.promise),
      readyResources: ready(),
    });
    const started = supervisor.start();
    await supervisor.cancel();
    await expect(started).rejects.toMatchObject({ errorCode: HANDOFF_CANCELLED });
    expect(supervisor.state).toBe("ready-refused");
    expect(transport.disposed).toBe(1);
    await supervisor.dispose();
    expect(transport.disposed).toBe(1);
  });

  it("disposes an outstanding claim explicitly and reports the child exit", async () => {
    const call = pending();
    const { transport, supervisor } = build({
      transport: new FakeTransport(() => call.promise),
      readyResources: ready(),
    });
    const started = supervisor.start();
    await supervisor.dispose();
    await expect(started).rejects.toMatchObject({ errorCode: HANDOFF_DISPOSED });
    expect(supervisor.state).toBe("ready-refused");
    expect(transport.disposed).toBe(1);
    await supervisor.dispose();
    expect(transport.disposed).toBe(1);
  });

  it("reports ready unavailable rather than inventing Ready without the injected owner", async () => {
    const { transport, supervisor } = build();
    await expect(supervisor.start()).rejects.toMatchObject({ errorCode: HANDOFF_TARGET_READY_UNAVAILABLE });
    expect(supervisor.state).toBe("ready-refused");
    expect(supervisor.claimed).toEqual(claimedRecord);
    expect(supervisor.ready).toBeUndefined();
    expect(transport.disposed).toBe(1);
  });

  it("preserves a classified readiness refusal from the injected owner", async () => {
    const { transport, supervisor } = build({
      readyResources: {
        publishReady: () => { throw new Error("HANDOFF_TARGET_NOT_INITIALIZED"); },
      },
    });
    await expect(supervisor.start()).rejects.toMatchObject({ errorCode: "HANDOFF_TARGET_NOT_INITIALIZED" });
    expect(supervisor.state).toBe("ready-refused");
    expect(supervisor.ready).toBeUndefined();
    expect(transport.disposed).toBe(1);
  });

  it("rejects a Ready outcome that is not the exact next revision of the claim", async () => {
    for (const bad of [
      { ...readyOutcome, record: { ...readyRecord, revision: readyRecord.revision + 1 } },
      { ...readyOutcome, record: { ...readyRecord, phase: "target_claimed" } },
      { ...readyOutcome, record: { ...readyRecord, id: claim.request_id } },
      { ...readyOutcome, ready: { ...readyOutcome.ready, ownerEpoch: claim.request_id } },
    ]) {
      const { transport, supervisor } = build({
        readyResources: { publishReady: () => bad as OwnerHandoffReadyOutcome },
      });
      await expect(supervisor.start()).rejects.toMatchObject({ errorCode: "HANDOFF_INVALID_READY" });
      expect(supervisor.state).toBe("ready-refused");
      expect(transport.disposed).toBe(1);
    }
  });

  it("times out a stalled Ready owner and keeps admission closed", async () => {
    vi.useFakeTimers();
    const { transport, supervisor } = build({
      readyResources: { publishReady: () => new Promise<never>(() => undefined) },
      readyTimeoutMs: 25,
    });
    const started = supervisor.start();
    const rejected = expect(started).rejects.toMatchObject({ errorCode: HANDOFF_TARGET_READY_TIMEOUT });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(supervisor.state).toBe("ready-refused");
    expect(transport.disposed).toBe(1);
  });

  it("retains a cleanup failure as diagnostic evidence without reporting Ready", async () => {
    const disposeFailure = Object.assign(new Error("HANDOFF_EXIT_UNCONFIRMED"), { errorCode: "HANDOFF_EXIT_UNCONFIRMED" });
    const transport = new FakeTransport(() => Promise.reject(
      Object.assign(new Error("HANDOFF_TRANSPORT_CLOSED"), { errorCode: "HANDOFF_TRANSPORT_CLOSED" }),
    ));
    transport.disposeFailure = disposeFailure;
    const { supervisor } = build({ transport, readyResources: ready() });
    const error = await supervisor.start().then(
      () => { throw new Error("expected a refusal"); },
      (value: Error & { errorCode?: string; cleanupError?: Error }) => value,
    );
    expect(error.errorCode).toBe("HANDOFF_TRANSPORT_CLOSED");
    expect((error as Error & { cleanupError?: { errorCode?: string } }).cleanupError?.errorCode)
      .toBe("HANDOFF_EXIT_UNCONFIRMED");
    expect(supervisor.state).toBe("ready-refused");
  });

  it("refuses a second start and invalid constructor input without writing a frame", async () => {
    const first = build({ readyResources: ready() });
    await first.supervisor.start();
    await expect(first.supervisor.start()).rejects.toMatchObject({ errorCode: "HANDOFF_INVALID_STATE" });
    for (const options of [
      { profileId: "not-a-digest" },
      { claim: fixture.bootstrap[0] },
      { targetBuild: null },
      { claim: { ...claim, expected_revision: 9_007_199_254_740_991 } },
    ]) {
      const transport = new FakeTransport();
      expect(() => new OwnerHandoffTargetSupervisor({
        transport, profileId, targetBuild, claim, ...options,
      } as unknown as ConstructorParameters<typeof OwnerHandoffTargetSupervisor>[0])).toThrow();
      expect(transport.calls).toEqual([]);
    }
  });

  it("validates receipts and Ready outcomes as pure, reusable contract checks", () => {
    expect(validateOwnerHandoffTargetClaimReceipt(
      { version: 1, record: claimedRecord },
      { version: 1, profileId, targetBuild, command: claim },
    )).toEqual(claimedRecord);
    expect(() => validateOwnerHandoffTargetClaimReceipt(
      { version: 1, record: { ...claimedRecord, revision: 1 } },
      { version: 1, profileId, targetBuild, command: claim },
    )).toThrow("HANDOFF_RESPONSE_MISMATCH");
    expect(validateOwnerHandoffTargetReadyOutcome(readyOutcome, claimedRecord)).toEqual(readyOutcome);
    expect(() => validateOwnerHandoffTargetReadyOutcome(readyOutcome, { ...claimedRecord, revision: 0 }))
      .toThrow("HANDOFF_INVALID_READY");
  });
});
