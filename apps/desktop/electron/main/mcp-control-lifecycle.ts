import type { ServerResponse } from "node:http";

/**
 * Synchronous owner report for the inbound MCP control transport.
 *
 * `operations` counts admitted handler lifetimes (accepted request until both
 * the detached handler promise settled and the HTTP response reached its
 * finish/close boundary) plus the start/stop filesystem effects the transport
 * performs. `resources` counts the live listener and accepted sockets.
 * `uncontainedResources` is monotonic: a handler or transport whose closure
 * could not be observed stays visible instead of being reported as zero.
 */
export type McpControlHandoffActivity = {
  operations: number;
  resources: number;
  uncontainedResources: number;
};

/** Error code used by the shared Desktop admission gate for a closed host. */
export const MCP_CONTROL_CLOSED_CODE = "HOST_BUSY";
/** JSON-RPC server-error code for a request refused before any effect. */
export const MCP_CONTROL_CLOSED_RPC_CODE = -32_001;

export function mcpControlClosed(): Error & { code: string } {
  return Object.assign(new Error("MCP control admission is closed"), {
    code: MCP_CONTROL_CLOSED_CODE,
  });
}

/** The owner report before anything is listening; safe for inspection. */
export const MCP_CONTROL_IDLE_ACTIVITY: McpControlHandoffActivity = Object.freeze({
  operations: 0,
  resources: 0,
  uncontainedResources: 0,
});

const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const bounded = (value: number): number => (value > MAX_COUNT ? MAX_COUNT : value);

/**
 * Lifecycle state and counters for one MCP control transport instance.
 *
 * This module owns only accounting, the permanent stop seal, the admission
 * probe and the bounded drain. Socket/server creation and the protocol stay in
 * `mcp-control.ts`, which owns the transport it created.
 */
export class McpControlLifecycle {
  private handlers = 0;
  private effects = 0;
  private sockets = 0;
  private listener = 0;
  private uncontained = 0;
  private sealed = false;
  private waiters: Array<() => void> = [];
  private readonly admissionClosed: () => boolean;

  constructor(isAdmissionClosed?: () => boolean) {
    this.admissionClosed = isAdmissionClosed ?? (() => false);
  }

  /**
   * Fresh work is refused once the owner stopped or the host admission closed.
   * A probe that throws or returns a non-boolean is treated as closed: an
   * unreadable gate must never read as permission.
   */
  isClosed(): boolean {
    if (this.sealed) return true;
    try {
      return Boolean(this.admissionClosed());
    } catch {
      return true;
    }
  }

  /** Stop is permanent: the instance never listens again. */
  seal(): void {
    this.sealed = true;
  }

  /** Startup token/manifest writes and stop filesystem effects. */
  beginEffect(): () => void {
    this.effects += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.effects -= 1;
    };
  }

  /** A handler lifetime, counted before the first effect of the request. */
  beginHandler(): () => void {
    this.handlers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.handlers -= 1;
      if (this.handlers === 0) this.releaseWaiters();
    };
  }

  listenerAcquired(): void {
    this.listener = 1;
  }

  /** Only called with evidence that the listener is actually closed. */
  listenerReleased(): void {
    this.listener = 0;
  }

  socketAcquired(): () => void {
    this.sockets += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.sockets -= 1;
    };
  }

  /** Unknown or unobserved underlying effects; never decremented. */
  retainUnknown(count = 1): void {
    if (!Number.isSafeInteger(count) || count <= 0) return;
    this.uncontained = bounded(this.uncontained + count);
  }

  /** Wait until the started handlers settle or the deadline passes. */
  async drain(deadlineAt: number): Promise<number> {
    if (this.handlers === 0) return 0;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer) clearTimeout(timer);
        const index = this.waiters.indexOf(done);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve();
      };
      this.waiters.push(done);
      const remaining = deadlineAt - Date.now();
      timer = setTimeout(done, remaining > 0 ? remaining : 0);
    });
    return this.handlers;
  }

  snapshot(): McpControlHandoffActivity {
    return {
      operations: this.handlers + this.effects,
      resources: this.listener + this.sockets,
      uncontainedResources: this.uncontained,
    };
  }

  private releaseWaiters(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}

/** Retain every created transport, including failed starts and retired owners.
 * An empty registry means startup has not created a transport. Clearing a
 * current-instance pointer must never erase pending work from this inventory. */
export function createMcpControlHandoffOwner() {
  const owners = new Set<{ getHandoffActivity(): McpControlHandoffActivity }>();
  return {
    retain(owner: { getHandoffActivity(): McpControlHandoffActivity }): void { owners.add(owner); },
    getHandoffActivity(): McpControlHandoffActivity {
      const result = { operations: 0, resources: 0, uncontainedResources: 0 };
      for (const owner of owners) {
        const value = owner.getHandoffActivity();
        if (!value || Reflect.ownKeys(value).length !== 3) throw new Error("HANDOFF_INVENTORY_UNAVAILABLE");
        for (const key of ["operations", "resources", "uncontainedResources"] as const) {
          const property = Object.getOwnPropertyDescriptor(value, key);
          if (!property || !("value" in property) || !Number.isSafeInteger(property.value) || property.value < 0) {
            throw new Error("HANDOFF_INVENTORY_UNAVAILABLE");
          }
          result[key] += property.value;
          if (!Number.isSafeInteger(result[key])) throw new Error("HANDOFF_INVENTORY_UNAVAILABLE");
        }
      }
      return result;
    },
  };
}

/**
 * Resolve once the response can no longer write more of the handler's result.
 *
 * `finish` is the flush boundary; `close`/`error` cover a caller that
 * disconnected first. A keep-alive socket after `finish` is not retained work,
 * and an early disconnect does not release the handler promise itself.
 */
export function whenResponseSettled(result: ServerResponse): Promise<void> {
  if (result.writableFinished || result.destroyed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      result.off("finish", done);
      result.off("close", done);
      result.off("error", done);
      resolve();
    };
    result.once("finish", done);
    result.once("close", done);
    result.once("error", done);
  });
}
