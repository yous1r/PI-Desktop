import test from 'node:test';
import assert from 'node:assert/strict';
import extension from '../../src/extension.js';
import { record } from '../../src/contracts.js';
import { MANAGED_TOOL_NAMES, type ExtensionApi, type ExtensionContext } from '../../src/tools/managed.js';
import { context, harness, settings } from '../helpers.js';

function runner() {
  const handlers = new Map<string, Parameters<ExtensionApi['on']>[1]>();
  const tools = new Map<string, Parameters<ExtensionApi['registerTool']>[0]>();
  let active: string[] = ['Read', 'mem_query'];
  const api: ExtensionApi = { on: (name, callback) => handlers.set(name, callback), registerCommand: () => {}, registerTool: tool => { tools.set(tool.name, tool); active.push(tool.name); }, getActiveTools: () => active, setActiveTools: names => { active = names; } };
  extension(api);
  return { handlers, tools, active: () => active, emit: (name: string, event: Record<string, unknown>, ctx: ExtensionContext) => handlers.get(name)?.(event, ctx) };
}
test('real extension/service path injects once into model context without changing transcript; coexist tools stay hidden', async () => {
  const config = settings(); config.mode = 'coexist';
  const h = await harness({ config });
  try {
    const runtime = runner();
    const hostContext = context();
    const ctx: ExtensionContext = { ...hostContext, owner: { version: 1, call: (operation, payload) => h.service.call(operation, payload, hostContext) }, ui: { confirm: async () => false, notify: () => {} } };
    await runtime.emit('session_start', {}, ctx);
    assert.deepEqual(runtime.active(), ['Read', 'mem_query']);
    await runtime.emit('before_agent_start', { prompt: 'transaction design' }, ctx);
    const transcript = [{ role: 'user', content: 'transaction design' }];
    const first = record(await runtime.emit('context', { messages: transcript }, ctx));
    const second = record(await runtime.emit('context', { messages: first.messages }, ctx));
    assert.equal((second.messages as unknown[]).length, 2);
    assert.equal(transcript.length, 1); assert.equal(transcript[0].content, 'transaction design');
    const modelMessages = second.messages as Array<{ role: string; content: string }>;
    assert.equal(modelMessages[0].role, 'user'); assert.match(modelMessages[0].content, /transaction boundaries/);
    assert.deepEqual(h.network.claimed, []);
    await runtime.emit('session_shutdown', {}, { ...ctx, retirementReason: 'reconfigure' });
    assert.equal(await runtime.emit('context', { messages: transcript }, ctx), undefined);
    const rebuilt = runner(); await rebuilt.emit('session_start', {}, ctx); await rebuilt.emit('before_agent_start', { prompt: 'transaction design' }, ctx);
    assert.ok(await rebuilt.emit('context', { messages: transcript }, ctx));
  } finally { await h.cleanup(); }
});
test('managed tools require real confirmation and route exact operation through owner', async () => {
  const h = await harness();
  try {
    const runtime = runner(); const hc = context(); let confirmed = false;
    const ctx: ExtensionContext = { ...hc, owner: { version: 1, call: (operation, payload) => h.service.call(operation, payload, hc) }, ui: { notify: () => {}, confirm: async () => confirmed } };
    await runtime.emit('session_start', {}, ctx);
    assert.ok(MANAGED_TOOL_NAMES.every(name => runtime.active().includes(name)));
    const write = runtime.tools.get('aim_writePage')!;
    const args = { path: 'notes/tool.md', body: '# Tool\nExplicit save', createOnly: true };
    await assert.rejects(write.execute('call-1', args, ctx.signal, undefined, ctx), /CONFIRMATION_REQUIRED/);
    assert.equal(h.network.pages.size, 0);
    confirmed = true; await write.execute('call-1', args, ctx.signal, undefined, ctx);
    assert.equal(h.network.pages.size, 1);
  } finally { await h.cleanup(); }
});
test('retired instance rejects late recall and another factory remains independent', async () => {
  const old = runner(); const next = runner();
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const hc = context();
  const ctx: ExtensionContext = { ...hc, owner: { version: 1, call: async operation => operation === 'recall' ? pending : {} }, ui: { confirm: async () => false, notify: () => {} } };
  const waiting = old.emit('context', { messages: [] }, ctx);
  await old.emit('session_shutdown', {}, ctx);
  finish({ id: 'old', text: 'STALE HISTORY' }); await waiting;
  assert.equal(await old.emit('context', { messages: [] }, ctx), undefined);
  const newCtx: ExtensionContext = { ...ctx, runtimeId: 'next', owner: { version: 1, call: async () => ({ id: 'new', text: 'NEW HISTORY' }) } };
  const result = record(await next.emit('context', { messages: [] }, newCtx));
  assert.match(JSON.stringify(result), /NEW HISTORY/); assert.equal(JSON.stringify(result).includes('STALE HISTORY'), false);
});
test('missing owner capability leaves normal context untouched and does not upload', async () => {
  const runtime = runner(); const notices: string[] = [];
  const ctx: ExtensionContext = { signal: new AbortController().signal, ui: { confirm: async () => false, notify: message => { notices.push(message); } } };
  await runtime.emit('session_start', {}, ctx);
  assert.equal(await runtime.emit('context', { messages: [{ role: 'user', content: 'Hi' }] }, ctx), undefined);
  assert.deepEqual(runtime.active(), ['Read', 'mem_query']); assert.match(notices[0], /HOST_UPGRADE_REQUIRED/);
});
