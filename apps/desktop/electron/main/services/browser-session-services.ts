import { join } from "node:path";
import type { AppSettings } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { BrowserHostDeps } from "../browser-host";
import type { BrowserOperationOwner } from "../browser-activity";
import { projectFolderPaths } from "../workspace-roots";

type BrowserSessionDependencies = {
  dataDir: string;
  getHost: () => Pick<HostProcess, "call" | "generation" | "isAvailable"> | null;
  getWorkspacePath: () => string | null;
  openExternal: (url: string) => Promise<void>;
  preview: (sessionId: string, url: string) => void;
};

/** Async browser roots and link preferences belong to the Host that accepted the lookup. */
export function createBrowserSessionServices(deps: BrowserSessionDependencies): Pick<BrowserHostDeps, "getFileRoots" | "getScratchDir" | "onOpenUrl"> {
  const capture = (owner: BrowserOperationOwner) => {
    owner.assertCurrent();
    const host = deps.getHost();
    const generation = host?.generation;
    const assertCurrent = () => {
      owner.assertCurrent();
      if (deps.getHost() !== host || host?.generation !== generation || (host && !host.isAvailable())) {
        throw Object.assign(new Error("Browser preview host changed or is unavailable."), { code: "HOST_UNAVAILABLE" });
      }
    };
    assertCurrent();
    return { host, assertCurrent };
  };
  return {
    async onOpenUrl(url, sessionId, owner) {
      const source = capture(owner);
      const settings = await source.host?.call<AppSettings>("settings.get");
      source.assertCurrent();
      if (!sessionId || settings?.linkOpenTarget === "external" || !/^https?:/i.test(url)) {
        owner.nativeAttempt();
        await deps.openExternal(url);
      } else {
        deps.preview(sessionId, url);
      }
    },
    async getFileRoots(sessionId, owner) {
      const source = capture(owner);
      if (!sessionId) return projectFolderPaths(deps.getWorkspacePath());
      const host = source.host;
      if (!host) throw new Error("Browser preview host is unavailable.");
      const res = await host.call<{ session: { projectPath?: string; worktree?: unknown } | null }>("session.get", { id: sessionId });
      source.assertCurrent();
      if (!res?.session) throw new Error("Browser preview session is unavailable.");
      if (res.session.worktree) {
        const location = await host.call<{ path?: string }>("worktree.location", { sessionId });
        source.assertCurrent();
        const path = location.path?.trim();
        if (!path) throw new Error("Browser preview worktree is unavailable.");
        return [path, join(deps.dataDir, "scratch", sessionId)];
      }
      return [...projectFolderPaths(res.session.projectPath?.trim() || null), join(deps.dataDir, "scratch", sessionId)];
    },
    getScratchDir: (sessionId) => sessionId ? join(deps.dataDir, "scratch", sessionId) : null,
  };
}
