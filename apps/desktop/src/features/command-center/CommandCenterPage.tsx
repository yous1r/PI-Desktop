import { useState } from "react";
import { useTranslation } from "react-i18next";
import { commandCenterTaskKey } from "@pi-desktop/shared";
import {
  CommandCenterSurface,
  COMMAND_CENTER_I18N_NAMESPACE,
} from "../../components/command-center";
import { useAppStore } from "../../stores/app-store";
import {
  COMMAND_CENTER_PREVIEW_RECEIPTS,
  COMMAND_CENTER_PREVIEW_SNAPSHOT,
  COMMAND_CENTER_PREVIEW_WORKSPACES,
} from "./command-center-fixtures";

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
 */
export function CommandCenterPage() {
  const { t } = useTranslation(COMMAND_CENTER_I18N_NAMESPACE);
  const setPage = useAppStore((state) => state.setPage);
  const [selectedTaskKey, setSelectedTaskKey] = useState<string>();
  return (
    <div className="command-center-route" data-route="command-center">
      <div className="command-center-route-surface">
        <CommandCenterSurface
          workspaces={COMMAND_CENTER_PREVIEW_WORKSPACES}
          snapshot={COMMAND_CENTER_PREVIEW_SNAPSHOT}
          receipts={COMMAND_CENTER_PREVIEW_RECEIPTS}
          hostStatus={{ label: t("route.hostLabel"), state: "offline" }}
          selectedTaskKey={selectedTaskKey}
          onOpenSettings={() => setPage("settings")}
          onSelectTask={(target) => setSelectedTaskKey(commandCenterTaskKey(target))}
        />
      </div>
      <p className="command-center-route-notice" data-command-center="preview-notice" role="note">
        {t("route.previewNotice")}
      </p>
    </div>
  );
}
