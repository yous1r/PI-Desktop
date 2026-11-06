import { shellQuote } from "./pi-host-bootstrap-script.js";
import type { SshTransport } from "./ssh-transport.js";

/** Called only after RACP authenticates the enrolled identity and capabilities. */
export async function completeHostDeployment(transport: SshTransport, transactionId: string, hostId: string): Promise<void> {
  const fail = () => Object.assign(new Error("Remote Host deployment requires recovery"), { errorCode: "HOST_RECOVERY_REQUIRED" });
  if (!/^[a-f0-9]{32}$/.test(transactionId) || !hostId || hostId.length > 256 || /[\0\r\n]/.test(hostId)) throw fail();
  const script = `set -eu
base="$HOME/.pi-desktop/pi-host"
cd -P "$base/current"
NODE_OPTIONS= NODE_PATH= flock -w 15 "$base/.deploy.lock" "$PWD/bin/node" "$PWD/deploy.mjs" --complete ${shellQuote(transactionId)} ${shellQuote(hostId)}
`;
  try {
    const result = await transport.execWithInput("sh -s", script, { timeoutMs: 30_000, maxOutputBytes: 4096 });
    if (result.code !== 0 || result.stdout.trim() !== `PI_HOST_DEPLOYMENT_COMPLETE ${transactionId}`) throw fail();
  } catch { throw fail(); }
}
