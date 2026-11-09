import type { TrustedExtensionSidecarBridge } from "@pi-desktop/host-runtime";
import type { TrustedExtensionCommand, TrustedExtensionDiagnostic, TrustedExtensionLoadReport, TrustedExtensionUiRequestEnvelope } from "@pi-desktop/shared";
import type { AgentExtensionBridge, AgentExtensionUiSource } from "./agent-extension-ui";
import type { AgentHostBridge } from "./agent-host-bridge";
import type { HostProcess } from "./host-process";

type Host = Pick<HostProcess, "call" | "generation" | "isAvailable">;
type QueueBridge = Pick<AgentHostBridge, "queue">;
type Options = {
  getHost: () => Host | null; getQueueBridge: () => QueueBridge | null;
  current: () => boolean; isAdmissionClosed: () => boolean; ui: AgentExtensionBridge;
  broadcastEvent: (event: string, args: unknown[]) => void;
};
type Binding = { host: Host | null; generation: string | undefined; ui: AgentExtensionUiSource };
const failure = (errorCode: string) => Object.assign(new Error(errorCode === "HOST_BUSY" ? "Host admission is closed" : "Extension service owner is unavailable"), { errorCode });
export type TrustedExtensionServices = ReturnType<typeof createTrustedExtensionServices>;

/** Original Desktop service calls remain owned after cancellation, rebind, and disposal. */
export function createTrustedExtensionServices(options: Options) {
  let disposed = false, operations = 0, uncontainedResources = 0;
  const sources = new Set<AgentExtensionUiSource>();
  let binding = createBinding();
  function createBinding(): Binding {
    const host = options.getHost();
    const next: Binding = { host, generation: host?.generation, ui: options.ui.bindSource(() => assertBinding(next)) };
    sources.add(next.ui);
    return next;
  }
  function assertBinding(original: Binding): void {
    if (disposed || binding !== original || !options.current() || !original.host || options.getHost() !== original.host ||
      original.host.generation !== original.generation || !original.host.isAvailable()) throw failure("HOST_UNAVAILABLE");
    if (options.isAdmissionClosed()) throw failure("HOST_BUSY");
  }
  async function dispatch<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) {
      const code = error && typeof error === "object" && "errorCode" in error ? error.errorCode : undefined;
      const answered = error && typeof error === "object" && "code" in error && typeof error.code === "number";
      if (!answered && !(typeof code === "string" && !["HOST_UNAVAILABLE", "HOST_TIMEOUT", "TIMEOUT", "TRANSPORT_LOST"].includes(code))) {
        uncontainedResources = Math.min(Number.MAX_SAFE_INTEGER, uncontainedResources + 1);
      }
      throw error;
    }
  }
  async function run<T>(sessionId: string | undefined, operation: (original: Binding, assertCurrent: () => void) => Promise<T>): Promise<T> {
    const original = binding; assertBinding(original);
    const assertSession = sessionId === undefined ? () => {} : original.ui.capture(sessionId);
    const assertCurrent = () => { assertBinding(original); assertSession(); };
    operations++;
    try { return await operation(original, assertCurrent); } finally { operations--; }
  }
  const callbacks: Pick<TrustedExtensionSidecarBridge, "publishCommands" | "publishDiagnostics" | "requestUi" | "configureModel" | "queuePush" | "queuePrioritize"> = {
    publishCommands: params => binding.ui.publishCommands(String(params.sessionId ?? ""),
      Array.isArray(params.commands) ? params.commands as TrustedExtensionCommand[] : []),
    publishDiagnostics: params => binding.ui.publishDiagnostics(String(params.sessionId ?? ""),
      Array.isArray(params.diagnostics) ? params.diagnostics as TrustedExtensionDiagnostic[] : [],
      Array.isArray(params.reports) ? params.reports as TrustedExtensionLoadReport[] : []),
    requestUi: params => binding.ui.requestUi(readUiEnvelope(params)),
    configureModel: params => {
      const sessionId = String(params.sessionId ?? "").trim();
      return run(sessionId, async (original, assertCurrent) => {
        assertCurrent();
        const host = original.host; if (!host) throw failure("HOST_UNAVAILABLE");
        const result = await dispatch(() => host.call<{ session?: { providerId?: string; modelId?: string; thinkingLevel?: string } | null }>("session.configure", {
          id: sessionId, mode: String(params.mode ?? "agent"), providerId: String(params.providerId ?? ""), modelId: String(params.modelId ?? ""),
          thinkingLevel: typeof params.thinkingLevel === "string" ? params.thinkingLevel : undefined,
        }));
        assertCurrent();
        if (result.session) options.broadcastEvent("session:modelChanged", [{ sessionId,
          modelKey: result.session.providerId && result.session.modelId ? `${result.session.providerId}/${result.session.modelId}` : null,
          thinkingLevel: result.session.thinkingLevel }]);
        return { ok: Boolean(result.session), session: result.session ?? null };
      });
    },
    queuePush: params => run(String(params.sessionId ?? ""), async (_original, assertCurrent) => {
      const queueBridge = options.getQueueBridge(); if (!queueBridge) throw failure("HOST_UNAVAILABLE");
      assertCurrent();
      const result = await dispatch(() => queueBridge.queue.push({ sessionId: String(params.sessionId ?? ""), content: String(params.content ?? ""),
        ...(typeof params.idempotencyKey === "string" ? { idempotencyKey: params.idempotencyKey } : {}) }));
      assertCurrent(); if (options.getQueueBridge() !== queueBridge) throw failure("HOST_UNAVAILABLE");
      return result;
    }),
    queuePrioritize: params => run(undefined, async (_original, assertCurrent) => {
      const queueBridge = options.getQueueBridge(); if (!queueBridge) throw failure("HOST_UNAVAILABLE");
      assertCurrent(); await dispatch(() => queueBridge.queue.prioritize(String(params.id ?? "")));
      assertCurrent(); if (options.getQueueBridge() !== queueBridge) throw failure("HOST_UNAVAILABLE");
      return { ok: true };
    }),
  };
  return { ...callbacks,
    rebindHost(expectedHost: object): void {
      const host = options.getHost();
      if (disposed || !options.current() || host !== expectedHost || !host?.isAvailable()) throw failure("HOST_UNAVAILABLE");
      if (binding.host === host && binding.generation === host.generation) return;
      if (options.isAdmissionClosed()) throw failure("HOST_BUSY");
      binding.ui.dispose(); binding = createBinding();
    },
    captureSession: (sessionId: string) => binding.ui.captureSession(sessionId),
    dispose(): void { disposed = true; for (const source of sources) source.dispose(); },
    getHandoffActivity() {
      let total = operations, inputs = 0;
      for (const source of sources) {
        const activity = source.getHandoffActivity(); total += activity.operations; inputs += activity.inputs;
        if ((disposed || source !== binding.ui) && activity.operations === 0 && activity.inputs === 0) sources.delete(source);
      }
      return { operations: total, inputs, uncontainedResources };
    },
  };
}

/** Narrow the existing UI envelope at the reverse-RPC boundary without a new wire format. */
function readUiEnvelope(params: Record<string, unknown>): TrustedExtensionUiRequestEnvelope {
  const invalid = () => { throw Object.assign(new Error("Invalid extension UI request"), { errorCode: "INVALID_ARGUMENT" }); };
  if (typeof params.sessionId !== "string" || typeof params.extensionId !== "string" || typeof params.extensionLabel !== "string" ||
    (params.requestId !== undefined && typeof params.requestId !== "string")) return invalid();
  const request = params.request;
  if (!request || typeof request !== "object" || !("kind" in request)) return invalid();
  const text = (value: unknown): value is string | undefined => value === undefined || typeof value === "string";
  let valid = false;
  switch (request.kind) {
    case "cancel": valid = "requestId" in request && typeof request.requestId === "string"; break;
    case "notify": valid = "message" in request && typeof request.message === "string" && "level" in request && typeof request.level === "string" && ["info", "warning", "error"].includes(request.level); break;
    case "confirm": valid = "title" in request && typeof request.title === "string" && "message" in request && typeof request.message === "string"; break;
    case "select": valid = "title" in request && typeof request.title === "string" && "options" in request && Array.isArray(request.options) && request.options.every(value => typeof value === "string"); break;
    case "input": valid = "title" in request && typeof request.title === "string" && (!("placeholder" in request) || text(request.placeholder)); break;
    case "setStatus": valid = "key" in request && typeof request.key === "string" && (!("text" in request) || text(request.text)); break;
    case "setWorkingMessage": valid = !("text" in request) || text(request.text); break;
  }
  if (!valid) return invalid();
  return { sessionId: params.sessionId, extensionId: params.extensionId, extensionLabel: params.extensionLabel,
    ...(params.requestId === undefined ? {} : { requestId: params.requestId }), request: request as TrustedExtensionUiRequestEnvelope["request"] };
}
