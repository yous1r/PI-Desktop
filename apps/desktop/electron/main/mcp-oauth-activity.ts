import { ExternalResourceActivity } from "./external-resource-activity.ts";
import type { McpOAuthCall, McpOAuthLog } from "./mcp-oauth-protocol.ts";

export type McpOAuthOwner = { call: McpOAuthCall; assertCurrent: () => void };
export type McpOAuthAuthority = {
  isAdmissionClosed: () => boolean;
  captureOwner: () => McpOAuthOwner;
  fetchImpl?: typeof fetch;
  log?: McpOAuthLog;
};
export const oauthRetired = () => Object.assign(new Error("OAuth login cancelled or operation retired"), { code: "OAUTH_RETIRED" });

/** Owns original work, including detached callback/setup work after a login is cancelled. */
export class McpOAuthActivity {
  readonly activity: ExternalResourceActivity;
  readonly scopes = new Set<McpOAuthOperation>();
  readonly resources = new Set<object>();
  private uncertainty = 0;
  private readonly deps: McpOAuthAuthority;
  constructor(deps: McpOAuthAuthority) { this.deps = deps; this.activity = new ExternalResourceActivity(deps.isAdmissionClosed); }
  capture(keys: string[] = [], retireable = true): McpOAuthOperation {
    this.activity.assertOpen();
    const owner = this.deps.captureOwner();
    owner.assertCurrent();
    this.activity.assertOpen();
    return new McpOAuthOperation(this, owner, keys, this.deps.fetchImpl ?? globalThis.fetch, retireable);
  }
  retire(keys: string[]): void {
    for (const scope of [...this.scopes]) if (scope.retireable && scope.keys.some(key => keys.includes(key))) scope.cancel();
  }
  dispose(): void { this.activity.seal(); for (const scope of this.scopes) scope.cancel(); }
  uncertain(): void { this.uncertainty = Math.min(Number.MAX_SAFE_INTEGER, this.uncertainty + 1); }
  report(message: string): void {
    try { if (this.deps.log) this.deps.log("error", message); else console.error(message); }
    catch { console.error(message); }
  }
  snapshot() {
    const result = this.activity.snapshot(this.resources.size);
    return { ...result, uncontainedResources: Math.min(Number.MAX_SAFE_INTEGER, result.uncontainedResources + this.uncertainty) };
  }
}

export class McpOAuthOperation {
  readonly controller = new AbortController();
  readonly keys: string[];
  readonly retireable: boolean;
  private references = 0;
  private readonly activity: McpOAuthActivity;
  private readonly owner: McpOAuthOwner;
  private readonly fetch: typeof fetch;
  constructor(activity: McpOAuthActivity, owner: McpOAuthOwner, keys: string[], fetchImpl: typeof fetch, retireable: boolean) {
    this.activity = activity; this.owner = owner; this.keys = keys; this.fetch = fetchImpl; this.retireable = retireable;
  }
  assertCurrent = (): void => {
    this.activity.activity.assertOpen();
    this.owner.assertCurrent();
    if (this.controller.signal.aborted) throw oauthRetired();
  };
  cancel(): void { this.controller.abort(); }
  nativeAttempt(): void { this.assertCurrent(); this.activity.activity.nativeAttempt(); }
  async track<T>(operation: () => Promise<T>): Promise<T> {
    this.references++; this.activity.scopes.add(this);
    try { return await this.activity.activity.track(operation); }
    finally { if (--this.references === 0) this.activity.scopes.delete(this); }
  }
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    return this.track(async () => {
      this.assertCurrent();
      let result: T;
      try { result = await this.owner.call<T>(method, params); }
      catch (error) {
        const detail = error && typeof error === "object" ? error as { code?: unknown; errorCode?: unknown } : {};
        const code = detail.errorCode ?? detail.code;
        if (typeof detail.code !== "number" && !(typeof code === "string" && !["HOST_UNAVAILABLE", "HOST_TIMEOUT", "TIMEOUT", "TRANSPORT_LOST"].includes(code))) this.activity.uncertain();
        throw error;
      }
      // An admitted write is never undone when its caller retires.
      this.assertCurrent();
      return result;
    });
  }
  async request<T>(url: string, init: RequestInit, read: (response: Response) => Promise<T>): Promise<T> {
    return this.track(async () => {
      this.nativeAttempt();
      const response = await this.fetch(url, { ...init, signal: this.controller.signal });
      try {
        this.assertCurrent();
        const value = await read(response);
        this.assertCurrent();
        return value;
      } finally {
        // Unused probe/error bodies also own transport resources until cancellation completes.
        if (response.body && !response.bodyUsed) {
          try { await response.body.cancel(); }
          catch { this.activity.uncertain(); this.activity.report("MCP OAuth response cleanup could not be confirmed"); }
        }
      }
    });
  }
}
