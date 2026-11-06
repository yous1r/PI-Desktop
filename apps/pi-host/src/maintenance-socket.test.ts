import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { HOST_MAINTENANCE_LEASE_MS, MaintenanceAdmission } from "@pi-desktop/agent-host";
import type { ProviderImportPayload, ProviderPublic } from "@pi-desktop/shared";

import { sendAdminRequest, sendMaintenanceRequest, startAdminSocket, type AdminSocket } from "./admin-socket.js";
import { handleMaintenanceRequest } from "./maintenance.js";
import { runMaintenance } from "./maintenance-cli.js";
import { runProviderImport, type HostCaller } from "./provider-import.js";

const directories: string[] = [];
const servers: AdminSocket[] = [];
beforeAll(() => { process.chdir(process.env.PI_SCRATCH_DIR ?? tmpdir()); });
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function directory() {
  const dir = await mkdtemp(join(process.cwd(), "maintenance-admin-"));
  directories.push(dir);
  return dir;
}

function payload(): ProviderImportPayload {
  return { version: 1, providers: [{ sourceId: "source-1", input: {
    name: "Models", vendorKey: "custom", type: "openai_compatible", protocol: "openai_compatible",
    baseUrl: "https://models.example/v1", authKind: "api_key", secretValue: "fixture-private-key",
    headers: {}, temperature: 0, models: [
      { id: "first", contextWindow: 10000, maxTokens: 1000, thinkingLevels: ["off"], defaultThinkingLevel: null },
    ],
  } }] };
}

class HostFixture implements HostCaller {
  rows = new Map<string, ProviderPublic>();
  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === "providers.create") {
      const row = { ...params, id: randomUUID(), enabled: true, hasSecret: true } as unknown as ProviderPublic;
      this.rows.set(row.id, row);
      return { provider: row } as T;
    }
    if (method === "providers.get") return { provider: this.rows.get(String(params.id)) ?? null } as T;
    if (method === "providers.getSecret") return { value: null } as T;
    throw new Error("unexpected RPC");
  }
}

function capture() {
  const io = { stdin: Readable.from([""]), stdout: "", stream: undefined as unknown as Writable };
  io.stream = new Writable({ write(chunk, _encoding, done) { io.stdout += String(chunk); done(); } });
  return io;
}

describe.skipIf(process.platform === "win32")("maintenance over the owner-only admin channel", () => {
  async function fixture() {
    const dataDir = await directory();
    const gate = new MaintenanceAdmission();
    const hostId = "host_fixture";
    const host = new HostFixture();
    const server = await startAdminSocket({
      dataDir,
      getHost: () => host,
      maintenance: {
        handle: (request) => handleMaintenanceRequest(
          { hostId, version: "9.9.9", gate, inspect: async () => ({ clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0, terminals: 0, plugins: 0 }) },
          request,
        ),
        isClosed: () => gate.isClosed(),
      },
    });
    servers.push(server);
    return { dataDir, hostId, host };
  }

  it("acquires and releases a lease through the CLI contract", async () => {
    const { dataDir, hostId } = await fixture();
    expect(await sendMaintenanceRequest(dataDir, { op: "status", expectedHostId: hostId }))
      .toEqual({ ok: true, hostId, version: "9.9.9", protocol: 1, busy: false });
    const acquired = await sendMaintenanceRequest(dataDir, { op: "acquire", leaseId: "lease-1", expectedHostId: hostId });
    expect(acquired).toMatchObject({ ok: true, leaseId: "lease-1", busy: true });
    expect(Date.parse((acquired as { expiresAt: string }).expiresAt) - Date.now()).toBeLessThanOrEqual(HOST_MAINTENANCE_LEASE_MS);
    expect(await sendMaintenanceRequest(dataDir, { op: "acquire", leaseId: "lease-2", expectedHostId: hostId }))
      .toEqual({ ok: false, code: "HOST_BUSY" });
    expect(await sendMaintenanceRequest(dataDir, { op: "release", leaseId: "lease-1", expectedHostId: hostId }))
      .toMatchObject({ ok: true, busy: false });
  });

  it("refuses another Host identity and never reports a lease for a missing Host", async () => {
    const { dataDir, hostId } = await fixture();
    expect(await sendMaintenanceRequest(dataDir, { op: "acquire", leaseId: "lease-1", expectedHostId: "host_other" }))
      .toEqual({ ok: false, code: "HOST_AUTH_FAILED" });
    for (const server of servers.splice(0)) await server.close();
    expect(await sendMaintenanceRequest(dataDir, { op: "acquire", leaseId: "lease-1", expectedHostId: hostId }))
      .toEqual({ ok: false, code: "HOST_MAINTENANCE_UNAVAILABLE" });
  });

  it("keeps provider import working, then fences it while a lease is held", async () => {
    const { dataDir, hostId, host } = await fixture();
    expect((await sendAdminRequest(dataDir, payload())).ok).toBe(true);
    expect(host.rows.size).toBe(1);
    expect((await sendMaintenanceRequest(dataDir, { op: "acquire", leaseId: "lease-1", expectedHostId: hostId })).ok).toBe(true);
    expect(await sendAdminRequest(dataDir, payload())).toEqual({ ok: false, code: "ADMIN_BUSY" });
    expect(host.rows.size).toBe(1);
  });

  it("prints one PI_HOST_MAINTENANCE line and exits zero for an accepted lease", async () => {
    const { dataDir, hostId } = await fixture();
    const io = capture();
    io.stdin = Readable.from([JSON.stringify({ op: "acquire", leaseId: "lease-cli", expectedHostId: hostId })]);
    const code = await runMaintenance(["--data-dir", dataDir], { stdin: io.stdin, stdout: io.stream });
    expect(code).toBe(0);
    const lines = io.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith("PI_HOST_MAINTENANCE ")).toBe(true);
    expect(JSON.parse(lines[0]!.slice("PI_HOST_MAINTENANCE ".length))).toMatchObject({ ok: true, leaseId: "lease-cli" });
  });

  it("still imports providers when no lease is held", async () => {
    const { dataDir } = await fixture();
    const io = capture();
    io.stdin = Readable.from([JSON.stringify(payload())]);
    const code = await runProviderImport(["--data-dir", dataDir], { stdin: io.stdin, stdout: io.stream });
    expect(code).toBe(0);
    expect(io.stdout.startsWith("PI_HOST_PROVIDERS ")).toBe(true);
  });
});
