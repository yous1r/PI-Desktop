import type { Session, Stream } from "transcribe-cpp";
import type { NativeModelLease } from "./native-model-owner.js";
import type { TranscribeOptions, TranscriptionStream } from "./types.js";
import { VoiceActivity, voiceCancelled } from "./voice-activity.js";

const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_QUEUED_CHUNKS = 256;

/** Adapts asynchronous native compute to the existing synchronous feed contract. */
export class NativeTranscriptionStream implements TranscriptionStream {
  private session?: Session;
  private stream?: Stream;
  private tail: Promise<void> = Promise.resolve();
  private failure?: { error: unknown };
  private cancelled = false;
  private closed = false;
  private closing?: Promise<void>;
  private finalizing?: Promise<string>;
  private queuedBytes = 0;
  private queuedChunks = 0;
  private readonly onAbort = () => this.cancel();

  constructor(
    private readonly lease: NativeModelLease,
    private readonly options: TranscribeOptions,
    private readonly activity: VoiceActivity,
    private readonly postProcess: (text: string, options: TranscribeOptions) => Promise<string>,
    private readonly onClosed: () => void,
  ) {}

  initialize(): boolean {
    this.lease.signal.addEventListener("abort", this.onAbort, { once: true });
    try {
      this.assertCurrent(); this.activity.nativeAttempt();
      this.session = this.lease.model.createSession();
      this.assertCurrent();
    } catch (error) {
      this.failure = { error }; void this.close();
      if (this.cancelled || this.lease.signal.aborted) throw voiceCancelled();
      return false;
    }
    this.enqueue(async () => {
      this.stream = await this.session!.stream({ language: this.options.language });
      this.assertCurrent();
    });
    return true;
  }

  feed(chunk: Float32Array): void {
    if (this.cancelled) throw voiceCancelled();
    if (this.finalizing) throw new Error("Voice stream is finalizing");
    // Preserve the original error for finalize, where the controller can fall back.
    if (this.failure) return;
    if (this.closed) throw new Error("Voice stream is closed");
    if (this.queuedBytes + chunk.byteLength > MAX_QUEUED_BYTES || this.queuedChunks >= MAX_QUEUED_CHUNKS) {
      this.failure = { error: new Error("Voice stream backlog exceeded") };
      void this.close(); return;
    }
    const owned = chunk.slice();
    this.queuedBytes += owned.byteLength; this.queuedChunks++;
    const work = this.enqueue(async () => { await this.stream!.feed(owned); });
    void work.then(() => { this.queuedBytes -= owned.byteLength; this.queuedChunks--; });
  }

  finalize(): Promise<string> {
    if (this.finalizing) return this.finalizing;
    let resolve!: (text: string) => void, reject!: (error: unknown) => void;
    this.finalizing = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    const previous = this.tail;
    const result = this.activity.track(async () => {
      await previous; this.assertCurrent();
      await this.stream!.finalize();
      this.assertCurrent();
      const text = await this.postProcess(this.stream!.text.full, this.options);
      this.assertCurrent(); return text;
    });
    this.tail = result.then(() => {}, error => { this.failure ??= { error }; });
    void result.then(async text => {
      await this.close();
      if (this.cancelled || this.lease.signal.aborted) throw voiceCancelled();
      return text;
    }, async error => { await this.close(); throw error; }).then(resolve, reject);
    return this.finalizing;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (!this.closed) void this.close();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const previous = this.tail;
    const work = this.activity.track(async () => {
      await previous; this.assertCurrent(); await operation(); this.assertCurrent();
    });
    this.tail = work.then(() => {}, error => {
      this.failure ??= { error };
      void this.close();
    });
    return this.tail;
  }
  private assertCurrent(): void {
    if (this.cancelled) throw voiceCancelled();
    if (this.failure) throw this.failure.error;
    this.lease.assertCurrent();
  }
  private close(): Promise<void> {
    if (this.closing) return this.closing;
    // Defer callbacks until closing is installed, including reentrant native cleanup.
    this.closing = this.activity.track(async () => {
      await Promise.resolve(); await this.tail;
      this.closed = true;
      this.lease.signal.removeEventListener("abort", this.onAbort);
      this.activity.cleanup(() => this.stream?.reset());
      this.activity.cleanup(() => this.session?.dispose());
      this.stream = undefined; this.session = undefined;
      this.lease.release(); this.onClosed();
    });
    return this.closing;
  }
}
