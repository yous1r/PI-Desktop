/** Ownership of one browser operation, including work left behind by a deadline. */
export interface BrowserOperationOwner {
  isCurrent(): boolean;
  assertCurrent(): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
  nativeAttempt(): void;
}

/** Process-local activity; this is neither capacity accounting nor native closure proof. */
export class BrowserActivity {
  private readonly isAdmissionClosed: () => boolean;
  private operations = 0;
  private uncontainedResources = 0;
  private epoch = 0;
  private disposed = false;

  constructor(isAdmissionClosed: () => boolean) { this.isAdmissionClosed = isAdmissionClosed; }

  assertAdmission(): void {
    if (this.disposed) throw Object.assign(new Error("Browser host is disposed."), { code: "UNAVAILABLE" });
    if (this.isAdmissionClosed()) throw Object.assign(new Error("Host admission is closed."), { code: "HOST_BUSY" });
  }

  scope(current: () => boolean = () => true): BrowserOperationOwner {
    const epoch = this.epoch;
    const isCurrent = () => !this.disposed && epoch === this.epoch && !this.isAdmissionClosed() && current();
    const assertCurrent = () => {
      this.assertAdmission();
      if (epoch !== this.epoch || !current()) {
        throw Object.assign(new Error("browser guest is not available"), { code: "UNAVAILABLE" });
      }
    };
    return {
      isCurrent,
      assertCurrent,
      run: async <T>(operation: () => Promise<T>): Promise<T> => {
        assertCurrent();
        this.operations++;
        try { return await operation(); }
        finally { this.operations--; }
      },
      nativeAttempt: () => {
        assertCurrent();
        // Creating, closing or losing an Electron handle does not qualify its native family.
        this.uncontainedResources = Math.min(Number.MAX_SAFE_INTEGER, this.uncontainedResources + 1);
      },
    };
  }

  invalidate(): void { this.epoch++; }
  dispose(): void { this.disposed = true; this.invalidate(); }
  snapshot(): { operations: number; uncontainedResources: number } {
    return { operations: this.operations, uncontainedResources: this.uncontainedResources };
  }
}
