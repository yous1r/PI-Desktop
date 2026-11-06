/**
 * Settings navigation is a tab swap, so leaving Remote hosts for one row in
 * General ─ Network would otherwise discard the Add form the user was filling
 * in. This holds that draft across the unmount and hands it back on return.
 *
 * Passwords are deliberately not part of the draft: returning from a network
 * setting must never resurrect a secret the user cannot see was dropped.
 */
import type { RemoteHostSshAuth } from "@pi-desktop/shared";

export type RemoteHostAddMode = "ssh" | "pair";

export type RemoteHostSshDraft = {
  label: string;
  host: string;
  user: string;
  port: string;
  identityFile: string;
  auth: RemoteHostSshAuth;
};

export type RemoteHostDraft = {
  mode: RemoteHostAddMode;
  ssh: RemoteHostSshDraft;
  /** Remote project path the user was choosing, when a picker sent them here. */
  remotePath?: string;
};

let pending: RemoteHostDraft | null = null;

/** Remember what the user was doing before jumping to another Settings tab. */
export function rememberRemoteHostDraft(draft: RemoteHostDraft): void {
  pending = {
    mode: draft.mode,
    ssh: { ...draft.ssh },
    ...(draft.remotePath ? { remotePath: draft.remotePath } : {}),
  };
}

/** Hand the draft to the returning page exactly once. */
export function takeRemoteHostDraft(): RemoteHostDraft | null {
  const draft = pending;
  pending = null;
  return draft ? { ...draft, ssh: { ...draft.ssh } } : null;
}

/** Drop a remembered draft, e.g. after the host was added successfully. */
export function clearRemoteHostDraft(): void {
  pending = null;
}
