/** Synchronous obstruction view for Main-owned personal-todo work. */
export type TodoHandoffActivity = {
  operations: number;
  resources: number;
  uncontainedResources: number;
};
const LIMIT = Number.MAX_SAFE_INTEGER;
const cap = (value: number) => Math.min(LIMIT, value);

/** One admission gate and one set of counters shared by the runtime, the draft
 * coordinator and the widget window. Operations stay counted until the original
 * Host reply settles, even after a caller deadline refused to wait. These are
 * obstruction and uncertainty bounds; they never certify native window closure. */
export function createTodoActivity(input: { isAdmissionClosed?: () => boolean } = {}) {
  let tracked = 0;
  let held = 0;
  let resources = 0;
  let uncontainedResources = 0;
  let sealed = false;
  // An unreadable gate cannot authorize new work.
  const isClosed = (): boolean => {
    if (sealed) return true;
    try { return input.isAdmissionClosed?.() === true; }
    catch { return true; }
  };
  const assertOpen = (): void => {
    if (!isClosed()) return;
    throw Object.assign(new Error("Host admission is closed"), { code: "HOST_BUSY", errorCode: "HOST_BUSY" });
  };
  return {
    isClosed,
    assertOpen,
    /** Refuse every fresh effect and leave retained counters readable. */
    seal(): void { sealed = true; },
    async track<T>(operation: () => Promise<T>): Promise<T> {
      tracked = cap(tracked + 1);
      try { return await operation(); }
      finally { if (tracked > 0) tracked -= 1; }
    },
    /** Work owned by Main without a promise of its own, such as an unsaved draft. */
    hold(): void { held = cap(held + 1); },
    release(): void { if (held > 0) held -= 1; },
    /** A live handle: native window, display listener or timer. */
    retain(): void { resources = cap(resources + 1); },
    letGo(): void { if (resources > 0) resources -= 1; },
    /** Observed uncertainty: a reply or surface this owner can no longer confirm. */
    unsettled(): void { uncontainedResources = cap(uncontainedResources + 1); },
    snapshot(): TodoHandoffActivity {
      return { operations: cap(tracked + held), resources, uncontainedResources };
    },
  };
}
export type TodoActivity = ReturnType<typeof createTodoActivity>;
