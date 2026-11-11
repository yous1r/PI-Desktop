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
} from "./owner-handoff-target-process.js";
import type { OwnerHandoffReadyOutcome } from "./owner-handoff-target.js";

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
function setup(ready: OwnerHandoffReadyOutcome = readyOutcome) {
  const child = new Child();
  spawnState.child = child;
  spawnState.calls = [];
  const supervisor = launchOwnerHandoffTarget({
    binaryPath: "C:\\fixture\\host.exe",
    dataDir: "C:\\fixture\\data",
    profileId,
    targetBuild,
    claim,
    readyResources: { publishReady: () => ready },
    onStderr: () => {},
  });
  return { child, supervisor };
}
afterEach(() => vi.useRealTimers());

describe.skipIf(process.platform !== "win32")("restricted target process", () => {
  it("spawns the exclusive --owner-target mode and serves the framed claim/response path", async () => {
    const { child, supervisor } = setup();
    expect(spawnState.calls).toHaveLength(1);
    const [binary, args, options] = spawnState.calls[0] as [string, string[], { stdio: string[]; windowsHide: boolean; env: NodeJS.ProcessEnv }];
    expect(binary).toBe("C:\\fixture\\host.exe");
    expect(args).toEqual(["--owner-target"]);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(options.windowsHide).toBe(true);
    expect(options.env.PI_DESKTOP_DATA_DIR).toBe("C:\\fixture\\data");

    const written = new Promise<Buffer>((resolve) => child.stdin.once("data", resolve));
    const starting = supervisor.start();
    const bytes = await written;
    expect(bytes.readUInt32LE(0)).toBe(bytes.length - 4);
    expect(JSON.parse(bytes.subarray(4).toString("utf8"))).toEqual({
      version: 1,
      profileId,
      targetBuild,
      command: claim,
    });
    child.stdout.write(frame({ version: 1, record: claimedRecord }));
    await expect(starting).resolves.toEqual(readyOutcome);
    expect(supervisor.state).toBe("ready");
    await supervisor.dispose();
    expect(supervisor.isDisposed).toBe(true);
    expect(child.stdin.writableEnded).toBe(true);
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
});
