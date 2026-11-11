import {
  commandCenterCanonicalJson,
  commandCenterTaskKey,
  commandCenterUtf8Bytes,
  parseCommandCenterMonitorSnapshot,
  type CommandCenterMonitorSnapshot,
  type CommandCenterTaskSummary,
} from "@pi-desktop/shared";
import {
  COMMAND_CENTER_MONITOR_READER_LIMITS,
  type CommandCenterMonitorReadFailure,
  type CommandCenterMonitorReaderLimits,
} from "./types.js";

export function readerLimits(overrides: Partial<CommandCenterMonitorReaderLimits> = {}): Readonly<CommandCenterMonitorReaderLimits> {
  const limits = { ...COMMAND_CENTER_MONITOR_READER_LIMITS, ...overrides };
  for (const key of Object.keys(limits) as (keyof CommandCenterMonitorReaderLimits)[]) {
    if (!(key in COMMAND_CENTER_MONITOR_READER_LIMITS) || !Number.isSafeInteger(limits[key]) ||
        limits[key] <= 0 || limits[key] > COMMAND_CENTER_MONITOR_READER_LIMITS[key]) {
      throw new RangeError("COMMAND_CENTER_CLIENT_INVALID_MONITOR_LIMIT");
    }
  }
  return Object.freeze(limits);
}

/** Only validated, detached JSON reaches this helper. */
export function freezeProjection<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeProjection(child);
    Object.freeze(value);
  }
  return value;
}

export type DecodedPage = { page: CommandCenterMonitorSnapshot; bytes: number };

export function decodePage(input: unknown): DecodedPage {
  // Shared parsers return their input: copy and validate again before retaining.
  const encoded = commandCenterCanonicalJson(parseCommandCenterMonitorSnapshot(input));
  const page = parseCommandCenterMonitorSnapshot(JSON.parse(encoded));
  return { page, bytes: commandCenterUtf8Bytes(encoded) };
}

/** Per-refresh staging; dropped on every failure/cancellation and never published partially. */
export class PageCollection {
  readonly rows: CommandCenterTaskSummary[] = [];
  readonly #tasks = new Set<string>();
  readonly #tokens = new Set<string>();
  #first?: CommandCenterMonitorSnapshot;
  #pages = 0;
  #bytes = 0;

  constructor(readonly limits: Readonly<CommandCenterMonitorReaderLimits>) {}

  append({ page, bytes }: DecodedPage): CommandCenterMonitorReadFailure | undefined {
    if (this.#first && (page.cursor.epoch !== this.#first.cursor.epoch ||
        page.cursor.sequence !== this.#first.cursor.sequence || page.generatedAt !== this.#first.generatedAt)) {
      return "inconsistent_generation";
    }
    if (this.#pages + 1 > this.limits.maxPages || (page.nextPage !== undefined && this.#pages + 1 === this.limits.maxPages)) {
      return "page_limit";
    }
    if (this.rows.length + page.rows.length > this.limits.maxRows) return "row_limit";
    if (this.#bytes + bytes > this.limits.maxBytes) return "byte_limit";
    if (page.nextPage !== undefined && this.#tokens.has(page.nextPage)) return "token_cycle";
    for (const row of page.rows) {
      const key = commandCenterTaskKey(row.target);
      if (this.#tasks.has(key)) return "duplicate_task";
      this.#tasks.add(key);
    }
    if (page.nextPage !== undefined) this.#tokens.add(page.nextPage);
    this.#first ??= page;
    this.rows.push(...page.rows);
    this.#pages += 1;
    this.#bytes += bytes;
    return undefined;
  }

  complete() {
    if (!this.#first) throw new Error("COMMAND_CENTER_CLIENT_MONITOR_EMPTY_COLLECTION");
    return freezeProjection({ cursor: this.#first.cursor, generatedAt: this.#first.generatedAt, rows: this.rows });
  }
}
