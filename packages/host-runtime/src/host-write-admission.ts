import { ErrorCodes, MAX_HOST_STDIN_LINE_BYTES } from "@pi-desktop/shared";

/** Leave host-core's other RPC slots available for control and tool traffic. */
const MAX_ACTIVE_WRITES = 8;
const MAX_ADMITTED_WRITES = 256;
const MAX_ADMITTED_BYTES = MAX_HOST_STDIN_LINE_BYTES;

export const TRANSCRIPT_WRITE_METHODS = new Set([
  "session.appendMessage", "session.recordUsage", "session.saveInflightMessage", "session.endTurn",
]);

type Waiter = {
  bytes: number;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * Admission before writing to stdio. Bounds both serialized bytes and request
 * count; FIFO waiting consumes the caller's existing transport deadline.
 * An active permit lasts until a response or transport loss, even when the
 * caller timed out: a timeout does not cancel the Rust operation.
 */
export class HostWriteAdmission {
  private active = 0;
  private count = 0;
  private bytes = 0;
  private readonly queue: Waiter[] = [];
  private closed?: Error;

  acquire(bytes: number, method: string, timeoutMs?: number): Promise<() => void> {
    if (this.closed) return Promise.reject(this.closed);
    if (this.count >= MAX_ADMITTED_WRITES || this.bytes + bytes > MAX_ADMITTED_BYTES) {
      return Promise.reject(Object.assign(new Error("Local transcript write queue capacity is exhausted. This request was not sent."), {
        errorCode: ErrorCodes.LIMIT_EXCEEDED,
        data: { scope: "host-write-queue", method, limitRequests: MAX_ADMITTED_WRITES, limitBytes: MAX_ADMITTED_BYTES },
      }));
    }
    this.count++;
    this.bytes += bytes;
    if (this.active < MAX_ACTIVE_WRITES) return Promise.resolve(this.admit(bytes));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { bytes, resolve, reject };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          this.count--;
          this.bytes -= bytes;
          reject(new Error(`host RPC timeout: ${method}`));
        }, timeoutMs);
      }
      this.queue.push(waiter);
    });
  }

  close(error: Error): void {
    this.closed = error;
    for (const waiter of this.queue.splice(0)) {
      clearTimeout(waiter.timer);
      this.count--;
      this.bytes -= waiter.bytes;
      waiter.reject(error);
    }
  }

  private admit(bytes: number): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.count--;
      this.bytes -= bytes;
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.resolve(this.admit(next.bytes));
      }
    };
  }
}
