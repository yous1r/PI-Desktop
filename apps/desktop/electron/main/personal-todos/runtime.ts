import { app, clipboard, dialog, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import {
  IPC, PERSONAL_TODO_MAX_NOTE, PERSONAL_TODO_MAX_TITLE,
  type AppSettings, type PersonalTodoDocument,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "../ipc/types";
import { createTodoActivity } from "./activity";
import { createTodoCoordinator, type TodoClock, type TodoPersistence } from "./coordinator";
import { createTodoWindow, type TodoWindow } from "./window";
import { parseItems, record, text, todoError } from "./validation";

/** A refused fresh effect while application admission is closed. */
const isGateRefusal = (error: unknown) =>
  (error as { errorCode?: unknown; code?: unknown } | null)?.errorCode === "HOST_BUSY";

export function createPersonalTodos(input: {
  dataDir: string;
  getHost(): HostProcess | null;
  getMainWindow(): BrowserWindow | null;
  log(message: string, error: unknown): void;
  /** Shared application gate; a closed gate refuses fresh background effects. */
  isAdmissionClosed?: () => boolean;
  clock?: TodoClock;
  mutationId?: () => string;
}) {
  let widget: TodoWindow | null = null;
  const activity = createTodoActivity({ isAdmissionClosed: input.isAdmissionClosed });
  let closed = false;
  /** Capture the original Host and its execution generation once, synchronously,
   * at the entry of one public sequence. Every await inside that sequence keeps
   * this owner: a queued, deferred or repeated call never adopts the Host that
   * replaced it, and a reply from a retired owner is never applied. */
  function owner() {
    activity.assertOpen();
    const current = input.getHost();
    if (!current) throw todoError("HOST_UNAVAILABLE", "Personal todo storage is unavailable");
    const host = current;
    const generation = host.generation;
    const assertCurrent = () => {
      if (input.getHost() !== host || host.generation !== generation || !host.isAvailable()) {
        throw todoError("HOST_UNAVAILABLE", "Personal todo storage owner changed");
      }
    };
    assertCurrent();
    return {
      call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        // Counted until the original Host settles, never only until a caller
        // deadline stops waiting for it. A sequence that captured while open
        // never issues its request after admission closed: the check is before
        // the send, and an already sent request is never abandoned.
        return activity.track(async () => {
          activity.assertOpen();
          assertCurrent();
          let value: T;
          try { value = await host.call<T>(method, params); }
          catch (error) { assertCurrent(); throw error; }
          // A retired owner never applies the reply, which may have committed.
          try { assertCurrent(); }
          catch (error) { activity.unsettled(); throw error; }
          return value;
        });
      },
    };
  }
  /** A binding for one public sequence; nested captures reuse the same owner. */
  function capturePersistence(): TodoPersistence {
    const captured = owner();
    const bound: TodoPersistence = {
      get: () => captured.call<PersonalTodoDocument>("personalTodos.get"),
      replace: (change) => captured.call<PersonalTodoDocument>("personalTodos.replace", change),
      capture: () => bound,
    };
    return bound;
  }
  /** A binding that keeps the capture refusal it was created with. A sequence
   * keeps this instead of falling back to a fresh capture after its first
   * await, so a Host that appears later is never adopted by that sequence. */
  function refusedPersistence(error: unknown): TodoPersistence {
    const refuse = (): Promise<never> => Promise.reject(error);
    const bound: TodoPersistence = { get: refuse, replace: refuse, capture: () => bound };
    return bound;
  }
  function captureOwnerOrRefusal(): TodoPersistence {
    try { return capturePersistence(); }
    catch (error) { return refusedPersistence(error); }
  }
  const persistence: TodoPersistence = {
    get: () => capturePersistence().get(),
    replace: (change) => capturePersistence().replace(change),
    capture: capturePersistence,
  };
  const coordinator = createTodoCoordinator({
    activity,
    clock: input.clock,
    mutationId: input.mutationId,
    persistence,
    publish(view) {
      widget?.publish(view);
      const main = input.getMainWindow();
      if (main && !main.isDestroyed() && !main.webContents.isDestroyed()) {
        main.webContents.send(IPC.event.personalTodosChanged, view);
      }
    },
  });
  const flushDraft = async () => {
    // Debounce, blur and collapse saves start no fresh Host write once
    // admission closes. The retained draft is written by the next admitted or
    // quit flush.
    activity.assertOpen();
    return coordinator.flush();
  };
  widget = createTodoWindow({ ...input, activity, getView: coordinator.view,
    onWindow: coordinator.setWindow, flush: flushDraft });
  const window = widget;
  let appearanceRead: Promise<void> | null = null;
  function refreshAppearance(): Promise<void> {
    // An already admitted read stays visible; a closed gate starts no fresh effect.
    if (appearanceRead) return appearanceRead;
    if (activity.isClosed()) return Promise.resolve();
    const operation = (async () => {
      try {
        const settings = await owner().call<AppSettings>("settings.get");
        // The owner was disposed while this read was outstanding: the reply is
        // neither applied nor published, and it stays uncertain.
        if (closed || activity.isClosed()) { activity.unsettled(); return; }
        coordinator.setAppearance({ language: settings.language, theme: settings.theme, fontFamily: settings.fontFamily });
      } catch (error) { input.log("personal todo appearance could not be loaded", error); }
    })();
    appearanceRead = operation;
    void operation.finally(() => { if (appearanceRead === operation) appearanceRead = null; });
    return operation;
  }
  async function open(focus = true) {
    void refreshAppearance();
    // This open sequence fixes its owner before it awaits the window. A failed
    // capture stays a refusal for this sequence, so it never reads a Host that
    // appears during the await; show() still decides the closed-gate refusal.
    const captured = captureOwnerOrRefusal();
    await window.show(focus);
    await coordinator.get(captured).catch(() => undefined);
  }
  function assertSender(event: IpcMainInvokeEvent, allowMain = false) {
    const main = input.getMainWindow();
    const isMain = allowMain && main && !main.isDestroyed()
      && event.sender === main.webContents && event.senderFrame === main.webContents.mainFrame;
    if (!isMain && !window.owns(event)) throw todoError("PERMISSION_DENIED", "Invalid personal todo window");
  }
  return {
    open, refreshAppearance,
    /** Synchronous obstruction view; never constructs the widget or the Host. */
    getHandoffActivity: () => activity.snapshot(),
    register(registrar: IpcRegistrar) {
      registrar.handleWithEvent(IPC.invoke.personalTodosGet, async (event) => {
        assertSender(event, true);
        void refreshAppearance();
        return coordinator.get();
      });
      registrar.handleWithEvent(IPC.invoke.personalTodosEdit, async (event, raw: unknown) => {
        assertSender(event);
        const value = record(raw, ["items", "expectedEditVersion"]);
        if (!Number.isSafeInteger(value.expectedEditVersion) || Number(value.expectedEditVersion) < 0) {
          throw todoError("INVALID_ARGUMENT", "Invalid personal todo edit version");
        }
        return coordinator.edit({ items: parseItems(value.items), expectedEditVersion: value.expectedEditVersion as number });
      });
      registrar.handleWithEvent(IPC.invoke.personalTodosFlush, async (event) => {
        assertSender(event); return coordinator.flush();
      });
      registrar.handleWithEvent(IPC.invoke.personalTodosWindow, async (event, raw: unknown) => {
        const value = record(raw, ["action", "value"]);
        assertSender(event, value.action === "open");
        if (value.action === "open" && value.value === undefined) await open();
        else if (value.action === "collapse" && value.value === undefined) window.collapse();
        else if (value.action === "pin" && typeof value.value === "boolean") window.setPinned(value.value);
        else throw todoError("INVALID_ARGUMENT", "Invalid personal todo window action");
        return coordinator.view();
      });
      registrar.handleWithEvent(IPC.invoke.personalTodosCopy, async (event, raw: unknown) => {
        assertSender(event);
        const value = record(raw, ["title", "note"]);
        const title = text(value.title, PERSONAL_TODO_MAX_TITLE);
        const note = text(value.note, PERSONAL_TODO_MAX_NOTE);
        clipboard.writeText(note ? `${title}\n\n${note}` : title);
        return { copied: true };
      });
      registrar.handleWithEvent(IPC.invoke.personalTodosQuitReady, async (event, raw: unknown) => {
        assertSender(event);
        const value = record(raw, ["requestId"]);
        window.editorReady(text(value.requestId, 128));
        return { accepted: true };
      });
    },
    async prepareQuit(): Promise<boolean> {
      // Shutdown calls this before the application gate is disposed, so a gate
      // that is already closed means an external handoff owns admission. Refuse
      // without draining, writing, opening a window or starting a dialog loop.
      if (activity.isClosed()) {
        input.log("personal todo quit refused: handoff admission is closed", "HOST_BUSY");
        return false;
      }
      for (;;) {
        try {
          // One quit attempt keeps the owner it captured before it awaits the
          // editor. A missing owner stays a refusal for this attempt, so a Host
          // that appears during the drain never receives this attempt's draft.
          // A clean board never reaches the flush, so it can still quit.
          const captured = captureOwnerOrRefusal();
          await window.drainEditor();
          coordinator.freeze(true);
          // A failed initial read without edits must not trap users in the app.
          if (coordinator.view().editVersion > coordinator.view().savedEditVersion) await coordinator.flush(captured);
          window.allowClose();
          return true;
        } catch (error) {
          coordinator.freeze(false);
          window.resumeEditor();
          // Admission closed while draining: the draft and its idempotency token
          // stay owned, no fresh write is attempted, and no dialog is raised for
          // a refusal the user cannot resolve by retrying.
          if (isGateRefusal(error)) {
            input.log("personal todo quit flush refused: handoff admission is closed", error);
            return false;
          }
          input.log("personal todo quit flush failed", error);
          await open().catch(() => undefined);
          const locale = coordinator.view().appearance.language;
          const labels = catalogs[resolveLocale(locale === "auto" || !locale ? app.getLocale() : locale)].personalTodos;
          const choice = await dialog.showMessageBox({ type: "error", message: labels.quitSaveFailed,
            buttons: [labels.cancelQuit, labels.retryQuit], defaultId: 1, cancelId: 0 });
          if (choice.response === 0) return false;
        }
      }
    },
    dispose() {
      closed = true;
      // The window releases native handles first; the coordinator then reports an
      // unsaved draft it can no longer commit instead of claiming success.
      window.dispose();
      coordinator.dispose();
      activity.seal();
    },
  };
}
export type PersonalTodosRuntime = ReturnType<typeof createPersonalTodos>;
