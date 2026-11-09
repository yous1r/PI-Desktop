import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryOwnerHandoffIdentity, readOwnerHandoffTransfer, type OwnerSourceBinding } from "./owner-handoff-query.js";

const record = JSON.parse(readFileSync(new URL("../../shared/test/fixtures/owner-handoff.json", import.meta.url), "utf8")).response.record;
function fixture() {
  const pending = Promise.withResolvers<unknown>();
  let request: object = {};
  let generation = "original";
  let available = true;
  const call = vi.fn(async <T>(_method: string, params: unknown, _timeout?: number): Promise<T> => {
    request = params as object; return await pending.promise as T;
  });
  const host = { call, get generation() { return generation; }, isAvailable: () => available };
  let binding: OwnerSourceBinding | null = { host, sourceEpoch: record.sourceEpoch, profileId: record.profile };
  return { current: () => binding, currentHost: () => binding?.host ?? null, host, call, pending,
    identity: () => ({ ...request, sourceEpoch: record.sourceEpoch, profileId: record.profile }),
    transfer: () => ({ ...request, record: structuredClone(record) }),
    replace: () => { if (binding) binding.host = { ...host }; }, remove: () => { binding = null; },
    generation: () => { generation = "replacement"; }, exit: () => { available = false; },
    sourceEpoch: () => { if (binding) binding.sourceEpoch = "changed"; }, profileId: () => { if (binding) binding.profileId = "changed"; } };
}
afterEach(() => vi.useRealTimers());

describe("original-owner query transport", () => {
  it("discovers identity and reads a transfer through original private stdio", async () => {
    const f = fixture();
    const identity = queryOwnerHandoffIdentity(f.currentHost);
    expect(f.call.mock.calls[0]?.[0]).toBe("ownerHandoff.identity");
    expect(f.call.mock.calls[0]?.[2]).toBe(2000);
    f.pending.resolve(f.identity());
    expect((await identity).sourceEpoch).toBe(record.sourceEpoch);
    const t = fixture();
    const transfer = readOwnerHandoffTransfer(t.current, record.id);
    expect(t.call.mock.calls[0]?.[0]).toBe("ownerHandoff.readTransfer");
    expect(t.call.mock.calls[0]?.[2]).toBe(2000);
    t.pending.resolve(t.transfer());
    expect(await transfer).toEqual({ version: 1, record });
  });
  for (const operation of ["identity", "transfer"] as const) {
    const start = (f: ReturnType<typeof fixture>) => operation === "identity" ? queryOwnerHandoffIdentity(f.currentHost) : readOwnerHandoffTransfer(f.current, record.id);
    it.each(["replace", "remove", "generation", "exit"] as const)(`${operation} rejects stale success after %s`, async action => {
      const f = fixture(); const result = start(f); f[action](); f.pending.resolve(f[operation]());
      await expect(result).rejects.toThrow("HANDOFF_OWNER_CHANGED");
    });
    it(`${operation} checks ownership even after rejected original transport`, async () => {
      const f = fixture(); const result = start(f); f.replace(); f.pending.reject(new Error("old refusal"));
      await expect(result).rejects.toThrow("HANDOFF_OWNER_CHANGED");
    });
    it(`${operation} preserves current refusal and refuses malformed facts`, async () => {
      const f = fixture(); const result = start(f); f.pending.reject(new Error("HANDOFF_UNAVAILABLE"));
      await expect(result).rejects.toThrow("HANDOFF_UNAVAILABLE");
      const bad = fixture(); const invalid = start(bad); bad.pending.resolve({});
      await expect(invalid).rejects.toThrow();
    });
    it(`${operation} bounds retries, observes late rejection and clears timer`, async () => {
      vi.useFakeTimers();
      const f = fixture(); const result = start(f);
      const rejected = expect(result).rejects.toThrow("HANDOFF_QUERY_TIMEOUT");
      await vi.advanceTimersByTimeAsync(2500); await rejected;
      f.pending.reject(new Error("late response")); await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    });
    it(`${operation} refuses unavailable owners without issuing an RPC`, async () => {
      const f = fixture(); f.exit(); await expect(start(f)).rejects.toThrow("HANDOFF_OWNER_CHANGED");
      expect(f.call).not.toHaveBeenCalled();
      f.remove(); await expect(start(f)).rejects.toThrow("HANDOFF_OWNER_UNAVAILABLE");
    });
  }
  it.each(["sourceEpoch", "profileId"] as const)("captures original %s across awaits", async key => {
    const f = fixture(); const result = readOwnerHandoffTransfer(f.current, record.id);
    f[key](); f.pending.resolve(f.transfer()); await expect(result).rejects.toThrow("HANDOFF_OWNER_CHANGED");
  });
  it("detects generation replacement inside a synchronous current-owner callback", async () => {
    const f = fixture(); let reads = 0;
    const current = () => { if (++reads === 2) f.generation(); return f.host; };
    await expect(queryOwnerHandoffIdentity(current)).rejects.toThrow("HANDOFF_OWNER_CHANGED");
    expect(f.call).not.toHaveBeenCalled();
  });
  it("rejects invalid transfer ids before transport", async () => {
    const f = fixture(); await expect(readOwnerHandoffTransfer(f.current, "bad")).rejects.toThrow("HANDOFF_INVALID_REQUEST");
    expect(f.call).not.toHaveBeenCalled();
  });
});
