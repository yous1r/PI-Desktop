import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from '../fixtures/upstream/v3.3.2.json';
import { inspectCapabilities } from '../../src/upstream/capabilities.js';
import { decodeRpc, McpTransport, unwrapTool, retryAfter } from '../../src/upstream/transport.js';
import { V3Adapter } from '../../src/upstream/adapters/v3.js';
import { connection, SyntheticConnections } from '../helpers.js';
import { errorCode } from '../../src/contracts.js';

const scope = { connectionId: connection.id, connectionRevision: 1, workspace: 'team', project: 'project-a' };
test('reviewed production catalog enables writes but missing observation schema disables capture', () => {
  const report = inspectCapabilities(fixture.initialize, fixture.tools);
  assert.equal(report.version, '3.3.2'); assert.equal(report.writes, true); assert.equal(report.capture, false);
  assert.ok(Object.entries(report.tools).filter(([name]) => name !== 'observations').every(([, tool]) => tool.available));
  assert.equal(report.tools.observations?.available, false);
});
test('future and missing versions stay read-only; protocol changes fail closed', () => {
  for (const version of ['9.0.0', undefined]) {
    const report = inspectCapabilities({ ...fixture.initialize, serverInfo: { version } }, fixture.tools);
    assert.equal(report.knownVersion, false); assert.equal(report.writes, false); assert.equal(report.tools.query?.available, true);
  }
  assert.throws(() => inspectCapabilities({ ...fixture.initialize, protocolVersion: '2099-01-01' }, fixture.tools), /PROTOCOL_UNSUPPORTED/);
});
test('schema drift: optional additions accepted, required unknown fields/types/deletions/enums rejected per capability', () => {
  const source = structuredClone(fixture.tools[0]);
  const optional = { ...source, inputSchema: { ...source.inputSchema, properties: { ...source.inputSchema.properties, future: { type: 'string' } } } };
  assert.equal(inspectCapabilities(fixture.initialize, [optional]).tools.query?.available, true);
  const required = { ...optional, inputSchema: { ...optional.inputSchema, required: ['query', 'future'] } };
  assert.equal(inspectCapabilities(fixture.initialize, [required]).tools.query?.available, false);
  for (const changed of [{ type: 'integer' }, { type: 'string', enum: ['restricted'] }, undefined]) {
    const tool = { ...source, inputSchema: { ...source.inputSchema, properties: { ...source.inputSchema.properties, query: changed } } };
    assert.equal(inspectCapabilities(fixture.initialize, [tool]).tools.query?.available, false);
  }
  assert.equal(inspectCapabilities(fixture.initialize, []).tools.readPage?.available, false);
});
test('query requires explicit no-synthesis support even for unknown server releases', () => {
  const source = structuredClone(fixture.tools[0]);
  for (const answer of [undefined, { type: 'string' }, { type: 'boolean', const: true }]) {
    const changed = { ...source, inputSchema: { ...source.inputSchema, properties: { ...source.inputSchema.properties, answer } } };
    const report = inspectCapabilities({ ...fixture.initialize, serverInfo: { version: '9.0.0' } }, [changed]);
    assert.equal(report.tools.query?.available, false);
  }
});
test('JSON and SSE RPC normalize results and reject wrong IDs, tool errors, and oversized data', () => {
  const response = { status: 200, connectionRevision: 1, headers: { 'content-type': 'application/json' }, bodyText: JSON.stringify({ jsonrpc: '2.0', id: 'id', result: { content: [{ type: 'text', text: '{"ok":true}' }] } }) };
  assert.deepEqual(unwrapTool(decodeRpc(response, 'id')), { ok: true });
  const sse = { ...response, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }, bodyText: `: ping\n\nevent: message\ndata: ${response.bodyText}\n\n` };
  assert.deepEqual(unwrapTool(decodeRpc(sse, 'id')), { ok: true });
  assert.throws(() => decodeRpc(response, 'wrong'), /RPC_ID_MISMATCH/);
  assert.throws(() => unwrapTool({ isError: true, content: [] }), /UPSTREAM_TOOL_ERROR/);
  assert.throws(() => decodeRpc({ ...response, bodyText: 'x'.repeat(1024 * 1024 + 1) }, 'id'), /RESPONSE_TOO_LARGE/);
  assert.throws(() => decodeRpc({ ...response, bodyText: '{"jsonrpc":"2.0","id":"id","error":{"message":"secret"}}' }, 'id'), /RPC_ERROR/);
  assert.equal(retryAfter('5'), 5000);
});
test('stateful SSE transport uses transport session, explicit scope, and no consuming endpoint', async () => {
  const network = new SyntheticConnections(); network.sse = true; network.stateful = true;
  const adapter = new V3Adapter(new McpTransport(network, scope));
  const signal = new AbortController().signal;
  await adapter.discover(signal); await adapter.query('transactions', signal); await adapter.listHandoffs(signal);
  assert.equal(network.requests[0].headers?.['Mcp-Session-Id'], undefined);
  assert.equal(network.requests[1].headers?.['Mcp-Session-Id'], 'transport-session');
  assert.ok(network.requests.every(request => request.path === '/mcp' && request.method === 'POST'));
  const args = JSON.parse(network.requests.at(-1)!.body!).params.arguments;
  assert.deepEqual(args, { limit: 10, workspace: 'team', project: 'project-a' });
  assert.deepEqual(network.claimed, []);
});
test('IPC errors retain only fixed diagnostic codes, never arbitrary messages or codes', () => {
  assert.equal(errorCode(new Error('PERMISSION_DENIED')), 'PERMISSION_DENIED');
  assert.equal(errorCode({ code: 'CONNECTION_CHANGED', message: 'Bearer synthetic-secret' }), 'CONNECTION_CHANGED');
  assert.equal(errorCode(new Error('Bearer synthetic-secret')), 'UNEXPECTED_FAILURE');
  assert.equal(errorCode({ code: 'Bearer synthetic-secret' }), 'UNEXPECTED_FAILURE');
});
