import { assertActive, DEFAULT_SETTINGS, errorCode, MemoryError, OWNER_OPERATIONS, record, scopeKey, text, type HostApi, type Mutation, type Operation, type OwnerContext, type Scope, type Settings } from '../contracts.js';
import { excluded, normalize, redactText, sanitize } from '../capture/policy.js';
import { Outbox } from '../capture/outbox.js';
import { digest, Journal, type OutboxEvent } from '../storage/journal.js';
import { McpTransport } from '../upstream/transport.js';
import { V3Adapter } from '../upstream/adapters/v3.js';
import type { CompatibilityCatalog } from '../upstream/capabilities.js';
import { retrieve, type ContextPacket } from '../recall/retrieval.js';
import { Mutations } from '../recall/handoff.js';
import { resolveBinding, validateSettings, type MarkerReader } from './project-binding.js';
import { SessionCoordinator } from './session-coordinator.js';
import { projectIdentity, sameProject } from '../project-identity.js';

export class AiMemoryService {
  settings: Settings = structuredClone(DEFAULT_SETTINGS);
  readonly sessions: SessionCoordinator;
  readonly mutations: Mutations;
  readonly outbox: Outbox;
  private hostReady = false;
  private adapters = new Map<string, { adapter: V3Adapter; at: number }>();
  private cache = new Map<string, { packet: ContextPacket; at: number }>();
  private lastRecall = new Map<string, Omit<ContextPacket, 'text'>>();
  private errors = new Map<string, string>();
  private blockedProjects = new Set<string>();
  private lifecycle = new AbortController();
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private worker?: Promise<void>;
  private stopped = false;
  private configuring = false;
  constructor(readonly host: HostApi, readonly journal: Journal, private readMarker: MarkerReader, private catalog?: CompatibilityCatalog) {
    this.sessions = new SessionCoordinator(journal);
    this.mutations = new Mutations(journal);
    this.outbox = new Outbox(journal, (event, signal) => this.deliveryAdapter(event, signal));
  }
  async initialize(): Promise<void> {
    this.hostReady = false;
    const raw = await this.host.plugin.getSettings();
    this.settings = validateSettings(raw.configuration === undefined ? {} : typeof raw.configuration === 'string' ? JSON.parse(raw.configuration) : raw.configuration);
    try {
      const granted = await this.host.plugin.getPermissions?.();
      if (!granted || !['net.connection', 'agent.extension', 'fs.read', 'background.service'].every(permission => granted.includes(permission))) throw new MemoryError('HOST_PERMISSIONS_MISSING');
      if (!this.host.connections || (await this.host.connections.getCapabilities()).version !== 1) throw new MemoryError('HOST_UPGRADE_REQUIRED');
      this.hostReady = true;
    } catch (error) { this.errors.set('host', errorCode(error)); }
  }
  private active(context: OwnerContext): OwnerContext {
    if (this.stopped || !this.hostReady || this.configuring) throw new MemoryError(this.stopped ? 'PLUGIN_STOPPED' : this.configuring ? 'STALE_CONFIGURATION' : 'HOST_UPGRADE_REQUIRED');
    if (!context.sessionId || !context.runtimeId || !['agent', 'plan', 'goal'].includes(context.mode)) throw new MemoryError('HOST_CONTEXT_INVALID');
    assertActive(context.signal);
    return { ...context, signal: AbortSignal.any([context.signal, this.lifecycle.signal]) };
  }
  private async binding(context: OwnerContext) {
    if (!this.host.connections) throw new MemoryError('HOST_UPGRADE_REQUIRED');
    try {
      const result = await resolveBinding(this.settings, context, await this.host.connections.list(), this.readMarker);
      assertActive(context.signal);
      this.blockedProjects.delete(projectIdentity(context.projectPath ?? ''));
      return result;
    } catch (error) {
      if (!context.signal.aborted) this.blockedProjects.add(projectIdentity(context.projectPath ?? ''));
      throw error;
    }
  }
  private async adapter(scope: Scope, signal: AbortSignal, refresh = false): Promise<V3Adapter> {
    assertActive(signal);
    if (!this.host.connections) throw new MemoryError('HOST_UPGRADE_REQUIRED');
    const key = scopeKey(scope);
    const cached = this.adapters.get(key);
    if (!refresh && cached && Date.now() - cached.at < 300_000) return cached.adapter;
    const generation = this.generation;
    const adapter = new V3Adapter(new McpTransport(this.host.connections, scope), this.catalog);
    await adapter.discover(signal);
    assertActive(signal);
    if (generation !== this.generation) throw new MemoryError('STALE_CONFIGURATION');
    this.adapters.set(key, { adapter, at: Date.now() });
    if (this.adapters.size > 100) this.adapters.delete(this.adapters.keys().next().value!);
    return adapter;
  }
  private async deliveryAdapter(event: OutboxEvent, signal: AbortSignal): Promise<V3Adapter> {
    if (this.settings.paused || this.stopped || !this.hostReady) throw new MemoryError('CAPTURE_PAUSED');
    if (this.configuring) throw new MemoryError('CAPTURE_PAUSED');
    const poisoned = this.journal.snapshot().events.some(item => item.scope.connectionId === event.scope.connectionId && item.scope.connectionRevision === event.scope.connectionRevision && item.error === 'SESSION_START_CONSUMED_HANDOFF');
    if (poisoned) throw new MemoryError('SESSION_START_CONSUMED_HANDOFF');
    const bindings = this.settings.bindings.filter(binding => binding.capture && binding.connectionId === event.scope.connectionId && binding.workspace === event.scope.workspace && binding.project === event.scope.project);
    if (!bindings.length || bindings.some(binding => this.blockedProjects.has(projectIdentity(binding.projectPath)))) throw new MemoryError('PROJECT_UNBOUND');
    const connection = (await this.host.connections!.list()).find(item => item.id === event.scope.connectionId);
    if (!connection || connection.revision !== event.scope.connectionRevision) throw new MemoryError('CONNECTION_CHANGED');
    const adapter = await this.adapter(event.scope, signal);
    if (!adapter.report?.capture) throw new MemoryError('CAPTURE_NOT_VERIFIED');
    return adapter;
  }
  async call(operation: string, payload: unknown, original: OwnerContext): Promise<unknown> {
    if (operation !== 'recall') return this.execute(operation, payload, original);
    const deadline = new AbortController();
    const signal = AbortSignal.any([original.signal, deadline.signal]);
    let rejectAbort!: (error: MemoryError) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new MemoryError(deadline.signal.aborted ? 'RECALL_DEADLINE' : 'CANCELLED'));
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => deadline.abort(), this.settings.recall.deadlineMs);
    try {
      if (signal.aborted) onAbort();
      return await Promise.race([this.execute(operation, payload, { ...original, signal }), aborted]);
    } catch (error) {
      this.errors.set(original.sessionId, errorCode(error));
      throw error;
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  }
  private async execute(operation: string, payload: unknown, original: OwnerContext): Promise<unknown> {
    if (!Object.hasOwn(OWNER_OPERATIONS, operation)) throw new MemoryError('OPERATION_UNSUPPORTED');
    const context = this.active(original);
    const op = operation as Operation;
    if (!OWNER_OPERATIONS[op] && context.mode !== 'agent') throw new MemoryError('AGENT_MODE_REQUIRED');
    const input = payload === undefined ? {} : record(payload);
    if (operation === 'status') return this.status(context);
    const generation = this.generation;
    try {
      if (operation === 'retire') {
        await this.sessions.retire(context, scope => !this.settings.paused && this.settings.bindings.some(binding => sameProject(binding.projectPath, context.projectPath) && binding.capture && binding.connectionId === scope.connectionId && binding.workspace === scope.workspace && binding.project === scope.project));
        return { retired: true, reason: context.retirementReason ?? 'reconfigure' };
      }
      const bound = await this.binding(context);
      if (generation !== this.generation) throw new MemoryError('STALE_CONFIGURATION');
      if (this.settings.paused) throw new MemoryError('CAPTURE_PAUSED');
      if (operation === 'recall') {
        const query = typeof input.query === 'string' ? input.query : '';
        return await this.recall(bound.scope, { ...input, query: excluded(query, bound.ignorePaths) ? '' : redactText(query) }, context);
      }
      if (operation === 'capture') {
        if (!bound.binding.capture) throw new MemoryError('CAPTURE_NOT_ENABLED');
        const adapter = await this.adapter(bound.scope, context.signal);
        if (!adapter.report?.capture) throw new MemoryError('CAPTURE_NOT_VERIFIED');
        const event = normalize(input, { ...this.settings.policy, ignorePaths: bound.ignorePaths });
        if (!event) return { accepted: false, reason: 'POLICY_EXCLUDED' };
        return await this.sessions.receive(event, bound.scope, context);
      }
      const mutating = !OWNER_OPERATIONS[op];
      if (mutating && this.settings.mode !== 'managed') throw new MemoryError('MANAGED_MODE_REQUIRED');
      const adapter = await this.adapter(bound.scope, context.signal, mutating);
      if (generation !== this.generation) throw new MemoryError('STALE_CONFIGURATION');
      let result: unknown;
      switch (operation) {
        case 'query': result = await adapter.query(text(input.query, 2000), context.signal); break;
        case 'readPage': result = await adapter.readPage(text(input.path, 512), context.signal); break;
        case 'briefing': result = await adapter.call('briefing', { recent_pages_limit: 5 }, context.signal); break;
        case 'listHandoffs': result = await adapter.listHandoffs(context.signal); break;
        default:
          result = await this.mutations.execute(op as Mutation, input, context, bound.scope, adapter);
          this.cache.clear();
      }
      assertActive(context.signal);
      this.errors.delete(context.sessionId);
      return sanitize(result, 24000);
    } catch (error) {
      this.errors.set(context.sessionId, errorCode(error));
      if (this.errors.size > 200) this.errors.delete(this.errors.keys().next().value!);
      throw new MemoryError(errorCode(error));
    }
  }
  private async recall(scope: Scope, input: Record<string, unknown>, context: OwnerContext): Promise<ContextPacket> {
    const query = typeof input.query === 'string' ? input.query.slice(0, 2000) : '';
    const key = digest([scopeKey(scope), context.sessionId, query]);
    const cached = this.cache.get(key);
    if (input.refresh !== true && cached && Date.now() - cached.at < 60_000) return cached.packet;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.settings.recall.deadlineMs);
    const signal = AbortSignal.any([context.signal, timeout.signal]);
    try {
      const adapter = await this.adapter(scope, signal);
      const packet = await retrieve(adapter, query, signal, this.settings.recall.maxChars, this.mutations.recovered(context, scope));
      assertActive(signal);
      this.cache.set(key, { packet, at: Date.now() });
      if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
      const { text: _body, ...diagnostics } = packet;
      this.lastRecall.set(context.sessionId, diagnostics);
      if (this.lastRecall.size > 100) this.lastRecall.delete(this.lastRecall.keys().next().value!);
      this.errors.delete(context.sessionId);
      return packet;
    } catch (error) { throw new MemoryError(timeout.signal.aborted ? 'RECALL_DEADLINE' : errorCode(error)); }
    finally { clearTimeout(timer); }
  }
  status(context?: OwnerContext) {
    const binding = context ? this.settings.bindings.find(item => sameProject(item.projectPath, context.projectPath)) : undefined;
    const reports = [...this.adapters.values()].filter(({ adapter }) => !context || (!!binding && adapter.transport.scope.connectionId === binding.connectionId && adapter.transport.scope.project === binding.project && adapter.transport.scope.workspace === binding.workspace)).slice(-20).map(({ adapter }) => ({ scope: adapter.transport.scope, ...adapter.report }));
    const error = this.errors.get(context?.sessionId ?? 'worker') ?? this.errors.get('host');
    return {
      ownerVersion: 1, connectionsVersion: this.hostReady ? 1 : null, mode: this.settings.mode,
      state: !this.hostReady ? 'unsupported' : error === 'AUTH_REQUIRED' ? 'auth-required' : ['TRANSPORT_FAILURE', 'RECALL_DEADLINE', 'HTTP_FAILURE'].includes(error ?? '') ? 'offline' : this.settings.paused || !!error ? 'capture-paused' : reports.some(item => item.writes && item.capture) ? 'ready' : 'read-only',
      error, binding, capabilities: reports, queue: this.journal.diagnostics(Date.now(), context?.sessionId),
      lastRecall: context ? this.lastRecall.get(context.sessionId) : [...this.lastRecall.values()].slice(-10),
    };
  }
  async saveSettings(value: unknown, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new MemoryError('CONFIRMATION_REQUIRED');
    const settings = validateSettings(value);
    // Cancel operations admitted under old policy before swapping persisted configuration.
    if (this.configuring) throw new MemoryError('SETTINGS_BUSY');
    this.configuring = true; this.lifecycle.abort(); this.generation++;
    try {
      await this.host.plugin.setSettings({ configuration: JSON.stringify(settings) });
      this.settings = settings; this.adapters.clear(); this.cache.clear(); this.lastRecall.clear();
    } finally { this.lifecycle = new AbortController(); this.configuring = false; }
  }
  start(): void {
    if (this.timer || this.stopped) return;
    const tick = () => {
      if (this.stopped) return;
      this.worker = this.tick().finally(() => { this.worker = undefined; if (!this.stopped) this.timer = setTimeout(tick, 5000); });
    };
    this.timer = setTimeout(tick, 1000);
  }
  async tick(): Promise<void> {
    if (!this.hostReady || this.settings.paused || this.stopped) return;
    try { await this.outbox.pruneReceipts(); await this.outbox.drain(this.lifecycle.signal); this.errors.delete('worker'); }
    catch (error) { this.errors.set('worker', errorCode(error)); }
  }
  async stop(): Promise<void> {
    this.stopped = true; this.lifecycle.abort(); clearTimeout(this.timer); this.timer = undefined;
    await this.worker; this.cache.clear(); this.adapters.clear();
  }
  async panel(channel: string, payload: unknown): Promise<unknown> {
    const input = payload === undefined ? {} : record(payload);
    switch (channel) {
      case 'memory.probe': {
        if (!this.hostReady) throw new MemoryError('HOST_UPGRADE_REQUIRED');
        const workspace = await this.host.workspace.get();
        if (!workspace) throw new MemoryError('PROJECT_UNBOUND');
        const binding = this.settings.bindings.find(item => sameProject(item.projectPath, workspace.path));
        const connection = (await this.host.connections!.list()).find(item => item.id === binding?.connectionId);
        if (!binding || !connection) throw new MemoryError('PROJECT_UNBOUND');
        return (await this.adapter({ connectionId: connection.id, connectionRevision: connection.revision, workspace: binding.workspace, project: binding.project }, this.lifecycle.signal, true)).report;
      }
      case 'memory.status': return { ...this.status(), settings: this.settings, connections: this.hostReady ? (await this.host.connections!.list()).map(({ id, label, revision, hasCredential }) => ({ id, label, revision, hasCredential })) : [], workspace: await this.host.workspace.get() };
      case 'memory.settings': await this.saveSettings(input.settings, input.confirmed === true); return { saved: true };
      case 'memory.retry': await this.outbox.retry(text(input.id, 200)); return { queued: true };
      case 'memory.reconcile': return { verified: await this.outbox.reconcile(text(input.id, 200), this.lifecycle.signal) };
      case 'memory.resolve': {
        if (input.decision !== 'confirmed-delivered' && input.decision !== 'discard') throw new MemoryError('INVALID_INPUT');
        await this.outbox.resolve(text(input.id, 200), input.decision, input.confirmed === true); return { resolved: true };
      }
      case 'memory.recovery': {
        const entry = this.journal.snapshot().events.find(item => item.id === input.id);
        if (!entry?.recovery) throw new MemoryError('RECOVERY_MISSING');
        return { eventId: entry.id, recovery: entry.recovery };
      }
      case 'memory.diagnostics': return { plugin: 'local.ai-memory', version: '0.1.0', hostReady: this.hostReady, queue: this.journal.diagnostics(), errors: [...new Set(this.errors.values())], capabilities: [...this.adapters.values()].map(({ adapter }) => adapter.report) };
      default: throw new MemoryError('PANEL_OPERATION_UNSUPPORTED');
    }
  }
}
