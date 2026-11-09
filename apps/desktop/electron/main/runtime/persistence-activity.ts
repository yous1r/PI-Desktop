type OperationKind = "writes" | "finalizations";

/** Process-local outstanding obligations, never a durable ownership ledger. */
export class PersistenceActivity {
  private readonly pending = new Map<Promise<void>, OperationKind>();
  private uncertain = false;

  markUncertain(): void {
    this.uncertain = true;
  }

  track(kind: OperationKind, operation: () => Promise<void>, onError?: (error: unknown) => void): Promise<void> {
    const completion = Promise.withResolvers<void>();
    // Reserve before the callback: synchronous reentry must observe this work.
    this.pending.set(completion.promise, kind);
    void completion.promise.then(
      () => this.pending.delete(completion.promise),
      () => {
        this.markUncertain();
        this.pending.delete(completion.promise);
      },
    );
    try {
      const original = operation();
      completion.resolve(onError ? original.catch((error: unknown) => {
        this.markUncertain();
        onError(error);
      }) : original);
    } catch (error) {
      this.markUncertain();
      completion.reject(error);
      throw error;
    }
    return completion.promise;
  }

  snapshot(): { writes: number; finalizations: number; uncontainedResources: number } {
    let writes = 0, finalizations = 0;
    for (const kind of this.pending.values()) {
      if (kind === "writes") writes += 1;
      else finalizations += 1;
    }
    return { writes, finalizations, uncontainedResources: Number(this.uncertain) };
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending.keys()]);
  }
}
