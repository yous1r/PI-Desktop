import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { relative } from "node:path";
import * as Value from "typebox/value";
import { WorkspacePluginFilesResultSchema, type WorkspacePluginFilesRequest, type WorkspacePluginFilesResult } from "@pi-desktop/shared";
import { isDeniedFsPath, isFsPathInScope, normalizeFsPath, type PluginFsRule } from "@pi-desktop/plugin-sdk";
import { previewFile, resolveRealPathWithinRoot, resolveWithinRoot } from "@pi-desktop/host-runtime";
import type { PluginToolInvocation } from "./plugin-tool-invocations";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
type Session = { projectPath?: string | null; worktree?: unknown; remoteWorkspace?: { hostKey: string; path: string } };
export type OwnerFileInput = {
  invocation: PluginToolInvocation; path: string; rule: PluginFsRule;
  workspacePath?: string; isProtected: (path: string) => boolean;
  audit?: (entry: Record<string, unknown>) => void;
};
export type OwnerFileReader = (input: OwnerFileInput) => Promise<Exclude<WorkspacePluginFilesResult, { kind: "list" }>>;
const failure = (code: string) => Object.assign(new Error(`Owner file access failed (${code})`), { code });

/** Session-scoped previews never fall back to the visible window or local cwd. */
export function createOwnerFileReader(deps: {
  getHost: () => Host | null;
  getRemote: () => { workspacePluginFiles(hostKey: string, input: WorkspacePluginFilesRequest): Promise<unknown> } | null;
  isPluginActive: (pluginId: string, projectPath: string | null) => boolean;
}): OwnerFileReader {
  const read: OwnerFileReader = async ({ invocation, path, rule, workspacePath, isProtected }) => {
    const { signal, sessionId, pluginId } = invocation;
    signal.throwIfAborted();
    if (rule.root !== "workspace" || typeof path !== "string" || /[\u0000-\u001f\\:]/.test(path) ||
        path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..")) throw failure("INVALID_ARGUMENT");
    if (isDeniedFsPath(path) || !isFsPathInScope(path, rule.scope)) throw failure("PERMISSION_DENIED");
    const host = deps.getHost();
    if (!host) throw failure("HOST_UNAVAILABLE");
    const resolve = async () => {
      signal.throwIfAborted();
      const { session } = await host.call<{ session: Session | null }>("session.get", { id: sessionId });
      const projectPath = session?.projectPath?.trim() || null;
      if (!session || !projectPath || !deps.isPluginActive(pluginId, projectPath)) throw failure("PERMISSION_DENIED");
      if (workspacePath !== undefined && workspacePath !== projectPath) throw failure("WORKSPACE_CHANGED");
      const root = session.remoteWorkspace?.path ?? (session.worktree
        ? (await host.call<{ path?: string }>("worktree.location", { sessionId })).path?.trim() : projectPath);
      signal.throwIfAborted();
      if (!root || deps.getHost() !== host) throw failure("HOST_UNAVAILABLE");
      return { root, projectPath, remote: session.remoteWorkspace };
    };
    const binding = await resolve();
    let result: unknown;
    if (binding.remote) {
      const remote = deps.getRemote();
      if (!remote) throw failure("HOST_UNAVAILABLE");
      result = await remote.workspacePluginFiles(binding.remote.hostKey, {
        path: binding.root, ref: path, operation: "preview", scope: rule.scope,
      });
      if (deps.getRemote() !== remote) throw failure("HOST_UNAVAILABLE");
    } else {
      if (binding.projectPath.startsWith("remote-project:")) throw failure("HOST_UNAVAILABLE");
      const full = await resolveRealPathWithinRoot(binding.root, path);
      if (!full) {
        const lexical = resolveWithinRoot(binding.root, path);
        throw failure(lexical && !existsSync(lexical) ? "NOT_FOUND" : "PERMISSION_DENIED");
      }
      const actual = normalizeFsPath(relative(await realpath(binding.root), full));
      if (isProtected(full) || isDeniedFsPath(actual) || !isFsPathInScope(actual, rule.scope)) throw failure("PERMISSION_DENIED");
      const info = await stat(full);
      if (!info.isFile()) throw failure("INVALID_ARGUMENT");
      result = { ...await previewFile(full, actual), mtimeMs: info.mtimeMs };
    }
    signal.throwIfAborted();
    if (JSON.stringify(await resolve()) !== JSON.stringify(binding)) throw failure("WORKSPACE_CHANGED");
    if (!Value.Check(WorkspacePluginFilesResultSchema, result) || result.kind === "list") throw failure("INVALID_RESPONSE");
    return result;
  };
  return async (input) => {
    const entry = { pluginId: input.invocation.pluginId, api: "fs.readPreview", ts: Date.now(),
      path: typeof input.path === "string" ? input.path.slice(0, 4096) : undefined };
    try {
      const result = await read(input);
      input.audit?.({ ...entry, ok: true, data: { kind: result.kind, size: result.size } });
      return result;
    } catch (error) {
      input.audit?.({ ...entry, ok: false, errorCode: "OWNER_FILE_READ_FAILED" });
      throw error;
    }
  };
}
