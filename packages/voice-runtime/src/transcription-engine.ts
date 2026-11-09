import { isChineseLanguage, convertChineseOutput } from "./chinese.js";
import type { ModelManager } from "./model-manager.js";
import { NativeTranscriptionStream } from "./native-transcription-stream.js";
import type { TranscribeOptions, TranscriptionStream } from "./types.js";
import { VoiceActivity } from "./voice-activity.js";

/** Owns original model uses through native compute and output conversion. */
export class TranscriptionEngine {
  private readonly activity: VoiceActivity;
  private readonly streams = new Set<NativeTranscriptionStream>();
  private readonly abort = new AbortController();
  private shuttingDown?: Promise<void>;
  constructor(readonly modelManager: ModelManager) { this.activity = new VoiceActivity(modelManager.onCleanupError); }

  getHandoffActivity() { return this.activity.snapshot(this.streams.size); }
  whenIdle(): Promise<void> { return this.activity.whenIdle(); }

  async transcribe(pcm: Float32Array, options: TranscribeOptions, signal?: AbortSignal): Promise<string> {
    this.assertOpen(); signal?.throwIfAborted();
    const lease = this.modelManager.acquireModel();
    const original = { ...options };
    const cancellation = AbortSignal.any([this.abort.signal, lease.signal, ...(signal ? [signal] : [])]);
    return this.activity.track(async () => {
      try {
        lease.assertCurrent(); cancellation.throwIfAborted(); this.activity.nativeAttempt();
        const result = await lease.model.transcribe(pcm, { language: original.language, signal: cancellation });
        lease.assertCurrent(); cancellation.throwIfAborted();
        const text = await postProcess(typeof result === "string" ? result : result.text, original);
        lease.assertCurrent(); cancellation.throwIfAborted();
        return text;
      } finally { lease.release(); }
    });
  }

  /** Streaming initialization is async internally; public feed remains synchronous. */
  createStream(options: TranscribeOptions): TranscriptionStream | null {
    this.assertOpen();
    if (!this.modelManager.getLoadedModel()) return null;
    const lease = this.modelManager.acquireModel();
    const stream = new NativeTranscriptionStream(lease, { ...options }, this.activity, postProcess, () => this.streams.delete(stream));
    this.streams.add(stream);
    return stream.initialize() ? stream : null;
  }

  shutdown(): Promise<void> {
    if (this.shuttingDown) return this.shuttingDown;
    // Install completion before abort or model-state observers can reenter shutdown.
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.shuttingDown = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.abort.abort();
    for (const stream of this.streams) stream.cancel();
    this.modelManager.dispose();
    void Promise.all([this.whenIdle(), this.modelManager.whenIdle()]).then(() => resolve(), reject);
    return this.shuttingDown;
  }
  private assertOpen(): void { if (this.shuttingDown) throw new Error("Transcription engine is shut down"); }
}

async function postProcess(value: string, options: TranscribeOptions): Promise<string> {
  const text = value.trim();
  if (text && options.chineseVariant && isChineseLanguage(options.language)) {
    try { return await convertChineseOutput(text, options.chineseVariant); }
    catch { return text; }
  }
  return text;
}
