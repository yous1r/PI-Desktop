import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { extname, type posix } from "node:path";

const CHUNK = 1024 * 1024;
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
const TYPES: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".xhtml": "application/xhtml+xml",
  ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".pdf": "application/pdf",
};

type ResourceSource = {
  path: string;
  paths: typeof posix;
  info(file: string): Promise<{ size: number; mtimeMs: number }>;
  bytes(file: string, offset: number, length: number, size: number): Promise<Buffer>;
  track(operation: () => Promise<void>): Promise<void>;
  assertCurrent(): void;
};

/** Bounded loopback delivery; callers retain the workspace authorization and lease. */
export async function openWorkspaceResourceServer(source: ResourceSource): Promise<{ server: Server; url: string }> {
  const prefix = `/${randomBytes(24).toString("hex")}/`;
  const directory = source.paths.dirname(source.path);
  let active = 0;
  let host = "";
  const server = createServer((req, res) => {
    void source.track(async () => {
      const completed = new Promise<void>(resolve => {
        const done = () => { res.off("finish", done); res.off("close", done); resolve(); };
        res.once("finish", done); res.once("close", done);
      });
      try {
      if (req.headers.host !== host || !["GET", "HEAD"].includes(req.method ?? "") || req.headers["sec-fetch-site"] === "cross-site") throw failure("PERMISSION_DENIED", "Resource request is unavailable");
      if (active >= 4) throw failure("LIMIT_EXCEEDED", "Too many resource reads");
      const rawUrl = (req.url ?? "").split("?")[0]!;
      if (!rawUrl.startsWith(prefix)) throw failure("NOT_FOUND", "Resource is unavailable");
      const rel = decodeURIComponent(rawUrl.slice(prefix.length));
      if (!rel || rel.split(/[\\/]/).some(part => part === ".." || part === ".") || /[\u0000-\u001f\\:]/.test(rel) || rel.startsWith("/")) throw failure("PERMISSION_DENIED", "Invalid resource path");
      active++;
      try {
        const resource = source.paths.join(directory, rel);
        const current = await source.info(resource);
        source.assertCurrent();
        res.setHeader("Content-Type", TYPES[extname(rel).toLowerCase()] ?? "application/octet-stream");
        res.setHeader("Content-Length", current.size);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; sandbox allow-scripts allow-same-origin");
        if (req.method === "HEAD") { res.end(); return; }
        for (let offset = 0; offset < current.size; offset += CHUNK) {
          if (res.destroyed) return;
          const chunk = await source.bytes(resource, offset, Math.min(CHUNK, current.size - offset), current.size);
          source.assertCurrent();
          if (!res.write(chunk)) await new Promise<void>(resolve => {
            const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
            res.once("drain", done); res.once("close", done);
          });
        }
        source.assertCurrent(); res.end();
      } finally { active--; }
      } catch {
        if (res.headersSent) res.destroy();
        else if (!res.destroyed) { res.writeHead(404, { "Cache-Control": "no-store" }); res.end("Workspace resource unavailable"); }
      } finally { await completed; }
    }).catch(() => { res.destroy(); console.warn("Workspace resource response failed; idle handoff remains unavailable"); });
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.timeout = 30_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw failure("UNAVAILABLE", "Resource server unavailable"); }
  host = `127.0.0.1:${address.port}`;
  return { server, url: `http://${host}${prefix}${encodeURIComponent(source.paths.basename(source.path))}` };
}
