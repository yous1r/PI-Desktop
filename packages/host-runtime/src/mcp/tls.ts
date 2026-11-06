import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { Agent, request } from "node:https";
import { connect, isIP, type Socket } from "node:net";
import { Readable } from "node:stream";
import { connect as tlsConnect, getCACertificates } from "node:tls";
import { createBrotliDecompress, createUnzip } from "node:zlib";
import { mcpError } from "./transport.js";

export type McpTlsTunnel = (host: string, port: number, signal: AbortSignal) => Promise<Socket>;
const direct: McpTlsTunnel = async (host, port, signal) => {
  const socket = connect({ host, port, signal });
  await once(socket, "connect", { signal });
  return socket;
};

export function validateMcpCertificate(pem: string): string[] {
  if (typeof pem !== "string" || Buffer.byteLength(pem) > 64 * 1024) {
    throw mcpError("MCP_CA_INVALID", "MCP CA must be a public PEM bundle of at most 64 KiB");
  }
  const pattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  const blocks = pem.match(pattern);
  try {
    if (!blocks?.length || blocks.length > 16 || pem.replace(pattern, "").trim()) throw new Error();
    for (const block of blocks) if (!new X509Certificate(block).ca) throw new Error();
  } catch {
    throw mcpError("MCP_CA_INVALID", "MCP CA must contain public CA certificates only");
  }
  return blocks;
}

async function openTunnel(tunnel: McpTlsTunnel, host: string, port: number, signal: AbortSignal): Promise<Socket> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    void tunnel(host, port, signal).then(socket => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) { socket.destroy(); reject(signal.reason); } else resolve(socket);
    }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** Scoped trust with streaming bodies; the caller still owns redirects and cancellation. */
export function createMcpTlsFetch(pem: string, endpoint: string, tunnel: McpTlsTunnel = direct): typeof fetch {
  const origin = new URL(endpoint).origin;
  const ca = [...new Set([...getCACertificates("default"), ...getCACertificates("system"), ...validateMcpCertificate(pem)])];
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (url.protocol !== "https:" || url.origin !== origin) {
      throw mcpError("MCP_CA_ORIGIN", "Custom MCP CA trust is restricted to the configured HTTPS origin");
    }
    if (init.body != null && typeof init.body !== "string") throw mcpError("INVALID_ARGUMENT", "Unsupported MCP request body");
    const signal = init.signal ?? AbortSignal.timeout(100_000);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const raw = await openTunnel(tunnel, host, Number(url.port) || 443, signal);
    let socket;
    try {
      socket = tlsConnect({ socket: raw, host, ...(isIP(host) ? {} : { servername: host }), ca,
        rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
    } catch (error) { raw.destroy(); throw error; }
    const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
    agent.createConnection = () => socket;
    const abort = () => socket.destroy(new DOMException("MCP request aborted", "AbortError"));
    const cleanup = () => { signal.removeEventListener("abort", abort); socket.destroy(); agent.destroy(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await once(socket, "secureConnect", { signal });
      signal.throwIfAborted();
      return await new Promise<Response>((resolve, reject) => {
        const outgoing = request(url, { agent, method: init.method ?? "GET", signal,
          headers: { ...Object.fromEntries(new Headers(init.headers)), "accept-encoding": "identity" },
        }, incoming => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) for (const item of value) headers.append(name, item);
            else if (value !== undefined) headers.set(name, value);
          }
          const encoding = incoming.headers["content-encoding"];
          const decoder = encoding === "br" ? createBrotliDecompress()
            : encoding === "gzip" || encoding === "deflate" ? createUnzip() : undefined;
          if (decoder) {
            incoming.on("error", error => decoder.destroy(error));
            decoder.once("close", () => { incoming.destroy(); cleanup(); });
            headers.delete("content-encoding");
            headers.delete("content-length");
          } else incoming.once("close", cleanup);
          const status = incoming.statusCode ?? 502;
          const body = [204, 205, 304].includes(status) ? null
            : Readable.toWeb(decoder ? incoming.pipe(decoder) : incoming) as ReadableStream<Uint8Array>;
          if (!body) { decoder?.destroy(); incoming.resume(); }
          resolve(new Response(body, { status, headers }));
        });
        outgoing.once("error", error => { cleanup(); reject(error); });
        outgoing.end(init.body ?? undefined);
      });
    } catch (error) { cleanup(); throw error; }
  };
}
