import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import type { BrowserWindow } from "electron";

import { ErrorCodes, IPC, parseTerminalEnv, parseTerminalLaunchArgs } from "@pi-desktop/shared";
import type { TerminalOpenResult, TerminalSettings, TerminalShellProfile } from "@pi-desktop/shared";

/**
 * Launch overrides applied on top of a shell profile. Both come from
 * `AppSettings.terminal`: `launchArgs` is appended after the profile's own
 * argv so a shell's required flags stay in front of user extras.
 */
export type TerminalLaunchOverrides = Pick<TerminalSettings, "launchArgs" | "env">;

/**
 * The subset of `node-pty` this service uses. Declared here so the module can
 * be imported in tests and on machines where the native optional dependency
 * is absent; the package is loaded lazily at first terminal creation.
 */
export type PtyProcess = {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
};

export type PtyModule = {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
  ): PtyProcess;
};

type TerminalRecord = {
  id: string;
  shellId: string;
  pty: PtyProcess;
  cols: number;
  rows: number;
  /** Bounded replay ring, newest last; powers `terminalGetBuffer`. */
  ring: Buffer[];
  ringBytes: number;
  exited: boolean;
  disposeData: () => void;
  disposeExit: () => void;
};

export const TERMINAL_RING_BYTES = 256 * 1024;
export const TERMINAL_BUFFER_DEFAULT_BYTES = 32 * 1024;
export const TERMINAL_MAX_PER_WINDOW = 8;

export type TerminalServiceOptions = {
  getWindow: () => BrowserWindow | null;
  /** Resolved lazily so a missing native module surfaces as a typed error. */
  loadPty?: () => PtyModule | null;
  ringBytes?: number;
  maxTerminals?: number;
  log?: (level: "info" | "warn", message: string, data?: Record<string, unknown>) => void;
};

function loadPtyFromNodeModules(): PtyModule | null {
  try {
    const require = createRequire(import.meta.url);
    return require("node-pty") as PtyModule;
  } catch {
    return null;
  }
}

/**
 * Environment variables the app keeps to itself. A shell started from the panel
 * is a user-facing process: anything holding credentials (`PI_DESKTOP_PROXY_JSON`
 * carries a proxied URL with userinfo) must not be readable by `env`/`echo`.
 */
export function shellEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith("PI_DESKTOP_")) continue;
    env[key] = value;
  }
  env.TERM = "xterm-256color";
  return env;
}

/** Strip ANSI/VT escape sequences so diagnostics stay readable as plain text. */
export function stripAnsiCodes(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/**
 * Trim `bytes` to at most `limit` bytes from the end without splitting a UTF-8
 * sequence: a cut inside a multi-byte code point would surface as U+FFFD in the
 * replay buffer.
 */
function tailWithin(bytes: Buffer, limit: number): Buffer {
  if (bytes.length <= limit) return bytes;
  let start = bytes.length - limit;
  // 0b10xxxxxx marks a continuation byte; walk forward to the next lead byte.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start);
}

/**
 * PTY lifecycle for the work-panel terminal. One service per main process;
 * output flows to the renderer over `IPC.event.terminalData` and the bounded
 * ring per terminal backs both replay-after-reconnect and the
 * `terminalGetBuffer` diagnostics read.
 */
export class TerminalService {
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly ringBytes: number;
  private readonly maxTerminals: number;
  private readonly options: TerminalServiceOptions;
  private ptyModule: PtyModule | null | undefined;
  /** Set once shutdown starts so no new PTY can be spawned into a closing app. */
  private sealed = false;

  constructor(options: TerminalServiceOptions) {
    this.options = options;
    this.ringBytes = options.ringBytes ?? TERMINAL_RING_BYTES;
    this.maxTerminals = options.maxTerminals ?? TERMINAL_MAX_PER_WINDOW;
  }

  private get pty(): PtyModule | null {
    if (this.ptyModule === undefined) {
      // An injected loader owns the answer, including "unavailable": only the
      // absence of a loader falls back to the optional native dependency.
      this.ptyModule = this.options.loadPty
        ? this.options.loadPty()
        : loadPtyFromNodeModules();
    }
    return this.ptyModule;
  }

  private emit(channel: string, payload: Record<string, unknown>): void {
    const window = this.options.getWindow();
    if (!window || window.isDestroyed()) return;
    const contents = window.webContents;
    if (!contents || contents.isDestroyed()) return;
    try {
      contents.send(channel, payload);
    } catch {
      // The renderer went away between the check and the send.
    }
  }

  list(): { id: string; shellId: string; cols: number; rows: number }[] {
    return [...this.terminals.values()].map(({ id, shellId, cols, rows }) => ({ id, shellId, cols, rows }));
  }

  create(
    profile: TerminalShellProfile,
    cwd: string | undefined,
    size: { cols: number; rows: number },
    overrides?: TerminalLaunchOverrides,
  ): TerminalOpenResult {
    if (this.sealed) {
      throw Object.assign(new Error("terminal service is shutting down"), { errorCode: ErrorCodes.INTERNAL });
    }
    if (this.terminals.size >= this.maxTerminals) {
      throw Object.assign(new Error(`terminal limit reached (${this.maxTerminals})`), { errorCode: ErrorCodes.RATE_LIMITED });
    }
    const ptyModule = this.pty;
    if (!ptyModule) {
      throw Object.assign(new Error("node-pty is unavailable in this build"), { errorCode: ErrorCodes.INTERNAL });
    }
    const cols = Math.max(2, Math.min(500, Math.floor(size.cols)));
    const rows = Math.max(2, Math.min(300, Math.floor(size.rows)));
    // User extras follow the profile's own argv; the env block is layered over
    // the sanitized environment, so it can add variables but never re-expose a
    // `PI_DESKTOP_*` value `shellEnv` withheld.
    const args = [...(profile.args ?? []), ...parseTerminalLaunchArgs(overrides?.launchArgs)];
    const env = { ...shellEnv(process.env), ...parseTerminalEnv(overrides?.env) };
    let pty: PtyProcess;
    try {
      pty = ptyModule.spawn(profile.path, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: cwd && cwd.trim() ? cwd : process.cwd(),
        env,
      });
    } catch {
      // The message can embed an absolute install path; keep it in the log and
      // hand the renderer a stable, path-free code.
      this.options.log?.("warn", "terminal spawn failed", { shellId: profile.id });
      throw Object.assign(new Error(`failed to start ${profile.id}`), { errorCode: ErrorCodes.INTERNAL });
    }
    const record: TerminalRecord = {
      id: `term_${randomUUID()}`,
      shellId: profile.id,
      pty,
      cols,
      rows,
      ring: [],
      ringBytes: 0,
      exited: false,
      disposeData: () => {},
      disposeExit: () => {},
    };
    this.terminals.set(record.id, record);
    try {
      const dataHandle = pty.onData((data) => {
        if (record.exited) return;
        // The ring keeps a bounded copy; the live event always carries the whole
        // chunk so the terminal never renders a truncated frame.
        const bytes = Buffer.from(data, "utf8");
        record.ring.push(tailWithin(bytes, this.ringBytes));
        record.ringBytes = record.ring.reduce((total, entry) => total + entry.length, 0);
        while (record.ringBytes > this.ringBytes && record.ring.length > 1) {
          const dropped = record.ring.shift();
          if (!dropped) break;
          record.ringBytes -= dropped.length;
        }
        this.emit(IPC.event.terminalData, { terminalId: record.id, data: bytes.toString("base64") });
      });
      record.disposeData = () => dataHandle.dispose();
      const exitHandle = pty.onExit(({ exitCode }) => {
        if (record.exited) return;
        record.exited = true;
        this.terminals.delete(record.id);
        record.disposeData();
        record.disposeExit();
        this.emit(IPC.event.terminalExit, { terminalId: record.id, exitCode });
        this.options.log?.("info", "terminal exited", { terminalId: record.id, exitCode });
      });
      record.disposeExit = () => exitHandle.dispose();
    } catch (error) {
      // Registration itself failed: without this the child would outlive the
      // record and never be reachable again.
      record.exited = true;
      this.terminals.delete(record.id);
      try {
        pty.kill();
      } catch {
        // Already gone.
      }
      this.options.log?.("warn", "terminal listener registration failed", { shellId: profile.id });
      throw Object.assign(new Error(`failed to start ${profile.id}`), {
        errorCode: ErrorCodes.INTERNAL,
        cause: error,
      });
    }
    this.options.log?.("info", "terminal opened", { terminalId: record.id, shellId: profile.id, pid: pty.pid });
    return { terminalId: record.id, shellId: profile.id, cols, rows };
  }

  write(terminalId: string, data: string): void {
    const record = this.require(terminalId);
    try {
      record.pty.write(data);
    } catch (error) {
      // The child can die between the liveness check and the write; the exit
      // event already reached the renderer, so a keystroke must not become an
      // unhandled IPC rejection.
      throw Object.assign(new Error(`terminal ${terminalId} is not writable`), {
        errorCode: ErrorCodes.NOT_FOUND,
        cause: error,
      });
    }
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const record = this.require(terminalId);
    const safeCols = Math.max(2, Math.min(500, Math.floor(cols)));
    const safeRows = Math.max(2, Math.min(300, Math.floor(rows)));
    record.cols = safeCols;
    record.rows = safeRows;
    try {
      record.pty.resize(safeCols, safeRows);
    } catch {
      // Resizing a terminal that is already gone is a no-op, not a failure.
    }
  }

  close(terminalId: string): void {
    const record = this.terminals.get(terminalId);
    if (!record) return;
    // Mark first: the listeners check `exited`, so neither a late data chunk nor
    // the exit that this kill provokes can reach a renderer that already closed
    // the tab.
    record.exited = true;
    this.terminals.delete(terminalId);
    record.disposeData();
    record.disposeExit();
    try {
      record.pty.kill();
    } catch {
      // Already gone.
    }
  }

  /** Plain-text tail of the replay ring, ANSI sequences stripped. */
  getBuffer(terminalId: string, maxBytes = TERMINAL_BUFFER_DEFAULT_BYTES): string {
    const record = this.terminals.get(terminalId);
    if (!record) return "";
    const whole = Buffer.concat(record.ring);
    const limit = Math.max(1, Math.floor(maxBytes));
    return stripAnsiCodes(tailWithin(whole, limit).toString("utf8"));
  }

  /**
   * Raw replay for a renderer that re-attaches to a terminal which kept running
   * while its tab was unmounted. Base64 of the ring bytes with ANSI sequences
   * intact: the caller feeds them straight into xterm, and the stripped
   * `getBuffer` form would lose colors, cursor position, and clear-screen.
   *
   * `null` means the terminal is unknown or already exited, which the caller
   * must tell apart from "still alive, no output yet".
   */
  replay(terminalId: string, maxBytes = TERMINAL_RING_BYTES): string | null {
    const record = this.terminals.get(terminalId);
    if (!record || record.exited) return null;
    const whole = Buffer.concat(record.ring);
    const limit = Math.max(1, Math.floor(maxBytes));
    return tailWithin(whole, limit).toString("base64");
  }

  /** Whether a terminal is still running, without touching its output. */
  isAlive(terminalId: string): boolean {
    const record = this.terminals.get(terminalId);
    return record !== undefined && !record.exited;
  }
  /**
   * Kills every open PTY without sealing the service. The main window closing
   * is not the app exiting: under `closeBehavior: "tray"` a new window can open
   * and create terminals again.
   */
  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }

  /** Kills every PTY and refuses further creation; used on app shutdown. */
  dispose(): void {
    this.sealed = true;
    this.closeAll();
  }

  private require(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (!record || record.exited) {
      throw Object.assign(new Error(`terminal ${terminalId} is not open`), { errorCode: ErrorCodes.NOT_FOUND });
    }
    return record;
  }
}
