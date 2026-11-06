import type { RemoteHostBootstrapRequest } from "@pi-desktop/shared";
import { sshMetadataOf } from "./remote-host-metadata.js";
import type { RemoteHostRecord } from "./remote-host-registry.js";
import type { SshBootstrap, SshBootstrapOutcome } from "./ssh-bootstrap.js";
import type { PreparationRunOptions } from "./remote-host-prepare.js";

/** Reuse the verified installer while retaining the enrolled Host and device. */
export function createRemoteHostRealigner(options: {
  bootstrap: SshBootstrap["bootstrap"];
  upsert(record: RemoteHostRecord): Promise<void>;
}) {
  return async (record: RemoteHostRecord, run: PreparationRunOptions): Promise<{ record: RemoteHostRecord; outcome: SshBootstrapOutcome }> => {
    const ssh = sshMetadataOf(record);
    if (!ssh?.hostId) throw Object.assign(new Error("Remote Host identity must be enrolled before upgrading"), { errorCode: "HOST_AUTH_FAILED" });
    if (ssh.auth === "password" && !record.sshSecret) throw Object.assign(new Error("SSH authentication is required"), { errorCode: "SSH_AUTH_FAILED" });
    const request: RemoteHostBootstrapRequest = {
      hostKey: record.hostKey, label: record.label, host: ssh.host,
      ...(ssh.port !== undefined ? { port: ssh.port } : {}),
      ...(ssh.user ? { user: ssh.user } : {}),
      ...(ssh.identityFile ? { identityFile: ssh.identityFile } : {}),
      ...(record.sshSecret ? { password: record.sshSecret } : {}), remotePort: 0,
    };
    const outcome = await options.bootstrap(request, {
      signal: run.signal,
      existing: { hostId: ssh.hostId, deviceToken: record.deviceToken, version: run.currentVersion ?? ssh.version },
      allowLegacyMaintenance: run.allowLegacyMaintenance,
      onProgress: step => run.progress(step === "download" || step === "download-checksum" ? "downloading"
        : step === "upload" ? "uploading" : step === "install" ? "installing"
        : step === "start" ? "starting" : step === "probe" || step === "resolve-release" ? "checking" : "connecting"),
    });
    try {
      run.signal.throwIfAborted();
      if (outcome.ssh.hostId !== ssh.hostId || outcome.deviceToken !== record.deviceToken) {
        throw Object.assign(new Error("The upgraded Host identity changed"), { errorCode: "HOST_AUTH_FAILED" });
      }
      const next = { ...record, url: outcome.url,
        metadata: { ...record.metadata, transport: "ssh", ssh: outcome.ssh, piHostDownloadConsent: true } };
      await options.upsert(next);
      return { record: next, outcome };
    } catch (error) {
      await outcome.forward.close();
      throw error;
    }
  };
}
