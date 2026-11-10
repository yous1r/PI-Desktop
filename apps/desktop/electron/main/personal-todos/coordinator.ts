import { randomUUID } from "node:crypto";
import type {
  PersonalTodoAppearance, PersonalTodoDocument, PersonalTodoEdit,
  PersonalTodoReplace, PersonalTodoView,
} from "@pi-desktop/shared";
import type { TodoActivity } from "./activity";
import { parseItems, todoError } from "./validation";

export type TodoPersistence = {
  get(): Promise<PersonalTodoDocument>;
  replace(input: PersonalTodoReplace): Promise<PersonalTodoDocument>;
  /** Fix the owner of one public sequence before its first await. A captured
   * binding is used for that sequence's read and every write iteration, so a
   * queued or repeated call can never adopt the owner that replaced it. */
  capture?(): TodoPersistence;
};
export type TodoClock = {
  now(): number;
  set(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clear(timer: ReturnType<typeof setTimeout>): void;
};
const clock: TodoClock = { now: Date.now, set: setTimeout, clear: clearTimeout };
const copy = <T>(value: T): T => structuredClone(value);

/** One Main-owned draft and serial writer, independent of renderer timers. */
export function createTodoCoordinator(input: {
  persistence: TodoPersistence;
  publish(view: PersonalTodoView): void;
  activity: TodoActivity;
  clock?: TodoClock;
  mutationId?: () => string;
}) {
  const time = input.clock ?? clock;
  const activity = input.activity;
  const capturePersistence = (): TodoPersistence =>
    input.persistence.capture ? input.persistence.capture() : input.persistence;
  let state: PersonalTodoView = {
    document: null, items: [], editVersion: 0, savedEditVersion: 0,
    saveStatus: "loading", error: null, alwaysOnTop: true, visible: false, collapsed: true, appearance: { theme: "system" },
  };
  let loading: Promise<void> | null = null;
  let writing: Promise<void> | null = null;
  let pending: { request: PersonalTodoReplace; version: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let dirtySince: number | null = null;
  let disposed = false;
  let frozen = false;
  const view = () => copy(state);
  const publish = () => { if (!disposed) input.publish(view()); };
  const clearTimer = () => {
    if (!timer) return;
    time.clear(timer); timer = null; activity.letGo();
  };
  const clearDeadline = () => {
    if (!deadline) return;
    time.clear(deadline); deadline = null; activity.letGo();
  };
  // An unsaved draft, its queued write and its idempotency token are one
  // outstanding Main obligation until a committed reply retires it.
  let held = false;
  const holdDraft = () => { if (!held) { held = true; activity.hold(); } };
  const releaseDraft = () => { if (held) { held = false; activity.release(); } };
  function failed(error: unknown) {
    const e = error as { errorCode?: string; data?: { errorCode?: string } } | null;
    state.saveStatus = "error";
    state.error = { code: e?.data?.errorCode ?? e?.errorCode ?? "INTERNAL",
      message: "Personal todos could not be saved or loaded" };
    publish();
  }
  async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<T>((_, reject) => {
        timeout = time.set(() => reject(todoError("TIMEOUT", "Personal todo storage timed out")), 4000);
      })]);
    } finally { if (timeout) time.clear(timeout); }
  }
  async function load(persistence: TodoPersistence): Promise<void> {
    if (state.document || disposed) return;
    if (loading) return loading;
    const operation = (async () => {
      state.saveStatus = "loading";
      state.error = null;
      publish();
      try {
        const document = await bounded(persistence.get());
        if (disposed) return;
        if (document.schemaVersion !== 1 || !Number.isSafeInteger(document.revision) || document.revision < 0) {
          throw todoError("INVALID_ARGUMENT", "Unsupported personal todo document");
        }
        const items = parseItems(document.items);
        state.document = copy(document);
        state.items = items;
        state.saveStatus = "saved";
        state.error = null;
        publish();
      } catch (error) { failed(error); throw error; }
    })();
    loading = operation;
    try { await operation; } finally { if (loading === operation) loading = null; }
  }
  function startDeadline() {
    if (deadline || dirtySince === null) return;
    deadline = time.set(() => {
      deadline = null;
      activity.letGo();
      if (state.savedEditVersion < state.editVersion) {
        state.saveStatus = "error";
        state.error = { code: "TIMEOUT", message: "Personal todo save is delayed" };
        publish();
      }
    }, Math.max(0, 5000 - (time.now() - dirtySince)));
    activity.retain();
  }
  function schedule() {
    clearTimer();
    if (disposed || frozen || dirtySince === null || state.saveStatus === "error") return;
    timer = time.set(() => {
      timer = null;
      activity.letGo();
      // A timer that fires after admission closed starts no fresh Host write.
      // The draft and its idempotency token stay owned and remain counted.
      if (activity.isClosed()) return;
      void flush().catch(() => undefined);
    }, Math.max(0, Math.min(500, 2000 - (time.now() - dirtySince))));
    activity.retain();
  }
  /** One flush sequence keeps the owner captured now, before any await, unless
   * the caller already captured one for its own longer sequence (quit). */
  const flush = (persistence?: TodoPersistence): Promise<PersonalTodoView> =>
    flushSequence(persistence ?? capturePersistence());
  async function flushSequence(persistence: TodoPersistence): Promise<PersonalTodoView> {
    clearTimer();
    await load(persistence);
    if (disposed) throw todoError("HOST_UNAVAILABLE", "Personal todo service is closed");
    if (writing) { await writing; return flushSequence(persistence); }
    if (state.savedEditVersion === state.editVersion) return view();
    const operation = (async () => {
      while (state.savedEditVersion < state.editVersion && !disposed) {
        pending ??= { version: state.editVersion, request: {
          items: copy(state.items), expectedRevision: state.document!.revision,
          mutationId: (input.mutationId ?? randomUUID)(),
        } };
        const batch = pending;
        state.saveStatus = "saving";
        state.error = null;
        publish();
        try {
          const result = await bounded(persistence.replace(batch.request));
          if (disposed) {
            // The Host may have committed this admitted write, but its owner is
            // closed and cannot represent it. Report uncertainty, never success.
            activity.unsettled();
            return;
          }
          state.document = copy(result);
          state.savedEditVersion = batch.version;
          pending = null;
          state.error = null;
          if (state.savedEditVersion === state.editVersion) {
            dirtySince = null;
            clearDeadline();
            releaseDraft();
            state.saveStatus = "saved";
          } else {
            state.saveStatus = "pending";
          }
          publish();
        } catch (error) { failed(error); throw error; }
      }
    })();
    writing = operation;
    try { await operation; } finally { if (writing === operation) writing = null; }
    return view();
  }
  return {
    view,
    async get(persistence?: TodoPersistence) {
      await load(persistence ?? capturePersistence());
      return view();
    },
    edit(change: PersonalTodoEdit) {
      if (disposed || frozen) throw todoError("HOST_UNAVAILABLE", "Personal todos are closing");
      if (!state.document) throw todoError("HOST_UNAVAILABLE", "Personal todos have not loaded");
      if (change.expectedEditVersion !== state.editVersion) throw todoError("CONFLICT", "Personal todo draft changed");
      state.items = parseItems(change.items);
      state.editVersion += 1;
      dirtySince ??= time.now();
      holdDraft();
      // A failed write keeps its idempotency token until it is resolved.
      if (state.saveStatus !== "error") state.saveStatus = "pending";
      startDeadline();
      schedule();
      publish();
      return view();
    },
    flush,
    setWindow(value: Partial<Pick<PersonalTodoView, "visible" | "alwaysOnTop" | "collapsed">>) {
      state = { ...state, ...value }; publish();
    },
    setAppearance(appearance: PersonalTodoAppearance) { state.appearance = copy(appearance); publish(); },
    freeze(value: boolean) { frozen = value; },
    dispose() {
      disposed = true;
      clearTimer();
      clearDeadline();
      // An unsaved draft stays in memory but can no longer reach the Host.
      if (state.savedEditVersion < state.editVersion) activity.unsettled();
      releaseDraft();
    },
  };
}
export type TodoCoordinator = ReturnType<typeof createTodoCoordinator>;
