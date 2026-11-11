import { useEffect, useSyncExternalStore, useState } from "react";
import { useTranslation } from "react-i18next";
import { commandCenterTaskKey } from "@pi-desktop/shared";
import {
  CommandCenterSurface,
  COMMAND_CENTER_I18N_NAMESPACE,
} from "../../components/command-center";
import { useAppStore } from "../../stores/app-store";
import {
  COMMAND_CENTER_FIXTURE_PROVIDER,
  type CommandCenterDataProvider,
} from "./command-center-data";

/**
 * Full-window command-center route.
 *
 * The V3 surface replaces the chat shell while it is open: it owns the whole
 * client area, its own top toolbar and no global left sidebar. The route passes
 * only deterministic preview data and the shell's Settings navigation port; it
 * declares no live Host producer, so every control that needs a negotiated
 * capability stays unavailable and the surface says why. Task selection is
 * local recall only: it remembers which reported row was opened and never
 * attaches or invents a conversation.
 *
 * A caller may inject an explicit data provider (see `command-center-data.ts`).
 * Without one the route keeps the fixture preview byte-for-byte and the Host
 * status says offline; the provider itself is owned by the injecting caller.
 */
export function CommandCenterPage({ provider }: { readonly provider?: CommandCenterDataProvider } = {}) {
  const { t } = useTranslation(COMMAND_CENTER_I18N_NAMESPACE);
  const setPage = useAppStore((state) => state.setPage);
  const [selectedTaskKey, setSelectedTaskKey] = useState<string>();
  const activeProvider = provider ?? COMMAND_CENTER_FIXTURE_PROVIDER;
  const data = useSyncExternalStore(activeProvider.subscribe, activeProvider.getState, activeProvider.getState);
  useEffect(() => {
    if (provider === undefined) return;
    void provider.refresh();
  }, [provider]);

  return (
    <div className="command-center-route" data-route="command-center">
      <div className="command-center-route-surface">
        <CommandCenterSurface
          workspaces={data.workspaces}
          snapshot={data.snapshot}
          receipts={data.receipts}
          hostStatus={{ label: t("route.hostLabel"), state: data.host.state }}
          selectedTaskKey={selectedTaskKey}
          onOpenSettings={() => setPage("settings")}
          onSelectTask={(target) => setSelectedTaskKey(commandCenterTaskKey(target))}
        />
      </div>
      {data.source === "fixture" ? (
        <p className="command-center-route-notice" data-command-center="preview-notice" role="note">
          {t("route.previewNotice")}
        </p>
      ) : null}
    </div>
  );
}
