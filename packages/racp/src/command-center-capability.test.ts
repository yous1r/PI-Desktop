import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Value from "typebox/value";
import { CommandCenterControl, type CommandCenterBinding, type CommandCenterRepository } from "@pi-desktop/agent-host";
import { RacpServerCapabilitiesSchema } from "@pi-desktop/shared";
import type { CommandCenterMonitorPagePort } from "./command-center-monitor.js";
import { flush, harness, OWNER_TOKEN, VIEWER_TOKEN } from "./test-harness.js";

/** C3/C4 capability negotiation: the additive `commandCenter` field appears only
 * when the control service is bound and the server explicitly opts in. */

const fixture = JSON.parse(
  readFileSync(new URL("../../shared/test/fixtures/command-center-control.json", import.meta.url), "utf8"),
);
const summaryFixture = JSON.parse(
  readFileSync(new URL("../../shared/test/fixtures/command-center-summary.json", import.meta.url), "utf8"),
);
const monitorPage = summaryFixture.snapshot;

function monitorPort(page: unknown = monitorPage) {
  const calls: { request: unknown; principal: unknown }[] = [];
  const port: CommandCenterMonitorPagePort = {
    async page(request, context) {
      calls.push({ request, principal: context.principal });
      return structuredClone(page);
    },
  };
  return { port, calls };
}
const binding: CommandCenterBinding = {
  hostId: "host_7c1e0a93b4d2f681",
  hostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14",
};
const workspaceId = "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31";

function realControl() {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const repository = {
    async call(method: string, input: Record<string, unknown>) {
      calls.push({ method, input });
      if (method === "workspace/list") {
        return { workspaces: [{ id: workspaceId, name: "Main", enabled: true, revision: 1 }] };
      }
      if (method === "receipt/get") {
        return {
          receipt: fixture.receipt,
          hostId: binding.hostId,
          hostEpoch: binding.hostEpoch,
          commandWorkspaceId: workspaceId,
          membershipRevision: 7,
          sequence: 1,
        };
      }
      throw new Error(`Unexpected repository call: ${method}`);
    },
  } as unknown as CommandCenterRepository;
  const control = new CommandCenterControl({
    repository,
    hostIdentity: () => binding,
    mutationsClosed: () => false,
    authorize: async () => true,
  });
  return { control, calls };
}

function capabilityKeys(capabilities: unknown): string[] {
  return Object.keys((capabilities ?? {}) as Record<string, unknown>).filter((key) => key.toLowerCase().includes("command"));
}

describe("command-center RACP capability advertisement", () => {
  it("stays absent when the control service is unbound even when opt-in is set", async () => {
    const h = await harness({ advertiseCommandCenter: true });
    const { client } = await h.connect(OWNER_TOKEN);
    expect(Value.Check(RacpServerCapabilitiesSchema, client.initialized?.capabilities)).toBe(true);
    expect(capabilityKeys(client.initialized?.capabilities)).toEqual([]);
    await expect(client.request("commandCenter/workspace/list", { version: 1, hostId: binding.hostId }))
      .rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });

  it("stays absent when the control service is bound but the Host did not opt in", async () => {
    const { control, calls } = realControl();
    const h = await harness({ operations: { commandCenter: control } });
    const { client } = await h.connect(OWNER_TOKEN);
    expect(capabilityKeys(client.initialized?.capabilities)).toEqual([]);
    await expect(client.request("commandCenter/workspace/list", { version: 1, hostId: binding.hostId }))
      .rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(calls).toHaveLength(0);
  });

  it("advertises and dispatches workspace/list and receipt/get through the server", async () => {
    const { control, calls } = realControl();
    const h = await harness({ operations: { commandCenter: control }, advertiseCommandCenter: true });
    const { client } = await h.connect(OWNER_TOKEN);
    expect(Value.Check(RacpServerCapabilitiesSchema, client.initialized?.capabilities)).toBe(true);
    expect(client.initialized?.capabilities.commandCenter).toBe(true);

    const page = await client.request("commandCenter/workspace/list", { version: 1, hostId: binding.hostId });
    expect(page).toEqual({ workspaces: [{ id: workspaceId, name: "Main", enabled: true, revision: 1 }] });

    const receipt = await client.request("commandCenter/receipt/get", {
      version: 1, hostId: binding.hostId, requestId: fixture.receipt.requestId,
    });
    expect(receipt).toEqual(fixture.receipt);
    expect(calls.map((call) => call.method)).toEqual(["workspace/list", "receipt/get"]);
  });

  it("serves bounded monitor pages to a viewer only with the advertised capability and a bound port", async () => {
    const { control } = realControl();
    const { port, calls } = monitorPort();
    const h = await harness({
      operations: { commandCenter: control, commandCenterMonitorPage: port },
      advertiseCommandCenter: true,
    });
    const viewer = await h.connect(VIEWER_TOKEN);
    expect(viewer.client.initialized?.capabilities.commandCenter).toBe(true);

    const first = await viewer.client.request("commandCenter/monitorPage", {
      version: 1, hostId: binding.hostId,
    });
    expect(first).toEqual(monitorPage);
    const second = await viewer.client.request("commandCenter/monitorPage", {
      version: 1, hostId: binding.hostId, token: "page-token-2",
    });
    expect(second).toEqual(monitorPage);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ request: { version: 1, hostId: binding.hostId } });
    expect(calls[1]).toMatchObject({ request: { token: "page-token-2" } });
    expect(calls[0].principal).toMatchObject({ subject: "dev_viewer", roles: ["viewer"] });
  });

  it("refuses monitor pages without the advertised capability or a bound port", async () => {
    const { control } = realControl();
    const { port, calls } = monitorPort();
    const notAdvertised = await harness({ operations: { commandCenter: control, commandCenterMonitorPage: port } });
    const withoutCapability = await notAdvertised.connect(VIEWER_TOKEN);
    await expect(withoutCapability.client.request("commandCenter/monitorPage", { version: 1, hostId: binding.hostId }))
      .rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(calls).toHaveLength(0);

    const noPort = await harness({ operations: { commandCenter: control }, advertiseCommandCenter: true });
    const withoutPort = await noPort.connect(VIEWER_TOKEN);
    await expect(withoutPort.client.request("commandCenter/monitorPage", { version: 1, hostId: binding.hostId }))
      .rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
  });

  it("rejects malformed and oversized monitor pages at the transport boundary", async () => {
    const { control } = realControl();
    const oversized = { ...monitorPage, rows: Array.from({ length: 101 }, () => monitorPage.rows[0]) };
    const h = await harness({
      operations: { commandCenter: control, commandCenterMonitorPage: monitorPort(oversized).port },
      advertiseCommandCenter: true,
    });
    const viewer = await h.connect(VIEWER_TOKEN);
    await expect(viewer.client.request("commandCenter/monitorPage", { version: 1, hostId: binding.hostId }))
      .rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });
    await expect(viewer.client.request("commandCenter/monitorPage", { version: 2, hostId: binding.hostId }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(viewer.client.request("commandCenter/monitorPage", { version: 1, hostId: binding.hostId, extra: true }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("keeps role checks ahead of dispatch and refuses read operations for a role-less pairing", async () => {
    const { control, calls } = realControl();
    const h = await harness({ operations: { commandCenter: control }, advertiseCommandCenter: true });
    const viewer = await h.connect(VIEWER_TOKEN);
    await expect(viewer.client.request("commandCenter/workspace/create", {
      version: 1, hostId: binding.hostId, expectedHostEpoch: binding.hostEpoch,
      commandWorkspaceId: workspaceId, name: "New", enabled: true,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toHaveLength(0);

    const issued = await h.authenticator.issuePairingToken(60_000);
    const pairing = await h.connect(issued.token);
    await expect(pairing.client.request("commandCenter/receipt/list", { version: 1, hostId: binding.hostId, afterSequence: 0, limit: 10 }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toHaveLength(0);
  });

  it("disposes the connection-scoped dispatcher on disconnect while advertising", async () => {
    const { control } = realControl();
    const h = await harness({ operations: { commandCenter: control }, advertiseCommandCenter: true });
    const { client, connection } = await h.connect(OWNER_TOKEN);
    expect(client.initialized?.capabilities.commandCenter).toBe(true);
    await client.request("commandCenter/workspace/list", { version: 1, hostId: binding.hostId });
    const dispatcher = connection()?.commandCenter;
    expect(dispatcher).not.toBeNull();
    await client.close();
    await flush();
    expect(dispatcher?.disposed).toBe(true);
    expect(h.server.connectionCount()).toBe(0);
  });
});
