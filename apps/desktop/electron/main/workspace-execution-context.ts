import { basename, isAbsolute, posix } from "node:path";
import type { ProjectGroupRecord, WorkspaceExecutionContext } from "@pi-desktop/shared";
import { sameWorkspacePath } from "./workspace-path";

type WorkspaceHost = { call<T>(method: string, input?: unknown): Promise<T> };
export type WorkspaceRemoteState = {
  connected: boolean;
  generation: number;
  platform: "linux" | "darwin" | "win32";
};
export type WorkspaceInvocationOwner = {
  sessionId?: string;
  workspacePath?: string;
  /** Host-captured identity; never accepted from an untrusted plugin payload. */
  context?: WorkspaceExecutionContext;
  /** Terminals may explicitly reattach after a connection change. */
  allowReconnect?: boolean;
};
const fail = (code: string, message: string) => Object.assign(new Error(message), { code, errorCode: code });

/** Resolve only durable session/project bindings; never guess a remote target. */
export function createWorkspaceExecutionResolver(deps: {
  getHost: () => WorkspaceHost | null;
  currentWorkspacePath: () => string | null;
  remoteState: (hostKey: string) => Promise<WorkspaceRemoteState>;
  platform?: "linux" | "darwin" | "win32";
}) {
  const revisions = new Map<string, { fingerprint: string; generation: number }>();
  let nextGeneration = 0;
  let previousHost: WorkspaceHost | null = null;
  const samePath = (left: string, right: string) => sameWorkspacePath(left, right, deps.platform);
  // A caller may capture its transport identity while preserving this resolver's
  // workspace revision history. The override is process-local, never wire input.
  return async (input: WorkspaceInvocationOwner = {}, remoteState = deps.remoteState): Promise<WorkspaceExecutionContext | null> => {
    const host = deps.getHost();
    if (!host) throw fail("HOST_UNAVAILABLE", "Workspace owner is unavailable");
    if (host !== previousHost) { revisions.clear(); previousHost = host; }
    const pinned = input.context;
    const { groups } = await host.call<{ groups: ProjectGroupRecord[] }>("project.groups.list");
    if (deps.getHost() !== host) throw fail("HOST_UNAVAILABLE", "Workspace owner was replaced");
    const pinnedGroup = pinned ? groups.find(item => item.id === pinned.projectId) : undefined;
    if (pinned && !pinnedGroup && !pinned.projectId.startsWith("local:")) {
      throw fail("WORKSPACE_CHANGED", "The originating project was removed");
    }
    let workspacePath: string | undefined;
    if (input.sessionId) {
      const { session } = await host.call<{ session?: { projectPath?: string } }>("session.get", { id: input.sessionId, messageLimit: 1 });
      if (!session) throw fail("NOT_FOUND", "The originating session is unavailable");
      workspacePath = session.projectPath;
      if (input.workspacePath && (!workspacePath || !samePath(input.workspacePath, workspacePath))) throw fail("WORKSPACE_CHANGED", "The originating workspace has changed");
    } else if (pinned) {
      workspacePath = pinnedGroup?.primaryPath ?? pinned.roots.find(root => root.primary)?.path;
    } else {
      workspacePath = deps.currentWorkspacePath() ?? undefined;
      if (input.workspacePath && (!workspacePath || !samePath(input.workspacePath, workspacePath))) throw fail("WORKSPACE_CHANGED", "The selected workspace has changed");
    }
    if (deps.getHost() !== host) throw fail("HOST_UNAVAILABLE", "Workspace owner was replaced");
    if (!workspacePath) return null;
    const group = groups.find(item => samePath(item.primaryPath, workspacePath!) || item.roots.some(root => samePath(root.path, workspacePath!)));
    const remote = group?.remote;
    if (workspacePath.startsWith("remote-project:") && !remote) throw fail("NOT_FOUND", "Remote workspace binding is unavailable");
    if (remote && !workspacePath.startsWith("remote-project:")) throw fail("INVALID_WORKSPACE_CONTEXT", "Remote workspace identity is invalid");
    const id = group?.id ?? `local:${workspacePath}`;
    let context: Omit<WorkspaceExecutionContext, "generation">;
    let connectionGeneration = 0;
    if (remote) {
      if (!remote.hostKey || !posix.isAbsolute(remote.path) || /[\u0000-\u001f]/.test(remote.path)) throw fail("INVALID_WORKSPACE_CONTEXT", "Remote workspace binding is invalid");
      const state = await remoteState(remote.hostKey);
      if (deps.getHost() !== host) throw fail("HOST_UNAVAILABLE", "Workspace owner was replaced");
      if (!state.connected) throw fail("HOST_UNAVAILABLE", "Remote workspace is disconnected");
      const current = await host.call<{ groups: ProjectGroupRecord[] }>("project.groups.list");
      const rebound = current.groups.find(item => item.id === group!.id)?.remote;
      if (deps.getHost() !== host) throw fail("HOST_UNAVAILABLE", "Workspace owner was replaced");
      if (!rebound || rebound.hostKey !== remote.hostKey || rebound.path !== remote.path) {
        throw fail("WORKSPACE_CHANGED", "Remote workspace binding changed during resolution");
      }
      if (input.sessionId) {
        const latest = await host.call<{ session?: { projectPath?: string } }>("session.get", { id: input.sessionId, messageLimit: 1 });
        if (deps.getHost() !== host) throw fail("HOST_UNAVAILABLE", "Workspace owner was replaced");
        if (latest.session?.projectPath !== workspacePath) throw fail("WORKSPACE_CHANGED", "The originating session workspace changed");
      } else if (!pinned && deps.currentWorkspacePath() !== workspacePath) {
        throw fail("WORKSPACE_CHANGED", "The selected workspace changed");
      }
      connectionGeneration = state.generation;
      context = {
        workspaceId: id, projectId: id, authority: { kind: "remote", hostKey: remote.hostKey },
        roots: [{ path: remote.path, name: group!.name || posix.basename(remote.path), primary: true }],
        platform: state.platform, connectionState: "connected",
      };
    } else {
      if (!isAbsolute(workspacePath)) throw fail("INVALID_WORKSPACE_CONTEXT", "Local workspace path is invalid");
      const ordered = group?.roots.slice().sort((a, b) => Number(samePath(b.path, workspacePath!)) - Number(samePath(a.path, workspacePath!)) || a.position - b.position);
      context = {
        workspaceId: id, projectId: id, authority: { kind: "local" },
        roots: ordered?.length ? ordered.map(root => ({ path: root.path, name: root.name, primary: samePath(root.path, workspacePath!) })) : [{ path: workspacePath, name: basename(workspacePath), primary: true }],
        platform: deps.platform ?? (process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"),
        connectionState: "connected",
      };
    }
    const fingerprint = JSON.stringify([context, connectionGeneration]);
    const previous = revisions.get(id);
    const generation = previous?.fingerprint === fingerprint ? previous.generation : ++nextGeneration;
    revisions.set(id, { fingerprint, generation });
    const resolved = { ...context, generation };
    if (pinned) {
      const identity = (value: WorkspaceExecutionContext) => JSON.stringify([
        value.workspaceId, value.projectId, value.authority, value.roots, value.platform,
      ]);
      if (identity(pinned) !== identity(resolved) || (!input.allowReconnect && pinned.generation !== generation)) {
        throw fail("WORKSPACE_CHANGED", "The originating workspace or connection changed; reopen the surface");
      }
    }
    return resolved;
  };
}
