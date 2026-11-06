import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import type { RemoteProjectEntry, RemoteProjectGroup } from "../../lib/remote-project-catalog";
import {
  projectRunSummaryIsLive,
  resolveSidebarRunningAffordances,
  summarizeProjectRuns,
} from "../../lib/sidebar-project-runs";
import { useAppStore } from "../../stores/app-store";
import { useRemoteProjectLaunch } from "../../hooks/use-remote-host-preparation";
import { ProjectRunBadge, ProjectRunCount, ProjectRunRail } from "../ProjectRunIndicator";
import { IconFolder, IconNewProject } from "../icons";
import { Button, TooltipButton } from "../ui";
import { RemoteHostPreparationNotice } from "./RemoteHostPreparationNotice";

/**
 * The same project/chat hierarchy, keyed by Host identity rather than local paths.
 *
 * Opening one of these projects is the user action that may need the Host
 * prepared, so the panel — not the app store — owns that call: the phase and a
 * recoverable stop are shown on the project row itself, and a preparation that
 * was stopped can be resumed without leaving the panel.
 */
export function RemoteProjectGroups({ groups, renderSessions }: {
  groups: RemoteProjectGroup[]; renderSessions: (sessions: SessionSummary[]) => ReactNode;
}) {
  const { t } = useTranslation();
  const launch = useRemoteProjectLaunch();
  const settings = useAppStore((state) => state.settings);
  const [busy, setBusy] = useState<string | null>(null);
  // Remote groups carry the same running affordances as local projects, so a
  // collapsed host group does not hide live work either.
  const runAffordances = resolveSidebarRunningAffordances(settings);
  const runningSessions = useAppStore((state) => state.runningSessions);
  const pendingPermissions = useAppStore((state) => state.pendingPermissions);
  const open = async (project: RemoteProjectEntry) => {
    if (busy) return;
    setBusy(project.key);
    try {
      const result = await launch.open(project);
      if (!result.ok && !result.code) {
        useAppStore.getState().showToast(t("remote:operationFailed"), { variant: "error" });
      }
    } finally {
      setBusy(null);
    }
  };
  return <>{groups.map(({ project, sessions }) => {
    const runSummary = summarizeProjectRuns(sessions, runningSessions, pendingPermissions);
    const runIsLive = projectRunSummaryIsLive(runSummary);
    const showRunBadge = runAffordances.badge && runIsLive;
    const showRunRail = runAffordances.rail && runIsLive;
    const stopped = launch.state.hostKey === project.hostKey && launch.state.project?.key === project.key;
    return <section
      className={`sidebar-session-group project-group ${runIsLive ? "has-running-sessions" : ""} ${showRunRail ? "has-run-rail" : ""}`}
      key={project.key}
    >
      {showRunRail ? <ProjectRunRail summary={runSummary} /> : null}
      <div className="sidebar-session-group-header">
        <Button variant="ghost" className="sidebar-session-group-title" disabled={busy !== null}
          title={`${project.hostLabel} · ${project.label}`} onClick={() => void open(project)}>
          <IconFolder size={13} aria-hidden /><span>{project.label} · {project.hostLabel}</span>
          {showRunBadge ? <ProjectRunBadge summary={runSummary} /> : null}
          {showRunRail ? <ProjectRunCount summary={runSummary} /> : null}
        </Button>
        <TooltipButton tooltip={t("nav.newTask")} ariaLabel={`${t("nav.newTask")}: ${project.label} · ${project.hostLabel}`}
          disabled={busy !== null} onClick={() => void open(project)}><IconNewProject size={14} /></TooltipButton>
      </div>
      {stopped ? (
        <RemoteHostPreparationNotice
          className="is-compact"
          hostKey={project.hostKey}
          label={project.hostLabel}
          view={launch.view(project.hostKey)}
          errorCode={launch.state.errorCode}
          onPrepare={(_hostKey, options) => void launch.resume(options)}
          onCancel={launch.cancel}
        />
      ) : null}
      {renderSessions(sessions)}
    </section>;
  })}</>;
}
