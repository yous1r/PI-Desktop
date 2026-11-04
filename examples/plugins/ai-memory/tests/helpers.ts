import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import fixture from './fixtures/upstream/v3.3.2.json';
import { DEFAULT_SETTINGS, record, type Connection, type ConnectionRequest, type ConnectionResponse, type Connections, type HostApi, type OwnerContext, type Settings } from '../src/contracts.js';
import { Journal, type Limits, DEFAULT_LIMITS } from '../src/storage/journal.js';
import { AiMemoryService } from '../src/service/memory-service.js';
import type { CompatibilityCatalog } from '../src/upstream/capabilities.js';
import binary from './fixtures/upstream/v3.3.2-binary.json';

/** Synthetic capability evidence injected only through test constructors, never plugin settings. */
export const TEST_CATALOG: CompatibilityCatalog = { protocolVersions: ['2025-03-26'], releases: { '3.3.2': { reads: true, writesVerified: true, hookVerified: true, hookIdempotencyVerified: true, evidence: 'Synthetic offline server only' } } };
export const connection: Connection = { id: 'connection-1', pluginId: 'local.ai-memory', label: 'Synthetic memory', baseUrl: 'http://127.0.0.1:1234', revision: 1, hasCredential: true, caConfigured: false, allowHttp: false, routes: [{ path: '/mcp', methods: ['POST'] }, { path: '/hook', methods: ['POST'] }] };
export const context = (overrides: Partial<OwnerContext> = {}): OwnerContext => ({ sessionId: 'session-a', runtimeId: 'runtime-a', turnId: 'turn-a', projectPath: '/project-a', workspaceRoot: '/project-a', mode: 'agent', signal: new AbortController().signal, ...overrides });
export function settings(): Settings { return { ...structuredClone(DEFAULT_SETTINGS), mode: 'managed', bindings: [{ projectPath: '/project-a', connectionId: connection.id, workspace: 'team', project: 'project-a', capture: true }] }; }
export class SyntheticConnections implements Connections {
  connection = structuredClone(connection);
  requests: ConnectionRequest[] = [];
  hooks: Record<string, unknown>[] = [];
  claimed: string[] = [];
  pages = new Map<string, { path: string; page_id: string; body: string }>();
  version = '3.3.2';
  tools: unknown[] = [...structuredClone(fixture.tools), ...structuredClone(binary.tools).filter(tool => tool.name === 'memory_read_session_observations')];
  status = 200;
  sse = false;
  stateful = false;
  loseResponse = false;
  pending = new Map<string, (error: Error) => void>();
  hang = false;
  observations = new Map<string, Record<string, unknown>>();
  getCapabilities = async () => ({ version: 1 });
  list = async () => [this.connection];
  async cancel(id: string): Promise<void> { this.pending.get(id)?.(new Error('cancelled')); this.pending.delete(id); }
  async request(input: ConnectionRequest): Promise<ConnectionResponse> {
    this.requests.push(structuredClone(input));
    if (input.expectedRevision !== this.connection.revision) throw new Error('revision');
    if (this.hang) return new Promise((_resolve, reject) => { this.pending.set(input.requestId, reject); });
    const reply = (body: unknown): ConnectionResponse => ({ status: this.status, connectionRevision: this.connection.revision, headers: { 'content-type': this.sse ? 'text/event-stream' : 'application/json', ...(this.stateful ? { 'mcp-session-id': 'transport-session' } : {}) }, bodyText: this.sse ? `event: message\ndata: ${JSON.stringify(body)}\n\n` : JSON.stringify(body) });
    const request = record(JSON.parse(input.body ?? '{}'));
    if (input.path.startsWith('/hook?')) {
      this.hooks.push(request);
      const query = new URL(input.path, 'http://synthetic').searchParams;
      const key = query.get('ingest_key')!;
      this.observations.set(key, { id: key, sessionID: request.sessionID, kind: query.get('event'), extension: query.get('extension'), source_event: query.get('source_event'), body: request.body ?? request.prompt ?? '' });
      if (this.loseResponse) throw new Error('lost response after commit');
      return { ...reply({}), status: this.status === 200 ? 202 : this.status, headers: { 'content-type': 'text/plain' }, bodyText: 'queued' };
    }
    if (input.path !== '/mcp') throw new Error('Unexpected route');
    let result: unknown;
    if (request.method === 'initialize') result = { ...fixture.initialize, serverInfo: { name: 'ai-memory', version: this.version } };
    else if (request.method === 'notifications/initialized') return { ...reply({}), status: 202, bodyText: '' };
    else if (request.method === 'tools/list') result = { tools: this.tools };
    else {
      const params = record(request.params);
      const args = record(params.arguments);
      if (!args.workspace || !args.project) throw new Error('Explicit scope required');
      const key = `${args.workspace}/${args.project}/${args.path}`;
      let value: unknown;
      switch (params.name) {
        case 'memory_read_session_observations': value = { observations: [...this.observations.values()].filter(item => item.sessionID === args.session_id).slice(Number(args.offset), Number(args.offset) + Number(args.limit)) }; break;
        case 'memory_query': value = fixture.query; break;
        case 'memory_briefing': value = { ...fixture.briefing, scope: { workspace: args.workspace, project: args.project } }; break;
        case 'memory_read_page': value = { ...(this.pages.get(key) ?? fixture.page), path: args.path }; break;
        case 'memory_handoff_list': value = fixture.handoffs; break;
        case 'memory_handoff_accept': this.claimed.push(String(args.handoff_id)); value = { status: 'claimed', handoff: { id: args.handoff_id, summary: 'Accepted recovery data' } }; break;
        case 'memory_handoff_begin': value = { handoff_id: 'created-handoff' }; break;
        case 'memory_handoff_cancel': value = { handoff_id: args.handoff_id, cancelled: true, state: 'expired' }; break;
        case 'memory_delete_page': this.pages.delete(key); value = { deleted: true }; break;
        case 'memory_write_page': {
          const existing = this.pages.get(key);
          if ((existing && args.create_only) || (args.expected_page_id && existing?.page_id !== args.expected_page_id)) value = { reason: 'precondition_failed' };
          else { const page = { path: String(args.path), body: String(args.body), page_id: `page-${this.pages.size + 2}` }; this.pages.set(key, page); value = page; }
          break;
        }
        default: throw new Error('Unexpected tool');
      }
      if (this.loseResponse && ['memory_handoff_accept', 'memory_write_page'].includes(String(params.name))) throw new Error('lost response after commit');
      result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
    }
    return reply({ jsonrpc: '2.0', id: request.id, result });
  }
}
export async function harness(options: { config?: Settings; catalog?: CompatibilityCatalog | null; limits?: Partial<Limits> } = {}) {
  const directory = await mkdtemp(join(process.env.AI_MEMORY_TEST_SCRATCH ?? tmpdir(), 'state-'));
  const network = new SyntheticConnections();
  let config = options.config ?? settings();
  const host: HostApi = {
    connections: network,
    plugin: { getSettings: async () => ({ configuration: JSON.stringify(config) }), setSettings: async value => { config = JSON.parse(String(value.configuration)); }, getDataPath: async () => directory, getPermissions: async () => ['net.connection', 'agent.extension', 'background.service', 'fs.read'] },
    fs: { readPreview: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } },
    workspace: { get: async () => ({ path: '/project-a', name: 'A' }) },
    commands: { register: async () => {}, unregister: async () => {} }, ui: { openPanel: async () => {} }, services: { register: () => {}, unregister: async () => {} },
  };
  const journal = new Journal(directory, { ...DEFAULT_LIMITS, ...options.limits }); await journal.initialize();
  let marker: string | null = null;
  const service = new AiMemoryService(host, journal, async () => marker, options.catalog === null ? undefined : options.catalog ?? TEST_CATALOG); await service.initialize();
  return { directory, network, host, journal, service, setMarker: (value: string | null) => { marker = value; }, cleanup: async () => { await service.stop(); await journal.close(); await rm(directory, { recursive: true, force: true }); } };
}
