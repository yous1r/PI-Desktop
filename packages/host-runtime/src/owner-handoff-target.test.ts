import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerHandoffResponse } from "@pi-desktop/shared";
import {
  HANDOFF_CANCELLED,
  HANDOFF_DISPOSED,
  HANDOFF_TARGET_READY_TIMEOUT,
  HANDOFF_TARGET_READY_UNAVAILABLE,
  HANDOFF_TARGET_SIDECAR_UNAVAILABLE,
  OwnerHandoffTargetSupervisor,
  createOwnerHandoffTargetReadyRequest,
  validateOwnerHandoffTargetClaimReceipt,
  validateOwnerHandoffTargetReadyOutcome,
  type OwnerHandoffReadyOutcome,
  type OwnerHandoffTargetAttachEpoch,
  type OwnerHandoffTargetEnvelope,
  type OwnerHandoffTargetLaunch,
  type OwnerHandoffTargetReadyRequest,
  type OwnerHandoffTargetReadyResources,
  type OwnerHandoffTargetSidecar,
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
class ReadyTransport extends FakeTransport {
  readonly readyCalls: OwnerHandoffTargetReadyRequest[] = [];
  readonly readyTimeouts: number[] = [];
  constructor(
    private readonly readyResponder: (request: OwnerHandoffTargetReadyRequest) => Promise<OwnerHandoffReadyOutcome>,
    responder?: Responder,
  ) {
    super(responder);
  }
  ready(request: OwnerHandoffTargetReadyRequest, timeoutMs: number): Promise<OwnerHandoffReadyOutcome> {
    this.readyCalls.push(request);
    this.readyTimeouts.push(timeoutMs);
    return this.readyResponder(request);
  }
}
const TICKET_GENERATION = "77777777-7777-4777-8777-777777777777";
function launchFrame(transferId: string, targetEpoch: string): OwnerHandoffTargetLaunch {
  return {
    version: 1,
    operation: "launch-sidecar",
    transferId,
    targetEpoch,
    ticket: {
      version: 1,
      generation: TICKET_GENERATION,
      address: `\\\\.\\pipe\\pi-execution-v1-${TICKET_GENERATION}`,
      capability: "88888888-8888-4888-8888-888888888888",
      ownerPid: 321,
      ownerCreatedAt: "134115649234567890",
    },
  };
}
class JoinTransport extends FakeTransport {
  readonly attachCalls: OwnerHandoffTargetAttachEpoch[] = [];
  readonly launch: OwnerHandoffTargetLaunch;
  constructor(
    private readonly outcome: OwnerHandoffReadyOutcome = readyOutcome,
    responder?: Responder,
  ) {
    super(responder);
    this.launch = launchFrame(claim.transfer_id, claim.target_epoch);
  }
  receiveLaunch(): Promise<OwnerHandoffTargetLaunch> {
    return Promise.resolve(this.launch);
  }
  attachEpoch(request: OwnerHandoffTargetAttachEpoch): Promise<OwnerHandoffReadyOutcome> {
    this.attachCalls.push(request);
    return Promise.resolve(this.outcome);
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

  it("sends exactly one ready command to the same claimed process and accepts its ReadyOutcome", async () => {
    const transport = new ReadyTransport(() => Promise.resolve(readyOutcome));
    const states: string[] = [];
    const supervisor = new OwnerHandoffTargetSupervisor({
      transport, profileId, targetBuild, claim, onState: (state) => states.push(state),
    });
    await expect(supervisor.start()).resolves.toEqual(readyOutcome);
    expect(transport.readyCalls).toHaveLength(1);
    expect(transport.readyCalls[0]).toMatchObject({
      version: 1,
      operation: "ready",
      transferId: claim.transfer_id,
      targetEpoch: claim.target_epoch,
      expectedRevision: claim.expected_revision + 1,
    });
    expect(transport.readyCalls[0]!.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(transport.readyTimeouts).toEqual([30_000]);
    expect(states).toEqual(["claim-sent", "claimed", "ready"]);
    expect(transport.disposed).toBe(0);
    await supervisor.dispose();
  });

  it("launches the sidecar ticket, attaches the live hub epoch, then accepts Ready", async () => {
    const transport = new JoinTransport();
    const launched: unknown[] = [];
    let sidecarDisposed = 0;
    const sidecar: OwnerHandoffTargetSidecar = {
      launch: (ticket) => {
        launched.push(ticket);
        return { dispose: () => { sidecarDisposed += 1; } };
      },
      eventEpoch: () => "hub-event-epoch",
    };
    const supervisor = new OwnerHandoffTargetSupervisor({
      transport, profileId, targetBuild, claim, sidecar,
    });
    await expect(supervisor.start()).resolves.toEqual(readyOutcome);
    expect(launched).toEqual([transport.launch.ticket]);
    expect(transport.attachCalls).toHaveLength(1);
    expect(transport.attachCalls[0]).toMatchObject({
      version: 1,
      operation: "attachEpoch",
      transferId: claim.transfer_id,
      targetEpoch: claim.target_epoch,
      expectedRevision: claimedRecord.revision,
      eventEpoch: "hub-event-epoch",
    });
    expect(transport.attachCalls[0]!.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(supervisor.state).toBe("ready");
    expect(sidecarDisposed).toBe(0);
    await supervisor.dispose();
    expect(sidecarDisposed).toBe(1);
  });

  it("disposes a sidecar resource that resolves after cancellation", async () => {
    const transport = new JoinTransport();
    let releaseLaunch!: (resource: { dispose(): void }) => void;
    let markLaunched!: () => void;
    const launched = new Promise<void>((resolve) => { markLaunched = resolve; });
    let disposed = 0;
    const sidecar: OwnerHandoffTargetSidecar = {
      launch: () => {
        markLaunched();
        return new Promise((resolve) => {
          releaseLaunch = (resource) => resolve(resource);
        });
      },
      eventEpoch: () => "hub-event-epoch",
    };
    const supervisor = new OwnerHandoffTargetSupervisor({
      transport, profileId, targetBuild, claim, sidecar,
    });
    const starting = supervisor.start();
    await launched;
    await supervisor.cancel();
    await expect(starting).rejects.toMatchObject({ errorCode: HANDOFF_CANCELLED });
    releaseLaunch({ dispose: () => { disposed += 1; } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(disposed).toBe(1);
    expect(transport.attachCalls).toEqual([]);
  });

  it("refuses the launch path without a sidecar provider", async () => {
    const transport = new JoinTransport();
    const supervisor = new OwnerHandoffTargetSupervisor({ transport, profileId, targetBuild, claim });
    await expect(supervisor.start()).rejects.toMatchObject({
      errorCode: HANDOFF_TARGET_SIDECAR_UNAVAILABLE,
    });
    expect(supervisor.state).toBe("ready-refused");
    expect(transport.attachCalls).toEqual([]);
    expect(transport.disposed).toBe(1);
  });

  it("fails closed on a classified ready refusal from the same process", async () => {    const transport = new ReadyTransport(() => Promise.reject(
      Object.assign(new Error("HANDOFF_TARGET_NOT_INITIALIZED"), { errorCode: "HANDOFF_TARGET_NOT_INITIALIZED" }),
    ));
    const supervisor = new OwnerHandoffTargetSupervisor({ transport, profileId, targetBuild, claim });
    await expect(supervisor.start()).rejects.toMatchObject({ errorCode: "HANDOFF_TARGET_NOT_INITIALIZED" });
    expect(supervisor.state).toBe("ready-refused");
    expect(supervisor.ready).toBeUndefined();
    expect(transport.disposed).toBe(1);
  });

  it("validates the one-shot ready request identity before it is written", () => {
    const request = createOwnerHandoffTargetReadyRequest(claimedRecord, "44444444-4444-4444-8444-444444444444");
    expect(request).toEqual({
      version: 1,
      operation: "ready",
      requestId: "44444444-4444-4444-8444-444444444444",
      transferId: claim.transfer_id,
      targetEpoch: claim.target_epoch,
      expectedRevision: claim.expected_revision + 1,
    });
    expect(() => createOwnerHandoffTargetReadyRequest(claimedRecord, "not-a-uuid"))
      .toThrow("HANDOFF_INVALID_REQUEST");
    expect(() => createOwnerHandoffTargetReadyRequest({ ...claimedRecord, revision: 0 }, "44444444-4444-4444-8444-444444444444"))
      .toThrow("HANDOFF_INVALID_REQUEST");
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
