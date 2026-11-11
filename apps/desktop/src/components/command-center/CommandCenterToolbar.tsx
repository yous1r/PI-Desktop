import type { TFunction } from "i18next";
import { LayoutGrid } from "lucide-react";
import { IconClock, IconGear } from "../icons";
import { TooltipButton, cx } from "../ui";
import type { CommandCenterHostStatus } from "./view/command-center-view";

export type CommandCenterToolbarDestination = "overview" | "history" | "workspace" | "settings";

const HOST_STATE_KEYS = {
  connected: "toolbar.hostState.connected",
  stale: "toolbar.hostState.stale",
  offline: "toolbar.hostState.offline",
} as const;

/**
 * V3 top toolbar: the global destinations are icon buttons with hover/focus
 * tooltips and accessible names, and the local Host status sits at the right.
 * There is no global left sidebar; a destination is marked with `aria-current`
 * so a screen reader can tell where the user is without relying on colour.
 *
 * Settings is owned by the desktop shell, so the button is disabled until the
 * parent passes its navigation port rather than pretending the page exists.
 */
export function CommandCenterToolbar({
  t,
  destination,
  onOpenOverview,
  onOpenHistory,
  onOpenSettings,
  hostStatus,
}: {
  readonly t: TFunction;
  readonly destination: CommandCenterToolbarDestination;
  readonly onOpenOverview: () => void;
  readonly onOpenHistory: () => void;
  readonly onOpenSettings?: () => void;
  readonly hostStatus?: CommandCenterHostStatus;
}) {
  const buttonClass = (active: boolean) =>
    cx(
      "rounded-md p-1.5",
      active ? "bg-bg-active text-text-primary" : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
    );
  return (
    <header
      className="flex flex-wrap items-center gap-3 border-b border-border-default px-4 py-2"
      data-command-center="toolbar"
    >
      <span className="text-sm font-semibold text-text-primary">{t("brand")}</span>
      <nav className="flex items-center gap-1" aria-label={t("toolbar.navigation")}>
        <TooltipButton
          type="button"
          className={buttonClass(destination === "overview")}
          tooltip={t("toolbar.overview")}
          onClick={onOpenOverview}
          aria-current={destination === "overview" ? "page" : undefined}
        >
          <LayoutGrid size={16} strokeWidth={1.75} aria-hidden="true" />
        </TooltipButton>
        <TooltipButton
          type="button"
          className={buttonClass(destination === "history")}
          tooltip={t("toolbar.history")}
          onClick={onOpenHistory}
          aria-current={destination === "history" ? "page" : undefined}
        >
          <IconClock size={16} aria-hidden="true" />
        </TooltipButton>
        <TooltipButton
          type="button"
          className={buttonClass(destination === "settings")}
          tooltip={t("toolbar.settings")}
          onClick={() => onOpenSettings?.()}
          disabled={onOpenSettings === undefined}
          aria-current={destination === "settings" ? "page" : undefined}
        >
          <IconGear size={16} aria-hidden="true" />
        </TooltipButton>
      </nav>
      {hostStatus === undefined ? null : (
        <span
          className="ml-auto flex items-center gap-2 text-xs text-text-secondary"
          role="status"
          aria-label={t("toolbar.hostStatus", {
            name: hostStatus.label,
            state: t(HOST_STATE_KEYS[hostStatus.state]),
          })}
        >
          <span
            aria-hidden="true"
            className={cx(
              "h-1.5 w-1.5 rounded-full",
              hostStatus.state === "connected"
                ? "bg-success"
                : hostStatus.state === "stale"
                  ? "bg-warning"
                  : "bg-error",
            )}
          />
          <span>{hostStatus.label}</span>
        </span>
      )}
    </header>
  );
}
