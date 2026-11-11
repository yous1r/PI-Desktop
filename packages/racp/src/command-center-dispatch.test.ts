import { describe, expect, it } from "vitest";
import { COMMAND_CENTER_METHODS, RacpError, type CommandCenterControl, type Principal } from "@pi-desktop/agent-host";
import { createCommandCenterDispatch } from "./command-center-dispatch.js";

/** C3 registration seam: prefix mapping and authenticated-principal forwarding. */

const owner: Principal = { subject: "local:owner", roles: ["owner"] };

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
  it("advertises one prefixed operation per control method", () => {
    const { dispatch } = service();
    expect(dispatch.methods).toEqual(COMMAND_CENTER_METHODS.map((method) => `commandCenter/${method}`));
    expect(dispatch.methods).toContain("commandCenter/intervention/record");
    expect(dispatch.methods).toContain("commandCenter/receipt/list");
  });

  it("strips the namespace and forwards params and the transport principal", async () => {
    const { dispatch, calls } = service();
    const params = { version: 1, hostId: "host_7c1e0a93b4d2f681" };
    const context = { principal: owner };
    const result = await dispatch.dispatch("commandCenter/workspace/list", params, context);
    expect(result).toEqual({ method: "workspace/list", params });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("workspace/list");
    expect(calls[0].principal).toBe(owner);
  });

  it("refuses unknown or unprefixed operations without calling the service", async () => {
    const { dispatch, calls } = service();
    for (const operation of ["commandCenter/nope", "workspace/list", "commandCenter/", ""]) {
      await expect(dispatch.dispatch(operation, {}, { principal: owner })).rejects.toBeInstanceOf(RacpError);
    }
    expect(calls).toHaveLength(0);
  });
});
