import { Type, type Static } from "typebox";
import * as Value from "typebox/value";
import { RacpError, type Principal } from "@pi-desktop/agent-host";
import {
  COMMAND_CENTER_MAX_SUMMARY_PAGE_BYTES,
  COMMAND_CENTER_MAX_SUMMARY_PAGE_ROWS,
  CommandCenterHostIdSchema,
  commandCenterWithinBytes,
  parseCommandCenterMonitorSnapshot,
  type CommandCenterMonitorSnapshot,
} from "@pi-desktop/shared";

/** Single wire name for the bounded monitor page read. */
export const COMMAND_CENTER_MONITOR_OPERATION = "commandCenter/monitorPage" as const;

const pageToken = Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000]+$" });

/**
 * The request carries only a Host identity and an optional continuation token.
 * The trusted scope/access lease stays server-side; a client can never choose
 * which authorization scope a page belongs to.
 */
const MonitorPageRequestSchema = Type.Object({
  version: Type.Literal(1),
  hostId: CommandCenterHostIdSchema,
  token: Type.Optional(pageToken),
}, { additionalProperties: false });
export type CommandCenterMonitorPageRequest = Static<typeof MonitorPageRequestSchema>;

export function parseCommandCenterMonitorPageRequest(value: unknown): CommandCenterMonitorPageRequest {
  if (!Value.Check(MonitorPageRequestSchema, value)) {
    throw new RacpError("INVALID_ARGUMENT", "invalid command-center monitor page request");
  }
  return value;
}

/** A host-bound page source; the implementation resolves its trusted scope. */
export type CommandCenterMonitorPagePort = {
  page(
    request: CommandCenterMonitorPageRequest,
    context: { principal: Principal },
  ): Promise<unknown>;
};

/**
 * Validate one page at the transport boundary. The shared C1 parser already
 * enforces the schema, row/task uniqueness and the byte budget; the explicit
 * checks first keep an oversized producer response a resource failure instead
 * of an internal schema failure.
 */
export function validateCommandCenterMonitorPageResponse(value: unknown): CommandCenterMonitorSnapshot {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const rows = (value as { rows?: unknown }).rows;
    if (Array.isArray(rows) && rows.length > COMMAND_CENTER_MAX_SUMMARY_PAGE_ROWS) {
      throw new RacpError("RESOURCE_EXHAUSTED", "command-center monitor page exceeds the row budget");
    }
  }
  if (!commandCenterWithinBytes(value, COMMAND_CENTER_MAX_SUMMARY_PAGE_BYTES)) {
    throw new RacpError("RESOURCE_EXHAUSTED", "command-center monitor page exceeds the page budget");
  }
  try {
    return parseCommandCenterMonitorSnapshot(value);
  } catch {
    throw new RacpError("INTERNAL", "command-center monitor page is invalid");
  }
}
