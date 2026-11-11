import type { TFunction } from "i18next";
import type { CommandCenterTaskTarget } from "@pi-desktop/shared";
import { Badge, cx } from "../ui";
import { COMMAND_CENTER_STATUS_LABEL_KEYS, commandCenterStatusTone } from "./strings";
import type { CommandCenterTaskRowView } from "./view/command-center-view";

/**
 * Bounded task rows shared by the overview preview and the workspace page.
 * Rows render as buttons only when a caller supplied a selection port, so the
 * list never implies an action it cannot perform.
 */
export function CommandCenterTaskList({
  t,
  rows,
  label,
  emptyLabel,
  onSelectTask,
  selectedTaskKey,
}: {
  readonly t: TFunction;
  readonly rows: readonly CommandCenterTaskRowView[];
  readonly label: string;
  readonly emptyLabel: string;
  readonly onSelectTask?: (target: CommandCenterTaskTarget) => void;
  readonly selectedTaskKey?: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-text-secondary">{emptyLabel}</p>;
  }
  return (
    <ul className="m-0 flex list-none flex-col p-0" aria-label={label} data-command-center="task-list">
      {rows.map((row) => {
        const content = (
          <>
            <span
              aria-hidden="true"
              className={cx(
                "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                row.needsHuman ? "bg-warning" : row.active ? "bg-accent" : "bg-text-faint",
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-text-primary">{row.label}</span>
              {row.detail === undefined ? null : (
                <span className="block truncate text-xs text-text-secondary">{row.detail}</span>
              )}
            </span>
            <Badge tone={commandCenterStatusTone(row.status)}>{t(COMMAND_CENTER_STATUS_LABEL_KEYS[row.status])}</Badge>
          </>
        );
        return (
          <li
            key={row.key}
            className="border-b border-border-subtle last:border-b-0"
            data-command-center="task-row"
            data-task-key={row.key}
          >
            {onSelectTask === undefined ? (
              <div className="flex items-start gap-2 px-1 py-2">{content}</div>
            ) : (
              <button
                type="button"
                data-command-center="task-open"
                data-task-key={row.key}
                className="flex w-full items-start gap-2 px-1 py-2 text-left hover:bg-bg-hover"
                aria-label={t("workspace.openTask", { label: row.label })}
                aria-current={selectedTaskKey === row.key ? "true" : undefined}
                onClick={() => onSelectTask(row.target)}
              >
                {content}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
