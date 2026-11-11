import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CommandCenterControl,
  type CommandCenterAccess,
  type CommandCenterBinding,
  type CommandCenterRepository,
  type CommandCenterRepositoryContext,
  type CommandCenterResults,
} from "./command-center-control.js";
import type { Principal } from "./ports.js";

/** C3 authorization/idempotency boundary, exercised through the public service. */

const fixture = JSON.parse(
  readFileSync(new URL("../../shared/test/fixtures/command-center-control.json", import.meta.url), "utf8"),
);
const binding: CommandCenterBinding = {
  hostId: "host_7c1e0a93b4d2f681",
  hostEpoch: "3f6b2a90-1c4d-4e88-9a71-5b2c8d0e6f14",
};
const owner: Principal = { subject: "local:owner", roles: ["owner"] };
const workspaceId = "7d1e4c20-8a3b-4f56-9c12-2e7a9b0d4f31";

type Call = {
  method: string;
  input: unknown;
  context: CommandCenterRepositoryContext;
};

function defaultResult(method: string): unknown {
  switch (method) {
    case "workspace/list":
      return { workspaces: [] };
    case "membership/list":
      return { memberships: [], nextAfterSessionId: null };
    case "receipt/list":
      return { entries: [], nextAfterSequence: null };
    case "workspace/get":
    case "membership/get":
    case "receipt/get":
      return null;
    default:
      throw new Error(`Unexpected repository call: ${method}`);
  }
}

function setup(
  handlers: Partial<Record<string, (input: Record<string, unknown>, context: CommandCenterRepositoryContext) => unknown>> = {},
  options: {
    mutationsClosed?: () => boolean;
    authorize?: (principal: Principal, access: CommandCenterAccess) => Promise<boolean>;
    runtime?: { canRecord: (...args: unknown[]) => boolean };
    identity?: () => CommandCenterBinding;
  } = {},
) {
  const calls: Call[] = [];
  const repository = {
    async call(method: string, input: unknown, context: CommandCenterRepositoryContext) {
      calls.push({ method, input, context });
      const handler = handlers[method];
      return handler ? handler(input as Record<string, unknown>, context) : defaultResult(method);
    },
  } as unknown as CommandCenterRepository;
  const control = new CommandCenterControl({
    repository,
    hostIdentity: options.identity ?? (() => binding),
    mutationsClosed: options.mutationsClosed ?? (() => false),
    authorize: options.authorize ?? (async () => true),
    ...(options.runtime ? { runtime: options.runtime } : {}),
  });
  return { control, calls };
}

/** Valid `workspace/create` payload; call sites override one field at a time. */
function request(extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    hostId: binding.hostId,
    expectedHostEpoch: binding.hostEpoch,
    commandWorkspaceId: workspaceId,
    name: "Focused work",
    enabled: true,
    ...extra,
  };
}

function receiptEntry(overrides: Record<string, unknown> = {}) {
  return {
    receipt: fixture.receipt,
    hostId: binding.hostId,
    hostEpoch: binding.hostEpoch,
    commandWorkspaceId: workspaceId,
    membershipRevision: 7,
    sequence: 1,
    ...overrides,
  };
}

describe("command-center control authorization", () => {
  it("rejects unknown methods and role-less mutations", async () => {
    const { control } = setup();
    await expect(control.call("nope/at/all" as never, {}, owner)).rejects.toMatchObject({ code: "METHOD_NOT_FOUND" });
    await expect(
      control.call("workspace/create", request(), { subject: "local:viewer", roles: ["viewer"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("conflicts when the request names another host or a stale epoch", async () => {
    const { control, calls } = setup();
    await expect(
      control.call("workspace/create", request({ hostId: "host_other" }), owner),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      control.call("workspace/create", request({ expectedHostEpoch: "0d9c1b7e-2a3f-4c56-8b41-6e5a9d0c3b28" }), owner),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(calls).toHaveLength(0);
  });

  it("closes mutations during owner handoff while reads continue", async () => {
    const { control, calls } = setup({}, { mutationsClosed: () => true });
    await expect(control.call("workspace/create", request(), owner)).rejects.toMatchObject({ code: "HOST_BUSY" });
    await expect(control.call("workspace/list", { version: 1, hostId: binding.hostId }, owner)).resolves.toEqual({
      workspaces: [],
    });
    expect(calls.map((call) => call.method)).toEqual(["workspace/list"]);
  });

  it("requires scope authorization before the repository sees a request", async () => {
    // `workspace/create` has no existing scope to authorize; a rename must pass
    // the control-scope check before the repository is reached.
    const denied = setup({}, { authorize: async (_principal, access) => access.permission === "read" });
    await expect(
      denied.control.call(
        "workspace/rename",
        {
          version: 1,
          hostId: binding.hostId,
          expectedHostEpoch: binding.hostEpoch,
          commandWorkspaceId: workspaceId,
          expectedRevision: 1,
          name: "Renamed",
        },
        owner,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(denied.calls).toHaveLength(0);

    const readDenied = setup({}, { authorize: async () => false });
    await expect(
      readDenied.control.call(
        "workspace/get",
        { version: 1, hostId: binding.hostId, commandWorkspaceId: workspaceId },
        owner,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(readDenied.calls).toHaveLength(0);
  });

  it("keeps membership removal unavailable and passes granted scopes to the repository", async () => {
    const { control, calls } = setup({}, { authorize: async () => true });
    await expect(
      control.call(
        "membership/remove",
        { version: 1, hostId: binding.hostId, expectedHostEpoch: binding.hostEpoch, commandWorkspaceId: workspaceId, sessionId: "sess-1", expectedRevision: 1 },
        owner,
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });

    const result = await control.call(
      "workspace/list",
      { version: 1, hostId: binding.hostId },
      { subject: "local:owner", roles: ["owner"] },
    );
    expect(result).toEqual({ workspaces: [] });
    expect(calls[0].context.auth.roles).toEqual(["owner"]);
    expect(calls[0].context.binding).toEqual(binding);
  });
});

describe("command-center control row filtering", () => {
  const deniedWorkspace = "9b3f6e42-ac5d-4b78-9e34-4a9c1d2f6b53";
  const allowed = "sess-parent-1";

  it("returns only workspaces the principal may read", async () => {
    const workspaces = [
      { id: workspaceId, name: "Allowed", enabled: true, revision: 1 },
      { id: deniedWorkspace, name: "Denied", enabled: true, revision: 1 },
    ];
    const { control } = setup(
      { "workspace/list": () => ({ workspaces }) },
      { authorize: async (_principal, access) => access.id === workspaceId },
    );
    const result = await control.call("workspace/list", { version: 1, hostId: binding.hostId }, owner);
    expect(result.workspaces.map((workspace) => workspace.id)).toEqual([workspaceId]);
  });

  it("drops receipts whose session or workspace scope is denied", async () => {
    const entries = [
      receiptEntry({ sequence: 1 }),
      receiptEntry({ commandWorkspaceId: deniedWorkspace, sequence: 2 }),
    ];
    const { control } = setup(
      { "receipt/list": () => ({ entries, nextAfterSequence: null }) },
      {
        authorize: async (_principal, access) =>
          access.kind === "workspace" ? access.id === workspaceId : access.id === allowed,
      },
    );
    const result = await control.call(
      "receipt/list",
      { version: 1, hostId: binding.hostId, afterSequence: 0, limit: 10 },
      owner,
    );
    expect(result.receipts.map((receipt) => receipt.requestId)).toEqual([fixture.receipt.requestId]);
    expect(result.nextAfterSequence).toBeNull();
  });

  it("refuses a single receipt the principal cannot read", async () => {
    const { control } = setup(
      { "receipt/get": () => receiptEntry({ commandWorkspaceId: deniedWorkspace }) },
      { authorize: async (_principal, access) => access.kind === "session" },
    );
    await expect(
      control.call("receipt/get", { version: 1, hostId: binding.hostId, requestId: fixture.receipt.requestId }, owner),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a response over the page byte budget", async () => {
    const workspaces = Array.from({ length: 2_000 }, (_, index) => ({
      id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      name: "x".repeat(256),
      enabled: true,
      revision: 1,
    }));
    const { control } = setup(
      { "workspace/list": () => ({ workspaces }) },
      { authorize: async () => true },
    );
    await expect(
      control.call("workspace/list", { version: 1, hostId: binding.hostId }, owner),
    ).rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });
  });

  it("filters membership rows by the session scope", async () => {
    const memberships = [
      { sessionId: allowed, commandWorkspaceId: workspaceId, revision: 3 },
      { sessionId: "sess-denied", commandWorkspaceId: workspaceId, revision: 3 },
    ];
    const { control } = setup(
      { "membership/list": () => ({ memberships, nextAfterSessionId: null }) },
      {
        authorize: async (_principal, access) =>
          access.id === allowed || (access.kind === "workspace" && access.id === workspaceId),
      },
    );
    const result = await control.call(
      "membership/list",
      { version: 1, hostId: binding.hostId, commandWorkspaceId: workspaceId, limit: 10 },
      owner,
    );
    expect(result.memberships.map((member) => member.sessionId)).toEqual([allowed]);
  });
});

describe("command-center control receipt and capability boundaries", () => {
  it("replays a matching receipt without mutating or granting capability", async () => {
    const runtime = { canRecord: () => false };
    const { control, calls } = setup(
      { "receipt/get": () => receiptEntry() },
      { runtime, authorize: async () => true },
    );
    const result = await control.call("intervention/record", fixture.request, owner);
    expect(result).toEqual({ receipt: fixture.receipt, replayed: true });
    expect(calls.map((call) => call.method)).toEqual(["receipt/get"]);
  });

  it("refuses a reused request ID whose payload no longer matches", async () => {
    const { control } = setup(
      { "receipt/get": () => receiptEntry({ receipt: { ...fixture.receipt, fingerprint: "0".repeat(64) } }) },
      { authorize: async () => true },
    );
    await expect(control.call("intervention/record", fixture.request, owner)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("requires a qualified runtime consumer before the first mutation", async () => {
    const { control, calls } = setup({}, { authorize: async () => true });
    await expect(control.call("intervention/record", fixture.request, owner)).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    expect(calls.map((call) => call.method)).toEqual(["receipt/get"]);
  });

  it("records once through the repository and returns the committed receipt", async () => {
    const { control, calls } = setup(
      {
        "receipt/get": () => null,
        "intervention/record": () => ({ entry: receiptEntry(), replayed: false }),
      },
      { runtime: { canRecord: () => true }, authorize: async () => true },
    );
    const result = await control.call("intervention/record", fixture.request, owner);
    expect(result).toEqual({ receipt: fixture.receipt, replayed: false });
    expect(calls.map((call) => call.method)).toEqual(["receipt/get", "intervention/record"]);
    expect(calls[1].context.auth.sessionIds).toContain("sess-parent-1");
    expect(calls[1].context.auth.workspaceIds).toContain(workspaceId);
  });

  it("fails closed when the owner changes across a repository await", async () => {
    let current: CommandCenterBinding = binding;
    const { control } = setup(
      {
        "receipt/get": () => {
          current = { ...binding, hostEpoch: "0d9c1b7e-2a3f-4c56-8b41-6e5a9d0c3b28" };
          return null;
        },
      },
      { identity: () => current, authorize: async () => true, runtime: { canRecord: () => true } },
    );
    await expect(control.call("intervention/record", fixture.request, owner)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
