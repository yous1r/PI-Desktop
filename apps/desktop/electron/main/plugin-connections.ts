import { randomUUID } from "node:crypto";
import type { PluginConnection, PluginConnectionInput, PluginConnectionRequest, PluginConnectionResponse } from "@pi-desktop/plugin-sdk";
import { connectionError, connectionHeaders, connectionRequestUrl, CONNECTION_MAX_BYTES, normalizeConnectionBase, validateConnectionCa, validateConnectionRoutes, validatePluginId } from "./plugin-connection-policy";
import { connectionTransport, readConnectionBody, type ConnectionTransport } from "./plugin-connection-transport";

type PrivateConnection = PluginConnection & { token?: string; caPem?: string };
type ConnectionFile = { version: 1; connections: PrivateConnection[] };
export type ConnectionSecretStore = { read(key: string): Promise<string | null>; write(key: string, value: string): Promise<void>; delete(key: string): Promise<void> };
export type PluginConnectionServiceOptions = {
  store: ConnectionSecretStore;
  transport?: ConnectionTransport;
  assertGranted(pluginId: string): void;
  audit?(entry: { pluginId: string; connectionId: string; ok: boolean; code?: string; status?: number }): void;
};
const secretRef = (id: string) => `secret:plugin-connections:${id}`;
const publicRecord = ({ token: _token, caPem: _ca, ...record }: PrivateConnection): PluginConnection => structuredClone(record);
const SAFE_ERROR_CODES = new Set(["HOST_BUSY", "INVALID_ARGUMENT", "LIMIT_EXCEEDED", "PERMISSION_DENIED", "NOT_FOUND", "CONNECTION_CHANGED", "PLUGIN_UNLOADED", "STORAGE_INVALID", "STORAGE_UNAVAILABLE", "REDIRECT_DISALLOWED", "CONFLICT", "RESPONSE_TOO_LARGE"]);
const safeError = (value: unknown): string | undefined => value instanceof Error && "code" in value &&
  typeof value.code === "string" && SAFE_ERROR_CODES.has(value.code) ? value.code : undefined;

/** Main-process connection owner. Store writes are serialized; HTTP never holds that lock. */
export class PluginConnectionService {
  private readonly options: PluginConnectionServiceOptions;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly active = new Map<string, { pluginId: string; connectionId: string; controller: AbortController }>();
  private readonly generations = new Map<string, number>();
  private readonly cancelled = new Map<string, number>();
  private storageOperations = 0;
  private uncontainedResources = 0;

  constructor(options: PluginConnectionServiceOptions) { this.options = options; }

  getHandoffActivity(): { operations: number; uncontainedResources: number } {
    return { operations: this.storageOperations + this.active.size, uncontainedResources: this.uncontainedResources };
  }

  private capture(pluginId: string): () => void {
    const generation = this.generations.get(pluginId) ?? 0;
    const assertCurrent = () => {
      this.options.assertGranted(pluginId);
      if (generation !== (this.generations.get(pluginId) ?? 0)) throw connectionError("PLUGIN_UNLOADED", "Plugin lifecycle changed");
    };
    assertCurrent();
    return assertCurrent;
  }

  private async serialized<T>(pluginId: string, action: () => Promise<T>): Promise<T> {
    validatePluginId(pluginId);
    this.storageOperations++;
    const previous = this.locks.get(pluginId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.locks.set(pluginId, next);
    try { return await next; } finally {
      this.storageOperations--;
      if (this.locks.get(pluginId) === next) this.locks.delete(pluginId);
    }
  }

  private async load(pluginId: string): Promise<ConnectionFile> {
    let raw: string | null;
    try { raw = await this.options.store.read(secretRef(pluginId)); }
    catch { throw connectionError("STORAGE_UNAVAILABLE", "Connection storage is unavailable"); }
    if (raw === null) return { version: 1, connections: [] };
    try {
      const file = JSON.parse(raw) as ConnectionFile;
      if (file.version !== 1 || !Array.isArray(file.connections) || file.connections.length > 32) throw new Error();
      for (const row of file.connections) {
        if (row.pluginId !== pluginId || !row.id || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new Error();
        normalizeConnectionBase(row.baseUrl, row.allowHttp === true);
        validateConnectionRoutes(row.routes);
        validateConnectionCa(row.caPem);
      }
      return file;
    } catch { throw connectionError("STORAGE_INVALID", "Connection storage needs recovery; it was not overwritten"); }
  }

  private async persist(pluginId: string, file: ConnectionFile): Promise<void> {
    try { await this.options.store.write(secretRef(pluginId), JSON.stringify(file)); }
    catch { throw connectionError("STORAGE_UNAVAILABLE", "Connection could not be saved"); }
  }

  async list(pluginId: string): Promise<PluginConnection[]> {
    const assertCurrent = this.capture(pluginId);
    return this.serialized(pluginId, async () => {
      assertCurrent();
      const file = await this.load(pluginId);
      assertCurrent();
      return file.connections.map(publicRecord);
    });
  }

  /** Native UI only. The plugin API has no configuration or secret operation. */
  async save(input: PluginConnectionInput): Promise<PluginConnection> {
    if (!input || typeof input !== "object") throw connectionError("INVALID_ARGUMENT", "Invalid connection input");
    const assertCurrent = this.capture(input.pluginId);
    return this.serialized(input.pluginId, async () => {
      assertCurrent();
      const file = await this.load(input.pluginId);
      const before = input.id ? file.connections.find(c => c.id === input.id) : undefined;
      if (input.id && !before) throw connectionError("NOT_FOUND", "Connection not found");
      if (before && input.expectedRevision !== undefined && before.revision !== input.expectedRevision) throw connectionError("CONFLICT", "Connection changed; reload before saving");
      if (!before && file.connections.length >= 32) throw connectionError("LIMIT_EXCEEDED", "Too many plugin connections");
      if (typeof input.label !== "string" || !input.label.trim() || input.label.length > 128 || typeof input.allowHttp !== "boolean") throw connectionError("INVALID_ARGUMENT", "Connection label or HTTP consent is invalid");
      const baseUrl = normalizeConnectionBase(input.baseUrl, input.allowHttp);
      if (before && before.baseUrl !== baseUrl && !input.token) throw connectionError("CREDENTIAL_REQUIRED", "Changing the endpoint requires credential re-entry");
      if (input.token !== undefined && (typeof input.token !== "string" || input.token.length > 4096 || /[\r\n\u0000]/.test(input.token))) throw connectionError("INVALID_ARGUMENT", "Invalid credential");
      const token = input.token === undefined ? before?.token : input.token || undefined;
      const caPem = input.caPem === undefined ? before?.caPem : validateConnectionCa(input.caPem);
      if (caPem && !baseUrl.startsWith("https:")) throw connectionError("INVALID_ARGUMENT", "A CA requires HTTPS");
      const record: PrivateConnection = {
        id: before?.id ?? randomUUID(), pluginId: input.pluginId, label: input.label.trim(), baseUrl,
        revision: (before?.revision ?? 0) + 1, hasCredential: Boolean(token), caConfigured: Boolean(caPem),
        allowHttp: input.allowHttp, routes: validateConnectionRoutes(input.routes), token, caPem,
      };
      assertCurrent();
      this.releaseConnection(input.pluginId, record.id);
      await this.persist(input.pluginId, { version: 1, connections: [...file.connections.filter(c => c.id !== record.id), record] });
      return publicRecord(record);
    });
  }

  async remove(pluginId: string, connectionId: string): Promise<void> {
    const assertCurrent = this.capture(pluginId);
    return this.serialized(pluginId, async () => {
      assertCurrent();
      const file = await this.load(pluginId);
      if (!file.connections.some(c => c.id === connectionId)) throw connectionError("NOT_FOUND", "Connection not found");
      assertCurrent();
      this.releaseConnection(pluginId, connectionId);
      await this.persist(pluginId, { version: 1, connections: file.connections.filter(c => c.id !== connectionId) });
    });
  }

  /** Native uninstall only: revoke authority even after the plugin has unloaded. */
  async uninstall(pluginId: string): Promise<void> {
    validatePluginId(pluginId);
    this.releasePlugin(pluginId);
    await this.serialized(pluginId, async () => {
      try { await this.options.store.delete(secretRef(pluginId)); }
      catch { throw connectionError("STORAGE_UNAVAILABLE", "Connection credentials could not be removed"); }
    });
  }

  cancel(pluginId: string, requestId: string): void {
    const key = JSON.stringify([pluginId, requestId]);
    this.active.get(key)?.controller.abort();
    const now = Date.now();
    for (const [id, time] of this.cancelled) if (now - time > 30000) this.cancelled.delete(id);
    if (this.cancelled.size < 1024) this.cancelled.set(key, now);
  }

  releasePlugin(pluginId: string): void {
    this.generations.set(pluginId, (this.generations.get(pluginId) ?? 0) + 1);
    for (const request of this.active.values()) if (request.pluginId === pluginId) request.controller.abort();
  }

  private releaseConnection(pluginId: string, connectionId: string): void {
    for (const request of this.active.values()) if (request.pluginId === pluginId && request.connectionId === connectionId) request.controller.abort();
  }

  async request(pluginId: string, input: PluginConnectionRequest, signal?: AbortSignal): Promise<PluginConnectionResponse> {
    validatePluginId(pluginId);
    this.options.assertGranted(pluginId);
    const generation = this.generations.get(pluginId) ?? 0;
    if (!input || typeof input !== "object" || typeof input.requestId !== "string" || !/^[\w.-]{1,128}$/.test(input.requestId) || !["GET", "POST"].includes(input.method)) throw connectionError("INVALID_ARGUMENT", "Invalid connection request");
    const now = Date.now();
    for (const [id, time] of this.cancelled) if (now - time > 30000) this.cancelled.delete(id);
    const key = JSON.stringify([pluginId, input.requestId]);
    if (this.active.has(key)) throw connectionError("CONFLICT", "Request ID is already active");
    if (this.active.size >= 128) throw connectionError("LIMIT_EXCEEDED", "Too many active connection requests");
    const controller = new AbortController();
    this.active.set(key, { pluginId, connectionId: input.connectionId, controller });
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted || this.cancelled.has(key)) controller.abort();
    const deadline = input.timeoutMs ?? 15000;
    if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 15000) {
      this.active.delete(key); signal?.removeEventListener("abort", abort);
      throw connectionError("INVALID_ARGUMENT", "Timeout must be 1 to 15000 ms");
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, deadline);
    try {
      const record = await this.serialized(pluginId, async () => (await this.load(pluginId)).connections.find(c => c.id === input.connectionId));
      controller.signal.throwIfAborted();
      this.options.assertGranted(pluginId);
      if (generation !== (this.generations.get(pluginId) ?? 0)) throw connectionError("PLUGIN_UNLOADED", "Plugin lifecycle changed");
      if (!record) throw connectionError("NOT_FOUND", "Connection not found");
      if (record.revision !== input.expectedRevision) throw connectionError("CONNECTION_CHANGED", "Connection changed; revalidate before sending");
      const url = connectionRequestUrl(record.baseUrl, input.path);
      const route = input.path.split("?")[0];
      if (!record.routes.some(r => r.path === route && r.methods.includes(input.method))) throw connectionError("PERMISSION_DENIED", "Connection route or method is not approved");
      const headers = connectionHeaders(input.headers);
      if (input.body !== undefined && (typeof input.body !== "string" || Buffer.byteLength(input.body) > CONNECTION_MAX_BYTES)) throw connectionError("LIMIT_EXCEEDED", "Connection request body is too large");
      if (input.method === "GET" && input.body !== undefined) throw connectionError("INVALID_ARGUMENT", "GET cannot have a body");
      if (record.token) headers.authorization = `Bearer ${record.token}`;
      this.uncontainedResources = Math.min(Number.MAX_SAFE_INTEGER, this.uncontainedResources + 1);
      const response = await (this.options.transport ?? connectionTransport)(url.href, {
        method: input.method, headers, body: input.body, redirect: "manual", signal: controller.signal,
      }, record.caPem);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw connectionError("REDIRECT_DISALLOWED", "Connection redirects are not allowed");
      }
      const body = await readConnectionBody(response);
      controller.signal.throwIfAborted();
      this.options.assertGranted(pluginId);
      if (generation !== (this.generations.get(pluginId) ?? 0)) throw connectionError("PLUGIN_UNLOADED", "Plugin lifecycle changed");
      const redact = (text: string) => record.token ? text.split(record.token).join("[redacted]") : text;
      const responseHeaders: Record<string, string> = {};
      for (const header of ["content-type", "mcp-session-id", "mcp-protocol-version", "retry-after"]) {
        const value = response.headers.get(header);
        if (value !== null && value.length <= 4096) responseHeaders[header] = redact(value);
      }
      this.options.audit?.({ pluginId, connectionId: record.id, ok: true, status: response.status });
      return { status: response.status, headers: responseHeaders, bodyText: redact(body), connectionRevision: record.revision };
    } catch (error) {
      const code = controller.signal.aborted ? (timedOut ? "TIMEOUT" : "ABORTED") : safeError(error) ?? "CONNECTION_FAILED";
      this.options.audit?.({ pluginId, connectionId: input.connectionId, ok: false, code });
      // Never forward transport errors that may contain URLs, headers or server text.
      throw connectionError(code, `Managed connection request failed (${code})`);
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", abort); this.active.delete(key);
    }
  }
}
