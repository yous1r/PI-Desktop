import { describe, expect, it, vi } from "vitest";
import { ExecutionFence } from "./execution-fence.js";
import type { SidecarHostLink } from "./agent-sidecar.js";

const generation = "12345678-1234-4234-8234-123456789abc";
const ticket = { version: 1, generation, address: `\\\\.\\pipe\\pi-execution-v1-${generation}`,
  capability: "22345678-1234-4234-8234-123456789abc", ownerPid: 1234, ownerCreatedAt: "134000000000000001" };
function hostWith(response: unknown) {
  const call = vi.fn().mockResolvedValue(response);
  const host: SidecarHostLink = { call, onNotification: () => () => {}, onExit: () => () => {} };
  return { host, call };
}
describe("execution fence transport", () => {
  it("preserves the launch command, arguments, environment and cwd behind the trusted launcher", async () => {
    const { host } = hostWith(ticket);
    const launch = { command: "C:/Node/node.exe", args: ["sidecar.js", "space & π"], cwd: "C:/task", env: { TEST_VALUE: "yes" } };
    const prepared = await ExecutionFence.prepare(host, "C:/Host/host.exe", launch);
    expect(prepared.launch.command).toBe("C:/Host/host.exe");
    expect(prepared.launch.args).toEqual(["--internal-execution-runner", "--", launch.command, ...launch.args]);
    expect(prepared.launch.cwd).toBe(launch.cwd);
    expect(prepared.launch.env?.TEST_VALUE).toBe("yes");
    expect(JSON.parse(prepared.launch.env?.PI_EXECUTION_TICKET ?? "null")).toEqual(ticket);
    expect(launch.env).toEqual({ TEST_VALUE: "yes" });
  });
  it("captures inherited environment before the original prepare RPC yields", async () => {
    const reply = Promise.withResolvers<unknown>();
    const { host, call } = hostWith(ticket);
    call.mockReturnValue(reply.promise);
    const previous = process.env.PI_FENCE_FACTORY_TEST;
    try {
      process.env.PI_FENCE_FACTORY_TEST = "original";
      const preparing = ExecutionFence.prepare(host, "host.exe", { command: "node", args: [] });
      process.env.PI_FENCE_FACTORY_TEST = "replacement";
      reply.resolve(ticket);
      expect((await preparing).launch.env?.PI_FENCE_FACTORY_TEST).toBe("original");
    } finally {
      if (previous === undefined) delete process.env.PI_FENCE_FACTORY_TEST;
      else process.env.PI_FENCE_FACTORY_TEST = previous;
    }
  });
  it("rejects malformed, lossy, redirected and unsupported tickets without a fallback", async () => {
    for (const response of [null, { ...ticket, version: 2 }, { ...ticket, pid: 1 },
      { ...ticket, ownerCreatedAt: 134000000000000001 }, { ...ticket, address: "\\\\remote\\pipe\\other" }]) {
      const { host } = hostWith(response);
      await expect(ExecutionFence.prepare(host, "host.exe", { command: "node", args: [] })).rejects.toThrow("INVALID_TICKET");
    }
  });
  it("preserves unconfirmed closure and validates the generation and native result", async () => {
    const { host, call } = hostWith(ticket);
    const { fence } = await ExecutionFence.prepare(host, "host.exe", { command: "node", args: [] });
    const status = { generation, state: "stopping", activeProcesses: 1, rootExited: false, confirmed: false };
    call.mockResolvedValue(status);
    expect((await fence.stop(0)).confirmed).toBe(false);
    expect(call).toHaveBeenLastCalledWith("executionFence.stop", { generation, timeoutMs: 0 });
    for (const invalid of [{ ...status, generation: ticket.capability }, { ...status, confirmed: true },
      { ...status, state: "closed", confirmed: true }, { ...status, activeProcesses: -1 }]) {
      call.mockResolvedValue(invalid);
      await expect(fence.status()).rejects.toThrow("INVALID_STATUS");
    }
    call.mockResolvedValue({ ...status, state: "closed", activeProcesses: 0, rootExited: true, confirmed: true });
    expect((await fence.stop()).confirmed).toBe(true);
  });
  it("refuses invalid timeout budgets before making an RPC", async () => {
    const { host, call } = hostWith(ticket);
    const { fence } = await ExecutionFence.prepare(host, "host.exe", { command: "node", args: [] });
    call.mockClear();
    for (const timeout of [-1, 2001, 1.5, NaN, Infinity]) await expect(fence.stop(timeout)).rejects.toBeInstanceOf(RangeError);
    expect(call).not.toHaveBeenCalled();
  });
  it("propagates lost prepare and stop replies without replay", async () => {
    const { host, call } = hostWith(ticket);
    call.mockRejectedValueOnce(new Error("transport lost"));
    await expect(ExecutionFence.prepare(host, "host.exe", { command: "node", args: [] })).rejects.toThrow("transport lost");
    expect(call).toHaveBeenCalledTimes(1);
    const { fence } = await ExecutionFence.prepare(host, "host.exe", { command: "node", args: [] });
    call.mockClear().mockRejectedValue(new Error("transport lost"));
    await expect(fence.stop()).rejects.toThrow("transport lost");
    expect(call).toHaveBeenCalledTimes(1);
  });
});

for (const method of ["status", "stop"] as const) for (const rejects of [false, true]) {
  it(`refuses ${method} after original Host generation changes during ${rejects ? "rejected" : "successful"} RPC`, async () => {
    const { host, call } = hostWith(ticket);
    const original = Object.assign(host, { generation: "original" });
    const { fence } = await ExecutionFence.prepare(original, "host.exe", { command: "node", args: [] });
    const reply = Promise.withResolvers<unknown>();
    call.mockReturnValue(reply.promise);
    const pending = fence[method]();
    original.generation = "replacement";
    if (rejects) reply.reject(new Error("old transport lost"));
    else reply.resolve({ generation, state: "closed", activeProcesses: 0, rootExited: true, confirmed: true });
    await expect(pending).rejects.toThrow("EXECUTION_FENCE_OWNER_CHANGED");
    original.generation = "original";
    call.mockClear();
    await expect(fence.status()).rejects.toThrow("EXECUTION_FENCE_OWNER_CHANGED");
    expect(call).not.toHaveBeenCalled();
  });
}

it("invalid Stop budget keeps the original binding; an admitted Stop revokes it synchronously", async () => {
  const { host, call } = hostWith(ticket);
  const { fence } = await ExecutionFence.prepare(host, "host.exe", { command: "node", args: [] });
  await expect(fence.stop(-1)).rejects.toThrow(RangeError);
  expect(() => fence.assertHost(host)).not.toThrow();
  const reply = Promise.withResolvers<unknown>();
  call.mockReturnValue(reply.promise);
  const stopping = fence.stop();
  expect(() => fence.assertHost(host)).toThrow("EXECUTION_FENCE_OWNER_CHANGED");
  reply.resolve({ generation, state: "closed", activeProcesses: 0, rootExited: true, confirmed: true });
  expect((await stopping).confirmed).toBe(true);
});
