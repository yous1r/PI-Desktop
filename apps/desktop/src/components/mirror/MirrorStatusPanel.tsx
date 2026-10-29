import { useTranslation } from "react-i18next";
import type { MirrorConflictResolution, MirrorSyncState } from "@pi-desktop/shared";
import type { MirrorProjectRuntime } from "../../stores/app-state";
import { Badge, Button } from "../ui";
import {
  MIRROR_STATE_TONE,
  mirrorActionAvailability,
  initBlocksSync,
  stepCatalogKey,
} from "./mirror-panel-model";
import { MirrorConflictList } from "./MirrorConflictList";
import "../../styles/mirror-panel.css";

export type MirrorStatusPanelProps = {
  /** Project group this panel is bound to; the host keys every call by it. */
  projectGroupId: string;
  /** Latest snapshot plus conflicts, as the store holds them. */
  runtime: MirrorProjectRuntime;
  /** Start synchronization for this project. */
  onStart: () => void;
  /** Stop synchronization, leaving the baseline intact. */
  onStop: () => void;
  /** Repeat the action that failed, named by the stored failure. */
  onRetry: () => void;
  /** Forward an explicit conflict decision. */
  onResolve: (relPath: string, resolution: MirrorConflictResolution) => void;
};

/**
 * What the mirror is doing, and what it needs from the user.
 *
 * The panel is a projection of host state: it never polls, never opens a
 * connection, and never decides anything the host did not report. The only
 * mutation it offers is a conflict decision the user makes on purpose.
 */
export function MirrorStatusPanel({
  projectGroupId,
  runtime,
  onStart,
  onStop,
  onRetry,
  onResolve,
}: MirrorStatusPanelProps) {
  const { t } = useTranslation();
  const { status, init, conflicts, error, loading } = runtime;
  const state: MirrorSyncState = status?.state ?? "idle";
  const blocked = initBlocksSync(init) || loading;
  const { canStart, canStop } = mirrorActionAvailability(state, { busy: loading, init });
  const stepLabel = init?.step ? t(`mirror.step.${stepCatalogKey(init.step)}`) : null;

  return (
    <section className="mirror-panel" aria-label={t("mirror.status.title")}>
      <header className="mirror-panel-head">
        <h2 className="mirror-panel-title">{t("mirror.status.title")}</h2>
        <Badge
          tone={MIRROR_STATE_TONE[state]}
          className="mirror-panel-state"
          data-mirror-state={state}
        >
          {t(`mirror.state.${state}`)}
        </Badge>
        {status && (
          <Badge tone="neutral" className="mirror-panel-mode">
            {status.mode === "manual" ? t("mirror.status.modeManual") : t("mirror.status.modeAuto")}
          </Badge>
        )}
      </header>

      {blocked && (
        <p className="mirror-panel-note" role="status">
          {stepLabel
            ? t("mirror.status.initializing", { step: stepLabel })
            : t("mirror.status.notReady")}
        </p>
      )}
      {!blocked && !status && (
        <p className="mirror-panel-note" role="status">
          {t("mirror.status.loading")}
        </p>
      )}

      <dl className="mirror-panel-counters">
        <div className="mirror-panel-counter">
          <dt>{t("mirror.status.pending")}</dt>
          <dd className="mirror-counter-value" data-mirror-pending>
            {status?.pendingPaths ?? 0}
          </dd>
        </div>
        <div className="mirror-panel-counter">
          <dt>{t("mirror.status.uploaded")}</dt>
          <dd className="mirror-counter-value" data-mirror-uploaded>
            {status?.uploadedFiles ?? 0}
          </dd>
        </div>
        <div className="mirror-panel-counter">
          <dt>{t("mirror.status.skipped")}</dt>
          <dd className="mirror-counter-value" data-mirror-skipped>
            {status?.skippedFiles ?? 0}
          </dd>
        </div>
        <div className="mirror-panel-counter">
          <dt>{t("mirror.status.conflicts")}</dt>
          <dd className="mirror-counter-value" data-mirror-conflicts={conflicts.length}>
            {conflicts.length}
          </dd>
        </div>
      </dl>

      <div className="mirror-panel-actions">
        <Button
          variant="primary"
          size="sm"
          className="mirror-panel-start"
          disabled={!canStart}
          title={t("mirror.status.start")}
          aria-label={t("mirror.status.start")}
          onClick={onStart}
        >
          {t("mirror.status.start")}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="mirror-panel-stop"
          disabled={!canStop}
          title={t("mirror.status.stop")}
          aria-label={t("mirror.status.stop")}
          onClick={onStop}
        >
          {t("mirror.status.stop")}
        </Button>
        {error && (
          // The retry repeats exactly the action that failed, so the user never
          // has to guess which step went wrong.
          <Button
            variant="ghost"
            size="sm"
            className="mirror-panel-retry"
            title={t("mirror.status.retry")}
            aria-label={t("mirror.status.retry")}
            onClick={onRetry}
          >
            {t("mirror.status.retry")}
          </Button>
        )}
      </div>

      {error && (
        <div className="mirror-panel-error" role="alert" data-mirror-error={error.code}>
          <p className="mirror-panel-error-title">{t("mirror.status.errorTitle")}</p>
          <p className="mirror-panel-error-detail">
            {t("mirror.status.errorDetail", { message: error.message, code: error.code })}
          </p>
        </div>
      )}

      <MirrorConflictList
        conflicts={conflicts}
        resolving={runtime.resolving}
        disabled={blocked}
        onResolve={onResolve}
      />
      {/* The id stays in the DOM so a debugger or a test can prove which project
          a panel speaks for without reading React state. */}
      <span hidden data-mirror-project={projectGroupId} />
    </section>
  );
}
