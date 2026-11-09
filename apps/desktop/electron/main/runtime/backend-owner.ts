import { isPromise } from "node:util/types";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { RuntimeState } from "./context";

type HostEntry = {
  value: HostProcess;
  generation: string;
  exited: boolean;
  ready: boolean;
  childClosed: boolean;
  unsubscribe?: () => void;
  closing?: Promise<void>;
};
type SidecarEntry = {
  value: AgentSidecar;
  host: HostEntry;
  exited: boolean;
  ready: boolean;
  nativeClosed: boolean;
  childClosed: boolean;
  cleanupFailed: boolean;
  unsubscribe?: () => void;
  closing?: Promise<void>;
};

export type DesktopBackendOwnerOptions<Prepared> = {
  runtimeState: Pick<RuntimeState, "host" | "sidecar" | "handoffAdmission">;
  fenced: boolean;
  isQuitting(): boolean;
  host: {
    prepare(): Promise<Prepared>;
    create(prepared: Prepared): HostProcess;
    /** Must complete the new Rust Host handshake, including native recovery. */
    configure(host: HostProcess, prepared: Prepared, assertCurrent: () => void): Promise<void>;
  };
  sidecar: {
    /** Failed construction must retain and clean its own partially created child. */
    create(host: HostProcess, assertCurrent: () => void): AgentSidecar | Promise<AgentSidecar>;
    configure(sidecar: AgentSidecar, host: HostProcess, assertCurrent: () => void): Promise<void>;
    retire?(sidecar: AgentSidecar): void;
  };
};

const failure = (code: string) => Object.assign(new Error(code), { errorCode: code });
const cleanupFailure = (errors: unknown[]) => new AggregateError(errors, "BACKEND_CLEANUP_UNCONFIRMED");
const MAX_RETIRED_SIDECARS = 8;

/** Owns original children across publication, crashes and cross-kind restarts.
 * Retry policy stays in RuntimeSupervisor; Rust remains native authority. */
export class DesktopBackendOwner<Prepared> {
  private host?: HostEntry;
  private sidecar?: SidecarEntry;
  private readonly retired = new Set<SidecarEntry>();
  private readonly flights: Partial<Record<"host" | "sidecar", Promise<void>>> = {};
  private tail: Promise<void> = Promise.resolve();
  private sealed = false;
  private operations = 0;
  private uncertain = false;
  private sidecarClose?: Promise<void>;
  private hostClose?: Promise<void>;

  constructor(private readonly options: DesktopBackendOwnerOptions<Prepared>) {}

  startHost = (): Promise<void> => this.start("host");
  startSidecar = (): Promise<void> => this.start("sidecar");

  private assertAdmission(): void {
    if (this.sealed || this.options.isQuitting() || this.options.runtimeState.handoffAdmission.isClosed()) {
      throw failure("HOST_BUSY");
    }
  }

  private liveHost(entry: HostEntry): boolean {
    return !entry.exited && entry.value.generation === entry.generation && entry.value.isAvailable();
  }

  private assertHost(entry: HostEntry): void {
    this.assertAdmission();
    if (this.host !== entry || this.options.runtimeState.host !== entry.value || !this.liveHost(entry)) {
      throw failure("BACKEND_OWNER_CHANGED");
    }
  }

  private start(kind: "host" | "sidecar"): Promise<void> {
    try { this.assertAdmission(); } catch (error) { return Promise.reject(error); }
    const existing = this.flights[kind];
    if (existing) return existing;
    const previous = this.tail;
    this.operations++;
    // Reserve the completion before invoking any callback, including reentry.
    const running = this.options.runtimeState.handoffAdmission.run(() => previous.then(async () => {
      this.assertAdmission();
      const host = await this.ensureHost();
      if (kind === "sidecar") await this.ensureSidecar(host);
    })).finally(() => {
      this.operations--;
      if (this.flights[kind] === running) delete this.flights[kind];
    });
    this.flights[kind] = running;
    this.tail = running.catch(() => undefined);
    return running;
  }

  private async ensureHost(): Promise<HostEntry> {
    const state = this.options.runtimeState;
    if (this.uncertain) throw cleanupFailure([failure("BACKEND_OWNER_CHANGED")]);
    const previous = this.host;
    if (state.host && state.host !== previous?.value) throw failure("BACKEND_OWNER_CHANGED");
    if (previous?.ready && state.host === previous.value && this.liveHost(previous)) return previous;
    if (this.options.fenced && this.sidecar) await this.retireSidecar(this.sidecar);
    if (previous) await this.retireHost(previous);
    this.assertAdmission();
    const prepared = await this.options.host.prepare();
    this.assertAdmission();
    if (state.host) throw failure("BACKEND_OWNER_CHANGED");
    const value = this.options.host.create(prepared);
    const entry: HostEntry = { value, generation: value.generation, exited: false, ready: false, childClosed: false };
    this.host = entry;
    try {
      if (state.host) throw failure("BACKEND_OWNER_CHANGED");
      state.host = value;
      entry.unsubscribe = value.onExit(() => { entry.exited = true; entry.ready = false; });
      const check = () => this.assertHost(entry);
      check();
      await this.options.host.configure(value, prepared, check);
      check();
      // A successful contained Rust startup proves all journal generations of
      // confirmed-exited prior Hosts. A JS root exit alone never does.
      if (this.options.fenced && previous) {
        for (const retired of this.retired) {
          if (retired.host.childClosed && retired.childClosed && !retired.cleanupFailed) retired.nativeClosed = true;
        }
      }
      if (!this.options.fenced && this.sidecar?.ready && !this.sidecar.exited) {
        this.sidecar.value.setHost(value);
        check();
        this.sidecar.host = entry;
      }
      entry.ready = true;
      return entry;
    } catch (error) {
      try { await this.retireHost(entry); }
      catch (cleanup) { throw cleanupFailure([error, cleanup]); }
      throw error;
    }
  }

  private async ensureSidecar(host: HostEntry): Promise<void> {
    this.assertHost(host);
    if (this.uncertain) throw cleanupFailure([failure("BACKEND_OWNER_CHANGED")]);
    const state = this.options.runtimeState;
    if (state.sidecar && state.sidecar !== this.sidecar?.value) throw failure("BACKEND_OWNER_CHANGED");
    const previous = this.sidecar;
    if (previous?.ready && !previous.exited && previous.host === host && state.sidecar === previous.value) return;
    if (previous) await this.retireSidecar(previous);
    this.assertHost(host);
    this.pruneRetired();
    if ([...this.retired].some(entry => !entry.nativeClosed || !entry.childClosed || entry.cleanupFailed)) {
      throw cleanupFailure([failure("BACKEND_OWNER_CHANGED")]);
    }
    if (this.retired.size >= MAX_RETIRED_SIDECARS) throw failure("BACKEND_RETIRED_CAPACITY");
    let entry: SidecarEntry | undefined;
    try {
      const value = await this.options.sidecar.create(host.value, () => this.assertHost(host));
      entry = { value, host, exited: false, ready: false, nativeClosed: !this.options.fenced,
        childClosed: false, cleanupFailed: false };
      this.sidecar = entry;
      const original = entry;
      entry.unsubscribe = value.onExit(() => { original.exited = true; original.ready = false; });
      this.assertHost(host);
      value.setHost(host.value);
      const binding = value.captureHostBinding(host.value);
      const check = () => {
        this.assertHost(host);
        if (this.sidecar !== original || original.exited || !binding() ||
          (state.sidecar !== null && state.sidecar !== value)) throw failure("BACKEND_OWNER_CHANGED");
      };
      check();
      await this.options.sidecar.configure(value, host.value, check);
      check();
      entry.ready = true;
      state.sidecar = value;
    } catch (error) {
      if (entry) {
        try { await this.retireSidecar(entry); }
        catch (cleanup) { throw cleanupFailure([error, cleanup]); }
      } else if (error instanceof AggregateError) {
        // Failed fenced construction owns partial cleanup; unresolved native
        // proof must remain observable even though no instance was returned.
        this.uncertain = true;
      }
      throw error;
    }
  }

  private retireHost(entry: HostEntry): Promise<void> {
    if (entry.closing) return entry.closing;
    entry.ready = false;
    if (this.options.runtimeState.host === entry.value) this.options.runtimeState.host = null;
    entry.closing = Promise.resolve().then(async () => {
      try {
        await entry.value.dispose();
        if (!await entry.value.confirmExit(2000)) throw failure("BACKEND_HOST_EXIT_UNCONFIRMED");
        entry.childClosed = true;
      } catch (error) {
        this.uncertain = true;
        throw cleanupFailure([error]);
      } finally {
        entry.unsubscribe?.(); entry.unsubscribe = undefined;
      }
    });
    return entry.closing;
  }

  private retireSidecar(entry: SidecarEntry): Promise<void> {
    if (entry.closing) return entry.closing;
    const wasReady = entry.ready;
    entry.ready = false;
    this.retired.add(entry);
    entry.closing = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      try { if (wasReady && !this.sealed && !this.options.isQuitting()) this.options.sidecar.retire?.(entry.value); }
      catch (error) { errors.push(error); }
      if (this.options.runtimeState.sidecar === entry.value) this.options.runtimeState.sidecar = null;
      const native = this.options.fenced && this.liveHost(entry.host);
      const results = await Promise.allSettled([
        Promise.resolve().then(async () => {
          if (native) {
            if (!await entry.value.fenceExecution(2000)) throw failure("BACKEND_NATIVE_EXIT_UNCONFIRMED");
            entry.nativeClosed = true;
          }
        }),
        Promise.resolve().then(async () => {
          await entry.value.dispose();
          if (!await entry.value.confirmExit(2000)) throw failure("BACKEND_CHILD_EXIT_UNCONFIRMED");
          entry.childClosed = true;
        }),
      ]);
      entry.unsubscribe?.(); entry.unsubscribe = undefined;
      errors.push(...results.flatMap(result => result.status === "rejected" ? [result.reason] : []));
      if (errors.length) { entry.cleanupFailed = true; throw cleanupFailure(errors); }
      if (this.sidecar === entry) this.sidecar = undefined;
    });
    return entry.closing;
  }

  private pruneRetired(): void {
    for (const entry of this.retired) {
      if (!entry.childClosed || !entry.nativeClosed || entry.cleanupFailed) continue;
      if (this.emptyReport(() => entry.value.getExtensionOwnerActivity(), ["operations", "runtimes", "uncontainedResources"]) &&
        this.emptyReport(() => entry.value.getExtensionWorkspaceProcessActivity(), ["operations", "processes", "uncontainedResources"]) &&
        this.emptyReport(() => entry.value.getExtensionServiceActivity(), ["operations", "inputs", "uncontainedResources"])) this.retired.delete(entry);
    }
  }

  private emptyReport(read: () => unknown, keys: string[]): boolean {
    try {
      const value = read();
      if (isPromise(value)) { void Promise.prototype.then.call(value, undefined, () => undefined); return false; }
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      return Reflect.ownKeys(value).length === keys.length && keys.every(key => descriptors[key] &&
        "value" in descriptors[key] && descriptors[key].value === 0);
    } catch { return false; }
  }

  retainedSidecars(): readonly AgentSidecar[] {
    this.pruneRetired();
    return [...new Set([...this.retired].map(entry => entry.value).concat(this.sidecar ? [this.sidecar.value] : []))];
  }

  getHandoffActivity() {
    this.pruneRetired();
    return { operations: this.operations, retiredSidecars: this.retired.size,
      uncontainedResources: Number(this.uncertain || [...this.retired].some(entry =>
        entry.cleanupFailed || !entry.childClosed || !entry.nativeClosed)) };
  }

  closeSidecar(): Promise<void> {
    this.sealed = true;
    if (this.sidecarClose) return this.sidecarClose;
    this.operations++;
    this.sidecarClose = this.tail.then(async () => {
      const entry = this.sidecar;
      if (!entry) return;
      const errors: unknown[] = [];
      try { if (entry.ready && !entry.exited) await entry.value.shutdown(); } catch (error) { errors.push(error); }
      try { await this.retireSidecar(entry); } catch (error) { errors.push(error); }
      if (errors.length) throw cleanupFailure(errors);
    }).finally(() => { this.operations--; });
    return this.sidecarClose;
  }

  /** Called after terminal persistence has drained while the Host is alive. */
  closeHost(): Promise<void> {
    this.sealed = true;
    if (this.hostClose) return this.hostClose;
    this.operations++;
    this.hostClose = this.tail.then(async () => { if (this.host) await this.retireHost(this.host); })
      .finally(() => { this.operations--; });
    return this.hostClose;
  }
}
