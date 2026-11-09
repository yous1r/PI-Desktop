import type { McpOAuthOperation } from "./mcp-oauth-activity.ts";
import { authorizationMetadataUrls, parseBearerChallenge, selectOAuthScope } from "./mcp-oauth-discovery.ts";
import { assertTlsProtectedUrl, LOOPBACK_REDIRECT_PORTLESS, type McpOAuthLog, type McpOAuthMetadata } from "./mcp-oauth-protocol.ts";

/** OAuth discovery and client registration; fallback never changes the original owner. */
export class McpOAuthClient {
  private readonly log?: McpOAuthLog;
  constructor(log?: McpOAuthLog) { this.log = log; }
  async discoverMetadata(operation: McpOAuthOperation, serverUrl: string): Promise<McpOAuthMetadata> {
    operation.assertCurrent();
    const urlObj = new URL(serverUrl);
    let resourceMetadataUrl: string | undefined;
    let challengeScope: string | undefined;
    try {
      const challenge = await operation.request(serverUrl, {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "probe", method: "initialize", params: {
          protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "PI-Desktop", version: "1" },
        } }),
      }, async response => response.status === 401 ? parseBearerChallenge(response.headers.get("www-authenticate") ?? "") : undefined);
      resourceMetadataUrl = challenge?.resourceMetadataUrl;
      challengeScope = challenge?.scope;
    } catch { operation.assertCurrent(); }
    operation.assertCurrent();
    if (resourceMetadataUrl) assertTlsProtectedUrl(resourceMetadataUrl, "resource_metadata", serverUrl);
    const candidateUrls: string[] = [];
    if (resourceMetadataUrl) candidateUrls.push(resourceMetadataUrl);
    const pathSuffix = urlObj.pathname.replace(/\/+$/, "");
    if (pathSuffix && pathSuffix !== "/") candidateUrls.push(new URL(`/.well-known/oauth-protected-resource${pathSuffix}`, urlObj.origin).toString());
    candidateUrls.push(new URL("/.well-known/oauth-protected-resource", urlObj.origin).toString());
    const prm = await this.metadata(operation, candidateUrls);
    operation.assertCurrent();
    const authServersRaw = Array.isArray(prm?.authorization_servers) ? (prm.authorization_servers as string[]) : [];
    const authServer = authServersRaw[0] ?? urlObj.origin;
    assertTlsProtectedUrl(authServer, "authorization_server", serverUrl);
    const asMeta = await this.metadata(operation, authorizationMetadataUrls(new URL(authServer)));
    operation.assertCurrent();
    const authorizationEndpoint = typeof asMeta?.authorization_endpoint === "string" ? asMeta.authorization_endpoint : "";
    const tokenEndpoint = typeof asMeta?.token_endpoint === "string" ? asMeta.token_endpoint : "";
    if (!authorizationEndpoint || !tokenEndpoint) throw new Error(`MCP OAuth metadata discovery failed: authorization_endpoint or token_endpoint missing for ${serverUrl}`);
    assertTlsProtectedUrl(authorizationEndpoint, "authorization_endpoint", serverUrl);
    assertTlsProtectedUrl(tokenEndpoint, "token_endpoint", serverUrl);
    const registrationEndpoint = typeof asMeta?.registration_endpoint === "string" ? asMeta.registration_endpoint : undefined;
    if (registrationEndpoint) assertTlsProtectedUrl(registrationEndpoint, "registration_endpoint", serverUrl);
    return { resource: typeof prm?.resource === "string" ? prm.resource : serverUrl,
      authorizationServers: authServersRaw.length > 0 ? authServersRaw : [authServer],
      authorizationEndpoint, tokenEndpoint, registrationEndpoint, scope: selectOAuthScope(challengeScope, prm?.scopes_supported) };
  }
  private async metadata(operation: McpOAuthOperation, candidates: string[]): Promise<Record<string, unknown> | null> {
    for (const url of candidates) {
      try {
        const data = await operation.request(url, { redirect: "manual" }, async response => response.ok ? await response.json() as Record<string, unknown> : null);
        operation.assertCurrent();
        if (data) return data;
      } catch { operation.assertCurrent(); }
    }
    return null;
  }
  async registerClient(operation: McpOAuthOperation, registrationEndpoint: string, redirectUris: string | string[], trustedUrl?: string, clientName = "PI-Desktop"): Promise<{ clientId: string; clientSecret?: string }> {
    operation.assertCurrent();
    assertTlsProtectedUrl(registrationEndpoint, "registration_endpoint", trustedUrl);
    const uris = Array.isArray(redirectUris) ? redirectUris : [redirectUris];
    const json = await operation.request(registrationEndpoint, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: clientName, redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
    }, async response => {
      if (!response.ok) {
        this.log?.("warn", "mcp oauth DCR failed", { status: response.status });
        throw new Error(`Dynamic client registration failed (HTTP ${response.status})`);
      }
      return await response.json() as Record<string, unknown>;
    });
    operation.assertCurrent();
    const clientId = typeof json.client_id === "string" ? json.client_id : "";
    if (!clientId) throw new Error("Dynamic client registration response missing client_id");
    return { clientId, clientSecret: typeof json.client_secret === "string" ? json.client_secret : undefined };
  }
  async registerLoopbackClient(operation: McpOAuthOperation, registrationEndpoint: string, exactRedirect: string, trustedUrl: string): Promise<{ clientId: string; clientSecret?: string; redirectUris: string[] }> {
    const portless = [LOOPBACK_REDIRECT_PORTLESS, exactRedirect];
    try {
      const registered = await this.registerClient(operation, registrationEndpoint, portless, trustedUrl);
      operation.assertCurrent();
      return { ...registered, redirectUris: portless };
    } catch (error) {
      operation.assertCurrent();
      this.log?.("info", "mcp oauth portless DCR rejected, registering exact redirect", { message: error instanceof Error ? error.message : String(error) });
      const registered = await this.registerClient(operation, registrationEndpoint, [exactRedirect], trustedUrl);
      operation.assertCurrent();
      return { ...registered, redirectUris: [exactRedirect] };
    }
  }
}
