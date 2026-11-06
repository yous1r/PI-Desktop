import { app, clipboard, dialog, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { catalogs, resolveLocale } from "@pi-desktop/i18n";
import {
  IPC, PERSONAL_TODO_MAX_NOTE, PERSONAL_TODO_MAX_TITLE,
  type AppSettings, type PersonalTodoDocument,
} from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "../ipc/types";
import { createTodoCoordinator } from "./coordinator";
import { createTodoWindow, type TodoWindow } from "./window";
import { parseItems, record, text, todoError } from "./validation";

export function createPersonalTodos(input: {
  dataDir: string;
  getHost(): HostProcess | null;
  getMainWindow(): BrowserWindow | null;
  log(message: string, error: unknown): void;
}) {
  let widget: TodoWindow | null = null;
  const host = () => {
    const current = input.getHost();
    if (!current) throw todoError("HOST_UNAVAILABLE", "Personal todo storage is unavailable");
    return current;
  };
  const coordinator = createTodoCoordinator({
    persistence: {
      get: () => host().call<PersonalTodoDocument>("personalTodos.get"),
      replace: (change) => host().call<PersonalTodoDocument>("personalTodos.replace", change),
    },
    publish(view) {
      widget?.publish(view);
      const main = input.getMainWindow();
      if (main && !main.isDestroyed() && !main.webContents.isDestroyed()) {
        main.webContents.send(IPC.event.personalTodosChanged, view);
      }
    },
  });
  widget = createTodoWindow({ ...input, getView: coordinator.view,
    onWindow: coordinator.setWindow, flush: coordinator.flush });
  const window = widget;
  let appearanceRead: Promise<void> | null = null;
  function refreshAppearance(): Promise<void> {
    if (appearanceRead) return appearanceRead;
    const operation = (async () => {
      try {
        const settings = await host().call<AppSettings>("settings.get");
        coordinator.setAppearance({ language: settings.language, theme: settings.theme, fontFamily: settings.fontFamily });
      } catch (error) { input.log("personal todo appearance could not be loaded", error); }
    })();
    appearanceRead = operation;
    void operation.finally(() => { if (appearanceRead === operation) appearanceRead = null; });
    return operation;
  }
  async function open(focus = true) {
    void refreshAppearance();
    await window.show(focus);
    await coordinator.get().catch(() => undefined);
  }
  function assertSender(event: IpcMainInvokeEvent, allowMain = false) {
    const main = input.getMainWindow();
    const isMain = allowMain && main && !main.isDestroyed()
      && event.sender === main.webContents && event.senderFrame === main.webContents.mainFrame;
    if (!isMain && !window.owns(event)) throw todoError("PERMISSION_DENIED", "Invalid personal todo window");
  }
  return {
    open, refreshAppearance,
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
      for (;;) {
        try {
          await window.drainEditor();
          coordinator.freeze(true);
          // A failed initial read without edits must not trap users in the app.
          if (coordinator.view().editVersion > coordinator.view().savedEditVersion) await coordinator.flush();
          window.allowClose();
          return true;
        } catch (error) {
          coordinator.freeze(false);
          window.resumeEditor();
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
    dispose() { window.dispose(); coordinator.dispose(); },
  };
}
export type PersonalTodosRuntime = ReturnType<typeof createPersonalTodos>;
