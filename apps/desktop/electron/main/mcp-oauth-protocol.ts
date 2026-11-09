import { isUserSuppliedHostname, type McpOAuthLoginErrorCode } from "@pi-desktop/shared";
import { allowInsecureUserEndpointsEnabled } from "./endpoint-policy.ts";

export type StoredMcpOAuthToken = {
  clientId: string;
  clientSecret?: string;
  registrationEndpoint?: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  resource?: string;
  redirectUris?: string[];
};
export type McpOAuthMetadata = {
  resource: string;
  authorizationServers: string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scope?: string;
};
export type McpOAuthCall = <T = unknown>(method: string, params?: unknown) => Promise<T>;
export type McpOAuthLog = (level: "info" | "warn" | "error", message: string, data?: unknown) => void;

export class McpOAuthError extends Error {
  readonly errorCode: McpOAuthLoginErrorCode;
  constructor(errorCode: McpOAuthLoginErrorCode, message: string) {
    super(message);
    this.errorCode = errorCode;
  }
}
export function secretRefForMcpOAuth(serverId: string): string {
  return `secret:mcp:${serverId}:oauth`;
}
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
export function parseExpiresIn(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
  if (typeof val === "string") {
    const parsed = Number.parseInt(val, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}
/** RFC 8252 loopback redirect without a port, so the AS may accept any ephemeral port. */
export const LOOPBACK_REDIRECT_PORTLESS = "http://127.0.0.1/callback";
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}
/** Metadata endpoints require TLS except loopback or the explicitly trusted user host. */
export function assertTlsProtectedUrl(raw: string, label: string, trustedUrl?: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} is not a valid URL`); }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:") {
    if (isLoopbackHostname(url.hostname)) return url;
    if (allowInsecureUserEndpointsEnabled() && trustedUrl !== undefined &&
      isUserSuppliedHostname(url.hostname) && sameHostname(trustedUrl, url.hostname)) return url;
    throw new Error(`${label} must use HTTPS (got ${url.protocol}//${url.host}); use HTTPS or enable plaintext endpoints for hosts you entered yourself in settings`);
  }
  throw new Error(`${label} must use HTTPS (got ${url.protocol}//${url.host})`);
}
function sameHostname(left: string, right: string): boolean {
  const host = (value: string): string => {
    const bare = value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
    try { return new URL(value).hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, ""); }
    catch { return bare; }
  };
  const target = host(left);
  return target !== "" && target === host(right);
}
export function loopbackRedirectUri(port: number): string { return `http://127.0.0.1:${port}/callback`; }
export function canReuseDcrClient(token: StoredMcpOAuthToken | null | undefined, registrationEndpoint: string | undefined, exactRedirect: string): boolean {
  if (!token?.clientId || token.registrationEndpoint !== registrationEndpoint) return false;
  const uris = token.redirectUris ?? [];
  return uris.includes(LOOPBACK_REDIRECT_PORTLESS) || uris.includes(exactRedirect);
}
export function preferredLoopbackPort(uris: string[] | undefined): number | undefined {
  for (const uri of uris ?? []) {
    try {
      const url = new URL(uri);
      if (url.hostname !== "127.0.0.1" || !url.port) continue;
      const port = Number(url.port);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    } catch { continue; }
  }
  return undefined;
}
export function renderOAuthHtml(ok: boolean, message: string): string {
  const color = ok ? "#10b981" : "#ef4444";
  const title = escapeHtml(ok ? "✓ Authorization Successful" : "✕ Authorization Failed");
  const escapedMessage = escapeHtml(message);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #09090b;
    color: #f4f4f5;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    margin: 0;
  }
  .card {
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 16px;
    padding: 36px 32px;
    text-align: center;
    max-width: 420px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  }
  h1 {
    color: ${color};
    font-size: 22px;
    margin: 0 0 12px 0;
    font-weight: 600;
  }
  p {
    color: #a1a1aa;
    font-size: 14px;
    line-height: 1.6;
    margin: 0;
  }
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${escapedMessage}</p>
  </div>
</body>
</html>`;
}
