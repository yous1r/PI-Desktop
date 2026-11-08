import type { Readable, Writable } from "node:stream";
import {
  OWNER_HANDOFF_MAX_RECORD_BYTES, parseOwnerHandoffBootstrapCommand, parseOwnerHandoffResponse,
  type OwnerHandoffBootstrapCommand, type OwnerHandoffResponse,
} from "@pi-desktop/shared";

type Pending = {
  command: OwnerHandoffBootstrapCommand;
  resolve: (response: OwnerHandoffResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export type OwnerHandoffChannelOptions = { input: Readable; output: Writable; profileId: string };
function failure(errorCode: string): Error { return Object.assign(new Error(errorCode), { errorCode }); }

/** Serialized private bootstrap frames; an ambiguous transport is never reused. */
export class OwnerHandoffChannel {
  private readonly buffer = Buffer.alloc(OWNER_HANDOFF_MAX_RECORD_BYTES + 4);
  private received = 0;
  private length?: number;
  private pending?: Pending;
  private failed?: Error;
  private disposed = false;

  constructor(private readonly options: OwnerHandoffChannelOptions) {
    if (!/^[0-9a-f]{64}$/.test(options.profileId)) throw failure("HANDOFF_INVALID_IDENTITY");
    options.input.on("data", this.onData);
    options.input.on("end", this.onClosed);
    options.input.on("close", this.onClosed);
    options.input.on("error", this.onClosed);
    options.output.on("error", this.onClosed);
    options.output.on("close", this.onClosed);
  }

  async call(value: unknown, timeoutMs = 15_000): Promise<OwnerHandoffResponse> {
    const command = { ...parseOwnerHandoffBootstrapCommand(value) };
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new RangeError("handoff timeout must be an integer from 1 to 30000 ms");
    }
    if (this.failed) throw this.failed;
    if (this.pending) throw failure("HANDOFF_CHANNEL_BUSY");
    if (this.options.input.destroyed || this.options.input.readableEnded ||
        this.options.output.destroyed || this.options.output.writableEnded) {
      this.fail("HANDOFF_TRANSPORT_CLOSED"); throw this.failed;
    }
    const body = Buffer.from(JSON.stringify(command));
    const bytes = Buffer.alloc(4 + body.length);
    bytes.writeUInt32LE(body.length); body.copy(bytes, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("HANDOFF_IO_TIMEOUT"), timeoutMs);
      timer.unref?.();
      this.pending = { command, resolve, reject, timer };
      try {
        this.options.output.write(bytes, error => { if (error) this.fail("HANDOFF_TRANSPORT_CLOSED"); });
      } catch { this.fail("HANDOFF_TRANSPORT_CLOSED"); }
    });
  }

  private readonly onData = (chunk: unknown): void => {
    if (this.failed) return;
    if (!Buffer.isBuffer(chunk) || !this.pending || chunk.length > this.buffer.length - this.received) {
      this.fail("HANDOFF_INVALID_FRAME"); return;
    }
    chunk.copy(this.buffer, this.received); this.received += chunk.length;
    if (this.length === undefined && this.received >= 4) {
      this.length = this.buffer.readUInt32LE();
      if (this.length < 1 || this.length > OWNER_HANDOFF_MAX_RECORD_BYTES) { this.fail("HANDOFF_INVALID_FRAME"); return; }
    }
    if (this.length === undefined || this.received < this.length + 4) return;
    if (this.received !== this.length + 4) { this.fail("HANDOFF_INVALID_FRAME"); return; }
    let response: OwnerHandoffResponse;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(this.buffer.subarray(4, this.received));
      response = parseOwnerHandoffResponse(JSON.parse(text));
    } catch { this.fail("HANDOFF_INVALID_FRAME"); return; }
    const pending = this.pending;
    if ("record" in response) {
      const record = response.record, command = pending.command;
      if (record.profile !== this.options.profileId || record.id !== command.transfer_id ||
          (command.operation !== "status" && (record.sourceEpoch !== command.source_epoch ||
            record.targetEpoch !== command.target_epoch || record.revision !== command.expected_revision + 1 ||
            record.phase !== (command.operation === "claim" ? "target_claimed" : "release_pending")))) {
        this.fail("HANDOFF_RESPONSE_MISMATCH"); return;
      }
    }
    clearTimeout(pending.timer);
    this.pending = undefined;
    this.received = 0; this.length = undefined;
    pending.resolve(response);
  };
  private readonly onClosed = (): void => { this.fail("HANDOFF_TRANSPORT_CLOSED"); };

  private fail(code: string): void {
    if (this.failed) return;
    this.failed = failure(code);
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(this.failed); }
    this.buffer.fill(0); this.received = 0; this.length = undefined;
    // Keep stream error listeners until the owning child is disposed. A late
    // error must remain handled even though no further protocol calls are legal.
    this.options.input.off("data", this.onData);
    this.options.input.resume();
  }

  /** Stop protocol work while keeping late stream errors handled during cleanup. */
  close(): void { this.fail("HANDOFF_TRANSPORT_CLOSED"); }


  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fail("HANDOFF_TRANSPORT_CLOSED");
    this.options.input.off("data", this.onData);
    this.options.input.off("end", this.onClosed);
    this.options.input.off("close", this.onClosed);
    this.options.input.off("error", this.onClosed);
    this.options.output.off("error", this.onClosed);
    this.options.output.off("close", this.onClosed);
  }
}
