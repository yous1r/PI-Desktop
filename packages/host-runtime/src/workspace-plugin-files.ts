import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isDeniedFsPath, isFsPathInScope, matchFsGlob, resolveFsAccess, type PluginFsMode, type PluginFsPolicy, type PluginFsPreview } from "@pi-desktop/plugin-sdk";
import { previewFile, resolveRealPathForCreateWithinRoot, resolveRealPathWithinRoot } from "./workspace-files.js";
import { pluginFailure } from "./plugin-wire.js";

const MAX_TEXT = 8 * 1024 * 1024;
const MAX_RANGE = 8 * 1024 * 1024;
const SKIP = new Set(["node_modules", "target", "dist", ".git"]);
const within = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)); };

/** Execution-host SDK filesystem. Native plugin code retains its separate OS privileges. */
export class WorkspacePluginFiles {
  private readonly permissions: Set<string>;
  private readonly policy: PluginFsPolicy;
  private readonly root: string;
  private readonly protectedRoot: string;
  private readonly active: () => boolean;
  private readonly written = new Map<string, string>();
  private deletes: number[] = [];
  constructor(input: { root: string; protectedRoot: string; permissions: string[]; manifest: { permissions?: string[]; fs?: unknown }; active(): boolean }) {
    const declared = resolveFsAccess(input.manifest);
    this.permissions = new Set(input.permissions.filter(permission => declared.permissions.includes(permission)));
    this.policy = declared.policy; this.root = input.root;
    this.protectedRoot = input.protectedRoot; this.active = input.active;
  }
  private check(): void {
    if (!this.active()) throw pluginFailure("PLUGIN_GONE", "Workspace plugin is no longer active");
  }
  private async resolve(path: unknown, mode: PluginFsMode, consent: boolean, create = false, directory = false) {
    this.check();
    if (!this.permissions.has(`fs.${mode}`)) throw pluginFailure("PERMISSION_DENIED", `Permission is required: fs.${mode}`);
    if (typeof path !== "string" || path.length > 4096 || /[\u0000-\u001f]/.test(path) || path.startsWith("remote-project:")) throw pluginFailure("INVALID_ARGUMENT", "Invalid workspace file path");
    const rule = this.policy[mode] ?? { root: "workspace", scope: [] };
    if (rule.root !== "workspace") throw pluginFailure("UNSUPPORTED", "Remote user-selected directories require an explicit remote picker");
    const rel = (isAbsolute(path) ? relative(this.root, path) : path).split(sep).join("/");
    if (rel.split("/").includes("..") || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw pluginFailure("PERMISSION_DENIED", "File must remain inside its workspace root");
    if (isDeniedFsPath(rel)) throw pluginFailure("PERMISSION_DENIED", "Credential paths and repository internals are protected");
    const full = !rel || rel === "." ? this.root : await (create ? resolveRealPathForCreateWithinRoot : resolveRealPathWithinRoot)(this.root, rel);
    if (!full) throw pluginFailure("NOT_FOUND", "Workspace file is unavailable or outside the root");
    const resolvedRel = relative(this.root, full).split(sep).join("/");
    if (!within(this.root, full) || within(this.protectedRoot, full) || isDeniedFsPath(resolvedRel)) throw pluginFailure("PERMISSION_DENIED", "Resolved file path is protected");
    let owned = false;
    if (mode === "delete" && rule.own) {
      try { owned = this.written.get(full) === await this.fingerprint(full); } catch { /* Missing files cannot be owned. */ }
    }
    if (!directory && !consent && !owned && !isFsPathInScope(rel, rule.scope)) throw pluginFailure("FS_CONSENT_REQUIRED", `Confirm ${mode} for this workspace file`);
    this.check(); return { full, rel };
  }
  private async fingerprint(path: string): Promise<string> {
    const info = await stat(path);
    return JSON.stringify([info.dev, info.ino, info.size, info.mtimeMs]);
  }
  async call(api: string, args: unknown[], consent = false): Promise<unknown> {
    this.check();
    if (api === "fs.requestDirectory") throw pluginFailure("UNSUPPORTED", "Remote directory selection is unavailable");
    if (["fs.openDefault", "fs.openInBrowser", "fs.reveal"].includes(api)) throw pluginFailure("UNSUPPORTED", "Open remote files in the application file view; local applications require an explicit downloaded copy");
    const supported = new Set(["fs.readText", "fs.stat", "fs.readRange", "fs.readPreview", "fs.list", "fs.glob", "fs.writeText", "fs.remove"]);
    if (!supported.has(api)) throw pluginFailure("UNSUPPORTED", "Unknown workspace file operation");
    if ((api === "fs.stat" && args[1] != null) || (api === "fs.readRange" && args[3] != null)) throw pluginFailure("PERMISSION_DENIED", "Desktop dropped-file grants cannot address remote files");
    if (api === "fs.readPreview" || api === "fs.list") {
      const options = args[1] as {workspacePath?:unknown} | undefined;
      if (options?.workspacePath !== undefined && options.workspacePath !== this.root) throw pluginFailure("WORKSPACE_CHANGED", "The requested file belongs to another workspace");
    }
    const mode: PluginFsMode = api === "fs.writeText" ? "write" : api === "fs.remove" ? "delete" : "read";
    const hit = await this.resolve(api === "fs.glob" ? "" : args[0], mode, consent, api === "fs.writeText", api === "fs.list" || api === "fs.glob");
    if (api === "fs.list" || api === "fs.glob") return this.list(hit.full, hit.rel, api === "fs.glob" ? String(args[0] ?? "*") : undefined);
    if (api === "fs.writeText") {
      if (typeof args[1] !== "string" || Buffer.byteLength(args[1]) > MAX_TEXT) throw pluginFailure("LIMIT_EXCEEDED", "Text writes are limited to 8 MiB");
      await mkdir(dirname(hit.full), {recursive:true});
      const checked = await this.resolve(args[0], mode, consent, true);
      if (checked.full !== hit.full) throw pluginFailure("WORKSPACE_CHANGED", "File path changed during write admission");
      const temporary = join(dirname(hit.full), `.pi-write-${randomUUID()}`);
      try {
        let mode = 0o600;
        try { mode = (await stat(hit.full)).mode & 0o777; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await writeFile(temporary, args[1], {flag:"wx",mode});
        this.check(); await rename(temporary, hit.full);
        this.written.set(hit.full, await this.fingerprint(hit.full));
      } finally { await rm(temporary, {force:true}); }
      return null;
    }
    const info = await stat(hit.full); this.check();
    if (api === "fs.remove") {
      if (hit.full === this.root) throw pluginFailure("PERMISSION_DENIED", "Cannot remove the workspace root");
      this.deletes = this.deletes.filter(time => Date.now() - time < 60_000);
      if (this.deletes.length >= 20 && !consent) throw pluginFailure("FS_CONSENT_REQUIRED", "Confirm the deletion rate for this workspace");
      this.deletes.push(Date.now());
      if (info.isDirectory()) await rmdir(hit.full); else await rm(hit.full);
      this.written.delete(hit.full); return null;
    }
    if (!info.isFile()) throw pluginFailure("INVALID_ARGUMENT", "Operation requires a regular file");
    if (api === "fs.stat") return {size:info.size,mtimeMs:info.mtimeMs};
    if (api === "fs.readPreview") {
      const preview: PluginFsPreview = await previewFile(hit.full, hit.rel);
      this.check(); return {...preview,mtimeMs:info.mtimeMs};
    }
    if (api === "fs.readText") {
      if (info.size > MAX_TEXT) throw pluginFailure("LIMIT_EXCEEDED", "Text reads are limited to 8 MiB; use readRange");
      const file = await open(hit.full,"r");
      try { const bytes = Buffer.alloc(MAX_TEXT + 1); const read = await file.read(bytes,0,bytes.length,0); this.check();
        if (read.bytesRead > MAX_TEXT) throw pluginFailure("LIMIT_EXCEEDED", "File grew beyond the text limit");
        return bytes.subarray(0,read.bytesRead).toString("utf8");
      } finally { await file.close(); }
    }
    const offset = args[1]; const length = args[2];
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > MAX_RANGE) throw pluginFailure("INVALID_ARGUMENT", "Invalid byte range (maximum 8 MiB)");
    const file = await open(hit.full,"r");
    try {
      const bytes = Buffer.alloc(length); const result = await file.read(bytes,0,length,offset); this.check();
      return {bytes:Array.from(bytes.subarray(0,result.bytesRead)),totalSize:info.size};
    } finally { await file.close(); }
  }
  private async list(directory: string, prefix: string, pattern?: string): Promise<unknown[]> {
    const entries: unknown[] = []; let visited = 0;
    const scope = this.policy.read?.scope ?? [];
    const walk = async (path: string, base: string, depth: number) => {
      if (depth > 32 || entries.length >= 1000) return;
      for (const entry of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
        this.check(); if (++visited > 20_000 || entries.length >= 1000) return;
        const rel = base && base !== "." ? `${base}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink() || isDeniedFsPath(rel) || SKIP.has(entry.name)) continue;
        const full = await realpath(join(path,entry.name));
        if (!within(this.root,full) || within(this.protectedRoot,full) || isDeniedFsPath(relative(this.root,full))) continue;
        if (entry.isDirectory()) {
          if (pattern !== undefined) await walk(full,rel,depth+1);
          else entries.push({name:entry.name,path:rel,isDirectory:true});
        } else if (entry.isFile() && isFsPathInScope(rel,scope)) {
          if (pattern !== undefined) { if (matchFsGlob(rel,pattern)) entries.push(rel); }
          else { const info=await stat(full); entries.push({name:entry.name,path:rel,isDirectory:false,size:info.size,mtimeMs:info.mtimeMs}); }
        }
      }
    };
    await walk(directory,prefix,0); this.check(); return entries;
  }
}
