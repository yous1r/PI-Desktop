import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  OWNER_HANDOFF_MAX_RECORD_BYTES,
  parseOwnerHandoffBootstrapCommand,
  parseOwnerHandoffResponse,
  stripProxyEnv,
  type OwnerHandoffResponse,
} from "@pi-desktop/shared";
import { confirmChildExit } from "./process-exit-confirmation.js";
import {
  OwnerHandoffTargetSupervisor,
  type OwnerHandoffTargetEnvelope,
  type OwnerHandoffTargetSupervisorOptions,
  type OwnerHandoffTargetTransport,
} from "./owner-handoff-target.js";

export type OwnerHandoffTargetProcessOptions = {
  /** Resolved by the trusted application launcher; never a remote request field. */
  binaryPath: string;
  dataDir: string;
  profileId: string;
  env?: NodeJS.ProcessEnv;
  onStderr: (text: string) => void;
};

function failure(errorCode: string): Error {
  return Object.assign(new Error(errorCode), { errorCode });
}
function envelopeBytes(request: OwnerHandoffTargetEnvelope): Buffer {
  if (!request || request.version !== 1 || !/^[0-9a-f]{64}$/.test(request.profileId)) {
    throw failure("HANDOFF_INVALID_REQUEST");
  }
  const command = parseOwnerHandoffBootstrapCommand(request.command);
  if (command.operation !== "claim") throw failure("HANDOFF_CLAIM_REQUIRED");
  const body = Buffer.from(JSON.stringify(request));
  if (body.length < 1 || body.length > OWNER_HANDOFF_MAX_RECORD_BYTES) throw failure("HANDOFF_INVALID_FRAME");
  const bytes = Buffer.alloc(4 + body.length);
  bytes.writeUInt32LE(body.length);
  body.copy(bytes, 4);
  return bytes;
}

/**
 * Original `--owner-target` child over the private framed channel. One claim
 * call is expected; the transport fails closed on an invalid frame, stream
 * closure or timeout and never looks up a PID it did not spawn.
 */
export class OwnerHandoffTargetProcess implements OwnerHandoffTargetTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly buffer = Buffer.alloc(OWNER_HANDOFF_MAX_RECORD_BYTES + 4);
  private received = 0;
  private length?: number;
  private pending?: {
    resolve: (response: OwnerHandoffResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private failed?: Error;
  private disposal?: Promise<void>;
  private spawnFailed = false;
  private exited = false;

  constructor(private readonly options: OwnerHandoffTargetProcessOptions) {
    if (process.platform !== "win32") throw failure("HANDOFF_NATIVE_PROOF_UNSUPPORTED");
    if (typeof options.binaryPath !== "string" || typeof options.dataDir !== "string" ||
        !isAbsolute(options.binaryPath) || !isAbsolute(options.dataDir) ||
        options.binaryPath.includes("\0") || options.dataDir.includes("\0") ||
        !/^[0-9a-f]{64}$/.test(options.profileId)) {
      throw failure("HANDOFF_INVALID_IDENTITY");
    }
    this.child = spawn(options.binaryPath, ["--owner-target"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...stripProxyEnv(process.env), ...options.env, PI_DESKTOP_DATA_DIR: options.dataDir },
    });
    this.child.stdout.on("data", this.onData);
    this.child.stdout.on("end", this.onClosed);
    this.child.stdout.on("close", this.onClosed);
    this.child.stdout.on("error", this.onClosed);
    this.child.stdin.on("error", this.onClosed);
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", options.onStderr);
    this.child.stderr.on("error", this.onClosed);
    this.child.on("error", this.onProcessError);
    this.child.on("exit", this.onExit);
    this.child.once("close", this.onClose);
  }

  private readonly onClose = (): void => {
    this.fail("HANDOFF_TRANSPORT_CLOSED");
    this.disposeListeners();
  };

  private readonly onData = (chunk: unknown): void => {
    if (this.failed) return;
    if (!Buffer.isBuffer(chunk) || !this.pending || chunk.length > this.buffer.length - this.received) {
      this.fail("HANDOFF_INVALID_FRAME");
      return;
    }
    chunk.copy(this.buffer, this.received);
    this.received += chunk.length;
    if (this.length === undefined && this.received >= 4) {
      this.length = this.buffer.readUInt32LE();
      if (this.length < 1 || this.length > OWNER_HANDOFF_MAX_RECORD_BYTES) {
        this.fail("HANDOFF_INVALID_FRAME");
        return;
      }
    }
    if (this.length === undefined || this.received < this.length + 4) return;
    if (this.received !== this.length + 4) {
      this.fail("HANDOFF_INVALID_FRAME");
      return;
    }
    let response: OwnerHandoffResponse;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(this.buffer.subarray(4, this.received));
      response = parseOwnerHandoffResponse(JSON.parse(text));
    } catch {
      this.fail("HANDOFF_INVALID_FRAME");
      return;
    }
    const pending = this.pending;
    if (!pending) {
      this.fail("HANDOFF_INVALID_FRAME");
      return;
    }
    clearTimeout(pending.timer);
    this.pending = undefined;
    this.received = 0;
    this.length = undefined;
    pending.resolve(response);
  };

  private readonly onClosed = (): void => { this.fail("HANDOFF_TRANSPORT_CLOSED"); };
  private readonly onProcessError = (): void => {
    this.spawnFailed = this.child.pid === undefined;
    this.fail("HANDOFF_TRANSPORT_CLOSED");
  };
  private readonly onExit = (): void => { this.exited = true; };

  call(request: OwnerHandoffTargetEnvelope, timeoutMs = 15_000): Promise<OwnerHandoffResponse> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      return Promise.reject(new RangeError("handoff timeout must be an integer from 1 to 30000 ms"));
    }
    if (this.failed) return Promise.reject(this.failed);
    if (this.exited || this.spawnFailed) {
      return Promise.reject(failure("HANDOFF_TRANSPORT_CLOSED"));
    }
    if (this.pending) return Promise.reject(failure("HANDOFF_CHANNEL_BUSY"));
    if (request.profileId !== this.options.profileId) {
      return Promise.reject(failure("HANDOFF_INVALID_IDENTITY"));
    }
    let bytes: Buffer;
    try {
      bytes = envelopeBytes(request);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("HANDOFF_IO_TIMEOUT"), timeoutMs);
      timer.unref?.();
      this.pending = { resolve, reject, timer };
      try {
        this.child.stdin.write(bytes, (error) => {
          if (error) this.fail("HANDOFF_TRANSPORT_CLOSED");
        });
      } catch {
        this.fail("HANDOFF_TRANSPORT_CLOSED");
      }
    });
  }

  confirmExit(timeoutMs = 2_000): Promise<boolean> {
    return confirmChildExit(this.child, timeoutMs);
  }

  /** A failed spawn never produced a PID and has no child to wait for. */
  hasProcess(): boolean {
    return this.child.pid !== undefined;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.fail("HANDOFF_TRANSPORT_CLOSED");
    this.disposal = (async () => {
      if (this.spawnFailed) return;
      if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end();
      if (await this.confirmExit()) return;
      // Signal only the original ChildProcess. No PID lookup or name-based kill.
      if (this.child.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill("SIGKILL");
      }
      if (!(await this.confirmExit())) throw failure("HANDOFF_EXIT_UNCONFIRMED");
    })();
    return this.disposal;
  }

  private fail(code: string): void {
    if (this.failed) return;
    this.failed = failure(code);
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(this.failed);
    }
    this.buffer.fill(0);
    this.received = 0;
    this.length = undefined;
    this.child.stdout.off("data", this.onData);
    this.child.stdout.resume();
  }

  /** Detach stream listeners after the child and all transport work are gone. */
  private disposeListeners(): void {
    this.child.stdout.off("data", this.onData);
    this.child.stdout.off("end", this.onClosed);
    this.child.stdout.off("close", this.onClosed);
    this.child.stdout.off("error", this.onClosed);
    this.child.stdin.off("error", this.onClosed);
    // Keep cleanup writes from surfacing as an unhandled stream error.
    this.child.stdin.on("error", () => undefined);
    this.child.stderr.off("data", this.options.onStderr);
    this.child.stderr.off("error", this.onClosed);
    this.child.off("error", this.onProcessError);
    this.child.off("exit", this.onExit);
    this.child.off("close", this.onClosed);
  }
}

export type OwnerHandoffTargetLaunchOptions = Omit<OwnerHandoffTargetSupervisorOptions, "transport"> &
  OwnerHandoffTargetProcessOptions;

/** Spawn the restricted successor and return its readiness-gating supervisor. */
export function launchOwnerHandoffTarget(
  options: OwnerHandoffTargetLaunchOptions,
): OwnerHandoffTargetSupervisor {
  const { binaryPath, dataDir, env, onStderr, ...supervisor } = options;
  const transport = new OwnerHandoffTargetProcess({ binaryPath, dataDir, profileId: options.profileId, env, onStderr });
  return new OwnerHandoffTargetSupervisor({ ...supervisor, transport });
}
