/**
 * Vendor-account (OAuth) login for model providers.
 *
 * pi-ai owns all supported login flows and the locked token refresh; persistence
 * and the user-facing half of the conversation are the app's job (see
 * `auth/types.d.ts`: "Login/account-removal orchestration is app-owned"). This module is
 * that half:
 *
 *  - a CredentialStore backed by host-core's encrypted secret store, keyed
 *    `secret:provider:<providerRowId>:oauth` so an API key and a vendor account
 *    can coexist on one provider row;
 *  - a bridge from pi-ai's prompt/notify interaction to renderer events;
 *  - short-lived request auth (`ModelAuth`) for the agent sidecar.
 *
 * Refresh tokens never leave the main process: callers get either a boolean, a
 * non-secret account label, or an already-resolved `ModelAuth`.
 */

import { randomUUID } from "node:crypto";
import { createInstallationIdentity } from "./installation-identity.ts";
import {
  VendorOAuthActivity,
  type VendorOAuthHandoffActivity,
  type VendorOAuthHostCall,
  type VendorOAuthOwner,
  type VendorOAuthScope,
} from "./oauth-activity.ts";

import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import type {
  Api,
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Credential,
  CredentialStore,
  Model,
  ModelAuth,
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import type {
  PluginProviderOAuthCredential,
  PluginProviderOAuthEvent,
  PluginProviderOAuthPrompt,
  PluginProviderOAuthRequest,
} from "@pi-desktop/plugin-sdk";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  capabilitiesFromModelConfig,
  genericModelConfig,
  installProviderHeadersFetch,
  modelConfigWithBinding,
  runWithProviderHeaders,
  type ModelConfig,
  type VendorModelBinding,
} from "@pi-desktop/agent-runtime";
import {
  isConversationModelId,
  parseVendorModelIds,
  readVendorModelList,
  VendorModelListError,
  vendorModelListRequest,
  wireForLiveModel,
} from "./vendor-live-models.ts";
import type { ThinkingLevel } from "@pi-desktop/shared";
import {
  OAUTH_AUTH_KIND,
  type OAuthLoginEvent,
  type OAuthPromptRequest,
  type OAuthRespondInput,
  type OAuthStartResult,
  type OAuthVendor,
  type ModelBinding,
} from "@pi-desktop/shared";

export { OAUTH_AUTH_KIND };

/** Mirrors `secret_ref_for_provider_oauth` in crates/host-core/src/secrets.rs. */
export function secretRefForProviderOauth(providerId: string): string {
  return `secret:provider:${providerId}:oauth`;
}

const API_STYLE_BY_WIRE_API: Record<string, string> = {
  "anthropic-messages": "anthropic_messages",
  "openai-completions": "chat_completions",
  "openai-responses": "responses",
  "openai-codex-responses": "openai_codex_responses",
  "google-generative-ai": "google_generative_ai",
  "pi-messages": "pi_messages",
};

const PROTOCOL_BY_API_STYLE: Record<string, string> = {
  anthropic_messages: "anthropic",
  chat_completions: "openai_compatible",
  responses: "openai",
  openai_codex_responses: "openai",
  google_generative_ai: "google",
  pi_messages: "custom_http",
};

/**
 * A provider row stores one apiStyle, but a vendor can span wire APIs (GitHub
 * Copilot serves Anthropic, Chat Completions and Responses models), so the
 * style follows the selected model rather than the vendor.
 */
export function apiStyleForWireApi(api: string): string {
  return API_STYLE_BY_WIRE_API[api] ?? "chat_completions";
}

function wireApiForStyle(style: string): Api {
  return Object.entries(API_STYLE_BY_WIRE_API).find(([, value]) => value === style)?.[0] ?? "openai-completions";
}

/** Interpret an explicitly supplied wire map without borrowing another model's record. */
function withMappedThinkingLevels(config: ModelConfig): ModelConfig {
  if (!config.thinkingLevelMap) return config;
  const supportedThinkingLevels = Object.entries(config.thinkingLevelMap).flatMap(([level, value]) =>
    typeof value === "string" ? [level as ThinkingLevel] : [],
  );
  return {
    ...config,
    reasoning: supportedThinkingLevels.some((level) => level !== "off"),
    supportedThinkingLevels,
  };
}

export function protocolForApiStyle(apiStyle: string): string {
  return PROTOCOL_BY_API_STYLE[apiStyle] ?? "openai_compatible";
}

const LIVE_MODELS_TTL_MS = 30_000;
const LIVE_MODELS_NEGATIVE_TTL_MS = 15_000;

/** xAI and the other account lists also publish generators. Those are not conversation models. */
export function isXaiConversationModel(modelId: string): boolean {
  return isConversationModelId(modelId);
}

export type HostCall = VendorOAuthHostCall;

/** The slice of a provider row this module reads; the rest stays in index.ts. */
export type OAuthProviderRow = {
  id: string;
  name?: string;
  vendorKey?: string;
  ownerPluginId?: string;
  authKind?: string;
  hasOauth?: boolean;
  oauthAccountLabel?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
  apiStyle?: string;
  models?: ModelBinding[];
  enabled?: boolean;
  defaultModelId?: string;
};

export type PluginOAuthProvider = {
  pluginId: string;
  runtimeId: string;
  contributionId: string;
  providerId: string;
  name: string;
  loginLabel?: string;
  isSubscription: boolean;
};

export type PluginOAuthBridge = {
  listOAuthProviders: () => PluginOAuthProvider[];
  invokeProviderOAuth: (
    pluginId: string,
    contributionId: string,
    request: PluginProviderOAuthRequest,
    signal?: AbortSignal,
    expectedRuntimeId?: string,
  ) => Promise<unknown>;
};

/** A model ID offered by a signed-in account and its required wire identity. */
export type OAuthModelOption = {
  modelId: string;
  apiStyle: string;
  baseUrl: string;
};

export type VendorOAuthDeps = {
  /** host-core RPC. Only the generic `secrets.*` and `providers.*` methods. */
  call: HostCall;
  /** Push login progress to the renderer. Never carries token material. */
  emit: (event: OAuthLoginEvent) => void;
  /** Open the vendor's consent page; rejects when no browser could be launched. */
  openExternal: (url: string) => Promise<void>;
  /** Loaded plugin OAuth providers and their isolated callback hooks. */
  getPluginOAuthBridge?: () => PluginOAuthBridge | undefined;
  log?: (
    level: "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ) => void;
  /**
   * Stable local installation identity, owned by Host secrets. It is called
   * with the owner that admitted the login, so the read and the write go to
   * that Host and a replacement refuses them.
   */
  getInstallationId?: (owner: VendorOAuthOwner) => Promise<string>;
  /** Share account-owned Models with the catalog without duplicating credentials. */
  onAccountModels?: (providerId: string, models: MutableModels) => void;
  onAccountRemoved?: (providerId: string) => void;
  /** Test seam: build the pi-ai collection without touching the real flows. */
  createModels?: (credentials: CredentialStore) => MutableModels;
  /** Model configuration is supplied by the main-process models.dev catalog. */
  modelConfigFor?: (input: {
    providerId: string;
    vendorKey: string;
    option: OAuthModelOption;
  }) => Promise<ModelConfig | undefined>;
  newId?: () => string;
  /** Test seam. Defaults to the process fetch. */
  fetch?: typeof fetch;
  /**
   * The shared Desktop admission gate (H1). Once it closes, no login, account
   * test, credential refresh or model-list read may start; work that was already
   * admitted keeps running and keeps reporting until it settles.
   *
   * Main composition injects this; the default keeps the gate open so an
   * isolated module test states its own admission.
   */
  isAdmissionClosed?: () => boolean;
  /**
   * Captures the original Host/generation that admits an operation. Every late
   * effect of that operation (secret write, provider row update, renderer event)
   * reuses this owner and refuses once it was replaced, so a previous
   * generation's credential can never land in a replacement Host.
   *
   * Main composition injects this; without it the module follows `call`.
   */
  captureOwner?: () => VendorOAuthOwner;
};

/**
 * A login event minus the identifiers `push()` stamps on. Distributed over the
 * union so each variant keeps its own fields.
 */
type OAuthEventBody = OAuthLoginEvent extends infer Variant
  ? Variant extends unknown
    ? Omit<Variant, "loginId" | "vendorId">
    : never
  : never;

type PendingPrompt = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
};

type AccountModels = {
  providerId: string;
  vendorId: string;
  models: MutableModels;
  pinnedProvider?: Provider;
  /** The original Host that created this collection; never re-pointed. */
  owner: VendorOAuthOwner;
};

type LoginSession = {
  loginId: string;
  vendorId: string;
  providerId: string;
  account: AccountModels;
  /** Whether this login created the row, and so owns cleaning it up on failure. */
  createdRow: boolean;
  controller: AbortController;
  prompts: Map<string, PendingPrompt>;
  /** Serializes renderer events so `authUrl` cannot overtake an earlier notice. */
  tail: Promise<void>;
  /** The admission and original Host this attempt was started for. */
  scope: VendorOAuthScope;
  /** Settles once the attempt has torn down; set as soon as it is running. */
  finished?: Promise<void>;
};

type PluginLoginSession = {
  loginId: string;
  vendorId: string;
  providerId: string;
  pluginId: string;
  contributionId: string;
  runtimeId: string;
  prompts: Map<string, PendingPrompt>;
  controller: AbortController;
  tail: Promise<void>;
  cancelled: boolean;
  /** The admission, original Host and plugin runtime this attempt was started for. */
  scope: VendorOAuthScope;
  finished?: Promise<void>;
};

function promptRequest(
  promptId: string,
  prompt: AuthPrompt,
): OAuthPromptRequest {
  return {
    promptId,
    type: prompt.type,
    message: prompt.message,
    placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
    options:
      prompt.type === "select"
        ? prompt.options.map((option) => ({
            id: option.id,
            label: option.label,
            description: option.description,
          }))
        : undefined,
  };
}

function clippedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4_096) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Events that close something the renderer already shows: a dialog, an open
 * input or an error banner. They are the one thing a retired attempt may still
 * publish, because they end the conversation instead of extending it.
 */
const TERMINAL_EVENT_KINDS: ReadonlySet<string> = new Set([
  "cancelled",
  "error",
  "done",
  "promptCancelled",
]);

function normalizePluginCredential(raw: unknown): PluginProviderOAuthCredential {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("plugin OAuth credential must be an object");
  }
  const value = raw as Record<string, unknown>;
  const accessToken = value.accessToken;
  if (
    typeof accessToken !== "string" ||
    !accessToken.trim() ||
    Buffer.byteLength(accessToken, "utf8") > 16 * 1024
  ) {
    throw new Error("plugin OAuth credential has an invalid accessToken");
  }
  const result: PluginProviderOAuthCredential = { accessToken };
  if (value.refreshToken !== undefined) {
    if (typeof value.refreshToken !== "string" || Buffer.byteLength(value.refreshToken, "utf8") > 16 * 1024) {
      throw new Error("plugin OAuth credential has an invalid refreshToken");
    }
    result.refreshToken = value.refreshToken;
  }
  if (value.expiresAt !== undefined) {
    if (
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= 0
    ) {
      throw new Error("plugin OAuth credential has an invalid expiresAt");
    }
    result.expiresAt = value.expiresAt;
  }
  if (value.accountLabel !== undefined) {
    if (typeof value.accountLabel !== "string" || value.accountLabel.length > 256) {
      throw new Error("plugin OAuth credential has an invalid accountLabel");
    }
    result.accountLabel = value.accountLabel.trim();
  }
  if (value.headers !== undefined) {
    if (!value.headers || typeof value.headers !== "object" || Array.isArray(value.headers)) {
      throw new Error("plugin OAuth credential headers must be an object");
    }
    const entries = Object.entries(value.headers as Record<string, unknown>);
    if (entries.length > 32) throw new Error("plugin OAuth credential has too many headers");
    const headers: Record<string, string> = {};
    const seenHeaderNames = new Set<string>();
    const blocked = new Set([
      "authorization",
      "proxy-authorization",
      "host",
      "cookie",
      "set-cookie",
      "content-length",
      "transfer-encoding",
      "connection",
      "proxy-connection",
    ]);
    for (const [name, headerValue] of entries) {
      const normalizedName = name.toLowerCase();
      if (
        !/^[A-Za-z0-9-]{1,128}$/.test(name) ||
        blocked.has(normalizedName) ||
        seenHeaderNames.has(normalizedName) ||
        typeof headerValue !== "string" ||
        Buffer.byteLength(headerValue, "utf8") > 4_096 ||
        /[\r\n\0]/.test(headerValue)
      ) {
        throw new Error("plugin OAuth credential has an invalid header");
      }
      seenHeaderNames.add(normalizedName);
      headers[name] = headerValue;
    }
    result.headers = headers;
  }
  return result;
}

export class VendorOAuth {
  private readonly deps: VendorOAuthDeps;
  private readonly logins = new Map<string, LoginSession>();
  private readonly pluginLogins = new Map<string, PluginLoginSession>();
  private readonly pluginRefreshControllers = new Map<string, AbortController>();
  /** One pi-ai collection and credential store per local OAuth account row. */
  private readonly accountModels = new Map<string, AccountModels>();
  /** Successful and failed account model lists, so launch does not refetch per model. */
  private readonly liveModelCache = new Map<string, { at: number; models: OAuthModelOption[] | null }>();
  private readonly liveModelLoads = new Map<string, Promise<OAuthModelOption[] | undefined>>();
  /** Per-account write chain: `modify` must be a serialized read-modify-write. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private catalogPromise?: Promise<MutableModels>;
  private oauthFlowsRegistered = false;
  /** Composition/test seam for the Host-owned installation identity. */
  private readonly readInstallationId?: (owner: VendorOAuthOwner) => Promise<string>;
  /** One identity read per live Host generation; never re-pointed at a later one. */
  private installationIdentity?: { owner: VendorOAuthOwner; read: () => Promise<string> };
  /** Admission, original-Host attribution and handoff counters for every entry. */
  private readonly activity: VendorOAuthActivity;

  constructor(deps: VendorOAuthDeps) {
    this.deps = deps;
    this.readInstallationId = deps.getInstallationId;
    this.activity = new VendorOAuthActivity({
      isAdmissionClosed: deps.isAdmissionClosed,
      captureOwner: deps.captureOwner,
      call: deps.call,
      log: deps.log,
    });
    installProviderHeadersFetch();
  }

  /**
   * Synchronous handoff sampling: what vendor-account OAuth still owns, and which
   * of it cannot be certified (pi-ai flow, plugin child process, HTTP transport,
   * external browser). Counts stay up until the underlying promise settles, so a
   * cancelled login or a refused caller never looks closed.
   */
  getHandoffActivity(): VendorOAuthHandoffActivity {
    return this.activity.snapshot();
  }

  /**
   * Refuse new work and stop the vendor conversations this process is driving.
   * Already-admitted work keeps running and keeps reporting, and nothing an
   * admitted operation persisted is rolled back by this call.
   */
  dispose(): void {
    this.activity.seal();
    for (const session of [...this.logins.values()]) this.cancel(session.loginId);
    for (const session of [...this.pluginLogins.values()]) this.cancelPluginLogin(session);
    for (const controller of [...this.pluginRefreshControllers.values()]) {
      controller.abort(new Error("vendor OAuth disposed"));
    }
  }

  /** Every vendor pi-ai can sign in to, with every local account row. */
  async listVendors(): Promise<OAuthVendor[]> {
    const scope = this.activity.capture("list-vendors");
    // Admitted work, counted to settlement: the vendor list reads the catalog
    // and the provider table, and a replaced Host may not finish it.
    return scope.track(() => this.listVendorsScope(scope));
  }

  private async listVendorsScope(scope: VendorOAuthScope): Promise<OAuthVendor[]> {
    const models = await this.ensureCatalogModels();
    const rows = await this.rows(scope);
    const vendors = models
      .getProviders()
      .filter((provider) => provider.auth.oauth)
      .map((provider) => {
        const oauth = provider.auth.oauth!;
        const accounts = rows
          .filter(
            (candidate) =>
              candidate.authKind === OAUTH_AUTH_KIND &&
              !candidate.ownerPluginId &&
              candidate.vendorKey === provider.id,
          )
          .map((row) => ({
            providerId: row.id,
            accountLabel: row.oauthAccountLabel || undefined,
            connected: row.hasOauth === true,
          }));
        return {
          vendorId: provider.id,
          name: oauth.name || provider.name,
          loginLabel: oauth.loginLabel,
          isSubscription: oauth.isSubscription === true,
          accounts,
        };
      });
    const pluginBridge = this.deps.getPluginOAuthBridge?.();
    if (!pluginBridge) return vendors;
    for (const provider of pluginBridge.listOAuthProviders()) {
      const row = rows.find(
        (candidate) =>
          candidate.id === provider.providerId &&
          candidate.ownerPluginId === provider.pluginId &&
          candidate.authKind === OAUTH_AUTH_KIND,
      );
      if (!row) continue;
      const credential = row.hasOauth ? await this.readPluginCredential(scope, row.id) : undefined;
      vendors.push({
        vendorId: row.id,
        name: provider.name,
        loginLabel: provider.loginLabel,
        isSubscription: provider.isSubscription,
        accounts: [{
          providerId: row.id,
          accountLabel: credential?.accountLabel || undefined,
          connected: row.hasOauth === true,
        }],
      });
    }
    return vendors;
  }

  /**
   * Begin a login. Every attempt gets a fresh provider row and credential
   * store, so signing into the same vendor twice creates two independent
   * accounts instead of silently replacing the first one.
   */
  async start(vendorId: string): Promise<OAuthStartResult> {
    const pluginProvider = this.deps
      .getPluginOAuthBridge?.()
      ?.listOAuthProviders()
      .find((provider) => provider.providerId === vendorId);
    if (pluginProvider) {
      // The login is admitted for this plugin runtime; a reload mid-attempt
      // retires it instead of letting a new runtime claim the stored credential.
      const pluginScope = this.activity.capture("plugin-login", {
        pluginId: pluginProvider.pluginId,
        runtimeId: pluginProvider.runtimeId,
      });
      return pluginScope.track(async () => {
        const row = (await this.rows(pluginScope)).find(
          (candidate) =>
            candidate.id === vendorId &&
            candidate.ownerPluginId === pluginProvider.pluginId &&
            candidate.authKind === OAUTH_AUTH_KIND,
        );
        if (!row) throw new Error(`unknown plugin OAuth provider: ${vendorId}`);
        return this.startPluginLogin(pluginScope, pluginProvider);
      });
    }
    // Captured before the first await: the attempt, the pi-ai flow it starts and
    // everything it persists later stay attributed to this admission and Host.
    const scope = this.activity.capture("login");
    return scope.track(async () => {
      const models = await this.ensureCatalogModels();
      const provider = models.getProvider(vendorId);
      if (!provider?.auth.oauth) {
        throw new Error(`unknown vendor account: ${vendorId}`);
      }
      // A second attempt replaces the one in flight rather than racing it, and
      // waits for it to let go: both hold the same local callback port, so
      // starting before the old one unwinds is how a login fails on arrival.
      const superseded = [...this.logins.values()].filter(
        (running) => running.vendorId === vendorId,
      );
      for (const running of superseded) this.cancel(running.loginId);
      for (const running of superseded) {
        await running.finished?.catch(() => undefined);
      }

      const { provider: row } = await scope.call<{
        provider: OAuthProviderRow;
      }>("providers.create", {
        name: provider.auth.oauth?.name || provider.name,
        vendorKey: vendorId,
        type: "native",
        authKind: OAUTH_AUTH_KIND,
        baseUrl: provider.baseUrl,
      });
      const account = this.createAccount(scope, vendorId, row.id);
      const session: LoginSession = {
        loginId: this.nextId(),
        vendorId,
        providerId: row.id,
        account,
        createdRow: true,
        controller: new AbortController(),
        prompts: new Map(),
        tail: Promise.resolve(),
        scope,
      };
      this.logins.set(session.loginId, session);
      this.activity.register(session);
      session.finished = this.run(session, provider);
      return { loginId: session.loginId };
    });
  }

  private startPluginLogin(
    scope: VendorOAuthScope,
    provider: PluginOAuthProvider,
  ): OAuthStartResult {
    const superseded = [...this.pluginLogins.values()].filter(
      (running) => running.providerId === provider.providerId,
    );
    for (const running of superseded) this.cancelPluginLogin(running);
    const session: PluginLoginSession = {
      loginId: this.nextId(),
      vendorId: provider.providerId,
      providerId: provider.providerId,
      pluginId: provider.pluginId,
      contributionId: provider.contributionId,
      runtimeId: provider.runtimeId,
      prompts: new Map(),
      controller: new AbortController(),
      tail: Promise.resolve(),
      cancelled: false,
      scope,
    };
    this.pluginLogins.set(session.loginId, session);
    this.activity.register(session);
    session.finished = this.runPluginLogin(session);
    return { loginId: session.loginId };
  }

  /** Answer a prompt. An absent value cancels the prompt and the login. */
  respond(input: OAuthRespondInput): boolean {
    const session = this.logins.get(input.loginId);
    const pluginSession = this.pluginLogins.get(input.loginId);
    const pending = session?.prompts.get(input.promptId) ?? pluginSession?.prompts.get(input.promptId);
    if ((!session && !pluginSession) || !pending) return false;
    // An answer is a late effect of the attempt that asked the question: a
    // closed admission or a replaced Host retires it instead of resuming the
    // conversation that generation had already lost.
    const scope = session?.scope ?? pluginSession?.scope;
    if (!scope || !scope.isCurrent()) return false;
    if (input.value === undefined) {
      pending.reject(new Error("login cancelled"));
      if (session) session.controller.abort();
      if (pluginSession) this.cancelPluginLogin(pluginSession);
    } else {
      pending.resolve(input.value);
    }
    return true;
  }

  /** Abort a login: stops the local callback server or device-code polling. */
  cancel(loginId: string): boolean {
    const session = this.logins.get(loginId);
    if (session) {
      session.controller.abort();
      return true;
    }
    const pluginSession = this.pluginLogins.get(loginId);
    if (!pluginSession) return false;
    this.cancelPluginLogin(pluginSession);
    return true;
  }

  /**
   * A plugin provider row belongs to exactly one plugin runtime. A reload
   * replaces that runtime, so an attempt admitted by the previous one may not
   * prompt through the new one.
   */
  private pluginRuntimeCurrent(session: PluginLoginSession): boolean {
    const provider = this.livePluginProvider(session.providerId);
    return provider?.pluginId === session.pluginId && provider.runtimeId === session.runtimeId;
  }

  /** The live plugin provider entry for one provider row, if a bridge has it. */
  private livePluginProvider(providerId: string): PluginOAuthProvider | undefined {
    return this.deps
      .getPluginOAuthBridge?.()
      ?.listOAuthProviders()
      .find((candidate) => candidate.providerId === providerId);
  }

  /** Whether the runtime an admitted operation was bound to is still the live one. */
  private pluginRuntimeLive(provider: PluginOAuthProvider, runtimeId: string): boolean {
    const current = this.livePluginProvider(provider.providerId);
    return current?.pluginId === provider.pluginId && current.runtimeId === runtimeId;
  }

  private assertPluginRuntime(provider: PluginOAuthProvider, runtimeId: string): void {
    if (!this.pluginRuntimeLive(provider, runtimeId)) {
      throw new Error(`plugin provider changed during OAuth refresh: ${provider.providerId}`);
    }
  }

  /** Plugin callbacks can ask the same Host-rendered question as native OAuth flows. */
  promptPluginOAuth(
    pluginId: string,
    loginId: string,
    input: PluginProviderOAuthPrompt,
  ): Promise<string> {
    const session = this.pluginLogins.get(loginId);
    if (
      !session ||
      session.pluginId !== pluginId ||
      session.cancelled ||
      !session.scope.isCurrent() ||
      !this.pluginRuntimeCurrent(session)
    ) {
      return Promise.reject(new Error("provider OAuth login is no longer active"));
    }
    if (
      !input ||
      typeof input !== "object" ||
      !["text", "secret", "select", "manual_code"].includes(input.type) ||
      typeof input.message !== "string" ||
      !input.message.trim() ||
      input.message.length > 2_000
    ) {
      return Promise.reject(new Error("provider OAuth prompt is invalid"));
    }
    if (input.type === "select" && (!Array.isArray(input.options) || input.options.length === 0 || input.options.length > 32)) {
      return Promise.reject(new Error("provider OAuth select prompt requires 1 to 32 options"));
    }
    const options = input.type === "select"
      ? (input.options ?? []).flatMap((option) =>
          option && typeof option.id === "string" && typeof option.label === "string"
            ? [{
                id: option.id.slice(0, 128),
                label: option.label.slice(0, 256),
                ...(typeof option.description === "string"
                  ? { description: option.description.slice(0, 512) }
                  : {}),
              }]
            : [],
        )
      : undefined;
    if (input.type === "select" && options?.length === 0) {
      return Promise.reject(new Error("provider OAuth select prompt options are invalid"));
    }
    const promptId = this.nextId();
    return new Promise((resolve, reject) => {
      const settle = () => session.prompts.delete(promptId);
      session.prompts.set(promptId, {
        resolve: (value) => { settle(); resolve(value); },
        reject: (error) => { settle(); reject(error); },
      });
      const request: OAuthPromptRequest = {
        promptId,
        type: input.type,
        message: input.message.trim(),
        ...(typeof input.placeholder === "string" && input.placeholder.length <= 512
          ? { placeholder: input.placeholder }
          : {}),
        ...(options ? { options } : {}),
      };
      this.pushPluginEvent(session, { kind: "prompt", request });
    });
  }

  /** Relay only bounded, non-secret progress to the renderer. */
  async notifyPluginOAuth(
    pluginId: string,
    loginId: string,
    event: PluginProviderOAuthEvent,
  ): Promise<void> {
    const session = this.pluginLogins.get(loginId);
    if (
      !session ||
      session.pluginId !== pluginId ||
      session.cancelled ||
      !session.scope.isCurrent() ||
      !this.pluginRuntimeCurrent(session)
    ) {
      throw new Error("provider OAuth login is no longer active");
    }
    if (event.kind === "authUrl") {
      if (!isHttpUrl(event.url)) throw new Error("provider OAuth URL must use HTTP or HTTPS");
      const url = event.url.slice(0, 4_096);
      // The browser launch outlives this callback, so it is counted against the
      // attempt it was admitted for and never re-attributed to a later owner.
      session.tail = session.tail.then(() =>
        session.scope.track(async () => {
          // A retired attempt may neither launch a browser nor publish a URL for
          // a dialog that already closed: both ends of the launch are checked.
          if (session.cancelled || !session.scope.isCurrent()) return;
          const opened = await this.openConsentPage(session.scope, url);
          if (session.cancelled || !session.scope.isCurrent()) return;
          this.deps.emit({
            loginId,
            vendorId: session.vendorId,
            kind: "authUrl",
            url,
            instructions: clippedText(event.instructions, 2_000),
            opened,
          });
        }),
      );
      await session.tail;
      return;
    }
    if (event.kind === "deviceCode") {
      if (!isHttpUrl(event.verificationUri)) throw new Error("verificationUri must use HTTP or HTTPS");
      this.pushPluginEvent(session, {
        kind: "deviceCode",
        userCode: clippedText(event.userCode, 256),
        verificationUri: event.verificationUri.slice(0, 4_096),
        ...(Number.isFinite(event.intervalSeconds) ? { intervalSeconds: event.intervalSeconds } : {}),
        ...(Number.isFinite(event.expiresInSeconds) ? { expiresInSeconds: event.expiresInSeconds } : {}),
      });
      await session.tail;
      return;
    }
    if (event.kind === "info") {
      this.pushPluginEvent(session, {
        kind: "info",
        message: clippedText(event.message, 2_000),
        ...(Array.isArray(event.links)
          ? {
              links: event.links.slice(0, 4).flatMap((link) =>
                isHttpUrl(link?.url)
                  ? [{ url: link.url.slice(0, 4_096), ...(typeof link.label === "string" ? { label: link.label.slice(0, 128) } : {}) }]
                  : [],
              ),
            }
          : {}),
      });
      await session.tail;
      return;
    }
    this.pushPluginEvent(session, { kind: "progress", message: clippedText(event.message, 2_000) });
    await session.tail;
  }

  /**
   * Delete one account's provider row and its provider-scoped OAuth secret.
   * Host-core owns the atomic cleanup of the row and both secret references.
   */
  async deleteAccount(providerId: string): Promise<void> {
    const scope = this.activity.capture("delete-account");
    return scope.track(async () => {
      const row = (await this.rows(scope)).find((candidate) => candidate.id === providerId);
      if (!row || row.authKind !== OAUTH_AUTH_KIND) {
        throw new Error(`unknown vendor account provider: ${providerId}`);
      }
      if (row.ownerPluginId) {
        this.pluginRefreshControllers.get(providerId)?.abort(new Error("provider sign-out requested"));
        const running = [...this.pluginLogins.values()].find(
          (session) => session.providerId === providerId,
        );
        if (running) this.cancelPluginLogin(running);
        await this.serialize(providerId, () =>
          scope.call("secrets.delete", {
            secretRef: secretRefForProviderOauth(providerId),
          }),
        );
        this.clearAccountModels(providerId);
        return;
      }
      const running = [...this.logins.values()].find(
        (session) => session.providerId === providerId,
      );
      if (running) {
        this.cancel(running.loginId);
        await running.finished?.catch(() => undefined);
      }
      // The row is only forgotten once Host deletion actually succeeded.
      await scope.call("providers.delete", { id: providerId });
      this.accountModels.delete(providerId);
      this.deps.onAccountRemoved?.(providerId);
      this.liveModelCache.delete(providerId);
      this.liveModelLoads.delete(providerId);
    });
  }

  /**
   * Resolve request auth for one model request. pi-ai refreshes the token under
   * the store lock when it has expired; the caller only ever sees the resulting
   * short-lived access token, headers and per-credential baseUrl.
   */
  async resolveAuth(providerId: string): Promise<ModelAuth> {
    const scope = this.activity.capture("resolve-auth");
    return scope.track(() => this.resolveAuthScope(scope, providerId));
  }

  private async resolveAuthScope(
    scope: VendorOAuthScope,
    providerId: string,
  ): Promise<ModelAuth> {
    const row = (await this.rows(scope)).find((candidate) => candidate.id === providerId);
    if (row?.ownerPluginId && row.authKind === OAUTH_AUTH_KIND) {
      return this.resolvePluginAuth(scope, row);
    }
    return this.withRowHeaders(scope, providerId, async () => {
      const account = await this.accountForProvider(scope, providerId);
      if (!account) throw new Error(`vendor account not signed in: ${providerId}`);
      const resolved = await account.models.getAuth(account.vendorId);
      if (!resolved) throw new Error(`vendor account not signed in: ${providerId}`);
      return resolved.auth;
    });
  }

  /**
   * Models the signed-in account may actually use.
   *
   * The account's own model list is the authority. pi-ai (`getAvailable`,
   * including a vendor `filterModels`) is used only when that request cannot
   * be read. Radius keeps its gateway refresh and does not get a second probe.
   */
  async listModels(providerId: string): Promise<OAuthModelOption[]> {
    const scope = this.activity.capture("list-models");
    return scope.track(() => this.modelsForScope(scope, providerId));
  }

  /** The same list inside an operation that already holds an owner. */
  private async modelsForScope(
    scope: VendorOAuthScope,
    providerId: string,
  ): Promise<OAuthModelOption[]> {
    const row = (await this.rows(scope)).find((candidate) => candidate.id === providerId);
    if (row?.ownerPluginId && row.authKind === OAUTH_AUTH_KIND) {
      if (!row.baseUrl) return [];
      const baseUrl = row.baseUrl;
      return (row.models ?? []).map((model) => ({
        modelId: model.id,
        apiStyle: row.apiStyle ?? "chat_completions",
        baseUrl,
      }));
    }
    return this.withRowHeaders(scope, providerId, async () => {
      const account = await this.accountForProvider(scope, providerId);
      if (!account) throw new Error(`unknown vendor account provider: ${providerId}`);
      // Dynamic catalogs (radius) are empty until refreshed.
      await account.models.refresh({ providers: [account.vendorId] });
      const available = await account.models.getAvailable(account.vendorId);
      return available.map((model) => this.optionFor(model));
    });
  }

  private optionFor(model: Model<Api>): OAuthModelOption {
    return {
      modelId: model.id,
      apiStyle: apiStyleForWireApi(model.api),
      baseUrl: model.baseUrl,
    };
  }

  /**
   * Everything a provider binding needs for one model of a signed-in account.
   *
   * A vendor row cannot take this from the builtin catalog: one account spans
   * wire APIs (GitHub Copilot serves Anthropic, Chat Completions and Responses
   * models, so the selected model — not the row — decides the style), and a
   * gateway's catalog (radius) is not in the builtin one at all. The
   * authenticated collection knows both.
   */
  async bindingFor(
    providerId: string,
    modelId: string,
  ): Promise<VendorModelBinding | undefined> {
    const scope = this.activity.capture("binding");
    return scope.track(() => this.bindingForScope(scope, providerId, modelId));
  }

  /** The same binding inside an operation that already holds an owner. */
  private async bindingForScope(
    scope: VendorOAuthScope,
    providerId: string,
    modelId: string,
  ): Promise<VendorModelBinding | undefined> {
    const row = (await this.rows(scope)).find((candidate) => candidate.id === providerId);
    if (row?.ownerPluginId && row.authKind === OAUTH_AUTH_KIND) {
      const declared = row.models?.find((model) => model.id === modelId);
      if (!declared || !row.baseUrl) return undefined;
      const option: OAuthModelOption = {
        modelId: declared.id,
        apiStyle: row.apiStyle ?? "chat_completions",
        baseUrl: row.baseUrl,
      };
      const published = await this.deps.modelConfigFor?.({
        providerId: row.id,
        vendorKey: row.vendorKey ?? "custom",
        option,
      }).catch(() => undefined);
      const baseline = withMappedThinkingLevels(
        published ?? genericModelConfig(option.modelId, option.baseUrl),
      );
      const model = modelConfigWithBinding(baseline, {
        ...declared,
        contextWindow: declared.contextWindow > 0 ? declared.contextWindow : baseline.contextWindow,
        maxTokens: declared.maxTokens > 0 ? declared.maxTokens : baseline.maxTokens,
      });
      const modelConfig = declared.thinkingLevels.length > 0
        ? withMappedThinkingLevels(model)
        : { ...model, reasoning: false, supportedThinkingLevels: [] };
      return {
        apiStyle: option.apiStyle,
        baseUrl: option.baseUrl,
        modelConfig,
        ...capabilitiesFromModelConfig(modelConfig),
      };
    }
    return this.withRowHeaders(scope, providerId, () =>
      this.bindingForUnscoped(scope, providerId, modelId),
    );
  }

  private async bindingForUnscoped(
    scope: VendorOAuthScope,
    providerId: string,
    modelId: string,
  ): Promise<VendorModelBinding | undefined> {
    const account = await this.accountForProvider(scope, providerId);
    if (!account) return undefined;
    await account.models.refresh({ providers: [account.vendorId] });
    const model = account.models.getModel(account.vendorId, modelId);
    if (!model) return undefined;
    return this.bindingFromOption(account, this.optionFor(model));
  }

  /**
   * Chat models the signed-in account can call right now.
   * `undefined` means the live list could not be read; callers keep the
   * pinned catalog.
   */
  private async liveAccountModels(
    scope: VendorOAuthScope,
    account: AccountModels,
  ): Promise<OAuthModelOption[] | undefined> {
    if (account.vendorId === "radius") return undefined;
    const cached = this.liveModelCache.get(account.providerId);
    if (cached) {
      const ttl = cached.models ? LIVE_MODELS_TTL_MS : LIVE_MODELS_NEGATIVE_TTL_MS;
      if (Date.now() - cached.at < ttl) return cached.models ?? undefined;
    }
    const pending = this.liveModelLoads.get(account.providerId);
    if (pending) return pending;
    const load = this.loadLiveAccountModels(scope, account).finally(() => {
      if (this.liveModelLoads.get(account.providerId) === load) this.liveModelLoads.delete(account.providerId);
    });
    this.liveModelLoads.set(account.providerId, load);
    return load;
  }

  private rememberLiveModels(
    scope: VendorOAuthScope,
    account: AccountModels,
    models: OAuthModelOption[] | null,
  ): OAuthModelOption[] | undefined {
    // The cache is state of the admission and Host that read it: an attempt that
    // already lost either leaves its answer with the caller, not in a later one.
    if (this.accountPublishable(scope, account)) {
      this.liveModelCache.set(account.providerId, { at: Date.now(), models });
    }
    return models ?? undefined;
  }

  /**
   * The vendor's own list, read through the attempt's captured owner. The fetch
   * is a transport this module cannot certify, so it is counted as uncontained;
   * the operation stays counted until the response is fully consumed.
   */
  private async loadLiveAccountModels(
    scope: VendorOAuthScope,
    account: AccountModels,
  ): Promise<OAuthModelOption[] | undefined> {
    return scope.track(async () => {
      let apiKey: string | undefined;
      let baseUrl: string | undefined;
      try {
        const resolved = await account.models.getAuth(account.vendorId);
        apiKey = resolved?.auth.apiKey;
        baseUrl = resolved?.auth.baseUrl;
      } catch (error) {
        this.log("warn", "vendor account auth unavailable for model list", {
          vendorId: account.vendorId,
          message: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
      const request = vendorModelListRequest({
        vendorId: account.vendorId,
        apiKey,
        baseUrl,
      });
      if (!request) return undefined;
      try {
        scope.nativeAttempt();
        const body = await readVendorModelList(request, this.deps.fetch ?? globalThis.fetch);
        const ids = parseVendorModelIds(account.vendorId, body, request.allowPolicyFallback);
        if (!ids || ids.length === 0) return this.rememberLiveModels(scope, account, null);
        const pinned = account.pinnedProvider?.getModels() ?? await account.models.getAvailable(account.vendorId);
        const known = new Map(pinned.map((model) => [model.id, model]));
        const wires = pinned.map((model) => ({
          id: model.id,
          api: model.api,
          baseUrl: model.baseUrl,
        }));
        const models = ids.flatMap((modelId) => {
          const pinnedModel = known.get(modelId);
          if (pinnedModel) return [this.optionFor(pinnedModel)];
          const wire = wireForLiveModel(account.vendorId, modelId, wires, request.accountBaseUrl);
          if (!wire?.api || !wire.baseUrl) return [];
          return [{
            modelId,
            apiStyle: apiStyleForWireApi(wire.api),
            baseUrl: wire.baseUrl,
          }];
        });
        if (models.length === 0) return this.rememberLiveModels(scope, account, null);
        return this.rememberLiveModels(scope, account, models);
      } catch (error) {
        this.log("warn", "vendor account model list failed", {
          vendorId: account.vendorId,
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof VendorModelListError
            ? { status: error.status, responseExcerpt: error.responseExcerpt }
            : {}),
        });
        return this.rememberLiveModels(scope, account, null);
      }
    });
  }

  private async bindingFromOption(
    account: AccountModels,
    option: OAuthModelOption,
  ): Promise<VendorModelBinding> {
    const published = await this.deps.modelConfigFor?.({
      providerId: account.providerId,
      vendorKey: account.vendorId,
      option,
    }).catch(() => undefined);
    const modelConfig = withMappedThinkingLevels(
      published ?? genericModelConfig(option.modelId, option.baseUrl),
    );
    const capabilities = capabilitiesFromModelConfig(modelConfig);
    return {
      apiStyle: option.apiStyle,
      baseUrl: option.baseUrl,
      modelConfig,
      ...capabilities,
    };
  }

  /**
   * The detached half of a login. It keeps its own attempt's admission and Host
   * for everything it does after the caller returned, and it stays counted until
   * pi-ai's flow has actually settled: cancel, refusal and disposal end the wait,
   * never the underlying work.
   */
  private async run(session: LoginSession, provider: Provider): Promise<void> {
    const { scope } = session;
    await scope.track(async () => {
      try {
        // The installation identity is a Host-global secret, not account data.
        // It is read through this attempt's own owner, so a replacement Host
        // refuses the read and the write instead of giving a new flow the id.
        const installationId = await this.installationIdFor(scope);
        session.controller.signal.throwIfAborted();
        // pi-ai owns the loopback listener or the device-code polling and never
        // reports its closure: the attempt's transport stays uncontained.
        scope.nativeAttempt();
        await this.withRowHeaders(scope, session.providerId, () =>
          session.account.models.login(
            session.vendorId,
            "oauth",
            this.interactionFor(session),
            { getDeviceId: () => installationId },
          ),
        );
        scope.assertCurrent();
        // A flow that ignored its abort signal may not complete a cancelled
        // attempt: the row, the credential and the "done" event are late effects.
        session.controller.signal.throwIfAborted();
        const accountLabel = provider.auth.oauth?.name || provider.name;
        await this.completeRow(scope, session, provider, accountLabel);
        this.push(session, {
          kind: "done",
          providerId: session.providerId,
          accountLabel,
        });
      } catch (error) {
        await this.discardRow(scope, session);
        if (session.controller.signal.aborted) {
          this.push(session, { kind: "cancelled" });
        } else {
          const message = error instanceof Error ? error.message : String(error);
          this.log("warn", "vendor account login failed", {
            vendorId: session.vendorId,
            message,
          });
          this.push(session, { kind: "error", message });
        }
      } finally {
        for (const pending of session.prompts.values()) {
          pending.reject(new Error("login finished"));
        }
        // A failed renderer push closes the dialog, it does not un-settle the
        // attempt: an unobserved rejection here would be the only symptom.
        await session.tail.catch(() => undefined);
        this.activity.release(session);
        this.logins.delete(session.loginId);
      }
    });
  }

  private async runPluginLogin(session: PluginLoginSession): Promise<void> {
    const { scope } = session;
    await scope.track(async () => {
      try {
        const bridge = this.deps.getPluginOAuthBridge?.();
        if (!bridge) throw new Error("provider OAuth is unavailable");
        // The plugin child process performs this login; its closure is not
        // observable from here, so the attempt stays explicitly uncontained.
        scope.nativeAttempt();
        const raw = await bridge.invokeProviderOAuth(
          session.pluginId,
          session.contributionId,
          {
            operation: "login",
            providerId: session.contributionId,
            loginId: session.loginId,
          },
          session.controller.signal,
          session.runtimeId,
        );
        if (session.cancelled) throw new Error("login cancelled");
        const credential = normalizePluginCredential(raw);
        await this.serialize(session.providerId, async () => {
          const row = (await this.rows(scope)).find(
            (candidate) => candidate.id === session.providerId,
          );
          if (!this.pluginLoginApplies(session, row, bridge)) {
            throw new Error("plugin provider changed during OAuth sign-in");
          }
          await this.writePluginCredential(scope, session.providerId, credential);
          // The write is admitted; only a provider that changed underneath it is
          // rolled back, and the rollback keeps the original owner.
          const savedRow = (await this.rows(scope)).find(
            (candidate) => candidate.id === session.providerId,
          );
          const savedProvider = this.deps.getPluginOAuthBridge?.()
            ?.listOAuthProviders()
            .find((candidate) => candidate.providerId === session.providerId);
          if (!this.pluginLoginApplies(session, savedRow, {
            listOAuthProviders: () => (savedProvider ? [savedProvider] : []),
          })) {
            await scope.call("secrets.delete", {
              secretRef: secretRefForProviderOauth(session.providerId),
            });
            throw new Error("plugin provider changed during OAuth sign-in");
          }
        });
        this.invalidateAccountModels(session.providerId);
        this.pushPluginEvent(session, {
          kind: "done",
          providerId: session.providerId,
          accountLabel: credential.accountLabel,
        });
      } catch {
        if (session.cancelled) {
          this.pushPluginEvent(session, { kind: "cancelled" });
        } else {
          // Callback errors are plugin-controlled and may contain token material.
          // Keep the user-facing diagnostic useful without reflecting the error.
          this.pushPluginEvent(session, {
            kind: "error",
            code: "PLUGIN_OAUTH_FAILED",
            message: "",
          });
          this.log("warn", "plugin provider OAuth sign-in failed", {
            pluginId: session.pluginId,
            providerId: session.providerId,
          });
        }
      } finally {
        for (const pending of session.prompts.values()) {
          pending.reject(new Error("login finished"));
        }
        await session.tail.catch(() => undefined);
        this.activity.release(session);
        this.pluginLogins.delete(session.loginId);
      }
    });
  }

  /**
   * One plugin provider row is owned by one plugin runtime. A reload replaces
   * that runtime, so an attempt admitted by the previous one may not store,
   * announce or retain a credential for the new one.
   */
  private pluginLoginApplies(
    session: PluginLoginSession,
    row: OAuthProviderRow | undefined,
    bridge: Pick<PluginOAuthBridge, "listOAuthProviders">,
  ): boolean {
    if (session.cancelled) return false;
    if (row?.ownerPluginId !== session.pluginId) return false;
    if (row.authKind !== OAUTH_AUTH_KIND) return false;
    if (row.enabled === false) return false;
    const current = bridge
      .listOAuthProviders()
      .find((candidate) => candidate.providerId === session.providerId);
    return current?.pluginId === session.pluginId && current.runtimeId === session.runtimeId;
  }

  private cancelPluginLogin(session: PluginLoginSession): void {
    if (session.cancelled) return;
    session.cancelled = true;
    session.controller.abort(new Error("login cancelled"));
    for (const pending of session.prompts.values()) {
      pending.reject(new Error("login cancelled"));
    }
  }

  private pushPluginEvent(
    session: PluginLoginSession,
    event: OAuthEventBody,
  ): void {
    session.tail = session.tail.then(() => {
      if (session.cancelled && event.kind !== "cancelled") return;
      // A plugin reload or a replaced Host retires the attempt: its progress may
      // not be published for the runtime that replaced it. Terminal events still
      // close the dialog.
      const terminal = TERMINAL_EVENT_KINDS.has(event.kind);
      if (!terminal && (!this.pluginRuntimeCurrent(session) || !session.scope.isCurrent())) {
        return;
      }
      this.deps.emit({
        ...event,
        loginId: session.loginId,
        vendorId: session.vendorId,
      } as OAuthLoginEvent);
    });
  }

  private async resolvePluginAuth(
    scope: VendorOAuthScope,
    row: OAuthProviderRow,
  ): Promise<ModelAuth> {
    if (!row.ownerPluginId || !row.hasOauth) {
      throw new Error(`plugin provider account not signed in: ${row.id}`);
    }
    // The runtime is read before the first await: the credential read below is
    // queued behind the per-row write chain, so a reload in that window must be
    // refused rather than handed this refresh and its credential.
    const bridge = this.deps.getPluginOAuthBridge?.();
    const provider = bridge
      ?.listOAuthProviders()
      .find((candidate) => candidate.providerId === row.id);
    const boundRuntime = provider?.runtimeId;
    const credential = await this.serialize(row.id, async () => {
      let current = await this.readPluginCredential(scope, row.id);
      if (!current) throw new Error(`plugin provider account not signed in: ${row.id}`);
      if (current.expiresAt !== undefined && current.expiresAt <= Date.now() + 30_000) {
        if (!current.refreshToken) throw new Error(`plugin provider credential expired: ${row.id}`);
        if (!bridge || !provider || boundRuntime === undefined) {
          throw new Error(`plugin provider OAuth is unavailable: ${row.id}`);
        }
        // The read above may already have outlived the runtime it was admitted
        // for: the refresh is never sent to the one that replaced it.
        this.assertPluginRuntime(provider, boundRuntime);
        const refreshController = new AbortController();
        this.pluginRefreshControllers.set(row.id, refreshController);
        this.activity.register(refreshController);
        let rawRefreshed: unknown;
        try {
          // The plugin child process performs the refresh and its vendor call:
          // neither closure is observable from this process.
          scope.nativeAttempt();
          rawRefreshed = await scope.track(() =>
            bridge.invokeProviderOAuth(
              provider.pluginId,
              provider.contributionId,
              {
                operation: "refresh",
                providerId: provider.contributionId,
                credential: current,
              },
              refreshController.signal,
              boundRuntime,
            ),
          );
        } finally {
          this.activity.release(refreshController);
          if (this.pluginRefreshControllers.get(row.id) === refreshController) {
            this.pluginRefreshControllers.delete(row.id);
          }
        }
        const refreshed = normalizePluginCredential(rawRefreshed);
        current = {
          ...refreshed,
          ...(refreshed.refreshToken ? {} : { refreshToken: current.refreshToken }),
          ...(refreshed.accountLabel ? {} : current.accountLabel ? { accountLabel: current.accountLabel } : {}),
          ...(refreshed.headers ? {} : current.headers ? { headers: current.headers } : {}),
        };
        const latest = (await this.rows(scope)).find((candidate) => candidate.id === row.id);
        if (
          !latest ||
          latest.ownerPluginId !== row.ownerPluginId ||
          latest.authKind !== OAUTH_AUTH_KIND ||
          latest.enabled === false
        ) {
          throw new Error(`plugin provider changed during OAuth refresh: ${row.id}`);
        }
        // A reload during the refresh retires it before the credential is
        // written, so the replacement never receives it even briefly.
        this.assertPluginRuntime(provider, boundRuntime);
        await this.writePluginCredential(scope, row.id, current);
        const savedRow = (await this.rows(scope)).find((candidate) => candidate.id === row.id);
        if (
          !savedRow ||
          savedRow.ownerPluginId !== row.ownerPluginId ||
          savedRow.authKind !== OAUTH_AUTH_KIND ||
          savedRow.enabled === false ||
          !this.pluginRuntimeLive(provider, boundRuntime)
        ) {
          await scope.call("secrets.delete", {
            secretRef: secretRefForProviderOauth(row.id),
          });
          throw new Error(`plugin provider changed during OAuth refresh: ${row.id}`);
        }
      }
      return current;
    });
    return {
      apiKey: credential.accessToken,
      ...(credential.headers ? { headers: credential.headers } : {}),
    };
  }

  private async readPluginCredential(
    scope: VendorOAuthScope,
    providerId: string,
  ): Promise<PluginProviderOAuthCredential | undefined> {
    const { value } = await scope.call<{ value?: string | null }>(
      "secrets.getForRuntime",
      { secretRef: secretRefForProviderOauth(providerId) },
    );
    if (!value) return undefined;
    try {
      return normalizePluginCredential(JSON.parse(value));
    } catch {
      this.log("warn", "stored plugin provider credential is not readable", { providerId });
      return undefined;
    }
  }

  private async writePluginCredential(
    scope: VendorOAuthScope,
    providerId: string,
    credential: PluginProviderOAuthCredential,
  ): Promise<void> {
    await scope.call("secrets.set", {
      secretRef: secretRefForProviderOauth(providerId),
      value: JSON.stringify(credential),
    });
  }

  private clearAccountModels(providerId: string): void {
    this.invalidateAccountModels(providerId);
    this.deps.onAccountRemoved?.(providerId);
  }

  private invalidateAccountModels(providerId: string): void {
    this.accountModels.delete(providerId);
    this.liveModelCache.delete(providerId);
    this.liveModelLoads.delete(providerId);
  }

  /** Point the row at a usable model now that the catalog can be read. */
  private async completeRow(
    scope: VendorOAuthScope,
    session: LoginSession,
    provider: Provider,
    accountLabel: string,
  ): Promise<void> {
    let options: OAuthModelOption[] = [];
    try {
      options = await this.modelsForScope(scope, session.providerId);
    } catch (error) {
      // A catalog that will not load is not worth failing a good login over;
      // the row stays selectable and the model picker retries later.
      this.log("warn", "vendor model catalog unavailable after login", {
        vendorId: session.vendorId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const chosen = options[0];
    const apiStyle = chosen?.apiStyle;
    const modelBindings: ModelBinding[] = [];
    for (const option of options) {
      const binding = await this.bindingForScope(scope, session.providerId, option.modelId).catch(
        () => undefined,
      );
      const levels = binding?.supportedThinkingLevels ?? ["off"];
      modelBindings.push({
        id: option.modelId,
        contextWindow: binding?.modelConfig.contextWindow ?? 128_000,
        maxTokens: binding?.modelConfig.maxTokens ?? 8_192,
        thinkingLevels: [...levels],
        defaultThinkingLevel: levels.includes("medium") ? "medium" : levels[0] ?? null,
      });
    }
    await scope.call("providers.update", {
      id: session.providerId,
      name: provider.auth.oauth?.name || provider.name,
      authKind: OAUTH_AUTH_KIND,
      oauthAccountLabel: accountLabel,
      baseUrl: chosen?.baseUrl ?? provider.baseUrl,
      ...(modelBindings.length > 0 ? { models: modelBindings } : {}),
      ...(apiStyle
        ? {
            apiStyle,
            protocol: protocolForApiStyle(apiStyle),
            defaultModelId: chosen?.modelId,
          }
        : {}),
    });
  }

  private async discardRow(scope: VendorOAuthScope, session: LoginSession): Promise<void> {
    if (!session.createdRow) return;
    try {
      await scope.call("providers.delete", { id: session.providerId });
      this.accountModels.delete(session.providerId);
      this.liveModelCache.delete(session.providerId);
      this.liveModelLoads.delete(session.providerId);
      this.deps.onAccountRemoved?.(session.providerId);
    } catch (error) {
      this.log("warn", "could not remove the half-created provider row", {
        vendorId: session.vendorId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private interactionFor(session: LoginSession): AuthInteraction {
    return {
      signal: session.controller.signal,
      prompt: (prompt) => this.ask(session, prompt),
      notify: (event) => this.notify(session, event),
    };
  }

  private ask(session: LoginSession, prompt: AuthPrompt): Promise<string> {
    const promptId = this.nextId();
    return new Promise<string>((resolve, reject) => {
      const cleanups: Array<() => void> = [];
      const settle = () => {
        session.prompts.delete(promptId);
        for (const cleanup of cleanups) cleanup();
      };
      const entry: PendingPrompt = {
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      };
      session.prompts.set(promptId, entry);

      // The flow cancels a prompt when it answers the step itself — a callback
      // that beats the paste box — so the renderer has to close that input.
      const abort = () => {
        this.push(session, { kind: "promptCancelled", promptId });
        entry.reject(new Error("prompt cancelled"));
      };
      for (const signal of [prompt.signal, session.controller.signal]) {
        if (!signal) continue;
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        cleanups.push(() => signal.removeEventListener("abort", abort));
      }

      this.push(session, {
        kind: "prompt",
        request: promptRequest(promptId, prompt),
      });
    });
  }

  private notify(session: LoginSession, event: AuthEvent): void {
    switch (event.type) {
      case "info":
        this.push(session, {
          kind: "info",
          message: event.message,
          links: event.links?.map((link) => ({
            url: link.url,
            label: link.label,
          })),
        });
        return;
      case "auth_url":
        this.pushAuthUrl(session, event.url, event.instructions);
        return;
      case "device_code":
        this.push(session, {
          kind: "deviceCode",
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          intervalSeconds: event.intervalSeconds,
          expiresInSeconds: event.expiresInSeconds,
        });
        return;
      case "progress":
        this.push(session, { kind: "progress", message: event.message });
    }
  }

  private pushAuthUrl(
    session: LoginSession,
    url: string,
    instructions?: string,
  ): void {
    session.tail = session.tail.then(async () => {
      // A retired attempt may not launch a browser or offer a URL for a dialog
      // that already closed, so both ends of the wait are checked.
      if (!this.publishable(session, "authUrl")) return;
      // Report whether the browser actually opened: when it did not, the
      // renderer has to offer the link for copying instead. The launch is a
      // counted, uncontained handoff of this attempt's own owner.
      const opened = await this.openConsentPage(session.scope, url);
      if (!this.publishable(session, "authUrl")) return;
      this.deps.emit({
        loginId: session.loginId,
        vendorId: session.vendorId,
        kind: "authUrl",
        url,
        instructions,
        opened,
      });
    });
  }

  /**
   * Whether an event of one attempt may still reach the renderer.
   *
   * Terminal events close something the renderer already shows, so they are
   * delivered even after the attempt lost its Host or its admission.
   * Everything else belongs to an attempt that is still the current one.
   */
  private publishable(session: LoginSession, kind: OAuthEventBody["kind"]): boolean {
    if (TERMINAL_EVENT_KINDS.has(kind)) return true;
    return !session.controller.signal.aborted && session.scope.isCurrent();
  }

  /**
   * Open the vendor's consent page for one attempt. `opened: false` is a
   * degradation, not a failure: the dialog offers the URL for copying. A
   * refusal (admission closed, Host replaced) is not a cancelled attempt.
   */
  private async openConsentPage(scope: VendorOAuthScope, url: string): Promise<boolean> {
    try {
      scope.nativeAttempt();
      return await this.deps.openExternal(url).then(
        () => true,
        () => false,
      );
    } catch {
      this.log("warn", "vendor account consent page was not opened", {});
      return false;
    }
  }

  private push(session: LoginSession, event: OAuthEventBody): void {
    session.tail = session.tail.then(() => {
      if (!this.publishable(session, event.kind)) return;
      this.deps.emit({
        ...event,
        loginId: session.loginId,
        vendorId: session.vendorId,
      } as OAuthLoginEvent);
    });
  }

  private async ensureCatalogModels(): Promise<MutableModels> {
    this.catalogPromise ??= Promise.resolve(
      this.createModels(this.emptyCredentials),
    );
    return this.catalogPromise;
  }

  private createModels(credentials: CredentialStore): MutableModels {
    if (this.deps.createModels) return this.deps.createModels(credentials);
    // pi-ai loads each flow through a variable import specifier so bundlers
    // cannot follow it into Node-only code; registering the static set keeps
    // login working in the packaged app. Named for the Bun binary, but the
    // flows themselves are plain Node.
    if (!this.oauthFlowsRegistered) {
      registerBunOAuthFlows();
      this.oauthFlowsRegistered = true;
    }
    return builtinModels({
      credentials,
      authContext: { env: async () => undefined, fileExists: async () => false },
      modelsStore: new InMemoryModelsStore(),
    });
  }

  private createAccount(
    scope: VendorOAuthScope,
    vendorId: string,
    providerId: string,
  ): AccountModels {
    const existing = this.accountModels.get(providerId);
    // A collection belongs to the Host that created it. After a replacement it is
    // dropped instead of being re-pointed at the new Host; work that is already
    // running keeps its own captured owner and refuses late effects.
    if (existing && this.accountOwnerCurrent(existing.owner)) return existing;
    if (existing) this.invalidateAccountModels(providerId);
    const account: AccountModels = {
      providerId,
      vendorId,
      owner: scope.owner,
      models: this.createModels(this.credentialsFor(scope, providerId, vendorId)),
    };
    const original = account.models.getProvider(vendorId);
    account.pinnedProvider = original;
    if (original && vendorId !== "radius") {
      let offered: Model<Api>[] | undefined;
      account.models.setProvider({
        ...original,
        getModels: () => offered ?? original.getModels(),
        getAllModels: () => [...(offered ?? original.getModels()), ...(original.getAllModels?.() ?? []).filter(model => model.type && model.type !== "chat")],
        // The successful live list is the account's entitlement authority.
        filterModels: (models, credential) => offered ? models : original.filterModels?.(models, credential) ?? models,
        refreshModels: async context => {
          // The account keeps the owner that created it: a refresh started after
          // a replacement is refused here instead of borrowing the Host that
          // replaced it, and it stays counted through publication rather than
          // only until the vendor list has been read.
          let refreshScope: VendorOAuthScope;
          try {
            refreshScope = this.activity.admit("model-refresh", account.owner);
          } catch {
            this.activity.report("vendor model refresh refused", { providerId });
            return;
          }
          await refreshScope.track(async () => {
            await original.refreshModels?.(context);
            if (!context.allowNetwork) return;
            context.signal.throwIfAborted();
            if (context.force) this.liveModelCache.delete(providerId);
            const live = await this.withRowHeaders(refreshScope, providerId, () =>
              this.liveAccountModels(refreshScope, account),
            );
            if (!live) return;
            const projected = await Promise.all(live.map(async option => {
              const config = withMappedThinkingLevels(await this.deps.modelConfigFor?.({
                providerId,
                vendorKey: account.vendorId,
                option,
              }).catch(() => undefined) ?? genericModelConfig(option.modelId, option.baseUrl));
              return {
                ...config, id: option.modelId, provider: vendorId,
                api: wireApiForStyle(option.apiStyle), baseUrl: option.baseUrl,
                // Generic limits and zero-price defaults are not published data.
                cost: config.source === "generic"
                  ? { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN }
                  : config.cost ?? { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN },
              } as Model<Api>;
            }));
            context.signal.throwIfAborted();
            // A publication is a late effect of this refresh: it only lands in
            // the account it was read for, while that account is still the one
            // registered for the row and its admission is still current.
            if (!this.accountPublishable(refreshScope, account)) return;
            await context.publish({
              update: () => {
                if (!this.accountPublishable(refreshScope, account)) return;
                offered = projected;
              },
            });
          });
        },
      });
    }
    this.accountModels.set(providerId, account);
    this.deps.onAccountModels?.(providerId, account.models);
    return account;
  }

  /** The account is still the one registered for its row, on this admission. */
  private accountPublishable(scope: VendorOAuthScope, account: AccountModels): boolean {
    return this.accountModels.get(account.providerId) === account && scope.isCurrent();
  }

  private accountOwnerCurrent(owner: VendorOAuthOwner): boolean {
    try {
      owner.assertCurrent();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The installation identity of this attempt's own Host.
   *
   * The identity is a Host-global secret, so it is resolved once per live owner
   * generation: every login admitted by the same Host shares that one read and
   * write, a replacement starts a new one, and a retired attempt refuses after
   * the wait instead of borrowing the identity of the Host that replaced it.
   */
  private installationIdFor(scope: VendorOAuthScope): Promise<string> {
    scope.assertCurrent();
    const cached = this.installationIdentity;
    if (cached && this.accountOwnerCurrent(cached.owner)) {
      return cached.read().then((id) => {
        scope.assertCurrent();
        return id;
      });
    }
    const { owner } = scope;
    const readInstallationId = this.readInstallationId;
    const read = readInstallationId
      ? () => readInstallationId(owner)
      : createInstallationIdentity(<T,>(method: string, params?: unknown) =>
          owner.call<T>(method, params),
        );
    this.installationIdentity = { owner, read };
    return read().then((id) => {
      scope.assertCurrent();
      return id;
    });
  }

  private async withRowHeaders<T>(
    scope: VendorOAuthScope,
    providerId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const row = (await this.rows(scope)).find((candidate) => candidate.id === providerId);
    return await runWithProviderHeaders(row?.headers, fn);
  }

  private async accountForProvider(
    scope: VendorOAuthScope,
    providerId: string,
  ): Promise<AccountModels | undefined> {
    const row = (await this.rows(scope)).find(
      (candidate) =>
        candidate.id === providerId &&
        candidate.authKind === OAUTH_AUTH_KIND &&
        typeof candidate.vendorKey === "string" &&
        candidate.vendorKey.length > 0,
    );
    return row?.vendorKey
      ? this.createAccount(scope, row.vendorKey, row.id)
      : undefined;
  }

  /**
   * Create a store scoped to one provider row. pi-ai still addresses the
   * credential by its builtin vendor id, while the app maps that id to the
   * row-specific encrypted secret ref.
   */
  private credentialsFor(
    scope: VendorOAuthScope,
    providerId: string,
    vendorId: string,
  ): CredentialStore {
    // The store belongs to the account, and the account to the Host that
    // created it. Each entry is admitted and counted on its own: pi-ai's locked
    // refresh is real work, so a replaced Host or a closed admission refuses it
    // instead of letting it reach the generation that is live now.
    const admission = () => this.activity.admit("account-credentials", scope.owner);
    return {
      read: async (requestedVendorId) => {
        if (requestedVendorId !== vendorId) return undefined;
        const entry = admission();
        return entry.track(() => this.readCredential(entry, providerId));
      },
      list: async () => {
        const entry = admission();
        return entry.track(async () => {
          const row = (await this.rows(entry)).find(
            (candidate) => candidate.id === providerId,
          );
          return row?.authKind === OAUTH_AUTH_KIND && row.hasOauth
            ? [{ providerId: vendorId, type: "oauth" }]
            : [];
        });
      },
      modify: async (requestedVendorId, fn) => {
        if (requestedVendorId !== vendorId) {
          throw new Error(`provider is not part of account ${providerId}`);
        }
        return this.serialize(providerId, async () => {
          const entry = admission();
          return entry.track(async () => {
            const current = await this.readCredential(entry, providerId);
            const next = await fn(current);
            if (next === undefined) return current;
            // A token write is a late effect of whoever refreshed it: it goes to
            // the original Host, and a replacement refuses instead of adopting it.
            entry.assertCurrent();
            await entry.call("secrets.set", {
              secretRef: secretRefForProviderOauth(providerId),
              value: JSON.stringify(next),
            });
            return next;
          });
        });
      },
      delete: async (requestedVendorId) => {
        if (requestedVendorId !== vendorId) {
          throw new Error(`provider is not part of account ${providerId}`);
        }
        return this.serialize(providerId, async () => {
          const entry = admission();
          await entry.track(() =>
            entry.call("secrets.delete", {
              secretRef: secretRefForProviderOauth(providerId),
            }),
          );
        });
      },
    };
  }

  private readonly emptyCredentials: CredentialStore = {
    read: async () => undefined,
    list: async () => [],
    modify: async (_providerId, fn) => fn(undefined),
    delete: async () => undefined,
  };

  private async readCredential(
    scope: VendorOAuthScope,
    providerId: string,
  ): Promise<Credential | undefined> {
    const { value } = await scope.call<{ value?: string | null }>(
      "secrets.getForRuntime",
      { secretRef: secretRefForProviderOauth(providerId) },
    );
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value) as Credential;
      return parsed?.type ? parsed : undefined;
    } catch {
      this.log("warn", "stored vendor credential is not readable", { providerId });
      return undefined;
    }
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async rows(scope: VendorOAuthScope): Promise<OAuthProviderRow[]> {
    const result = await scope.call<{ providers?: OAuthProviderRow[] }>(
      "providers.list",
      { includeDisabled: true },
    );
    return result.providers ?? [];
  }

  private nextId(): string {
    return this.deps.newId?.() ?? randomUUID();
  }

  private log(
    level: "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.deps.log?.(level, message, data);
  }
}
