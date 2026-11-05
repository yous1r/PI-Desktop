import type { PluginExtensionRetirementReason } from "@pi-desktop/shared";

type Retirable = { dispose(reason?: PluginExtensionRetirementReason): Promise<void> };
/** One sidecar's shutdown fence. Parent keeps transport open until this settles. */
export class RuntimeShutdown {
  private closing?: Promise<{ ok: true }>;
  assertOpen(): void {
    if (this.closing) throw new Error("Agent sidecar is shutting down");
  }
  shutdown(runtimes: Map<string, Retirable>, disposeNative: () => void): Promise<{ ok: true }> {
    return this.closing ??= Promise.resolve().then(async () => {
      const retiring = [...runtimes.values()];
      runtimes.clear();
      const results = await Promise.allSettled([
        Promise.resolve().then(disposeNative),
        ...retiring.map((runtime) => Promise.resolve().then(() => runtime.dispose("app-quit"))),
      ]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Runtime shutdown failed");
      return { ok: true as const };
    });
  }
}
