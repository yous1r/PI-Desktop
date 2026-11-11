import {
  COMMAND_CENTER_MAX_REVISION,
  commandCenterCanonicalJson,
  commandCenterTaskKey,
  commandCenterUtf8Bytes,
  parseCommandCenterMonitorSnapshot,
  parseCommandCenterTaskSummary,
  parseCommandCenterTaskTarget,
  type CommandCenterMonitorCursor,
  type CommandCenterTaskSummary,
  type CommandCenterTaskTarget,
} from "@pi-desktop/shared";
import type { CommandCenterMonitorProjection } from "../monitor/types.js";
import {
  COMMAND_CENTER_MONITOR_SUMMARY_LIMITS,
  type CommandCenterMonitorSummaryLimits,
} from "./types.js";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid record");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw new Error("Unexpected fields");
  }
}

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface StoredRow {
  row: CommandCenterTaskSummary;
  bytes: number;
}

function copyRow(input: unknown): StoredRow {
  const text = commandCenterCanonicalJson(parseCommandCenterTaskSummary(input));
  const row = freeze(parseCommandCenterTaskSummary(JSON.parse(text)));
  return { row, bytes: commandCenterUtf8Bytes(text) };
}

export function summaryLimits(overrides: Partial<CommandCenterMonitorSummaryLimits> = {}): Readonly<CommandCenterMonitorSummaryLimits> {
  const limits = { ...COMMAND_CENTER_MONITOR_SUMMARY_LIMITS, ...overrides };
  for (const key of Reflect.ownKeys(limits)) {
    if (typeof key !== "string" || !Object.hasOwn(COMMAND_CENTER_MONITOR_SUMMARY_LIMITS, key)) {
      throw new RangeError("COMMAND_CENTER_CLIENT_INVALID_SUMMARY_LIMIT");
    }
    const name = key as keyof CommandCenterMonitorSummaryLimits;
    if (!Number.isSafeInteger(limits[name]) || limits[name] <= 0 || limits[name] > COMMAND_CENTER_MONITOR_SUMMARY_LIMITS[name]) {
      throw new RangeError("COMMAND_CENTER_CLIENT_INVALID_SUMMARY_LIMIT");
    }
  }
  return Object.freeze(limits);
}

export interface InitialSummary {
  projection: CommandCenterMonitorProjection;
  rows: Map<string, StoredRow>;
  bytes: number;
}

export function initialSummary(input: unknown, limits: Readonly<CommandCenterMonitorSummaryLimits>): InitialSummary {
  const initial = record(input);
  exactKeys(initial, ["cursor", "generatedAt", "rows"]);
  // Reuse C1 cursor/timestamp checks without claiming this complete projection is a page.
  const metadata = parseCommandCenterMonitorSnapshot({
    version: 1, cursor: initial.cursor, generatedAt: initial.generatedAt, rows: [],
  });
  const copied = parseCommandCenterMonitorSnapshot(JSON.parse(commandCenterCanonicalJson(metadata)));
  const values = initial.rows;
  if (!Array.isArray(values)) throw new Error("Invalid initial rows");
  const count = values.length;
  if (!Number.isSafeInteger(count) || count < 0 || count > limits.maxRows) throw new Error("Invalid initial rows");
  const rows = new Map<string, StoredRow>();
  let bytes = 0;
  // Fixed count avoids an external iterator or row accessor extending validation unboundedly.
  for (let index = 0; index < count; index += 1) {
    const stored = copyRow(values[index]);
    const key = commandCenterTaskKey(stored.row.target);
    if (rows.has(key)) throw new Error("Duplicate initial task");
    bytes += stored.bytes;
    if (bytes > limits.maxBytes) throw new Error("Initial byte limit");
    rows.set(key, stored);
  }
  return {
    rows, bytes,
    projection: freeze({ cursor: copied.cursor, generatedAt: copied.generatedAt, rows: [...rows.values()].map(({ row }) => row) }),
  };
}

export type SummaryChange = { cursor: CommandCenterMonitorCursor } & (
  | { type: "upsert"; stored: StoredRow }
  | { type: "remove"; target: CommandCenterTaskTarget }
  | { type: "resync" }
);

export function parseChange(input: unknown): SummaryChange {
  const change = record(input);
  const type = change.type;
  exactKeys(change, type === "upsert" ? ["version", "epoch", "sequence", "type", "row"]
    : type === "remove" ? ["version", "epoch", "sequence", "type", "target"]
      : ["version", "epoch", "sequence", "type"]);
  const version = change.version;
  const epoch = change.epoch;
  const sequence = change.sequence;
  if (version !== 1 || typeof epoch !== "string" || epoch.length === 0 || epoch.length > 256 || epoch.includes("\0") ||
      typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > COMMAND_CENTER_MAX_REVISION) {
    throw new Error("Invalid change metadata");
  }
  const cursor = { epoch, sequence };
  if (type === "upsert") return { cursor, type, stored: copyRow(change.row) };
  if (type === "remove") {
    const target = freeze(parseCommandCenterTaskTarget(JSON.parse(commandCenterCanonicalJson(parseCommandCenterTaskTarget(change.target)))));
    return { cursor, type, target };
  }
  if (type === "resync") return { cursor, type };
  throw new Error("Unknown change type");
}
