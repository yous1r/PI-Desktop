import { X509Certificate } from "node:crypto";
import { isMetadataNetHost, type PluginConnection } from "@pi-desktop/plugin-sdk";

export const CONNECTION_MAX_BYTES = 1024 * 1024;
export const connectionError = (code: string, message: string) => Object.assign(new Error(message), { code });

export function validatePluginId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw connectionError("INVALID_ARGUMENT", "Invalid plugin identity");
  }
}

export function normalizeConnectionBase(value: unknown, allowHttp: boolean): string {
  if (typeof value !== "string" || value.length > 2048 || /[\\\u0000-\u0020]/.test(value)) {
    throw connectionError("INVALID_ARGUMENT", "Invalid connection URL");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw connectionError("INVALID_ARGUMENT", "Invalid connection URL"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw connectionError("INVALID_ARGUMENT", "Connection requires a plain HTTP(S) base URL without credentials or query");
  }
  if (isMetadataNetHost(url.hostname.replace(/^\[|\]$/g, ""))) {
    throw connectionError("PERMISSION_DENIED", "Cloud metadata endpoints are not allowed");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !loopback && !allowHttp) {
    throw connectionError("HTTP_CONSENT_REQUIRED", "Unencrypted remote HTTP requires explicit consent");
  }
  if (/%|(?:^|\/)\.\.?(?:\/|$)/.test(value.slice(value.indexOf("://") + 3))) {
    throw connectionError("INVALID_ARGUMENT", "Encoded or relative base paths are not supported");
  }
  return url.href.replace(/\/+$/, "");
}

/** Validate BEFORE URL normalization can erase traversal. Query values may be encoded. */
export function connectionRequestUrl(base: string, path: unknown): URL {
  if (typeof path !== "string" || path.length > 16384 || !path.startsWith("/") || path.startsWith("//") || /[\\#\u0000-\u0020]/.test(path)) {
    throw connectionError("INVALID_ARGUMENT", "A relative connection path is required");
  }
  const pathname = path.split("?")[0];
  if (pathname.includes("%") || /(?:^|\/)\.\.?(?:\/|$)/.test(pathname) || pathname.includes("//")) {
    throw connectionError("INVALID_ARGUMENT", "Connection path escapes its route");
  }
  const url = new URL(`${base}${path}`);
  if (url.origin !== new URL(base).origin) throw connectionError("INVALID_ARGUMENT", "Connection origin changed");
  return url;
}

export function validateConnectionRoutes(raw: unknown): PluginConnection["routes"] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 16) throw connectionError("INVALID_ARGUMENT", "Declare 1 to 16 exact routes");
  const seen = new Set<string>();
  return raw.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw connectionError("INVALID_ARGUMENT", "Invalid route");
    const item = entry as { path?: unknown; methods?: unknown };
    connectionRequestUrl("https://route.invalid", item.path);
    if (typeof item.path !== "string" || item.path.includes("?") || seen.has(item.path) || !Array.isArray(item.methods) || !item.methods.length || item.methods.some(m => m !== "GET" && m !== "POST")) {
      throw connectionError("INVALID_ARGUMENT", "Invalid or duplicate route");
    }
    seen.add(item.path);
    return { path: item.path, methods: [...new Set(item.methods)] as Array<"GET" | "POST"> };
  });
}

export function validateConnectionCa(raw: unknown): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > 128 * 1024 || raw.includes("PRIVATE KEY")) {
    throw connectionError("INVALID_ARGUMENT", "Expected public CA certificates only");
  }
  const certificates = raw.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!certificates?.length || certificates.length > 16 || raw.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()) {
    throw connectionError("INVALID_ARGUMENT", "Invalid CA PEM");
  }
  try { for (const pem of certificates) { if (!new X509Certificate(pem).ca) throw new Error("Not a CA"); } }
  catch { throw connectionError("INVALID_ARGUMENT", "Invalid CA certificate"); }
  return raw;
}

const ALLOWED_HEADERS = new Set(["accept", "content-type", "mcp-protocol-version", "mcp-session-id", "x-memory-actor-session-id", "x-ai-memory-client", "last-event-id", "idempotency-key"]);
export function connectionHeaders(raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 16) {
    throw connectionError("INVALID_ARGUMENT", "Invalid request headers");
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = key.toLowerCase();
    if (!ALLOWED_HEADERS.has(normalized) || typeof value !== "string" || value.length > 4096 || /[\r\n\u0000]/.test(value)) {
      throw connectionError("INVALID_ARGUMENT", "Request header is not allowed");
    }
    headers[normalized] = value;
  }
  return headers;
}
