import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { COMMAND_CENTER_METHODS, RacpError, type CommandCenterControl, type Principal } from "@pi-desktop/agent-host";
import {
  COMMAND_CENTER_OPERATIONS, COMMAND_CENTER_RACP_PREFIX, createCommandCenterDispatch, isCommandCenterOperation,
} from "./command-center-dispatch.js";
import { COMMAND_CENTER_MONITOR_OPERATION, type CommandCenterMonitorPagePort } from "./command-center-monitor.js";

/** C3 registration seam: prefix mapping, authenticated-principal forwarding,
 * exact catalog names and the connection-scoped disposal contract. */

const owner: Principal = { subject: "local:owner", roles: ["owner"] };
const pageFixture = JSON.parse(
  readFileSync(new URL("../../shared/test/fixtures/command-center-summary.json", import.meta.url), "utf8"),
).snapshot;

function monitorPort() {
  const calls: { request: unknown; principal: Principal }[] = [];
  const port: CommandCenterMonitorPagePort = {
    async page(request, context) {
      calls.push({ request, principal: context.principal });
      return structuredClone(pageFixture);
    },
  };
  return { port, calls };
}

function service() {
  const calls: { method: string; params: unknown; principal: Principal }[] = [];
  const fake = {
    async call(method: string, params: unknown, principal: Principal) {
      calls.push({ method, params, principal });
      return { method, params };
    },
  } as unknown as CommandCenterControl;
  return { dispatch: createCommandCenterDispatch(fake), calls };
}

describe("command-center RACP dispatch", () => {
  it("advertises one prefixed operation per control method plus the monitor page", () => {
    const { dispatch } = service();
    expect(dispatch.methods).toEqual([
      ...COMMAND_CENTER_METHODS.map((method) => `${COMMAND_CENTER_RACP_PREFIX}${method}`),
      COMMAND_CENTER_MONITOR_OPERATION,
    ]);
    expect(dispatch.methods).toEqual(COMMAND_CENTER_OPERATIONS);
    expect(dispatch.methods).toContain("commandCenter/intervention/record");
    expect(dispatch.methods).toContain("commandCenter/receipt/list");
    expect(dispatch.methods).toContain(COMMAND_CENTER_MONITOR_OPERATION);
  });

  it("keeps every operation under the single commandCenter prefix", () => {
    expect(COMMAND_CENTER_OPERATIONS).toHaveLength(COMMAND_CENTER_METHODS.length + 1);
    expect(new Set(COMMAND_CENTER_OPERATIONS).size).toBe(COMMAND_CENTER_OPERATIONS.length);
    for (const operation of COMMAND_CENTER_OPERATIONS) {
      expect(operation.startsWith(COMMAND_CENTER_RACP_PREFIX)).toBe(true);
      expect(isCommandCenterOperation(operation)).toBe(true);
    }
    expect(isCommandCenterOperation("commandCenter/../../etc")).toBe(false);
    expect(isCommandCenterOperation("commandCenter")).toBe(false);
    expect(isCommandCenterOperation("workspace/list")).toBe(false);
  });

  it("strips the namespace and forwards params and the transport principal", async () => {
    const { dispatch, calls } = service();
    const params = { version: 1, hostId: "host_7c1e0a93b4d2f681" };
    const context = { principal: owner };
    const result = await dispatch.dispatch("commandCenter/workspace/list", params, context);
    expect(result).toEqual({ method: "workspace/list", params });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("workspace/list");
    expect(calls[0].params).toBe(params);
    expect(calls[0].principal).toBe(owner);
  });

  it("refuses unknown or unprefixed operations without calling the service", async () => {
    const { dispatch, calls } = service();
    for (const operation of ["commandCenter/nope", "workspace/list", "commandCenter/", ""]) {
      await expect(dispatch.dispatch(operation, {}, { principal: owner })).rejects.toBeInstanceOf(RacpError);
    }
    expect(calls).toHaveLength(0);
  });

  it("dispatches a bounded monitor page to the port with the authenticated principal", async () => {
    const { port, calls } = monitorPort();
    const withPage = createCommandCenterDispatch(
      { async call() { return null; } } as unknown as CommandCenterControl,
      { monitorPage: port },
    );
    const request = { version: 1, hostId: "host_7c1e0a93b4d2f681", token: "page-token-1" };
    const page = await withPage.dispatch(COMMAND_CENTER_MONITOR_OPERATION, request, { principal: owner });
    expect(page).toEqual(pageFixture);
    expect(calls).toHaveLength(1);
    expect(calls[0].request).toEqual(request);
    expect(calls[0].principal).toBe(owner);
    expect(withPage.methods).toContain(COMMAND_CENTER_MONITOR_OPERATION);
  });

  it("refuses the monitor page when no port is bound or the request is invalid", async () => {
    const { dispatch } = service();
    await expect(dispatch.dispatch(COMMAND_CENTER_MONITOR_OPERATION, { version: 1, hostId: "host_7c1e0a93b4d2f681" }, { principal: owner }))
      .rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });

    const { port, calls } = monitorPort();
    const withPage = createCommandCenterDispatch({ async call() { return null; } } as unknown as CommandCenterControl, { monitorPage: port });
    await expect(withPage.dispatch(COMMAND_CENTER_MONITOR_OPERATION, { version: 2, hostId: "host" }, { principal: owner }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(withPage.dispatch(COMMAND_CENTER_MONITOR_OPERATION, { version: 1, hostId: "host", extra: true }, { principal: owner }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(calls).toHaveLength(0);
  });

  it("bounds the monitor page response at the transport boundary", async () => {
    const withPage = (page: unknown) => createCommandCenterDispatch(
      { async call() { return null; } } as unknown as CommandCenterControl,
      { monitorPage: { async page() { return page; } } },
    );
    await expect(withPage({ ...pageFixture, rows: Array.from({ length: 101 }, () => pageFixture.rows[0]) })
      .dispatch(COMMAND_CENTER_MONITOR_OPERATION, { version: 1, hostId: "host_7c1e0a93b4d2f681" }, { principal: owner }))
      .rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });
    await expect(withPage({ nope: true })
      .dispatch(COMMAND_CENTER_MONITOR_OPERATION, { version: 1, hostId: "host_7c1e0a93b4d2f681" }, { principal: owner }))
      .rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("disposes exactly once and refuses work after disposal", async () => {
    const onDispose = vi.fn();
    const calls: string[] = [];
    const fake = {
      async call(method: string) {
        calls.push(method);
        return null;
      },
    } as unknown as CommandCenterControl;
    const dispatch = createCommandCenterDispatch(fake, { onDispose });
    expect(dispatch.disposed).toBe(false);
    await dispatch.dispose();
    await dispatch.dispose();
    expect(dispatch.disposed).toBe(true);
    expect(onDispose).toHaveBeenCalledTimes(1);
    await expect(dispatch.dispatch("commandCenter/workspace/list", {}, { principal: owner }))
      .rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
    expect(calls).toHaveLength(0);
  });
});
