import { randomUUID } from "node:crypto";
import {
  ErrorCodes, TRUSTED_EXTENSION_PROMPT_TIMEOUT_MS,
  type PluginAgentExtensionStatus, type TrustedExtensionCommand, type TrustedExtensionDiagnostic,
  type TrustedExtensionLoadReport, type TrustedExtensionStatusEvent, type TrustedExtensionUiPrompt,
  type TrustedExtensionUiRequestEnvelope, type TrustedExtensionUiResponse,
} from "@pi-desktop/shared";

type Source = {
  active: boolean; assertCurrent: () => void; operations: number;
  sessions: Map<string, SessionState>; requests: Map<string, UiRequest>;
};
type SessionState = {
  id: string; source: Source; active: boolean;
  commands: TrustedExtensionCommand[]; diagnostics: TrustedExtensionDiagnostic[]; reports: TrustedExtensionLoadReport[];
};
type UiRequest = { session: SessionState; controller: AbortController };
type PromptKind = "confirm" | "select" | "input";
type PendingPrompt = {
  prompt: TrustedExtensionUiPrompt; session: SessionState; kind: PromptKind;
  resolve: (response: TrustedExtensionUiResponse) => void; reject: (error: unknown) => void;
  cleanup: () => void;
};
export type AgentExtensionBridgeOptions = {
  isAdmissionClosed: () => boolean;
  /** Renderer notifications. `hasRenderer` false means prompts fail closed (spec §9). */
  hasRenderer: () => boolean;
  onChanged: () => void;
  onPrompt: (prompt: TrustedExtensionUiPrompt) => void;
  onToast: (message: string, level: "info" | "warning" | "error") => void;
  onStatus: (event: TrustedExtensionStatusEvent) => void;
  onError: (error: unknown) => void;
  promptTimeoutMs?: number;
};
const dismissedResponse = (kind: PromptKind): TrustedExtensionUiResponse => kind === "confirm"
  ? { kind, value: false, cancelled: true } : { kind, value: undefined, cancelled: true };
const unavailable = () => Object.assign(new Error("Extension UI source is unavailable"), { errorCode: ErrorCodes.HOST_UNAVAILABLE });
export type AgentExtensionUiSource = ReturnType<AgentExtensionBridge["bindSource"]>;

/** Publications and prompts carry their original sidecar binding, never a session ID alone. */
export class AgentExtensionBridge {
  private readonly options: AgentExtensionBridgeOptions;
  private readonly sources = new Set<Source>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly pending = new Map<string, PendingPrompt>();
  /** One interactive prompt per session, including the original tails of cancelled requests. */
  private readonly promptQueues = new Map<string, Promise<unknown>>();

  constructor(options: AgentExtensionBridgeOptions) { this.options = options; }

  bindSource(assertCurrent: () => void) {
    const source: Source = { active: true, assertCurrent, operations: 0, sessions: new Map(), requests: new Map() };
    this.sources.add(source);
    return {
      publishCommands: (sessionId: string, commands: TrustedExtensionCommand[]) => this.publish(source, sessionId, state => { state.commands = commands; }),
      publishDiagnostics: (sessionId: string, diagnostics: TrustedExtensionDiagnostic[], reports: TrustedExtensionLoadReport[]) =>
        this.publish(source, sessionId, state => { state.diagnostics = diagnostics; if (reports.length) state.reports = reports; }),
      requestUi: (envelope: TrustedExtensionUiRequestEnvelope) => this.requestUi(source, envelope),
      capture: (sessionId: string) => {
        const state = this.session(source, sessionId);
        return () => this.assertSession(state);
      },
      captureSession: (sessionId: string) => {
        const state = source.sessions.get(sessionId);
        return () => { if (state) this.retireSession(state); };
      },
      clearSession: (sessionId: string) => { const state = source.sessions.get(sessionId); if (state) this.retireSession(state); },
      dispose: () => {
        source.active = false;
        for (const state of [...source.sessions.values()]) this.retireSession(state);
        this.releaseSource(source);
      },
      getHandoffActivity: () => ({ operations: source.operations, inputs: source.requests.size }),
    };
  }

  private assertSource(source: Source): void {
    if (!source.active) throw unavailable();
    if (this.options.isAdmissionClosed()) throw Object.assign(new Error("Host admission is closed"), { errorCode: "HOST_BUSY" });
    source.assertCurrent();
  }
  private assertSession(state: SessionState): void {
    this.assertSource(state.source);
    if (!state.active || this.sessions.get(state.id) !== state) throw unavailable();
  }
  private session(source: Source, sessionId: string): SessionState {
    this.assertSource(source);
    let state = source.sessions.get(sessionId);
    if (!state) {
      const previous = this.sessions.get(sessionId);
      state = { id: sessionId, source, active: true, commands: [], diagnostics: [], reports: [] };
      source.sessions.set(sessionId, state); this.sessions.set(sessionId, state);
      if (previous) this.retireSession(previous);
    }
    this.assertSession(state);
    return state;
  }
  private publish(source: Source, sessionId: string, update: (state: SessionState) => void): void {
    source.operations++;
    try { update(this.session(source, sessionId)); this.options.onChanged(); }
    finally { source.operations--; this.releaseSource(source); }
  }
  private releaseSource(source: Source): void { if (!source.active && source.operations === 0) this.sources.delete(source); }
  private retireSession(state: SessionState): void {
    if (!state.active) return;
    state.active = false;
    if (state.source.sessions.get(state.id) === state) state.source.sessions.delete(state.id);
    const removed = this.sessions.get(state.id) === state;
    if (removed) this.sessions.delete(state.id);
    for (const entry of [...state.source.requests.values()]) if (entry.session === state) entry.controller.abort();
    if (removed) this.notify(() => this.options.onChanged());
  }
  private notify(operation: () => void): void {
    try { operation(); } catch (error) { this.options.onError(error); }
  }

  /** Commands registered by any live session, deduplicated by name. */
  allCommands(): TrustedExtensionCommand[] {
    const byName = new Map<string, TrustedExtensionCommand>();
    for (const state of this.sessions.values()) for (const command of state.commands) if (!byName.has(command.name)) byName.set(command.name, command);
    return [...byName.values()];
  }
  commandsForSession(sessionId: string): TrustedExtensionCommand[] { return this.sessions.get(sessionId)?.commands ?? []; }
  /** The most recent session reporting a plugin's modules wins (spec §11). */
  statusForPlugin(extensionIds: readonly string[]): PluginAgentExtensionStatus {
    const ids = new Set(extensionIds);
    const status: PluginAgentExtensionStatus = { state: "enabled", toolNames: [], commandNames: [], agentNames: [], diagnostics: [] };
    for (const session of this.sessions.values()) {
      const reports = session.reports.filter(r => ids.has(r.extensionId));
      if (!reports.length) continue;
      status.state = reports.some(r => r.state === "error") ? "error" : "loaded";
      status.toolNames = reports.flatMap(r => r.toolNames);
      status.commandNames = reports.flatMap(r => r.commandNames);
      status.agentNames = reports.flatMap(r => r.agentNames);
      status.diagnostics = session.diagnostics.filter(d => ids.has(d.extensionId));
    }
    return status;
  }

  private emit(source: Source, operation: () => void): void {
    source.operations++;
    try { operation(); } finally { source.operations--; this.releaseSource(source); }
  }
  private async requestUi(source: Source, envelope: TrustedExtensionUiRequestEnvelope): Promise<TrustedExtensionUiResponse> {
    const { request } = envelope;
    if (request.kind === "cancel") {
      source.requests.get(JSON.stringify([envelope.sessionId, envelope.extensionId, request.requestId]))?.controller.abort();
      return { kind: "cancel" };
    }
    const state = this.session(source, envelope.sessionId);
    switch (request.kind) {
      case "notify":
        this.emit(source, () => this.options.onToast(`${envelope.extensionLabel}: ${request.message}`, request.level));
        return { kind: "notify" };
      case "setStatus":
      case "setWorkingMessage":
        this.emit(source, () => this.options.onStatus({ sessionId: envelope.sessionId, extensionId: envelope.extensionId,
          key: request.kind === "setStatus" ? request.key : "working", text: request.text }));
        return { kind: request.kind };
    }
    if (!this.options.hasRenderer()) throw Object.assign(new Error("interactive extension prompts need the desktop window"), { errorCode: ErrorCodes.UNSUPPORTED });
    this.assertSession(state);
    const key = JSON.stringify([envelope.sessionId, envelope.extensionId, envelope.requestId ?? randomUUID()]);
    if (source.requests.has(key)) throw new Error("Duplicate extension UI request");
    const controller = new AbortController(), entry: UiRequest = { session: state, controller };
    source.requests.set(key, entry); source.operations++;
    const previous = this.promptQueues.get(envelope.sessionId) ?? Promise.resolve();
    const run = previous.then(() => {
      if (controller.signal.aborted) return dismissedResponse(request.kind);
      this.assertSession(state);
      return this.showPrompt(state, envelope, request, controller.signal);
    }).finally(() => {
      if (source.requests.get(key) === entry) source.requests.delete(key);
      source.operations--; this.releaseSource(source);
    });
    const tail = run.catch(() => undefined);
    this.promptQueues.set(envelope.sessionId, tail);
    void tail.then(() => { if (this.promptQueues.get(envelope.sessionId) === tail) this.promptQueues.delete(envelope.sessionId); });
    let retire!: () => void;
    const cancelled = new Promise<TrustedExtensionUiResponse>(resolve => {
      retire = () => resolve(dismissedResponse(request.kind));
      controller.signal.addEventListener("abort", retire, { once: true });
      if (controller.signal.aborted) retire();
    });
    try { return await Promise.race([run, cancelled]); }
    finally { controller.signal.removeEventListener("abort", retire); }
  }

  respond(promptId: string, value: string | boolean | undefined): boolean {
    const pending = this.pending.get(promptId);
    if (!pending) return false;
    this.assertSession(pending.session);
    this.settle(promptId, pending.kind === "confirm" ? { kind: pending.kind, value: value === true }
      : { kind: pending.kind, value: typeof value === "string" ? value : undefined });
    return true;
  }
  /** Explicit user abort keeps its existing whole-session scope, including queued requests. */
  cancelPrompts(sessionId: string): void {
    const entries = [...this.sources].flatMap(source => [...source.requests.values()]);
    for (const entry of entries) if (entry.session.id === sessionId) entry.controller.abort();
  }
  pendingPromptCount(): number { return this.pending.size; }

  private showPrompt(state: SessionState, envelope: TrustedExtensionUiRequestEnvelope,
    request: TrustedExtensionUiPrompt["request"], signal: AbortSignal): Promise<TrustedExtensionUiResponse> {
    return new Promise((resolve, reject) => {
      const promptId = randomUUID();
      const prompt = { promptId, sessionId: envelope.sessionId, extensionId: envelope.extensionId, extensionLabel: envelope.extensionLabel, request };
      const abort = () => this.settle(promptId, dismissedResponse(request.kind));
      const timer = setTimeout(abort, this.options.promptTimeoutMs ?? TRUSTED_EXTENSION_PROMPT_TIMEOUT_MS);
      this.pending.set(promptId, { prompt, session: state, kind: request.kind, resolve, reject,
        cleanup: () => { clearTimeout(timer); signal.removeEventListener("abort", abort); } });
      signal.addEventListener("abort", abort, { once: true });
      try { this.assertSession(state); this.options.onPrompt(prompt); }
      catch (error) {
        const pending = this.takePrompt(promptId);
        pending?.reject(error);
        this.options.onError(error);
      }
      if (signal.aborted) abort();
    });
  }
  private takePrompt(promptId: string): PendingPrompt | undefined {
    const pending = this.pending.get(promptId);
    if (pending) { this.pending.delete(promptId); pending.cleanup(); }
    return pending;
  }
  private settle(promptId: string, response: TrustedExtensionUiResponse): void {
    const pending = this.takePrompt(promptId);
    if (!pending) return;
    try { this.notify(() => this.options.onPrompt({ ...pending.prompt, cancelled: true })); }
    finally { pending.resolve(response); }
  }
}
