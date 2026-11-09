import { EventEmitter } from "node:events";
import { PcmChunker } from "./pcm-chunker.js";
import { convertFrames } from "./pcm-utils.js";
import type { TranscriptionEngine } from "./transcription-engine.js";
import type { AudioCapture, AudioCaptureFactory, TranscriptionStream, VoiceResult, VoiceSettings, VoiceState } from "./types.js";

const INITIAL_STATE: VoiceState = { phase: "idle", durationSeconds: 0, volumeLevel: 0 };
interface Recording {
  readonly abort: AbortController;
  readonly settings: VoiceSettings;
  frames: Int16Array[];
  capture?: AudioCapture;
  stream?: TranscriptionStream | null;
  chunker?: PcmChunker;
  startedAt: number;
  captureCancelled: boolean;
  captureStopped: boolean;
  streamCancelled: boolean;
  retired: boolean;
  stopping?: Promise<VoiceResult>;
}

/** Owns each prepare/record/transcribe sequence until its original work settles. */
export class VoiceController extends EventEmitter {
  private _state: VoiceState = { ...INITIAL_STATE };
  private current: Recording | undefined;
  private transition = {};
  private readonly pending = new Set<Promise<unknown>>();
  private disposed = false;
  private uncontainedResources = 0;

  constructor(
    private readonly engine: TranscriptionEngine,
    private readonly captureFactory: AudioCaptureFactory,
    private readonly getSettings: () => VoiceSettings,
    private readonly onCleanupError: (error: Error) => void = error => console.error(error.message),
  ) { super(); }

  get state(): VoiceState { return this._state; }
  getHandoffActivity() {
    return { operations: this.pending.size, resources: this.current ? 1 : 0, uncontainedResources: this.uncontainedResources };
  }
  async whenIdle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Pre-load the model for faster first recording. */
  async prepare(): Promise<void> {
    if (this.disposed) return;
    if (this.current) throw new Error(`Cannot prepare from phase: ${this._state.phase}`);
    const slot = this.reserve();
    return this.track(async () => {
      try { await this.prepareOriginal(slot); }
      catch (error) { this.fail(slot, error); throw error; }
      finally { this.retire(slot); }
    });
  }

  /** Start recording. Auto-prepares the model if needed. */
  async start(): Promise<void> {
    if (this.disposed) throw new Error("Controller is disposed");
    const phase = this._state.phase;
    if (this.current || (phase !== "idle" && phase !== "ready")) {
      throw new Error(`Cannot start from phase: ${phase}`);
    }
    const slot = this.reserve();
    return this.track(async () => {
      try {
        if (phase !== "ready" || this.engine.modelManager.getLoadedModelId() !== slot.settings.modelId) {
          await this.prepareOriginal(slot);
        }
        this.assertCurrent(slot);
        this.setState({ phase: "starting", durationSeconds: 0, volumeLevel: 0 });
        this.assertCurrent(slot);
        slot.stream = this.engine.createStream({ language: slot.settings.languages[0] ?? "en", chineseVariant: slot.settings.chineseVariant });
        this.assertCurrent(slot);
        slot.chunker = new PcmChunker(chunk => {
          this.assertCurrent(slot);
          slot.stream?.feed(chunk);
        });
        slot.capture = this.captureFactory.create(slot.settings.deviceId);
        this.assertCurrent(slot);
        slot.capture.onFrame(frame => this.onFrame(slot, frame));
        this.assertCurrent(slot);
        try { await slot.capture.start(); }
        finally {
          // A backend may accept start after an earlier cancellation. Clean only
          // that original capture again after its startup has actually returned.
          if (slot.retired) this.cancelCapture(slot, true);
        }
        this.assertCurrent(slot);
        slot.startedAt = performance.now();
        this.setState({ phase: "listening", durationSeconds: 0, volumeLevel: 0 });
        this.assertCurrent(slot);
      } catch (error) { this.fail(slot, error); throw error; }
    });
  }

  /** Stop recording and transcribe the original audio. */
  async stop(): Promise<VoiceResult> {
    const slot = this.current;
    if (slot?.stopping) return slot.stopping;
    if (!slot || this._state.phase !== "listening") throw new Error(`Cannot stop from phase: ${this._state.phase}`);
    // Install the shared promise before state notifications or native callbacks.
    let resolve!: (value: VoiceResult) => void;
    let reject!: (error: unknown) => void;
    slot.stopping = new Promise<VoiceResult>((yes, no) => { resolve = yes; reject = no; });
    void this.track(() => this.stopOriginal(slot)).then(resolve, reject);
    return slot.stopping;
  }

  private async stopOriginal(slot: Recording): Promise<VoiceResult> {
    const speechSeconds = (performance.now() - slot.startedAt) / 1000;
    try {
      this.setState({ ...this._state, phase: "transcribing" });
      this.assertCurrent(slot);
      await slot.capture?.stop();
      slot.captureStopped = true;
      this.assertCurrent(slot);
      slot.chunker?.flush();
      this.assertCurrent(slot);
      const transcribeStart = performance.now();
      let text: string;
      if (slot.stream) {
        try { text = await slot.stream.finalize(); }
        catch {
          this.assertCurrent(slot);
          text = await this.batchTranscribe(slot);
        }
      } else { text = await this.batchTranscribe(slot); }
      this.assertCurrent(slot);
      const result: VoiceResult = {
        text, speechSeconds, transcribeSeconds: (performance.now() - transcribeStart) / 1000,
        language: slot.settings.languages[0] ?? "en",
      };
      const transition = this.transition;
      this.retire(slot);
      if (this.disposed || transition !== this.transition) {
        throw Object.assign(new Error("Voice operation cancelled"), { name: "AbortError" });
      }
      this.setState({ phase: "done", durationSeconds: speechSeconds, volumeLevel: 0, result });
      return result;
    } catch (error) { this.fail(slot, error, speechSeconds); throw error; }
  }

  /** Cancel effects immediately; original promises remain owned until completion. */
  cancel(): void {
    const slot = this.current;
    if (!slot && (this._state.phase === "idle" || this._state.phase === "cancelling")) return;
    const transition = {};
    this.transition = transition;
    // Revoke identity before any event listener, abort handler or cleanup callback.
    if (this.current === slot) this.current = undefined;
    this.setState({ phase: "cancelling", durationSeconds: 0, volumeLevel: 0 });
    if (slot) {
      slot.abort.abort();
      this.retire(slot);
    }
    // A reentrant observer may have started another owner after cancellation.
    if (this.transition === transition) this.setState({ ...INITIAL_STATE });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.removeAllListeners();
  }

  private reserve(): Recording {
    const settings = this.getSettings();
    if (!settings.modelId) throw new Error("No model selected");
    const slot: Recording = {
      abort: new AbortController(), settings: { ...settings, languages: [...settings.languages] }, frames: [], startedAt: 0,
      captureCancelled: false, captureStopped: false, streamCancelled: false, retired: false,
    };
    this.transition = {};
    this.current = slot;
    return slot;
  }

  private async prepareOriginal(slot: Recording): Promise<void> {
    this.setState({ phase: "preparing", durationSeconds: 0, volumeLevel: 0 });
    this.assertCurrent(slot);
    await this.engine.modelManager.ensureLoaded(slot.settings.modelId);
    this.assertCurrent(slot);
    this.setState({ phase: "ready", durationSeconds: 0, volumeLevel: 0 });
    this.assertCurrent(slot);
  }

  private onFrame(slot: Recording, frame: Int16Array): void {
    if (!this.isCurrent(slot) || this._state.phase !== "listening") return;
    slot.frames.push(frame);
    slot.chunker?.push(frame);
    if (!this.isCurrent(slot)) return;
    let sum = 0;
    for (const sample of frame) sum += (sample / 32_768) ** 2;
    const rms = frame.length ? Math.sqrt(sum / frame.length) : 0;
    this.setState({ phase: "listening", durationSeconds: (performance.now() - slot.startedAt) / 1000, volumeLevel: rms });
    if (this.isCurrent(slot)) this.emit("volumeLevel", rms);
  }

  private async batchTranscribe(slot: Recording): Promise<string> {
    this.assertCurrent(slot);
    return this.engine.transcribe(convertFrames(slot.frames), {
      language: slot.settings.languages[0] ?? "en", chineseVariant: slot.settings.chineseVariant,
    }, slot.abort.signal);
  }

  private isCurrent(slot: Recording): boolean { return !this.disposed && !slot.retired && this.current === slot; }
  private assertCurrent(slot: Recording): void {
    if (!this.isCurrent(slot)) throw Object.assign(new Error("Voice operation cancelled"), { name: "AbortError" });
  }
  private retire(slot: Recording): void {
    slot.retired = true;
    if (this.current === slot) this.current = undefined;
    slot.frames = [];
    slot.chunker = undefined;
    this.cleanupResources(slot);
  }
  private fail(slot: Recording, error: unknown, durationSeconds = 0): void {
    const publish = this.isCurrent(slot), transition = this.transition;
    this.retire(slot);
    if (publish && !this.disposed && this.transition === transition) {
      this.setState({ phase: "error", durationSeconds, volumeLevel: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  private cancelCapture(slot: Recording, afterStartup = false): void {
    if (!slot.capture || slot.captureStopped || (slot.captureCancelled && !afterStartup)) return;
    slot.captureCancelled = true;
    this.cleanup(() => slot.capture?.cancel());
  }
  private cleanupResources(slot: Recording): void {
    this.cancelCapture(slot);
    if (slot.stream && !slot.streamCancelled) {
      slot.streamCancelled = true;
      this.cleanup(() => slot.stream?.cancel());
    }
  }
  private cleanup(operation: () => void): void {
    try { operation(); }
    catch {
      this.uncontainedResources = Math.min(Number.MAX_SAFE_INTEGER, this.uncontainedResources + 1);
      this.report(new Error("Voice cleanup could not be confirmed; idle handoff remains unavailable"));
    }
  }
  private report(error: Error): void {
    try { this.onCleanupError(error); }
    catch { console.error("Voice lifecycle notification failed; original activity remains retained"); }
  }
  private async track<T>(operation: () => Promise<T>): Promise<T> {
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    this.pending.add(completion);
    try { return await operation(); }
    finally { this.pending.delete(completion); finish(); }
  }
  private setState(state: VoiceState): void {
    this._state = state;
    try { this.emit("stateChange", state); }
    catch { this.report(new Error("Voice state notification failed")); }
  }
}
