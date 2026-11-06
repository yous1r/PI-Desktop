import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { MaintenanceFailure } from "@pi-desktop/agent-host";

import { maintenanceLine, parseMaintenanceRequest, type MaintenanceResponse } from "./maintenance.js";
import { readCapped, ImportFailure } from "./provider-import.js";

/**
 * `pi-host maintenance [--data-dir <dir>]` with one bounded JSON request on
 * stdin. It only talks to the running Host's owner-only admin socket: it never
 * creates the data directory, spawns host-core, or opens the database.
 */
export async function runMaintenance(
  argv: string[],
  io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream } = process,
): Promise<number> {
  let response: MaintenanceResponse;
  try {
    if (argv.length !== 0 && !(argv.length === 2 && argv[0] === "--data-dir" && argv[1])) throw new MaintenanceFailure("INVALID_REQUEST");
    const dataDir = resolve(argv[1] ?? process.env.PI_DESKTOP_DATA_DIR ?? join(homedir(), ".pi-desktop"));
    const request = parseMaintenanceRequest(await readCapped(io.stdin, 1024, 20_000));
    const { sendMaintenanceRequest } = await import("./admin-socket.js");
    response = await sendMaintenanceRequest(dataDir, request);
  } catch (error) {
    // An oversized or unreadable request is still a request error, never a lease.
    response = { ok: false, code: failureCode(error) };
  }
  io.stdout.write(`${maintenanceLine(response)}\n`);
  return response.ok ? 0 : 1;
}

/** Every refusal maps onto the four documented maintenance codes. */
function failureCode(error: unknown): MaintenanceFailure["code"] {
  if (error instanceof MaintenanceFailure) return error.code;
  if (error instanceof ImportFailure && (error.code === "INVALID_REQUEST" || error.code === "PAYLOAD_TOO_LARGE")) return "INVALID_REQUEST";
  return "HOST_MAINTENANCE_UNAVAILABLE";
}
