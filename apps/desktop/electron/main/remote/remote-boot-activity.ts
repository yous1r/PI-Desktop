import type { RacpRemoteHostClient } from "./racp-remote-host-client.js";

export type RemoteBootSnapshot = { operations: number; resources: number; uncontainedResources: number };
type Reporter = { getHandoffActivity?: () => RemoteBootSnapshot };
const unknown = Number.MAX_SAFE_INTEGER;
const add = (left: number, right: number) => Math.min(unknown, left + right);
const empty = (): RemoteBootSnapshot => ({ operations: 0, resources: 0, uncontainedResources: 0 });

/** Local lifetimes only. Retirement and ordinary close never certify native closure. */
export class RemoteBootActivity {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly clients = new Map<RacpRemoteHostClient, boolean>();
  private uncertainty = 0;
  private cleanupFailed = false;
  private readonly temporary = new Set<RacpRemoteHostClient>();
  private readonly temporaryClosings = new WeakMap<RacpRemoteHostClient, Promise<void>>();

  constructor(private readonly warn: () => void) {}

  track<T>(action: () => Promise<T>): Promise<T> {
    const completion = Promise.withResolvers<T>();
    this.pending.add(completion.promise);
    void (async () => action())().then(value => {
      this.pending.delete(completion.promise);
      completion.resolve(value);
    }, error => {
      this.pending.delete(completion.promise);
      completion.reject(error);
    });
    return completion.promise;
  }

  own(client: RacpRemoteHostClient): void { this.clients.set(client, false); }
  retire(client: RacpRemoteHostClient): void { this.clients.set(client, true); }
  uncertain(): void { this.uncertainty = add(this.uncertainty, 1); }
  assertCleanup(): void {
    if (this.cleanupFailed) throw new AggregateError([], "Remote host cleanup could not be confirmed");
  }

  useTemporary<T>(client: RacpRemoteHostClient, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.own(client);
    this.temporary.add(client);
    const abort = () => { void this.closeTemporaryClient(client).catch(() => undefined); };
    return this.track(async () => {
      signal?.addEventListener("abort", abort, { once: true });
      try { signal?.throwIfAborted(); return await action(); }
      finally {
        signal?.removeEventListener("abort", abort);
        try { await this.closeTemporaryClient(client); }
        finally { this.temporary.delete(client); this.retire(client); }
      }
    });
  }

  closeTemporary(): Promise<void> {
    return this.cleanup([...this.temporary].map(client => () => this.closeTemporaryClient(client)));
  }

  private closeTemporaryClient(client: RacpRemoteHostClient): Promise<void> {
    const existing = this.temporaryClosings.get(client);
    if (existing) return existing;
    const completion = Promise.withResolvers<void>();
    this.temporaryClosings.set(client, completion.promise);
    void this.cleanup([() => client.close()]).then(completion.resolve, completion.reject);
    return completion.promise;
  }

  cleanup(actions: (() => Promise<unknown>)[]): Promise<void> {
    return this.track(async () => {
      const outcomes = await Promise.allSettled(actions.map(async action => action()));
      const failures = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
      if (!failures.length) return;
      this.uncertain();
      this.cleanupFailed = true;
      try { this.warn(); } catch { console.error("Remote cleanup notification failed"); }
      throw new AggregateError(failures, "Remote host cleanup could not be confirmed");
    });
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  snapshot(tunnels: Reporter): RemoteBootSnapshot {
    const result = empty();
    result.operations = this.pending.size;
    result.uncontainedResources = this.uncertainty;
    const accumulate = (sample: RemoteBootSnapshot) => {
      for (const key of ["operations", "resources", "uncontainedResources"] as const) result[key] = add(result[key], sample[key]);
    };
    accumulate(this.read(tunnels));
    for (const [client, retired] of this.clients) {
      const sample = this.read(client);
      accumulate(sample);
      if (!retired) result.resources = add(result.resources, 1);
      if (retired && sample.operations === 0 && sample.resources === 0) {
        // Compact settled wrappers; retain bounded refusal evidence independently.
        this.uncertainty = add(this.uncertainty, sample.uncontainedResources);
        this.clients.delete(client);
      }
    }
    return result;
  }

  private read(owner: Reporter): RemoteBootSnapshot {
    try {
      const sample = owner.getHandoffActivity?.();
      if (sample && [sample.operations, sample.resources, sample.uncontainedResources].every(value => Number.isSafeInteger(value) && value >= 0)) return sample;
    } catch { /* Invalid or unavailable inventory refuses idle handoff. */ }
    return { operations: unknown, resources: unknown, uncontainedResources: unknown };
  }
}
