/**
 * Remote build/run for mirror projects (spec 23 §1).
 *
 * The local root stays the source of truth; this is the one place where a
 * *configured* command (the project's build or run command) runs on the host,
 * inside the mirror's `remotePath`. It is not a general remote shell: one
 * display string, a working directory that can only be the mirror root, and at
 * most one live command per project.
 *
 * Transport is a port (`RemoteRunSpawn`), so ordering, backpressure,
 * cancellation, and the one-run rule are testable without an SSH host.
 * `createSshRemoteRunSpawn` reuses the existing ssh argv builder, single-quote
 * helper, and askpass material. Nothing here writes to the local tree.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { SshTarget } from "../remote/ssh-transport.js";

/**
 * The `@pi-desktop/shared` `ErrorCodes` values this module reports, spelled as a
 * union the way `helper-client.ts` does: mirror code runs against the prebuilt
 * workspace copy of that package, so it must not depend on that build's age.
 */
export type RemoteRunErrorCode =
  | "CONFLICT"
  | "HOST_SHUTTING_DOWN"
  | "INVALID_ARGUMENT"
  | "REMOTE_CONNECTION_FAILED"
  | "REMOTE_PATH_ESCAPE";

/** The two configured commands a mirror project can run on the host. */
export type RemoteRunKind = "build" | "run";

export type RemoteRunStatus = "succeeded" | "failed" | "cancelled";

export type RemoteRunStream = "stdout" | "stderr";

/** Request shape as it arrives from the IPC/preload boundary. */
export type RemoteRunRequest = {
  /** Mirror project the run belongs to; also the one-run-per-project key. */
  projectId: string;
  /** Host the mirror lives on, as the caller resolved it. */
  hostKey: string;
  /** The mirror root on the host; the run's working directory. */
  remotePath: string;
  /** The user's configured display string, executed by the remote shell. */
  command: string;
  kind: RemoteRunKind;
};

/** A validated request; every field has passed `parseRemoteRunRequest`. */
export type RemoteRunTarget = Readonly<RemoteRunRequest>;

/** One ordered piece of output. A chunk boundary is not a line boundary. */
export type RemoteRunChunk = {
  stream: RemoteRunStream;
  text: string;
};

/** The single, final verdict of a run. */
export type RemoteRunOutcome = {
  status: RemoteRunStatus;
  /** Exit status reported by the host, `null` when none was reported. */
  code: number | null;
  kind: RemoteRunKind;
  /** Bytes the host wrote, including output dropped at the memory cap. */
  bytes: number;
  /** True when output beyond the cap was dropped instead of buffered. */
  truncated: boolean;
};

/**
 * What a transport reports. `fail` carries no argument: transport text is never
 * forwarded, because it can quote credentials and the command line (§10.7).
 */
export type RemoteRunHandlers = {
  stdout(chunk: Buffer): void;
  stderr(chunk: Buffer): void;
  exit(code: number | null): void;
  fail(): void;
};

/** The started command on the host; `kill` must be safe to call twice. */
export type RemoteRunProcess = {
  kill(): void;
};

/**
 * Starts `target.command` in `target.remotePath` on the host. A rejection here
 * is replaced with a typed error, because its text may quote the ssh argv.
 */
export type RemoteRunSpawn = (
  target: RemoteRunTarget,
  handlers: RemoteRunHandlers,
) => RemoteRunProcess | Promise<RemoteRunProcess>;

export type RemoteRunHandle = {
  id: string;
  projectId: string;
  hostKey: string;
  kind: RemoteRunKind;
  remotePath: string;
  /** The configured command, as validated (trimmed). */
  command: string;
  /** Output in arrival order; draining it is what frees the memory cap. */
  chunks: AsyncIterable<RemoteRunChunk>;
  /** Settles exactly once; rejects with a typed error when the channel failed. */
  outcome: Promise<RemoteRunOutcome>;
  /** Terminates the remote command; resolves once the handle settled. */
  cancel(): Promise<void>;
};

export type RemoteRunManagerOptions = {
  spawn: RemoteRunSpawn;
  /** Unconsumed output held per run before it is marked `truncated`. */
  maxBufferedBytes?: number;
  /** Id seam for deterministic tests; defaults to `randomUUID`. */
  newId?: () => string;
};

export type RemoteRunManager = {
  /** Rejects when validation fails, a run is already live for the project, or the runner is disposed. */
  start(request: RemoteRunRequest): Promise<RemoteRunHandle>;
  /** Cancels every live run; later `start` calls reject. Safe to call twice. */
  dispose(): Promise<void>;
};

/** Longest accepted `command`; a configured command is one string, not a script. */
export const MAX_REMOTE_RUN_COMMAND_CHARS = 4096;

/** Longest accepted mirror root, matching the helper's own path bound. */
export const MAX_REMOTE_RUN_PATH_CHARS = 4096;

/** Longest accepted `projectId` / `hostKey` label. */
const MAX_LABEL_CHARS = 256;

/**
 * Default cap on output held in memory per run: far more than a transcript
 * renders, small enough that a runaway build cannot grow the main process.
 */
export const DEFAULT_MAX_BUFFERED_OUTPUT_BYTES = 1024 * 1024;

/** Grace period between SIGTERM and SIGKILL of a cancelled channel. */
const CANCEL_GRACE_MS = 5_000;

/** Control characters would reach the remote shell as bytes, not as text. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

type QueuedChunk = RemoteRunChunk & { bytes: number };

/** The typed error every rejection from this module carries. */
function runFailure(message: string, errorCode: RemoteRunErrorCode): Error {
  return Object.assign(new Error(message), { errorCode });
}

function requireLabel(value: unknown, field: string): string {
  const label = typeof value === "string" ? value.trim() : "";
  if (label.length === 0 || label.length > MAX_LABEL_CHARS || CONTROL_CHARS.test(label)) {
    throw runFailure(`The ${field} is not a usable identifier`, "INVALID_ARGUMENT");
  }
  return label;
}

/**
 * An absolute POSIX path that cannot change the command it prefixes. `..` is
 * refused rather than normalised: the mirror root is recorded project data, and
 * a value that climbs means the stored binding is not what we think it is.
 */
export function validateRemoteRunPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REMOTE_RUN_PATH_CHARS) {
    throw runFailure("The mirror remote path is not an absolute POSIX path", "INVALID_ARGUMENT");
  }
  if (CONTROL_CHARS.test(value) || value.includes("\\")) {
    throw runFailure("The mirror remote path contains a refused character", "REMOTE_PATH_ESCAPE");
  }
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw runFailure("The mirror remote path must be an absolute POSIX path", "INVALID_ARGUMENT");
  }
  for (const segment of value.split("/")) {
    if (segment === "..") {
      throw runFailure("The mirror remote path must not contain '..'", "REMOTE_PATH_ESCAPE");
    }
  }
  return value;
}

/** The configured command as a remote shell would receive it. */
export function validateRemoteRunCommand(value: unknown): string {
  if (typeof value !== "string") {
    throw runFailure("The run command must be a string", "INVALID_ARGUMENT");
  }
  const command = value.trim();
  if (command.length === 0) {
    throw runFailure("The run command must not be empty", "INVALID_ARGUMENT");
  }
  if (command.length > MAX_REMOTE_RUN_COMMAND_CHARS) {
    throw runFailure(
      `The run command must be at most ${MAX_REMOTE_RUN_COMMAND_CHARS} characters`,
      "INVALID_ARGUMENT",
    );
  }
  // A newline or NUL in a configured command is never intentional and would let
  // one setting become two commands.
  if (CONTROL_CHARS.test(command)) {
    throw runFailure("The run command must not contain control characters", "INVALID_ARGUMENT");
  }
  return command;
}

function requireKind(value: unknown): RemoteRunKind {
  if (value !== "build" && value !== "run") {
    throw runFailure("The run kind must be 'build' or 'run'", "INVALID_ARGUMENT");
  }
  return value;
}

/** Validate a request before anything touches the host. */
export function parseRemoteRunRequest(request: RemoteRunRequest): RemoteRunTarget {
  if (typeof request !== "object" || request === null) {
    throw runFailure("The run request is not usable", "INVALID_ARGUMENT");
  }
  return {
    projectId: requireLabel(request.projectId, "project id"),
    hostKey: requireLabel(request.hostKey, "host key"),
    remotePath: validateRemoteRunPath(request.remotePath),
    command: validateRemoteRunCommand(request.command),
    kind: requireKind(request.kind),
  };
}

/**
 * One run: buffering, the memory cap, and the settle-once lifecycle. Not
 * exported because `start` owns the invariants a caller must not skip.
 */
class MirrorRun implements RemoteRunHandle {
  readonly id: string;
  readonly projectId: string;
  readonly hostKey: string;
  readonly kind: RemoteRunKind;
  readonly remotePath: string;
  readonly command: string;
  readonly chunks: AsyncIterable<RemoteRunChunk>;
  readonly outcome: Promise<RemoteRunOutcome>;

  /** Called once, when the run settles, so the manager can free its slot. */
  onSettled: () => void = () => undefined;

  private readonly maxBufferedBytes: number;
  private readonly decoders: Record<RemoteRunStream, StringDecoder> = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  private readonly queue: QueuedChunk[] = [];
  private readonly waiters: (() => void)[] = [];
  private readonly settled: Promise<void>;
  private resolveOutcome: (outcome: RemoteRunOutcome) => void = () => undefined;
  private rejectOutcome: (error: Error) => void = () => undefined;
  private resolveSettled: () => void = () => undefined;
  private process: RemoteRunProcess | null = null;
  private bufferedBytes = 0;
  private outputBytes = 0;
  private truncated = false;
  private cancelRequested = false;
  private closed = false;
  private failure: Error | null = null;
  private killTimer: NodeJS.Timeout | null = null;

  constructor(target: RemoteRunTarget, options: { id: string; maxBufferedBytes: number }) {
    this.id = options.id;
    this.projectId = target.projectId;
    this.hostKey = target.hostKey;
    this.kind = target.kind;
    this.remotePath = target.remotePath;
    this.command = target.command;
    this.maxBufferedBytes = options.maxBufferedBytes;
    this.outcome = new Promise<RemoteRunOutcome>((resolve, reject) => {
      this.resolveOutcome = resolve;
      this.rejectOutcome = reject;
    });
    // A caller that awaits only `outcome` after the fact must not turn a
    // transport failure into an unhandled rejection in the meantime.
    void this.outcome.catch(() => undefined);
    this.settled = new Promise<void>((resolve) => {
      this.resolveSettled = resolve;
    });
    const iterator = this.iterate();
    this.chunks = { [Symbol.asyncIterator]: () => iterator };
  }

  /** The transport-facing callbacks for this run. */
  handlers(): RemoteRunHandlers {
    return {
      stdout: (chunk) => this.accept("stdout", chunk),
      stderr: (chunk) => this.accept("stderr", chunk),
      exit: (code) => this.finish(code),
      fail: () => this.fail(runFailure("The remote run channel failed", "REMOTE_CONNECTION_FAILED")),
    };
  }

  attach(process: RemoteRunProcess): void {
    this.process = process;
    // A cancel that arrived while the channel was still being created must
    // still reach the command that has just started.
    if (this.cancelRequested && !this.closed) this.kill();
  }

  /** The channel never started; nothing runs on the host. */
  settleFailure(error: Error): void {
    this.fail(error);
  }

  async cancel(): Promise<void> {
    if (!this.closed && !this.cancelRequested) {
      this.cancelRequested = true;
      if (this.process) this.kill();
      else this.finish(null);
    }
    await this.settled;
  }

  private kill(): void {
    const running = this.process;
    if (!running) return;
    try {
      running.kill();
    } catch {
      // The channel already went away; the exit path owns the settlement.
    }
    // A remote command that ignores the closed channel must not hang the app.
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (!this.closed) this.finish(null);
    }, CANCEL_GRACE_MS);
    this.killTimer.unref();
  }

  private accept(stream: RemoteRunStream, chunk: Buffer): void {
    if (this.closed) return;
    this.outputBytes += chunk.length;
    this.retain(stream, this.decoders[stream].write(chunk));
  }

  private retain(stream: RemoteRunStream, text: string): void {
    if (this.closed || text.length === 0) return;
    const bytes = Buffer.byteLength(text, "utf8");
    // Once the cap is reached the rest of the run is dropped, not buffered: the
    // caller keeps what arrived first and sees `truncated` instead of the app
    // holding an unbounded build log.
    if (this.truncated || this.bufferedBytes + bytes > this.maxBufferedBytes) {
      this.truncated = true;
      return;
    }
    this.bufferedBytes += bytes;
    this.queue.push({ stream, text, bytes });
    this.wake();
  }

  private finish(code: number | null): void {
    if (this.closed) return;
    // A chunk can end mid-character; the decoder holds the tail.
    this.retain("stdout", this.decoders.stdout.end());
    this.retain("stderr", this.decoders.stderr.end());
    const status: RemoteRunStatus = this.cancelRequested ? "cancelled" : code === 0 ? "succeeded" : "failed";
    this.close();
    this.resolveOutcome({
      status,
      code,
      kind: this.kind,
      bytes: this.outputBytes,
      truncated: this.truncated,
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.failure = error;
    this.close();
    this.rejectOutcome(error);
  }

  private close(): void {
    this.closed = true;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    this.onSettled();
    this.resolveSettled();
    this.wake();
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  private waitForOutput(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private async *iterate(): AsyncGenerator<RemoteRunChunk, void, undefined> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        this.bufferedBytes -= next.bytes;
        yield { stream: next.stream, text: next.text };
        continue;
      }
      if (this.closed) {
        if (this.failure) throw this.failure;
        return;
      }
      await this.waitForOutput();
    }
  }
}

export function createRemoteRunManager(options: RemoteRunManagerOptions): RemoteRunManager {
  const { spawn: spawnRun } = options;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_OUTPUT_BYTES;
  const newId = options.newId ?? (() => randomUUID());
  const active = new Map<string, MirrorRun>();
  let disposing: Promise<void> | null = null;

  return {
    async start(request) {
      const target = parseRemoteRunRequest(request);
      if (disposing) {
        throw runFailure("The remote runner is shutting down", "HOST_SHUTTING_DOWN");
      }
      if (active.has(target.projectId)) {
        throw runFailure("A build or run is already active for this project", "CONFLICT");
      }
      const run = new MirrorRun(target, { id: newId(), maxBufferedBytes });
      // The slot is reserved before the first await, so a second start in the
      // same tick rejects instead of racing into a second remote process.
      active.set(target.projectId, run);
      run.onSettled = () => {
        if (active.get(target.projectId) === run) active.delete(target.projectId);
      };
      try {
        run.attach(await spawnRun(target, run.handlers()));
      } catch {
        // Whatever the transport said is replaced: an ssh error can quote the
        // command line, and a credential helper can quote its own material.
        const error = runFailure(
          "The remote run channel could not be started",
          "REMOTE_CONNECTION_FAILED",
        );
        run.settleFailure(error);
        throw error;
      }
      return run;
    },
    dispose() {
      disposing ??= (async () => {
        const runs = [...active.values()];
        active.clear();
        await Promise.all(runs.map((run) => run.cancel()));
      })();
      return disposing;
    },
  };
}

export type SshRemoteRunSpawnOptions = {
  /** `ssh` executable; defaults to `ssh` on PATH. Tests point it at a fixture. */
  binary?: string;
};

function startSsh(binary: string, args: string[], env: NodeJS.ProcessEnv | undefined) {
  try {
    return spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env });
  } catch {
    throw runFailure("The ssh client could not be started", "REMOTE_CONNECTION_FAILED");
  }
}

/**
 * The production spawn: the existing ssh transport's argv, one command string,
 * streamed stdout/stderr. The command runs the way every other remote-host
 * command in this app does — one string interpreted by the remote user's shell
 * — and the mirror root is quoted with the transport's own `shellQuote`, so
 * there is one quoting scheme. The caller resolves `hostKey` to `target`, so a
 * leaked key cannot redirect a run.
 */
export async function createSshRemoteRunSpawn(
  target: SshTarget,
  options: SshRemoteRunSpawnOptions = {},
): Promise<RemoteRunSpawn> {
  const [{ sshCommonArgs }, { shellQuote }, { createSshAskpass }] = await Promise.all([
    import("../remote/ssh-transport.js"),
    import("../remote/pi-host-bootstrap-script.js"),
    import("../remote/ssh-askpass.js"),
  ]);
  const binary = options.binary ?? "ssh";
  return async (input, handlers) => {
    const command = `cd ${shellQuote(input.remotePath)} && ${input.command}`;
    // Password mode keeps the transport's own credential path: the secret goes
    // to the askpass helper, never to the argv, and is removed as soon as this
    // child is gone.
    const material = target.password === undefined ? null : await createSshAskpass(target.password);
    const args = [...sshCommonArgs(target), command];
    const env = material ? { ...process.env, ...material.env } : undefined;
    const child = await (async () => {
      try {
        return startSsh(binary, args, env);
      } catch (error) {
        await material?.dispose().catch(() => undefined);
        throw error;
      }
    })();
    const releaseMaterial = (): void => {
      if (material) void material.dispose().catch(() => undefined);
    };
    let killTimer: NodeJS.Timeout | null = null;
    child.stdout?.on("data", (chunk: Buffer) => handlers.stdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => handlers.stderr(chunk));
    child.once("error", () => {
      releaseMaterial();
      handlers.fail();
    });
    child.once("close", (code: number | null) => {
      if (killTimer) clearTimeout(killTimer);
      killTimer = null;
      releaseMaterial();
      handlers.exit(code);
    });
    let killed = false;
    return {
      kill() {
        if (killed) return;
        killed = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), CANCEL_GRACE_MS);
        killTimer.unref();
      },
    };
  };
}
