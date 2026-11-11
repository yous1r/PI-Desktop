import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  OWNER_HANDOFF_MAX_RECORD_BYTES,
  OWNER_HANDOFF_REVISION_MAX,
  parseOwnerHandoffBootstrapCommand,
  parseOwnerHandoffReady,
  parseOwnerHandoffResponse,
  stripProxyEnv,
  type OwnerHandoffReady,
  type OwnerHandoffRecord,
  type OwnerHandoffResponse,
} from "@pi-desktop/shared";
import { confirmChildExit } from "./process-exit-confirmation.js";
import {
  OwnerHandoffTargetSupervisor,
  type OwnerHandoffReadyOutcome,
  type OwnerHandoffTargetAttachEpoch,
  type OwnerHandoffTargetEnvelope,
  type OwnerHandoffTargetLaunch,
  type OwnerHandoffTargetReadyRequest,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ERROR_CODE = /^HANDOFF_[A-Z0-9_]{1,120}$/;

function failure(errorCode: string): Error {
  return Object.assign(new Error(errorCode), { errorCode });
}
function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length < 1 || body.length > OWNER_HANDOFF_MAX_RECORD_BYTES) throw failure("HANDOFF_INVALID_FRAME");
  const bytes = Buffer.alloc(4 + body.length);
  bytes.writeUInt32LE(body.length);
  body.copy(bytes, 4);
  return bytes;
}
function envelopeBytes(request: OwnerHandoffTargetEnvelope): Buffer {
  if (!request || request.version !== 1 || !/^[0-9a-f]{64}$/.test(request.profileId)) {
    throw failure("HANDOFF_INVALID_REQUEST");
  }
  const command = parseOwnerHandoffBootstrapCommand(request.command);
  if (command.operation !== "claim") throw failure("HANDOFF_CLAIM_REQUIRED");
  return frame(request);
}
function readyBytes(request: OwnerHandoffTargetReadyRequest): Buffer {
  if (!request || request.version !== 1 || request.operation !== "ready" ||
      !UUID.test(request.requestId) || !UUID.test(request.transferId) ||
      !UUID.test(request.targetEpoch) || !Number.isInteger(request.expectedRevision) ||
      request.expectedRevision < 1 || request.expectedRevision > OWNER_HANDOFF_REVISION_MAX) {
    throw failure("HANDOFF_INVALID_REQUEST");
  }
  return frame(request);
}
function attachEpochBytes(request: OwnerHandoffTargetAttachEpoch): Buffer {
  if (!request || request.version !== 1 || request.operation !== "attachEpoch" ||
      !UUID.test(request.requestId) || !UUID.test(request.transferId) ||
      !UUID.test(request.targetEpoch) || !Number.isInteger(request.expectedRevision) ||
      request.expectedRevision < 1 || request.expectedRevision > OWNER_HANDOFF_REVISION_MAX ||
      typeof request.eventEpoch !== "string" || request.eventEpoch.length === 0 ||
      request.eventEpoch.length > 256 || request.eventEpoch.includes("\0")) {
    throw failure("HANDOFF_INVALID_REQUEST");
  }
  return frame(request);
}
function parseLaunchFrame(value: unknown): OwnerHandoffTargetLaunch {
  // The supervisor binds the launch frame to the exact claim after this shape
  // check; the transport never interprets the ticket.
  if (!isRecord(value) || value.version !== 1 || value.operation !== "launch-sidecar" ||
      !isRecord(value.ticket)) {
    throw failure("HANDOFF_INVALID_RESPONSE");
  }
  return value as unknown as OwnerHandoffTargetLaunch;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
 * Strict Ready frame: exactly `{version, ready}` or `{version, error:{code}}`.
 * The nested outcome must contain the exact authoritative record and a ready
 * publication bound to it; incidental text never crosses this boundary.
 */
export function parseOwnerHandoffTargetReadyResponse(value: unknown): OwnerHandoffReadyOutcome {
  if (!isRecord(value) || value.version !== 1 || Object.keys(value).length !== 2) {
    throw failure("HANDOFF_INVALID_RESPONSE");
  }
  if ("error" in value) {
    const error = value.error;
    if (!isRecord(error) || Object.keys(error).length !== 1 ||
        typeof error.code !== "string" || !ERROR_CODE.test(error.code)) {
      throw failure("HANDOFF_INVALID_RESPONSE");
    }
    throw failure(error.code);
  }
  const outcome = value.ready;
  if (!isRecord(outcome) || Object.keys(outcome).length !== 2 ||
      !("record" in outcome) || !("ready" in outcome)) {
    throw failure("HANDOFF_INVALID_RESPONSE");
  }
  let record: OwnerHandoffRecord;
  try {
    const parsed = parseOwnerHandoffResponse({ version: 1, record: outcome.record });
    if ("error" in parsed) throw new Error("HANDOFF_INVALID_RESPONSE");
    record = parsed.record;
    parseOwnerHandoffReady(outcome.ready, record);
  } catch {
    throw failure("HANDOFF_INVALID_RESPONSE");
  }
  return { record, ready: outcome.ready as OwnerHandoffReady };
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Original `--owner-target` child over the private framed channel. One claim
 * call and at most one ready call are expected; the transport fails closed on
 * an invalid frame, stream closure or timeout and never looks up a PID it did
 * not spawn.
 */
export class OwnerHandoffTargetProcess implements OwnerHandoffTargetTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  /** Incremental parser buffer: one chunk may hold many frames or partial ones. */
  private buffer = Buffer.alloc(0);
  private pending?: Pending;
  private readonly frames: unknown[] = [];
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
    if (!Buffer.isBuffer(chunk)) {
      this.fail("HANDOFF_INVALID_FRAME");
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // At most one queued unsolicited frame plus a partial frame may be held.
    if (this.buffer.length > (OWNER_HANDOFF_MAX_RECORD_BYTES + 4) * 6) {
      this.fail("HANDOFF_INVALID_FRAME");
      return;
    }
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length < 1 || length > OWNER_HANDOFF_MAX_RECORD_BYTES) {
        this.fail("HANDOFF_INVALID_FRAME");
        return;
      }
      if (this.buffer.length < length + 4) return;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let value: unknown;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
        value = JSON.parse(text);
      } catch {
        this.fail("HANDOFF_INVALID_FRAME");
        return;
      }
      const pending = this.pending;
      if (pending) {
        clearTimeout(pending.timer);
        this.pending = undefined;
        pending.resolve(value);
        continue;
      }
      // The launch-sidecar frame is unsolicited: it can arrive before the
      // supervisor attaches its pending receive. Keep a tiny bounded queue.
      this.frames.push(value);
      if (this.frames.length > 4) {
        this.fail("HANDOFF_INVALID_FRAME");
        return;
      }
    }
  };

  private readonly onClosed = (): void => { this.fail("HANDOFF_TRANSPORT_CLOSED"); };
  private readonly onProcessError = (): void => {
    this.spawnFailed = this.child.pid === undefined;
    this.fail("HANDOFF_TRANSPORT_CLOSED");
  };
  private readonly onExit = (): void => { this.exited = true; };

  call(request: OwnerHandoffTargetEnvelope, timeoutMs = 15_000): Promise<OwnerHandoffResponse> {
    return this.send(envelopeBytes(request), timeoutMs, parseOwnerHandoffResponse);
  }

  ready(request: OwnerHandoffTargetReadyRequest, timeoutMs = 30_000): Promise<OwnerHandoffReadyOutcome> {
    return this.send(readyBytes(request), timeoutMs, parseOwnerHandoffTargetReadyResponse);
  }

  /** Wait for the unsolicited launch-sidecar frame after the claim receipt. */
  receiveLaunch(timeoutMs = 30_000): Promise<OwnerHandoffTargetLaunch> {
    return this.awaitFrame(timeoutMs, parseLaunchFrame);
  }

  /** Send the live hub epoch and receive the committed ReadyOutcome. */
  attachEpoch(
    request: OwnerHandoffTargetAttachEpoch,
    timeoutMs = 30_000,
  ): Promise<OwnerHandoffReadyOutcome> {
    return this.send(attachEpochBytes(request), timeoutMs, parseOwnerHandoffTargetReadyResponse);
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

  private awaitFrame<T>(timeoutMs: number, parse: (value: unknown) => T): Promise<T> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      return Promise.reject(new RangeError("handoff timeout must be an integer from 1 to 30000 ms"));
    }
    if (this.failed) return Promise.reject(this.failed);
    if (this.exited || this.spawnFailed) {
      return Promise.reject(failure("HANDOFF_TRANSPORT_CLOSED"));
    }
    if (this.frames.length > 0) {
      const value = this.frames.shift();
      try {
        return Promise.resolve(parse(value));
      } catch (error) {
        this.failed = error instanceof Error ? error : failure("HANDOFF_INVALID_FRAME");
        return Promise.reject(error);
      }
    }
    if (this.pending) return Promise.reject(failure("HANDOFF_CHANNEL_BUSY"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("HANDOFF_IO_TIMEOUT"), timeoutMs);
      timer.unref?.();
      this.pending = {
        resolve: (value) => {
          try {
            resolve(parse(value));
          } catch (error) {
            this.failed = error instanceof Error ? error : failure("HANDOFF_INVALID_FRAME");
            reject(error);
          }
        },
        reject,
        timer,
      };
    });
  }

  private send<T>(bytes: Buffer, timeoutMs: number, parse: (value: unknown) => T): Promise<T> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      return Promise.reject(new RangeError("handoff timeout must be an integer from 1 to 30000 ms"));
    }
    if (this.failed) return Promise.reject(this.failed);
    if (this.exited || this.spawnFailed) {
      return Promise.reject(failure("HANDOFF_TRANSPORT_CLOSED"));
    }
    if (this.pending) return Promise.reject(failure("HANDOFF_CHANNEL_BUSY"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("HANDOFF_IO_TIMEOUT"), timeoutMs);
      timer.unref?.();
      this.pending = {
        resolve: (value) => {
          try {
            resolve(parse(value));
          } catch (error) {
            // An unparsable reply poisons this ambiguous transport; a later
            // call must never be matched against another frame.
            this.failed = error instanceof Error ? error : failure("HANDOFF_INVALID_FRAME");
            reject(error);
          }
        },
        reject,
        timer,
      };
      try {
        this.child.stdin.write(bytes, (error) => {
          if (error) this.fail("HANDOFF_TRANSPORT_CLOSED");
        });
      } catch {
        this.fail("HANDOFF_TRANSPORT_CLOSED");
      }
    });
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
    this.buffer = Buffer.alloc(0);
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
