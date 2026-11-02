import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates } from "node:tls";
import { createMcpTlsFetch, validateMcpCertificate } from "../electron/main/mcp-tls.ts";
import { McpServerClient } from "../electron/main/plugin-mcp.ts";
import { UserMcpRuntime } from "../electron/main/user-mcp.ts";

let directory;
let trusted;
let other;
let wrongHostname;

function certificate(name, san) {
  const keyPath = join(directory, `${name}.key`);
  const certPath = join(directory, `${name}.pem`);
  const result = spawnSync(process.env.PI_TEST_OPENSSL || "openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-subj", `/CN=${name}`, "-addext", `subjectAltName=${san}`,
    "-addext", "basicConstraints=critical,CA:TRUE", "-keyout", keyPath, "-out", certPath,
  ], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  assert.equal(result.status, 0, `Set PI_TEST_OPENSSL to an existing OpenSSL binary. ${result.error?.message || result.stderr}`);
  return Promise.all([readFile(keyPath, "utf8"), readFile(certPath, "utf8")]).then(([key, cert]) => ({ key, cert }));
}

before(async () => {
  directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-mcp-tls-"));
  trusted = await certificate("trusted", "DNS:localhost,IP:127.0.0.1");
  other = await certificate("other", "DNS:localhost,IP:127.0.0.1");
  wrongHostname = await certificate("wrong-host", "DNS:unrelated.example");
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 5 }); });

async function peer(t, credentials = trusted, handler) {
  const requests = [];
  const server = createServer(credentials, async (request, response) => {
    requests.push({ path: request.url, method: request.method });
    if (handler) return handler(request, response);
    if (request.method === "GET") return response.writeHead(200).end("healthy");
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) return response.writeHead(202).end();
    let result = {};
    if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "tls-peer", version: "1" } };
    if (message.method === "tools/list") result = { tools: [{ name: "sc_memory_status", inputSchema: { type: "object" } }] };
    if (message.method === "tools/call") result = { content: [{ type: "text", text: JSON.stringify(message.params.arguments) }] };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `https://127.0.0.1:${server.address().port}/mcp`, requests };
}

function runtime(t) {
  const instance = new UserMcpRuntime({ createClient: (config) => new McpServerClient(config), connectTimeoutMs: 5_000, callTimeoutMs: 5_000 });
  t.after(() => instance.disposeAll());
  return instance;
}
function record(url, caCertificate) {
  return { id: "tls-peer", label: "TLS peer", transport: "http", url, caCertificate, enabled: true,
    scope: { mode: "global", projects: [] }, memoryProjectBindings: { "remote-project:tls": "alpha" } };
}

test("CA import accepts public certificates only and keeps bounded input", () => {
  assert.equal(validateMcpCertificate(trusted.cert).length, 1);
  for (const invalid of [trusted.key, `${trusted.cert}\n${trusted.key}`, "C:/private/ca.pem", "-----BEGIN CERTIFICATE-----\nbad\n-----END CERTIFICATE-----", trusted.cert.repeat(17), "x".repeat(65537)]) {
    assert.throws(() => validateMcpCertificate(invalid), { errorCode: "MCP_CA_INVALID" });
  }
});

test("real HTTPS MCP succeeds with selected CA without changing default trust", async (t) => {
  const defaults = getCACertificates("default");
  const endpoint = await peer(t);
  await assert.rejects(fetch(endpoint.url));
  const instance = runtime(t);
  instance.setRecords([record(endpoint.url, trusted.cert)]);
  const tools = await instance.toolsForProject("remote-project:tls");
  assert.equal(tools.length, 1);
  assert.equal(instance.statusFor("tls-peer").state, "ready");
  const value = await instance.callTool(tools[0].fullName, {}, "remote-project:tls");
  assert.deepEqual(JSON.parse(value.content[0].text), { project: "alpha" });
  assert.ok(endpoint.requests.some((request) => request.method === "POST"));
  assert.deepEqual(getCACertificates("default"), defaults);
  await assert.rejects(fetch(endpoint.url), "a selected MCP CA must not become global trust");
});

test("wrong CA is a visible structured TLS failure, then explicit correction reconnects", async (t) => {
  const endpoint = await peer(t);
  const instance = runtime(t);
  instance.setRecords([record(endpoint.url, other.cert)]);
  const failed = await instance.test("tls-peer");
  assert.equal(failed.state, "failed");
  assert.equal(failed.errorCode, "MCP_TLS_FAILED");
  assert.match(failed.message, /TLS verification failed/);
  assert.equal(endpoint.requests.length, 0);
  instance.setRecords([record(endpoint.url, trusted.cert)]);
  assert.equal((await instance.test("tls-peer")).state, "ready");
});

test("selected trust still verifies the certificate hostname", async (t) => {
  const endpoint = await peer(t, wrongHostname);
  await assert.rejects(createMcpTlsFetch(wrongHostname.cert)(endpoint.url), { errorCode: "MCP_TLS_FAILED" });
  assert.equal(endpoint.requests.length, 0);
});

test("managed CA MCP refuses even same-origin redirects before sending a second request", async (t) => {
  const endpoint = await peer(t, trusted, (request, response) => {
    response.writeHead(307, { location: "/redirect-target" }).end();
  });
  const instance = runtime(t);
  instance.setRecords([record(endpoint.url, trusted.cert)]);
  const failed = await instance.test("tls-peer");
  assert.equal(failed.state, "failed");
  assert.equal(failed.errorCode, "MCP_HTTP_REDIRECT");
  assert.match(failed.message, /Redirects are refused/);
  assert.deepEqual(endpoint.requests.map((request) => request.path), ["/mcp"]);
});

test("the scoped HTTPS adapter releases a cancelled request and rejects non-HTTPS", async (t) => {
  let markReceived;
  const received = new Promise((resolve) => { markReceived = resolve; });
  const endpoint = await peer(t, trusted, () => markReceived());
  const controller = new AbortController();
  const selectedFetch = createMcpTlsFetch(trusted.cert);
  const pending = selectedFetch(endpoint.url, { signal: controller.signal });
  await received;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(selectedFetch("http://127.0.0.1/mcp"), { errorCode: "MCP_CA_INVALID" });
});
