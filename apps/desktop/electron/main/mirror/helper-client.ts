import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

const CONTROL_FRAME = 0x01;
const DATA_FRAME = 0x02;
const END_FRAME = 0x03;
const STREAM_HEADER_BYTES = 4;
const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;

/** Per-file transfer ceiling from spec 23 section 6.3, enforced on both sides. */
export const MAX_TRANSFER_BYTES = 50 * 1024 * 1024;
/** DATA payload size: comfortably below the 1 MiB frame cap. */
export const TRANSFER_CHUNK_BYTES = 64 * 1024;
/** Streaming operations legitimately outlive a control round trip. */
export const DEFAULT_TRANSFER_TIMEOUT_MS = MAX_TIMEOUT_MS;

export type HelperErrorCode =
  | "HELPER_AUTH_FAILED"
  | "HELPER_INTERNAL_ERROR"
  | "HELPER_OPERATION_UNAVAILABLE"
  | "HELPER_PROTOCOL_ERROR"
  | "HELPER_START_FAILED"
  | "HELPER_VERSION_MISMATCH"
  | "MIRROR_FILE_TOO_LARGE"
  | "REMOTE_PATH_ESCAPE"
  | "REMOTE_TRANSFER_FAILED";

export type HelperFailure = Error & { errorCode: string };

export type HelperResponse = {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code?: string };
};

export type HelperStreamBegin = {
  /** Control operation that opens the stream, for example `fs.put.begin`. */
  op: string;
  /** Extra control fields; `streamId` is added by the client. */
  params?: Record<string, unknown>;
  /** Caller-chosen stream identifier; allocated by the client when omitted. */
  streamId?: number;
  timeoutMs?: number;
  /** Receives DATA payloads in frame order; a returned promise applies backpressure. */
  onData?(bytes: Buffer): void | Promise<void>;
};

export type HelperStreamHandle = {
  streamId: number;
  /** Control response for the opening operation. */
  response: Promise<Record<string, unknown>>;
  /** Resolves when the peer ends the stream, rejects when it fails or is abandoned. */
  completed: Promise<void>;
};

export type HelperClient = {
  request(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  beginStream(input: HelperStreamBegin): HelperStreamHandle;
  writeStreamData(streamId: number, bytes: Uint8Array): Promise<void>;
  writeStreamEnd(streamId: number): Promise<void>;
  /** Unregisters a finished stream; a stream that never ended is treated as abandoned. */
  closeStream(streamId: number): void;
  /** Unregisters an in-flight stream and drops any frame the peer still sends for it. */
  abandonStream(streamId: number, reason?: Error): void;
  close(): void;
};

type PendingRequest = {
  resolve(response: HelperResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

type StreamState = {
  streamId: number;
  requestId: string;
  onData: ((bytes: Buffer) => void | Promise<void>) | null;
  responseSettled: boolean;
  settled: boolean;
  resolveCompleted(): void;
  rejectCompleted(error: Error): void;
};

export function helperFailure(message: string, errorCode: HelperErrorCode | string): HelperFailure {
  return Object.assign(new Error(message), { errorCode });
}

function failure(message: string, errorCode: HelperErrorCode): HelperFailure {
  return helperFailure(message, errorCode);
}

function encodeFrame(kind: number, payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(5);
  header[0] = kind;
  header.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
}

function encodeControl(value: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength > MAX_CONTROL_BYTES) throw failure("The helper control frame is too large", "HELPER_PROTOCOL_ERROR");
  return encodeFrame(CONTROL_FRAME, payload);
}

function decodeFrame(buffer: Buffer<ArrayBufferLike>): { kind: number; payload: Buffer<ArrayBufferLike>; rest: Buffer<ArrayBufferLike> } | null {
  if (buffer.byteLength < 5) return null;
  const kind = buffer[0];
  if (kind !== CONTROL_FRAME && kind !== DATA_FRAME && kind !== END_FRAME) {
    throw failure("The helper sent an invalid frame type", "HELPER_PROTOCOL_ERROR");
  }
  const size = buffer.readUInt32BE(1);
  const limit = kind === CONTROL_FRAME ? MAX_CONTROL_BYTES : MAX_FRAME_BYTES;
  if (size > limit || (kind === END_FRAME && size !== STREAM_HEADER_BYTES) || (kind === DATA_FRAME && size < STREAM_HEADER_BYTES)) {
    throw failure("The helper sent an invalid frame length", "HELPER_PROTOCOL_ERROR");
  }
  if (buffer.byteLength < 5 + size) return null;
  return {
    kind,
    payload: buffer.subarray(5, 5 + size),
    rest: buffer.subarray(5 + size),
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : failure("The helper stream failed", "REMOTE_TRANSFER_FAILED");
}

class FramedHelperClient implements HelperClient {
  // `subarray` views keep the parent's backing store, which is not statically
  // an `ArrayBuffer`; the widened parameter says so instead of copying per frame.
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private readonly streams = new Map<number, StreamState>();
  private readonly abandonedStreams = new Set<number>();
  private readonly abandonedRequests = new Set<string>();
  private nextId = 0;
  private nextStreamId = 0;
  private pumping = false;
  private closed = false;
  private authenticated = false;

  private readonly socket: Socket;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", () => this.dispose(failure("The helper connection failed", "HELPER_START_FAILED")));
    socket.on("close", () => this.dispose(failure("The helper connection closed", "HELPER_START_FAILED")));
  }

  static async connect(options: { port: number; token: string; timeoutMs?: number }): Promise<FramedHelperClient> {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535
        || !/^[a-f0-9]{64}$/.test(options.token)) {
      throw failure("Invalid helper connection configuration", "HELPER_AUTH_FAILED");
    }
    const socket = await new Promise<Socket>((resolve, reject) => {
      const connection = createConnection({ host: "127.0.0.1", port: options.port });
      const timer = setTimeout(() => {
        connection.destroy();
        reject(failure("The helper connection timed out", "HELPER_START_FAILED"));
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      connection.once("connect", () => {
        clearTimeout(timer);
        resolve(connection);
      });
      connection.once("error", () => {
        clearTimeout(timer);
        reject(failure("The helper connection failed", "HELPER_START_FAILED"));
      });
      connection.once("close", () => {
        clearTimeout(timer);
        reject(failure("The helper connection closed before authentication", "HELPER_AUTH_FAILED"));
      });
    });
    const result = await FramedHelperClient.authenticate(socket, options);
    return result;
  }

  private static authenticate(socket: Socket, options: { token: string; timeoutMs?: number }): Promise<FramedHelperClient> {
    return new Promise((resolve, reject) => {
      const client = new FramedHelperClient(socket);
      const timer = setTimeout(() => {
        client.close();
        reject(failure("The helper rejected authentication", "HELPER_AUTH_FAILED"));
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      client.requestInternal("auth", { token: options.token }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS).then((auth) => {
        clearTimeout(timer);
        if (auth.authenticated !== true) {
          client.close();
          reject(failure("The helper rejected authentication", "HELPER_AUTH_FAILED"));
          return;
        }
        client.authenticated = true;
        resolve(client);
      }).catch(() => {
        clearTimeout(timer);
        client.close();
        reject(failure("The helper rejected authentication", "HELPER_AUTH_FAILED"));
      });
    });
  }

  request(op: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (!this.authenticated) return Promise.reject(failure("The helper client is not authenticated", "HELPER_AUTH_FAILED"));
    if (op === "auth") return Promise.reject(failure("Helper authentication cannot be repeated", "HELPER_PROTOCOL_ERROR"));
    return this.requestInternal(op, params, timeoutMs);
  }

  beginStream(input: HelperStreamBegin): HelperStreamHandle {
    if (!this.authenticated) throw failure("The helper client is not authenticated", "HELPER_AUTH_FAILED");
    const op = input.op;
    if (typeof op !== "string" || op.length === 0 || op.length > 128 || op === "auth") {
      throw failure("Invalid helper stream request", "HELPER_PROTOCOL_ERROR");
    }
    const streamId = input.streamId ?? this.allocateStreamId();
    if (!Number.isInteger(streamId) || streamId < 1 || streamId > 0xffffffff) {
      throw failure("Invalid helper stream identifier", "HELPER_PROTOCOL_ERROR");
    }
    if (this.streams.has(streamId) || this.abandonedStreams.has(streamId)) {
      throw failure("The helper stream identifier is already in use", "HELPER_PROTOCOL_ERROR");
    }
    let resolveCompleted: () => void = () => undefined;
    let rejectCompleted: (error: Error) => void = () => undefined;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    void completed.catch(() => undefined);
    const state: StreamState = {
      streamId,
      requestId: "",
      onData: input.onData ?? null,
      responseSettled: false,
      settled: false,
      resolveCompleted: () => {
        if (state.settled) return;
        state.settled = true;
        resolveCompleted();
      },
      rejectCompleted: (error) => {
        if (state.settled) return;
        state.settled = true;
        rejectCompleted(error);
      },
    };
    // The frame is written by sendRequest before the stream is registered; socket
    // data is only delivered on a later tick, so no frame can outrun registration.
    const sent = this.sendRequest(op, { ...input.params, streamId }, input.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS);
    state.requestId = sent.id;
    this.streams.set(streamId, state);
    const response = sent.promise.then(
      (result) => {
        state.responseSettled = true;
        return result;
      },
      (error: unknown) => {
        state.responseSettled = true;
        this.releaseStream(state, true);
        state.rejectCompleted(asError(error));
        throw asError(error);
      },
    );
    void response.catch(() => undefined);
    return { streamId, response, completed };
  }

  async writeStreamData(streamId: number, bytes: Uint8Array): Promise<void> {
    if (!this.streams.has(streamId)) throw failure("The helper stream is not open", "HELPER_PROTOCOL_ERROR");
    if (bytes.byteLength === 0) return;
    if (bytes.byteLength > MAX_FRAME_BYTES - STREAM_HEADER_BYTES) {
      throw failure("The helper data frame is too large", "HELPER_PROTOCOL_ERROR");
    }
    const payload = Buffer.allocUnsafe(STREAM_HEADER_BYTES + bytes.byteLength);
    payload.writeUInt32BE(streamId, 0);
    payload.set(bytes, STREAM_HEADER_BYTES);
    await this.writeFrame(DATA_FRAME, payload);
  }

  async writeStreamEnd(streamId: number): Promise<void> {
    if (!this.streams.has(streamId)) throw failure("The helper stream is not open", "HELPER_PROTOCOL_ERROR");
    const payload = Buffer.alloc(STREAM_HEADER_BYTES);
    payload.writeUInt32BE(streamId, 0);
    await this.writeFrame(END_FRAME, payload);
  }

  closeStream(streamId: number): void {
    const state = this.streams.get(streamId);
    if (!state) return;
    const finished = state.settled;
    this.releaseStream(state, !finished);
    if (!finished) state.rejectCompleted(failure("The helper stream was closed", "REMOTE_TRANSFER_FAILED"));
  }

  abandonStream(streamId: number, reason?: Error): void {
    const state = this.streams.get(streamId);
    if (!state) return;
    this.releaseStream(state, true);
    state.rejectCompleted(reason ?? failure("The helper transfer was cancelled", "REMOTE_TRANSFER_FAILED"));
  }

  private releaseStream(state: StreamState, abandon: boolean): void {
    if (this.streams.get(state.streamId) === state) this.streams.delete(state.streamId);
    if (!abandon) return;
    this.abandonedStreams.add(state.streamId);
    if (!state.responseSettled && state.requestId) this.abandonedRequests.add(state.requestId);
  }

  private allocateStreamId(): number {
    for (let attempt = 0; attempt < 1024; attempt += 1) {
      this.nextStreamId = this.nextStreamId >= 0xffffffff ? 1 : this.nextStreamId + 1;
      if (!this.streams.has(this.nextStreamId) && !this.abandonedStreams.has(this.nextStreamId)) return this.nextStreamId;
    }
    throw failure("The helper client has no free stream", "HELPER_INTERNAL_ERROR");
  }

  private requestInternal(op: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    try {
      return this.sendRequest(op, params, timeoutMs).promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private sendRequest(op: string, params: Record<string, unknown>, timeoutMs: number): { id: string; promise: Promise<Record<string, unknown>> } {
    if (this.closed) throw failure("The helper client is closed", "HELPER_START_FAILED");
    if (!op || op.length > 128 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw failure("Invalid helper request", "HELPER_PROTOCOL_ERROR");
    }
    const id = `${++this.nextId}-${randomUUID()}`;
    const frame = encodeControl({ id, op, ...params });
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        reject(failure("The helper request timed out", "HELPER_START_FAILED"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          if (!response.ok) {
            const code = typeof response.error?.code === "string" ? response.error.code : "HELPER_INTERNAL_ERROR";
            reject(helperFailure("The helper operation failed", code));
            return;
          }
          resolve(response.result ?? {});
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer,
      });
      try {
        this.socket.write(frame, (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          pending.reject(failure("The helper request could not be sent", "HELPER_START_FAILED"));
        });
      } catch (error) {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.reject(error instanceof Error ? error : failure("The helper request could not be sent", "HELPER_PROTOCOL_ERROR"));
        }
      }
    });
    return { id, promise };
  }

  private writeFrame(kind: number, payload: Buffer): Promise<void> {
    if (this.closed) return Promise.reject(failure("The helper client is closed", "HELPER_START_FAILED"));
    const frame = encodeFrame(kind, payload);
    return new Promise<void>((resolve, reject) => {
      try {
        this.socket.write(frame, (error) => {
          if (error) reject(failure("The helper frame could not be sent", "HELPER_START_FAILED"));
          else resolve();
        });
      } catch {
        reject(failure("The helper frame could not be sent", "HELPER_START_FAILED"));
      }
    });
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.byteLength ? Buffer.concat([this.buffer, chunk]) : chunk;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.closed) return;
        const frame = decodeFrame(this.buffer);
        if (!frame) return;
        this.buffer = frame.rest;
        const work = this.handleFrame(frame);
        if (!work) continue;
        this.socket.pause();
        try {
          await work;
        } finally {
          if (!this.closed) this.socket.resume();
        }
      }
    } catch (error) {
      this.dispose(error instanceof Error ? error : failure("The helper sent an invalid response", "HELPER_PROTOCOL_ERROR"));
    } finally {
      this.pumping = false;
    }
  }

  private handleFrame(frame: { kind: number; payload: Buffer }): void | Promise<void> {
    if (frame.kind === CONTROL_FRAME) {
      this.handleControl(frame.payload);
      return undefined;
    }
    const streamId = frame.payload.readUInt32BE(0);
    if (frame.kind === END_FRAME) {
      this.handleEnd(streamId);
      return undefined;
    }
    return this.handleData(streamId, frame.payload.subarray(STREAM_HEADER_BYTES));
  }

  private handleControl(payload: Buffer): void {
    let response: HelperResponse;
    try {
      response = JSON.parse(payload.toString("utf8")) as HelperResponse;
    } catch {
      throw failure("The helper sent an invalid response", "HELPER_PROTOCOL_ERROR");
    }
    if (!response || typeof response.id !== "string" || typeof response.ok !== "boolean") {
      throw failure("The helper sent an invalid response", "HELPER_PROTOCOL_ERROR");
    }
    const pending = this.pending.get(response.id);
    if (pending) {
      this.pending.delete(response.id);
      pending.resolve(response);
      return;
    }
    if (this.abandonedRequests.delete(response.id)) return;
    throw failure("The helper sent an unmatched response", "HELPER_PROTOCOL_ERROR");
  }

  private handleData(streamId: number, bytes: Buffer): void | Promise<void> {
    const state = this.streams.get(streamId);
    if (!state) {
      if (this.abandonedStreams.has(streamId)) return undefined;
      throw failure("The helper sent data for an unknown stream", "HELPER_PROTOCOL_ERROR");
    }
    if (!state.onData) return undefined;
    try {
      const work = state.onData(bytes);
      if (work instanceof Promise) {
        return work.catch((error: unknown) => {
          this.abandonStream(streamId, asError(error));
        });
      }
      return undefined;
    } catch (error) {
      this.abandonStream(streamId, asError(error));
      return undefined;
    }
  }

  private handleEnd(streamId: number): void {
    if (this.abandonedStreams.delete(streamId)) return;
    const state = this.streams.get(streamId);
    if (!state) throw failure("The helper ended an unknown stream", "HELPER_PROTOCOL_ERROR");
    this.streams.delete(streamId);
    state.resolveCompleted();
  }

  private dispose(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(reason);
    }
    for (const [streamId, state] of this.streams) {
      this.streams.delete(streamId);
      state.rejectCompleted(reason);
    }
    this.abandonedStreams.clear();
    this.abandonedRequests.clear();
    this.buffer = Buffer.alloc(0);
    this.socket.destroy();
  }

  close(): void {
    this.dispose(failure("The helper client is closed", "HELPER_START_FAILED"));
  }
}

export function connectHelper(options: { port: number; token: string; timeoutMs?: number }): Promise<HelperClient> {
  return FramedHelperClient.connect(options);
}
