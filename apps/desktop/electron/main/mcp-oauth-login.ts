import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpOAuthLoginEvent, McpServerRecord, McpServerStatus } from "@pi-desktop/shared";
import { oauthRetired, type McpOAuthActivity, type McpOAuthOperation } from "./mcp-oauth-activity.ts";
import type { McpOAuthClient } from "./mcp-oauth-client.ts";
import { McpOAuthLoopback } from "./mcp-oauth-loopback.ts";
import type { McpOAuthTokens } from "./mcp-oauth-tokens.ts";
import { McpOAuthError, canReuseDcrClient, loopbackRedirectUri, parseExpiresIn, preferredLoopbackPort, renderOAuthHtml, type McpOAuthMetadata, type StoredMcpOAuthToken } from "./mcp-oauth-protocol.ts";

type LoginEvent<T = McpOAuthLoginEvent> = T extends McpOAuthLoginEvent ? Omit<T, "loginId" | "serverId"> : never;

export type McpOAuthLoginDeps = {
  openExternal: (url: string) => Promise<void>;
  createServer?: typeof createServer;
  emit?: (event: McpOAuthLoginEvent) => void;
  onAuthorized?: (serverId: string, record: McpServerRecord | undefined, assertCurrent: () => void) => Promise<McpServerStatus>;
};
export class McpOAuthLogin {
  readonly loginId: string;
  readonly serverId: string;
  readonly operation: McpOAuthOperation;
  readonly token = Promise.withResolvers<StoredMcpOAuthToken>();
  finished: Promise<void> = Promise.resolve();
  private readonly completion = Promise.withResolvers<StoredMcpOAuthToken>();
  private readonly deps: McpOAuthLoginDeps;
  private readonly activity: McpOAuthActivity;
  private readonly client: McpOAuthClient;
  private readonly tokens: McpOAuthTokens;
  private readonly serverUrl: string;
  private readonly record?: McpServerRecord;
  private readonly onRetired: () => void;
  private loopback?: McpOAuthLoopback;
  private timer?: ReturnType<typeof setTimeout>;
  private timeoutError?: Error;
  private consumed = false;
  private settled = false;
  private retired = false;
  private cancelled = false;
  private metadata?: McpOAuthMetadata;
  private clientId = "";
  private clientSecret?: string;
  private redirectUri = "";
  private redirectUris?: string[];
  private readonly verifier = randomBytes(32).toString("base64url");
  private readonly state = randomBytes(16).toString("hex");
  constructor(input: { loginId: string; serverId: string; serverUrl: string; record?: McpServerRecord;
    operation: McpOAuthOperation; activity: McpOAuthActivity; client: McpOAuthClient; tokens: McpOAuthTokens;
    deps: McpOAuthLoginDeps; onRetired: () => void }) {
    this.loginId = input.loginId; this.serverId = input.serverId; this.serverUrl = input.serverUrl; this.record = input.record;
    this.operation = input.operation; this.activity = input.activity; this.client = input.client; this.tokens = input.tokens;
    this.deps = input.deps; this.onRetired = input.onRetired;
    void this.token.promise.catch(() => {}); void this.completion.promise.catch(() => {});
  }
  assertCurrent = (): void => { this.operation.assertCurrent(); if (this.retired) throw oauthRetired(); };
  start(): void {
    const aborted = () => this.fail(oauthRetired());
    this.operation.controller.signal.addEventListener("abort", aborted, { once: true });
    this.finished = this.operation.track(async () => {
      try {
        this.assertCurrent();
        this.emit({ kind: "progress", message: "Discovering metadata…" });
        void this.operation.track(async () => { try { await this.setup(); } catch (error) { this.fail(error); } });
        await this.completion.promise;
        this.assertCurrent();
        let status: McpServerStatus | undefined;
        if (this.deps.onAuthorized) {
          try { status = await this.deps.onAuthorized(this.serverId, this.record, this.assertCurrent); }
          catch { this.assertCurrent(); }
        }
        this.assertCurrent();
        this.emit({ kind: "done", status: status ? { ...status, hasOauth: true } : {
          serverId: this.serverId, state: "ready", toolCount: 0, updatedAt: Date.now(), hasOauth: true, authRequired: false,
        } });
      } catch (error) {
        this.token.reject(error);
        if (this.operation.controller.signal.aborted && error !== this.timeoutError) this.notifyCancelled();
        else {
          const message = error instanceof Error ? error.message : String(error);
          this.emit({ kind: "error", message, ...(error instanceof McpOAuthError ? { errorCode: error.errorCode } : {}) });
        }
      } finally {
        this.retired = true;
        this.operation.controller.signal.removeEventListener("abort", aborted);
        if (this.timer) clearTimeout(this.timer);
        this.onRetired();
        this.operation.cancel();
        await this.loopback?.close();
      }
    });
  }
  cancel(): void {
    this.operation.cancel();
    this.fail(oauthRetired());
    this.notifyCancelled();
    if (this.timer) clearTimeout(this.timer);
    void this.loopback?.close();
  }
  private fail(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    this.token.reject(error); this.completion.reject(error);
  }
  private notifyCancelled(): void {
    if (this.cancelled) return;
    this.cancelled = true; this.emit({ kind: "cancelled" });
  }
  private emit(event: LoginEvent): void {
    try { this.deps.emit?.({ ...event, loginId: this.loginId, serverId: this.serverId }); }
    catch { this.activity.report("MCP OAuth event observer failed"); }
  }
  private async setup(): Promise<void> {
    this.metadata = await this.client.discoverMetadata(this.operation, this.serverUrl);
    this.assertCurrent();
    this.loopback = new McpOAuthLoopback(this.activity, this.operation, this.deps.createServer ?? createServer,
      (request, response) => this.callback(request, response), error => this.fail(error));
    this.timer = setTimeout(() => {
      this.timeoutError = new Error("OAuth authorization timed out");
      this.fail(this.timeoutError); this.operation.cancel();
    }, 5 * 60 * 1000);
    const existing = await this.tokens.readStoredToken(this.operation, this.serverId);
    this.assertCurrent();
    const address = await this.loopback.listen(preferredLoopbackPort(existing?.redirectUris));
    this.assertCurrent();
    this.redirectUri = loopbackRedirectUri(address.port);
    if (canReuseDcrClient(existing, this.metadata.registrationEndpoint, this.redirectUri) && existing) {
      this.clientId = existing.clientId; this.clientSecret = existing.clientSecret; this.redirectUris = existing.redirectUris;
    } else if (this.metadata.registrationEndpoint) {
      const registered = await this.client.registerLoopbackClient(this.operation, this.metadata.registrationEndpoint, this.redirectUri, this.serverUrl);
      this.assertCurrent();
      this.clientId = registered.clientId; this.clientSecret = registered.clientSecret; this.redirectUris = registered.redirectUris;
    } else throw new McpOAuthError("MCP_OAUTH_DCR_UNAVAILABLE", `MCP server "${this.serverId}" has no registered client id and does not support Dynamic Client Registration.`);
    const url = new URL(this.metadata.authorizationEndpoint);
    for (const [key, value] of Object.entries({ response_type: "code", client_id: this.clientId, redirect_uri: this.redirectUri,
      state: this.state, code_challenge: createHash("sha256").update(this.verifier).digest("base64url"),
      code_challenge_method: "S256", resource: this.metadata.resource })) url.searchParams.set(key, value);
    if (this.metadata.scope) url.searchParams.set("scope", this.metadata.scope); else url.searchParams.delete("scope");
    this.assertCurrent(); this.operation.nativeAttempt();
    const opened = await this.deps.openExternal(url.toString()).then(() => true, () => false);
    this.assertCurrent();
    this.emit({ kind: "authUrl", url: url.toString(), opened });
  }
  private async callback(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, message: string, ok = false) => {
      if (response.destroyed || response.writableEnded) return;
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" }); response.end(renderOAuthHtml(ok, message));
    };
    try {
      this.assertCurrent();
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") { response.writeHead(404, { "content-type": "text/plain" }); response.end("Not Found"); return; }
      if (this.consumed || this.settled) { reply(409, "Authorization already completed"); return; }
      if (!this.redirectUri || !this.clientId || !this.metadata) { reply(503, "Authorization is not ready"); return; }
      if (url.searchParams.get("state") !== this.state) { reply(400, "Invalid OAuth callback state"); return; }
      // A valid callback consumes the code, but exchange/storage can still fail or be cancelled.
      this.consumed = true;
      const authError = url.searchParams.get("error"), description = url.searchParams.get("error_description");
      if (authError) {
        const message = description ? `${authError}: ${description}` : authError;
        reply(400, `Authorization error: ${message}`); this.fail(new Error(`OAuth authorization error: ${message}`)); return;
      }
      const code = url.searchParams.get("code");
      if (!code) { reply(400, "Invalid OAuth callback: missing code"); this.fail(new Error("Invalid OAuth callback: missing code")); return; }
      const params = new URLSearchParams({ grant_type: "authorization_code", client_id: this.clientId, code,
        redirect_uri: this.redirectUri, code_verifier: this.verifier, resource: this.metadata.resource });
      if (this.clientSecret) params.set("client_secret", this.clientSecret);
      const result = await this.operation.request(this.metadata.tokenEndpoint, {
        method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: params.toString(),
      }, async res => ({ ok: res.ok, status: res.status, json: res.ok ? await res.json() as Record<string, unknown> : null }));
      this.assertCurrent();
      if (!result.ok) { reply(500, `Token exchange failed (${result.status})`); this.fail(new Error(`OAuth token exchange failed (HTTP ${result.status})`)); return; }
      const json = result.json ?? {}, accessToken = typeof json.access_token === "string" ? json.access_token : "";
      if (!accessToken) { reply(500, "Token response missing access_token"); this.fail(new Error("Token response missing access_token")); return; }
      const expiresIn = parseExpiresIn(json.expires_in);
      const stored: StoredMcpOAuthToken = { clientId: this.clientId, clientSecret: this.clientSecret,
        registrationEndpoint: this.metadata.registrationEndpoint, tokenEndpoint: this.metadata.tokenEndpoint, accessToken,
        refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
        expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined, scope: typeof json.scope === "string" ? json.scope : undefined,
        resource: this.metadata.resource, redirectUris: this.redirectUris };
      await this.tokens.store(this.operation, this.serverId, stored);
      this.assertCurrent();
      reply(200, "Authorization successful! You can close this tab and return to PI-Desktop.", true);
      this.settled = true; this.token.resolve(stored); this.completion.resolve(stored);
    } catch (error) {
      try { reply(500, "Authorization could not be completed"); }
      finally { this.fail(error); }
    }
  }
}
