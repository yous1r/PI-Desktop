/** Desktop downloads through its global network policy, verifies, then uploads. */
import { buildBootstrapScript, type PiHostBootstrapScriptInput } from "./pi-host-bootstrap-script.js";
import { uploadSshArtifact } from "./ssh-artifact-transfer.js";
import type { SshExecResult, SshTransport } from "./ssh-transport.js";

export async function installPiHost(
  transport: SshTransport,
  input: PiHostBootstrapScriptInput,
  options: {
    timeoutMs: number; signal?: AbortSignal;
    uploadArtifact?: typeof uploadSshArtifact;
    fetchArtifact?: typeof fetch;
    onDownload?: () => void;
    onUpload?: () => void;
    onInstall?: () => void;
    log?: (level: "warn", message: string) => void;
  },
): Promise<SshExecResult> {
  options.signal?.throwIfAborted();
  options.onDownload?.();
  const artifact = await (options.uploadArtifact ?? uploadSshArtifact)(transport, {
    url: input.artifactUrl, expectedSha256: input.expectedSha256,
    signal: options.signal, fetchArtifact: options.fetchArtifact, onUpload: options.onUpload,
  });
  try {
    options.signal?.throwIfAborted();
    options.onInstall?.();
    return await transport.execWithInput("sh -s", buildBootstrapScript({ ...input, artifactPath: artifact.path }),
      { timeoutMs: options.timeoutMs, maxOutputBytes: 64 * 1024 });
  } finally {
    try { await artifact.cleanup(); }
    catch { options.log?.("warn", "SSH artifact temporary directory cleanup failed"); }
  }
}
