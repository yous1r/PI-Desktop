import { GLOBAL_SCOPE, resolveScope, type ActivationScope, type AgentCapabilityLevel, type McpServerInput, type McpServerRecord, type McpTransport } from "@pi-desktop/shared";
import { pairsToRecord, recordToPairs, type KeyValuePair } from "./KeyValueRows";

export type McpDraft = {
  id: string; label: string; description: string; transport: McpTransport;
  command: string; args: string; env: KeyValuePair[]; url: string; headers: KeyValuePair[];
  enabled: boolean; scope: ActivationScope; timeoutSeconds: string;
  authType: "none" | "bearer"; bearerToken: string; clearBearerToken: boolean; hasBearerToken: boolean;
  caCertificate: string; memoryProjectBindings: Record<string, string>;
};

export function emptyMcpDraft(): McpDraft {
  return { id: "", label: "", description: "", transport: "stdio", command: "npx", args: "", env: [], url: "", headers: [],
    enabled: true, scope: GLOBAL_SCOPE, timeoutSeconds: "", authType: "none", bearerToken: "", clearBearerToken: false,
    hasBearerToken: false, caCertificate: "", memoryProjectBindings: {} };
}

export function draftFromRecord(record: McpServerRecord): McpDraft {
  return { ...emptyMcpDraft(), id: record.id, label: record.label ?? "", description: record.description ?? "", transport: record.transport,
    command: record.command ?? "", args: (record.args ?? []).join(" "), env: recordToPairs(record.env), url: record.url ?? "",
    headers: recordToPairs(record.headers), enabled: record.enabled, scope: resolveScope(record.scope),
    timeoutSeconds: record.timeoutSeconds !== undefined ? String(record.timeoutSeconds) : "",
    authType: record.authType ?? "none", hasBearerToken: record.hasBearerToken === true, caCertificate: record.caCertificate ?? "",
    memoryProjectBindings: { ...(record.memoryProjectBindings ?? {}) } };
}

export function splitArgs(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of value) {
    if (quote) { if (char === quote) quote = null; else current += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) { if (current) out.push(current); current = ""; continue; }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

export function mcpIdFromLabel(label: string): string {
  const cleaned = label.trim().toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+/, "").replace(/-+$/, "").slice(0, 64);
  return /^[a-z]/.test(cleaned) ? cleaned : "";
}

export function draftToInput(draft: McpDraft, context?: { level?: AgentCapabilityLevel; projectPath?: string }): McpServerInput {
  const timeout = draft.timeoutSeconds.trim();
  const parsed = timeout ? Number.parseInt(timeout, 10) : undefined;
  const base = { id: draft.id.trim(), ...(context?.level ? { level: context.level } : {}), ...(context?.projectPath ? { projectPath: context.projectPath } : {}),
    label: draft.label.trim() || draft.id.trim(), description: draft.description.trim() || undefined,
    timeoutSeconds: timeout && parsed !== undefined && !Number.isNaN(parsed) ? parsed : null, enabled: draft.enabled, scope: draft.scope };
  if (draft.transport === "stdio") return { ...base, transport: "stdio", command: draft.command.trim(), args: splitArgs(draft.args), env: pairsToRecord(draft.env) };
  return { ...base, transport: "http", url: draft.url.trim(), headers: pairsToRecord(draft.headers),
    authType: draft.authType === "bearer" ? "bearer" : null,
    ...(draft.authType === "bearer" && draft.clearBearerToken ? { bearerToken: null } :
      draft.authType === "bearer" && draft.bearerToken ? { bearerToken: draft.bearerToken } : {}),
    caCertificate: draft.caCertificate || null, memoryProjectBindings: { ...draft.memoryProjectBindings } };
}

/** Choosing the secure mode is the explicit migration of an old Bearer header. */
export function selectMcpAuthentication(draft: McpDraft, authType: "none" | "bearer"): McpDraft {
  if (authType === "none") return { ...draft, authType, bearerToken: "", clearBearerToken: false };
  const bearer = draft.headers.find((pair) => pair.key.toLowerCase() === "authorization" && /^Bearer\s+/i.test(pair.value));
  return { ...draft, authType, clearBearerToken: false,
    bearerToken: bearer ? bearer.value.replace(/^Bearer\s+/i, "") : draft.bearerToken,
    headers: bearer ? draft.headers.filter((pair) => pair !== bearer) : draft.headers };
}

export function mcpDraftForTransport(draft: McpDraft, transport: McpTransport): McpDraft {
  return { ...draft, transport, ...(transport === "stdio" ? { bearerToken: "", clearBearerToken: false } : {}) };
}

export function memoryCenterDraft(label: string, record?: McpServerRecord): McpDraft {
  const draft = record ? draftFromRecord(record) : { ...emptyMcpDraft(), id: "superclaude-memory", label };
  let url = record?.transport === "http" ? record.url : undefined;
  if (!url) {
    try {
      const base = new URL(record?.env?.SC_MEMORY_URL || "https://dev");
      base.pathname = `${base.pathname.replace(/\/+$/, "")}/mcp`;
      url = base.toString();
    } catch { url = "https://dev/mcp"; }
  }
  return { ...draft, transport: "http", url, authType: record?.transport === "http" ? draft.authType : "bearer", bearerToken: "", clearBearerToken: false };
}

export function mcpDraftError(draft: McpDraft): string | null {
  if (!draft.id.trim()) return "extensions.mcp.errorId";
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(draft.id.trim())) return "extensions.mcp.errorIdShape";
  if (draft.timeoutSeconds.trim()) {
    const parsed = Number(draft.timeoutSeconds.trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 600) return "extensions.mcp.errorTimeoutRange";
  }
  if (draft.transport === "stdio") {
    if (!draft.command.trim()) return "extensions.mcp.errorCommand";
    if (draft.command.includes("..")) return "extensions.mcp.errorCommandDots";
    return null;
  }
  let url: URL;
  if (!draft.url.trim()) return "extensions.mcp.errorUrl";
  try { url = new URL(draft.url.trim()); } catch { return "extensions.mcp.errorUrlShape"; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "extensions.mcp.errorUrlScheme";
  if (draft.authType === "bearer") {
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) return "mcpSecurity.errorSecureUrl";
    if (draft.headers.some((pair) => pair.key.toLowerCase() === "authorization")) return "mcpSecurity.errorAuthHeader";
    if (draft.bearerToken && (!/^[\x21-\x7e]+$/.test(draft.bearerToken) || new TextEncoder().encode(draft.bearerToken).length > 4096)) return "mcpSecurity.errorToken";
  }
  if (draft.caCertificate && (url.protocol !== "https:" || new TextEncoder().encode(draft.caCertificate).length > 65536 || !/^\s*-----BEGIN CERTIFICATE-----/.test(draft.caCertificate) || /PRIVATE KEY/.test(draft.caCertificate))) return "mcpSecurity.errorCa";
  const bindings = Object.entries(draft.memoryProjectBindings);
  if (bindings.length > 64 || bindings.some(([path, id]) => !path.trim() || /[\u0000-\u001f\u007f]/.test(path) || !/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,255}$/.test(id) || /^[A-Za-z]:/.test(id))) return "mcpSecurity.errorBinding";
  return null;
}

/** A user-selected File boundary; the Main process also validates real X.509 certificates. */
export async function readMcpCaFile(file: Pick<File, "size" | "text">): Promise<string> {
  if (file.size > 65536) throw new Error("mcpSecurity.errorCa");
  const pem = await file.text();
  if (new TextEncoder().encode(pem).length > 65536 || !/^\s*-----BEGIN CERTIFICATE-----/.test(pem) || !/-----END CERTIFICATE-----\s*$/.test(pem) || /PRIVATE KEY/.test(pem)) throw new Error("mcpSecurity.errorCa");
  return pem;
}
