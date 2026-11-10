/**
 * Ownership, admission and activity accounting for vendor-account OAuth (H1).
 *
 * pi-ai owns the login flows, the loopback callback server, device-code polling
 * and the locked token refresh; the plugin runtime owns a child process that
 * performs plugin provider logins and refreshes. Neither reports closure, so
 * this owner counts what it can prove and keeps the rest explicit:
 *
 *  - `operations` counts one unit per login attempt, account auth resolution,
 *    plugin credential refresh, model-list read or browser launch from entry
 *    until the underlying promise settles. Cancelling a login, refusing a
 *    caller or disposing the service never releases a count that real work
 *    still holds.
 *  - `resources` is the app-held handle set (login sessions and plugin refresh
 *    controllers) whose teardown this module can observe.
 *  - `uncontainedResources` counts handoffs whose closure is unobservable: the
 *    pi-ai flow (loopback listener / device polling), the plugin child process,
 *    the vendor model-list HTTP transport and the external browser. It never
 *    clears, so the vendor-oauth family stays an explicit blocker.
 *
 * Attribution is per operation, never one mutable field: `capture()` reads the
 * original Host/generation once at the entry point, and every late effect of
 * that operation calls that same Host and refuses once it was replaced. A later
 * entry can therefore never re-point earlier work at a replacement.
 */
import { ExternalResourceActivity } from "./external-resource-activity.ts";

export type VendorOAuthHostCall = <T = unknown>(
  method: string,
  params?: unknown,
) => Promise<T>;

/** The real Host that admitted the work, captured once, with a currency check. */
export type VendorOAuthOwner = {
  /** A call bound to the captured Host generation, never the live one. */
  call: VendorOAuthHostCall;
  /** Throws once the original Host/generation is gone. */
  assertCurrent: () => void;
};

/** Which plugin runtime an operation was admitted for. */
export type VendorOAuthAttribution = {
  pluginId: string;
  runtimeId: string;
};

export type VendorOAuthHandoffActivity = {
  operations: number;
  resources: number;
  uncontainedResources: number;
};

export type VendorOAuthActivityOptions = {
  /** The shared Desktop admission gate, injected by Main composition. */
  isAdmissionClosed?: () => boolean;
  /** Captures the original Host/generation at an entry point, once per operation. */
  captureOwner?: () => VendorOAuthOwner;
  /**
   * Host access used only when Main composition injects no owner capture.
   * Existing tests and tooling keep working; production must inject the owner.
   */
  call: VendorOAuthHostCall;
  log?: (
    level: "info" | "warn" | "error",
    message: string,
    data?: Record<string, unknown>,
  ) => void;
};

export class VendorOAuthActivity {
  private readonly base: ExternalResourceActivity;
  private readonly options: VendorOAuthActivityOptions;
  private readonly resources = new Set<object>();
  private sealed = false;

  constructor(options: VendorOAuthActivityOptions) {
    this.options = options;
    this.base = new ExternalResourceActivity(
      () => this.sealed || options.isAdmissionClosed?.() === true,
    );
  }

  assertOpen(): void {
    this.base.assertOpen();
  }

  /** One entry's immutable attribution. The gate is checked before anything starts. */
  capture(work: string, attribution?: VendorOAuthAttribution): VendorOAuthScope {
    return this.admit(work, this.captureOwner(), attribution);
  }

  /**
   * Admission for work whose owner was captured earlier than this call: an
   * account's credential store and model collection outlive the operation that
   * created them, so they keep that original Host instead of capturing a fresh
   * owner and borrowing the generation that replaced it. The gate and the
   * retained owner are checked exactly as at a normal entry point.
   */
  admit(
    work: string,
    owner: VendorOAuthOwner,
    attribution?: VendorOAuthAttribution,
  ): VendorOAuthScope {
    this.base.assertOpen();
    owner.assertCurrent();
    this.base.assertOpen();
    return new VendorOAuthScope(this, work, owner, attribution);
  }

  private captureOwner(): VendorOAuthOwner {
    if (this.options.captureOwner) return this.options.captureOwner();
    // No composition owner: follow the injected call and refuse once the gate closes.
    return {
      call: (method, params) => this.options.call(method, params),
      assertCurrent: () => this.base.assertOpen(),
    };
  }

  /** Counts to real settlement; a refused or cancelled caller does not release it. */
  track<T>(operation: () => Promise<T>): Promise<T> {
    return this.base.track(operation);
  }

  /** An app-held handle whose teardown this module can observe. */
  register(resource: object): void {
    this.resources.add(resource);
  }

  release(resource: object): void {
    this.resources.delete(resource);
  }

  /** A transport or native handoff whose closure this module cannot observe. */
  nativeAttempt(): void {
    this.base.nativeAttempt();
  }

  /** Permanently refuses new work; admitted work keeps reporting until it settles. */
  seal(): void {
    this.sealed = true;
  }

  report(message: string, data?: Record<string, unknown>): void {
    try {
      this.options.log?.("warn", message, data);
    } catch {
      // Reporting must never decide an operation's outcome.
    }
  }

  snapshot(): VendorOAuthHandoffActivity {
    const base = this.base.snapshot(this.resources.size);
    return {
      operations: base.operations,
      resources: base.resources,
      uncontainedResources: base.uncontainedResources,
    };
  }
}

/** One entry's immutable attribution plus its counted-operation helpers. */
export class VendorOAuthScope {
  readonly work: string;
  /** The original owner captured synchronously at entry; never reassigned. */
  readonly owner: VendorOAuthOwner;
  /** The plugin runtime this operation was admitted for, when it has one. */
  readonly attribution?: VendorOAuthAttribution;
  private readonly activity: VendorOAuthActivity;

  constructor(
    activity: VendorOAuthActivity,
    work: string,
    owner: VendorOAuthOwner,
    attribution?: VendorOAuthAttribution,
  ) {
    this.activity = activity;
    this.work = work;
    this.owner = owner;
    this.attribution = attribution;
  }

  isCurrent(): boolean {
    try {
      this.assertCurrent();
      return true;
    } catch {
      return false;
    }
  }

  /** Gate open and this entry's own original owner still current. */
  assertCurrent(): void {
    this.activity.assertOpen();
    this.owner.assertCurrent();
  }

  /** Counts to real settlement; refusal or cancellation does not release it. */
  track<T>(operation: () => Promise<T>): Promise<T> {
    return this.activity.track(operation);
  }

  /** One Host call of this operation, always against its original Host. */
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.assertCurrent();
    const result = await this.owner.call<T>(method, params);
    // The wait can outlive the admission or the Host: a result that arrives
    // afterwards is a late effect of a generation that is gone, so it is
    // refused instead of being consumed as if it were current.
    this.assertCurrent();
    return result;
  }

  /** A transport or native handoff of this operation whose closure is unobservable. */
  nativeAttempt(): void {
    this.assertCurrent();
    this.activity.nativeAttempt();
  }
}
