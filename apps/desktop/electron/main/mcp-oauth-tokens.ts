import type { McpOAuthOperation } from "./mcp-oauth-activity.ts";
import { assertTlsProtectedUrl, parseExpiresIn, readOAuthJson, secretRefForMcpOAuth, type McpOAuthLog, type StoredMcpOAuthToken } from "./mcp-oauth-protocol.ts";

/** One ordered lane per secret, shared by login writes, refresh, deletion and transfer. */
export class McpOAuthTokens {
  private readonly log?: McpOAuthLog;
  private readonly chains = new Map<string, Promise<void>>();
  constructor(log?: McpOAuthLog) { this.log = log; }
  getValidAccessToken(operation: McpOAuthOperation, serverId: string): Promise<string | null> {
    return this.serialize(operation, [serverId], async () => {
      const token = await this.read(operation, serverId);
      operation.assertCurrent();
      if (!token) return null;
      if (token.expiresAt && Date.now() > token.expiresAt - 60_000 && token.refreshToken) {
        try { return (await this.refresh(operation, serverId, token)).accessToken; }
        catch (error) {
          operation.assertCurrent();
          this.log?.("warn", "failed to refresh mcp oauth token", { serverId, error: (error as Error).message });
          const still = await this.read(operation, serverId);
          operation.assertCurrent();
          return still?.accessToken ?? null;
        }
      }
      return token.accessToken;
    });
  }
  hasOAuth(operation: McpOAuthOperation, serverId: string): Promise<boolean> {
    return this.serialize(operation, [serverId], async () => {
      try { return (await operation.call<{ has: boolean }>("secrets.has", { secretRef: secretRefForMcpOAuth(serverId) }))?.has === true; }
      catch { operation.assertCurrent(); return false; }
    });
  }
  deleteOAuth(operation: McpOAuthOperation, serverId: string): Promise<void> {
    return this.serialize(operation, [serverId], () => this.clear(operation, serverId));
  }
  transferOAuth(operation: McpOAuthOperation, oldServerId: string, newServerId: string): Promise<void> {
    return this.serialize(operation, [oldServerId, newServerId], async () => {
      if (!oldServerId || !newServerId || oldServerId === newServerId) return;
      const current = await this.read(operation, oldServerId);
      operation.assertCurrent();
      if (current) {
        await this.write(operation, newServerId, current);
        operation.assertCurrent();
        await operation.call("secrets.delete", { secretRef: secretRefForMcpOAuth(oldServerId) });
      }
    });
  }
  readStoredToken(operation: McpOAuthOperation, serverId: string): Promise<StoredMcpOAuthToken | null> {
    return this.serialize(operation, [serverId], () => this.read(operation, serverId));
  }
  store(operation: McpOAuthOperation, serverId: string, token: StoredMcpOAuthToken): Promise<void> {
    return this.serialize(operation, [serverId], () => this.write(operation, serverId, token));
  }
  private async read(operation: McpOAuthOperation, serverId: string): Promise<StoredMcpOAuthToken | null> {
    let raw: string | null = null;
    try { raw = (await operation.call<{ value: string | null }>("secrets.getForRuntime", { secretRef: secretRefForMcpOAuth(serverId) }))?.value ?? null; }
    catch { operation.assertCurrent(); return null; }
    operation.assertCurrent();
    if (!raw) return null;
    try { return JSON.parse(raw) as StoredMcpOAuthToken; } catch { return null; }
  }
  private async write(operation: McpOAuthOperation, serverId: string, token: StoredMcpOAuthToken): Promise<void> {
    await operation.call("secrets.set", { secretRef: secretRefForMcpOAuth(serverId), value: JSON.stringify(token) });
  }
  private async clear(operation: McpOAuthOperation, serverId: string): Promise<void> {
    try { await operation.call("secrets.delete", { secretRef: secretRefForMcpOAuth(serverId) }); }
    catch { operation.assertCurrent(); }
  }
  private async refresh(operation: McpOAuthOperation, serverId: string, token: StoredMcpOAuthToken): Promise<StoredMcpOAuthToken> {
    operation.assertCurrent();
    if (!token.refreshToken) throw new Error("Token refresh failed: missing refresh_token");
    assertTlsProtectedUrl(token.tokenEndpoint, "token_endpoint", token.resource);
    const params = new URLSearchParams({ grant_type: "refresh_token", client_id: token.clientId, refresh_token: token.refreshToken });
    if (token.clientSecret) params.set("client_secret", token.clientSecret);
    if (token.resource) params.set("resource", token.resource);
    const result = await operation.request(token.tokenEndpoint, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: params.toString(),
    }, async response => ({ ok: response.ok, status: response.status, json: response.ok ? await readOAuthJson(response) : null }));
    operation.assertCurrent();
    if (!result.ok) {
      this.log?.("warn", "mcp oauth token refresh failed", { serverId, status: result.status });
      if (result.status === 400 || result.status === 401) await this.clear(operation, serverId);
      throw new Error(`Token refresh failed (HTTP ${result.status})`);
    }
    const json = result.json ?? {};
    const accessToken = typeof json.access_token === "string" ? json.access_token : "";
    if (!accessToken) throw new Error("Refresh token response missing access_token");
    const expiresIn = parseExpiresIn(json.expires_in);
    const updated: StoredMcpOAuthToken = { ...token, accessToken,
      refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : token.refreshToken,
      expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
      scope: typeof json.scope === "string" ? json.scope : token.scope };
    await this.write(operation, serverId, updated);
    operation.assertCurrent();
    return updated;
  }
  private serialize<T>(operation: McpOAuthOperation, keys: string[], fn: () => Promise<T>): Promise<T> {
    // Install every touched lane together; crossed transfers cannot deadlock or borrow a later owner.
    const previous = keys.map(key => this.chains.get(key) ?? Promise.resolve());
    const next = operation.track(async () => {
      await Promise.all(previous);
      operation.assertCurrent();
      const result = await fn();
      operation.assertCurrent();
      return result;
    });
    const tail = next.then(() => undefined, () => undefined).then(() => {
      for (const key of keys) if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    for (const key of keys) this.chains.set(key, tail);
    return next;
  }
}
