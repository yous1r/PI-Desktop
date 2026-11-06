import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { HOST_MAINTENANCE_LEASE_MS, MaintenanceAdmission, type MaintenanceBusyState } from "@pi-desktop/agent-host";

import { parseMaintenanceRequest, handleMaintenanceRequest, maintenanceLine } from "./maintenance.js";
import { runMaintenance } from "./maintenance-cli.js";

const idle: MaintenanceBusyState = { clients: 0, turns: 0, queuedTurns: 0, plans: 0, tools: 0, processes: 0, terminals: 0, plugins: 0 };
const hostId = "host_fixture";

function coordinator(gate: MaintenanceAdmission, busy: Partial<MaintenanceBusyState> = {}) {
  return {
    hostId,
    version: "9.9.9",
    gate,
    inspect: async () => ({ ...idle, ...busy }),
  };
}

describe("maintenance request parsing", () => {
  it("accepts only the three operations with an explicit host identity", () => {
    expect(parseMaintenanceRequest(JSON.stringify({ op: "status", expectedHostId: hostId }))).toEqual({ op: "status", expectedHostId: hostId });
    expect(parseMaintenanceRequest(JSON.stringify({ op: "acquire", leaseId: "lease-1", expectedHostId: hostId }))).toEqual({ op: "acquire", leaseId: "lease-1", expectedHostId: hostId });
    for (const raw of [
      "",
      "{}",
      "[]",
      JSON.stringify({ op: "status" }),
      JSON.stringify({ op: "status", expectedHostId: hostId, extra: 1 }),
      JSON.stringify({ op: "import", expectedHostId: hostId }),
      JSON.stringify({ op: "acquire", expectedHostId: hostId }),
      JSON.stringify({ op: "release", expectedHostId: hostId }),
      JSON.stringify({ op: "acquire", leaseId: "bad lease", expectedHostId: hostId }),
      JSON.stringify({ op: "acquire", leaseId: "lease-1", expectedHostId: "../etc" }),
    ]) {
      expect(() => parseMaintenanceRequest(raw)).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
    }
  });
});

describe("maintenance coordination", () => {
  it("reports status and refuses a lease for another host identity", async () => {
    const gate = new MaintenanceAdmission();
    const c = coordinator(gate);
    expect(await handleMaintenanceRequest(c, { op: "status", expectedHostId: hostId })).toEqual({
      ok: true, hostId, version: "9.9.9", protocol: 1, busy: false,
    });
    expect(await handleMaintenanceRequest(c, { op: "acquire", leaseId: "l1", expectedHostId: "host_other" })).toEqual({ ok: false, code: "HOST_AUTH_FAILED" });
    expect(gate.isClosed()).toBe(false);
  });

  it("grants one lease, refuses a second holder, and reports busy until release", async () => {
    const gate = new MaintenanceAdmission();
    const c = coordinator(gate);
    const acquired = await handleMaintenanceRequest(c, { op: "acquire", leaseId: "l1", expectedHostId: hostId });
    expect(acquired).toMatchObject({ ok: true, leaseId: "l1", protocol: 1, busy: true });
    expect(Date.parse((acquired as { expiresAt: string }).expiresAt) - Date.now()).toBeLessThanOrEqual(HOST_MAINTENANCE_LEASE_MS);
    expect(await handleMaintenanceRequest(c, { op: "acquire", leaseId: "l2", expectedHostId: hostId })).toEqual({ ok: false, code: "HOST_BUSY" });
    expect(await handleMaintenanceRequest(c, { op: "release", leaseId: "l2", expectedHostId: hostId })).toEqual({ ok: false, code: "HOST_AUTH_FAILED" });
    expect(await handleMaintenanceRequest(c, { op: "status", expectedHostId: hostId })).toMatchObject({ ok: true, busy: true });
    expect(await handleMaintenanceRequest(c, { op: "release", leaseId: "l1", expectedHostId: hostId })).toMatchObject({ ok: true, busy: false });
    expect(gate.isClosed()).toBe(false);
  });

  it("refuses a lease while any RACP client, turn, plan, tool, process, terminal or plugin is live", async () => {
    for (const key of ["clients", "turns", "queuedTurns", "plans", "tools", "processes", "terminals", "plugins"] as const) {
      const gate = new MaintenanceAdmission();
      const response = await handleMaintenanceRequest(coordinator(gate, { [key]: 1 }), { op: "acquire", leaseId: "l1", expectedHostId: hostId });
      expect(response).toEqual({ ok: false, code: "HOST_BUSY" });
      expect(gate.isClosed()).toBe(false);
    }
  });

  it("formats exactly one parseable stdout line", () => {
    expect(maintenanceLine({ ok: false, code: "HOST_BUSY" })).toBe('PI_HOST_MAINTENANCE {"ok":false,"code":"HOST_BUSY"}');
  });
});

describe("maintenance CLI without a running Host", () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

  it("reports HOST_MAINTENANCE_UNAVAILABLE and a nonzero exit instead of starting a Host", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-host-maint-"));
    dirs.push(dataDir);
    let stdout = "";
    const code = await runMaintenance(["--data-dir", dataDir], {
      stdin: Readable.from([JSON.stringify({ op: "status", expectedHostId: hostId })]),
      stdout: new Writable({ write(chunk, _encoding, done) { stdout += String(chunk); done(); } }),
    });
    expect(code).toBe(1);
    expect(stdout).toBe('PI_HOST_MAINTENANCE {"ok":false,"code":"HOST_MAINTENANCE_UNAVAILABLE"}\n');
  });

  it("rejects malformed requests, extra argv and unbounded stdin without touching the Host", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pi-host-maint-"));
    dirs.push(dataDir);
    const run = async (argv: string[], input: string) => {
      let stdout = "";
      const code = await runMaintenance(argv, {
        stdin: Readable.from([input]),
        stdout: new Writable({ write(chunk, _encoding, done) { stdout += String(chunk); done(); } }),
      });
      return { code, stdout };
    };
    expect(await run(["--data-dir", dataDir], "{not json")).toEqual({ code: 1, stdout: 'PI_HOST_MAINTENANCE {"ok":false,"code":"INVALID_REQUEST"}\n' });
    expect((await run(["--data-dir", dataDir, "extra"], "{}")).stdout).toBe('PI_HOST_MAINTENANCE {"ok":false,"code":"INVALID_REQUEST"}\n');
    expect((await run(["--data-dir", dataDir], "x".repeat(4096))).stdout).toBe('PI_HOST_MAINTENANCE {"ok":false,"code":"INVALID_REQUEST"}\n');
  });
});
