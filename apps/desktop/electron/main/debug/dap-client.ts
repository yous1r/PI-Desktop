/**
 * Debug Adapter Protocol (DAP) Client and Session Model for Electron Main.
 *
 * Implements:
 * - TCP socket communication with incremental framing codec (dap-framing.ts)
 * - Sequence number generation starting from 1
 * - Request/response correlation by request_seq with timeout settlement
 * - Rejection on error or socket close with zero leaks
 * - Bounded memory: max message size, request timeout, max concurrent pending requests
 * - Path mapping integration (dap-paths.ts) with unmapped paths marked read-only
 * - DAP protocol operations: initialize, setBreakpoints, setExceptionBreakpoints,
 *   configurationDone, threads, stackTrace, scopes, variables, continue, next,
 *   stepIn, stepOut, pause, disconnect
 * - Event attachments: stopped, continued, output, terminated, exited
 * - Full session lifecycle and SSH forward closure
 */

import { EventEmitter } from "node:events";
import { createConnection, type Socket } from "node:net";
import {
  DapDecoder,
  encodeDapMessage,
  type DapEvent,
  type DapMessage,
  type DapRequest,
  type DapResponse,
} from "./dap-framing.ts";
import {
  type DapPathMapping,
  type DapSource,
  mapLocalToRemote,
  translateRemoteSource,
} from "./dap-paths.ts";

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_PENDING_REQUESTS = 100;

export type DapSessionState =
  | "unconnected"
  | "connecting"
  | "connected"
  | "initialized"
  | "configured"
  | "running"
  | "stopped"
  | "disconnected";

export type SshForwardHandle = {
  localPort: number;
  close(): Promise<void>;
};

export type DapClientOptions = {
  port?: number;
  host?: string;
  forward?: SshForwardHandle;
  pathMappings?: DapPathMapping[];
  defaultTimeoutMs?: number;
  maxPendingRequests?: number;
};

export type DapInitializeArgs = {
  clientID?: string;
  clientName?: string;
  adapterID?: string;
  pathFormat?: string;
  linesStartAt1?: boolean;
  columnsStartAt1?: boolean;
  supportsVariableType?: boolean;
  supportsVariablePaging?: boolean;
  supportsRunInTerminalRequest?: boolean;
  pathMappings?: DapPathMapping[];
  [key: string]: unknown;
};

export type DapCapabilities = Record<string, unknown>;

export type DapSourceBreakpoint = {
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
};

export type DapSetBreakpointsArgs = {
  source: DapSource;
  breakpoints?: DapSourceBreakpoint[];
  lines?: number[];
  sourceModified?: boolean;
};

export type DapBreakpoint = {
  id?: number;
  verified: boolean;
  message?: string;
  source?: DapSource;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  instructionReference?: string;
  offset?: number;
};

export type DapSetBreakpointsResult = {
  breakpoints: DapBreakpoint[];
};

export type DapSetExceptionBreakpointsArgs = {
  filters: string[];
  filterOptions?: Array<{ filterId: string; condition?: string }>;
  exceptionOptions?: unknown[];
};

export type DapSetExceptionBreakpointsResult = Record<string, unknown> | undefined;

export type DapConfigurationDoneResult = Record<string, unknown> | undefined;

export type DapThread = {
  id: number;
  name: string;
};

export type DapThreadsResult = {
  threads: DapThread[];
};

export type DapStackTraceArgs = {
  threadId: number;
  startFrame?: number;
  levels?: number;
  format?: unknown;
};

export type DapStackFrame = {
  id: number;
  name: string;
  source?: DapSource;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  instructionPointerReference?: string;
  moduleId?: number | string;
  presentationHint?: "normal" | "label" | "subtle";
};

export type DapStackTraceResult = {
  stackFrames: DapStackFrame[];
  totalFrames?: number;
};

export type DapScopesArgs = {
  frameId: number;
};

export type DapScope = {
  name: string;
  presentationHint?: "arguments" | "locals" | "registers" | string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  expensive: boolean;
  source?: DapSource;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
};

export type DapScopesResult = {
  scopes: DapScope[];
};

export type DapVariablesArgs = {
  variablesReference: number;
  filter?: "indexed" | "named";
  start?: number;
  count?: number;
  format?: unknown;
};

export type DapVariable = {
  name: string;
  value: string;
  type?: string;
  presentationHint?: unknown;
  evaluateName?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  memoryReference?: string;
};

export type DapVariablesResult = {
  variables: DapVariable[];
};

export type DapContinueArgs = {
  threadId: number;
  singleThread?: boolean;
};

export type DapContinueResult = {
  allThreadsContinued?: boolean;
};

export type DapNextArgs = {
  threadId: number;
  singleThread?: boolean;
  granularity?: string;
};

export type DapNextResult = Record<string, unknown> | undefined;

export type DapStepInArgs = {
  threadId: number;
  singleThread?: boolean;
  targetId?: number;
  granularity?: string;
};

export type DapStepInResult = Record<string, unknown> | undefined;

export type DapStepOutArgs = {
  threadId: number;
  singleThread?: boolean;
  granularity?: string;
};

export type DapStepOutResult = Record<string, unknown> | undefined;

export type DapPauseArgs = {
  threadId: number;
};

export type DapPauseResult = Record<string, unknown> | undefined;

export type DapDisconnectArgs = {
  restart?: boolean;
  terminateDebuggee?: boolean;
  suspendDebuggee?: boolean;
};

export type DapStoppedEventBody = {
  reason:
    | "step"
    | "breakpoint"
    | "exception"
    | "pause"
    | "entry"
    | "goto"
    | "function breakpoint"
    | "data breakpoint"
    | "instruction breakpoint"
    | string;
  description?: string;
  threadId?: number;
  preserveFocusHint?: boolean;
  text?: string;
  allThreadsStopped?: boolean;
  hitBreakpointIds?: number[];
};

export type DapContinuedEventBody = {
  threadId: number;
  allThreadsContinued?: boolean;
};

export type DapOutputEventBody = {
  category?: "console" | "stdout" | "stderr" | "telemetry" | string;
  output: string;
  variablesReference?: number;
  source?: DapSource;
  line?: number;
  column?: number;
  data?: unknown;
};

export type DapTerminatedEventBody = {
  restart?: unknown;
};

export type DapExitedEventBody = {
  exitCode: number;
};

type PendingEntry<T = unknown> = {
  seq: number;
  command: string;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * Typed Debug Adapter Protocol Client.
 */
export class DapClient extends EventEmitter {
  private socket: Socket | null = null;
  private decoder = new DapDecoder();
  private nextSeq = 1;
  private pending = new Map<number, PendingEntry<any>>();
  private pathMappings: DapPathMapping[] = [];
  private forward: SshForwardHandle | null = null;
  private state: DapSessionState = "unconnected";
  private connected = false;
  private disposed = false;
  private defaultTimeoutMs: number;
  private maxPendingRequests: number;
  private lastStoppedThreadId?: number;

  constructor(options: DapClientOptions = {}) {
    super();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxPendingRequests = options.maxPendingRequests ?? MAX_PENDING_REQUESTS;
    if (options.pathMappings) {
      this.pathMappings = [...options.pathMappings];
    }
    if (options.forward) {
      this.forward = options.forward;
    }
  }

  get currentState(): DapSessionState {
    return this.state;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  getPathMappings(): DapPathMapping[] {
    return [...this.pathMappings];
  }

  setPathMappings(mappings: DapPathMapping[]): void {
    this.pathMappings = [...mappings];
  }

  /**
   * Connects the DAP client to a local port (or via an active SSH forward).
   */
  async connect(options: {
    port?: number;
    host?: string;
    forward?: SshForwardHandle;
    timeoutMs?: number;
  } = {}): Promise<void> {
    if (this.connected || this.socket) {
      throw new Error("DAP client is already connected or connecting");
    }

    this.disposed = false;
    this.state = "connecting";

    if (options.forward) {
      this.forward = options.forward;
    }

    const port = options.port ?? this.forward?.localPort;
    if (!port) {
      if (this.forward) {
        await this.forward.close().catch(() => undefined);
        this.forward = null;
      }
      this.state = "unconnected";
      throw new Error("No port or SSH forward provided for DAP connection");
    }

    const host = options.host ?? "127.0.0.1";
    const connectTimeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = async (err?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;

        if (err) {
          this.state = "disconnected";
          if (socket) {
            socket.removeAllListeners();
            socket.destroy();
          }
          this.socket = null;
          if (this.forward) {
            await this.forward.close().catch(() => undefined);
            this.forward = null;
          }
          reject(err);
        } else {
          this.connected = true;
          this.state = "connected";
          resolve();
        }
      };

      timer = setTimeout(() => {
        void finish(
          new Error(
            `Connecting to DAP adapter at ${host}:${port} timed out after ${connectTimeoutMs}ms`
          )
        );
      }, connectTimeoutMs);

      const socket = createConnection({ host, port });
      this.socket = socket;

      const onConnectError = (err: Error) => {
        void finish(
          new Error(
            `Failed to connect to DAP adapter at ${host}:${port}: ${err.message}`
          )
        );
      };

      socket.once("connect", () => {
        socket.off("error", onConnectError);
        this.wireSocket(socket);
        void finish();
      });

      socket.once("error", onConnectError);
    });
  }

  /**
   * Sends a typed request over DAP and correlates the response by request_seq.
   */
  sendRequest<T = Record<string, unknown>>(
    command: string,
    args?: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<T> {
    this.assertConnected();

    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(
        new Error(
          `Maximum concurrent pending DAP requests reached (${this.maxPendingRequests})`
        )
      );
    }

    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
    const seq = this.nextSeq++;

    const request: DapRequest = {
      seq,
      type: "request",
      command,
      arguments: args,
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(seq);
        if (!entry) return;
        this.pending.delete(seq);
        entry.reject(
          new Error(
            `DAP request '${command}' (seq: ${seq}) timed out after ${effectiveTimeout}ms`
          )
        );
      }, effectiveTimeout);

      this.pending.set(seq, {
        seq,
        command,
        resolve: (val: T) => {
          clearTimeout(timer);
          this.pending.delete(seq);
          resolve(val);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          this.pending.delete(seq);
          reject(err);
        },
        timer,
      });

      try {
        const wireBytes = encodeDapMessage(request);
        this.socket!.write(wireBytes);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Initializes the debug adapter.
   */
  async initialize(args: DapInitializeArgs = {}): Promise<DapCapabilities> {
    this.assertConnected();
    if (args.pathMappings) {
      this.pathMappings = [...args.pathMappings];
    }

    const defaultInitArgs: DapInitializeArgs = {
      clientID: "pi-desktop",
      clientName: "PI-Desktop Remote Debugger",
      adapterID: "remote-mirror",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsVariablePaging: true,
      supportsRunInTerminalRequest: false,
      ...args,
    };

    const capabilities = await this.sendRequest<DapCapabilities>(
      "initialize",
      defaultInitArgs
    );
    this.state = "initialized";
    return capabilities;
  }

  /**
   * Sets breakpoints in a source file.
   * Translates local source path to remote path before sending, and maps
   * returned breakpoint locations back to local coordinates.
   */
  async setBreakpoints(args: DapSetBreakpointsArgs): Promise<DapSetBreakpointsResult> {
    this.assertConnected();

    let remotePath = args.source.path;
    if (args.source.path) {
      const mapped = mapLocalToRemote(args.source.path, this.pathMappings);
      if (mapped !== null) {
        remotePath = mapped;
      }
    }

    const wireArgs: DapSetBreakpointsArgs = {
      ...args,
      source: {
        ...args.source,
        path: remotePath,
      },
    };

    const result = await this.sendRequest<DapSetBreakpointsResult>(
      "setBreakpoints",
      wireArgs as Record<string, unknown>
    );

    if (result?.breakpoints) {
      for (const bp of result.breakpoints) {
        if (bp.source) {
          bp.source = translateRemoteSource(bp.source, this.pathMappings);
        }
      }
    }

    return result;
  }

  /**
   * Configures exception breakpoint behavior.
   */
  async setExceptionBreakpoints(
    args: DapSetExceptionBreakpointsArgs
  ): Promise<DapSetExceptionBreakpointsResult> {
    this.assertConnected();
    return this.sendRequest<DapSetExceptionBreakpointsResult>(
      "setExceptionBreakpoints",
      args as Record<string, unknown>
    );
  }

  /**
   * Signals that breakpoint and configuration staging is complete.
   */
  async configurationDone(): Promise<DapConfigurationDoneResult> {
    this.assertConnected();
    const result = await this.sendRequest<DapConfigurationDoneResult>("configurationDone");
    this.state = "configured";
    return result;
  }

  /**
   * Requests the list of active threads.
   */
  async threads(): Promise<DapThreadsResult> {
    this.assertConnected();
    return this.sendRequest<DapThreadsResult>("threads");
  }

  /**
   * Requests stack frames for a thread.
   * Remote source paths are translated to local paths when mapped, or returned
   * as read-only remote sources when unmapped.
   */
  async stackTrace(args: DapStackTraceArgs): Promise<DapStackTraceResult> {
    this.assertConnected();
    const result = await this.sendRequest<DapStackTraceResult>(
      "stackTrace",
      args as Record<string, unknown>
    );

    if (result?.stackFrames) {
      for (const frame of result.stackFrames) {
        if (frame.source) {
          frame.source = translateRemoteSource(frame.source, this.pathMappings);
        }
      }
    }

    return result;
  }

  /**
   * Requests variable scopes for a stack frame.
   */
  async scopes(args: DapScopesArgs): Promise<DapScopesResult> {
    this.assertConnected();
    const result = await this.sendRequest<DapScopesResult>(
      "scopes",
      args as Record<string, unknown>
    );

    if (result?.scopes) {
      for (const scope of result.scopes) {
        if (scope.source) {
          scope.source = translateRemoteSource(scope.source, this.pathMappings);
        }
      }
    }

    return result;
  }

  /**
   * Requests variables for a given variable scope reference.
   */
  async variables(args: DapVariablesArgs): Promise<DapVariablesResult> {
    this.assertConnected();
    return this.sendRequest<DapVariablesResult>(
      "variables",
      args as Record<string, unknown>
    );
  }

  /**
   * Resumes execution of a thread (or all threads).
   */
  async continue(args: DapContinueArgs): Promise<DapContinueResult> {
    this.assertConnected();
    const result = await this.sendRequest<DapContinueResult>(
      "continue",
      args as Record<string, unknown>
    );
    this.state = "running";
    return result;
  }

  /**
   * Steps over to the next statement.
   */
  async next(args: DapNextArgs): Promise<DapNextResult> {
    this.assertConnected();
    return this.sendRequest<DapNextResult>("next", args as Record<string, unknown>);
  }

  /**
   * Steps into a function call.
   */
  async stepIn(args: DapStepInArgs): Promise<DapStepInResult> {
    this.assertConnected();
    return this.sendRequest<DapStepInResult>("stepIn", args as Record<string, unknown>);
  }

  /**
   * Steps out of the current function.
   */
  async stepOut(args: DapStepOutArgs): Promise<DapStepOutResult> {
    this.assertConnected();
    return this.sendRequest<DapStepOutResult>("stepOut", args as Record<string, unknown>);
  }

  /**
   * Suspends execution of a thread.
   */
  async pause(args: DapPauseArgs): Promise<DapPauseResult> {
    this.assertConnected();
    return this.sendRequest<DapPauseResult>("pause", args as Record<string, unknown>);
  }

  /**
   * Resumes or begins running the session after configurationDone.
   */
  async run(threadId?: number): Promise<void> {
    this.assertConnected();
    if (threadId !== undefined) {
      await this.continue({ threadId });
    } else if (this.lastStoppedThreadId !== undefined) {
      await this.continue({ threadId: this.lastStoppedThreadId });
    }
    this.state = "running";
  }

  /**
   * Sends disconnect to the adapter, closes the TCP socket, and terminates
   * the SSH forward. Nothing leaks on error paths.
   */
  async disconnect(args?: DapDisconnectArgs, timeoutMs?: number): Promise<void> {
    if (this.disposed) return;

    if (this.connected && this.socket && !this.socket.destroyed && this.socket.writable) {
      const disconnectTimeout = timeoutMs ?? Math.min(1_000, this.defaultTimeoutMs);
      try {
        await this.sendRequest("disconnect", args as Record<string, unknown>, disconnectTimeout);
      } catch {
        // Ignore disconnect handshake rejection/timeout during teardown
      }
    }

    await this.close();
  }

  /**
   * Closes the socket and SSH forward immediately, rejecting any in-flight requests.
   */
  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.connected = false;
    this.state = "disconnected";

    // Reject all in-flight requests
    const closeError = new Error("DAP client disconnected");
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(closeError);
    }

    // Destroy socket
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    // Close SSH forward
    if (this.forward) {
      try {
        await this.forward.close();
      } catch {
        // Ignore forward close errors
      }
      this.forward = null;
    }

    this.decoder.reset();
  }

  /**
   * Helper to attach to "stopped" events.
   */
  onStopped(listener: (body: DapStoppedEventBody) => void): () => void {
    this.on("stopped", listener);
    return () => this.off("stopped", listener);
  }

  /**
   * Helper to attach to "continued" events.
   */
  onContinued(listener: (body: DapContinuedEventBody) => void): () => void {
    this.on("continued", listener);
    return () => this.off("continued", listener);
  }

  /**
   * Helper to attach to "output" events.
   */
  onOutput(listener: (body: DapOutputEventBody) => void): () => void {
    this.on("output", listener);
    return () => this.off("output", listener);
  }

  /**
   * Helper to attach to "terminated" events.
   */
  onTerminated(listener: (body: DapTerminatedEventBody) => void): () => void {
    this.on("terminated", listener);
    return () => this.off("terminated", listener);
  }

  /**
   * Helper to attach to "exited" events.
   */
  onExited(listener: (body: DapExitedEventBody) => void): () => void {
    this.on("exited", listener);
    return () => this.off("exited", listener);
  }

  private assertConnected(): void {
    if (!this.connected || !this.socket || this.socket.destroyed) {
      throw new Error(`DAP client is not connected (current state: ${this.state})`);
    }
  }

  private wireSocket(socket: Socket): void {
    socket.on("data", (chunk: Buffer) => {
      this.handleIncomingData(chunk);
    });

    socket.on("error", (err: Error) => {
      this.handleSocketError(err);
    });

    socket.on("end", () => {
      this.handleSocketClose();
    });

    socket.on("close", () => {
      this.handleSocketClose();
    });
  }

  private handleIncomingData(chunk: Buffer): void {
    let messages: DapMessage[];
    try {
      messages = this.decoder.push(chunk);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handleSocketError(error);
      return;
    }

    for (const message of messages) {
      this.dispatchMessage(message);
    }
  }

  private dispatchMessage(message: DapMessage): void {
    if (message.type === "response") {
      const response = message as DapResponse;
      const entry = this.pending.get(response.request_seq);
      if (entry) {
        this.pending.delete(response.request_seq);
        clearTimeout(entry.timer);
        if (response.success) {
          entry.resolve(response.body);
        } else {
          entry.reject(
            new Error(response.message || `DAP request '${response.command}' failed`)
          );
        }
      }
    } else if (message.type === "event") {
      const event = message as DapEvent;
      if (event.event === "stopped") {
        this.state = "stopped";
        const body = event.body as DapStoppedEventBody | undefined;
        if (typeof body?.threadId === "number") {
          this.lastStoppedThreadId = body.threadId;
        }
      } else if (event.event === "continued") {
        this.state = "running";
      } else if (event.event === "terminated") {
        this.state = "disconnected";
      }

      // If output event carries a source, translate it
      if (event.event === "output" && event.body?.source) {
        event.body.source = translateRemoteSource(
          event.body.source as DapSource,
          this.pathMappings
        );
      }

      this.emit(event.event, event.body);
      this.emit("event", event);
    }
  }

  private handleSocketError(err: Error): void {
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    }
    void this.close();
  }

  private handleSocketClose(): void {
    if (this.disposed) return;
    const err = new Error("DAP socket closed");
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.emit("close");
    void this.close();
  }
}

/**
 * Creates an unconnected DAP client instance.
 */
export function createDapClient(options?: DapClientOptions): DapClient {
  return new DapClient(options);
}

/**
 * Connects a new DAP client to the specified endpoint or SSH forward.
 */
export async function connectDap(options: DapClientOptions): Promise<DapClient> {
  const client = new DapClient(options);
  await client.connect(options);
  return client;
}
