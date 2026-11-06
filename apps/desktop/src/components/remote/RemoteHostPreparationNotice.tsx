/**
 * One shared surface for Host preparation: the phase Main reported, the
 * version it is moving from and to, and the single action that phase allows.
 *
 * There is no progress bar and no percentage anywhere — Main publishes phases,
 * not byte counts, so a filled bar would be invented information. Every
 * visible sentence comes from the `remote` namespace; no raw stderr and no raw
 * error code reaches the user.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, cx } from "../ui";
import { remoteHostErrorCodeKey } from "../../lib/remote-host-errors";
import {
  preparationIsActive,
  preparationNeedsConsent,
  type RemoteHostPrepareOptions,
  type RemoteHostPreparationView,
} from "../../lib/remote-host-preparation";

export type PreparationAction = "download" | "maintenance" | "retry";

/**
 * What the user may do next. A legacy Host gets one maintenance attempt; after
 * it fails only an ordinary retry is offered, so the warning is not repeated.
 */
export function preparationActionFor(
  view: RemoteHostPreparationView | undefined,
  errorCode?: string | null,
): PreparationAction | null {
  const phase = view?.phase;
  const code = view?.errorCode ?? errorCode ?? undefined;
  if (code === "HOST_DOWNLOAD_REQUIRED" || phase === "awaiting-download") return "download";
  if (code === "HOST_MAINTENANCE_REQUIRED" || phase === "awaiting-maintenance") {
    return view?.legacyAttempted === true ? "retry" : "maintenance";
  }
  if (preparationIsActive(phase)) return null;
  if (code === undefined && (phase === undefined || phase === "ready")) return null;
  if (code === "HOST_CLIENT_TOO_OLD" || code === "HOST_VERSION_UNSUPPORTED") return null;
  if (code === "HOST_RECOVERY_REQUIRED") return null;
  return "retry";
}

export function RemoteHostPreparationNotice({
  hostKey,
  label,
  view,
  errorCode,
  onPrepare,
  onCancel,
  proxyHint = false,
  onOpenNetworkSettings,
  className,
}: {
  hostKey: string;
  /** Host display name, when the surface has one. */
  label?: string;
  view?: RemoteHostPreparationView;
  /** Failure this surface saw, when Main has not reported a state yet. */
  errorCode?: string | null;
  onPrepare: (hostKey: string, options: RemoteHostPrepareOptions) => void;
  onCancel?: (hostKey: string) => void;
  /** Show where the local download takes its proxy from (Settings only). */
  proxyHint?: boolean;
  onOpenNetworkSettings?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  // The legacy warning is offered once even if Main keeps answering the same
  // stop; the user already made that decision.
  const [maintenanceSpent, setMaintenanceSpent] = useState(view?.legacyAttempted === true);
  const code = view?.errorCode ?? errorCode ?? undefined;
  const phase = view?.phase;
  if (!view && !code) return null;

  const effectiveView = view && maintenanceSpent && view.legacyAttempted !== true
    ? { ...view, legacyAttempted: true }
    : view;
  const action = preparationActionFor(effectiveView, errorCode);
  const failed = phase === "failed" || (phase === undefined && code !== undefined);
  const working = preparationIsActive(phase) && !failed;
  const phaseText = phase && phase !== "failed"
    ? t(`remote:preparation.phase.${phase}`)
    : t("remote:preparation.phase.failed");

  const versions = view
    ? view.currentVersion && view.targetVersion
      ? t("remote:preparation.versionTransition", {
          current: view.currentVersion,
          target: view.targetVersion,
        })
      : view.targetVersion
        ? t("remote:preparation.targetVersion", { version: view.targetVersion })
        : view.currentVersion
          ? t("remote:preparation.currentVersion", { version: view.currentVersion })
          : null
    : null;

  const tone = failed
    ? "error"
    : phase === "ready"
      ? "success"
      : preparationNeedsConsent(phase) || (code !== undefined && !working)
        ? "warning"
        : "neutral";

  const start = (options: RemoteHostPrepareOptions) => {
    if (options.allowLegacyMaintenance) setMaintenanceSpent(true);
    onPrepare(hostKey, options);
  };

  // A stopped preparation cannot proceed without the user, so it is announced
  // assertively; work in flight and the ready state stay polite.
  const attention = failed || preparationNeedsConsent(phase);

  return (
    <div
      className={cx("remote-preparation", className)}
      data-phase={phase ?? "failed"}
      data-host-key={hostKey}
      role={attention ? "alert" : "status"}
    >
      <div className="remote-preparation-head">
        <Badge tone={tone}>
          {label ? t("remote:preparation.hostPhase", { label, phase: phaseText }) : phaseText}
        </Badge>
        {versions ? <span className="remote-preparation-versions">{versions}</span> : null}
      </div>
      {code && code !== "HOST_PREPARATION_CANCELLED" ? (
        <p className="remote-preparation-error">{t(remoteHostErrorCodeKey(code))}</p>
      ) : null}
      {action === "download" ? (
        <p className="remote-preparation-hint">{t("remote:preparation.downloadHint")}</p>
      ) : null}
      {action === "maintenance" ? (
        <p className="remote-preparation-hint">{t("remote:preparation.legacyHint")}</p>
      ) : null}
      {proxyHint ? (
        <p className="remote-preparation-hint">{t("remote:preparation.proxyHint")}</p>
      ) : null}
      {action || (working && onCancel) || (proxyHint && onOpenNetworkSettings) ? (
        <div className="remote-preparation-actions">
          {action === "download" ? (
            <Button variant="primary" size="sm" onClick={() => start({ allowDownload: true })}>
              {t("remote:preparation.downloadAction")}
            </Button>
          ) : null}
          {action === "maintenance" ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => start({ allowLegacyMaintenance: true, retry: true })}
            >
              {t("remote:preparation.maintenanceAction")}
            </Button>
          ) : null}
          {action === "retry" ? (
            <Button variant="secondary" size="sm" onClick={() => start({ retry: true })}>
              {t("remote:preparation.retryAction")}
            </Button>
          ) : null}
          {working && onCancel ? (
            <Button variant="ghost" size="sm" onClick={() => onCancel(hostKey)}>
              {t("remote:preparation.cancelAction")}
            </Button>
          ) : null}
          {proxyHint && onOpenNetworkSettings ? (
            <Button variant="ghost" size="sm" onClick={onOpenNetworkSettings}>
              {t("remote:preparation.proxyAction")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
