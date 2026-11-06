import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "i18next";
import {
  IPC,
  type PersonalTodoAppearance,
  type PersonalTodoEdit,
  type PersonalTodoItem,
  type PersonalTodoView,
} from "@pi-desktop/shared";
import {
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconListChecks,
  IconPin,
  IconPlus,
  IconTrash,
} from "../../components/icons";
import { Button, Checkbox, Input, Textarea, TooltipButton } from "../../components/ui";
import { loadRendererCatalog } from "../../lib/renderer-catalogs";
import { flattenCatalog, resolveLocale } from "@pi-desktop/i18n/locale-info";
import "../../styles/personal-todos.css";

type WidgetState = {
  items: PersonalTodoItem[];
  view: PersonalTodoView | null;
  loading: boolean;
  error: string | null;
  saveError: string | null;
  conflict: boolean;
  saving: boolean;
  copiedId: string | null;
};

const initialState: WidgetState = {
  items: [], view: null, loading: true, error: null, saveError: null,
  conflict: false, saving: false, copiedId: null,
};

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const bridge = window.piDesktop;
  if (!bridge?.invoke) throw new Error("Personal todo bridge unavailable");
  const result = await bridge.invoke<T>(channel, ...(payload === undefined ? [] : [payload]));
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.data;
}

function sameItems(a: PersonalTodoItem[], b: PersonalTodoItem[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index];
    return other?.id === item.id && other.title === item.title && other.note === item.note && other.completed === item.completed;
  });
}

function useWidgetAppearance(appearance: PersonalTodoAppearance | undefined): void {
  useEffect(() => {
    if (!appearance) return;
    let current = true;
    const root = document.documentElement;
    const language = appearance.language;
    const locale = resolveLocale(language === "auto" ? (window.piDesktop?.locale ?? navigator.language) : language ?? "en");
    let languageRequest = 0;
    const request = ++languageRequest;
    void loadRendererCatalog(locale).then(async (catalog) => {
      if (!current || request !== languageRequest) return;
      i18n.addResourceBundle(locale, "translation", flattenCatalog(catalog), true, true);
      if (i18n.language !== locale) await i18n.changeLanguage(locale);
      if (current && request === languageRequest) document.documentElement.lang = locale;
    }).catch((error: unknown) => console.error("Failed to apply personal todo language", error));
    const theme = appearance.theme;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const applySystemTheme = () => { root.dataset.theme = media.matches ? "light" : "dark"; };
    if (theme === "light" || theme === "dark") root.dataset.theme = theme;
    else if (theme === "system") {
      applySystemTheme();
      media.addEventListener("change", applySystemTheme);
    } else {
      // Plugin themes require the full app theme registry; fall back to the
      // system appearance instead of booting the app store in this surface.
      root.dataset.theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    if (appearance.fontFamily) root.style.setProperty("--font-sans", appearance.fontFamily);
    else root.style.removeProperty("--font-sans");
    return () => {
      current = false;
      if (theme === "system") media.removeEventListener("change", applySystemTheme);
    };
  }, [appearance?.language, appearance?.theme, appearance?.fontFamily]);
}

export function PersonalTodosWidget() {
  const { t } = useTranslation();
  const [state, setState] = useState<WidgetState>(initialState);
  const [expandedNotes, setExpandedNotes] = useState<Set<string>>(() => new Set());
  const [copyError, setCopyError] = useState(false);
  const [statusAnnouncement, setStatusAnnouncement] = useState<string | null>(null);
  const [quitSaveError, setQuitSaveError] = useState(false);
  const [preparingQuit, setPreparingQuit] = useState(false);
  const quitRequest = useRef<string | null>(null);
  const latestItems = useRef<PersonalTodoItem[]>([]);
  const viewRef = useRef<PersonalTodoView | null>(null);
  const sentVersion = useRef(0);
  const localVersion = useRef(0);
  const acknowledgedLocalVersion = useRef(0);
  const inFlight = useRef(false);
  const pendingVersion = useRef<number | null>(null);
  const activeSequence = useRef<number | null>(null);
  const activeItems = useRef<PersonalTodoItem[] | null>(null);
  const pausedAfterError = useRef(false);
  const mounted = useRef(true);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingWaiters = useRef<Array<{ resolve: () => void; reject: (error: Error) => void }>>([]);
  const appearance = state.view?.appearance;
  useWidgetAppearance(appearance);

  const applyView = useCallback((view: PersonalTodoView, fromEvent = false) => {
    if (!view.document) {
      if (!viewRef.current?.document) {
        viewRef.current = null;
        setState((old) => ({ ...old, view, loading: view.saveStatus === "loading",
          error: view.error ? t("personalTodos.loadingFailed") : null }));
      }
      return;
    }
    const prior = viewRef.current;
    if (prior && view.editVersion < prior.editVersion) return;
    viewRef.current = view;
    const eventIsOurAck = sameItems(latestItems.current, view.items);
    const eventIsActiveAck = inFlight.current && activeItems.current !== null && sameItems(activeItems.current, view.items);
    if (eventIsActiveAck && activeSequence.current !== null) acknowledgedLocalVersion.current = Math.max(acknowledgedLocalVersion.current, activeSequence.current);
    else if (eventIsOurAck) acknowledgedLocalVersion.current = localVersion.current;
    const hasLocalDraft = pendingVersion.current !== null || inFlight.current || localVersion.current > acknowledgedLocalVersion.current;
    if (hasLocalDraft && fromEvent && !eventIsOurAck && !eventIsActiveAck && view.editVersion > sentVersion.current) {
      viewRef.current = view;
      setState((old) => ({ ...old, view, conflict: true, saving: false,
        saveError: view.error ? t("personalTodos.saveFailed") : null }));
      return;
    }
    if (!hasLocalDraft || eventIsOurAck || eventIsActiveAck || !fromEvent) {
      sentVersion.current = Math.max(sentVersion.current, view.editVersion);
    }
    if (eventIsActiveAck) {
      sentVersion.current = Math.max(sentVersion.current, view.editVersion);
      setState((old) => ({ ...old, view, loading: false, error: null, saving: true, conflict: false }));
      return;
    }
    if (!hasLocalDraft || eventIsOurAck) {
      latestItems.current = view.items.map((item) => ({ ...item }));
      localVersion.current = Math.max(localVersion.current, view.editVersion);
      acknowledgedLocalVersion.current = Math.max(acknowledgedLocalVersion.current, localVersion.current);
      setState((old) => ({ ...old, items: latestItems.current, view, loading: false, error: null,
        saveError: view.error ? t("personalTodos.saveFailed") : null, saving: view.saveStatus === "saving" || view.saveStatus === "pending",
        conflict: false }));
      return;
    }
    setState((old) => ({ ...old, view, loading: false, error: null,
      saving: inFlight.current || view.saveStatus === "saving" || view.saveStatus === "pending" }));
  }, [t]);

  const load = useCallback(async () => {
    setState((old) => ({ ...old, loading: true, error: null }));
    try {
      const view = await invoke<PersonalTodoView>(IPC.invoke.personalTodosGet);
      applyView(view);
    } catch {
      if (mounted.current) setState((old) => ({ ...old, loading: false, error: t("personalTodos.loadingFailed") }));
    }
  }, [applyView, t]);

  const flushOnBlur = useCallback(async () => {
    try {
      if (pausedAfterError.current || stateRef.current.conflict) throw new Error("save not ready");
      if (pendingVersion.current !== null || inFlight.current) {
        await new Promise<void>((resolve, reject) => pendingWaiters.current.push({ resolve, reject }));
      }
      await invoke<PersonalTodoView>(IPC.invoke.personalTodosFlush);
    } catch {
      if (mounted.current) setState((old) => ({ ...old, saveError: t("personalTodos.saveFailed") }));
    }
  }, [t]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const onBlur = () => {
      if (pendingVersion.current !== null) { void sendPendingRef.current(); }
      void flushOnBlur();
    };
    window.addEventListener("blur", onBlur);
    const unsubscribe = window.piDesktop?.on(IPC.event.personalTodosChanged, (value) => {
      if (value && typeof value === "object") applyView(value as PersonalTodoView, true);
    });
    const unsubscribeQuit = window.piDesktop?.on(IPC.event.personalTodosPrepareQuit, (value) => {
      if (!value || typeof value !== "object" || !("requestId" in value)) return;
      const requestId = value.requestId;
      if (requestId === null) {
        quitRequest.current = null;
        setPreparingQuit(false);
        return;
      }
      if (typeof requestId !== "string" || !requestId) return;
      quitRequest.current = requestId;
      setPreparingQuit(true);
      void (async () => {
        try {
          if (pausedAfterError.current || stateRef.current.conflict) throw new Error("save not ready");
          if (pendingVersion.current !== null || (localVersion.current > acknowledgedLocalVersion.current && !inFlight.current)) {
            pendingVersion.current ??= localVersion.current;
            void sendPendingRef.current();
          }
          if (pendingVersion.current !== null || inFlight.current) {
            await new Promise<void>((resolve, reject) => pendingWaiters.current.push({ resolve, reject }));
          }
          if (quitRequest.current !== requestId) return;
          if (pausedAfterError.current || localVersion.current > acknowledgedLocalVersion.current) throw new Error("draft not accepted");
          await invoke(IPC.invoke.personalTodosQuitReady, { requestId });
          setQuitSaveError(false);
        } catch {
          if (mounted.current && quitRequest.current === requestId) setQuitSaveError(true);
        }
      })();
    });
    return () => {
      mounted.current = false;
      window.removeEventListener("blur", onBlur);
      unsubscribe?.();
      unsubscribeQuit?.();
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, [applyView, flushOnBlur, load]);

  const sendPending = useCallback(async () => {
    if (inFlight.current || !viewRef.current?.document || stateRef.current.conflict) return;
    inFlight.current = true;
    setState((old) => ({ ...old, saving: true, saveError: null }));
    try {
      while (mounted.current && pendingVersion.current !== null) {
        const sequence = pendingVersion.current;
        pendingVersion.current = null;
        activeSequence.current = sequence;
        activeItems.current = latestItems.current.map((item) => ({ ...item }));
        const payload: PersonalTodoEdit = {
          items: activeItems.current,
          expectedEditVersion: sentVersion.current,
        };
        const result = await invoke<PersonalTodoView>(IPC.invoke.personalTodosEdit, payload);
        if (result.editVersion >= sentVersion.current) {
          sentVersion.current = result.editVersion;
          viewRef.current = result;
          acknowledgedLocalVersion.current = Math.max(acknowledgedLocalVersion.current, sequence);
        }
        if (localVersion.current === sequence && sameItems(latestItems.current, result.items)) {
          latestItems.current = result.items.map((item) => ({ ...item }));
          const currentView = viewRef.current;
          const acceptedView = currentView && currentView.editVersion > result.editVersion ? currentView : result;
          setState((old) => ({ ...old, items: latestItems.current, view: acceptedView, saving: false,
            saveError: acceptedView.error ? t("personalTodos.saveFailed") : null, conflict: false }));
        }
      }
      if (mounted.current) setState((old) => ({ ...old, saving: false }));
      activeSequence.current = null;
      activeItems.current = null;
      if (pendingVersion.current === null) {
        pendingWaiters.current.splice(0).forEach(({ resolve }) => resolve());
      }
    } catch (error) {
      pausedAfterError.current = true;
      if (pendingVersion.current === null && activeSequence.current !== null) pendingVersion.current = activeSequence.current;
      if (mounted.current) {
        const conflict = (error as Error & { code?: string }).code === "CONFLICT";
        setState((old) => ({ ...old, saving: false, saveError: conflict ? t("personalTodos.conflict") : t("personalTodos.saveFailed"), conflict }));
      }
      pendingWaiters.current.splice(0).forEach(({ reject }) => reject(error instanceof Error ? error : new Error(String(error))));
    } finally {
      inFlight.current = false;
      activeSequence.current = null;
      activeItems.current = null;
      if (mounted.current && pendingVersion.current !== null && !stateRef.current.conflict && !pausedAfterError.current) void sendPendingRef.current();
      else if (pendingVersion.current === null) {
        pendingWaiters.current.splice(0).forEach(({ resolve }) => resolve());
      }
    }
  }, [t]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const sendPendingRef = useRef(sendPending);
  sendPendingRef.current = sendPending;

  const commitItems = useCallback((items: PersonalTodoItem[]) => {
    if (quitRequest.current !== null) return;
    latestItems.current = items;
    const version = ++localVersion.current;
    pendingVersion.current = version;
    setState((old) => ({ ...old, items, saving: true, saveError: null, conflict: false }));
    if (!inFlight.current) void sendPendingRef.current();
  }, []);

  const retry = useCallback(() => {
    if (!viewRef.current?.document) { void load(); return; }
    void (async () => {
      try {
        if (stateRef.current.conflict) {
          const fresh = await invoke<PersonalTodoView>(IPC.invoke.personalTodosGet);
          sentVersion.current = fresh.editVersion;
          viewRef.current = fresh;
          // The explicit retry authorizes this retained draft over the latest version.
          stateRef.current = { ...stateRef.current, conflict: false };
          setState((old) => ({ ...old, view: fresh, conflict: false }));
        }
        pausedAfterError.current = false;
        if (localVersion.current > acknowledgedLocalVersion.current) pendingVersion.current = localVersion.current;
        await sendPendingRef.current();
        if (pausedAfterError.current || stateRef.current.conflict) throw new Error("draft not accepted");
        if (pendingVersion.current !== null || inFlight.current) {
          await new Promise<void>((resolve, reject) => pendingWaiters.current.push({ resolve, reject }));
        }
        if (pausedAfterError.current || stateRef.current.conflict) throw new Error("draft not accepted");
        applyView(await invoke<PersonalTodoView>(IPC.invoke.personalTodosFlush));
        setQuitSaveError(false);
      } catch {
        if (mounted.current) setState((old) => ({ ...old, saving: false, saveError: t("personalTodos.saveFailed") }));
      }
    })();
  }, [applyView, load, t]);

  const copy = useCallback(async (item: PersonalTodoItem) => {
    try {
      await invoke<void>(IPC.invoke.personalTodosCopy, { title: item.title, note: item.note });
      setCopyError(false);
      setStatusAnnouncement(t("personalTodos.copied"));
      setState((old) => ({ ...old, copiedId: item.id }));
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setState((old) => ({ ...old, copiedId: null })), 1600);
    } catch {
      setCopyError(true);
      setStatusAnnouncement(t("personalTodos.copyFailed"));
    }
  }, [t]);

  const collapse = useCallback(async () => {
    try {
      if (pausedAfterError.current || stateRef.current.conflict) throw new Error("save not ready");
      if (pendingVersion.current !== null || inFlight.current) {
        await new Promise<void>((resolve, reject) => pendingWaiters.current.push({ resolve, reject }));
      }
      await invoke<PersonalTodoView>(IPC.invoke.personalTodosFlush);
      await invoke<PersonalTodoView>(IPC.invoke.personalTodosWindow, { action: "collapse" });
    } catch {
      setState((old) => ({ ...old, saveError: t("personalTodos.saveFailed") }));
    }
  }, [t]);

  const toggleNote = (id: string) => setExpandedNotes((old) => {
    const next = new Set(old);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const addItem = () => {
    const item: PersonalTodoItem = { id: crypto.randomUUID(), title: "", note: "", completed: false };
    commitItems([...latestItems.current, item]);
  };

  const update = (id: string, values: Partial<Pick<PersonalTodoItem, "title" | "note" | "completed">>) => {
    commitItems(latestItems.current.map((item) => item.id === id ? { ...item, ...values } : item));
  };

  const view = state.view;
  const pinned = view?.alwaysOnTop ?? true;
  const remaining = state.items.filter((item) => !item.completed).length;
  const saveStatusKey = state.conflict || state.saveError || state.error ? "saveFailed" : state.saving ? "saving" : view?.saveStatus === "saved" ? "saved" : "saveDelayed";

  if (view?.collapsed) {
    const first = state.items[0];
    const title = state.error ? t("personalTodos.loadingFailed") : first ? first.title || t("personalTodos.untitled") : t("personalTodos.title");
    return <CompactTodo title={title} preparingQuit={preparingQuit} onOpen={() => void invoke<PersonalTodoView>(IPC.invoke.personalTodosWindow, { action: "open" }).then(applyView).catch(() => setStatusAnnouncement(t("personalTodos.loadingFailed")))} announcement={statusAnnouncement} />;
  }
  if (state.error && !view?.document) {
    return <main className="personal-todos personal-todos-state" role="alert"><p>{t("personalTodos.loadingFailed")}</p><TooltipButton type="button" className="personal-todos-text-action" tooltip={t("personalTodos.retry")} onClick={() => void load()}><IconCheck size={15} />{t("personalTodos.retry")}</TooltipButton></main>;
  }
  return (
    <main className="personal-todos" aria-label={t("personalTodos.title")} inert={preparingQuit}>
      <header className="personal-todos-header">
        <span className="personal-todos-heading"><IconListChecks size={18} /><h1>{t("personalTodos.title")}</h1></span>
        <div className="personal-todos-toolbar">
          <TooltipButton type="button" className="personal-todos-icon" tooltip={pinned ? t("personalTodos.unpin") : t("personalTodos.pin")} aria-pressed={pinned} onClick={() => void invoke<PersonalTodoView>(IPC.invoke.personalTodosWindow, { action: "pin", value: !pinned }).then(applyView).catch(() => setState((old) => ({ ...old, saveError: t("personalTodos.saveFailed") })))}><IconPin size={16} /></TooltipButton>
          <TooltipButton type="button" className="personal-todos-icon" tooltip={t("personalTodos.collapse")} onClick={() => void collapse()}><IconChevronDown size={16} /></TooltipButton>
        </div>
      </header>
      <div className="personal-todos-list" aria-busy={state.loading}>
        {state.loading && !view ? <p className="personal-todos-empty">{t("personalTodos.loading")}</p> : null}
        {!state.loading && state.items.length === 0 ? <p className="personal-todos-empty">{t("personalTodos.empty")}</p> : null}
        {state.items.map((item) => {
          const noteExpanded = expandedNotes.has(item.id);
          return <article className="personal-todo-row" key={item.id}>
            <Checkbox className="personal-todo-check" checked={item.completed} label={<span className="personal-todos-visually-hidden">{t("personalTodos.toggleCompleted", { title: item.title || t("personalTodos.untitled") })}</span>} onChange={(event) => update(item.id, { completed: event.currentTarget.checked })} />
            <div className="personal-todo-content">
              <Input className={item.completed ? "personal-todo-title is-completed" : "personal-todo-title"} value={item.title} aria-label={t("personalTodos.editTitle", { title: item.title || t("personalTodos.untitled") })} placeholder={t("personalTodos.titlePlaceholder")} onChange={(event) => update(item.id, { title: event.currentTarget.value })} />
              <button type="button" className="personal-todo-note-toggle" aria-expanded={noteExpanded} onClick={() => toggleNote(item.id)}>{noteExpanded ? t("personalTodos.note") : t("personalTodos.addNote")}</button>
              {noteExpanded ? <Textarea className="personal-todo-note" aria-label={t("personalTodos.editNote", { title: item.title || t("personalTodos.untitled") })} placeholder={t("personalTodos.notePlaceholder")} value={item.note} onChange={(event) => update(item.id, { note: event.currentTarget.value })} rows={3} /> : null}
            </div>
            <div className="personal-todo-actions">
              <TooltipButton type="button" className="personal-todos-icon" tooltip={copyError ? t("personalTodos.copyFailed") : state.copiedId === item.id ? t("personalTodos.copied") : t("personalTodos.copy")} ariaLabel={copyError ? t("personalTodos.copyFailed") : state.copiedId === item.id ? t("personalTodos.copied") : t("personalTodos.copy")} onClick={() => void copy(latestItems.current.find((current) => current.id === item.id) ?? item)}><IconCopy size={15} /></TooltipButton>
              <TooltipButton type="button" className="personal-todos-icon personal-todo-delete" tooltip={t("personalTodos.delete")} onClick={() => commitItems(latestItems.current.filter((current) => current.id !== item.id))}><IconTrash size={15} /></TooltipButton>
            </div>
          </article>;
        })}
      </div>
      <footer className="personal-todos-footer">
        <TooltipButton type="button" className="personal-todos-add" tooltip={t("personalTodos.add")} disabled={state.loading || !view || state.conflict} onClick={addItem}><IconPlus size={16} /><span>{t("personalTodos.add")}</span></TooltipButton>
        <span className="personal-todos-remaining">{t("personalTodos.remaining", { count: remaining })}</span>
      </footer>
      <span className="personal-todos-visually-hidden" aria-live="polite">{statusAnnouncement}</span>
      <div className={`personal-todos-status ${state.saveError || state.error || quitSaveError ? "is-error" : ""}`} role={state.saveError || state.error || quitSaveError ? "alert" : "status"}>
        <span>{quitSaveError ? t("personalTodos.quitSaveFailed") : state.conflict ? t("personalTodos.conflict") : t(`personalTodos.${saveStatusKey}`)}</span>
        {state.saveError || state.error || quitSaveError ? <button type="button" className="personal-todos-retry" onClick={retry}>{t("personalTodos.retry")}</button> : null}
      </div>
    </main>
  );
}

function CompactTodo({ title, preparingQuit, onOpen, announcement }: {
  title: string;
  preparingQuit: boolean;
  onOpen(): void;
  announcement?: string | null;
}) {
  const { t } = useTranslation();
  return <main className="personal-todos is-collapsed" aria-label={t("personalTodos.title")} inert={preparingQuit}>
    <span className="personal-todos-drag"><IconListChecks size={16} /></span>
    <Button className="personal-todos-expand" variant="ghost" aria-label={t("personalTodos.open")} title={title} onClick={onOpen}>
      <span className="personal-todos-summary">{title}</span><IconChevronDown size={16} />
    </Button>
    <span className="personal-todos-visually-hidden" role="status">{announcement}</span>
  </main>;
}
