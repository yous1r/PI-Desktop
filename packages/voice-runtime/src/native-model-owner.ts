import type { TranscribeModel } from "transcribe-cpp";
import type { ModelState } from "./types.js";
import { VoiceActivity, voiceCancelled } from "./voice-activity.js";

interface Resident {
  readonly id: string;
  readonly model: TranscribeModel;
  readonly abort: AbortController;
  readonly released: Promise<void>;
  readonly finish: () => void;
  uses: number;
  retired: boolean;
  disposalAttempted: boolean;
}
interface Loading { readonly id: string; readonly promise: Promise<void>; }
export interface NativeModelLease {
  readonly model: TranscribeModel;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  release(): void;
}

/** Owns native models, pending loads and original users independently of cache files. */
export class NativeModelOwner {
  private current?: Resident;
  private loading?: Loading;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly residents = new Set<Resident>();
  private readonly activity: VoiceActivity;
  private disposed = false;
  private cleanupFailed = false;
  constructor(
    private readonly update: (id: string, patch: Partial<ModelState>) => void,
    onError: (error: Error) => void,
  ) { this.activity = new VoiceActivity(onError); }
  getModel(): TranscribeModel | null { return this.current?.model ?? null; }
  getId(): string | null { return this.current?.id ?? null; }
  getHandoffActivity() { return this.activity.snapshot(this.residents.size); }
  whenIdle(): Promise<void> { return this.activity.whenIdle(); }

  ensureLoaded(id: string, localPath: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Model manager is disposed"));
    if (this.cleanupFailed) return Promise.reject(new Error("Voice native cleanup is unconfirmed"));
    if (this.current?.id === id) return Promise.resolve();
    if (this.loading?.id === id) return this.loading.promise;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const request: Loading = { id, promise: new Promise<void>((yes, no) => { resolve = yes; reject = no; }) };
    const previous = this.tail, old = this.current, oldLoading = this.loading;
    this.current = undefined; this.loading = request;
    this.tail = request.promise.catch(() => {});
    void this.activity.track(async () => {
      this.retire(old);
      if (old) this.notifyRetired(old.id);
      if (oldLoading && oldLoading.id !== id) this.notifyRetired(oldLoading.id);
      try {
        this.assertLoading(request);
        this.notify(id, { status: "loading", error: undefined });
        this.assertLoading(request);
        await previous;
        this.assertLoading(request);
        await Promise.all([...this.residents].map(record => record.released));
        this.assertLoading(request);
        if (this.cleanupFailed) throw new Error("Voice native cleanup is unconfirmed");
        this.activity.nativeAttempt();
        const { TranscribeModel } = await import("transcribe-cpp");
        this.assertLoading(request);
        const model = await TranscribeModel.load(localPath);
        let finish!: () => void;
        const record: Resident = {
          id, model, abort: new AbortController(), uses: 0, retired: false, disposalAttempted: false,
          released: new Promise<void>(yes => { finish = yes; }), finish: () => finish(),
        };
        this.residents.add(record);
        if (this.loading !== request || this.disposed) { this.retire(record); throw voiceCancelled(); }
        this.current = record; this.loading = undefined;
        this.notify(id, { status: "loaded", error: undefined });
        if (this.current !== record || record.retired) throw voiceCancelled();
      } catch (error) {
        if (this.loading === request) {
          this.loading = undefined;
          this.notify(id, { status: "error", error: `Load failed: ${error instanceof Error ? error.message : String(error)}` });
        }
        throw error;
      }
    }).then(resolve, reject);
    return request.promise;
  }

  acquire(): NativeModelLease {
    const record = this.current;
    if (!record || record.retired || this.disposed) throw new Error("No model loaded");
    record.uses++;
    let released = false, finish!: () => void;
    const completion = new Promise<void>(yes => { finish = yes; });
    void this.activity.track(() => completion);
    return {
      model: record.model, signal: record.abort.signal,
      assertCurrent: () => { if (released || record.retired || this.current !== record || this.disposed) throw voiceCancelled(); },
      release: () => {
        if (released) return;
        released = true; record.uses--;
        this.disposeRetired(record); finish();
      },
    };
  }

  unload(): void {
    const old = this.current, loading = this.loading;
    this.current = undefined; this.loading = undefined;
    this.retire(old);
    if (old) this.notifyRetired(old.id);
    if (loading) this.notifyRetired(loading.id);
  }
  dispose(): void { this.disposed = true; this.unload(); }
  private assertLoading(request: Loading): void {
    if (this.disposed || this.loading !== request) throw voiceCancelled();
  }
  private retire(record?: Resident): void {
    if (!record || record.retired) return;
    record.retired = true; record.abort.abort();
    this.disposeRetired(record);
  }
  private disposeRetired(record: Resident): void {
    if (!record.retired || record.uses || record.disposalAttempted) return;
    record.disposalAttempted = true;
    if (this.activity.cleanup(() => record.model.dispose())) this.residents.delete(record);
    else this.cleanupFailed = true;
    // This resolves JavaScript ownership only. transcribe-cpp may defer native frees.
    record.finish();
  }
  private notifyRetired(id: string): void {
    if (this.current?.id === id || this.loading?.id === id) return;
    this.notify(id, { status: "downloaded" });
  }
  private notify(id: string, patch: Partial<ModelState>): void {
    try { this.update(id, patch); }
    catch { this.activity.report("Voice model state notification failed"); }
  }
}
