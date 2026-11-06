import assert from "node:assert/strict";
import { app, session } from "electron";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { createServer, connect } from "node:net";
import { readFile } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { join } from "node:path";
import { applyNetworkProxy, fetchWithNetworkProxy } from "../../electron/main/network-proxy.ts";

async function main() {
await app.whenReady();
const sockets = new Set();
const track = socket => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); return socket; };
const listen = async server => {
  server.on("connection", track);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
};
const certDir = join(process.env.PI_PROXY_TEST_ROOT, "scripts/e2e/fixtures/certificates");
const cert = await readFile(join(certDir, "localhost-cert.pem"));
const key = await readFile(join(certDir, "localhost-key.pem"));
const fingerprint = new X509Certificate(cert).fingerprint256;
const origin = httpsServer({ cert, key }, (_req, res) => res.end("verified-local-release"));
const originPort = await listen(origin);
let httpHits = 0, socksHits = 0;
const credentials = `Basic ${Buffer.from("fixture:password").toString("base64")}`;
function proxy(auth) {
  const server = httpServer((_req, res) => { res.writeHead(502); res.end(); });
  server.on("connect", (req, client, head) => {
    if (auth && req.headers["proxy-authorization"] !== credentials) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n'); return;
    }
    if (req.url !== `artifact.invalid:${originPort}`) { client.destroy(); return; }
    httpHits++;
    const upstream = track(connect(originPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    }));
    client.on("close", () => upstream.destroy());
  });
  return server;
}
function socks(auth) {
  return createServer(client => {
    let bytes = Buffer.alloc(0), stage = "hello";
    const onData = chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (stage === "hello") {
        if (bytes.length < 2 || bytes.length < 2 + bytes[1]) return;
        bytes = bytes.subarray(2 + bytes[1]); stage = auth ? "auth" : "connect";
        client.write(Buffer.from([5, auth ? 2 : 0]));
      }
      if (stage === "auth") {
        if (bytes.length < 2 || bytes.length < 3 + bytes[1]) return;
        const userEnd = 2 + bytes[1], end = userEnd + 1 + bytes[userEnd];
        if (bytes.length < end) return;
        if (bytes.subarray(2, userEnd).toString() !== "fixture" || bytes.subarray(userEnd + 1, end).toString() !== "password") { client.destroy(); return; }
        bytes = bytes.subarray(end); stage = "connect"; client.write(Buffer.from([1, 0]));
      }
      if (stage !== "connect" || bytes.length < 5) return;
      const length = bytes[3] === 3 ? bytes[4] + 7 : bytes[3] === 1 ? 10 : 22;
      if (bytes.length < length) return;
      if (bytes.readUInt16BE(length - 2) !== originPort) { client.destroy(); return; }
      stage = "stream"; client.off("data", onData); socksHits++;
      const rest = bytes.subarray(length);
      const upstream = track(connect(originPort, "127.0.0.1", () => {
        client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        if (rest.length) upstream.write(rest);
        client.pipe(upstream); upstream.pipe(client);
      }));
      client.on("close", () => upstream.destroy());
    };
    client.on("data", onData);
  });
}
const proxies = [proxy(false), proxy(true), socks(false), socks(true)];
const ports = await Promise.all(proxies.map(listen));
const pac = httpServer((_req, res) => { res.setHeader("content-type", "application/x-ns-proxy-autoconfig"); res.end(`function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:${ports[0]}"; }`); });
const pacPort = await listen(pac);
try {
  await app.whenReady();
  session.defaultSession.setCertificateVerifyProc(({ certificate, hostname }, callback) => {
    callback(["127.0.0.1", "artifact.invalid"].includes(hostname) && new X509Certificate(certificate.data).fingerprint256 === fingerprint ? 0 : -3);
  });
  await assert.rejects(fetchWithNetworkProxy("https://artifact.invalid/"), { errorCode: "HOST_NETWORK_NOT_READY" });
  const download = async host => {
    const response = await fetchWithNetworkProxy(`https://${host}:${originPort}/release?${Math.random()}`, { signal: AbortSignal.timeout(8_000) });
    assert.equal(await response.text(), "verified-local-release");
  };
  for (const [index, scheme] of ["http", "http", "socks5", "socks5"].entries()) {
    const before = index < 2 ? httpHits : socksHits;
    const auth = index % 2 ? "fixture:password@" : "";
    // The fetch starts before setProxy resolves; it must wait for that application.
    const applied = applyNetworkProxy({ mode: "custom", url: `${scheme}://${auth}127.0.0.1:${ports[index]}` });
    await download("artifact.invalid"); await applied;
    assert.ok((index < 2 ? httpHits : socksHits) > before);
  }
  await applyNetworkProxy({ mode: "direct" });
  const beforeDirect = httpHits + socksHits;
  await download("127.0.0.1");
  assert.equal(httpHits + socksHits, beforeDirect);
  await applyNetworkProxy({ mode: "system" });
  // Supply a controlled PAC to this isolated Chromium session only.
  const pacSource = `function FindProxyForURL(url, host) { return "PROXY 127.0.0.1:${ports[0]}"; }`;
  await session.defaultSession.setProxy({ mode: "pac_script", pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pacSource).toString("base64")}` });
  await session.defaultSession.closeAllConnections();
  const beforePac = httpHits;
  await download("artifact.invalid"); assert.ok(httpHits > beforePac);
  const lastDirect = applyNetworkProxy({ mode: "direct" });
  await lastDirect;
  await assert.rejects(download("artifact.invalid"));
  console.log("PASS: HTTP, authenticated HTTP, SOCKS5, authenticated SOCKS5, Direct, System/PAC and settings barrier");
} finally {
  await applyNetworkProxy({ mode: "direct" }).catch(() => {});
  for (const socket of sockets) socket.destroy();
  for (const server of [origin, ...proxies, pac]) server.close();
}
app.exit(0);
}
void main().catch(error => { console.error(error); app.exit(1); });
