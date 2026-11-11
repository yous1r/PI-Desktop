import type { TFunction } from "i18next";
import type { CommandCenterMonitorSnapshot, CommandCenterWorkspace } from "@pi-desktop/shared";
import { Badge, Panel } from "../ui";
import { CommandCenterTaskList } from "./CommandCenterTaskList";
import { CommandCenterWorkspaceEntryList } from "./CommandCenterWorkspaceEntries";
import { selectOverviewView, selectWorkspaceEntries } from "./view/command-center-view";

/**
 * The permanent V3 overview: monitoring at upper left, workspace entry previews
 * at upper right, and two lower regions that stay unassigned.
 *
 * The lower regions are deliberately static sections: they carry no focusable
 * descendant, no handler and no placeholder feature. The design leaves them
 * undecided, so the component must not invent a purpose for them later.
 */
export function CommandCenterOverview({
  t,
  workspaces,
  snapshot,
  onOpenWorkspace,
}: {
  readonly t: TFunction;
  readonly workspaces: readonly CommandCenterWorkspace[];
  readonly snapshot?: CommandCenterMonitorSnapshot;
  readonly onOpenWorkspace: (workspaceId: string) => void;
}) {
  const overview = selectOverviewView(snapshot);
  const entries = selectWorkspaceEntries(workspaces, snapshot);
  return (
    <section
      className="flex flex-col gap-4 p-6"
      data-command-center="overview"
      aria-labelledby="command-center-overview-title"
    >
      <h1 id="command-center-overview-title" className="text-lg font-semibold text-text-primary">
        {t("overview.title")}
      </h1>
      <div className="grid grid-cols-2 gap-4">
        <Panel className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-sm font-semibold text-text-primary">{t("overview.monitorTitle")}</h2>
            <Badge tone={overview.attentionCount > 0 ? "warning" : "neutral"}>
              {t("overview.needsInput", { count: overview.attentionCount })}
            </Badge>
            <Badge tone="neutral">{t("overview.allTasks", { count: overview.totalTasks })}</Badge>
          </div>
          <div className="mt-3">
            {overview.rows.length === 0 ? (
              <div className="space-y-1" data-command-center="overview-empty">
                <p className="text-sm text-text-secondary">{t("overview.monitorEmpty")}</p>
                <p className="text-xs text-text-muted">{t("overview.monitorEmptyHint")}</p>
              </div>
            ) : (
              <CommandCenterTaskList
                t={t}
                rows={overview.rows}
                label={t("overview.monitorTitle")}
                emptyLabel={t("overview.monitorEmpty")}
              />
            )}
          </div>
        </Panel>
        <Panel className="p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-text-primary">{t("overview.workspacesTitle")}</h2>
            <span className="text-xs text-text-secondary">{t("overview.workspacesHint")}</span>
          </div>
          <div className="mt-3">
            <CommandCenterWorkspaceEntryList t={t} entries={entries} onOpenWorkspace={onOpenWorkspace} />
          </div>
        </Panel>
      </div>
      <div className="grid grid-cols-2 gap-4" data-command-center="overview-reserved">
        {[1, 2].map((index) => (
          <section
            key={index}
            data-command-center="reserved-region"
            data-reserved-index={index}
            aria-label={t("overview.reservedLabel", { index })}
            className="rounded-lg border border-dashed border-border-default bg-bg-secondary p-4"
          >
            <Badge tone="neutral">{t("overview.reservedBadge")}</Badge>
            <p className="mt-2 text-sm text-text-secondary">{t("overview.reservedTitle")}</p>
            <p className="text-xs text-text-muted">{t("overview.reservedNote")}</p>
          </section>
        ))}
      </div>
    </section>
  );
}
