import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { stripProxyEnv, type OwnerHandoffResponse } from "@pi-desktop/shared";
import { OwnerHandoffChannel } from "./owner-handoff-channel.js";
import { confirmChildExit } from "./process-exit-confirmation.js";

export type OwnerHandoffProcessOptions = {
  /** Resolved by the trusted application launcher; never a remote request field. */
  binaryPath: string;
  dataDir: string;
  profileId: string;
  env?: NodeJS.ProcessEnv;
  onStderr: (text: string) => void;
};

/** Existing-profile-only restricted Host; never starts AppState or an Agent.
 * The successor `--owner-target` mode is owned by OwnerHandoffTargetProcess,
 * which frames the BootstrapRequest envelope rather than a command.
 */
export class OwnerHandoffProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly channel: OwnerHandoffChannel;
  private disposal?: Promise<void>;
  private spawnFailed = false;
  private exited = false;

  constructor(options: OwnerHandoffProcessOptions) {
    if (process.platform !== "win32") throw new Error("HANDOFF_NATIVE_PROOF_UNSUPPORTED");
    if (!isAbsolute(options.binaryPath) || !isAbsolute(options.dataDir) ||
        options.binaryPath.includes("\0") || options.dataDir.includes("\0") || !/^[0-9a-f]{64}$/.test(options.profileId)) {
      throw new Error("HANDOFF_INVALID_IDENTITY");
    }
    this.child = spawn(options.binaryPath, ["--owner-handoff"], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      env: { ...stripProxyEnv(process.env), ...options.env, PI_DESKTOP_DATA_DIR: options.dataDir },
    });
    this.channel = new OwnerHandoffChannel({ input: this.child.stdout, output: this.child.stdin, profileId: options.profileId });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", options.onStderr);
    this.child.stderr.on("error", this.onUnavailable);
    this.child.on("error", this.onProcessError);
    this.child.on("exit", this.onExit);
    this.child.once("close", () => {
      this.channel.dispose();
      this.child.stderr.off("data", options.onStderr);
      this.child.stderr.off("error", this.onUnavailable);
      this.child.off("error", this.onProcessError);
      this.child.off("exit", this.onExit);
    });
  }

  private readonly onUnavailable = (): void => { this.channel.close(); };
  private readonly onProcessError = (): void => {
    this.spawnFailed = this.child.pid === undefined;
    this.channel.close();
  };
  private readonly onExit = (): void => { this.exited = true; };

  call(command: unknown, timeoutMs?: number): Promise<OwnerHandoffResponse> {
    if (this.exited || this.spawnFailed) return Promise.reject(new Error("HANDOFF_TRANSPORT_CLOSED"));
    return this.channel.call(command, timeoutMs);
  }

  confirmExit(timeoutMs = 2_000): Promise<boolean> { return confirmChildExit(this.child, timeoutMs); }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.channel.close();
    this.disposal = (async () => {
      if (this.spawnFailed) return;
      if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end();
      if (await this.confirmExit()) return;
      // Signal only the original ChildProcess. No PID lookup or name-based kill.
      if (this.child.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
      if (!await this.confirmExit()) throw new Error("HANDOFF_EXIT_UNCONFIRMED");
    })();
    return this.disposal;
  }
}
