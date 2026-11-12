import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({
  child: undefined as unknown,
  calls: [] as unknown[][],
}));
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => {
    spawnState.calls.push(args);
    return spawnState.child;
  },
}));

import {
  launchOwnerHandoffTarget,
  OwnerHandoffTargetProcess,
  OWNER_HANDOFF_TARGET_NOTIFICATION_LIMIT,
  OWNER_HANDOFF_TARGET_RPC_MAX_INFLIGHT,
  parseOwnerHandoffTargetReadyResponse,
} from "./owner-handoff-target-process.js";
import {
  createOwnerHandoffTargetReadyRequest,
  type OwnerHandoffReadyOutcome,
  type OwnerHandoffTargetLaunch,
  type OwnerHandoffTargetTicket,
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
const readyOutcome: OwnerHandoffReadyOutcome = {
  record: { ...claimedRecord, phase: "ready", revision: claimedRecord.revision + 1 },
  ready: { ...fixture.ready, recordRevision: claimedRecord.revision + 1 },
};
const TICKET_GENERATION = "77777777-7777-4777-8777-777777777777";
const launch: OwnerHandoffTargetLaunch = {
  version: 1,
  operation: "launch-sidecar",
  transferId: claim.transfer_id,
  targetEpoch: claim.target_epoch,
  ticket: {
    version: 1,
    generation: TICKET_GENERATION,
    address: `\\\\.\\pipe\\pi-execution-v1-${TICKET_GENERATION}`,
    capability: "88888888-8888-4888-8888-888888888888",
    ownerPid: 321,
    ownerCreatedAt: "134115649234567890",
  },
};

class Child extends EventEmitter {
  pid: number | undefined = 321;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor() {
    super();
    // Disposal ends stdin; model the original process exiting on that signal.
    this.stdin.on("finish", () => this.exit(0));
  }
  exit(code = 0) {
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
  kill() {
    this.signalCode = "SIGKILL";
    this.emit("exit", null, "SIGKILL");
    this.emit("close", null, "SIGKILL");
    return true;
  }
}
function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const bytes = Buffer.alloc(4 + body.length);
  bytes.writeUInt32LE(body.length);
  body.copy(bytes, 4);
  return bytes;
}
function setup() {
  const child = new Child();
  spawnState.child = child;
  spawnState.calls = [];
  const launched: OwnerHandoffTargetTicket[] = [];
  const sidecar = {
    launched,
    launch(ticket: OwnerHandoffTargetTicket) { launched.push(ticket); },
    eventEpoch: () => "hub-event-epoch",
  };
  const supervisor = launchOwnerHandoffTarget({
    binaryPath: "C:\\fixture\\host.exe",
    dataDir: "C:\\fixture\\data",
    profileId,
    targetBuild,
    claim,
    sidecar,
    onStderr: () => {},
  });
  return { child, supervisor, sidecar };
}
function nextFrame(child: Child): Promise<Buffer> {
  return new Promise((resolve) => child.stdin.once("data", resolve));
}
/** Parse the 4-byte framed JSON objects the transport writes to stdin. */
function stdinFrames(child: Child) {
  let buffer = Buffer.alloc(0);
  const frames: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  const drain = () => {
    while (waiters.length > 0 && frames.length > 0) waiters.shift()!(frames.shift());
  };
  child.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < length + 4) break;
      frames.push(JSON.parse(buffer.subarray(4, length + 4).toString("utf8")));
      buffer = buffer.subarray(length + 4);
    }
    drain();
  });
  return {
    next(): Promise<unknown> {
      if (frames.length > 0) return Promise.resolve(frames.shift());
      return new Promise((resolve) => { waiters.push(resolve); drain(); });
    },
  };
}
function rpcProcess() {
  const child = new Child();
  spawnState.child = child;
  const transport = new OwnerHandoffTargetProcess({
    binaryPath: "C:\\fixture\\host.exe",
    dataDir: "C:\\fixture\\data",
    profileId,
    onStderr: () => {},
  });
  return { child, transport, frames: stdinFrames(child) };
}
const READY_REQUEST_ID = "99999999-9999-4999-8999-999999999999";
async function openRpc(
  transport: OwnerHandoffTargetProcess,
  child: Child,
  frames: ReturnType<typeof stdinFrames>,
) {
  const request = createOwnerHandoffTargetReadyRequest(claimedRecord, READY_REQUEST_ID);
  const written = frames.next();
  const readying = transport.ready(request);
  await written;
  child.stdout.write(frame({ version: 1, ready: readyOutcome }));
  await readying;
}
afterEach(() => vi.useRealTimers());

describe.skipIf(process.platform !== "win32")("restricted target process", () => {
  it("spawns --owner-target, claims, receives launch-sidecar and sends attach-epoch", async () => {
    const { child, supervisor, sidecar } = setup();
    expect(spawnState.calls).toHaveLength(1);
    const [binary, args, options] = spawnState.calls[0] as [string, string[], { stdio: string[]; windowsHide: boolean; env: NodeJS.ProcessEnv }];
    expect(binary).toBe("C:\\fixture\\host.exe");
    expect(args).toEqual(["--owner-target"]);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(options.windowsHide).toBe(true);
    expect(options.env.PI_DESKTOP_DATA_DIR).toBe("C:\\fixture\\data");

    const claimWritten = nextFrame(child);
    const starting = supervisor.start();
    const bytes = await claimWritten;
    expect(bytes.readUInt32LE(0)).toBe(bytes.length - 4);
    expect(JSON.parse(bytes.subarray(4).toString("utf8"))).toEqual({
      version: 1,
      profileId,
      targetBuild,
      command: claim,
    });
    const attachWritten = nextFrame(child);
    child.stdout.write(frame({ version: 1, record: claimedRecord }));
    child.stdout.write(frame(launch));
    const attachBytes = await attachWritten;
    expect(JSON.parse(attachBytes.subarray(4).toString("utf8"))).toMatchObject({
      version: 1,
      operation: "attachEpoch",
      transferId: claim.transfer_id,
      targetEpoch: claim.target_epoch,
      expectedRevision: claimedRecord.revision,
      eventEpoch: "hub-event-epoch",
    });
    expect(sidecar.launched).toEqual([launch.ticket]);
    child.stdout.write(frame({ version: 1, ready: readyOutcome }));
    await expect(starting).resolves.toEqual(readyOutcome);
    expect(supervisor.state).toBe("ready");
    await supervisor.dispose();
    expect(supervisor.isDisposed).toBe(true);
    expect(child.stdin.writableEnded).toBe(true);
  });

  it("propagates a framed attach-epoch refusal and disposes the same process", async () => {
    const { child, supervisor } = setup();
    const claimWritten = nextFrame(child);
    const starting = supervisor.start();
    await claimWritten;
    const attachWritten = nextFrame(child);
    child.stdout.write(frame({ version: 1, record: claimedRecord }));
    child.stdout.write(frame(launch));
    await attachWritten;
    child.stdout.write(frame({ version: 1, error: { code: "HANDOFF_TARGET_ROOT_BIND_FAILED" } }));
    await expect(starting).rejects.toMatchObject({ errorCode: "HANDOFF_TARGET_ROOT_BIND_FAILED" });
    expect(supervisor.state).toBe("ready-refused");
    expect(child.stdin.writableEnded).toBe(true);
  });

  it("strictly parses the bounded Ready frame", () => {
    expect(parseOwnerHandoffTargetReadyResponse({ version: 1, ready: readyOutcome })).toEqual(readyOutcome);
    expect(() => parseOwnerHandoffTargetReadyResponse({ version: 1, ready: readyOutcome, extra: true }))
      .toThrow("HANDOFF_INVALID_RESPONSE");
    expect(() => parseOwnerHandoffTargetReadyResponse({ version: 1, error: { code: "secret/path" } }))
      .toThrow("HANDOFF_INVALID_RESPONSE");
    expect(() => parseOwnerHandoffTargetReadyResponse({
      version: 1,
      ready: { ...readyOutcome, record: { ...readyOutcome.record, revision: 1 } },
    })).toThrow("HANDOFF_INVALID_RESPONSE");
    expect(() => parseOwnerHandoffTargetReadyResponse({ version: 1, error: { code: "HANDOFF_READY_REFUSED" } }))
      .toThrow("HANDOFF_READY_REFUSED");
  });

  it("parses two coalesced frames in one stdout chunk", async () => {
    const { child, supervisor } = setup();
    const claimWritten = nextFrame(child);
    const starting = supervisor.start();
    await claimWritten;
    const attachWritten = nextFrame(child);
    child.stdout.write(Buffer.concat([
      frame({ version: 1, record: claimedRecord }),
      frame(launch),
    ]));
    await attachWritten;
    child.stdout.write(frame({ version: 1, ready: readyOutcome }));
    await expect(starting).resolves.toEqual(readyOutcome);
    await supervisor.dispose();
  });

  it("parses a claim receipt split across every byte", async () => {
    const { child, supervisor } = setup();
    const claimWritten = nextFrame(child);
    const starting = supervisor.start();
    await claimWritten;
    const attachWritten = nextFrame(child);
    const claimBytes = frame({ version: 1, record: claimedRecord });
    for (let index = 0; index < claimBytes.length; index += 1) {
      child.stdout.write(claimBytes.subarray(index, index + 1));
    }
    child.stdout.write(frame(launch));
    await attachWritten;
    child.stdout.write(frame({ version: 1, ready: readyOutcome }));
    await expect(starting).resolves.toEqual(readyOutcome);
    await supervisor.dispose();
  });

  it("fails closed on malformed stdout frames and disposes the child", async () => {
    const { child, supervisor } = setup();
    const written = new Promise<Buffer>((resolve) => child.stdin.once("data", resolve));
    const starting = supervisor.start();
    await written;
    const body = Buffer.from("{not-json");
    const bad = Buffer.alloc(4 + body.length);
    bad.writeUInt32LE(body.length);
    body.copy(bad, 4);
    child.stdout.write(bad);
    await expect(starting).rejects.toMatchObject({ errorCode: "HANDOFF_INVALID_FRAME" });
    expect(supervisor.state).toBe("ready-refused");
    expect(child.stdin.writableEnded).toBe(true);
  });

  it("fails closed and cleans up when the child exits instead of replying", async () => {
    const { child, supervisor } = setup();
    const written = new Promise<Buffer>((resolve) => child.stdin.once("data", resolve));
    const starting = supervisor.start();
    await written;
    child.exit(1);
    await expect(starting).rejects.toMatchObject({ errorCode: "HANDOFF_TRANSPORT_CLOSED" });
    expect(supervisor.state).toBe("ready-refused");
    expect(child.stdin.writableEnded).toBe(true);
  });

  it("forwards child stderr and confirms the original child exit", async () => {
    const lines: string[] = [];
    const child = new Child();
    spawnState.child = child;
    const transport = new OwnerHandoffTargetProcess({
      binaryPath: "C:\\fixture\\host.exe",
      dataDir: "C:\\fixture\\data",
      profileId,
      onStderr: (text) => lines.push(text),
    });
    child.stderr.write("Error: HANDOFF_TARGET_ADOPTION_UNAVAILABLE\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines.join("")).toContain("HANDOFF_TARGET_ADOPTION_UNAVAILABLE");
    const disposing = transport.dispose();
    await disposing;
    expect(await transport.confirmExit(0)).toBe(true);
    expect(child.stdin.writableEnded).toBe(true);
  });

  it("refuses relative paths and non-digest identities before spawning", () => {
    const child = new Child();
    spawnState.child = child;
    spawnState.calls = [];
    expect(() => new OwnerHandoffTargetProcess({
      binaryPath: "host.exe", dataDir: "C:\\fixture\\data", profileId, onStderr: () => {},
    })).toThrow("HANDOFF_INVALID_IDENTITY");
    expect(() => new OwnerHandoffTargetProcess({
      binaryPath: "C:\\fixture\\host.exe", dataDir: "C:\\fixture\\data", profileId: "x", onStderr: () => {},
    })).toThrow("HANDOFF_INVALID_IDENTITY");
    expect(spawnState.calls).toEqual([]);
  });

  it("times out a silent child and records no reply", async () => {
    vi.useFakeTimers();
    const child = new Child();
    spawnState.child = child;
    const transport = new OwnerHandoffTargetProcess({
      binaryPath: "C:\\fixture\\host.exe",
      dataDir: "C:\\fixture\\data",
      profileId,
      onStderr: () => {},
    });
    const calling = transport.call({
      version: 1, profileId, targetBuild, command: claim,
    }, 25);
    const rejected = expect(calling).rejects.toMatchObject({ errorCode: "HANDOFF_IO_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    await transport.dispose();
  });

  describe("post-Ready JSON-RPC", () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve));

    it("correlates out-of-order replies coalesced in one stdout chunk", async () => {
      const { child, transport, frames } = rpcProcess();
      await openRpc(transport, child, frames);
      const first = transport.rpcCall<{ a: number }>("session/list", { limit: 1 });
      const second = transport.rpcCall<{ b: number }>("host/list", { filter: "x" });
      const requestA = await frames.next() as { id: string };
      const requestB = await frames.next() as { id: string };
      expect(requestA).toMatchObject({ jsonrpc: "2.0", method: "session/list", params: { limit: 1 } });
      expect(requestB).toMatchObject({ jsonrpc: "2.0", method: "host/list", params: { filter: "x" } });
      child.stdout.write(Buffer.concat([
        frame({ jsonrpc: "2.0", id: requestB.id, result: { b: 2 } }),
        frame({ jsonrpc: "2.0", id: requestA.id, result: { a: 1 } }),
      ]));
      await expect(first).resolves.toEqual({ a: 1 });
      await expect(second).resolves.toEqual({ b: 2 });
      await transport.dispose();
    });

    it("parses a post-Ready reply split across every byte", async () => {
      const { child, transport, frames } = rpcProcess();
      await openRpc(transport, child, frames);
      const call = transport.rpcCall("session/list", {});
      const request = await frames.next() as { id: string };
      const response = frame({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
      for (let index = 0; index < response.length; index += 1) {
        child.stdout.write(response.subarray(index, index + 1));
      }
      await expect(call).resolves.toEqual({ ok: true });
      await transport.dispose();
    });

    it("maps a JSON-RPC error reply to an errorCode", async () => {
      const { child, transport, frames } = rpcProcess();
      await openRpc(transport, child, frames);
      const call = transport.rpcCall("session/list", {});
      const request = await frames.next() as { id: string };
      child.stdout.write(frame({
        jsonrpc: "2.0", id: request.id,
        error: { code: -32000, message: "denied", data: { errorCode: "HANDOFF_TEST_DENIED" } },
      }));
      const error = await call.catch((failure: Error & { code?: number; errorCode?: string }) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("denied");
      expect((error as Error & { code?: number }).code).toBe(-32000);
      expect((error as Error & { errorCode?: string }).errorCode).toBe("HANDOFF_TEST_DENIED");
      await transport.dispose();
    });

    it("rejects a timed-out call, ignores its late reply and keeps serving", async () => {
      const { child, transport, frames } = rpcProcess();
      await openRpc(transport, child, frames);
      vi.useFakeTimers();
      const timedOut = transport.rpcCall("session/list", {}, 25);
      const request = await frames.next() as { id: string };
      const rejected = expect(timedOut).rejects.toMatchObject({ errorCode: "HANDOFF_TARGET_RPC_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      vi.useRealTimers();
      child.stdout.write(frame({ jsonrpc: "2.0", id: request.id, result: { late: true } }));
      await tick();
      const next = transport.rpcCall("host/list", {});
      const second = await frames.next() as { id: string };
      child.stdout.write(frame({ jsonrpc: "2.0", id: second.id, result: { ok: 1 } }));
      await expect(next).resolves.toEqual({ ok: 1 });
      await transport.dispose();
    });

    it("caps in-flight calls instead of queueing without bound", async () => {
      const { child, transport, frames } = rpcProcess();
      await openRpc(transport, child, frames);
      const calls = Array.from({ length: OWNER_HANDOFF_TARGET_RPC_MAX_INFLIGHT }, (_, index) =>
        transport.rpcCall<{ index: number }>("session/list", { index }));
      const requests = [];
      for (let index = 0; index < OWNER_HANDOFF_TARGET_RPC_MAX_INFLIGHT; index += 1) {
        requests.push(await frames.next() as { id: string });
      }
      await expect(transport.rpcCall("session/list", { index: 32 }))
        .rejects.toMatchObject({ errorCode: "HANDOFF_TARGET_RPC_BUSY" });
      child.stdout.write(Buffer.concat(requests.map((request, index) =>
        frame({ jsonrpc: "2.0", id: request.id, result: { index } }))));
      await expect(Promise.all(calls)).resolves.toHaveLength(OWNER_HANDOFF_TARGET_RPC_MAX_INFLIGHT);
      await transport.dispose();
    });

    it("opens the RPC mirror synchronously when Ready and a notification share a chunk", async () => {
      const { child, transport } = rpcProcess();
      const request = createOwnerHandoffTargetReadyRequest(claimedRecord, READY_REQUEST_ID);
      const written = nextFrame(child);
      const readying = transport.ready(request);
      await written;
      child.stdout.write(Buffer.concat([
        frame({ version: 1, ready: readyOutcome }),
        frame({ jsonrpc: "2.0", method: "turn/progress", params: { id: 9 } }),
      ]));
      await readying;
      const seen: unknown[] = [];
      transport.onTargetNotification((notification) => seen.push(notification));
      expect(seen).toEqual([{ method: "turn/progress", params: { id: 9 } }]);
      await transport.dispose();
    });

    it("buffers notifications for a subscriber and stops after unsubscribe", async () => {
      const { child, transport, frames } = rpcProcess();
      await openRpc(transport, child, frames);
      child.stdout.write(Buffer.concat([
        frame({ jsonrpc: "2.0", method: "approval/requested", params: { id: 1 } }),
        frame({ jsonrpc: "2.0", method: "turn/progress", params: { id: 2 } }),
      ]));
      await tick();
      const seen: Array<{ method: string; params: unknown }> = [];
      const unsubscribe = transport.onTargetNotification((notification) => seen.push(notification));
      expect(seen).toEqual([
        { method: "approval/requested", params: { id: 1 } },
        { method: "turn/progress", params: { id: 2 } },
      ]);
      unsubscribe();
      child.stdout.write(frame({ jsonrpc: "2.0", method: "after/unsubscribe", params: {} }));
      await tick();
      expect(seen).toHaveLength(2);
      await transport.dispose();
    });

    it("fails closed on notification overflow instead of dropping silently", async () => {
      const { child, transport, frames } = rpcProcess();
      await openRpc(transport, child, frames);
      const pending = transport.rpcCall("session/list", {});
      await frames.next();
      const burst = Array.from({ length: OWNER_HANDOFF_TARGET_NOTIFICATION_LIMIT + 1 }, (_, index) =>
        frame({ jsonrpc: "2.0", method: "progress", params: { index } }));
      child.stdout.write(Buffer.concat(burst));
      await expect(pending).rejects.toMatchObject({ errorCode: "HANDOFF_TARGET_NOTIFICATION_OVERFLOW" });
      await expect(transport.rpcCall("host/list", {}))
        .rejects.toMatchObject({ errorCode: "HANDOFF_TARGET_NOTIFICATION_OVERFLOW" });
      await transport.dispose();
    });

    it("ignores unknown ids and rejects before Ready", async () => {
      const preReady = rpcProcess();
      await expect(preReady.transport.rpcCall("session/list", {}))
        .rejects.toMatchObject({ errorCode: "HANDOFF_TARGET_RPC_UNAVAILABLE" });
      await preReady.transport.dispose();

      const { child, transport, frames } = rpcProcess();
      await openRpc(transport, child, frames);
      child.stdout.write(frame({ jsonrpc: "2.0", id: "unknown", result: { ignored: true } }));
      await tick();
      const call = transport.rpcCall("session/list", {});
      const request = await frames.next() as { id: string };
      child.stdout.write(frame({ jsonrpc: "2.0", id: request.id, result: { ok: true } }));
      await expect(call).resolves.toEqual({ ok: true });
      await transport.dispose();
    });

    it("dispose rejects in-flight calls and late frames cannot revive it", async () => {
      const { child, transport, frames } = rpcProcess();
      await openRpc(transport, child, frames);
      const pending = transport.rpcCall("session/list", {});
      await frames.next();
      const disposing = transport.dispose();
      await expect(pending).rejects.toMatchObject({ errorCode: "HANDOFF_TRANSPORT_CLOSED" });
      await disposing;
      await expect(transport.rpcCall("host/list", {}))
        .rejects.toMatchObject({ errorCode: "HANDOFF_TRANSPORT_CLOSED" });
      const seen: unknown[] = [];
      const unsubscribe = transport.onTargetNotification((notification) => seen.push(notification));
      child.stdout.write(frame({ jsonrpc: "2.0", method: "late/notification", params: {} }));
      await tick();
      expect(seen).toEqual([]);
      unsubscribe();
    });
  });
});
