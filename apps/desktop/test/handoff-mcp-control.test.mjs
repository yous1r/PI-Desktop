import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { Agent, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { McpControlServer } = await import("../electron/main/mcp-control.ts");

const CHANNELS = {
  appGetVersion: "pi-desktop/app/getVersion",
  sessionGet: "pi-desktop/session/get",
};

const fixtureDir = (prefix) => mkdtempSync(join(tmpdir(), prefix));

/** Controlled macrotask sync point; no timer advances the behavior under test. */
async function flush(turns = 4) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Observe an externally caused state change with a bounded poll. */
async function eventually(predicate, label) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`condition was not reached: ${label}`);
}

async function post(url, token, body, headers = {}, signal) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const raw = await response.text();
  return { response, body: raw ? JSON.parse(raw) : null };
}

/** One request over an explicit keep-alive agent, so the socket stays open. */
function postKeepingConnection(url, token, body, agent) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = httpRequest(
      url,
      {
        method: "POST",
        agent,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let raw = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => resolve({
          status: response.statusCode,
          headers: response.headers,
          body: raw ? JSON.parse(raw) : null,
        }));
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18" },
};

async function initializeSession(info) {
  const { response, body } = await post(info.url, info.token, initializeBody);
  assert.equal(response.status, 200);
  assert.equal(body.result.serverInfo.name, "pi-desktop");
  return response.headers.get("mcp-session-id");
}

const invokeBody = (id = 2) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: {
    name: "pi_desktop_invoke",
    arguments: { operation: "app/getVersion", args: [] },
  },
});

const activity = (server) => server.getHandoffActivity();

test("the MCP control owner reports the synchronous handoff contract", async () => {
  const server = new McpControlServer({
    dataDir: fixtureDir("pi-mcp-handoff-contract-"),
    port: 0,
    channels: CHANNELS,
    invoke: async () => ({ ok: true }),
  });
  const idle = activity(server);
  assert.deepEqual(idle, { operations: 0, resources: 0, uncontainedResources: 0 });
  assert.deepEqual(Object.keys(idle).sort(), ["operations", "resources", "uncontainedResources"]);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(idle))) {
    assert.equal("value" in descriptor, true, "the report is a data property, not an accessor");
    assert.equal(Number.isSafeInteger(descriptor.value), true);
    assert.ok(descriptor.value >= 0);
  }

  const info = await server.start();
  assert.equal(info.active, true);
  assert.equal(activity(server).resources, 1, "the live listener is a resource");
  assert.equal(activity(server).operations, 0);
  assert.equal(activity(server).uncontainedResources, 0);

  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const initialized = await postKeepingConnection(info.url, info.token, initializeBody, agent);
    assert.equal(initialized.status, 200);
    assert.equal(typeof initialized.headers["mcp-session-id"], "string");
    await eventually(
      () => activity(server).resources === 2,
      "the accepted keep-alive socket is counted as a resource",
    );
    assert.equal(activity(server).operations, 0, "a settled request releases its operation");
  } finally {
    agent.destroy();
  }
  await eventually(
    () => activity(server).resources === 1,
    "the closed client socket stops being a resource",
  );

  await server.stop();
  await eventually(
    () => activity(server).resources === 0,
    "the listener and socket closure are observed",
  );
  assert.deepEqual(activity(server), { operations: 0, resources: 0, uncontainedResources: 0 });
});

test("an accepted handler stays counted through caller disconnect and the post-effect", async () => {
  let resolveInvoke;
  const invokeGate = new Promise((resolve) => {
    resolveInvoke = resolve;
  });
  let resolvePostEffect;
  const postEffectGate = new Promise((resolve) => {
    resolvePostEffect = resolve;
  });
  let signalPostEffect;
  const postEffectEntered = new Promise((resolve) => {
    signalPostEffect = resolve;
  });
  const effects = [];
  const server = new McpControlServer({
    dataDir: fixtureDir("pi-mcp-handoff-inflight-"),
    port: 0,
    channels: CHANNELS,
    invoke: async (channel, args) => {
      effects.push({ channel, args });
      await invokeGate;
      return { name: "PI-Desktop", version: "test" };
    },
    onOperationComplete: async () => {
      signalPostEffect();
      await postEffectGate;
    },
  });
  const info = await server.start();
  const sessionId = await initializeSession(info);

  const controller = new AbortController();
  const request = post(info.url, info.token, invokeBody(), { "Mcp-Session-Id": sessionId }, controller.signal);
  await eventually(
    () => activity(server).operations === 1,
    "the accepted request is counted before its effect",
  );
  controller.abort();
  await assert.rejects(() => request);
  await flush();
  assert.equal(effects.length, 1, "the admitted effect was dispatched exactly once");
  assert.equal(
    activity(server).operations,
    1,
    "a caller disconnect does not release the handler before it settles",
  );

  resolveInvoke();
  await postEffectEntered;
  assert.equal(
    activity(server).operations,
    1,
    "the renderer post-effect is part of the handler lifetime",
  );

  resolvePostEffect();
  await eventually(
    () => activity(server).operations === 0,
    "the handler is released after actual settlement",
  );
  await server.stop();
});

test("stop retains a handler that outlives the bound instead of claiming closure", async () => {
  let resolveInvoke;
  const invokeGate = new Promise((resolve) => {
    resolveInvoke = resolve;
  });
  const dir = fixtureDir("pi-mcp-handoff-retained-");
  const server = new McpControlServer({
    dataDir: dir,
    port: 0,
    channels: CHANNELS,
    invoke: async () => {
      await invokeGate;
      return { ok: true };
    },
  });
  const info = await server.start();
  const sessionId = await initializeSession(info);
  const request = post(info.url, info.token, invokeBody(), { "Mcp-Session-Id": sessionId })
    .catch((error) => ({ error }));
  await eventually(
    () => activity(server).operations === 1,
    "the handler is accepted before stop",
  );

  await server.stop();
  assert.equal(server.isRunning, false);
  assert.equal(activity(server).operations, 1, "the stop bound does not erase the pending handler");
  assert.ok(
    activity(server).uncontainedResources >= 1,
    "an expired drain is retained uncertainty, not containment proof",
  );
  await eventually(
    () => activity(server).resources === 0,
    "the listener and socket closure are observed",
  );
  assert.equal(JSON.parse(readFileSync(join(dir, "mcp-control.json"), "utf8")).active, false);
  await assert.rejects(
    () => server.start(),
    (error) => error.code === "HOST_BUSY",
  );

  resolveInvoke();
  await request;
  await eventually(
    () => activity(server).operations === 0,
    "the retained handler settles after the stop",
  );
  assert.ok(
    activity(server).uncontainedResources >= 1,
    "uncontained resources never decrease",
  );
});

test("a stop that wins a start leaves no listener and publishes nothing", async () => {
  const dir = fixtureDir("pi-mcp-handoff-start-race-");
  const server = new McpControlServer({
    dataDir: dir,
    port: 0,
    channels: CHANNELS,
    invoke: async () => ({ ok: true }),
  });
  const starting = server.start();
  const stopping = server.stop();
  await assert.rejects(
    () => starting,
    (error) => error.code === "HOST_BUSY",
  );
  await stopping;
  assert.equal(server.isRunning, false);
  assert.deepEqual(activity(server), { operations: 0, resources: 0, uncontainedResources: 0 });
  assert.equal(existsSync(join(dir, "mcp-control.token")), true, "the attempt loaded its token");
  assert.equal(existsSync(join(dir, "mcp-control.json")), false, "no endpoint was published");
});

test("closing admission while an authenticated body arrives refuses dispatch", async () => {
  let closed = false, invoked = 0;
  const server = new McpControlServer({ dataDir: fixtureDir("pi-mcp-handoff-body-"), port: 0,
    channels: CHANNELS, isAdmissionClosed: () => closed, invoke: async () => { invoked++; return {}; } });
  const info = await server.start();
  try {
    const session = await initializeSession(info);
    const payload = JSON.stringify(invokeBody());
    let request;
    const done = new Promise((resolve, reject) => {
      request = httpRequest(info.url, { method: "POST", headers: { Authorization: `Bearer ${info.token}`,
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), "Mcp-Session-Id": session } }, response => {
        response.resume(); response.once("end", () => resolve(response.statusCode));
      });
      request.on("error", reject); request.write(payload.slice(0, 8));
    });
    await eventually(() => activity(server).operations === 1, "partial request body is retained");
    closed = true; request.end(payload.slice(8));
    assert.equal(await done, 503);
    assert.equal(invoked, 0);
  } finally { await server.stop(); }
});

test("closing admission during endpoint persistence withdraws the original listener", async t => {
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const entered = Promise.withResolvers(), resume = Promise.withResolvers();
  const dir = fixtureDir("pi-mcp-handoff-manifest-");
  const write = fs.writeFile;
  t.mock.method(fs, "writeFile", async (path, contents, ...args) => {
    if (path === join(dir, "mcp-control.json") && JSON.parse(contents).active) { entered.resolve(); await resume.promise; }
    return write(path, contents, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  let closed = false;
  const server = new McpControlServer({ dataDir: dir, port: 0, channels: CHANNELS,
    isAdmissionClosed: () => closed, invoke: async () => ({}) });
  const starting = server.start();
  const rejected = assert.rejects(starting, { code: "HOST_BUSY" });
  await entered.promise;
  assert.ok(activity(server).operations > 0);
  closed = true; resume.resolve();
  try {
    await rejected;
    assert.equal(server.isRunning, false);
    assert.equal(activity(server).resources, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, "mcp-control.json"), "utf8")).active, false);
  } finally { resume.resolve(); await server.stop(); }
});
