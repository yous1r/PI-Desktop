import manifest from '../../compatibility/supported-versions.json';
import { MemoryError, record } from '../contracts.js';
import { digest } from '../storage/journal.js';

export const TOOL_CONTRACTS = {
  query: { name: 'memory_query', fields: { workspace: 'string', project: 'string', query: 'string', limit: 'integer', answer: 'boolean' } },
  readPage: { name: 'memory_read_page', fields: { workspace: 'string', project: 'string', path: 'string' } },
  briefing: { name: 'memory_briefing', fields: { workspace: 'string', project: 'string', recent_pages_limit: 'integer' } },
  listHandoffs: { name: 'memory_handoff_list', fields: { workspace: 'string', project: 'string', limit: 'integer' } },
  writePage: { name: 'memory_write_page', fields: { workspace: 'string', project: 'string', path: 'string', body: 'string', expected_page_id: 'string', create_only: 'boolean' } },
  acceptHandoff: { name: 'memory_handoff_accept', fields: { workspace: 'string', project: 'string', handoff_id: 'string' } },
  beginHandoff: { name: 'memory_handoff_begin', fields: { workspace: 'string', project: 'string', summary: 'string', shared: 'boolean' } },
  cancelHandoff: { name: 'memory_handoff_cancel', fields: { workspace: 'string', project: 'string', handoff_id: 'string' } },
  maintenance: { name: 'memory_delete_page', fields: { workspace: 'string', project: 'string', path: 'string', expected_page_id: 'string' } },
  observations: { name: 'memory_read_session_observations', fields: { workspace: 'string', project: 'string', session_id: 'string', limit: 'integer', offset: 'integer', body_max_chars: 'integer', order: 'string' } },
} as const;
export type ToolOperation = keyof typeof TOOL_CONTRACTS;
export interface ReleaseEvidence { reads: boolean; writesVerified: boolean; hookVerified: boolean; hookIdempotencyVerified: boolean; evidence: string }
export interface CompatibilityCatalog { protocolVersions: string[]; releases: Record<string, ReleaseEvidence> }
export const CATALOG: CompatibilityCatalog = manifest;
export interface CapabilityReport {
  version: string | null; protocol: string; knownVersion: boolean;
  tools: Partial<Record<ToolOperation, { available: boolean; reason?: string; fingerprint?: string }>>;
  writes: boolean; capture: boolean; hookIdempotent: boolean;
}
const SUPPLIED_REQUIRED: Record<ToolOperation, string[]> = {
  query: ['workspace', 'project', 'query', 'limit', 'answer'], readPage: ['workspace', 'project', 'path'],
  briefing: ['workspace', 'project', 'recent_pages_limit'], listHandoffs: ['workspace', 'project', 'limit'],
  writePage: ['workspace', 'project', 'path', 'body'], acceptHandoff: ['workspace', 'project', 'handoff_id'],
  beginHandoff: ['workspace', 'project', 'summary', 'shared'], cancelHandoff: ['workspace', 'project', 'handoff_id'],
  maintenance: ['workspace', 'project', 'path', 'expected_page_id'],
  observations: ['workspace', 'project', 'session_id', 'limit', 'offset', 'body_max_chars', 'order'],
};
function acceptsType(schema: unknown, type: string): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const value = schema as Record<string, unknown>;
  if (value.$ref || value.enum || value.const || value.oneOf || value.allOf || value.not) return false;
  if (value.type === type || (Array.isArray(value.type) && value.type.includes(type) && value.type.every(item => item === type || item === 'null'))) return true;
  if (Array.isArray(value.anyOf)) return value.anyOf.some(item => acceptsType(item, type)) && value.anyOf.every(item => acceptsType(item, type) || (item && typeof item === 'object' && item.type === 'null'));
  return false;
}
export function inspectCapabilities(initialize: Record<string, unknown>, tools: unknown[], catalog: CompatibilityCatalog = CATALOG): CapabilityReport {
  const protocol = initialize.protocolVersion;
  if (typeof protocol !== 'string' || !catalog.protocolVersions.includes(protocol)) throw new MemoryError('PROTOCOL_UNSUPPORTED');
  if (!record(initialize.capabilities).tools) throw new MemoryError('MCP_TOOLS_UNAVAILABLE');
  const info = record(initialize.serverInfo);
  const version = typeof info.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(info.version) ? info.version : null;
  const evidence = version ? catalog.releases[version] : undefined;
  const report: CapabilityReport = { version, protocol, knownVersion: !!evidence, tools: {}, writes: evidence?.writesVerified === true, capture: evidence?.hookVerified === true, hookIdempotent: evidence?.hookIdempotencyVerified === true };
  for (const [operation, contract] of Object.entries(TOOL_CONTRACTS)) {
    const matching = tools.filter(tool => tool && typeof tool === 'object' && 'name' in tool && tool.name === contract.name);
    const key = operation as ToolOperation;
    if (matching.length !== 1) { report.tools[key] = { available: false, reason: 'TOOL_MISSING_OR_DUPLICATE' }; continue; }
    try {
      const tool = record(matching[0]);
      const schema = record(tool.inputSchema);
      const properties = record(schema.properties);
      const required = schema.required ?? [];
      const fields: Record<string, string> = contract.fields;
      const stable = schema.type === 'object' && !schema.oneOf && !schema.anyOf && !schema.allOf && !schema.$ref && !schema.not
        && Array.isArray(required) && required.every(field => typeof field === 'string' && SUPPLIED_REQUIRED[key].includes(field))
        && Object.entries(fields).every(([field, type]) => acceptsType(properties[field], type));
      report.tools[key] = { available: stable, reason: stable ? undefined : 'TOOL_SCHEMA_CHANGED', fingerprint: digest(schema) };
    } catch { report.tools[key] = { available: false, reason: 'TOOL_SCHEMA_CHANGED' }; }
  }
  report.capture = report.capture && report.hookIdempotent && report.tools.observations?.available === true;
  return report;
}
