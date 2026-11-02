import type { AgentCapabilityMove, AgentCapabilityQuery, McpServerInput, McpServerRecord } from "@pi-desktop/shared";
import { validateMcpCertificate } from "./mcp-tls.ts";

export type McpSecurityHost = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };
export type McpSecurityDependencies = {
  getHost: () => McpSecurityHost | null;
  invalidate: (serverId: string) => void;
};
const REFERENCE = /^secret:mcp:bearer:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[\x21-\x7e]+$/;

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { errorCode: code });
}

/** Credentials are bound to an exact endpoint, not merely a mutable server id. */
export function mcpCredentialEndpoint(raw: string | undefined): string {
  let url: URL;
  try { url = new URL(raw ?? ""); } catch { throw failure("MCP_AUTH_INVALID", "A valid MCP endpoint is required."); }
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw failure("MCP_AUTH_INVALID", "Managed MCP credentials require HTTPS (or loopback HTTP), without URL credentials, query or fragment.");
  }
  return url.toString();
}

function tokenText(value: unknown): string {
  if (typeof value !== "string" || !TOKEN.test(value) || Buffer.byteLength(value) > 4096) {
    throw failure("MCP_AUTH_INVALID", "Enter one Bearer token of at most 4096 bytes, without whitespace.");
  }
  return value;
}

function credentialRef(record: McpServerRecord): string {
  if (!record.credentialRef || !REFERENCE.test(record.credentialRef)) {
    throw failure("MCP_AUTH_REQUIRED", "Configure a Bearer credential in the MCP settings.");
  }
  return record.credentialRef;
}

/** Native settings lifecycle. No plugin API, CLI argument or tool receives a token. */
export class McpSecurityService {
  private pending: Promise<void> = Promise.resolve();
  private deps: McpSecurityDependencies;

  constructor(deps: McpSecurityDependencies) { this.deps = deps; }

  private host(): McpSecurityHost {
    const host = this.deps.getHost();
    if (!host) throw failure("HOST_UNAVAILABLE", "Host is unavailable.");
    return host;
  }

  private current(host: McpSecurityHost): void {
    if (this.deps.getHost() !== host) throw failure("HOST_UNAVAILABLE", "Host changed during MCP configuration; try again.");
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async find(host: McpSecurityHost, id: string, query: Partial<AgentCapabilityQuery>): Promise<McpServerRecord | undefined> {
    const listed = await host.call<{ servers: McpServerRecord[] }>("mcp.list", query);
    this.current(host);
    return listed.servers.find((record) => record.id === id);
  }

  private async publicRecord(host: McpSecurityHost, record: McpServerRecord): Promise<McpServerRecord> {
    if (record.authType !== "bearer") return { ...record, hasBearerToken: false };
    const ref = credentialRef(record);
    const result = await host.call<{ has: boolean }>("secrets.has", { secretRef: ref });
    this.current(host);
    return { ...record, hasBearerToken: result.has === true };
  }

  async describe(records: McpServerRecord[]): Promise<McpServerRecord[]> {
    await this.pending;
    const host = this.host();
    return Promise.all(records.map((record) => this.publicRecord(host, record)));
  }

  upsert(input: McpServerInput): Promise<{ server: McpServerRecord }> {
    return this.serialize(async () => {
      const host = this.host();
      const query = { level: input.level ?? "global", ...(input.projectPath ? { projectPath: input.projectPath } : {}) } as Partial<AgentCapabilityQuery>;
      const before = await this.find(host, input.id, query);
      const { bearerToken, ...configuration } = input;
      const authType = input.transport === "http" ? (input.authType === undefined ? before?.authType : input.authType) : null;
      if (input.transport !== "http" && (input.authType || bearerToken !== undefined || input.caCertificate)) {
        throw failure("MCP_AUTH_INVALID", "Managed authentication and CA settings apply only to HTTP MCP.");
      }
      if (authType === "bearer") {
        const endpoint = mcpCredentialEndpoint(input.url ?? before?.url);
        if (Object.keys(input.headers ?? before?.headers ?? {}).some((name) => name.toLowerCase() === "authorization")) {
          throw failure("MCP_AUTH_INVALID", "Remove the Authorization header when using a managed Bearer credential.");
        }
        if (bearerToken !== undefined && bearerToken !== null) tokenText(bearerToken);
        if (before?.authType === "bearer" && bearerToken === undefined && mcpCredentialEndpoint(before.url) !== endpoint) {
          throw failure("MCP_AUTH_TARGET_CHANGED", "The MCP endpoint changed. Enter the credential again to authorize the new endpoint.");
        }
      } else if (bearerToken !== undefined && bearerToken !== null) {
        throw failure("MCP_AUTH_INVALID", "Select managed Bearer authentication before entering a token.");
      }
      const pem = input.transport === "http" ? (input.caCertificate === undefined ? before?.caCertificate : input.caCertificate) : undefined;
      if (pem) {
        if (!(input.url ?? before?.url)?.trim().toLowerCase().startsWith("https://")) throw failure("MCP_CA_INVALID", "A custom MCP CA requires HTTPS.");
        validateMcpCertificate(pem);
      }
      this.current(host);
      this.deps.invalidate(input.id);
      // bearerToken is removed before registry serialization or host RPC logging.
      const result = await host.call<{ server: McpServerRecord }>("mcp.upsert", { server: configuration });
      this.current(host);
      const record = result.server;
      if (record.authType === "bearer" && bearerToken !== undefined) {
        const ref = credentialRef(record);
        try {
          if (bearerToken === null) await host.call("secrets.delete", { secretRef: ref });
          else await host.call("secrets.set", { secretRef: ref, value: JSON.stringify({ version: 1, endpoint: mcpCredentialEndpoint(record.url), token: tokenText(bearerToken) }) });
        } catch {
          throw failure("MCP_AUTH_STORAGE_FAILED", "The MCP credential could not be saved. No connection was started; retry in settings.");
        }
      }
      this.current(host);
      if (before?.credentialRef && before.credentialRef !== record.credentialRef && REFERENCE.test(before.credentialRef)) {
        await host.call("secrets.delete", { secretRef: before.credentialRef });
      }
      this.deps.invalidate(input.id);
      return { server: await this.publicRecord(host, record) };
    });
  }

  remove(input: { id: string } & Partial<AgentCapabilityQuery>): Promise<unknown> {
    return this.serialize(async () => {
      const host = this.host();
      const before = await this.find(host, input.id, input);
      this.deps.invalidate(input.id);
      const result = await host.call<{ ok: boolean }>("mcp.remove", input);
      this.current(host);
      if (result.ok && before?.credentialRef && REFERENCE.test(before.credentialRef)) {
        if (await this.find(host, input.id, input)) throw failure("MCP_REMOVE_FAILED", "MCP configuration could not be removed; its credential was retained.");
        await host.call("secrets.delete", { secretRef: before.credentialRef });
      }
      return result;
    });
  }

  transfer(input: AgentCapabilityMove): Promise<{ server: McpServerRecord }> {
    return this.serialize(async () => {
      const host = this.host();
      this.deps.invalidate(input.id);
      const result = await host.call<{ server: McpServerRecord }>("mcp.transfer", input);
      this.current(host);
      // The registry moves its opaque reference unchanged, including on rename.
      this.deps.invalidate(result.server.id);
      return { server: await this.publicRecord(host, result.server) };
    });
  }

  /** Runtime-only read; a missing, corrupt or endpoint-mismatched credential fails closed. */
  async getBearerToken(record: McpServerRecord): Promise<string | null> {
    if (record.authType !== "bearer") return null;
    await this.pending;
    const host = this.host();
    const ref = credentialRef(record);
    let value: string | null;
    try {
      value = (await host.call<{ value: string | null }>("secrets.getForRuntime", { secretRef: ref })).value;
    } catch {
      throw failure("MCP_AUTH_REQUIRED", "The MCP credential could not be read. Configure it again in settings.");
    }
    this.current(host);
    if (!value) throw failure("MCP_AUTH_REQUIRED", "No Bearer credential is configured for this MCP server.");
    let stored: { version?: unknown; endpoint?: unknown; token?: unknown };
    try {
      if (Buffer.byteLength(value) > 16 * 1024) throw new Error();
      stored = JSON.parse(value);
    } catch {
      throw failure("MCP_AUTH_REQUIRED", "The stored MCP credential is invalid. Configure it again in settings.");
    }
    if (!stored || stored.version !== 1 || stored.endpoint !== mcpCredentialEndpoint(record.url)) {
      throw failure("MCP_AUTH_TARGET_CHANGED", "The stored credential does not authorize this endpoint. Enter it again in settings.");
    }
    return tokenText(stored.token);
  }
}
