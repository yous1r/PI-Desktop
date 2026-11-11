import type { TFunction } from "i18next";
import { cx } from "../ui";
import type { CommandCenterWorkspaceEntry } from "./view/command-center-view";

/**
 * Workspace entry previews for the overview: one button per enabled workspace,
 * labelled with its real name and its current agent count. The A/B/C prefix is
 * the design position, not a stored identity; the workspace id keys the entry.
 */
export function CommandCenterWorkspaceEntryList({
  t,
  entries,
  onOpenWorkspace,
}: {
  readonly t: TFunction;
  readonly entries: readonly CommandCenterWorkspaceEntry[];
  readonly onOpenWorkspace: (workspaceId: string) => void;
}) {
  if (entries.length === 0) {
    return (
      <div className="space-y-1" data-command-center="workspace-entries-empty">
        <p className="text-sm text-text-secondary">{t("overview.workspacesEmpty")}</p>
        <p className="text-xs text-text-muted">{t("overview.workspacesEmptyHint")}</p>
      </div>
    );
  }
  return (
    <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label={t("overview.workspacesTitle")}>
      {entries.map((entry) => (
        <li key={entry.workspaceId}>
          <button
            type="button"
            data-command-center="workspace-entry"
            data-workspace-id={entry.workspaceId}
            className="flex min-w-[10rem] flex-col gap-1 rounded-lg border border-border-default bg-bg-secondary px-3 py-2 text-left hover:border-border-strong hover:bg-bg-hover"
            aria-label={t("overview.entryOpenAgents", {
              letter: entry.letter,
              name: entry.name,
              count: entry.activeAgents,
              max: entry.maxAgents,
            })}
            onClick={() => onOpenWorkspace(entry.workspaceId)}
          >
            <span className="text-sm font-semibold text-text-primary">
              {t("overview.entryLabel", { letter: entry.letter, name: entry.name })}
            </span>
            <span className="text-xs text-text-secondary">
              {t("overview.entryAgents", { count: entry.activeAgents, max: entry.maxAgents })}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Compact workspace switcher shown at the top right of a focused workspace.
 * It is the same set of destinations, so the user cannot reach a fourth
 * workspace and cannot leave the current one by switching tabs.
 */
export function CommandCenterWorkspaceTabStrip({
  t,
  entries,
  focusedWorkspaceId,
  onOpenWorkspace,
}: {
  readonly t: TFunction;
  readonly entries: readonly CommandCenterWorkspaceEntry[];
  readonly focusedWorkspaceId: string;
  readonly onOpenWorkspace: (workspaceId: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <nav className="flex flex-wrap justify-end gap-1" aria-label={t("workspace.tabsLabel")} data-command-center="workspace-tabs">
      {entries.map((entry) => {
        const current = entry.workspaceId === focusedWorkspaceId;
        return (
          <button
            key={entry.workspaceId}
            type="button"
            data-command-center="workspace-tab"
            data-workspace-id={entry.workspaceId}
            aria-current={current ? "page" : undefined}
            aria-label={t("workspace.tabOpen", { letter: entry.letter, name: entry.name })}
            className={cx(
              "rounded-md border px-2 py-1 text-xs font-semibold",
              current
                ? "border-border-strong bg-bg-active text-text-primary"
                : "border-border-default bg-bg-secondary text-text-secondary hover:bg-bg-hover",
            )}
            onClick={() => onOpenWorkspace(entry.workspaceId)}
          >
            {t("overview.entryLabel", { letter: entry.letter, name: entry.name })}
          </button>
        );
      })}
    </nav>
  );
}
