/** Tracks original JavaScript completion; native disposal is not a closure proof. */
export class VoiceActivity {
  private readonly pending = new Set<Promise<unknown>>();
  private uncertainty = 0;
  constructor(private readonly onError: (error: Error) => void) {}
  snapshot(resources: number) {
    return { operations: this.pending.size, resources, uncontainedResources: this.uncertainty };
  }
  nativeAttempt(): void { this.uncertainty = Math.min(Number.MAX_SAFE_INTEGER, this.uncertainty + 1); }
  async track<T>(operation: () => Promise<T>): Promise<T> {
    let finish!: () => void;
    const completion = new Promise<void>(resolve => { finish = resolve; });
    this.pending.add(completion);
    try { return await operation(); }
    finally { this.pending.delete(completion); finish(); }
  }
  async whenIdle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  cleanup(operation: () => void): boolean {
    try { operation(); return true; }
    catch {
      this.nativeAttempt();
      this.report("Voice native cleanup could not be confirmed; idle handoff remains unavailable");
      return false;
    }
  }
  report(message: string): void {
    try { this.onError(new Error(message)); }
    catch { console.error("Voice lifecycle notification failed; original activity remains retained"); }
  }
}
export function voiceCancelled(): Error {
  return Object.assign(new Error("Voice operation cancelled"), { name: "AbortError" });
}
