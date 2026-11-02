import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { McpServerClient } from "../electron/main/plugin-mcp.ts";

const TOKEN = "testkey";
async function client(t, reply) {
  const audit = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    if (message.id === undefined) return response.writeHead(202).end();
    response.setHeader("content-type", "application/json");
    if (message.method === "tools/call") return reply(message, response);
    const result = message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "peer", version: "1" } }
      : { tools: [{ name: "lookup", description: `Do not expose ${TOKEN}`, inputSchema: { type: "object" } }] };
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const instance = new McpServerClient({ rootPath: tmpdir(), server: { id: "redaction", transport: "http", url: `http://127.0.0.1:${server.address().port}/mcp` },
    values: { Authorization: `Bearer ${TOKEN}` }, redactValues: [TOKEN], audit: (entry) => audit.push(entry), connectTimeoutMs: 5_000, callTimeoutMs: 5_000 });
  t.after(() => instance.close());
  await instance.connect();
  assert.doesNotMatch(JSON.stringify(instance.getTools()), new RegExp(TOKEN));
  return { instance, audit };
}

function safeFailure(error, code) {
  assert.equal(error.code, code);
  assert.doesNotMatch(String(error.stack), new RegExp(TOKEN));
  assert.doesNotMatch(JSON.stringify(error), new RegExp(TOKEN));
  return true;
}

test("peer JSON-RPC and tool error text is redacted before rejection and audit", async (t) => {
  let toolError = false;
  const f = await client(t, (message, response) => response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
    ...(toolError ? { result: { isError: true, content: [{ type: "text", text: `Failed for ${TOKEN}` }] } }
      : { error: { code: -32000, message: `Rejected ${TOKEN}`, data: { credential: TOKEN } } }) })));
  await assert.rejects(f.instance.callTool("lookup", {}), (error) => safeFailure(error, "MCP_ERROR"));
  toolError = true;
  await assert.rejects(f.instance.callTool("lookup", {}), (error) => safeFailure(error, "TOOL_FAILED"));
  assert.doesNotMatch(JSON.stringify(f.audit), new RegExp(TOKEN));
  assert.match(JSON.stringify(f.audit), /redacted/);
});

test("malformed JSON that echoes the credential cannot leak through transport errors", async (t) => {
  const f = await client(t, (_message, response) => response.end(TOKEN));
  await assert.rejects(f.instance.callTool("lookup", {}), (error) => {
    assert.doesNotMatch(String(error.stack), new RegExp(TOKEN));
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
    return true;
  });
  assert.doesNotMatch(JSON.stringify(f.audit), new RegExp(TOKEN));
});

test("deep peer responses fail closed without leaving a pending request to time out", async (t) => {
  const f = await client(t, (message, response) => {
    let nested = { [TOKEN]: TOKEN };
    for (let depth = 0; depth < 70; depth += 1) nested = { child: nested };
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: nested }));
  });
  await assert.rejects(f.instance.callTool("lookup", {}), (error) => safeFailure(error, "INVALID_RESPONSE"));
  assert.equal(f.instance.isConnected(), true);
  assert.doesNotMatch(JSON.stringify(f.audit), new RegExp(TOKEN));
});
