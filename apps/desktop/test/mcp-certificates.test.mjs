import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { UserMcpRuntime } from "../electron/main/user-mcp.ts";
import { McpServerClient } from "../electron/main/plugin-mcp.ts";
import { connect, Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { createMcpTlsFetch, validateMcpCertificate } from "@pi-desktop/host-runtime/mcp/tls";

const fixtures = new URL("../../../scripts/e2e/fixtures/certificates/", import.meta.url);
const cert = await readFile(new URL("localhost-cert.pem", fixtures), "utf8");
const key = await readFile(new URL("localhost-key.pem", fixtures), "utf8");

async function fixture(t, override) {
  const sockets = new Set();
  const server = createServer({ cert, key }, async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const message = JSON.parse(body);
    if (override?.(req, res, message)) return;
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} } }
      : message.method === "tools/list" ? { tools: [{ name: "lookup", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: "private CA connected" }] };
    // Keep the stream open: discovery must not wait for its HTTP body to end.
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return `https://localhost:${server.address().port}/mcp`;
}

function runtime(t) {
  const rt = new UserMcpRuntime({ isAdmissionClosed: () => false, createClient: config => new McpServerClient(config), connectTimeoutMs: 1500, callTimeoutMs: 1500 });
  t.after(() => rt.disposeAll());
  return rt;
}
const record = (url, caCertificate) => ({ id: "private", label: "Private", transport: "http", url, caCertificate, enabled: true });

test("MCP private CA connects, calls tools over SSE, and clearing it revokes trust", async t => {
  const url = await fixture(t);
  const rt = runtime(t);
  rt.setRecords([record(url)]);
  assert.equal((await rt.test("private")).state, "failed");
  rt.setRecords([record(url, cert)]);
  assert.equal((await rt.test("private")).state, "ready");
  assert.deepEqual((await rt.toolsForProject(null)).map(tool => tool.fullName), ["mcp_private_lookup"]);
  assert.deepEqual(await rt.callTool("mcp_private_lookup", {}, null), { content: [{ type: "text", text: "private CA connected" }] });
  rt.setRecords([record(url)]);
  assert.equal((await rt.test("private")).state, "failed");
});

test("MCP private CA still rejects a hostname mismatch and cross-origin redirects", async t => {
  const url = await fixture(t);
  const rt = runtime(t);
  rt.setRecords([record(url.replace("localhost", "127.0.0.1"), cert)]);
  assert.equal((await rt.test("private")).state, "failed");
  const redirect = await fixture(t, (_req, res) => { res.writeHead(307, { location: url }); res.end(); return true; });
  rt.setRecords([record(redirect, cert)]);
  const status = await rt.test("private");
  assert.equal(status.state, "failed");
  assert.match(status.message, /origin/i);
});

test("MCP editor preserves existing CA, clears explicitly, and rejects HTTP with CA", async () => {
  const server = await createViteServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, esbuild: { jsx: "automatic" }, appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { draftFromRecord, draftToInput, mcpDraftError } = await server.ssrLoadModule("/src/components/extensions/McpEditorSheet.tsx");
    const draft = draftFromRecord(record("https://localhost/mcp", cert));
    assert.equal(draft.caCertificate, cert);
    assert.equal(draftToInput(draft).caCertificate, cert.trim());
    assert.equal(mcpDraftError({ ...draft, url: "http://localhost/mcp" }), "extensions.mcp.caRequiresHttps");
    assert.equal(draftToInput({ ...draft, caCertificate: "" }).caCertificate, null);
    assert.equal("caCertificate" in draftToInput({ ...draft, transport: "stdio", command: "node" }), false);
  } finally { await server.close(); }
});

test("MCP CA validates public bundles and refuses private keys and oversized input", () => {
  assert.equal(validateMcpCertificate(cert).length, 1);
  for (const invalid of ["", key, `${cert}\n${key}`, "x".repeat(65537), cert.repeat(17)]) {
    assert.throws(() => validateMcpCertificate(invalid), { code: "MCP_CA_INVALID" });
  }
});

test("MCP CA uses the supplied proxy route and decodes compressed responses", async t => {
  const url = await fixture(t, (_req, res) => {
    res.writeHead(200, { "content-encoding": "gzip" });
    res.end(gzipSync("proxied response")); return true;
  });
  const routes = [];
  const fetch = createMcpTlsFetch(cert, url, async (host, port, signal) => {
    routes.push({ host, port });
    const socket = connect({ host: "127.0.0.1", port, signal });
    await once(socket, "connect", { signal }); return socket;
  });
  const response = await fetch(url, { method: "POST", body: "{}" });
  assert.equal(await response.text(), "proxied response");
  assert.deepEqual(routes, [{ host: "localhost", port: Number(new URL(url).port) }]);
});

test("MCP CA cancellation rejects immediately and closes a late proxy socket", async () => {
  const pending = Promise.withResolvers();
  const abort = new AbortController();
  const fetch = createMcpTlsFetch(cert, "https://localhost/mcp", () => pending.promise);
  const work = fetch("https://localhost/mcp", { signal: abort.signal });
  abort.abort();
  await assert.rejects(work, { name: "AbortError" });
  const socket = new Socket(); const closed = once(socket, "close");
  pending.resolve(socket); await closed;
  assert.equal(socket.destroyed, true);
});
