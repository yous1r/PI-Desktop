import { Type } from "typebox";

/**
 * Version of the command-center control contracts (C1).
 *
 * These shared schemas are exported for producers and consumers. RACP and IPC
 * operations and capability advertisement are registered only when their
 * authoritative repositories and runtime adapters are implemented.
 * Incompatible wire changes require a new version literal.
 */
export const COMMAND_CENTER_VERSION = 1;

/**
 * One intervention request and its canonical fingerprint payload.
 *
 * Equal to `RACP_DEFAULT_LIMITS.maxPromptBytes` (256 KiB) so a control intent
 * can never carry more text than one existing prompt. Producers must also stay
 * within the negotiated `maxFrameBytes` of the transport that carries it.
 */
export const COMMAND_CENTER_MAX_REQUEST_BYTES = 256 * 1024;
/** A durable receipt is small; it never carries transcript or tool payloads. */
export const COMMAND_CENTER_MAX_RECEIPT_BYTES = 16 * 1024;
/** At most 100 summary rows per page, matching the approved draft limit. */
export const COMMAND_CENTER_MAX_SUMMARY_PAGE_ROWS = 100;
/** Byte cap for one summary page, independent of the row count. */
export const COMMAND_CENTER_MAX_SUMMARY_PAGE_BYTES = 256 * 1024;
/** Enabled execution groups per Host for the first release. */
export const COMMAND_CENTER_MAX_ENABLED_WORKSPACES = 3;
/** Live Agent slots per command workspace for the first release. */
export const COMMAND_CENTER_MAX_AGENTS_PER_WORKSPACE = 12;
/** Live Agent slots per Host for the first release (shared by all clients). */
export const COMMAND_CENTER_MAX_AGENTS_PER_HOST = 36;
/** Revisions and counts stay inside the exact JavaScript integer range. */
export const COMMAND_CENTER_MAX_REVISION = Number.MAX_SAFE_INTEGER;

/**
 * Non-nil lower-case UUID. Nil UUIDs are reserved so an unset value cannot
 * accidentally address a real Host, epoch, workspace or request.
 */
export const CommandCenterUuidSchema = Type.String({
  pattern: "^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});

/**
 * Existing canonical identifier (session, turn or delegation) resolved by Host
 * registries. Opaque here: this contract must not impose a new identity format
 * on durable session records that already exist.
 */
export const CommandCenterCanonicalIdSchema = Type.String({
  minLength: 1, maxLength: 128, pattern: "^[^\\u0000]+$",
});

/** Monotonic revision or non-negative count. */
export const CommandCenterRevisionSchema = Type.Integer({ minimum: 0, maximum: COMMAND_CENTER_MAX_REVISION });
export const CommandCenterCountSchema = Type.Integer({ minimum: 0, maximum: COMMAND_CENTER_MAX_REVISION });
/** Short display label; never a path, transcript or credential. */
export const CommandCenterLabelSchema = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000]+$" });
/** Bounded timestamp string as produced by the existing Host records. */
export const CommandCenterTimestampSchema = Type.String({ minLength: 20, maxLength: 64, pattern: "^[^\\u0000]+$" });
/** User-authored intent text. Byte limits are enforced by the parsers. */
export const CommandCenterTextSchema = Type.String({
  minLength: 1, maxLength: COMMAND_CENTER_MAX_REQUEST_BYTES, pattern: "^[^\\u0000]+$",
});

const encoder = new TextEncoder();

export function commandCenterUtf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * True when the JSON encoding of `value` fits `maxBytes`.
 *
 * Byte caps complement TypeBox item/character limits: even 100 individually
 * bounded rows may exceed the encoded page budget.
 */
export function commandCenterWithinBytes(value: unknown, maxBytes: number): boolean {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" && commandCenterUtf8Bytes(text) <= maxBytes;
  } catch {
    return false;
  }
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("COMMAND_CENTER_INVALID_NUMBER");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new Error("COMMAND_CENTER_INVALID_VALUE");
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item === undefined ? null : item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(",")}}`;
}

/**
 * Deterministic JSON used as the idempotency fingerprint input.
 *
 * Object keys are sorted with default code-unit order (all contract keys are
 * ASCII), arrays keep their order, and absent optional fields are omitted.
 * The producer hashes these exact UTF-8 bytes; transport connection IDs,
 * timestamps and retry counters are not part of a validated request, so they
 * cannot change the fingerprint. A producer in another language must reproduce
 * this canonical form byte for byte; the fixture pins one vector.
 */
export function commandCenterCanonicalJson(value: unknown): string {
  return canonicalValue(value);
}
