type CleanupOwner = object;

export function pluginLifecycleError(code: "HOST_BUSY" | "PLUGIN_UNLOADED", message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Owns admission and unfinished lifecycle work; native closure remains Rust-owned. */
export class PluginLifecycle {
  private readonly isAdmissionClosed: () => boolean;
  private readonly loads = new Map<string, object>();
  private readonly unloads = new Map<string, Promise<void>>();
  private readonly cleanups = new WeakMap<CleanupOwner, Promise<void>>();
  private sealed = false;
  private operations = 0;
  private uncontainedResources = 0;

  constructor(isAdmissionClosed: () => boolean) { this.isAdmissionClosed = isAdmissionClosed; }

  assertAdmission(retiring = false): void {
    if (this.sealed) throw pluginLifecycleError("PLUGIN_UNLOADED", "Plugin runtime is shutting down");
    if (!retiring && this.isAdmissionClosed()) throw pluginLifecycleError("HOST_BUSY", "Host admission is closed");
  }

  isClosed(): boolean { return this.sealed || this.isAdmissionClosed(); }

  async track<T>(operation: () => T | Promise<T>): Promise<T> {
    this.operations += 1;
    try { return await operation(); }
    finally { this.operations -= 1; }
  }

  async load<T>(pluginId: string, operation: (assertCurrent: () => void) => Promise<T>): Promise<T> {
    this.assertAdmission();
    const marker = {};
    this.loads.set(pluginId, marker);
    const assertCurrent = () => {
      this.assertAdmission();
      if (this.loads.get(pluginId) !== marker) {
        throw pluginLifecycleError("PLUGIN_UNLOADED", "Plugin load was retired");
      }
    };
    try { return await this.track(() => operation(assertCurrent)); }
    finally { if (this.loads.get(pluginId) === marker) this.loads.delete(pluginId); }
  }

  retire(pluginId: string): void { this.loads.delete(pluginId); }
  seal(): void { this.sealed = true; this.loads.clear(); }

  cleanup(owner: CleanupOwner, operation: () => Promise<void>): Promise<void> {
    const existing = this.cleanups.get(owner);
    if (existing) return existing;
    // Install before invoking callbacks: teardown can synchronously re-enter.
    const work = this.track(() => Promise.resolve().then(operation));
    this.cleanups.set(owner, work);
    return work;
  }

  unload(pluginId: string, operation: () => Promise<void>): Promise<void> {
    const existing = this.unloads.get(pluginId);
    if (existing) return existing;
    const work = this.track(() => Promise.resolve().then(operation)).finally(() => {
      if (this.unloads.get(pluginId) === work) this.unloads.delete(pluginId);
    });
    this.unloads.set(pluginId, work);
    return work;
  }

  async waitWithin(work: Promise<unknown>, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([work, new Promise<void>(resolve => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      })]);
    } finally { clearTimeout(timer); }
  }

  nativeAttempt(): void {
    this.uncontainedResources = Math.min(Number.MAX_SAFE_INTEGER, this.uncontainedResources + 1);
  }

  snapshot(): { operations: number; uncontainedResources: number } {
    return { operations: this.operations, uncontainedResources: this.uncontainedResources };
  }
}
