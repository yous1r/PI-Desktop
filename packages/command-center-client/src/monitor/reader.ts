import {
  onContextInvalidated,
  requireBoundContext,
  type CommandCenterObservationContext,
} from "../context.js";
import { decodePage, PageCollection, readerLimits, type DecodedPage } from "./pages.js";
import type {
  CommandCenterMonitorCancellation,
  CommandCenterMonitorPageLoader,
  CommandCenterMonitorReader,
  CommandCenterMonitorReaderLimits,
  CommandCenterMonitorReaderState,
  CommandCenterMonitorReadFailure,
  CommandCenterMonitorRefreshResult,
} from "./types.js";

interface ReadOperation {
  controller: AbortController;
  collection: PageCollection | null;
  resolve: (result: CommandCenterMonitorRefreshResult) => void;
}

class MonitorReader implements CommandCenterMonitorReader {
  readonly #context: CommandCenterObservationContext;
  readonly #loader: CommandCenterMonitorPageLoader;
  readonly #limits: Readonly<CommandCenterMonitorReaderLimits>;
  #state: CommandCenterMonitorReaderState = Object.freeze({ status: "idle", projection: null });
  #current?: ReadOperation;
  #pendingLoads = 0;
  #closed?: "context_invalidated" | "disposed";
  #detach: () => void;

  constructor(
    context: CommandCenterObservationContext,
    loader: CommandCenterMonitorPageLoader,
    limits: Readonly<CommandCenterMonitorReaderLimits>,
  ) {
    this.#context = context;
    this.#loader = loader;
    this.#limits = limits;
    this.#detach = onContextInvalidated(context, () => this.#close("context_invalidated"));
  }

  getState(): CommandCenterMonitorReaderState {
    return this.#state;
  }

  refresh(): Promise<CommandCenterMonitorRefreshResult> {
    if (this.#closed) return Promise.resolve(Object.freeze({ kind: "cancelled", reason: this.#closed }));
    requireBoundContext(this.#context);
    let resolve!: ReadOperation["resolve"];
    const result = new Promise<CommandCenterMonitorRefreshResult>((done) => { resolve = done; });
    const operation: ReadOperation = { controller: new AbortController(), collection: null, resolve };
    const previous = this.#current;
    this.#current = operation;
    this.#state = Object.freeze({ status: "loading", projection: this.#state.projection });
    if (previous) this.#cancelOperation(previous, "superseded");
    // Abort listeners may synchronously revoke/dispose or start a newer refresh.
    if (!this.#owns(operation)) return result;
    if (this.#pendingLoads >= this.#limits.maxPendingLoads) {
      this.#fail(operation, "busy");
      return result;
    }
    operation.collection = new PageCollection(this.#limits);
    void this.#read(operation);
    return result;
  }

  cancel(): boolean {
    const operation = this.#current;
    if (!operation) return false;
    this.#current = undefined;
    this.#state = Object.freeze({ status: "cancelled", projection: this.#state.projection, reason: "cancelled" });
    this.#cancelOperation(operation, "cancelled");
    return true;
  }

  dispose(): void {
    this.#close("disposed");
  }

  #owns(operation: ReadOperation): boolean {
    return this.#closed === undefined && this.#current === operation;
  }

  #cancelOperation(operation: ReadOperation, reason: CommandCenterMonitorCancellation): void {
    operation.collection = null;
    operation.resolve(Object.freeze({ kind: "cancelled", reason }));
    operation.controller.abort();
  }

  #close(reason: "context_invalidated" | "disposed"): void {
    if (this.#closed) return;
    this.#closed = reason;
    const operation = this.#current;
    this.#current = undefined;
    this.#state = Object.freeze({ status: reason === "disposed" ? "disposed" : "invalidated", projection: null });
    this.#detach();
    if (operation) this.#cancelOperation(operation, reason);
  }

  #fail(operation: ReadOperation, reason: CommandCenterMonitorReadFailure): void {
    if (!this.#owns(operation)) return;
    this.#current = undefined;
    operation.collection = null;
    this.#state = Object.freeze({
      status: reason === "inconsistent_generation" ? "resync_required" : "error",
      projection: this.#state.projection,
      reason,
    });
    operation.resolve(Object.freeze({ kind: "failed", reason }));
  }

  async #read(operation: ReadOperation): Promise<void> {
    let token: string | undefined;
    while (this.#owns(operation)) {
      let input: unknown;
      this.#pendingLoads += 1;
      try {
        input = await this.#loader(token, operation.controller.signal);
      } catch {
        this.#fail(operation, "load_failed");
        return;
      } finally {
        // Cancellation resolves the caller promptly but never frees unsettled I/O capacity.
        this.#pendingLoads -= 1;
      }
      if (!this.#owns(operation)) return;
      let decoded: DecodedPage;
      try {
        decoded = decodePage(input);
      } catch {
        this.#fail(operation, "invalid_page");
        return;
      }
      // Untrusted accessors can revoke the scope while the parser reads a page.
      if (!this.#owns(operation) || !operation.collection) return;
      const failure = operation.collection.append(decoded);
      if (failure) {
        this.#fail(operation, failure);
        return;
      }
      if (decoded.page.nextPage === undefined) {
        const projection = operation.collection.complete();
        operation.collection = null;
        this.#current = undefined;
        this.#state = Object.freeze({ status: "ready", projection });
        operation.resolve(Object.freeze({ kind: "published", projection }));
        return;
      }
      token = decoded.page.nextPage;
    }
  }
}

/**
 * Create a read-only model in an already bound authenticated observation context.
 * The trusted adapter provides page provenance; cursor consistency is not authorization.
 */
export function createCommandCenterMonitorReader(
  context: CommandCenterObservationContext,
  loader: CommandCenterMonitorPageLoader,
  limits?: Partial<CommandCenterMonitorReaderLimits>,
): CommandCenterMonitorReader {
  requireBoundContext(context);
  if (typeof loader !== "function") throw new TypeError("COMMAND_CENTER_CLIENT_INVALID_MONITOR_LOADER");
  return new MonitorReader(context, loader, readerLimits(limits));
}
