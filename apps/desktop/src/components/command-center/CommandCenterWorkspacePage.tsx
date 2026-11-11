import type { TFunction } from "i18next";
import { commandCenterTaskKey } from "@pi-desktop/shared";
import type {
  CommandCenterCapabilities,
  CommandCenterReceipt,
  CommandCenterTaskSummary,
  CommandCenterTaskTarget,
} from "@pi-desktop/shared";
import { Badge, Button, Field, Panel, Textarea } from "../ui";
import { CommandCenterReceipts } from "./CommandCenterReceipts";
import { CommandCenterTaskList } from "./CommandCenterTaskList";
import { CommandCenterWorkspaceTabStrip } from "./CommandCenterWorkspaceEntries";
import {
  COMMAND_CENTER_MAX_DRAFT_CHARS,
  commandCenterControlAvailability,
  commandCenterDraftSubmission,
  type CommandCenterWorkspaceView,
} from "./view/command-center-view";

/**
 * A workspace opened as a focused page.
 *
 * The page changes what is visible, not who owns execution: switching
 * workspace, editing a draft or leaving the page never starts, stops or
 * reassigns a task. Guidance can only be sent through an explicit port and only
 * when the peer implements the intervention capability; otherwise the control
 * is unavailable and says why.
 */
export function CommandCenterWorkspacePage({
  t,
  view,
  focusedTask,
  receipts = [],
  capabilities,
  draft = "",
  draftKey,
  onDraftChange,
  onSubmitDraft,
  onOpenWorkspace,
  onSelectTask,
  selectedTaskKey,
}: {
  readonly t: TFunction;
  readonly view: CommandCenterWorkspaceView;
  readonly focusedTask?: CommandCenterTaskSummary;
  readonly receipts?: readonly CommandCenterReceipt[];
  readonly capabilities?: CommandCenterCapabilities;
  readonly draft?: string;
  readonly draftKey: string;
  readonly onDraftChange: (draftKey: string, text: string) => void;
  readonly onSubmitDraft?: (input: {
    readonly draftKey: string;
    readonly text: string;
    readonly workspaceId: string;
    readonly taskKey?: string;
  }) => void;
  readonly onOpenWorkspace: (workspaceId: string) => void;
  readonly onSelectTask?: (target: CommandCenterTaskTarget) => void;
  readonly selectedTaskKey?: string;
}) {
  const availability = commandCenterControlAvailability(capabilities);
  const submission = commandCenterDraftSubmission(availability, onSubmitDraft);
  const taskKey = focusedTask === undefined ? undefined : commandCenterTaskKey(focusedTask.target);
  const canSend = submission.available && draft.trim().length > 0;
  return (
    <section
      className="flex flex-col gap-4 p-6"
      data-command-center="workspace"
      data-workspace-id={view.workspaceId}
      aria-labelledby="command-center-workspace-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="command-center-workspace-title" className="text-lg font-semibold text-text-primary">
            {view.name}
          </h1>
          <p className="text-xs text-text-secondary">
            {t("workspace.liveAgents", { count: view.liveAgents, max: view.maxAgents })}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Badge tone={view.attentionCount > 0 ? "warning" : "neutral"}>
            {view.attentionCount > 0
              ? t("workspace.attention", { count: view.attentionCount })
              : t("workspace.attentionNone")}
          </Badge>
          <CommandCenterWorkspaceTabStrip
            t={t}
            entries={view.entries}
            focusedWorkspaceId={view.workspaceId}
            onOpenWorkspace={onOpenWorkspace}
          />
        </div>
      </div>
      <div className="flex flex-col gap-4 lg:flex-row">
        <Panel className="p-3 lg:w-72 lg:shrink-0">
          <h2 className="text-sm font-semibold text-text-primary">
            {t("workspace.taskListLabel", { name: view.name })}
          </h2>
          <div className="mt-2">
            <CommandCenterTaskList
              t={t}
              rows={view.rows}
              label={t("workspace.taskListLabel", { name: view.name })}
              emptyLabel={t("workspace.taskListEmpty")}
              onSelectTask={onSelectTask}
              selectedTaskKey={selectedTaskKey}
            />
          </div>
          <p className="mt-3 text-xs text-text-muted">{t("workspace.backgroundNote")}</p>
        </Panel>
        <Panel className="min-w-0 flex-1 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-text-primary">
              {focusedTask === undefined
                ? t("workspace.conversation")
                : t("workspace.conversationTitle", { task: focusedTask.label })}
            </h2>
            {focusedTask === undefined ? null : (
              <span className="text-xs text-text-secondary">
                {t("workspace.goalRevisions", {
                  desired: focusedTask.desiredGoalRevision,
                  effective: focusedTask.effectiveGoalRevision,
                })}
              </span>
            )}
          </div>
          {focusedTask === undefined ? (
            <p className="mt-3 text-sm text-text-secondary" data-command-center="conversation-empty">
              {t("workspace.conversationEmpty")}
            </p>
          ) : null}
          <div className="mt-4">
            <Field label={t("workspace.composerLabel", { name: view.name })}>
              <Textarea
                value={draft}
                rows={4}
                maxLength={COMMAND_CENTER_MAX_DRAFT_CHARS}
                placeholder={t("workspace.composerPlaceholder", { name: view.name })}
                onChange={(event) => onDraftChange(draftKey, event.target.value)}
              />
            </Field>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-text-muted">
                {focusedTask === undefined
                  ? t("workspace.draftLocal")
                  : t("workspace.composerTarget", { task: focusedTask.label })}
              </span>
              <Button
                type="button"
                variant="primary"
                disabled={!canSend}
                onClick={() => onSubmitDraft?.({ draftKey, text: draft, workspaceId: view.workspaceId, taskKey })}
              >
                {t("workspace.send")}
              </Button>
            </div>
            {submission.available ? null : (
              <p className="mt-1 text-xs text-text-muted" data-command-center="send-unavailable">
                {submission.blocker === "capability"
                  ? t("workspace.sendUnavailableCapability")
                  : t("workspace.sendUnavailableHandler")}
              </p>
            )}
          </div>
          <CommandCenterReceipts t={t} receipts={receipts} />
        </Panel>
      </div>
    </section>
  );
}
