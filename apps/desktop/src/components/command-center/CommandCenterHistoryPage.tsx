import type { TFunction } from "i18next";
import { commandCenterTaskKey } from "@pi-desktop/shared";
import { Badge } from "../ui";
import { COMMAND_CENTER_STATUS_LABEL_KEYS, commandCenterStatusTone } from "./strings";
import type { CommandCenterHistoryEntry } from "./view/command-center-view";

/**
 * Local recall of conversations this client opened. It is not the Host
 * transcript history: no prompt, message or tool body is copied here, and
 * selecting an entry only changes the local view.
 */
export function CommandCenterHistoryPage({
  t,
  entries,
  selectedTaskKey,
  onOpenEntry,
}: {
  readonly t: TFunction;
  readonly entries: readonly CommandCenterHistoryEntry[];
  readonly selectedTaskKey?: string;
  readonly onOpenEntry: (entry: CommandCenterHistoryEntry) => void;
}) {
  return (
    <section className="flex flex-col gap-3 p-6" data-command-center="history" aria-labelledby="command-center-history-title">
      <h1 id="command-center-history-title" className="text-lg font-semibold text-text-primary">
        {t("history.title")}
      </h1>
      <p className="text-xs text-text-secondary">{t("history.localOnly")}</p>
      {entries.length === 0 ? (
        <p className="text-sm text-text-secondary" data-command-center="history-empty">
          {t("history.empty")}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {entries.map((entry) => {
            const key = commandCenterTaskKey(entry.target);
            return (
              <li key={key}>
                <button
                  type="button"
                  data-command-center="history-entry"
                  data-task-key={key}
                  className="flex w-full items-center gap-2 rounded-md border border-border-default bg-bg-secondary px-3 py-2 text-left hover:bg-bg-hover"
                  aria-label={t("history.open", { label: entry.label })}
                  aria-current={selectedTaskKey === key ? "true" : undefined}
                  onClick={() => onOpenEntry(entry)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-text-primary">{entry.label}</span>
                    {entry.workspaceName === undefined ? null : (
                      <span className="block truncate text-xs text-text-secondary">
                        {t("history.entryWorkspace", { name: entry.workspaceName })}
                      </span>
                    )}
                  </span>
                  {entry.status === undefined ? null : (
                    <Badge tone={commandCenterStatusTone(entry.status)}>
                      {t(COMMAND_CENTER_STATUS_LABEL_KEYS[entry.status])}
                    </Badge>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
