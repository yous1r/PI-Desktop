import {
  COMMAND_CENTER_VERSION,
  commandCenterTaskKey,
  commandCenterUtf8Bytes,
  parseCommandCenterMonitorSnapshot,
  parseCommandCenterTaskSummary,
  type CommandCenterTaskSummary,
} from "@pi-desktop/shared";
import { MonitorSnapshotCaptureError, type MonitorSnapshotLimits } from "./types.js";

export type SnapshotPage = { json: string; token?: string };
export type SnapshotGeneration = {
  scopeKey: string;
  expiresAt: number;
  rows: number;
  /** All page JSON plus encoded scope and token-index keys; excludes JS object overhead. */
  bytes: number;
  pages: SnapshotPage[];
};

type EncodedRow = { json: string; bytes: number };

function copyRows(source: Iterable<CommandCenterTaskSummary>, limits: Readonly<MonitorSnapshotLimits>): EncodedRow[] {
  const rows: EncodedRow[] = [];
  const keys = new Set<string>();
  let bytes = 0;
  for (const value of source) {
    // Inspect at most maxRows + 1 elements, even for an unbounded iterator.
    if (rows.length === limits.maxRows) throw new MonitorSnapshotCaptureError("row_limit");
    let row: CommandCenterTaskSummary;
    try {
      parseCommandCenterTaskSummary(value);
      row = parseCommandCenterTaskSummary(structuredClone(value));
    } catch (cause) {
      throw new MonitorSnapshotCaptureError("invalid_row", { cause });
    }
    const key = commandCenterTaskKey(row.target);
    if (keys.has(key)) throw new MonitorSnapshotCaptureError("duplicate_task");
    keys.add(key);
    const json = JSON.stringify(row);
    const rowBytes = commandCenterUtf8Bytes(json);
    bytes += rowBytes;
    if (bytes > limits.maxBytes) throw new MonitorSnapshotCaptureError("byte_limit");
    rows.push({ json, bytes: rowBytes });
  }
  return rows;
}

/** Stage a complete generation without mutating retained generations or tokens. */
export function buildSnapshotGeneration(input: {
  scopeKey: string;
  epoch: string;
  sequence: number;
  now: number;
  rows: Iterable<CommandCenterTaskSummary>;
  limits: Readonly<MonitorSnapshotLimits>;
  nextToken(): string;
}): SnapshotGeneration {
  const { scopeKey, epoch, sequence, now, limits } = input;
  const header = { version: COMMAND_CENTER_VERSION, cursor: { epoch, sequence }, generatedAt: new Date(now).toISOString() };
  // C1 validates metadata before consuming any source rows.
  parseCommandCenterMonitorSnapshot({ ...header, rows: [] });
  const rows = copyRows(input.rows, limits);
  const prefix = `${JSON.stringify(header).slice(0, -1)},"rows":[`;
  const prefixBytes = commandCenterUtf8Bytes(prefix);
  const pages: SnapshotPage[] = [];
  const generation: SnapshotGeneration = {
    scopeKey, expiresAt: now + limits.maxAgeMs, rows: rows.length,
    bytes: commandCenterUtf8Bytes(JSON.stringify(scopeKey)), pages,
  };
  let offset = 0;
  let pageToken: string | undefined;
  do {
    let count = Math.min(limits.pageRows, rows.length - offset);
    let rowBytes = rows.slice(offset, offset + count).reduce((sum, row) => sum + row.bytes, 0);
    let nextToken: string | undefined;
    let suffix: string;
    let pageBytes: number;
    for (;;) {
      const hasMore = offset + count < rows.length;
      if (hasMore && nextToken === undefined) {
        // Every continuation adds one retained token. No retry loops on collisions.
        if (pages.length >= limits.maxTokens) throw new MonitorSnapshotCaptureError("token_limit");
        nextToken = input.nextToken();
      }
      suffix = hasMore ? `],"nextPage":${JSON.stringify(nextToken)}}` : "]}";
      pageBytes = prefixBytes + rowBytes + Math.max(0, count - 1) + commandCenterUtf8Bytes(suffix);
      if (pageBytes <= limits.pageBytes) break;
      if (count <= 1) throw new MonitorSnapshotCaptureError("page_limit");
      count -= 1;
      rowBytes -= rows[offset + count].bytes;
    }
    const json = prefix + rows.slice(offset, offset + count).map((row) => row.json).join(",") + suffix;
    // C1 remains the boundary validator for the exact page including its token.
    parseCommandCenterMonitorSnapshot(JSON.parse(json));
    generation.bytes += pageBytes + (pageToken === undefined ? 0 : commandCenterUtf8Bytes(pageToken));
    if (generation.bytes > limits.maxBytes) throw new MonitorSnapshotCaptureError("byte_limit");
    pages.push({ json, ...(pageToken === undefined ? {} : { token: pageToken }) });
    pageToken = nextToken;
    offset += count;
  } while (offset < rows.length);
  return generation;
}
