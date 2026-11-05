/** Structural host contracts: no Desktop implementation imports or credential fields. */
export interface OwnerContext {
  sessionId: string;
  turnId?: string;
  runtimeId: string;
  projectPath: string | null;
  workspaceRoot: string | null;
  remoteWorkspace?: { hostKey: string; path: string };
  mode: 'agent' | 'plan' | 'goal';
  retirementReason?: 'reconfigure' | 'session-close' | 'app-quit';
  parentSessionId?: string;
  signal: AbortSignal;
}
export interface Connection {
  id: string;
  pluginId: string;
  label: string;
  baseUrl: string;
  revision: number;
  hasCredential: boolean;
  caConfigured: boolean;
  allowHttp: boolean;
  routes: Array<{ path: string; methods: Array<'GET' | 'POST'> }>;
}
export interface ConnectionRequest {
  connectionId: string;
  expectedRevision: number;
  requestId: string;
  path: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}
export interface ConnectionResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  connectionRevision: number;
}
export interface Connections {
  getCapabilities(): Promise<{ version: number }>;
  list(): Promise<Connection[]>;
  request(input: ConnectionRequest): Promise<ConnectionResponse>;
  cancel(requestId: string): Promise<void>;
}
export interface HostApi {
  connections?: Connections;
  plugin: {
    getSettings(): Promise<Record<string, unknown>>;
    setSettings(settings: Record<string, unknown>): Promise<void>;
    getDataPath(): Promise<string>;
    getPermissions?(): Promise<string[]>;
  };
  fs: {
    readPreview(path: string, options?: { workspacePath?: string }): Promise<unknown>;
  };
  workspace: { get(): Promise<{ path: string; name: string; remote?: { path: string; readOnly: true } } | null> };
  commands: { register(command: { id: string; title: string; run(): Promise<void> }): Promise<void>; unregister(id: string): Promise<void> };
  ui: { openPanel(options?: { title?: string }): Promise<void> };
  services: { register(service: { id: string; start(): void | Promise<void>; stop(): void | Promise<void> }): void; unregister(id: string): Promise<void> };
}
export const OWNER_OPERATIONS = {
  status: true, recall: true, capture: false, retire: false,
  query: true, readPage: true, briefing: true, listHandoffs: true,
  writePage: false, acceptHandoff: false, beginHandoff: false,
  cancelHandoff: false, maintenance: false,
} as const;
export type Operation = keyof typeof OWNER_OPERATIONS;
export type Mutation = 'writePage' | 'acceptHandoff' | 'beginHandoff' | 'cancelHandoff' | 'maintenance';
export interface Scope { connectionId: string; connectionRevision: number; workspace: string; project: string }
export interface Binding {
  projectPath: string;
  connectionId: string;
  workspace: string;
  project: string;
  capture: boolean;
}
export interface CapturePolicy {
  prompts: boolean;
  toolArguments: boolean;
  toolResults: boolean;
  assistant: boolean;
  maxChars: number;
  ignorePaths: string[];
}
export interface Settings {
  schemaVersion: 1;
  mode: 'coexist' | 'managed';
  paused: boolean;
  bindings: Binding[];
  policy: CapturePolicy;
  recall: { deadlineMs: number; maxChars: number };
}
export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1, mode: 'coexist', paused: false, bindings: [],
  policy: { prompts: false, toolArguments: false, toolResults: false, assistant: false, maxChars: 8000, ignorePaths: [] },
  recall: { deadlineMs: 1500, maxChars: 6000 },
};
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new MemoryError('INVALID_INPUT');
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new MemoryError('INVALID_INPUT');
  return value;
}
export function name(value: unknown): string {
  const result = text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) throw new MemoryError('INVALID_SCOPE');
  return result;
}
export class MemoryError extends Error {
  constructor(public readonly code: string, public readonly retryAfterMs?: number) { super(code); this.name = 'MemoryError'; }
}
/** Never expose arbitrary upstream errors, URLs, response bodies, or host error messages. */
const SAFE_CODES = new Set(['CANCELLED', 'PERMISSION_DENIED', 'AUTH_REQUIRED', 'CONNECTION_CHANGED', 'CONNECTION_MISSING', 'CONNECTION_NOT_FOUND', 'CONNECTION_REVISION_MISMATCH', 'CONNECTION_DISABLED', 'HTTP_NOT_APPROVED', 'HOST_UPGRADE_REQUIRED', 'INVALID_ROUTE', 'ROUTE_NOT_ALLOWED', 'TLS_FAILED', 'NETWORK_ERROR', 'TRANSPORT_FAILURE', 'REQUEST_TIMEOUT', 'RESPONSE_TOO_LARGE', 'RATE_LIMITED', 'OWNER_UNAVAILABLE', 'OWNER_CONTEXT_EXPIRED', 'WORKSPACE_UNAVAILABLE', 'WORKSPACE_CHANGED', 'REMOTE_UNAVAILABLE', 'FILE_NOT_FOUND']);
for (const code of ['WRITES_NOT_VERIFIED', 'CAPTURE_NOT_VERIFIED', 'CAPTURE_NOT_ENABLED', 'CAPTURE_PAUSED', 'PROJECT_UNBOUND', 'BINDING_CONFLICT', 'MARKER_INVALID', 'REMOTE_MARKER_UNAVAILABLE', 'PAGE_CONFLICT', 'QUEUE_FULL', 'RECONCILIATION_REQUIRED', 'CONFIRMATION_REQUIRED', 'MANAGED_MODE_REQUIRED', 'AGENT_MODE_REQUIRED', 'SENSITIVE_CONTENT', 'RECALL_DEADLINE', 'STALE_CONFIGURATION', 'PLUGIN_STOPPED', 'HOST_CONTEXT_INVALID', 'HOST_PERMISSIONS_MISSING', 'ENDPOINT_UNSUPPORTED', 'RPC_ERROR', 'UPSTREAM_TOOL_ERROR', 'DELIVERY_IN_PROGRESS', 'INVALID_ARGUMENT', 'LIMIT_EXCEEDED', 'NOT_FOUND', 'PLUGIN_UNLOADED', 'STORAGE_INVALID', 'STORAGE_UNAVAILABLE', 'REDIRECT_DISALLOWED', 'CONFLICT', 'TIMEOUT', 'ABORTED', 'CONNECTION_FAILED']) SAFE_CODES.add(code);
for (const code of ['MCP_SESSION_EXPIRED', 'STATE_UNWRITABLE']) SAFE_CODES.add(code);
export function errorCode(error: unknown): string {
  if (error instanceof MemoryError) return error.code;
  if (error instanceof Error && error.name === 'AbortError') return 'CANCELLED';
  if (error && typeof error === 'object') {
    const code = 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && SAFE_CODES.has(code)) return code;
    // Host IPC wraps fixed codes in Error.message. Never pass through arbitrary text.
    if (error instanceof Error && SAFE_CODES.has(error.message)) return error.message;
  }
  return 'UNEXPECTED_FAILURE';
}
export function assertActive(signal: AbortSignal): void { if (signal.aborted) throw new MemoryError('CANCELLED'); }
export function scopeKey(scope: Scope): string { return JSON.stringify([scope.connectionId, scope.connectionRevision, scope.workspace, scope.project]); }
