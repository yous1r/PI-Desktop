import { randomUUID } from 'node:crypto';
import { errorCode, record } from './contracts.js';
import { sanitize, textParts } from './capture/policy.js';
import { activateManagedTools, owner, registerManagedTools, type ExtensionApi, type ExtensionContext } from './tools/managed.js';

/** All mutable state belongs to this factory invocation, never to the cached module. */
export default function aiMemoryExtension(api: ExtensionApi): void {
  let managed = false;
  let retired = false;
  let epoch = 0;
  let query = '';
  let packet: { text: string; id: string } | undefined;
  let refresh = true;
  let attempted = false;
  let lastError: string | undefined;
  const injected = new Set<string>();
  const calls = new Map<string, unknown>();
  const instance = randomUUID();
  let sequence = 0;
  registerManagedTools(api, () => managed && !retired);
  activateManagedTools(api, false);

  async function report(error: unknown, context: ExtensionContext): Promise<void> {
    const code = errorCode(error);
    if (code === lastError || context.signal.aborted || retired) return;
    lastError = code;
    await context.ui?.notify(`ai-memory: ${code}. Open Memory diagnostics / 打开记忆诊断。`, 'warning');
  }
  async function capture(type: string, data: unknown, context: ExtensionContext): Promise<void> {
    if (retired || context.mode !== 'agent') return;
    try {
      await owner(context, 'capture', { type, eventId: `${instance}:${++sequence}`, data: sanitize(data, 16000) });
    } catch (error) { await report(error, context); }
  }
  async function recall(context: ExtensionContext): Promise<void> {
    const current = ++epoch;
    const forceRefresh = refresh;
    attempted = true; refresh = false;
    try {
      const result = record(await owner(context, 'recall', { query, refresh: forceRefresh }));
      if (retired || current !== epoch || context.signal.aborted) return;
      if (typeof result.text === 'string' && typeof result.id === 'string' && result.text.length <= 12000) {
        packet = { text: result.text, id: result.id }; refresh = false; lastError = undefined;
      }
    } catch (error) { if (current === epoch) packet = undefined; await report(error, context); }
  }
  api.registerCommand('ai-memory-status', {
    description: 'Memory diagnostics / 记忆诊断',
    async handler(_args, context) {
      try { await context.ui?.notify(JSON.stringify(await owner(context, 'status')), 'info'); }
      catch (error) { await report(error, context); }
    },
  });
  api.on('session_start', async (_event, context) => {
    try {
      const status = record(await owner(context, 'status'));
      managed = status.mode === 'managed' && status.connectionsVersion === 1;
      activateManagedTools(api, managed);
    } catch (error) { managed = false; activateManagedTools(api, false); await report(error, context); }
    // The service atomically adds session-start with the first accepted capture.
    // No network side-effect is needed just to open or rebuild a session.
  });
  api.on('before_agent_start', async (event, context) => {
    if (retired) return;
    query = typeof event.prompt === 'string' ? event.prompt.slice(0, 2000) : '';
    packet = undefined; attempted = false;
    await recall(context);
    await capture('prompt', { prompt: event.prompt }, context);
  });
  api.on('context', async (event, context) => {
    if (retired || context.signal.aborted || !Array.isArray(event.messages)) return;
    if (refresh || (!packet && !attempted)) await recall(context);
    if (retired || context.signal.aborted) return;
    const messages = event.messages.filter(message => {
      if (!message || typeof message !== 'object') return true;
      const value = message as Record<string, unknown>;
      return !(value.role === 'user' && typeof value.content === 'string' && injected.has(value.content));
    });
    if (!packet) return messages.length === event.messages.length ? undefined : { messages };
    injected.add(packet.text);
    if (injected.size > 100) injected.delete(injected.values().next().value!);
    // User content is supported by Desktop's context transform and never writes the transcript.
    return { messages: [{ role: 'user', content: packet.text, timestamp: Date.now() }, ...messages] };
  });
  api.on('tool_call', async (event, context) => {
    if (typeof event.toolName === 'string' && event.toolName.startsWith('aim_')) return;
    if (typeof event.toolCallId === 'string') {
      if (calls.size >= 100) calls.delete(calls.keys().next().value!);
      calls.set(event.toolCallId, sanitize(event.input, 8000));
    }
    await capture('tool_call', { toolName: event.toolName, toolCallId: event.toolCallId, input: event.input }, context);
  });
  api.on('tool_result', async (event, context) => {
    if (typeof event.toolName === 'string' && event.toolName.startsWith('aim_')) { refresh = true; attempted = false; packet = undefined; return; }
    const input = event.input ?? (typeof event.toolCallId === 'string' ? calls.get(event.toolCallId) : undefined);
    if (typeof event.toolCallId === 'string') calls.delete(event.toolCallId);
    await capture('tool_result', { toolName: event.toolName, toolCallId: event.toolCallId, input, content: textParts(event.content), isError: event.isError === true, cancelled: event.cancelled === true }, context);
  });
  api.on('agent_end', async (event, context) => {
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const final = [...messages].reverse().find(message => message && typeof message === 'object' && message.role === 'assistant') as Record<string, unknown> | undefined;
    const outcome = final?.stopReason === 'aborted' ? 'cancelled' : final?.stopReason === 'error' ? 'failed' : final?.stopReason === 'stop' ? 'completed' : 'interrupted';
    await capture('agent_end', { outcome, content: textParts(final?.content), cancelled: outcome === 'cancelled', isError: outcome === 'failed' }, context);
    calls.clear();
  });
  api.on('session_before_compact', async (_event, context) => { refresh = true; attempted = false; packet = undefined; epoch++; await capture('compact', {}, context); });
  api.on('session_compact', async () => { refresh = true; attempted = false; packet = undefined; epoch++; });
  api.on('session_shutdown', async (_event, context) => {
    retired = true; epoch++; packet = undefined; injected.clear(); calls.clear();
    if (context.mode === 'agent') await owner(context, 'retire', {});
  });
}
