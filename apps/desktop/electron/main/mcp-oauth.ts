import { randomUUID } from "node:crypto";
import type { McpServerRecord } from "@pi-desktop/shared";
import { McpOAuthActivity, oauthRetired, type McpOAuthAuthority, type McpOAuthOperation } from "./mcp-oauth-activity.ts";
import { McpOAuthClient } from "./mcp-oauth-client.ts";
import { McpOAuthLogin, type McpOAuthLoginDeps } from "./mcp-oauth-login.ts";
import { McpOAuthTokens } from "./mcp-oauth-tokens.ts";
export { assertTlsProtectedUrl, canReuseDcrClient, escapeHtml, isLoopbackHostname, LOOPBACK_REDIRECT_PORTLESS, loopbackRedirectUri, parseExpiresIn, preferredLoopbackPort, secretRefForMcpOAuth, type McpOAuthMetadata, type StoredMcpOAuthToken } from "./mcp-oauth-protocol.ts";
export type { McpOAuthOwner } from "./mcp-oauth-activity.ts";
export type McpOAuthDeps = McpOAuthAuthority & McpOAuthLoginDeps & { newId?: () => string };

/** Desktop lifetime owner; a temporary admission hold never becomes a new Host binding. */
export class McpOAuthManager {
  private readonly deps: McpOAuthDeps;
  private readonly pendingLogins = new Map<string, McpOAuthLogin>();
  private readonly activity: McpOAuthActivity;
  private readonly client: McpOAuthClient;
  private readonly tokens: McpOAuthTokens;
  constructor(deps: McpOAuthDeps) {
    this.deps = deps; this.activity = new McpOAuthActivity(deps);
    this.client = new McpOAuthClient(deps.log); this.tokens = new McpOAuthTokens(deps.log);
  }
  getHandoffActivity() { return this.activity.snapshot(); }
  invalidate(serverId: string): void { this.retire([serverId]); }
  async discoverMetadata(serverUrl: string) {
    const operation = this.activity.capture();
    return operation.track(() => this.client.discoverMetadata(operation, serverUrl));
  }
  async registerClient(endpoint: string, redirectUris: string | string[], trustedUrl?: string, clientName?: string) {
    const operation = this.activity.capture();
    return operation.track(() => this.client.registerClient(operation, endpoint, redirectUris, trustedUrl, clientName));
  }
  /** Five-minute browser interaction proceeds independently of the caller's IPC wait. */
  async start(serverId: string, serverUrl: string, record?: McpServerRecord): Promise<{ ok: boolean; loginId: string }> {
    const session = this.begin(serverId, serverUrl, record);
    return { ok: true, loginId: session.loginId };
  }
  async startLogin(serverId: string, serverUrl: string) { return this.begin(serverId, serverUrl).token.promise; }
  private begin(serverId: string, serverUrl: string, record?: McpServerRecord): McpOAuthLogin {
    const operation = this.activity.capture([serverId]);
    this.retire([serverId]);
    if ([...this.pendingLogins.values()].some(item => item.serverId === serverId)) throw oauthRetired();
    operation.assertCurrent();
    const loginId = this.deps.newId?.() ?? randomUUID();
    if (this.pendingLogins.has(loginId)) throw new Error("Duplicate OAuth login ID");
    const session = new McpOAuthLogin({ loginId, serverId, serverUrl, record, operation, activity: this.activity,
      client: this.client, tokens: this.tokens, deps: this.deps,
      onRetired: () => { if (this.pendingLogins.get(loginId) === session) this.pendingLogins.delete(loginId); },
    });
    this.pendingLogins.set(loginId, session);
    session.start();
    return session;
  }
  async getValidAccessToken(serverId: string) {
    return this.tokens.getValidAccessToken(this.activity.capture([serverId]), serverId);
  }
  async hasOAuth(serverId: string) { return this.tokens.hasOAuth(this.activity.capture([serverId]), serverId); }
  async deleteOAuth(serverId: string): Promise<void> {
    const operation = this.captureMutation([serverId]);
    await this.tokens.deleteOAuth(operation, serverId);
  }
  async transferOAuth(oldServerId: string, newServerId: string): Promise<void> {
    const operation = this.activity.capture([oldServerId, newServerId], false);
    if (!oldServerId || !newServerId || oldServerId === newServerId) return;
    this.retire([oldServerId, newServerId]);
    await this.tokens.transferOAuth(operation, oldServerId, newServerId);
  }
  private captureMutation(keys: string[]): McpOAuthOperation {
    const operation = this.activity.capture(keys, false);
    this.retire(keys);
    return operation;
  }
  private retire(keys: string[]): void {
    const sessions = [...this.pendingLogins.values()].filter(item => keys.includes(item.serverId));
    this.activity.retire(keys);
    for (const session of sessions) {
      if (this.pendingLogins.get(session.loginId) === session) this.cancel(session.loginId);
    }
  }
  cancel(loginIdOrServerId: string): boolean {
    const session = this.pendingLogins.get(loginIdOrServerId) ?? [...this.pendingLogins.values()].find(item => item.serverId === loginIdOrServerId);
    if (!session) return false;
    // Remove only this authority before callbacks can reenter and create a replacement.
    this.pendingLogins.delete(session.loginId);
    session.cancel();
    return true;
  }
  disposeAll(): void {
    this.activity.dispose();
    for (const session of [...this.pendingLogins.values()]) this.cancel(session.loginId);
  }
}
