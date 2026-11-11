import { describe, expect, it, vi } from "vitest";
import * as Value from "typebox/value";
import {
  RACP_OPERATIONS, RacpServerCapabilitiesSchema, type RacpOperation,
} from "@pi-desktop/shared";
import { type CommandCenterControl } from "@pi-desktop/agent-host";
import { COMMAND_CENTER_OPERATIONS } from "./command-center-dispatch.js";
import { createOperations } from "./operations.js";
import { hashToken, newDeviceToken } from "./auth.js";
import { flush, harness, OWNER_TOKEN, VIEWER_TOKEN } from "./test-harness.js";

/** C3 registration contract: the command-center names exist in the shared RACP
 * catalog with the control service's roles, but no capability is advertised, so
 * every request is refused before the control service runs. */

const EXPECTED_SPECS: Record<string, { role: "viewer" | "controller" | "owner"; mutation: boolean }> = {
  "commandCenter/workspace/list": { role: "viewer", mutation: false },
  "commandCenter/workspace/get": { role: "viewer", mutation: false },
  "commandCenter/workspace/create": { role: "owner", mutation: true },
  "commandCenter/workspace/rename": { role: "owner", mutation: true },
  "commandCenter/workspace/setEnabled": { role: "owner", mutation: true },
  "commandCenter/workspace/delete": { role: "owner", mutation: true },
  "commandCenter/membership/get": { role: "viewer", mutation: false },
  "commandCenter/membership/list": { role: "viewer", mutation: false },
  "commandCenter/membership/bind": { role: "controller", mutation: true },
  "commandCenter/membership/remove": { role: "controller", mutation: true },
  "commandCenter/intervention/record": { role: "controller", mutation: true },
  "commandCenter/receipt/get": { role: "viewer", mutation: false },
  "commandCenter/receipt/list": { role: "viewer", mutation: false },
};

function controlSpy() {
  const calls: { method: string; params: unknown; principal: unknown }[] = [];
  const control = {
    async call(method: string, params: unknown, principal: unknown) {
      calls.push({ method, params, principal });
      return null;
    },
  } as unknown as CommandCenterControl;
  return { control, calls };
}

function controllerToken(): string {
  return newDeviceToken();
}

describe("command-center RACP catalog registration", () => {
  it("registers exactly the dispatcher operations with the control-service roles", () => {
    const registered = (Object.keys(RACP_OPERATIONS) as RacpOperation[]).filter((operation) =>
      operation.startsWith("commandCenter/"));
    expect([...registered].sort()).toEqual([...COMMAND_CENTER_OPERATIONS].sort());
    expect(Object.keys(EXPECTED_SPECS).sort()).toEqual([...COMMAND_CENTER_OPERATIONS].sort());
    for (const [operation, expected] of Object.entries(EXPECTED_SPECS)) {
      expect(RACP_OPERATIONS[operation as RacpOperation]).toEqual({
        role: expected.role,
        profile: "remote-host",
        mutation: expected.mutation,
      });
    }
  });

  it("binds a handler for every catalog operation without changing existing ones", () => {
    const handlers = createOperations();
    for (const operation of COMMAND_CENTER_OPERATIONS) {
      expect(handlers.has(operation)).toBe(true);
    }
    expect(handlers.has("session/list")).toBe(true);
    expect(handlers.has("workspace/toolExecute")).toBe(true);
    expect(handlers.size).toBe(Object.keys(RACP_OPERATIONS).length);
  });

  it("enforces the existing role model before the capability gate", async () => {
    const h = await harness();
    const viewer = await h.connect(VIEWER_TOKEN);
    await expect(viewer.client.request("commandCenter/workspace/create", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(viewer.client.request("commandCenter/membership/bind", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    // A read operation passes the role check and then hits the capability gate.
    await expect(viewer.client.request("commandCenter/receipt/list", {})).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    await expect(viewer.client.request("commandCenter/unknown", {})).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });

    const token = controllerToken();
    await h.store.saveDevice({
      deviceId: "dev_controller", label: "controller", roles: ["controller"],
      tokenHash: hashToken(token), createdAt: "2026-11-11T00:00:00.000Z",
    });
    const controller = await h.connect(token);
    await expect(controller.client.request("commandCenter/workspace/create", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(controller.client.request("commandCenter/intervention/record", {})).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });

  it("denies an unprivileged pairing principal explicitly", async () => {
    const h = await harness();
    const issued = await h.authenticator.issuePairingToken(60_000);
    const pairing = await h.connect(issued.token);
    expect(pairing.client.initialized?.principal.roles).toEqual([]);
    await expect(pairing.client.request("commandCenter/receipt/list", {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses an expired principal before any dispatch", async () => {
    const h = await harness();
    const expired = await h.authenticator.issuePairingToken(0);
    await expect(h.connect(expired.token)).rejects.toMatchObject({ code: "REMOTE_AUTH_FAILED" });
  });

  it("refuses every operation with CAPABILITY_UNAVAILABLE before the control service runs", async () => {
    const { control, calls } = controlSpy();
    const h = await harness({ operations: { commandCenter: control } });
    const { client } = await h.connect(OWNER_TOKEN);

    expect(Value.Check(RacpServerCapabilitiesSchema, client.initialized?.capabilities)).toBe(true);
    const capabilityKeys = Object.keys(client.initialized?.capabilities ?? {});
    expect(capabilityKeys.filter((key) => key.toLowerCase().includes("command"))).toEqual([]);

    for (const operation of COMMAND_CENTER_OPERATIONS) {
      await expect(client.request(operation, {})).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    }
    expect(calls).toHaveLength(0);
  });

  it("disposes the connection-scoped dispatcher on disconnect", async () => {
    const { control, calls } = controlSpy();
    const h = await harness({ operations: { commandCenter: control } });
    const { client, connection } = await h.connect(OWNER_TOKEN);
    await expect(client.request("commandCenter/workspace/list", {})).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    const serverConnection = connection();
    expect(serverConnection?.commandCenter).not.toBeNull();
    expect(serverConnection?.commandCenter?.disposed).toBe(false);
    expect(serverConnection?.subscriptions.size).toBe(0);
    expect(serverConnection?.terminals.size).toBe(0);

    const dispatcher = serverConnection!.commandCenter!;
    await client.close();
    await flush();
    expect(dispatcher.disposed).toBe(true);
    expect(calls).toHaveLength(0);
    expect(h.server.connectionCount()).toBe(0);
    await expect(dispatcher.dispatch("commandCenter/workspace/list", {}, { principal: { subject: "dev_owner", roles: ["owner"] } }))
      .rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
  });
});
