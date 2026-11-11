import type { TFunction } from "i18next";
import type { CommandCenterReceipt } from "@pi-desktop/shared";
import { Badge } from "../ui";
import {
  COMMAND_CENTER_OPERATION_LABEL_KEYS,
  COMMAND_CENTER_RECEIPT_LABEL_KEYS,
} from "./strings";
import { selectReceiptViews } from "./view/command-center-view";

/**
 * Retained control receipts for the focused workspace.
 *
 * The list separates `recorded`, `accepted`, `consumed` and `completed` rather
 * than collapsing them into "sent": a committed intent, a runtime admission, a
 * consumed revision and terminal evidence are different facts. Revisions are
 * monotonic locally too, so a delayed event cannot repaint an older state.
 */
export function CommandCenterReceipts({
  t,
  receipts,
}: {
  readonly t: TFunction;
  readonly receipts: readonly CommandCenterReceipt[];
}) {
  const views = selectReceiptViews(receipts);
  return (
    <section className="mt-3" aria-labelledby="command-center-receipts-title" data-command-center="receipts">
      <h3 id="command-center-receipts-title" className="text-sm font-semibold text-text-primary">
        {t("receipts.title")}
      </h3>
      {views.length === 0 ? (
        <p className="mt-1 text-xs text-text-muted">{t("receipts.empty")}</p>
      ) : (
        <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0" aria-live="polite">
          {views.map((view) => (
            <li
              key={view.requestId}
              className="flex items-center gap-2 text-xs text-text-secondary"
              data-command-center="receipt"
              data-receipt-status={view.status}
            >
              <span className="sr-only">
                {t("receipts.item", {
                  operation: t(COMMAND_CENTER_OPERATION_LABEL_KEYS[view.operation]),
                  status: t(COMMAND_CENTER_RECEIPT_LABEL_KEYS[view.status]),
                })}
              </span>
              <Badge tone={view.tone}>{t(COMMAND_CENTER_RECEIPT_LABEL_KEYS[view.status])}</Badge>
              <span className="min-w-0 flex-1 truncate">{t(COMMAND_CENTER_OPERATION_LABEL_KEYS[view.operation])}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
