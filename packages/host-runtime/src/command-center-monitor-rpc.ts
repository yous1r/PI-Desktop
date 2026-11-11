import { createHash, randomUUID } from "node:crypto";
import {
  MonitorSnapshotCaptureError,
  MonitorSnapshotStore,
  RacpError,
  type Clock,
  type CommandCenterAccess,
  type CommandCenterBinding,
  type HostRpcPort,
  type Principal,
} from "@pi-desktop/agent-host";
import {
  parseCommandCenterMonitorSnapshot,
  parseCommandCenterTaskSummary,
  type CommandCenterMonitorSnapshot,
  type CommandCenterTaskSummary,
} from "@pi-desktop/shared";

/**
 * Production monitor-page port over the private Rust `commandCenter.monitor.cut`
 * RPC.
 *
 * The Rust cut is trusted only inside this Node process: every row is
 * authorized for its workspace and owning session before it can enter the
 * snapshot store. External RACP callers still pass through the existing
 * dispatcher schema/response validation.
 *
 * Continuation tokens are opaque and bound to the exact authenticated
 * observation scope: principal subject, connection id, roles, Host id/epoch and
 * the permission scope of every authorized row. A revoked permission, replaced
 * connection, role change or Host epoch change invalidates the page instead of
 * reusing it. Rows are never synthesized and no transcript is read.
 */

/** Stricter than the C1 256 KiB page ceiling: one monitor page stays ≤64 KiB. */
export const COMMAND_CENTER_MONITOR_PAGE_BYTES = 64 * 1024;
/** One page never exceeds the shared C1 page-row ceiling. */
export const COMMAND_CENTER_MONITOR_PAGE_ROWS = 100;
const DEFAULT_PAGE_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 16;
const DEFAULT_MAX_ENTRIES_PER_PRINCIPAL = 4;
const MAX_CUT_ROWS = 100;
const MONITOR_CUT_METHOD = "commandCenter.monitor.cut";

/** Same wire shape as the RACP monitor page request. */
export type CommandCenterMonitorRpcPageRequest = Readonly<{
  version: 1;
  hostId: string;
  token?: string;
}>;

/** Same context the command-center dispatcher supplies to the page port. */
export type CommandCenterMonitorRpcPageContext = Readonly<{ principal: Principal }>;

export type CommandCenterMonitorRpcPort = {
  page(
    request: CommandCenterMonitorRpcPageRequest,
    context: CommandCenterMonitorRpcPageContext,
  ): Promise<CommandCenterMonitorSnapshot>;
  /** Drop every retained cut, page token and snapshot generation. */
  dispose(): void;
};

export type CommandCenterMonitorRpcPortOptions = {
  /** Private Rust host-core stdio transport. */
  transport: HostRpcPort;
  /** Current Host installation identity; re-read before and after every await. */
  hostIdentity: () => CommandCenterBinding;
  /** Existing per-principal workspace/session read policy. Never inferred here. */
  authorize: (principal: Principal, access: CommandCenterAccess) => Promise<boolean>;
  clock: Clock;
  /** Page token entropy; defaults to randomUUID. */
  tokens?: { next(): string };
  /** Page and snapshot lifetime in milliseconds (≤60s store ceiling). */
  pageTtlMs?: number;
  pageRows?: number;
  maxEntries?: number;
  maxEntriesPerPrincipal?: number;
};

type AuthorizedScope = Readonly<{ kind: "workspace" | "session"; id: string }>;

type CutEntry = {
  readonly store: MonitorSnapshotStore;
  readonly scopeKey: string;
  readonly epoch: string;
  readonly sequence: number;
  readonly hostId: string;
  readonly hostEpoch: string;
  readonly subject: string;
  readonly connectionId: string;
  readonly rolesKey: string;
  readonly scopes: readonly AuthorizedScope[];
  readonly tokens: Set<string>;
  readonly expiresAt: number;
  touchedAt: number;
};

type RustCut = {
  version: 1;
  cursor: { epoch: string; sequence: number };
  generatedAt: string;
  rows: CommandCenterTaskSummary[];
};

function invalid(message: string): never {
  throw new RacpError("INVALID_ARGUMENT", message);
}

function internal(message: string): never {
  throw new RacpError("INTERNAL", message);
}

function conflict(message: string): never {
  throw new RacpError("CONFLICT", message, { retriable: false });
}

function forbidden(message: string): never {
  throw new RacpError("FORBIDDEN", message);
}

function notFound(message: string): never {
  throw new RacpError("NOT_FOUND", message, { retriable: false });
}

function validBinding(binding: CommandCenterBinding | null | undefined): binding is CommandCenterBinding {
  return !!binding && typeof binding.hostId === "string" && binding.hostId.length > 0 &&
    typeof binding.hostEpoch === "string" && binding.hostEpoch.length > 0;
}

function rolesKey(principal: Principal): string {
  return [...principal.roles].sort().join(",");
}

function connectionKey(principal: Principal): string {
  return typeof principal.connectionId === "string" && principal.connectionId.length > 0
    ? principal.connectionId
    : "connection:unknown";
}

function scopeKeyOf(
  binding: CommandCenterBinding,
  principal: Principal,
  scopes: readonly AuthorizedScope[],
): string {
  const canonical = JSON.stringify({
    hostId: binding.hostId,
    hostEpoch: binding.hostEpoch,
    subject: principal.subject,
    connectionId: connectionKey(principal),
    roles: [...principal.roles].sort(),
    scopes: scopes.map((scope) => `${scope.kind}:${scope.id}`).sort(),
  });
  return `command-center-rpc:${createHash("sha256").update(canonical).digest("hex")}`;
}

function parseCut(value: unknown): RustCut {
  if (value === null || typeof value !== "object" || Array.isArray(value)) internal("command-center monitor cut is invalid");
  const input = value as Record<string, unknown>;
  const cursor = input.cursor;
  if (input.version !== 1 || cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
    internal("command-center monitor cut is invalid");
  }
  const header = cursor as Record<string, unknown>;
  if (typeof header.epoch !== "string" || header.epoch.length === 0 || header.epoch.length > 256 || header.epoch.includes("\0")) {
    internal("command-center monitor cut is invalid");
  }
  if (!Number.isSafeInteger(header.sequence) || (header.sequence as number) < 0) {
    internal("command-center monitor cut is invalid");
  }
  if (!Array.isArray(input.rows) || input.rows.length > MAX_CUT_ROWS) {
    internal("command-center monitor cut is invalid");
  }
  let rows: CommandCenterTaskSummary[];
  try {
    rows = input.rows.map((row) => parseCommandCenterTaskSummary(structuredClone(row)));
  } catch {
    internal("command-center monitor cut is invalid");
  }
  // Reuse the shared page validation for cursor/rows/byte and duplicate checks.
  let page: CommandCenterMonitorSnapshot;
  try {
    page = parseCommandCenterMonitorSnapshot({
      version: 1, cursor: { epoch: header.epoch, sequence: header.sequence },
      generatedAt: input.generatedAt, rows,
    });
  } catch {
    internal("command-center monitor cut is invalid");
  }
  return {
    version: 1,
    cursor: page.cursor,
    generatedAt: page.generatedAt,
    rows: page.rows,
  };
}

function pageLimit(): never {
  throw new RacpError("RESOURCE_EXHAUSTED", "command-center monitor page exceeds the budget");
}

export function createCommandCenterMonitorRpcPort(
  options: CommandCenterMonitorRpcPortOptions,
): CommandCenterMonitorRpcPort {
  if (!options || typeof options.transport?.call !== "function" ||
      typeof options.hostIdentity !== "function" || typeof options.authorize !== "function" ||
      typeof options.clock?.now !== "function") {
    throw new TypeError("COMMAND_CENTER_MONITOR_RPC_INVALID_OPTIONS");
  }
  const pageRows = options.pageRows ?? COMMAND_CENTER_MONITOR_PAGE_ROWS;
  const pageTtlMs = options.pageTtlMs ?? DEFAULT_PAGE_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxEntriesPerPrincipal = options.maxEntriesPerPrincipal ?? DEFAULT_MAX_ENTRIES_PER_PRINCIPAL;
  if (!Number.isSafeInteger(pageRows) || pageRows < 1 || pageRows > COMMAND_CENTER_MONITOR_PAGE_ROWS) {
    throw new RangeError("COMMAND_CENTER_MONITOR_RPC_INVALID_PAGE_ROWS");
  }
  if (!Number.isSafeInteger(pageTtlMs) || pageTtlMs < 1 || pageTtlMs > 60_000) {
    throw new RangeError("COMMAND_CENTER_MONITOR_RPC_INVALID_TTL");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 128 ||
      !Number.isSafeInteger(maxEntriesPerPrincipal) || maxEntriesPerPrincipal < 1 || maxEntriesPerPrincipal > 32) {
    throw new RangeError("COMMAND_CENTER_MONITOR_RPC_INVALID_CACHE");
  }
  const tokens = options.tokens ?? { next: () => randomUUID() };
  const entries = new Set<CutEntry>();
  const byToken = new Map<string, CutEntry>();
  let disposed = false;

  const now = (): number => {
    const value = options.clock.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new RacpError("INTERNAL", "invalid monitor clock");
    return value;
  };

  const assertOwner = (binding: CommandCenterBinding): void => {
    const current = options.hostIdentity();
    if (!validBinding(current) || current.hostId !== binding.hostId || current.hostEpoch !== binding.hostEpoch) {
      conflict("command-center monitor owner changed");
    }
  };

  const evict = (entry: CutEntry): void => {
    entries.delete(entry);
    for (const token of entry.tokens) if (byToken.get(token) === entry) byToken.delete(token);
    entry.tokens.clear();
    entry.store.dispose();
  };

  const evictExpired = (at: number): void => {
    for (const entry of [...entries]) if (at >= entry.expiresAt) evict(entry);
  };

  const evictForCapacity = (subject: string): void => {
    let samePrincipal = 0;
    for (const entry of entries) if (entry.subject === subject) samePrincipal += 1;
    while (samePrincipal >= maxEntriesPerPrincipal) {
      const oldest = [...entries].filter((entry) => entry.subject === subject).sort((a, b) => a.touchedAt - b.touchedAt)[0];
      if (!oldest) break;
      evict(oldest);
      samePrincipal -= 1;
    }
    while (entries.size >= maxEntries) {
      const oldest = [...entries].sort((a, b) => a.touchedAt - b.touchedAt)[0];
      if (!oldest) break;
      evict(oldest);
    }
  };

  const authorizeRow = async (
    principal: Principal,
    row: CommandCenterTaskSummary,
    binding: CommandCenterBinding,
    scopes: Map<string, AuthorizedScope>,
  ): Promise<boolean> => {
    const sessionId = row.target.kind === "session" ? row.target.sessionId : row.target.parentSessionId;
    const checks: CommandCenterAccess[] = [
      { kind: "workspace", id: row.commandWorkspaceId, permission: "read" },
      { kind: "session", id: sessionId, permission: "read" },
    ];
    for (const access of checks) {
      let allowed: boolean;
      try {
        allowed = await options.authorize(principal, access);
      } catch {
        internal("command-center monitor authorization failed");
      }
      assertOwner(binding);
      if (allowed !== true) return false;
      scopes.set(`${access.kind}:${access.id}`, { kind: access.kind, id: access.id });
    }
    return true;
  };

  const reauthorize = async (
    principal: Principal,
    entry: CutEntry,
    binding: CommandCenterBinding,
  ): Promise<void> => {
    for (const scope of entry.scopes) {
      let allowed: boolean;
      try {
        allowed = await options.authorize(principal, { kind: scope.kind, id: scope.id, permission: "read" });
      } catch {
        internal("command-center monitor authorization failed");
      }
      assertOwner(binding);
      if (allowed !== true) {
        evict(entry);
        forbidden("command-center monitor access was revoked");
      }
    }
  };

  const firstPage = async (
    request: CommandCenterMonitorRpcPageRequest,
    principal: Principal,
  ): Promise<CommandCenterMonitorSnapshot> => {
    const binding = options.hostIdentity();
    if (!validBinding(binding)) conflict("command-center monitor owner is unavailable");
    if (request.hostId !== binding.hostId) conflict("command-center monitor owner changed");
    let cut: RustCut;
    try {
      cut = parseCut(await options.transport.call<unknown>(MONITOR_CUT_METHOD, {
        binding: { hostId: binding.hostId, hostEpoch: binding.hostEpoch },
        auth: {
          subject: principal.subject,
          roles: [...principal.roles],
          sessionIds: [],
          workspaceIds: [],
        },
        input: { version: 1, hostId: binding.hostId },
      }));
    } catch (error) {
      if (error instanceof RacpError) throw error;
      throw new RacpError("AGENT_UNAVAILABLE", "command-center monitor cut failed", { retriable: true });
    }
    assertOwner(binding);

    const scopes = new Map<string, AuthorizedScope>();
    const rows: CommandCenterTaskSummary[] = [];
    for (const row of cut.rows) {
      if (await authorizeRow(principal, row, binding, scopes)) rows.push(row);
    }
    assertOwner(binding);

    const authorizedScopes = [...scopes.values()].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    const scopeKey = scopeKeyOf(binding, principal, authorizedScopes);
    const store = new MonitorSnapshotStore({
      epoch: cut.cursor.epoch,
      clock: options.clock,
      tokens,
      limits: {
        pageRows, pageBytes: COMMAND_CENTER_MONITOR_PAGE_BYTES, maxAgeMs: pageTtlMs,
      },
    });
    let page: CommandCenterMonitorSnapshot;
    try {
      page = store.capture({ scopeKey, sequence: cut.cursor.sequence, rows });
    } catch (error) {
      store.dispose();
      if (error instanceof MonitorSnapshotCaptureError) {
        if (error.reason === "page_limit" || error.reason === "byte_limit") pageLimit();
        internal("command-center monitor cut could not be published");
      }
      throw error;
    }
    let entry: CutEntry;
    try {
      assertOwner(binding);
      const at = now();
      evictExpired(at);
      evictForCapacity(principal.subject);
      if (disposed) throw new RacpError("AGENT_UNAVAILABLE", "the command-center monitor port is disposed");
      entry = {
        store, scopeKey, epoch: cut.cursor.epoch, sequence: cut.cursor.sequence,
        hostId: binding.hostId, hostEpoch: binding.hostEpoch,
        subject: principal.subject, connectionId: connectionKey(principal),
        rolesKey: rolesKey(principal), scopes: authorizedScopes,
        tokens: new Set<string>(), expiresAt: at + pageTtlMs, touchedAt: at,
      };
    } catch (error) {
      store.dispose();
      throw error;
    }
    entries.add(entry);
    if (page.nextPage !== undefined) {
      entry.tokens.add(page.nextPage);
      byToken.set(page.nextPage, entry);
    }
    return page;
  };

  const continuation = async (
    request: CommandCenterMonitorRpcPageRequest,
    principal: Principal,
    token: string,
  ): Promise<CommandCenterMonitorSnapshot> => {
    const at = now();
    evictExpired(at);
    const entry = byToken.get(token);
    if (!entry) notFound("command-center monitor page is unknown or expired");
    if (disposed) throw new RacpError("AGENT_UNAVAILABLE", "the command-center monitor port is disposed");
    const binding = options.hostIdentity();
    if (!validBinding(binding) || binding.hostId !== entry.hostId || binding.hostEpoch !== entry.hostEpoch ||
        request.hostId !== entry.hostId) {
      evict(entry);
      conflict("command-center monitor owner changed");
    }
    if (principal.subject !== entry.subject || connectionKey(principal) !== entry.connectionId ||
        rolesKey(principal) !== entry.rolesKey) {
      forbidden("command-center monitor page belongs to another observation scope");
    }
    await reauthorize(principal, entry, binding);
    if (disposed) throw new RacpError("AGENT_UNAVAILABLE", "the command-center monitor port is disposed");
    assertOwner(binding);
    const result = entry.store.page({ scopeKey: entry.scopeKey, epoch: entry.epoch, token });
    if (result.status !== "page") {
      evict(entry);
      notFound("command-center monitor page is unknown or expired");
    }
    entry.tokens.delete(token);
    if (byToken.get(token) === entry) byToken.delete(token);
    if (result.snapshot.nextPage !== undefined) {
      entry.tokens.add(result.snapshot.nextPage);
      byToken.set(result.snapshot.nextPage, entry);
    }
    entry.touchedAt = now();
    return result.snapshot;
  };

  return {
    async page(request, context) {
      if (disposed) throw new RacpError("AGENT_UNAVAILABLE", "the command-center monitor port is disposed");
      if (request === null || typeof request !== "object" || request.version !== 1 ||
          typeof request.hostId !== "string" || request.hostId.length === 0 ||
          (request.token !== undefined && (typeof request.token !== "string" || request.token.length === 0 || request.token.length > 512))) {
        invalid("invalid command-center monitor page request");
      }
      const principal = context?.principal;
      if (!principal || typeof principal.subject !== "string" || principal.subject.length === 0 ||
          !Array.isArray(principal.roles)) {
        forbidden("command-center monitor requires an authenticated principal");
      }
      // Continuation tokens are connection-bound; an unbound principal could
      // replay a page from another authenticated connection, so fail closed.
      if (typeof principal.connectionId !== "string" || principal.connectionId.length === 0) {
        forbidden("command-center monitor requires a connection-bound principal");
      }
      return request.token === undefined
        ? firstPage(request, principal)
        : continuation(request, principal, request.token);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of [...entries]) evict(entry);
      byToken.clear();
    },
  };
}
