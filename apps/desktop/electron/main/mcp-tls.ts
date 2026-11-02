import { X509Certificate } from "node:crypto";
import { request } from "node:https";
import { Readable } from "node:stream";
import { getCACertificates, rootCertificates } from "node:tls";

export const MCP_CA_MAX_BYTES = 64 * 1024;

function caError(): Error {
  return Object.assign(new Error("MCP CA must be a public PEM certificate bundle of at most 64 KiB."), {
    errorCode: "MCP_CA_INVALID",
  });
}

/** A selected public certificate, never a key or an arbitrary filesystem path. */
export function validateMcpCertificate(pem: string): string[] {
  if (typeof pem !== "string" || !pem.trim() || Buffer.byteLength(pem) > MCP_CA_MAX_BYTES) throw caError();
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (!blocks.length || blocks.length > 16 || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()) throw caError();
  try {
    for (const block of blocks) new X509Certificate(block);
  } catch {
    throw caError();
  }
  return blocks;
}

/** Per-client HTTPS trust; never mutates Node's process-wide CA store. */
export function createMcpTlsFetch(pem: string): typeof fetch {
  const selected = validateMcpCertificate(pem);
  const defaults = typeof getCACertificates === "function" ? getCACertificates("default") : rootCertificates;
  const ca = [...new Set([...defaults, ...selected])];
  const fetchWithCa: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (url.protocol !== "https:") {
      throw Object.assign(new Error("A custom MCP CA can only be used with HTTPS."), { errorCode: "MCP_CA_INVALID" });
    }
    // This adapter belongs to the MCP JSON transport, which sends only strings.
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
      throw Object.assign(new Error("Unsupported MCP request body."), { errorCode: "INVALID_ARGUMENT" });
    }
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    return new Promise<Response>((resolve, reject) => {
      const outgoing = request(url, {
        method: init.method ?? "GET", headers, ca, rejectUnauthorized: true,
        signal: init.signal ?? undefined,
      }, (incoming) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(name, item);
          else if (value !== undefined) responseHeaders.set(name, value);
        }
        const status = incoming.statusCode ?? 502;
        const body = status === 204 || status === 205 || status === 304
          ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        if (body === null) incoming.resume();
        resolve(new Response(body, { status, statusText: incoming.statusMessage, headers: responseHeaders }));
      });
      outgoing.once("error", (error: Error & { code?: string }) => {
        if (init.signal?.aborted) { reject(new DOMException("MCP request was aborted", "AbortError")); return; }
        const tlsFailure = /CERT|TLS|SSL|UNABLE_TO|SELF_SIGNED/.test(error.code ?? "");
        reject(Object.assign(new Error(tlsFailure
          ? "MCP TLS verification failed; check the selected CA, certificate expiry and hostname."
          : "MCP HTTPS connection failed; check the service and network."), {
          errorCode: tlsFailure ? "MCP_TLS_FAILED" : "MCP_CONNECTION_FAILED",
        }));
      });
      outgoing.end(init.body ?? undefined);
    });
  };
  return fetchWithCa;
}
