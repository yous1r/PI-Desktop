import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MirrorConflict, MirrorConflictResolution } from "@pi-desktop/shared";
import { Badge, Button, cx } from "../ui";
import "../../styles/mirror-panel.css";

/** Byte scales rendered through `Intl`, so every locale gets its own units. */
const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;

/** Localized file size: no hard-coded English unit anywhere in the tree. */
export function formatMirrorSize(bytes: number, locale: string): string {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: BYTE_UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: value >= 10 || unit === 0 ? 0 : 1,
  }).format(value);
}

/** Localized modification time of one side of a conflict. */
export function formatMirrorTime(mtimeMs: number, locale: string): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return "";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(mtimeMs));
}

/**
 * The keep-remote gate. Keeping the remote copy writes into the local tree, so
 * the first press only arms the row and the second one — which names the file
 * it will overwrite — is the decision.
 */
export type KeepRemoteIntent = "arm" | "confirm";

export function keepRemoteIntent(
  confirmingPath: string | null,
  relPath: string,
): KeepRemoteIntent {
  return confirmingPath === relPath ? "confirm" : "arm";
}

export type MirrorConflictRowProps = {
  conflict: MirrorConflict;
  /** This row is the armed one: its destructive action asks for confirmation. */
  armed: boolean;
  /** A resolve for this row is in flight. */
  busy?: boolean;
  /** Every action is unavailable, e.g. while the mirror is initializing. */
  disabled?: boolean;
  onRequestConfirm: (relPath: string) => void;
  onCancelConfirm: () => void;
  onResolve: (relPath: string, resolution: MirrorConflictResolution) => void;
};

/** One remote file that diverged, with both sides and the three decisions. */
export function MirrorConflictRow({
  conflict,
  armed,
  busy = false,
  disabled = false,
  onRequestConfirm,
  onCancelConfirm,
  onResolve,
}: MirrorConflictRowProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const blocked = disabled || busy;
  const side = (size: number, mtimeMs: number) =>
    t("mirror.conflict.sideDetail", {
      size: formatMirrorSize(size, locale),
      time: formatMirrorTime(mtimeMs, locale),
    });
  return (
    <li className={cx("mirror-conflict-row", armed && "is-armed")}>
      <div className="mirror-conflict-head">
        <code className="mirror-conflict-path">{conflict.relPath}</code>
        {armed && (
          <Badge tone="warning" className="mirror-conflict-armed">
            {t("mirror.conflict.armed")}
          </Badge>
        )}
      </div>
      <dl className="mirror-conflict-sides">
        <dt>{t("mirror.conflict.localSide")}</dt>
        <dd>{side(conflict.localSize, conflict.localMtimeMs)}</dd>
        <dt>{t("mirror.conflict.remoteSide")}</dt>
        <dd>{side(conflict.remoteSize, conflict.remoteMtimeMs)}</dd>
      </dl>
      {conflict.baselineSize === null && (
        <p className="mirror-conflict-note">{t("mirror.conflict.neverSynced")}</p>
      )}
      {armed ? (
        <div
          className="mirror-conflict-actions"
          data-mirror-confirm={conflict.relPath}
          role="group"
          aria-label={t("mirror.conflict.confirmRegion", { path: conflict.relPath })}
        >
          <Button
            variant="secondary"
            size="sm"
            className="mirror-conflict-confirm"
            disabled={blocked}
            title={t("mirror.conflict.confirmKeepRemote", { path: conflict.relPath })}
            aria-label={t("mirror.conflict.confirmKeepRemote", { path: conflict.relPath })}
            onClick={() => onResolve(conflict.relPath, "keep_remote")}
          >
            {t("mirror.conflict.confirmKeepRemote", { path: conflict.relPath })}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="mirror-conflict-cancel"
            disabled={busy}
            title={t("mirror.conflict.cancelKeepRemote")}
            aria-label={t("mirror.conflict.cancelKeepRemote")}
            onClick={onCancelConfirm}
          >
            {t("mirror.conflict.cancelKeepRemote")}
          </Button>
        </div>
      ) : (
        <div className="mirror-conflict-actions">
          <Button
            variant="secondary"
            size="sm"
            className="mirror-conflict-keep-local"
            disabled={blocked}
            title={t("mirror.conflict.keepLocalFor", { path: conflict.relPath })}
            aria-label={t("mirror.conflict.keepLocalFor", { path: conflict.relPath })}
            onClick={() => onResolve(conflict.relPath, "keep_local")}
          >
            {t("mirror.conflict.keepLocal")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="mirror-conflict-keep-remote"
            disabled={blocked}
            title={t("mirror.conflict.keepRemoteFor", { path: conflict.relPath })}
            aria-label={t("mirror.conflict.keepRemoteFor", { path: conflict.relPath })}
            onClick={() => onRequestConfirm(conflict.relPath)}
          >
            {t("mirror.conflict.keepRemote")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="mirror-conflict-skip"
            disabled={blocked}
            title={t("mirror.conflict.skipFor", { path: conflict.relPath })}
            aria-label={t("mirror.conflict.skipFor", { path: conflict.relPath })}
            onClick={() => onResolve(conflict.relPath, "skip")}
          >
            {t("mirror.conflict.skip")}
          </Button>
        </div>
      )}
      {busy && <p role="status">{t("mirror.conflict.resolving", { path: conflict.relPath })}</p>}
    </li>
  );
}

export type MirrorConflictListProps = {
  /** Remote files waiting for a decision, as the host last reported them. */
  conflicts: MirrorConflict[];
  /** Conflict paths whose resolve invoke is in flight. */
  resolving?: Record<string, true>;
  /** Disable every action while the mirror cannot accept one. */
  disabled?: boolean;
  onResolve: (relPath: string, resolution: MirrorConflictResolution) => void;
};

/**
 * The conflict list: one row per remote divergence and three explicit
 * decisions. Nothing is resolved automatically and no decision carries over to
 * another file, so the armed row is the only one that can overwrite locally.
 */
export function MirrorConflictList({
  conflicts,
  resolving,
  disabled = false,
  onResolve,
}: MirrorConflictListProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState<string | null>(null);
  // A row that left the list cannot stay armed; the gate is derived, not stored
  // twice, so a stale arm can never confirm a file the user no longer sees.
  const armedPath =
    confirming && conflicts.some((row) => row.relPath === confirming)
      ? confirming
      : null;
  const resolve = (relPath: string, resolution: MirrorConflictResolution) => {
    setConfirming(null);
    onResolve(relPath, resolution);
  };
  return (
    <section className="mirror-conflicts" aria-label={t("mirror.conflict.title")}>
      <header className="mirror-conflicts-head">
        <h3 className="mirror-conflicts-title">{t("mirror.conflict.title")}</h3>
        <Badge tone={conflicts.length > 0 ? "warning" : "neutral"}>
          {conflicts.length > 0
            ? t("mirror.conflict.total", { total: conflicts.length })
            : t("mirror.conflict.empty")}
        </Badge>
      </header>
      {conflicts.length === 0 ? (
        <p className="mirror-conflicts-empty">{t("mirror.conflict.empty")}</p>
      ) : (
        <ul className="mirror-conflict-list">
          {conflicts.map((conflict) => (
            <MirrorConflictRow
              key={conflict.relPath}
              conflict={conflict}
              armed={armedPath === conflict.relPath}
              busy={Boolean(resolving?.[conflict.relPath])}
              disabled={disabled}
              onRequestConfirm={setConfirming}
              onCancelConfirm={() => setConfirming(null)}
              onResolve={resolve}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
