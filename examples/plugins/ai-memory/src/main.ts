import { join } from 'node:path';
import { errorCode, MemoryError, record, type HostApi, type OwnerContext } from './contracts.js';
import { Journal } from './storage/journal.js';
import { AiMemoryService } from './service/memory-service.js';

declare const pi: HostApi;
let service: AiMemoryService | undefined;
let journal: Journal | undefined;
let initializationError: string | undefined;

export async function readHostMarker(host: HostApi, context: OwnerContext): Promise<string | null> {
  if (!context.projectPath || !context.workspaceRoot) throw new MemoryError('PROJECT_UNBOUND');
  try {
    // The owner invocation supplies the actual session root, including remote/worktree roots.
    const preview = record(await host.fs.readPreview('.ai-memory.toml', { workspacePath: context.projectPath }));
    if (preview.kind !== 'text' || typeof preview.content !== 'string' || Number(preview.size) > 65536) throw new MemoryError('MARKER_UNREADABLE');
    return preview.content;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (['ENOENT', 'NOT_FOUND', 'FILE_NOT_FOUND'].includes(String(code))) return null;
    throw error instanceof MemoryError ? error : new MemoryError(context.remoteWorkspace ? 'REMOTE_MARKER_UNAVAILABLE' : 'MARKER_UNREADABLE');
  }
}
export async function onLoad(): Promise<void> {
  await pi.commands.register({ id: 'ai-memory.open', title: 'Memory / 记忆', run: () => pi.ui.openPanel({ title: 'ai-memory' }) });
  try {
    journal = new Journal(join(await pi.plugin.getDataPath(), 'memory-v1'));
    await journal.initialize();
    service = new AiMemoryService(pi, journal, context => readHostMarker(pi, context));
    await service.initialize();
    pi.services.register({ id: 'outbox', start: () => service?.start(), stop: async () => { await service?.stop(); } });
  } catch (error) {
    initializationError = errorCode(error);
    await service?.stop(); service = undefined;
    await journal?.close(); journal = undefined;
  }
}
export async function onUnload(): Promise<void> {
  await service?.stop();
  await pi.services.unregister('outbox');
  await journal?.close(); service = undefined; journal = undefined;
  await pi.commands.unregister('ai-memory.open');
}
export async function onAgentExtensionCall(operation: string, payload: unknown, context: OwnerContext): Promise<unknown> {
  if (!service) throw new MemoryError(initializationError ?? 'PLUGIN_NOT_READY');
  return service.call(operation, payload, context);
}
export async function onPanelInvoke(channel: string, payload: unknown): Promise<unknown> {
  if (!service) return { state: 'unsupported', error: initializationError ?? 'PLUGIN_NOT_READY' };
  try { return await service.panel(channel, payload); }
  catch (error) { throw new MemoryError(errorCode(error)); }
}
