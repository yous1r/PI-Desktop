import { randomUUID } from "node:crypto";
import type {
  AgentStatus,
  AppSettings,
  SessionCollaborationDelivery,
  SessionCollaborationMessage,
  SessionCollaborationSummary,
} from "@pi-desktop/shared";
import { DESKTOP_PRINCIPAL, type AgentHostBridge } from "../agent-host-bridge";
import { listReadyPluginModels, parsePluginModelKey } from "../plugin-agent-complete";
import type { McpControlInvokeInput } from "../mcp-control";

/** The Host transport one operation keeps. `generation`/`isAvailable` are the
 * HostProcess identity this module checks where the caller provides it. */
type Host = {
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  readonly generation?: unknown;
  isAvailable?(): boolean;
};
type Sidecar = { call<T>(method: string, params: Record<string, unknown>): Promise<T> };

/** Shared by the plugin and the sidebar: durable outcomes plus live activity. */
export async function readSessionCollaboration(
  host: Host,
  sidecar: Sidecar | null,
  sessionId: string,
): Promise<SessionCollaborationSummary> {
  const [summary, live] = await Promise.all([
    host.call<SessionCollaborationSummary>("session.collaboration.status", { sessionId }),
    sidecar?.call<{ status: AgentStatus }>("agent.getStatus", { sessionId }),
  ]);
  if (live?.status.sessionId === sessionId && live.status.isRunning) {
    return {
      ...summary,
      status: live.status.pendingToolConfirmations > 0 ? "waiting_permission" : "running",
      observedAt: new Date().toISOString(),
    };
  }
  return summary;
}

export type SessionCollaborationDependencies = {
  getHost: () => Host | null;
  getSidecar: () => Sidecar | null;
  getBridge: () => AgentHostBridge | null;
  getActiveTurn: (sessionId: string) => string | undefined;
  flushTranscript: () => Promise<boolean>;
  isPluginLoaded: (pluginId: string) => boolean;
  isQuitting: () => boolean;
  /** Shared Desktop admission probe (`handoffAdmission.isClosed`). Fresh
   * delivery effects are refused while it is closed; an unreadable probe is
   * treated as closed, never as permission. */
  isAdmissionClosed?: () => boolean;
  onChanged: () => void;
  log: (message: string, data: Record<string, unknown>) => void;
};

/**
 * Synchronous owner report for the Desktop hand-off inventory.
 *
 * `operations` counts open invoke/drain/settle lifetimes, registered before
 * their first await. Nested lifetimes (a settle that drains) count separately,
 * so it is an obligation bound, not a turn total. `resources` counts durable
 * settlement receipts this process still has to flush. `uncontainedResources`
 * stays zero: this service owns no native resource whose closure it cannot see.
 */
export type SessionCollaborationHandoffActivity = {
  operations: number;
  resources: number;
  uncontainedResources: number;
};

/** One operation's original Host, generation and runtime execution identity. */
type Owner = {
  host: Host;
  generation: unknown;
  bridge: AgentHostBridge | null;
  sidecar: Sidecar | null;
};

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, errorCode: code });
}

function text(input: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) fail("INVALID_ARGUMENT", `${key} must be a nonempty string`);
  return value.trim();
}

function messageKind(value: unknown): "task" | "message" {
  if (value === undefined) return "message";
  if (value !== "task" && value !== "message") fail("INVALID_ARGUMENT", "kind must be task or message");
  return value;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: string; errorCode?: string; data?: { errorCode?: string } };
  return value.data?.errorCode ?? value.errorCode ?? value.code;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try { return JSON.stringify(error) ?? String(error); } catch { return String(error); }
}

function delivery(message: SessionCollaborationMessage): SessionCollaborationDelivery {
  return {
    sessionId: message.targetSessionId,
    messageId: message.id,
    status: message.status,
    ...(message.turnId ? { turnId: message.turnId } : {}),
  };
}

/** Refusals that never reached a durable turn outcome for this delivery. */
const RETAINS_QUEUED_TASK = new Set(["HOST_BUSY", "HOST_UNAVAILABLE", "AGENT_UNAVAILABLE", "HOST_DISCONNECTED"]);

/** Coordinates reviewed operations; Rust owns all identity and outcome state. */
export function createSessionCollaborationService(deps: SessionCollaborationDependencies) {
  // Keyed by message id, but only shared inside one Host generation: a pass
  // that started on a replaced Host never satisfies a newer caller.
  const dispatching = new Map<string, { owner: Owner; operation: Promise<SessionCollaborationDelivery> }>();
  // Turn IDs awaiting settlement. The host keys the receipt by the turn row in
  // its own database, so an entry orphaned by a host restart is replayed there
  // by a later drain — never by the pass that observed the restart.
  const settlements = new Set<string>();
  let draining: Promise<void> | undefined;
  let dirty = false;
  let operations = 0;

  function admissionClosed(): boolean {
    try {
      return Boolean(deps.isAdmissionClosed?.() ?? false);
    } catch {
      // A gate that cannot be read must never read as permission.
      return true;
    }
  }

  function assertOpen(): void {
    if (admissionClosed()) fail("HOST_BUSY", "Session collaboration admission is closed");
  }

  function hostAvailable(host: Host): boolean {
    try {
      return host.isAvailable?.() !== false;
    } catch {
      return false;
    }
  }

  /** Count the operation before its first await so the report never loses it. */
  function beginOperation(): () => void {
    operations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      operations -= 1;
    };
  }

  function captureOwner(): Owner {
    if (deps.isQuitting()) fail("ABORTED", "The application is shutting down");
    const host = deps.getHost();
    if (!host) fail("HOST_UNAVAILABLE", "The host is unavailable");
    // The runtime identity is captured before any read so a replacement
    // bridge/sidecar appearing mid-operation is never adopted for this work.
    return { host, generation: host.generation, bridge: deps.getBridge(), sidecar: deps.getSidecar() };
  }

  /** The original Host instance, generation and liveness are still current. */
  function hostCurrent(owner: Owner): boolean {
    return !deps.isQuitting() && deps.getHost() === owner.host &&
      owner.host.generation === owner.generation && hostAvailable(owner.host);
  }

  /** The Agent runtime this operation captured is still the live one. */
  function runtimeCurrent(owner: Owner): boolean {
    return deps.getBridge() === owner.bridge && deps.getSidecar() === owner.sidecar;
  }

  function assertHost(owner: Owner, signal?: AbortSignal): void {
    if (signal?.aborted || deps.isQuitting()) fail("ABORTED", "The session operation was cancelled");
    if (!hostCurrent(owner)) fail("HOST_UNAVAILABLE", "The host restarted during the session operation");
  }

  function assertOwner(owner: Owner, signal?: AbortSignal): void {
    assertHost(owner, signal);
    if (!runtimeCurrent(owner)) fail("HOST_UNAVAILABLE", "The Agent runtime restarted during the session operation");
  }

  function sender(input: McpControlInvokeInput): { pluginId: string; sourceSessionId: string; sourceTurnId: string } {
    const context = input.pluginContext;
    if (!context?.sessionId || !context.turnId || !context.invocationId
      || deps.getActiveTurn(context.sessionId) !== context.turnId) {
      fail("PERMISSION_DENIED", "Sending requires an active, host-authenticated Agent tool invocation");
    }
    return { pluginId: context.pluginId, sourceSessionId: context.sessionId, sourceTurnId: context.turnId };
  }

  /**
   * Whether a failed attempt must leave the durable queued delivery intact.
   *
   * A dead or replaced owner cannot record its own outcome, and a closed or
   * busy admission refused work that never started. Terminalizing the ledger
   * row in either case would lose a queued task that a later drain can still
   * deliver, so only genuine delivery failures on the original owner persist.
   */
  function retainsQueuedTask(owner: Owner, message: SessionCollaborationMessage, error: unknown): boolean {
    if (deps.isQuitting() || !hostCurrent(owner)) return true;
    const code = errorCode(error);
    if (!code) return false;
    if (code === "HOST_BUSY") return true;
    // A full callback inbox is deferred until a later queue/turn change. It
    // must not turn a successfully completed original task into failure.
    if (message.kind === "completion" && code === "AGENT_BUSY") return true;
    return RETAINS_QUEUED_TASK.has(code);
  }

  async function dispatch(
    owner: Owner,
    message: SessionCollaborationMessage,
    signal?: AbortSignal,
  ): Promise<SessionCollaborationDelivery> {
    const shared = dispatching.get(message.id);
    if (shared && shared.owner.host === owner.host && shared.owner.generation === owner.generation) {
      return shared.operation;
    }
    const operation = (async () => {
      try {
        assertOwner(owner, signal);
        const current = (await owner.host.call<{ message?: SessionCollaborationMessage }>(
          "session.collaboration.message", { messageId: message.id },
        )).message;
        assertOwner(owner, signal);
        if (!current) fail("NOT_FOUND", "Session message not found");
        if (current.status !== "queued") return delivery(current);
        const { bridge, sidecar } = owner;
        if (!bridge || !sidecar) fail("HOST_UNAVAILABLE", "The Agent runtime is unavailable");
        if (!runtimeCurrent(owner)) fail("HOST_UNAVAILABLE", "The Agent runtime restarted during the session operation");
        if (bridge.queue.list(current.targetSessionId).some((entry) => entry.sessionMessageId === current.id)) {
          return delivery(current);
        }
        if (!deps.isPluginLoaded(current.pluginId)) fail("ABORTED", "The sending plugin is no longer enabled");
        // beginTurn rechecks the persisted authorization ceiling at execution,
        // including when a queued turn resumes after settings have changed.
        // The admission gate is the AgentHost's own shared gate, so a closure
        // here is the same refusal it would make; checking first means no
        // attempt is started at all.
        assertOwner(owner, signal);
        assertOpen();
        await bridge.agentHost.startTurn(DESKTOP_PRINCIPAL, {
          sessionId: current.targetSessionId,
          input: { text: current.content, sessionMessageId: current.id },
          admission: "queue",
          idempotencyKey: `session-message:${current.id}`,
          context: { requestId: `session-message:${current.id}` },
        });
        // The turn is admitted: finish its bookkeeping on the original owner
        // even when the caller has already cancelled.
        assertOwner(owner);
        const accepted = (await owner.host.call<{ message: SessionCollaborationMessage }>(
          "session.collaboration.message", { messageId: current.id },
        )).message;
        if (signal?.aborted) await cancel(owner, { sessionId: current.targetSessionId, messageId: current.id });
        deps.onChanged();
        return delivery(accepted);
      } catch (error) {
        if (!retainsQueuedTask(owner, message, error)) {
          // The host persists free text, so the code is embedded to keep the
          // stored failure machine-readable and bounded.
          const persisted = `${errorCode(error) ?? "FAILED"}: ${errorMessage(error)}`;
          await owner.host.call("session.collaboration.fail", {
            messageId: message.id,
            error: persisted.slice(0, 2000),
          }).catch((persistenceError: unknown) => deps.log("Session delivery failure could not be saved", {
            messageId: message.id, error: String(persistenceError),
          }));
        }
        throw error;
      }
    })();
    const entry = { owner, operation };
    dispatching.set(message.id, entry);
    try { return await operation; }
    finally { if (dispatching.get(message.id) === entry) dispatching.delete(message.id); }
  }

  async function cancel(owner: Owner, args: Record<string, unknown>) {
    const result = await owner.host.call<{
      sessionId: string; cancelled: true; sessionRetained: true; messageIds: string[]; runningTurnIds: string[];
    }>("session.collaboration.cancel", args);
    assertHost(owner);
    const { bridge } = owner;
    if (bridge) {
      for (const messageId of result.messageIds) await bridge.queue.cancelSessionMessage(result.sessionId, messageId);
      for (const turnId of result.runningTurnIds) {
        // The exact turn guard prevents a late cancellation from stopping a
        // newer task in this reusable session.
        if (deps.getActiveTurn(result.sessionId) === turnId) {
          await bridge.interruptSessionMessage(result.sessionId, turnId);
        }
      }
    }
    deps.onChanged();
    return { sessionId: result.sessionId, cancelled: true, sessionRetained: true };
  }

  async function drain(): Promise<void> {
    const release = beginOperation();
    try {
      // Re-entrant, self-healing: a caller arriving while a pass is running
      // flags dirty and awaits it, then re-checks. This also closes the narrow
      // window where a settlement is queued right as a running pass decides to
      // stop, so a completion callback is never deferred to an unrelated later
      // trigger.
      for (;;) {
        if (draining) {
          dirty = true;
          await draining;
          if (!dirty) return;
          continue;
        }
        if (!deps.getHost() || deps.isQuitting()) return;
        let owner: Owner;
        try { owner = captureOwner(); } catch { return; }
        // Once a pass observes an owner change this call stops: the retained
        // work belongs to a drain that starts on the new owner.
        let ownerChanged = false;
        draining = (async () => {
          do {
            // Cleared first so a throwing pass cannot keep re-running the loop.
            dirty = false;
            // A pass keeps the owner it captured. Settling work admitted
            // before a closure still finishes; starting a new dispatch does
            // not.
            if (settlements.size && await deps.flushTranscript()) {
              if (!hostCurrent(owner)) { ownerChanged = true; return; }
              for (const turnId of [...settlements]) {
                // Settling is idempotent host-side, so entries recorded
                // against a previous host are replayed by a later drain rather
                // than dropped. A failing call keeps its entry.
                await owner.host.call("session.collaboration.settle", { turnId });
                settlements.delete(turnId);
                if (!hostCurrent(owner)) { ownerChanged = true; return; }
              }
            }
            if (!hostCurrent(owner)) { ownerChanged = true; return; }
            // A closed admission finishes the settlement above and starts no
            // new dispatch.
            if (admissionClosed()) return;
            const pending = await owner.host.call<{ messages: SessionCollaborationMessage[] }>(
              "session.collaboration.pending", {},
            );
            // A pass that observed an owner change stops here. Its pending
            // messages stay queued for a drain that starts on the new owner.
            if (!hostCurrent(owner)) { ownerChanged = true; return; }
            await Promise.all(pending.messages.map(async (message) => {
              if (!hostCurrent(owner)) { ownerChanged = true; return; }
              try { await dispatch(owner, message); }
              catch (error) {
                deps.log("Session completion delivery is pending or failed", { messageId: message.id, error: String(error) });
              }
            }));
          } while (dirty);
        })();
        try { await draining; }
        finally { draining = undefined; }
        if (ownerChanged || !dirty) return;
        continue;
      }
    } finally { release(); }
  }

  return {
    async invoke(input: McpControlInvokeInput): Promise<unknown> {
      const release = beginOperation();
      try {
        if (input.source !== "plugin" || !input.pluginContext?.pluginId) {
          fail("PERMISSION_DENIED", "Session collaboration requires a trusted plugin context");
        }
        const args = input.args?.[0];
        if (input.args?.length !== 1 || !args || typeof args !== "object" || Array.isArray(args)) {
          fail("INVALID_ARGUMENT", "One session operation object is required");
        }
        const data = args as Record<string, unknown>;
        const owner = captureOwner();
        // Reads need the original Host only; effects additionally require the
        // Agent runtime captured for them.
        assertHost(owner, input.signal);
        switch (input.operation) {
          case "session/collaboration/status":
            await drain();
            assertHost(owner, input.signal);
            return readSessionCollaboration(owner.host, owner.sidecar, text(data, "sessionId")!);
          case "session/collaboration/list":
            await drain();
            assertHost(owner, input.signal);
            return owner.host.call("session.collaboration.list", {});
          case "session/collaboration/result":
            await drain();
            assertHost(owner, input.signal);
            return owner.host.call("session.collaboration.result", {
              sessionId: text(data, "sessionId"), messageId: text(data, "messageId", false), turnId: text(data, "turnId", false),
            });
          case "session/collaboration/cancel": {
            const result = await cancel(owner, {
              sessionId: text(data, "sessionId"), messageId: text(data, "messageId", false),
              pluginId: input.pluginContext.pluginId,
              ...(input.pluginContext.sessionId ? { sourceSessionId: input.pluginContext.sessionId } : {}),
            });
            await drain();
            return result;
          }
          case "session/collaboration/spawn":
          case "session/collaboration/send": {
            const source = sender(input);
            const spawn = input.operation.endsWith("/spawn");
            const content = text(data, spawn ? "task" : "content");
            const notify = data.notifyOnCompletion;
            if (notify !== undefined && typeof notify !== "boolean") fail("INVALID_ARGUMENT", "notifyOnCompletion must be a boolean");
            let model: { providerId: string; modelId: string } | null = null;
            if (spawn) {
              const [listed, settings] = await Promise.all([
                owner.host.call<{ providers: Parameters<typeof listReadyPluginModels>[0] }>("providers.list", { includeDisabled: false }),
                owner.host.call<AppSettings>("settings.get"),
              ]);
              assertOwner(owner, input.signal);
              const models = listReadyPluginModels(listed.providers, settings);
              const requested = text(data, "modelKey", false);
              // No isDefault fallback here: naming a default the user never
              // opted into delegation would spend a model the Task gate
              // refuses (issue #1183). Omitting modelKey must fall back to the
              // spawn path's own inheritance, not to an un opted-in default.
              const chosen = requested
                ? models.find((item) => item.key === requested)
                : models.find((item) => item.availableForSubagents);
              if (!chosen) fail("MODEL_NOT_CONFIGURED", "No matching configured model is available");
              // A worker the agent starts is AI-driven delegation, so naming a model here
              // needs that model's own `availableForSubagents` opt-in — the gate `Task.model`
              // already applies (ADR subagent-model-opt-in; #386). Inheriting stays open, and
              // naming the default is that inheritance spelled out, the way repeating a
              // definition's own pin is on the Task path.
              if (requested && !chosen.availableForSubagents && !chosen.isDefault) {
                fail("PERMISSION_DENIED", `Model "${requested}" is not enabled for AI delegation. Turn on "Available for AI delegation" for it in model settings, or omit modelKey to inherit.`);
              }
              model = parsePluginModelKey(chosen.key);
            }
            assertOwner(owner, input.signal);
            sender(input);
            // The ledger write is the new delivery effect, so admission and
            // owner identity are rechecked immediately before it.
            assertOpen();
            const response = await owner.host.call<{ message: SessionCollaborationMessage }>(`session.collaboration.${spawn ? "spawn" : "send"}`, {
              ...source, content,
              idempotencyKey: text(data, "idempotencyKey", false) ?? randomUUID(),
              ...(typeof notify === "boolean" ? { notifyOnCompletion: notify } : {}),
              ...(spawn ? { ...model, title: text(data, "title", false) }
                : { sessionId: text(data, "sessionId"), kind: messageKind(data.kind) }),
            });
            return dispatch(owner, response.message, input.signal);
          }
          default: fail("NOT_FOUND", "Unknown session collaboration operation");
        }
      } finally { release(); }
    },
    // The session ID stays part of the runtime callback contract; the host
    // resolves the receipt from the turn ID alone.
    async settle(_sessionId: string, turnId: string): Promise<void> {
      const release = beginOperation();
      try {
        const host = deps.getHost();
        if (!host || deps.isQuitting()) return;
        settlements.add(turnId);
        // Let final message_end enqueues from this event-loop turn reach the outbox.
        await new Promise<void>((resolve) => setImmediate(resolve));
        await drain();
        deps.onChanged();
      } finally { release(); }
    },
    drain,
    getHandoffActivity(): SessionCollaborationHandoffActivity {
      return { operations, resources: settlements.size, uncontainedResources: 0 };
    },
  };
}
