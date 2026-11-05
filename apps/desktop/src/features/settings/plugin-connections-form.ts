/**
 * Draft model for a host-managed plugin connection.
 *
 * The native sheet edits what the host stores; the plugin only ever sees the
 * credential-free projection. Everything here is a pure function over plain
 * data — the component owns rendering and IPC — so the rules that decide
 * "this may be saved" and "what exactly goes over IPC" are unit-testable
 * without a DOM.
 *
 * Wire models use the public SDK contract; runtime imports stay outside this
 * pure form module.
 */
import type { PluginConnection, PluginConnectionInput } from "@pi-desktop/plugin-sdk";

export type PluginConnectionRecord = PluginConnection;
export type PluginConnectionRoute = PluginConnection["routes"][number];
export type PluginConnectionMethod = PluginConnectionRoute["methods"][number];

/**
 * Write model for `connections/save`.
 *
 * `token`/`caPem` are tri-state and the three states mean different things:
 * a string stores it, an empty string deletes it, and an absent key keeps the
 * stored value untouched. `undefined` is never sent — the key is omitted — so
 * a stale render cannot accidentally clear a credential.
 */
export type PluginConnectionSaveInput = PluginConnectionInput;

export type ConnectionDraftRoute = PluginConnectionRoute & {
  /** Stable render key; a route has no identity in the host. */
  key: string;
};

export type ConnectionDraft = {
  /** Absent while adding; present while editing an existing connection. */
  id?: string;
  expectedRevision?: number;
  label: string;
  baseUrl: string;
  /** Write-only: seeded blank, never filled from the host. */
  token: string;
  /** User asked to delete the stored credential on save. */
  clearToken: boolean;
  allowHttp: boolean;
  caPem: string;
  /** User asked to delete the stored custom CA on save. */
  clearCa: boolean;
  routes: ConnectionDraftRoute[];
  /** Endpoint the stored credential belongs to; absent for a new connection. */
  savedBaseUrl?: string;
  hasCredential: boolean;
  hasCustomCa: boolean;
};

/** Where the form has to send the user back; first entry wins. */
export type ConnectionDraftIssue =
  | { kind: "label" }
  | { kind: "baseUrl" }
  | { kind: "httpConsent" }
  | { kind: "tokenRequired" }
  | { kind: "routes" }
  | { kind: "routePath"; index: number }
  | { kind: "routeMethods"; index: number }
  | { kind: "routeDuplicate"; index: number };

export const PLUGIN_CONNECTION_METHODS: readonly PluginConnectionMethod[] = [
  "GET",
  "POST",
];

/** Host policy: unencrypted HTTP needs consent unless it never leaves the box. */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const MAX_BASE_URL_LENGTH = 2048;

let routeKeySeed = 0;

function nextRouteKey(): string {
  routeKeySeed += 1;
  return `route-${routeKeySeed}`;
}

export function draftRoute(
  path = "",
  methods: PluginConnectionMethod[] = [],
): ConnectionDraftRoute {
  return { key: nextRouteKey(), path, methods: normalizeMethods(methods) };
}

/** Canonical method order, so equal selections always serialize equally. */
export function normalizeMethods(
  methods: readonly PluginConnectionMethod[],
): PluginConnectionMethod[] {
  return PLUGIN_CONNECTION_METHODS.filter((method) => methods.includes(method));
}

export function emptyConnectionDraft(): ConnectionDraft {
  return {
    label: "",
    baseUrl: "",
    token: "",
    clearToken: false,
    allowHttp: false,
    caPem: "",
    clearCa: false,
    routes: [draftRoute()],
    hasCredential: false,
    hasCustomCa: false,
  };
}

export function connectionDraft(connection: PluginConnectionRecord): ConnectionDraft {
  return {
    id: connection.id,
    expectedRevision: connection.revision,
    label: connection.label,
    baseUrl: connection.baseUrl,
    token: "",
    clearToken: false,
    allowHttp: connection.allowHttp,
    caPem: "",
    clearCa: false,
    routes: connection.routes.map((route) =>
      draftRoute(route.path, [...route.methods]),
    ),
    savedBaseUrl: connection.baseUrl,
    hasCredential: connection.hasCredential,
    hasCustomCa: connection.caConfigured,
  };
}

/** Comparison form: trailing slashes and case in the host are not a change. */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
  return url.href.replace(/\/+$/, "");
}

/**
 * The stored credential is bound to one origin and base path, so a new
 * endpoint demands the token again.
 */
export function endpointChanged(draft: ConnectionDraft): boolean {
  if (draft.savedBaseUrl === undefined) return false;
  return normalizeBaseUrl(draft.baseUrl) !== normalizeBaseUrl(draft.savedBaseUrl);
}

/** Whether the form must reject a save until a token is typed. */
export function tokenRequired(draft: ConnectionDraft): boolean {
  if (draft.id === undefined) return false;
  return endpointChanged(draft);
}

export function baseUrlIsLoopback(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.includes(new URL(value.trim()).hostname);
  } catch {
    return false;
  }
}

/**
 * Mirrors the host's base URL rules as an early error, never as authority:
 * a plain http(s) URL with no credentials, query, fragment, encoded or
 * dot-segment path component.
 */
export function parseBaseUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_BASE_URL_LENGTH) return null;
  if (/[\u0000-\u0020\\]/.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const afterScheme = trimmed.slice(trimmed.indexOf("://") + 3);
  if (/%|(?:^|\/)\.\.?(?:\/|$)/.test(afterScheme)) return null;
  return url;
}

export function routePathIssue(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return true;
  if (trimmed.length > 16384) return true;
  if (/[\\#?\u0000-\u0020]/.test(trimmed)) return true;
  if (trimmed.includes("%") || trimmed.includes("//")) return true;
  return /(?:^|\/)\.\.?(?:\/|$)/.test(trimmed);
}

/** Every reason this draft cannot be saved, in the order the form shows them. */
export function validateConnectionDraft(draft: ConnectionDraft): ConnectionDraftIssue[] {
  const issues: ConnectionDraftIssue[] = [];
  if (!draft.label.trim()) issues.push({ kind: "label" });

  const url = parseBaseUrl(draft.baseUrl);
  if (!url) {
    issues.push({ kind: "baseUrl" });
  } else if (
    url.protocol === "http:" &&
    !draft.allowHttp &&
    !baseUrlIsLoopback(draft.baseUrl)
  ) {
    issues.push({ kind: "httpConsent" });
  }

  if (tokenRequired(draft) && !draft.token) issues.push({ kind: "tokenRequired" });

  if (draft.routes.length === 0) issues.push({ kind: "routes" });
  const seen = new Set<string>();
  draft.routes.forEach((route, index) => {
    const path = route.path.trim();
    if (routePathIssue(path)) {
      issues.push({ kind: "routePath", index });
      return;
    }
    if (route.methods.length === 0) {
      issues.push({ kind: "routeMethods", index });
      return;
    }
    if (seen.has(path)) {
      issues.push({ kind: "routeDuplicate", index });
      return;
    }
    seen.add(path);
  });
  return issues;
}

/**
 * The IPC payload. Absent `token`/`caPem` keys are the "keep what is stored"
 * state; empty strings are deliberate deletions.
 */
export function buildConnectionSaveInput(
  pluginId: string,
  draft: ConnectionDraft,
): PluginConnectionSaveInput {
  const input: PluginConnectionSaveInput = {
    pluginId,
    label: draft.label.trim(),
    baseUrl: draft.baseUrl.trim(),
    allowHttp: draft.allowHttp,
    routes: draft.routes.map((route) => ({
      path: route.path.trim(),
      methods: normalizeMethods(route.methods),
    })),
  };
  if (draft.id !== undefined) input.id = draft.id;
  if (draft.expectedRevision !== undefined) input.expectedRevision = draft.expectedRevision;
  if (draft.token) input.token = draft.token;
  else if (draft.clearToken) input.token = "";
  const caPem = draft.caPem.trim();
  if (caPem) input.caPem = caPem;
  else if (draft.clearCa) input.caPem = "";
  return input;
}

/** `POST /mcp` for each declared route, in declaration order. */
export function connectionRouteSummary(connection: PluginConnectionRecord): string[] {
  return connection.routes.flatMap((route) =>
    normalizeMethods(route.methods).map((method) => `${method} ${route.path}`),
  );
}

/** The absolute URL one route resolves to, or null while the pair is invalid. */
export function resolvedRouteUrl(baseUrl: string, path: string): string | null {
  const url = parseBaseUrl(baseUrl);
  const trimmed = path.trim();
  if (!url || routePathIssue(trimmed)) return null;
  return `${url.href.replace(/\/+$/, "")}${trimmed}`;
}

/** Upsert one saved connection into the list, newest host value winning. */
export function upsertConnection(
  connections: readonly PluginConnectionRecord[],
  connection: PluginConnectionRecord,
): PluginConnectionRecord[] {
  const index = connections.findIndex((entry) => entry.id === connection.id);
  if (index === -1) return [...connections, connection];
  return connections.map((entry) => (entry.id === connection.id ? connection : entry));
}
