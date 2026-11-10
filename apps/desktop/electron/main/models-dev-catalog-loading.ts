import { readFile } from "node:fs/promises";
import { ExternalResourceActivity } from "./external-resource-activity";

type Source = "bundled" | "remote";
type Options = {
  catalogPath: string;
  apiUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  isAdmissionClosed(): boolean;
  isLoaded(): boolean;
  publish(raw: unknown, source: Source): void;
  failed(error: unknown, source: Source): void;
};

/** Owns actual I/O, not a caller's wait. Snapshot parsing/publication remains
 * with the catalog; pending response bodies and ignored aborts stay counted. */
export class ModelsDevCatalogLoading {
  private readonly activity: ExternalResourceActivity;
  private readonly flights = new Map<Source, Promise<boolean>>();
  private readonly controllers = new Set<AbortController>();
  private localAttempted = false;
  private disposed = false;

  constructor(private readonly options: Options) {
    this.activity = new ExternalResourceActivity(options.isAdmissionClosed);
  }

  loadLocal(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    const pending = this.flights.get("bundled");
    if (pending) return pending;
    if (this.localAttempted) return Promise.resolve(this.options.isLoaded());
    return this.start("bundled", async () => {
      this.localAttempted = true;
      return JSON.parse(await readFile(this.options.catalogPath, "utf8")) as unknown;
    });
  }

  refresh(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    return this.flights.get("remote") ?? this.start("remote", async () => {
      const controller = new AbortController();
      this.controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        // Fetch settlement cannot certify closure of its native connection pool.
        // Keep that family unqualified even after the response body settles.
        this.activity.nativeAttempt();
        const response = await this.options.fetchImpl(this.options.apiUrl, {
          headers: { Accept: "application/json" }, signal: controller.signal,
        });
        if (controller.signal.aborted || !response.ok) {
          await response.body?.cancel();
          controller.signal.throwIfAborted();
          throw new Error(`models.dev catalog request failed (${response.status})`);
        }
        const raw: unknown = await response.json();
        controller.signal.throwIfAborted();
        return raw;
      } finally {
        clearTimeout(timer);
        this.controllers.delete(controller);
      }
    });
  }

  private start(source: Source, load: () => Promise<unknown>): Promise<boolean> {
    if (this.activity.isClosed()) return Promise.resolve(false);
    // Reserve synchronously, publish the single flight before callbacks, and
    // recheck before the deferred I/O starts. No cancelled admission is consumed.
    const flight = this.activity.track(async () => {
      await Promise.resolve();
      if (this.activity.isClosed()) return false;
      try {
        const raw = await load();
        if (this.disposed) return false;
        this.options.publish(raw, source);
        return true;
      } catch (error) {
        if (!this.disposed) this.options.failed(error, source);
        return false;
      }
    }).finally(() => {
      if (this.flights.get(source) === flight) this.flights.delete(source);
    });
    this.flights.set(source, flight);
    return flight;
  }

  getHandoffActivity() { return this.activity.snapshot(this.controllers.size); }

  dispose(): void {
    this.disposed = true;
    this.activity.seal();
    for (const controller of this.controllers) controller.abort();
    // Do not clear flights or controllers: cancellation is not settlement.
  }
}
