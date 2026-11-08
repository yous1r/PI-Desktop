/** Original external work outlives caller cancellation and registry removal. */
export class ExternalResourceActivity {
  private operations = 0;
  private uncontainedResources = 0;
  private sealed = false;
  private readonly admissionClosed: () => boolean;

  constructor(isAdmissionClosed: () => boolean) { this.admissionClosed = isAdmissionClosed; }
  isClosed(): boolean { return this.sealed || this.admissionClosed(); }
  assertOpen(): void {
    if (this.isClosed()) throw Object.assign(new Error("Host admission is closed"), { code: "HOST_BUSY" });
  }
  seal(): void { this.sealed = true; }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return this.track(operation);
  }
  async track<T>(operation: () => Promise<T>): Promise<T> {
    this.operations++;
    try { return await operation(); } finally { this.operations--; }
  }
  nativeAttempt(): void {
    this.assertOpen();
    // Ordinary close, peer ACK and root exit do not certify native-family closure.
    this.uncontainedResources = Math.min(Number.MAX_SAFE_INTEGER, this.uncontainedResources + 1);
  }
  snapshot(resources = 0) {
    return { operations: this.operations, resources, uncontainedResources: this.uncontainedResources };
  }
}
