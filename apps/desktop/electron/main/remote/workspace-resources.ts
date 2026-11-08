import type { Server } from "node:http";
import { openWorkspaceResourceServer } from "./workspace-resource-server";
import { open, rm } from "node:fs/promises";
import { extname, posix, win32 } from "node:path";
import type { WorkspaceExecutionContext } from "@pi-desktop/shared";
import { ExternalResourceActivity } from "../external-resource-activity";

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
type Lease = { ownerId: string; server: Server; timer: NodeJS.Timeout; active: boolean; closing?: Promise<void> };

/** Desktop resource ownership; all remote bytes still pass through the admitted file API. */
export class WorkspaceResources {
  private readonly leases = new Set<Lease>();
  private readonly activity: ExternalResourceActivity;
  private readonly owners = new Map<string, { active: boolean }>();
  private opening = 0;
  private disposed = false;
  private readonly options: {
    isAdmissionClosed(): boolean;
    onCleanupError?(): void;
    chooseCopy(input: { name: string; pluginName: string; hostKey: string }, assertCurrent: () => void): Promise<string | null>;
    openCopy(path: string): Promise<void>;
    openBrowser(url: string, sessionId: string): Promise<void>;
    reveal(path: string, sessionId: string): Promise<void>;
  };
  constructor(options: WorkspaceResources["options"]) {
    this.options = options; this.activity = new ExternalResourceActivity(options.isAdmissionClosed);
  }
  open(input: WorkspaceResourceRequest): Promise<void> {
    return this.activity.run(() => this.openCurrent(input));
  }
  getHandoffActivity() { return this.activity.snapshot(this.leases.size); }
  private async openCurrent(input: WorkspaceResourceRequest): Promise<void> {
    if (this.disposed || this.opening + this.leases.size >= 8) throw failure("LIMIT_EXCEEDED", "Workspace resource limit reached");
    if (input.context.authority.kind !== "remote") throw failure("INVALID_ARGUMENT", "A remote workspace is required");
    const owner = this.owners.get(input.ownerId) ?? { active: true };
    this.owners.set(input.ownerId, owner);
    let lease: Lease | undefined;
    const assertCurrent = () => {
      if (this.disposed || !owner.active || (lease && !lease.active)) throw failure("PLUGIN_GONE", "Resource owner was closed");
      this.activity.assertOpen();
    };
    const check = async () => { assertCurrent(); await input.validate(); assertCurrent(); };
    const paths = input.context.platform === "win32" ? win32 : posix;
    const root = input.context.roots.find(item => item.primary)!.path;
    const raw = input.path;
    if (!raw || raw.length > 4096 || /[\u0000-\u001f]/.test(raw) || raw.startsWith("remote-project:")) throw failure("INVALID_ARGUMENT", "Invalid resource path");
    const path = paths.isAbsolute(raw) ? paths.relative(root, raw) : raw;
    if (path.split(/[\\/]/).includes("..") || paths.isAbsolute(path) || /^[a-z]:/i.test(path)) throw failure("PERMISSION_DENIED", "Resource must remain inside its workspace");
    const info = async (file: string) => {
      await check(); assertCurrent();
      const result = await input.read<FileInfo>("fs.stat", [file]);
      if (!Number.isSafeInteger(result.size) || result.size < 0 || result.size > MAX_FILE || !Number.isFinite(result.mtimeMs)) throw failure("LIMIT_EXCEEDED", "Workspace resources are limited to 64 MiB");
      await check(); assertCurrent(); return result;
    };
    const bytes = async (file: string, offset: number, length: number, size: number) => {
      await check(); assertCurrent();
      const value = await input.read<{ bytes: number[]; totalSize: number }>("fs.readRange", [file, offset, length]);
      if (value.totalSize !== size || !Array.isArray(value.bytes) || value.bytes.length !== length || value.bytes.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw failure("FILE_CHANGED", "Workspace file changed during transfer");
      await check(); assertCurrent(); return Buffer.from(value.bytes);
    };
    this.opening++;
    try {
      const initial = await info(path);
      if (input.api === "fs.reveal") {
        if (!input.sessionId) throw failure("WORKSPACE_REQUIRED", "File reveal requires an originating session");
        await check(); assertCurrent(); await this.options.reveal(paths.resolve(root, path), input.sessionId); return;
      }
      if (input.api === "fs.openDefault") {
        await check(); assertCurrent(); this.activity.nativeAttempt();
        const target = await this.options.chooseCopy({ name: paths.basename(path), pluginName: input.pluginName, hostKey: input.context.authority.hostKey }, assertCurrent);
        if (!target) throw failure("CANCELLED", "Download cancelled");
        await check(); assertCurrent();
        // Never replace an existing Desktop file, including a race after the picker.
        const file = await open(target, "wx", 0o600);
        let complete = false;
        try {
          for (let offset = 0; offset < initial.size; offset += CHUNK) {
            const chunk = await bytes(path, offset, Math.min(CHUNK, initial.size - offset), initial.size);
            assertCurrent(); await file.writeFile(chunk);
          }
          const latest = await info(path);
          if (latest.size !== initial.size || latest.mtimeMs !== initial.mtimeMs) throw failure("FILE_CHANGED", "Workspace file changed during transfer");
          assertCurrent(); await file.sync(); await check(); assertCurrent(); complete = true;
        } finally { await file.close(); if (!complete) await rm(target, { force: true }); }
        await check(); assertCurrent(); this.activity.nativeAttempt(); await this.options.openCopy(target); return;
      }
      if (!input.sessionId) throw failure("WORKSPACE_REQUIRED", "Browser preview requires an originating session");
      if (![".html", ".htm", ".xhtml"].includes(extname(path).toLowerCase())) throw failure("INVALID_ARGUMENT", "Browser preview requires an HTML file");
      await check(); assertCurrent(); this.activity.nativeAttempt();
      const { server, url } = await openWorkspaceResourceServer({ path, paths, info, bytes, assertCurrent,
        track: operation => this.activity.track(operation) });
      const currentLease: Lease = { ownerId: input.ownerId, server, active: true,
        timer: setTimeout(() => { void this.close(currentLease); }, LIFETIME) };
      lease = currentLease;
      currentLease.timer.unref(); server.unref(); this.leases.add(currentLease);
      try { await check(); assertCurrent(); this.activity.nativeAttempt(); await this.options.openBrowser(url, input.sessionId); await check(); assertCurrent(); }
      catch (error) { await this.close(currentLease); throw error; }
    } finally { this.opening--; }
  }
  private close(lease: Lease): Promise<void> {
    lease.active = false; clearTimeout(lease.timer);
    if (lease.closing) return lease.closing;
    lease.closing = this.activity.track(async () => {
      await Promise.resolve();
      try {
        await new Promise<void>((resolve, reject) => {
          lease.server.close(error => error ? reject(error) : resolve());
          lease.server.closeAllConnections();
        });
      } catch {
        (this.options.onCleanupError ?? (() => console.warn("Workspace resource cleanup failed; idle handoff remains unavailable")))();
      } finally { this.leases.delete(lease); }
    });
    return lease.closing;
  }
  closeOwner(ownerId: string): void {
    const owner = this.owners.get(ownerId); if (owner) owner.active = false;
    this.owners.delete(ownerId);
    for (const lease of this.leases) if (lease.ownerId === ownerId) void this.close(lease);
  }
  dispose(): void { this.disposed = true; this.activity.seal(); for (const lease of this.leases) void this.close(lease); this.owners.clear(); }
}
