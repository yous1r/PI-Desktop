import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOwnerHandoffResponse } from "@pi-desktop/shared";
import { OwnerHandoffChannel } from "./owner-handoff-channel.js";

const fixture = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/owner-handoff.json", import.meta.url), "utf8"));
const status = fixture.bootstrap[0];
function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(4 + body.length); result.writeUInt32LE(body.length); body.copy(result, 4); return result;
}
function setup() {
  const input = new PassThrough(), output = new PassThrough();
  const writes: Buffer[] = [];
  output.on("data", (bytes: Buffer) => writes.push(Buffer.from(bytes)));
  const channel = new OwnerHandoffChannel({ input, output, profileId: fixture.response.record.profile });
  return { input, output, writes, channel };
}
afterEach(() => vi.useRealTimers());

describe("restricted owner handoff channel", () => {
  it("decodes split header/body bytes and preserves the exact native creation identity", async () => {
    const f = setup();
    const pending = f.channel.call(status);
    const bytes = frame(fixture.response);
    for (const byte of bytes) f.input.write(Buffer.from([byte]));
    expect(await pending).toEqual(parseOwnerHandoffResponse(fixture.response));
    expect(JSON.parse(f.writes[0]!.subarray(4).toString())).toEqual(status);
    f.channel.dispose();
  });
  it("permits a new explicit request after a classified native refusal", async () => {
    const f = setup();
    const first = f.channel.call(status); f.input.write(frame(fixture.failure));
    expect(await first).toEqual(fixture.failure);
    const second = f.channel.call(status); f.input.write(frame(fixture.response));
    expect(await second).toEqual(fixture.response);
    expect(f.writes).toHaveLength(2); f.channel.dispose();
  });
  it("rejects concurrent requests before transmission without replaying or cancelling the first", async () => {
    const f = setup(); const pending = f.channel.call(status);
    await expect(f.channel.call(status)).rejects.toMatchObject({ errorCode: "HANDOFF_CHANNEL_BUSY" });
    expect(f.writes).toHaveLength(1); f.input.write(frame(fixture.response)); await pending; f.channel.dispose();
  });
  it("poisons a timed-out channel so a late reply cannot settle a subsequent request", async () => {
    vi.useFakeTimers(); const f = setup();
    const pending = f.channel.call(status, 20);
    const rejected = expect(pending).rejects.toMatchObject({ errorCode: "HANDOFF_IO_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20); await rejected;
    f.input.write(frame(fixture.response));
    await expect(f.channel.call(status)).rejects.toMatchObject({ errorCode: "HANDOFF_IO_TIMEOUT" });
    expect(f.writes).toHaveLength(1); f.channel.dispose();
  });
  it("refuses zero/oversized/trailing/truncated/invalid-UTF8 frames without buffering unbounded input", async () => {
    const zero = Buffer.alloc(4), large = Buffer.alloc(4); large.writeUInt32LE(16385);
    const badUtf8 = Buffer.from([1, 0, 0, 0, 0xff]);
    for (const bytes of [zero, large, badUtf8, Buffer.concat([frame(fixture.response), Buffer.from([0])]), Buffer.alloc(20000)]) {
      const f = setup(); const pending = f.channel.call(status);
      const rejected = expect(pending).rejects.toMatchObject({ errorCode: "HANDOFF_INVALID_FRAME" });
      f.input.write(bytes); await rejected;
      await expect(f.channel.call(status)).rejects.toMatchObject({ errorCode: "HANDOFF_INVALID_FRAME" }); f.channel.dispose();
    }
    const f = setup(); const pending = f.channel.call(status);
    const rejected = expect(pending).rejects.toMatchObject({ errorCode: "HANDOFF_TRANSPORT_CLOSED" });
    f.input.end(Buffer.from([10, 0, 0, 0, 123])); await rejected; f.channel.dispose();
  });
  it("binds successful replies to profile, transfer, source, target, phase and mutation revision", async () => {
    const r = fixture.response.record;
    const claim = fixture.bootstrap[1];
    const valid = { ...r, phase: "target_claimed", revision: claim.expected_revision + 1 };
    for (const record of [{ ...valid, profile: "f".repeat(64) }, { ...valid, id: claim.request_id },
      { ...valid, sourceEpoch: claim.request_id }, { ...valid, targetEpoch: claim.request_id },
      { ...valid, phase: "release_pending" }, { ...valid, revision: claim.expected_revision }]) {
      const f = setup(); const pending = f.channel.call(claim);
      const rejected = expect(pending).rejects.toMatchObject({ errorCode: "HANDOFF_RESPONSE_MISMATCH" });
      f.input.write(frame({ version: 1, record })); await rejected; f.channel.dispose();
    }
    const f = setup(); const pending = f.channel.call(claim); f.input.write(frame({ version: 1, record: valid }));
    expect((await pending)).toMatchObject({ record: { phase: "target_claimed", revision: 5 } }); f.channel.dispose();
  });
  it("rejects malformed requests before writing and keeps the transport usable", async () => {
    const f = setup();
    await expect(f.channel.call({ ...status, operation: "ready" })).rejects.toThrow("HANDOFF_INVALID_REQUEST");
    await expect(f.channel.call(status, 0)).rejects.toThrow(RangeError);
    expect(f.writes).toEqual([]);
    const pending = f.channel.call(status); f.input.write(frame(fixture.response)); await pending; f.channel.dispose();
  });
  it("propagates stream failure without exposing request capabilities and clears its timer", async () => {
    vi.useFakeTimers(); const f = setup();
    const pending = f.channel.call(fixture.bootstrap[1]);
    const rejected = expect(pending).rejects.toMatchObject({ errorCode: "HANDOFF_TRANSPORT_CLOSED" });
    f.output.emit("error", new Error(fixture.bootstrap[1].capability));
    await rejected;
    await expect(f.channel.call(status)).rejects.not.toThrow(fixture.bootstrap[1].capability);
    expect(vi.getTimerCount()).toBe(0);
    f.channel.dispose();
    expect(f.input.listenerCount("data")).toBe(0);
    expect(f.input.listenerCount("end")).toBe(0);
  });
});
