import * as Value from "typebox/value";
import { RuntimeHandoffActivitySchema, type RuntimeHandoffActivity, type SidecarHandoffActivity } from "@pi-desktop/shared";

type RuntimeOwner = { getHandoffActivity(): RuntimeHandoffActivity };

/** Reads live owners; remembers only whether retirement lost a closure proof. */
export class SidecarHandoffInventory {
  private unconfirmedRetirement = false;
  constructor(private readonly runtimes: () => Iterable<RuntimeOwner>, private readonly nativeInitialized: () => boolean) {}

  retired(runtime: RuntimeOwner): void {
    const activity = runtime.getHandoffActivity();
    if (!Value.Check(RuntimeHandoffActivitySchema, activity) || Object.values(activity).some(count => count !== 0)) {
      this.unconfirmedRetirement = true;
    }
  }

  /** A replaced owner that did not complete its retirement is never forgotten. */
  lostOwner(): void { this.unconfirmedRetirement = true; }

  inspect(): SidecarHandoffActivity {
    const total: SidecarHandoffActivity = {
      turns: 0, children: 0, tools: 0, inputs: 0, settlements: 0,
      // Native session teardown is synchronous initiation, not awaited closure.
      nativeSessions: Number(this.nativeInitialized()),
      unqualifiedResources: Number(this.unconfirmedRetirement),
    };
    for (const runtime of this.runtimes()) {
      const activity = runtime.getHandoffActivity();
      if (!Value.Check(RuntimeHandoffActivitySchema, activity)) throw new Error("HANDOFF_UNAVAILABLE");
      for (const key of Object.keys(activity) as Array<keyof RuntimeHandoffActivity>) total[key] += activity[key];
    }
    return total;
  }
}
