import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import { terminalWorkspaceId } from "@pi-desktop/shared";
import { terminalWorkPanelTab } from "../../lib/work-panel-tabs";
import { useAppStore } from "../../stores/app-store";
import { IconClose, IconPlus } from "../icons";
import { Button, TooltipButton } from "../ui";
import { TerminalTab } from "../workpanel/TerminalTab";

/** Remote-Agent sessions share the ordinary panel's tab ownership and cleanup. */
export function RemoteTerminalTabs({ session }: { session: SessionSummary }) {
  const { t } = useTranslation();
  const context = useAppStore(state => state.workPanelContexts[session.id]);
  const buttons = useRef<Record<string, HTMLButtonElement | null>>({});
  const addButton = useRef<HTMLButtonElement | null>(null);
  const tabs = context?.tabs.filter(tab => tab.kind === "terminal") ?? [];
  const active = tabs.find(tab => tab.id === context?.activeTabId) ?? tabs[0];
  const hostKey = session.remoteWorkspace?.hostKey ?? session.remoteHostKey;
  const hostLabel = session.remoteHostLabel ?? hostKey;
  const create = useCallback(() => {
    const state = useAppStore.getState();
    if (state.activeSessionId !== session.id) return;
    state.openWorkPanelTabForSession(session.id, terminalWorkPanelTab({
      sessionId: session.id,
      workspaceId: terminalWorkspaceId({ hostKey, path: session.remoteWorkspace?.path }),
    }));
  }, [session.id, hostKey, session.remoteWorkspace?.path]);
  useEffect(() => {
    // Initialize once. An explicitly emptied context stays empty on remount.
    if (!useAppStore.getState().workPanelContexts[session.id]) create();
  }, [session.id, create]);
  useLayoutEffect(() => {
    if (active) buttons.current[active.id]?.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active?.id, tabs.length]);
  const activate = (id: string) => {
    if (useAppStore.getState().activeSessionId !== session.id) return;
    useAppStore.getState().activateWorkPanelTab(id);
    buttons.current[id]?.focus();
  };
  const close = (id: string) => {
    const state = useAppStore.getState();
    if (state.activeSessionId !== session.id) return;
    state.closeWorkPanelTab(id);
    const next = useAppStore.getState().workPanelContexts[session.id]?.activeTabId;
    if (next) buttons.current[next]?.focus();
    else addButton.current?.focus();
  };
  return <div className="remote-terminal-tabs">
    <div className="remote-terminal-tabs__bar">
      <div className="remote-terminal-tabs__list" role="tablist" aria-label={t("panel.tabs.terminal")}>
        {tabs.map((tab, index) => {
          const label = `${t("panel.tabs.terminal")} ${index + 1}`;
          return <div className="remote-terminal-tabs__item" key={tab.id}>
            <Button ref={node => { buttons.current[tab.id] = node; }} variant="ghost" role="tab"
              id={`remote-terminal-tab-${tab.id}`} aria-selected={active?.id === tab.id}
              aria-controls={`remote-terminal-surface-${tab.id}`} tabIndex={active?.id === tab.id ? 0 : -1}
              onClick={() => activate(tab.id)} onKeyDown={event => {
                const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
                  : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
                if (next >= 0) { event.preventDefault(); activate(tabs[next].id); }
              }}>{label}</Button>
            <TooltipButton className="terminal-tab__restart" tooltip={t("panel.closeTab", { name: label })}
              ariaLabel={t("panel.closeTab", { name: label })} onClick={() => close(tab.id)}>
              <IconClose size={12} />
            </TooltipButton>
          </div>;
        })}
      </div>
      <TooltipButton ref={addButton} className="terminal-tab__restart" tooltip={t("panel.terminal.new")}
        ariaLabel={t("panel.terminal.new")} onClick={create}><IconPlus size={14} /></TooltipButton>
    </div>
    {active?.terminal ? <div key={active.id} id={`remote-terminal-surface-${active.id}`}
      className="remote-terminal-tabs__pane" role="tabpanel" aria-labelledby={`remote-terminal-tab-${active.id}`}>
      <TerminalTab tabId={active.id} target={active.terminal}
        hostKey={hostKey} hostLabel={hostLabel} workspacePath={session.remoteWorkspace?.path}
        onCloseTerminal={() => close(active.id)} />
    </div> : <div className="remote-terminal-tabs__empty">
      <Button onClick={create}>{t("panel.terminal.new")}</Button>
    </div>}
  </div>;
}
