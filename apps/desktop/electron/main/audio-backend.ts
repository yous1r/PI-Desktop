/** PvRecorder capture for local Dictation. Native reads retain their original handle. */
import { systemPreferences } from "electron";
import type { AudioCapture, AudioCaptureFactory, AudioInputDevice } from "@pi-desktop/voice-runtime";
import { CAPTURE_SAMPLE_RATE, FRAME_LENGTH, convertFrames } from "@pi-desktop/voice-runtime";
import { ExternalResourceActivity } from "./external-resource-activity";

type RecorderModule = typeof import("@picovoice/pvrecorder-node");
type Recorder = InstanceType<RecorderModule["PvRecorder"]>;
let recorderModule: Promise<RecorderModule> | undefined;
function loadPvRecorder(): Promise<RecorderModule> {
  if (!recorderModule) {
    const loading = import("@picovoice/pvrecorder-node");
    recorderModule = loading;
    void loading.catch(() => { if (recorderModule === loading) recorderModule = undefined; });
  }
  return recorderModule;
}

export async function checkMicrophonePermission(): Promise<"granted" | "denied" | "undetermined"> {
  if (process.platform !== "darwin") return "granted";
  switch (systemPreferences.getMediaAccessStatus("microphone")) {
    case "granted": return "granted";
    case "denied":
    case "restricted": return "denied";
    default: return "undetermined";
  }
}

export async function requestMicrophonePermission(): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  return systemPreferences.askForMediaAccess("microphone");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

interface Recording {
  recorder?: Recorder;
  starting: Promise<void>;
  reading?: Promise<void>;
  closing?: Promise<void>;
  output?: Promise<Float32Array>;
  finished: ReturnType<typeof deferred<void>>;
  stopping: boolean;
  stopIssued: boolean;
  frames: Int16Array[];
  readError?: unknown;
  stopError?: unknown;
}

class PvRecorderCapture implements AudioCapture {
  private current: Recording | undefined;
  private frameCallback: ((frame: Int16Array) => void) | undefined;

  constructor(private readonly deviceIndex: number, private readonly backend: PvRecorderBackend) {}

  get isActive(): boolean { return !!this.current?.recorder && !this.current.stopping; }
  onFrame(callback: (frame: Int16Array) => void): void { this.frameCallback = callback; }
  whenIdle(): Promise<void> { return this.current?.finished.promise ?? Promise.resolve(); }

  async start(): Promise<void> {
    this.backend.assertOpen();
    if (this.current) throw new Error("Capture already active");
    const starting = deferred<void>();
    const slot: Recording = {
      starting: starting.promise, finished: deferred<void>(), stopping: false, stopIssued: false, frames: [],
    };
    // Install ownership before import, native callbacks or cancellation can reenter.
    this.backend.retain(this);
    this.current = slot;
    void slot.finished.promise.catch(() => undefined);
    void this.backend.track(() => this.open(slot)).then(starting.resolve, starting.reject);
    try {
      await slot.starting;
      this.assertCurrent(slot);
    } catch (error) {
      await this.close(slot).catch(() => undefined); // close reports cleanup uncertainty separately
      throw error;
    }
  }

  private assertCurrent(slot: Recording): void {
    this.backend.assertOpen();
    if (this.current !== slot || slot.stopping) {
      throw Object.assign(new Error("Audio capture cancelled"), { name: "AbortError" });
    }
  }

  private async open(slot: Recording): Promise<void> {
    this.backend.nativeAttempt();
    const { PvRecorder } = await loadPvRecorder();
    this.assertCurrent(slot);
    const recorder = new PvRecorder(FRAME_LENGTH, this.deviceIndex);
    slot.recorder = recorder;
    this.assertCurrent(slot);
    if (recorder.sampleRate !== CAPTURE_SAMPLE_RATE) {
      throw new Error(`PvRecorder reported ${recorder.sampleRate} Hz; expected ${CAPTURE_SAMPLE_RATE} Hz`);
    }
    recorder.start();
    this.assertCurrent(slot);
    slot.reading = this.backend.track(() => this.readFrames(slot, recorder));
  }

  stop(): Promise<Float32Array> {
    const slot = this.current;
    if (!slot) return Promise.reject(new Error("Capture not active"));
    if (slot.output) return slot.output;
    const output = deferred<Float32Array>();
    slot.output = output.promise;
    void this.close(slot).then(() => {
      if (slot.readError !== undefined) throw slot.readError;
      return convertFrames(slot.frames);
    }).then(output.resolve, output.reject);
    return output.promise;
  }

  cancel(): void {
    const slot = this.current;
    if (slot) void this.close(slot).catch(() => undefined);
  }

  private stopOriginal(slot: Recording): void {
    if (!slot.recorder || slot.stopIssued) return;
    try {
      if (slot.recorder.isRecording) {
        slot.stopIssued = true;
        slot.recorder.stop();
      }
    } catch (error) { slot.stopError ??= error instanceof Error ? error : new Error(String(error)); }
  }

  private close(slot: Recording): Promise<void> {
    if (slot.closing) return slot.closing;
    const closing = deferred<void>();
    slot.closing = closing.promise;
    slot.stopping = true;
    // Native stop must begin synchronously, with the shared completion installed.
    this.stopOriginal(slot);
    void this.backend.track(async () => {
      await slot.starting.catch(() => undefined);
      this.stopOriginal(slot);
      await slot.reading;
      // PvRecorder.read queues a native handle read. Never delete that handle
      // until the original read has returned, even when the caller cancelled.
      try {
        slot.recorder?.release();
      } catch {
        throw new Error("Audio capture cleanup could not be confirmed; idle handoff remains unavailable");
      }
      if (this.current === slot) this.current = undefined;
      this.backend.release(this);
      if (slot.stopError !== undefined) {
        throw new Error("Audio capture cleanup could not be confirmed; idle handoff remains unavailable");
      }
    }).then(() => {
      closing.resolve();
      slot.finished.resolve();
    }, (error: Error) => {
      this.backend.reportCleanupError(error);
      closing.reject(error);
      slot.finished.reject(error);
    });
    return closing.promise;
  }

  private async readFrames(slot: Recording, recorder: Recorder): Promise<void> {
    try {
      while (!slot.stopping && recorder.isRecording) {
        const frame = await recorder.read();
        if (slot.stopping || this.current !== slot) break;
        slot.frames.push(frame);
        try { this.frameCallback?.(frame); } catch { /* Observer errors do not fail capture. */ }
      }
    } catch (error) {
      if (!slot.stopping) slot.readError = error instanceof Error ? error : new Error(String(error));
    }
  }
}

export class PvRecorderBackend implements AudioCaptureFactory {
  private readonly activity: ExternalResourceActivity;
  private readonly captures = new Set<PvRecorderCapture>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(isAdmissionClosed: () => boolean, private readonly onCleanupError: (error: Error) => void) {
    this.activity = new ExternalResourceActivity(isAdmissionClosed);
  }

  assertOpen(): void { this.activity.assertOpen(); }
  nativeAttempt(): void { this.activity.nativeAttempt(); }
  retain(capture: PvRecorderCapture): void {
    if (this.captures.size > 0) throw new Error("Capture already active or cleanup is pending");
    this.captures.add(capture);
  }
  release(capture: PvRecorderCapture): void { this.captures.delete(capture); }
  reportCleanupError(error: Error): void {
    try { this.onCleanupError(error); }
    catch { console.error("Audio capture cleanup notification failed; idle handoff remains unavailable"); }
  }
  getHandoffActivity() { return this.activity.snapshot(this.captures.size); }

  track<T>(operation: () => Promise<T>): Promise<T> {
    const completion = deferred<T>();
    this.pending.add(completion.promise);
    void this.activity.track(operation).then((value) => {
      this.pending.delete(completion.promise);
      completion.resolve(value);
    }, (error: unknown) => {
      this.pending.delete(completion.promise);
      completion.reject(error);
    });
    return completion.promise;
  }

  async whenIdle(): Promise<void> {
    await Promise.all([...this.captures].map((capture) => capture.whenIdle()));
    await Promise.all([...this.pending]);
  }

  dispose(): void {
    this.activity.seal();
    for (const capture of this.captures) capture.cancel();
  }

  async getDevices(): Promise<AudioInputDevice[]> {
    this.assertOpen();
    return this.track(async () => {
      this.nativeAttempt();
      const { PvRecorder } = await loadPvRecorder();
      this.assertOpen();
      const names = PvRecorder.getAvailableDevices();
      this.assertOpen();
      return names.map((label, index) => ({ deviceId: String(index), label, isDefault: index === 0 }));
    });
  }

  create(deviceId: string | null): AudioCapture {
    this.assertOpen();
    const index = deviceId !== null ? Number.parseInt(deviceId, 10) : -1;
    return new PvRecorderCapture(Number.isNaN(index) ? -1 : index, this);
  }

  async checkPermission(): Promise<"granted" | "denied" | "undetermined"> {
    this.assertOpen();
    return this.track(async () => {
      const result = await checkMicrophonePermission();
      this.assertOpen();
      return result;
    });
  }

  async requestPermission(): Promise<boolean> {
    this.assertOpen();
    return this.track(async () => {
      this.nativeAttempt();
      const result = await requestMicrophonePermission();
      this.assertOpen();
      return result;
    });
  }
}
