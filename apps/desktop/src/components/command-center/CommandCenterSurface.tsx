import { useTranslation } from "react-i18next";
import type {
  CommandCenterCapabilities,
  CommandCenterMonitorSnapshot,
  CommandCenterReceipt,
  CommandCenterTaskSummary,
  CommandCenterTaskTarget,
  CommandCenterWorkspace,
} from "@pi-desktop/shared";
import { CommandCenterHistoryPage } from "./CommandCenterHistoryPage";
import { CommandCenterOverview } from "./CommandCenterOverview";
import { CommandCenterToolbar, type CommandCenterToolbarDestination } from "./CommandCenterToolbar";
import { CommandCenterWorkspacePage } from "./CommandCenterWorkspacePage";
import { COMMAND_CENTER_I18N_NAMESPACE } from "./strings";
import {
  commandCenterDraftKey,
  commandCenterVisitEntry,
  selectTaskRows,
  selectWorkspaceView,
  type CommandCenterHistoryEntry,
  type CommandCenterHostStatus,
  type CommandCenterViewState,
} from "./view/command-center-view";
import { useCommandCenterView } from "./view/use-command-center-view";

export interface CommandCenterDraftSubmissionInput {
  readonly draftKey: string;
  readonly text: string;
  readonly workspaceId: string;
  readonly taskKey?: string;
}

/**
 * V3 command-center surface: the top toolbar plus one of the overview, a
 * focused workspace or the local history page.
 *
 * Every port here is supplied by the caller. The surface owns only the local
 * view (which page is open, which workspace was focused, drafts and recall
 * history); it opens no transport, invents no task and advertises no
 * capability. Parent integration mounts this component inside the app route,
 * passes negotiated monitor/workspace data and an explicit draft-submit port,
 * and registers the `commandCenter` i18n namespace.
 */
export function CommandCenterSurface({
  workspaces,
  snapshot,
  focusedTask,
  receipts,
  capabilities,
  hostStatus,
  selectedTaskKey,
  initialView,
  onOpenSettings,
  onSelectTask,
  onSubmitDraft,
}: {
  readonly workspaces: readonly CommandCenterWorkspace[];
  readonly snapshot?: CommandCenterMonitorSnapshot;
  readonly focusedTask?: CommandCenterTaskSummary;
  readonly receipts?: readonly CommandCenterReceipt[];
  readonly capabilities?: CommandCenterCapabilities;
  readonly hostStatus?: CommandCenterHostStatus;
  readonly selectedTaskKey?: string;
  readonly initialView?: Partial<Pick<CommandCenterViewState, "destination" | "lastWorkspaceId">>;
  readonly onOpenSettings?: () => void;
  readonly onSelectTask?: (target: CommandCenterTaskTarget) => void;
  readonly onSubmitDraft?: (input: CommandCenterDraftSubmissionInput) => void;
}) {
  const { t } = useTranslation(COMMAND_CENTER_I18N_NAMESPACE);
  const { view, dispatch } = useCommandCenterView(initialView);
  const destination = view.destination;
  const workspaceId =
    destination.kind === "workspace" ? destination.workspaceId : (view.lastWorkspaceId ?? undefined);
  const workspaceView =
    destination.kind === "workspace"
      ? selectWorkspaceView({ workspaceId: destination.workspaceId, workspaces, snapshot })
      : undefined;
  const draftKey = commandCenterDraftKey(workspaceId ?? "");
  const toolbarDestination: CommandCenterToolbarDestination =
    destination.kind === "workspace" ? "workspace" : destination.kind;

  const openWorkspace = (nextWorkspaceId: string) => {
    dispatch({ type: "open-workspace", workspaceId: nextWorkspaceId });
  };

  const selectTask = (target: CommandCenterTaskTarget) => {
    const entry = commandCenterVisitEntry({ target, rows: selectTaskRows(snapshot), workspaces });
    if (entry !== undefined) dispatch({ type: "record-visit", entry });
    onSelectTask?.(target);
  };

  const openHistoryEntry = (entry: CommandCenterHistoryEntry) => {
    dispatch({ type: "open-history-entry", entry });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary text-text-primary" data-command-center="surface">
      <CommandCenterToolbar
        t={t}
        destination={toolbarDestination}
        onOpenOverview={() => dispatch({ type: "open-overview" })}
        onOpenHistory={() => dispatch({ type: "open-history" })}
        onOpenSettings={onOpenSettings}
        hostStatus={hostStatus}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        {destination.kind === "overview" ? (
          <CommandCenterOverview t={t} workspaces={workspaces} snapshot={snapshot} onOpenWorkspace={openWorkspace} />
        ) : null}
        {destination.kind === "history" ? (
          <CommandCenterHistoryPage
            t={t}
            entries={view.history}
            selectedTaskKey={selectedTaskKey}
            onOpenEntry={openHistoryEntry}
          />
        ) : null}
        {destination.kind === "workspace" && workspaceView !== undefined ? (
          <CommandCenterWorkspacePage
            t={t}
            view={workspaceView}
            focusedTask={focusedTask}
            receipts={receipts}
            capabilities={capabilities}
            draft={view.drafts[draftKey] ?? ""}
            draftKey={draftKey}
            onDraftChange={(key, text) => dispatch({ type: "update-draft", key, text })}
            onSubmitDraft={onSubmitDraft}
            onOpenWorkspace={openWorkspace}
            onSelectTask={onSelectTask === undefined ? undefined : selectTask}
            selectedTaskKey={selectedTaskKey}
          />
        ) : null}
        {destination.kind === "workspace" && workspaceView === undefined ? (
          <section
            className="p-6"
            data-command-center="workspace-unavailable"
            role="status"
            aria-labelledby="command-center-workspace-unavailable-title"
          >
            <h1
              id="command-center-workspace-unavailable-title"
              className="text-lg font-semibold text-text-primary"
            >
              {t("workspace.unavailable")}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">{t("workspace.unavailableHint")}</p>
          </section>
        ) : null}
      </div>
    </div>
  );
}
