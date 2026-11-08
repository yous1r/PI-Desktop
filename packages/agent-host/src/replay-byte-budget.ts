/** Shared retention accounting. Entries are ordered by append, not by access. */
export class ReplayByteBudget {
  private readonly entries = new Map<() => void, number>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("Replay byte budget must be a positive integer");
  }

  retain(bytes: number, evict: () => void): () => void {
    this.entries.set(evict, bytes);
    this.bytes += bytes;
    return () => {
      const held = this.entries.get(evict);
      if (held === undefined) return;
      this.entries.delete(evict);
      this.bytes -= held;
    };
  }

  /** Caller installs the release callback before enforcing the shared cap. */
  trim(): void {
    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) return;
      oldest();
    }
  }
}
