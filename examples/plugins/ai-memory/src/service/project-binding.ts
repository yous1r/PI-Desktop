import { parse } from 'smol-toml';
import { DEFAULT_SETTINGS, MemoryError, name, record, text, type Binding, type Connection, type OwnerContext, type Scope, type Settings } from '../contracts.js';
import { projectIdentity, sameProject } from '../project-identity.js';

function bool(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new MemoryError('INVALID_SETTINGS');
  return value;
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new MemoryError('INVALID_SETTINGS');
  return value;
}
export function validateSettings(input: unknown): Settings {
  const raw = record(input);
  if (Object.keys(raw).some(key => /token|secret|password|credential|endpoint|baseurl/i.test(key))) throw new MemoryError('CREDENTIAL_SETTINGS_FORBIDDEN');
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) throw new MemoryError('SETTINGS_VERSION_UNSUPPORTED');
  if (raw.mode !== undefined && raw.mode !== 'coexist' && raw.mode !== 'managed') throw new MemoryError('INVALID_SETTINGS');
  const policy = raw.policy === undefined ? {} : record(raw.policy);
  const recall = raw.recall === undefined ? {} : record(raw.recall);
  const bindings = raw.bindings ?? [];
  if (!Array.isArray(bindings) || bindings.length > 200) throw new MemoryError('INVALID_SETTINGS');
  const paths = new Set<string>();
  const validated = bindings.map(value => {
    const b = record(value);
    const projectPath = projectIdentity(text(b.projectPath, 4096));
    if (paths.has(projectPath)) throw new MemoryError('DUPLICATE_BINDING');
    paths.add(projectPath);
    const binding: Binding = { projectPath, connectionId: text(b.connectionId, 200), workspace: name(b.workspace), project: name(b.project), capture: bool(b.capture, false) };
    return binding;
  });
  const ignorePaths = policy.ignorePaths ?? [];
  if (!Array.isArray(ignorePaths) || ignorePaths.length > 100) throw new MemoryError('INVALID_SETTINGS');
  return {
    schemaVersion: 1, mode: raw.mode === 'managed' ? 'managed' : 'coexist', paused: bool(raw.paused, false), bindings: validated,
    policy: {
      prompts: bool(policy.prompts, false), toolArguments: bool(policy.toolArguments, false), toolResults: bool(policy.toolResults, false), assistant: bool(policy.assistant, false),
      maxChars: integer(policy.maxChars, DEFAULT_SETTINGS.policy.maxChars, 256, 16000), ignorePaths: ignorePaths.map(value => text(value, 256)),
    },
    recall: { deadlineMs: integer(recall.deadlineMs, 1500, 200, 3000), maxChars: integer(recall.maxChars, 6000, 512, 12000) },
  };
}
export interface Marker { workspace?: string; project?: string; ignorePaths: string[] }
export function parseMarker(source: string): Marker {
  if (source.length > 65536) throw new MemoryError('MARKER_TOO_LARGE');
  try {
    const raw = parse(source);
    const capture = raw.capture === undefined ? {} : record(raw.capture);
    const ignores = capture.ignore_paths ?? [];
    if (!Array.isArray(ignores) || ignores.length > 100) throw new MemoryError('MARKER_INVALID');
    return {
      workspace: raw.workspace === undefined ? undefined : name(raw.workspace),
      project: raw.project === undefined ? undefined : name(raw.project),
      ignorePaths: ignores.map(value => text(value, 256)),
    };
  } catch { throw new MemoryError('MARKER_INVALID'); }
}
export type MarkerReader = (context: OwnerContext) => Promise<string | null>;
export async function resolveBinding(settings: Settings, context: OwnerContext, connections: Connection[], readMarker: MarkerReader): Promise<{ scope: Scope; binding: Binding; ignorePaths: string[] }> {
  if (!context.projectPath || !context.workspaceRoot) throw new MemoryError('PROJECT_UNBOUND');
  const binding = settings.bindings.find(item => sameProject(item.projectPath, context.projectPath));
  if (!binding) throw new MemoryError('PROJECT_UNBOUND');
  const connection = connections.find(item => item.id === binding.connectionId && item.pluginId === 'local.ai-memory');
  if (!connection) throw new MemoryError('CONNECTION_MISSING');
  const source = await readMarker(context);
  const marker = source === null ? { ignorePaths: [] } : parseMarker(source);
  if ((marker.workspace !== undefined && marker.workspace !== binding.workspace) || (marker.project !== undefined && marker.project !== binding.project)) throw new MemoryError('BINDING_CONFLICT');
  return {
    binding, scope: { connectionId: connection.id, connectionRevision: connection.revision, workspace: binding.workspace, project: binding.project },
    ignorePaths: [...settings.policy.ignorePaths, ...marker.ignorePaths],
  };
}
/** Suggestions are never authorization and never include URL credentials. */
export function projectCandidate(remote: string): string | null {
  const clean = remote.replace(/^[^@\s]+@([^:]+):/, 'https://$1/');
  try {
    const url = new URL(clean);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
    const candidate = path.replace(/[^A-Za-z0-9._-]+/g, '-');
    return candidate && candidate.length <= 128 ? candidate : null;
  } catch { return null; }
}
