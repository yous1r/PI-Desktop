import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspacePluginOwner } from "@pi-desktop/shared";
import { decodePluginChunk, pluginFailure } from "./plugin-wire.js";

const MAX_FILES = 2000;
const MAX_CONTENT = 50 * 1024 * 1024;
export const MAX_PLUGIN_PACKAGE_BYTES = 72 * 1024 * 1024;
const OMIT_DIRS = new Set([".git", ".pi", ".agents", ".memories", "node_modules"]);
export function safePluginPackagePath(path: string): boolean {
  return path.length > 0 && path.length <= 1024 && !/[\\:\u0000-\u001f]/.test(path)
    && path.split("/").every(part => Boolean(part) && part !== "." && part !== ".."
      && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
      && !OMIT_DIRS.has(part.toLowerCase()) && !/^\.env(?:\.|$)|^\.ssh$|\.(?:pem|key|p12|pfx|node)$/i.test(part));
}
export type PluginPackageManifest = { id: string; version: string; main: string; execution: { main: "workspace" | "desktop"; workspaceMain?: string }; [key: string]: unknown };
export type PluginPackageFile = { path: string; data: string };
function parsePackage(bytes: Buffer): { files: PluginPackageFile[]; manifest: PluginPackageManifest } {
  if (bytes.length > MAX_PLUGIN_PACKAGE_BYTES) throw pluginFailure("LIMIT_EXCEEDED", "Plugin package is too large");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw pluginFailure("PLUGIN_INVALID", "Invalid plugin package"); }
  if (!value || typeof value !== "object" || !Array.isArray((value as {files?:unknown}).files)) throw pluginFailure("PLUGIN_INVALID", "Invalid plugin file table");
  const files = (value as { files: PluginPackageFile[] }).files;
  if (!files.length || files.length > MAX_FILES) throw pluginFailure("LIMIT_EXCEEDED", "Invalid plugin file count");
  const names = new Set<string>(); let size = 0;
  for (const file of files) {
    if (!file || typeof file.path !== "string" || !safePluginPackagePath(file.path) || typeof file.data !== "string") throw pluginFailure("PLUGIN_INVALID", "Unsafe plugin package path");
    const key = file.path.toLowerCase();
    if (names.has(key)) throw pluginFailure("PLUGIN_INVALID", "Duplicate plugin package path");
    names.add(key);
    const content = Buffer.from(file.data, "base64");
    size += content.length;
    if (size > MAX_CONTENT || content.toString("base64") !== file.data) throw pluginFailure("PLUGIN_INVALID", "Invalid plugin file content");
  }
  const source = files.find(file => file.path === "manifest.json");
  let manifest: PluginPackageManifest;
  try { manifest = JSON.parse(Buffer.from(source?.data ?? "", "base64").toString("utf8")); }
  catch { throw pluginFailure("PLUGIN_INVALID", "Plugin manifest is missing or invalid"); }
  if (!manifest || typeof manifest.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.id)
    || typeof manifest.version !== "string" || !manifest.version || typeof manifest.main !== "string"
    || !manifest.execution || !["desktop", "workspace"].includes(manifest.execution.main)) throw pluginFailure("PLUGIN_INVALID", "Workspace execution declaration is required");
  const entry = manifest.execution.main === "workspace" ? manifest.main : manifest.execution.workspaceMain;
  if (!entry || !safePluginPackagePath(entry) || !files.some(file => file.path === entry) || !/\.(?:js|cjs|mjs)$/.test(entry)) throw pluginFailure("PLUGIN_INVALID", "Workspace entry is missing");
  return { files, manifest };
}

/** Build only regular package files. Native dependencies must be bundled for the target separately. */
export async function collectPluginPackage(root: string): Promise<{ bytes: Buffer; digest: string; manifest: PluginPackageManifest }> {
  const files: PluginPackageFile[] = []; let size = 0;
  async function walk(directory: string, prefix: string) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, "en"))) {
      if (OMIT_DIRS.has(entry.name.toLowerCase())) continue;
      const path = prefix + entry.name;
      if (!safePluginPackagePath(path)) throw pluginFailure("PLUGIN_INVALID", "Package contains a credential, native dependency, or unsafe filename");
      const full = join(directory, entry.name); const info = await lstat(full);
      if (info.isSymbolicLink()) throw pluginFailure("PLUGIN_INVALID", "Plugin package cannot contain symlinks");
      if (info.isDirectory()) { await walk(full, path + "/"); continue; }
      if (!info.isFile()) throw pluginFailure("PLUGIN_INVALID", "Plugin package must contain regular files");
      size += info.size;
      if (size > MAX_CONTENT || files.length >= MAX_FILES) throw pluginFailure("LIMIT_EXCEEDED", "Plugin package exceeds its limits");
      const data = await readFile(full);
      if (data.length !== info.size || (await lstat(full)).isSymbolicLink()) throw pluginFailure("PLUGIN_CHANGED", "Plugin package changed during collection");
      files.push({ path, data: data.toString("base64") });
    }
  }
  await walk(root, "");
  const bytes = Buffer.from(JSON.stringify({ files })); const { manifest } = parsePackage(bytes);
  return { bytes, digest: createHash("sha256").update(bytes).digest("hex"), manifest };
}

type Upload = { digest: string; size: number; owner: WorkspacePluginOwner; chunks: Buffer[]; received: number; expires: number };
export class WorkspacePluginPackages {
  private readonly uploads = new Map<string, Upload>();
  private readonly admitted = new Map<string, { path: string; manifest: PluginPackageManifest; bytes: number }>();
  private readonly root: string;
  private readonly ready: Promise<void>;
  private sealed = false;
  constructor(root: string) {
    const runRoot = join(root, `run-${process.pid}-${randomUUID()}`);
    this.root = runRoot;
    this.ready = (async () => {
      await mkdir(root, {recursive:true,mode:0o700});
      for (const entry of await readdir(root,{withFileTypes:true})) {
        const match = /^run-([0-9]+)-[a-f0-9-]{36}$/.exec(entry.name);
        if (!match || !entry.isDirectory()) continue;
        let alive = true;
        try { process.kill(Number(match[1]),0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (!alive) await rm(join(root,entry.name),{recursive:true,force:true});
      }
      await mkdir(runRoot,{mode:0o700});
    })();
    // Admission reports initialization failure; do not produce an unhandled rejection at startup.
    void this.ready.catch(() => undefined);
  }
  async begin(digest: string, size: number, owner: WorkspacePluginOwner) {
    if (this.sealed) throw pluginFailure("HOST_UNAVAILABLE", "Plugin package service is closed");
    if (!/^[a-f0-9]{64}$/.test(digest) || !Number.isInteger(size) || size < 1 || size > MAX_PLUGIN_PACKAGE_BYTES) throw pluginFailure("INVALID_ARGUMENT", "Invalid plugin package descriptor");
    for (const [id, upload] of this.uploads) if (upload.expires < Date.now()) this.uploads.delete(id);
    if (this.admitted.has(digest)) return { present: true };
    const retained = [...this.admitted.values()].reduce((sum,entry) => sum + entry.bytes,0);
    const reserved = [...this.uploads.values()].reduce((sum,entry) => sum + entry.size,0);
    if (this.admitted.size + this.uploads.size >= 64 || retained + reserved + size > 512 * 1024 * 1024) {
      throw pluginFailure("LIMIT_EXCEEDED", "Plugin package cache is full; restart the Host to release inactive artifacts");
    }
    if (this.uploads.size >= 4 || [...this.uploads.values()].some(upload => upload.owner.connectionId === owner.connectionId)) throw pluginFailure("LIMIT_EXCEEDED", "Plugin upload already in progress");
    const uploadId = randomUUID();
    this.uploads.set(uploadId, { digest, size, owner, chunks: [], received: 0, expires: Date.now() + 120_000 });
    try { await this.ready; this.owned(uploadId,owner); }
    catch (error) { this.uploads.delete(uploadId); throw error; }
    return { present: false, uploadId };
  }
  private owned(id: string, owner: WorkspacePluginOwner): Upload {
    const upload = this.uploads.get(id);
    if (!upload || upload.owner.deviceId !== owner.deviceId || upload.owner.connectionId !== owner.connectionId || upload.expires < Date.now()) throw pluginFailure("FORBIDDEN", "Plugin upload is unavailable");
    return upload;
  }
  chunk(id: string, offset: number, data: string, owner: WorkspacePluginOwner) {
    const upload = this.owned(id, owner); const bytes = decodePluginChunk(data);
    if (offset !== upload.received || !bytes.length || offset + bytes.length > upload.size) throw pluginFailure("INVALID_ARGUMENT", "Invalid plugin upload offset");
    upload.chunks.push(bytes); upload.received += bytes.length;
    return { received: upload.received };
  }
  async commit(id: string, owner: WorkspacePluginOwner) {
    const upload = this.owned(id, owner);
    if (upload.received !== upload.size) throw pluginFailure("INVALID_ARGUMENT", "Plugin upload is incomplete");
    const bytes = Buffer.concat(upload.chunks, upload.received);
    if (createHash("sha256").update(bytes).digest("hex") !== upload.digest) { this.uploads.delete(id); throw pluginFailure("PLUGIN_INVALID", "Plugin package digest differs"); }
    const { files, manifest } = parsePackage(bytes);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // The digest stays in the admitted index; duplicating it in the path breaks Windows child cwd limits.
    const staging = join(this.root, `.upload-${id}`); const target = join(this.root, id);
    await mkdir(staging, { mode: 0o700 });
    try {
      for (const file of files) {
        const path = join(staging, ...file.path.split("/"));
        await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
        await writeFile(path, Buffer.from(file.data, "base64"), { flag: "wx", mode: 0o600 });
      }
      this.owned(id, owner); // A disconnect during extraction cannot activate the package.
      await rename(staging, target);
      try { this.owned(id,owner); } catch (error) { await rm(target,{recursive:true,force:true}); throw error; }
      if (this.admitted.has(upload.digest)) await rm(target,{recursive:true,force:true});
      else this.admitted.set(upload.digest, { path: target, manifest, bytes: upload.size });
      return { digest: upload.digest };
    } finally { this.uploads.delete(id); await rm(staging, { recursive: true, force: true }); }
  }
  get(digest: string) {
    const entry = this.admitted.get(digest);
    if (!entry) throw pluginFailure("NOT_FOUND", "Plugin package must be uploaded before execution");
    return entry;
  }
  disconnect(connectionId: string): void {
    for (const [id, upload] of this.uploads) if (upload.owner.connectionId === connectionId) this.uploads.delete(id);
  }
  revoke(deviceId: string): void {
    for (const [id, upload] of this.uploads) if (upload.owner.deviceId === deviceId) this.uploads.delete(id);
  }
  dispose(): void {
    this.sealed = true; this.uploads.clear(); this.admitted.clear();
    void this.ready.then(() => rm(this.root,{recursive:true,force:true,maxRetries:3})).catch(() => undefined);
  }
}
