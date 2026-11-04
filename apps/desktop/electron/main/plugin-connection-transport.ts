import { once } from "node:events";
import { Agent, request as httpsRequest } from "node:https";
import { connect as tcpConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, getCACertificates } from "node:tls";
import { createBrotliDecompress, createUnzip } from "node:zlib";
import { CONNECTION_MAX_BYTES, connectionError } from "./plugin-connection-policy";

export type ConnectionTransport = (url: string, init: RequestInit, caPem?: string) => Promise<Response>;
export type ConnectionTunnel = (host: string, port: number, signal: AbortSignal) => Promise<Socket>;
const direct: ConnectionTunnel = async (host, port, signal) => {
  const socket = tcpConnect({ host, port, signal });
  await once(socket, "connect", { signal });
  return socket;
};
async function admittedTunnel(connect: ConnectionTunnel, host: string, port: number, signal: AbortSignal): Promise<Socket> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    connect(host, port, signal).then((socket) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) { socket.destroy(); reject(signal.reason); } else resolve(socket);
    }, (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** Private trust is additive and scoped to one HTTPS request. Never follows redirects. */
export function createConnectionTransport(connect: ConnectionTunnel): ConnectionTransport {
  return async (url, init, caPem) => {
    if (!caPem) return fetch(url, { ...init, credentials: "omit" });
    const target = new URL(url);
    if (target.protocol !== "https:") throw connectionError("INVALID_ARGUMENT", "A CA requires HTTPS");
    const signal = init.signal ?? AbortSignal.timeout(15000);
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const raw = await admittedTunnel(connect, host, Number(target.port) || 443, signal);
    let socket;
    try {
      socket = tlsConnect({ socket: raw, host, ...(isIP(host) ? {} : { servername: host }),
        ca: [...new Set([...getCACertificates("default"), ...getCACertificates("system"), caPem])],
        rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
    } catch (error) { raw.destroy(); throw error; }
    const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
    agent.createConnection = () => socket;
    const abort = () => socket.destroy(new DOMException("Connection aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      await once(socket, "secureConnect", { signal });
      signal.throwIfAborted();
      return await new Promise<Response>((resolve, reject) => {
        const req = httpsRequest(target, { agent, method: init.method, signal,
          headers: { ...Object.fromEntries(new Headers(init.headers)), "accept-encoding": "identity" },
        }, (response) => {
          const encoding = response.headers["content-encoding"];
          const decoder = encoding === "br" ? createBrotliDecompress() :
            encoding === "gzip" || encoding === "deflate" ? createUnzip() : undefined;
          if (decoder) response.on("error", (error) => decoder.destroy(error));
          void (async () => {
            try {
              const chunks: Buffer[] = [];
              let size = 0;
              for await (const value of decoder ? response.pipe(decoder) : response) {
                const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
                size += chunk.byteLength;
                if (size > CONNECTION_MAX_BYTES) throw connectionError("LIMIT_EXCEEDED", "Connection response is too large");
                chunks.push(chunk);
              }
              const status = response.statusCode ?? 502;
              const headers = new Headers();
              for (const [key, value] of Object.entries(response.headers)) {
                if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
              }
              resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
            } finally { decoder?.destroy(); response.destroy(); }
          })().catch(reject);
        });
        req.once("error", reject);
        req.end(typeof init.body === "string" ? init.body : undefined);
      });
    } catch (error) { signal.throwIfAborted(); throw error; }
    finally { signal.removeEventListener("abort", abort); socket.destroy(); agent.destroy(); }
  };
}
export const connectionTransport = createConnectionTransport(direct);

export async function readConnectionBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > CONNECTION_MAX_BYTES) throw connectionError("LIMIT_EXCEEDED", "Connection response is too large");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
