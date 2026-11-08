import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({ child: undefined as unknown }));
vi.mock("node:child_process", () => ({ spawn: () => spawnState.child }));
import { OwnerHandoffProcess } from "./owner-handoff-process.js";
const fixture = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/owner-handoff.json", import.meta.url), "utf8"));
class Child extends EventEmitter {
  pid: number | undefined = 123;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  kill() { this.signalCode = "SIGKILL"; this.emit("exit"); this.emit("close"); return true; }
  finish() { this.exitCode = 0; this.emit("exit", 0, null); }
}
function build() {
  const child = new Child(); spawnState.child = child;
  const process = new OwnerHandoffProcess({ binaryPath: "C:/fixture/host.exe", dataDir: "C:/fixture/data", profileId: fixture.response.record.profile, onStderr: () => {} });
  return { child, process };
}
function frame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value));const bytes = Buffer.alloc(body.length + 4);
  bytes.writeUInt32LE(body.length);body.copy(bytes, 4);return bytes;
}
afterEach(() => vi.useRealTimers());

describe.skipIf(process.platform !== "win32")("restricted process lifecycle", () => {
  it("consumes the final stdout reply even when original child exit precedes stream closure", async () => {
    const { child, process } = build();
    const pending = process.call(fixture.bootstrap[0]);
    child.finish(); child.stdout.end(frame(fixture.response));
    expect(await pending).toEqual(fixture.response);
    child.emit("close", 0, null);
    expect(await process.confirmExit(0)).toBe(true);
    await process.dispose();
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });
  it("cleans a spawn failure without claiming the absent process exited", async () => {
    const { child, process } = build(); child.pid = undefined;
    const pending = process.call(fixture.bootstrap[0]);
    const failed = expect(pending).rejects.toMatchObject({ errorCode: "HANDOFF_TRANSPORT_CLOSED" });
    child.emit("error", new Error("spawn failed"));child.emit("close", -2, null);
    await failed;
    expect(await process.confirmExit(0)).toBe(false);
    await expect(process.dispose()).resolves.toBeUndefined();
  });
  it("ends stdin and signals only its original child when graceful exit is unconfirmed", async () => {
    vi.useFakeTimers();const { child, process } = build();
    const pending = process.dispose();
    expect(child.stdin.writableEnded).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);await pending;
    expect(child.signalCode).toBe("SIGKILL");
    expect(await process.confirmExit(0)).toBe(true);
    await expect(process.dispose()).resolves.toBeUndefined();
  });
});
