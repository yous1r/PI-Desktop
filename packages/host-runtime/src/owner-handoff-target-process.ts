import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  OWNER_HANDOFF_MAX_RECORD_BYTES,
  OWNER_HANDOFF_REVISION_MAX,
  parseOwnerHandoffBootstrapCommand,
  parseOwnerHandoffReady,
  parseOwnerHandoffResponse,
  rpcTimeoutMs,
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
  type OwnerHandoffTargetNotification,
  type OwnerHandoffTargetNotificationHandler,
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

/** Bounded post-Ready RPC concurrency; excess calls reject instead of queueing. */
export const OWNER_HANDOFF_TARGET_RPC_MAX_INFLIGHT = 32;
/** Bounded unsolicited notification retention while no observer is attached. */
export const OWNER_HANDOFF_TARGET_NOTIFICATION_LIMIT = 64;
export const OWNER_HANDOFF_TARGET_NOTIFICATION_BYTES = 256 * 1024;
/** Largest transport deadline accepted for one post-Ready RPC call. */
export const OWNER_HANDOFF_TARGET_RPC_MAX_TIMEOUT_MS = 900_000;
/** One read may coalesce many maximum-size frames; keep the parser bounded. */
const MAX_BUFFER_BYTES = (OWNER_HANDOFF_MAX_RECORD_BYTES + 4) * 64;

type RpcPending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

function rpcFailure(value: unknown): Error {
  const error = isRecord(value) ? value : {};
  const message = typeof error.message === "string" && error.message.length > 0
    ? error.message : "target RPC failed";
  const failureError = new Error(message) as Error & { code?: number; data?: unknown; errorCode: string };
  if (Number.isInteger(error.code)) failureError.code = error.code as number;
  failureError.data = error.data;
  const data = isRecord(error.data) ? error.data : undefined;
  // Ordinary host RPC preserves the peer's error code, whatever its family.
  failureError.errorCode = data && typeof data.errorCode === "string" &&
    data.errorCode.length > 0 && data.errorCode.length <= 128
    ? data.errorCode : "HANDOFF_TARGET_RPC_ERROR";
  return failureError;
}

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
  /** Post-Ready JSON-RPC state. Only opened by a validated Ready outcome. */
  private rpcOpen = false;
  private rpcCounter = 0;
  private readonly rpcPending = new Map<string, RpcPending>();
  private readonly notifications: OwnerHandoffTargetNotification[] = [];
  private notificationBytes = 0;
  private readonly notificationHandlers = new Set<OwnerHandoffTargetNotificationHandler>();

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
    // Bound the incremental parser across coalesced frames and partial ones.
    if (this.buffer.length > MAX_BUFFER_BYTES) {
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
      if (this.rpcOpen) {
        this.handleRpcFrame(value);
        if (this.failed) return;
        continue;
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
    return this.send(readyBytes(request), timeoutMs, parseOwnerHandoffTargetReadyResponse, true);
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
    return this.send(attachEpochBytes(request), timeoutMs, parseOwnerHandoffTargetReadyResponse, true);
  }

  /**
   * Ordinary JSON-RPC call over the same private framed channel, allowed only
   * after a validated Ready outcome. Responses are correlated by request id;
   * `error` replies reject with their classified `errorCode`. Excess in-flight
   * calls reject instead of queueing without bound.
   */
  rpcCall<T = unknown>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.exited || this.spawnFailed) return Promise.reject(failure("HANDOFF_TRANSPORT_CLOSED"));
    if (!this.rpcOpen) return Promise.reject(failure("HANDOFF_TARGET_RPC_UNAVAILABLE"));
    if (typeof method !== "string" || method.length < 1 || method.length > 256) {
      return Promise.reject(failure("HANDOFF_TARGET_RPC_INVALID_REQUEST"));
    }
    if (this.rpcPending.size >= OWNER_HANDOFF_TARGET_RPC_MAX_INFLIGHT) {
      return Promise.reject(failure("HANDOFF_TARGET_RPC_BUSY"));
    }
    // Mirror the ordinary host: an explicit override wins, otherwise the
    // per-method ceiling applies and a method with no aggregate deadline
    // (e.g. configSync.syncNow) is left to Rust's own request lifetime.
    const timeout = timeoutMs ?? rpcTimeoutMs(method, params);
    if (timeout !== undefined &&
        (!Number.isInteger(timeout) || timeout < 1 || timeout > OWNER_HANDOFF_TARGET_RPC_MAX_TIMEOUT_MS)) {
      return Promise.reject(failure("HANDOFF_TARGET_RPC_INVALID_TIMEOUT"));
    }
    const id = `target-rpc-${(this.rpcCounter += 1)}`;
    let bytes: Buffer;
    try {
      bytes = frame({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      return Promise.reject(failure(error && typeof error === "object" &&
        "errorCode" in error && error.errorCode === "HANDOFF_INVALID_FRAME"
        ? "HANDOFF_TARGET_RPC_TOO_LARGE" : "HANDOFF_TARGET_RPC_INVALID_REQUEST"));
    }
    return new Promise<T>((resolve, reject) => {
      const timer = timeout === undefined ? undefined : setTimeout(() => {
        // A late reply is an unknown id and is ignored; the transport remains
        // usable because Rust may still be serving a later serial request.
        if (this.rpcPending.delete(id)) reject(failure("HANDOFF_TARGET_RPC_TIMEOUT"));
      }, timeout);
      timer?.unref?.();
      this.rpcPending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try {
        this.child.stdin.write(bytes, error => { if (error) this.fail("HANDOFF_TRANSPORT_CLOSED"); });
      } catch {
        this.fail("HANDOFF_TRANSPORT_CLOSED");
      }
    });
  }

  /** Subscribe to post-Ready server notifications; buffered ones replay first. */
  onTargetNotification(handler: OwnerHandoffTargetNotificationHandler): () => void {
    if (this.failed || typeof handler !== "function") return () => undefined;
    this.notificationHandlers.add(handler);
    const queued = this.notifications.splice(0);
    this.notificationBytes = 0;
    for (const notification of queued) {
      if (this.failed) break;
      this.deliverNotification(notification);
    }
    const unsubscribe = () => { this.notificationHandlers.delete(handler); };
    return Object.assign(unsubscribe, { close: unsubscribe });
  }

  /** Drop buffered notifications and every observer without ending the child. */
  closeTargetNotifications(): void {
    this.notificationHandlers.clear();
    this.notifications.length = 0;
    this.notificationBytes = 0;
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

  private send<T>(bytes: Buffer, timeoutMs: number, parse: (value: unknown) => T, opensRpc = false): Promise<T> {
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
            const parsed = parse(value);
            // Flip synchronously: a notification coalesced after Ready in the
            // same stdout chunk must not fall into the handshake frame queue.
            if (opensRpc) this.rpcOpen = true;
            resolve(parsed);
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

  private handleRpcFrame(value: unknown): void {
    if (!isRecord(value)) {
      this.fail("HANDOFF_TARGET_RPC_INVALID_FRAME");
      return;
    }
    const id = value.id;
    if (id !== undefined && id !== null) {
      const key = String(id);
      const pending = this.rpcPending.get(key);
      // Unknown ids are late/foreign replies; they never settle another call.
      if (!pending) return;
      this.rpcPending.delete(key);
      if (pending.timer) clearTimeout(pending.timer);
      if (value.error !== undefined && value.error !== null) {
        pending.reject(rpcFailure(value.error));
        return;
      }
      if (!("result" in value)) {
        pending.reject(failure("HANDOFF_TARGET_RPC_INVALID_RESPONSE"));
        this.fail("HANDOFF_TARGET_RPC_INVALID_RESPONSE");
        return;
      }
      pending.resolve(value.result);
      return;
    }
    if (value.jsonrpc !== "2.0" || typeof value.method !== "string" ||
        value.method.length < 1 || value.method.length > 256) {
      this.fail("HANDOFF_TARGET_RPC_INVALID_FRAME");
      return;
    }
    this.enqueueNotification({ method: value.method, params: value.params });
  }

  private enqueueNotification(notification: OwnerHandoffTargetNotification): void {
    if (this.notificationHandlers.size > 0) {
      this.deliverNotification(notification);
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(notification), "utf8");
    if (this.notifications.length >= OWNER_HANDOFF_TARGET_NOTIFICATION_LIMIT ||
        this.notificationBytes + bytes > OWNER_HANDOFF_TARGET_NOTIFICATION_BYTES) {
      // Overflow is explicit and fail-closed; notifications are never dropped
      // silently while an observer is absent.
      this.fail("HANDOFF_TARGET_NOTIFICATION_OVERFLOW");
      return;
    }
    this.notifications.push(notification);
    this.notificationBytes += bytes;
  }

  private deliverNotification(notification: OwnerHandoffTargetNotification): void {
    for (const handler of [...this.notificationHandlers]) {
      try { handler(notification); }
      catch {
        this.fail("HANDOFF_TARGET_NOTIFICATION_HANDLER_FAILED");
        return;
      }
    }
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
    for (const rpc of this.rpcPending.values()) {
      if (rpc.timer) clearTimeout(rpc.timer);
      rpc.reject(this.failed);
    }
    this.rpcPending.clear();
    this.rpcOpen = false;
    this.frames.length = 0;
    this.closeTargetNotifications();
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
