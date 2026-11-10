/**
 * Ownership, admission and activity accounting for the Electron surfaces and
 * listener registrations this process creates (H1-R07).
 *
 * The main window, the plugin launcher and the application lifecycle all
 * consult one immutable owner before a fresh native surface, accelerator or
 * listener is created. Accounting stays separate from admission:
 *
 *  - `operations` counts admitted work whose lifetime outlives a caller wait:
 *    settings reads, renderer loads and pending debounced state writes. A
 *    caller timeout, a race loser or a disposal never releases a count the
 *    underlying promise still holds.
 *  - `resources` counts surfaces and registrations the concrete owners still
 *    hold. A handle is released only with evidence that the native object is
 *    actually gone (a `closed` event or the surface's own liveness probe), not
 *    because a call returned or a timer fired.
 *  - `uncontainedResources` is monotonic: a registration whose native closure
 *    could not be observed stays visible and is never cleared by a later
 *    admission reopening.
 *
 * Attribution is per operation. `begin()` captures the original Host instance
 * and generation plus the target slot synchronously; every late continuation
 * consults that frozen token through `assertFresh()`, so a callback that
 * resumed after a replacement can neither create a surface nor rebind one.
 *
 * This owner never scans `BrowserWindow.getAllWindows()`, adopts a process it
 * did not create, or destroys a native object itself: concrete registration and
 * cleanup stay in the window, launcher and lifecycle modules that own them.
 */

export type SurfaceHandoffActivity = {
  operations: number;
  resources: number;
  uncontainedResources: number;
};

/** Surface slots whose occupancy is a single-owner invariant. */
export type SurfaceSlot = "main-window" | "launcher-window" | "tray";

/** Identity of the Host generation that owns the app's current surfaces. */
export type SurfaceHostSnapshot = {
  readonly host: unknown;
  readonly generation: unknown;
};

export type SurfaceActivityOptions = {
  /** The one shared Desktop admission gate, injected by Main composition. */
  isAdmissionClosed: () => boolean;
  /**
   * Original Host instance and generation, read synchronously at every entry.
   * `null` means no Host owns the app yet; the operation is then not bound to a
   * generation until one exists, so startup ordering cannot refuse itself.
   */
  getHost: () => SurfaceHostSnapshot | null;
};

/** Which existing surface an operation is tied to. */
export type SurfaceOperationIntent = {
  /** A creation that must still find the slot empty when it resumes. */
  create?: SurfaceSlot;
};

/** A counted, immutable attribution for one admitted operation. */
export type SurfaceOperation = {
  readonly work: string;
  /** Gate open, Host unchanged and this operation's slot still free. */
  current(): boolean;
  /** Throws `HOST_BUSY` before a fresh creation or external effect. */
  assertFresh(): void;
  /** Counts until the underlying promise settles, never until a caller wait. */
  track<T>(operation: () => Promise<T>): Promise<T>;
};

/** A retained surface/registration; release needs actual cleanup evidence. */
export type SurfaceRetention = {
  readonly kind: string;
  release(): void;
};

/** A counted lifetime for pending work that is not a single promise. */
export type SurfaceHold = {
  release(): void;
};

const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const CLOSED = "desktop surface work refused while host admission is closed";
const REPLACED = "desktop surface work refused after its original host was replaced";
const SUPERSEDED = "desktop surface work refused after its surface was replaced";

function refusal(message: string): Error {
  return Object.assign(new Error(message), {
    code: "HOST_BUSY",
    errorCode: "HOST_BUSY",
  });
}

function bounded(value: number): number {
  return value > MAX_COUNT ? MAX_COUNT : value;
}

type HostReading =
  | { readonly readable: true; readonly value: SurfaceHostSnapshot | null }
  | { readonly readable: false };

type RetainedSurface = {
  readonly kind: string;
  readonly slot: SurfaceSlot | null;
  readonly isAlive: (() => boolean) | null;
  probeFailed: boolean;
};

export class SurfaceActivityOwner {
  private readonly options: SurfaceActivityOptions;
  private readonly retained = new Map<number, RetainedSurface>();
  private readonly occupants = new Map<SurfaceSlot, number>();
  private readonly generations: Record<SurfaceSlot, number> = {
    "main-window": 0,
    "launcher-window": 0,
    tray: 0,
  };
  private pendingOperations = 0;
  private uncontained = 0;
  private sealed = false;
  private sequence = 0;

  constructor(options: SurfaceActivityOptions) {
    this.options = options;
  }

  /**
   * False once the shared admission closed or this owner was sealed. A probe
   * that throws is treated as closed: an unreadable gate is never permission.
   */
  isClosed(): boolean {
    if (this.sealed) return true;
    try {
      return Boolean(this.options.isAdmissionClosed());
    } catch {
      return true;
    }
  }

  /** Permanent: a later gate reopening never revives fresh creation. */
  seal(): void {
    this.sealed = true;
  }

  /**
   * A fresh entry. The Host and target slot are captured here, synchronously,
   * and stay bound to the returned operation for its whole lifetime.
   */
  begin(work: string, intent: SurfaceOperationIntent = {}): SurfaceOperation {
    const host = this.readHost();
    const slot = intent.create;
    if (slot) this.clearDeadOccupant(slot);
    const generation = slot ? this.generations[slot] : 0;
    const owner = this;
    const current = (): boolean => {
      if (owner.isClosed()) return false;
      if (!owner.hostCurrent(host)) return false;
      // A creation may only resume into the slot state it started from. Any
      // attach/release changes the generation and refuses the late creator.
      return !slot || (owner.generations[slot] === generation && !owner.occupants.has(slot));
    };
    return {
      work,
      current,
      assertFresh(): void {
        if (owner.isClosed()) throw refusal(CLOSED);
        if (!owner.hostCurrent(host)) throw refusal(REPLACED);
        if (!current()) throw refusal(SUPERSEDED);
      },
      track<T>(operation: () => Promise<T>): Promise<T> {
        return owner.track(operation);
      },
    };
  }

  /**
   * Retains a listener or registration the caller owns. With a liveness probe
   * the resource is released as soon as the probe proves it is gone; without
   * one it stays counted until `release()` carries real cleanup evidence.
   */
  retain(kind: string, isAlive?: () => boolean): SurfaceRetention {
    return this.retainSurface(kind, null, isAlive ?? null).handle;
  }

  /**
   * Adopts a freshly created slot occupant. Refuses instead of overwriting a
   * live occupant, so a stale creator can never rebind a replacement surface.
   * Called in the same synchronous step as the creation, so a refusal here can
   * only mean the caller's own invariant was already broken; callers still
   * destroy the surface they just made.
   */
  attach(slot: SurfaceSlot, kind: string, isAlive: () => boolean): SurfaceRetention {
    if (this.isClosed()) throw refusal(CLOSED);
    const occupant = this.occupants.get(slot);
    if (occupant !== undefined && !this.clearDead(occupant)) {
      throw refusal(SUPERSEDED);
    }
    const adopted = this.retainSurface(kind, slot, isAlive);
    this.occupants.set(slot, adopted.id);
    this.generations[slot] = bounded(this.generations[slot] + 1);
    return adopted.handle;
  }

  /** A counted lifetime for pending persistence that has no single promise. */
  hold(): SurfaceHold {
    this.pendingOperations = bounded(this.pendingOperations + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.pendingOperations = Math.max(0, this.pendingOperations - 1);
      },
    };
  }

  /**
   * Records a surface or registration whose native closure cannot be observed.
   * It stays visible for the rest of the process; nothing may clear it later.
   */
  retainUnobservable(): void {
    this.uncontained = bounded(this.uncontained + 1);
  }

  /** Synchronous conservative report; never throws for a probe failure. */
  getHandoffActivity(): SurfaceHandoffActivity {
    this.sweep();
    return {
      operations: this.pendingOperations,
      resources: this.retained.size,
      uncontainedResources: this.uncontained,
    };
  }

  private retainSurface(
    kind: string,
    slot: SurfaceSlot | null,
    isAlive: (() => boolean) | null,
  ): { id: number; handle: SurfaceRetention } {
    const id = (this.sequence += 1);
    this.retained.set(id, { kind, slot, isAlive, probeFailed: false });
    return { id, handle: { kind, release: () => this.release(id) } };
  }

  private release(id: number): void {
    const surface = this.retained.get(id);
    if (!surface) return;
    this.retained.delete(id);
    if (surface.slot && this.occupants.get(surface.slot) === id) {
      this.occupants.delete(surface.slot);
      this.generations[surface.slot] = bounded(this.generations[surface.slot] + 1);
    }
  }

  /** Releases a slot only when its own probe proves the surface is gone. */
  private clearDead(id: number): boolean {
    const surface = this.retained.get(id);
    if (!surface) return true;
    if (!surface.isAlive) return false;
    try {
      if (surface.isAlive()) return false;
    } catch {
      if (!surface.probeFailed) {
        surface.probeFailed = true;
        this.retainUnobservable();
      }
      return false;
    }
    this.release(id);
    return true;
  }

  private clearDeadOccupant(slot: SurfaceSlot): void {
    const occupant = this.occupants.get(slot);
    if (occupant !== undefined) this.clearDead(occupant);
  }

  private sweep(): void {
    for (const [id, surface] of [...this.retained]) {
      if (!surface.isAlive) continue;
      try {
        if (!surface.isAlive()) this.release(id);
      } catch {
        if (!surface.probeFailed) {
          surface.probeFailed = true;
          this.retainUnobservable();
        }
      }
    }
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingOperations = bounded(this.pendingOperations + 1);
    let result: Promise<T>;
    try {
      result = operation();
    } catch (error) {
      this.pendingOperations = Math.max(0, this.pendingOperations - 1);
      throw error;
    }
    return Promise.resolve(result).finally(() => {
      this.pendingOperations = Math.max(0, this.pendingOperations - 1);
    });
  }

  private readHost(): HostReading {
    try {
      const value = this.options.getHost();
      if (value === null) return { readable: true, value: null };
      if (!value || typeof value !== "object" || !("host" in value) || !("generation" in value)) {
        return { readable: false };
      }
      return { readable: true, value: { host: value.host, generation: value.generation } };
    } catch {
      return { readable: false };
    }
  }

  /**
   * An unreadable Host at entry or now refuses everything. An entry with no
   * Host stays valid until one appears; only a replacement invalidates work.
   */
  private hostCurrent(entry: HostReading): boolean {
    if (!entry.readable) return false;
    if (entry.value === null) return true;
    const live = this.readHost();
    return (
      live.readable &&
      live.value !== null &&
      live.value.host === entry.value.host &&
      live.value.generation === entry.value.generation
    );
  }
}

/** Factory kept separate so Main composition reads as one owner instance. */
export function createSurfaceActivity(options: SurfaceActivityOptions): SurfaceActivityOwner {
  return new SurfaceActivityOwner(options);
}
