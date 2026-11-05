import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { open, rm } from "node:fs/promises";
import { extname, posix, win32 } from "node:path";
import type { WorkspaceExecutionContext } from "@pi-desktop/shared";

const MAX_FILE = 64 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const LIFETIME = 30 * 60_000;
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
type FileInfo = { size: number; mtimeMs: number };
export type WorkspaceResourceRequest = {
  ownerId: string;
  pluginName: string;
  context: WorkspaceExecutionContext;
  sessionId?: string;
  path: string;
  api: "fs.openDefault" | "fs.openInBrowser" | "fs.reveal";
  validate(): Promise<void>;
  read<T>(api: string, args: unknown[]): Promise<T>;
};
type Lease = { ownerId: string; server: Server; timer: NodeJS.Timeout };
const TYPES: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html", ".xhtml": "application/xhtml+xml",
  ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".pdf": "application/pdf",
};

/** Desktop resource ownership; all remote bytes still pass through the admitted file API. */
export class WorkspaceResources {
  private readonly leases = new Set<Lease>();
  private readonly owners = new Map<string, { active: boolean }>();
  private opening = 0;
  private disposed = false;
  private readonly options: {
    chooseCopy(input: { name: string; pluginName: string; hostKey: string }): Promise<string | null>;
    openCopy(path: string): Promise<void>;
    openBrowser(url: string, sessionId: string): Promise<void>;
    reveal(path: string, sessionId: string): Promise<void>;
  };
  constructor(options: WorkspaceResources["options"]) { this.options = options; }
  async open(input: WorkspaceResourceRequest): Promise<void> {
    if (this.disposed || this.opening + this.leases.size >= 8) throw failure("LIMIT_EXCEEDED", "Workspace resource limit reached");
    if (input.context.authority.kind !== "remote") throw failure("INVALID_ARGUMENT", "A remote workspace is required");
    const owner = this.owners.get(input.ownerId) ?? { active: true };
    this.owners.set(input.ownerId, owner);
    const check = async () => {
      if (this.disposed || !owner.active) throw failure("PLUGIN_GONE", "Resource owner was closed");
      await input.validate();
      if (this.disposed || !owner.active) throw failure("PLUGIN_GONE", "Resource owner was closed");
    };
    const paths = input.context.platform === "win32" ? win32 : posix;
    const root = input.context.roots.find(item => item.primary)!.path;
    const raw = input.path;
    if (!raw || raw.length > 4096 || /[\u0000-\u001f]/.test(raw) || raw.startsWith("remote-project:")) throw failure("INVALID_ARGUMENT", "Invalid resource path");
    const path = paths.isAbsolute(raw) ? paths.relative(root, raw) : raw;
    if (path.split(/[\\/]/).includes("..") || paths.isAbsolute(path) || /^[a-z]:/i.test(path)) throw failure("PERMISSION_DENIED", "Resource must remain inside its workspace");
    const info = async (file: string) => {
      await check();
      const result = await input.read<FileInfo>("fs.stat", [file]);
      if (!Number.isSafeInteger(result.size) || result.size < 0 || result.size > MAX_FILE || !Number.isFinite(result.mtimeMs)) throw failure("LIMIT_EXCEEDED", "Workspace resources are limited to 64 MiB");
      await check(); return result;
    };
    const bytes = async (file: string, offset: number, length: number, size: number) => {
      await check();
      const value = await input.read<{ bytes: number[]; totalSize: number }>("fs.readRange", [file, offset, length]);
      if (value.totalSize !== size || !Array.isArray(value.bytes) || value.bytes.length !== length || value.bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw failure("FILE_CHANGED", "Workspace file changed during transfer");
      await check(); return Buffer.from(value.bytes);
    };
    this.opening++;
    try {
      const initial = await info(path);
      if (input.api === "fs.reveal") {
        if (!input.sessionId) throw failure("WORKSPACE_REQUIRED", "File reveal requires an originating session");
        await check(); await this.options.reveal(paths.resolve(root, path), input.sessionId); return;
      }
      if (input.api === "fs.openDefault") {
        const target = await this.options.chooseCopy({ name: paths.basename(path), pluginName: input.pluginName, hostKey: input.context.authority.hostKey });
        if (!target) throw failure("CANCELLED", "Download cancelled");
        await check();
        // Never replace an existing Desktop file, including a race after the picker.
        const file = await open(target, "wx", 0o600);
        let complete = false;
        try {
          for (let offset = 0; offset < initial.size; offset += CHUNK) await file.writeFile(await bytes(path, offset, Math.min(CHUNK, initial.size - offset), initial.size));
          const latest = await info(path);
          if (latest.size !== initial.size || latest.mtimeMs !== initial.mtimeMs) throw failure("FILE_CHANGED", "Workspace file changed during transfer");
          await file.sync(); await check(); complete = true;
        } finally { await file.close(); if (!complete) await rm(target, { force: true }); }
        await check(); await this.options.openCopy(target); return;
      }
      if (!input.sessionId) throw failure("WORKSPACE_REQUIRED", "Browser preview requires an originating session");
      if (![".html", ".htm", ".xhtml"].includes(extname(path).toLowerCase())) throw failure("INVALID_ARGUMENT", "Browser preview requires an HTML file");
      const token = randomBytes(24).toString("hex");
      const prefix = `/${token}/`;
      const directory = paths.dirname(path);
      let active = 0;
      let host = "";
      const server = createServer((req, res) => {
        void (async () => {
          if (req.headers.host !== host || !["GET", "HEAD"].includes(req.method ?? "") || req.headers["sec-fetch-site"] === "cross-site") throw failure("PERMISSION_DENIED", "Resource request is unavailable");
          if (active >= 4) throw failure("LIMIT_EXCEEDED", "Too many resource reads");
          const rawUrl = (req.url ?? "").split("?")[0]!;
          if (!rawUrl.startsWith(prefix)) throw failure("NOT_FOUND", "Resource is unavailable");
          const rel = decodeURIComponent(rawUrl.slice(prefix.length));
          if (!rel || rel.split(/[\\/]/).some(part => part === ".." || part === ".") || /[\u0000-\u001f\\:]/.test(rel) || rel.startsWith("/")) throw failure("PERMISSION_DENIED", "Invalid resource path");
          active++;
          try {
            const resource = paths.join(directory, rel);
            const current = await info(resource);
            res.setHeader("Content-Type", TYPES[extname(rel).toLowerCase()] ?? "application/octet-stream");
            res.setHeader("Content-Length", current.size);
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("Referrer-Policy", "no-referrer");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Content-Security-Policy", "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; sandbox allow-scripts allow-same-origin");
            if (req.method === "HEAD") { res.end(); return; }
            for (let offset = 0; offset < current.size; offset += CHUNK) {
              if (res.destroyed) return;
              const chunk = await bytes(resource, offset, Math.min(CHUNK, current.size - offset), current.size);
              if (!res.write(chunk)) await new Promise<void>(resolve => {
                const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
                res.once("drain", done); res.once("close", done);
              });
            }
            res.end();
          } finally { active--; }
        })().catch(() => { if (res.headersSent) res.destroy(); else { res.writeHead(404, { "Cache-Control": "no-store" }); res.end("Workspace resource unavailable"); } });
      });
      server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.timeout = 30_000;
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); throw failure("UNAVAILABLE", "Resource server unavailable"); }
      host = `127.0.0.1:${address.port}`;
      const lease: Lease = { ownerId: input.ownerId, server, timer: setTimeout(() => this.close(lease), LIFETIME) };
      lease.timer.unref(); server.unref(); this.leases.add(lease);
      try { await check(); await this.options.openBrowser(`http://${host}${prefix}${encodeURIComponent(paths.basename(path))}`, input.sessionId); }
      catch (error) { this.close(lease); throw error; }
    } finally { this.opening--; }
  }
  private close(lease: Lease): void { this.leases.delete(lease); clearTimeout(lease.timer); lease.server.closeAllConnections(); lease.server.close(); }
  closeOwner(ownerId: string): void {
    const owner = this.owners.get(ownerId); if (owner) owner.active = false;
    this.owners.delete(ownerId);
    for (const lease of this.leases) if (lease.ownerId === ownerId) this.close(lease);
  }
  dispose(): void { this.disposed = true; for (const lease of this.leases) this.close(lease); this.owners.clear(); }
}
