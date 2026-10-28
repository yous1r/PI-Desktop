import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

const CONTROL_FRAME = 0x01;
const DATA_FRAME = 0x02;
const END_FRAME = 0x03;
const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export type HelperErrorCode =
  | "HELPER_AUTH_FAILED"
  | "HELPER_INTERNAL_ERROR"
  | "HELPER_OPERATION_UNAVAILABLE"
  | "HELPER_PROTOCOL_ERROR"
  | "HELPER_START_FAILED"
  | "HELPER_VERSION_MISMATCH";

export type HelperResponse = {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: HelperErrorCode };
};

type PendingRequest = {
  resolve(response: HelperResponse): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export type HelperClient = {
  request(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
};

function failure(message: string, errorCode: HelperErrorCode): Error {
  return Object.assign(new Error(message), { errorCode });
}

function encodeControl(value: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength > MAX_CONTROL_BYTES) throw failure("The helper control frame is too large", "HELPER_PROTOCOL_ERROR");
  const header = Buffer.allocUnsafe(5);
  header[0] = CONTROL_FRAME;
  header.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer: Buffer): { kind: number; payload: Buffer; rest: Buffer } | null {
  if (buffer.byteLength < 5) return null;
  const kind = buffer[0];
  if (kind !== CONTROL_FRAME && kind !== DATA_FRAME && kind !== END_FRAME) {
    throw failure("The helper sent an invalid frame type", "HELPER_PROTOCOL_ERROR");
  }
  const size = buffer.readUInt32BE(1);
  const limit = kind === CONTROL_FRAME ? MAX_CONTROL_BYTES : MAX_FRAME_BYTES;
  if (size > limit || (kind === END_FRAME && size !== 4) || (kind === DATA_FRAME && size < 4)) {
    throw failure("The helper sent an invalid frame length", "HELPER_PROTOCOL_ERROR");
  }
  if (buffer.byteLength < 5 + size) return null;
  return {
    kind,
    payload: buffer.subarray(5, 5 + size),
    rest: buffer.subarray(5 + size),
  };
}

class FramedHelperClient implements HelperClient {
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingRequest>();
  private nextId = 0;
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

  private requestInternal(op: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(failure("The helper client is closed", "HELPER_START_FAILED"));
    if (!op || op.length > 128 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      return Promise.reject(failure("Invalid helper request", "HELPER_PROTOCOL_ERROR"));
    }
    const id = `${++this.nextId}-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        reject(failure("The helper request timed out", "HELPER_START_FAILED"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (response) => {
          if (!response.ok) {
            reject(failure("The helper operation failed", response.error?.code ?? "HELPER_INTERNAL_ERROR"));
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
        this.socket.write(encodeControl({ id, op, ...params }), (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          pending.reject(failure("The helper request could not be sent", "HELPER_START_FAILED"));
        });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : failure("The helper request could not be sent", "HELPER_PROTOCOL_ERROR"));
      }
    });
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = this.buffer.byteLength ? Buffer.concat([this.buffer, chunk]) : chunk;
    try {
      for (;;) {
        const frame = decodeFrame(this.buffer);
        if (!frame) return;
        this.buffer = frame.rest;
        if (frame.kind !== CONTROL_FRAME) throw failure("Unexpected helper data frame", "HELPER_PROTOCOL_ERROR");
        const response = JSON.parse(frame.payload.toString("utf8")) as HelperResponse;
        if (!response || typeof response.id !== "string" || typeof response.ok !== "boolean") {
          throw failure("The helper sent an invalid response", "HELPER_PROTOCOL_ERROR");
        }
        const pending = this.pending.get(response.id);
        if (!pending) throw failure("The helper sent an unmatched response", "HELPER_PROTOCOL_ERROR");
        this.pending.delete(response.id);
        pending.resolve(response);
      }
    } catch (error) {
      this.dispose(error instanceof Error ? error : failure("The helper sent an invalid response", "HELPER_PROTOCOL_ERROR"));
    }
  }

  private dispose(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(reason);
    }
    this.socket.destroy();
  }

  close(): void {
    this.dispose(failure("The helper client is closed", "HELPER_START_FAILED"));
  }
}

export function connectHelper(options: { port: number; token: string; timeoutMs?: number }): Promise<HelperClient> {
  return FramedHelperClient.connect(options);
}
