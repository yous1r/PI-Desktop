/**
 * The one place a stopped remote-project open is resolved.
 *
 * The switcher, the sidebar project rows and the project archive all reach the
 * same `activateProject` entry point, so the pending project lives in the
 * activation service and this single dialog renders it. A per-surface dialog
 * would lose the project the moment its menu closed.
 *
 * The dialog only ever answers the service: Download / Confirm idle / Retry
 * resume the exact project that was picked, and Close releases this gate's own
 * preparation waits without opening the project late.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/app-store";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { remoteProjectActivation } from "../../lib/remote-project-activation";
import {
  useRemoteHostPreparation,
  useRemoteHostPreparationSync,
} from "../../hooks/use-remote-host-preparation";
import { OverlayBackdrop, Button, portalOverlay } from "../ui";
import { IconClose } from "../icons";
import { RemoteHostPreparationNotice } from "./RemoteHostPreparationNotice";

export function RemoteProjectPreparationGate() {
  const { t } = useTranslation();
  const snapshot = useSyncExternalStore(
    remoteProjectActivation.subscribe,
    remoteProjectActivation.getSnapshot,
    remoteProjectActivation.getSnapshot,
  );
  const activeProjectPath = useAppStore((state) => state.activeProjectPath);
  const preparation = useRemoteHostPreparation();
  const pending = snapshot.pending;
  const open = pending !== null;

  // While the gate waits, Main reports progress through the host list; adopting
  // it keeps the phase (download, install, connect) truthful without ever
  // starting work from a refresh.
  useRemoteHostPreparationSync(open);
  useBlockingOverlay(open);

  // Switching project is the user leaving this decision behind.
  useEffect(() => {
    if (open) remoteProjectActivation.syncStillWanted();
  }, [open, activeProjectPath]);

  const dialogRef = useRef<HTMLDivElement>(null);
  const initialFocus = useRef(true);
  useEffect(() => {
    if (!open) { initialFocus.current = true; return; }
    if (!initialFocus.current) return;
    initialFocus.current = false;
    const frame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (!pending) return null;
  const view = preparation.view(pending.hostKey);
  const close = () => remoteProjectActivation.cancel();
  const title = pending.label
    ? t("remote:preparation.openProjectTitle", { project: pending.label })
    : t("remote:preparation.openProjectTitleFallback");

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // Closing only releases this gate's waits; the project stays closed.
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    // Modal: keep Tab inside, like the folder picker.
    const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), a[href]',
    );
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return portalOverlay(
    <OverlayBackdrop
      className="overlay remote-project-preparation-overlay"
      role="presentation"
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div
        ref={dialogRef}
        className="dialog remote-project-preparation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-project-preparation-title"
        aria-describedby="remote-project-preparation-description"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="project-create-dialog-head">
          <div className="project-create-dialog-heading">
            <h2 id="remote-project-preparation-title" className="project-create-dialog-title">
              {title}
            </h2>
            <p id="remote-project-preparation-description" className="project-edit-dialog-description">
              {t("remote:preparation.openProjectHint")}
            </p>
          </div>
          <Button variant="ghost" type="button" aria-label={t("common.close")} onClick={close}>
            <IconClose size={17} />
          </Button>
        </div>
        <RemoteHostPreparationNotice
          hostKey={pending.hostKey}
          view={view}
          onPrepare={(_hostKey, options) => { void remoteProjectActivation.resume(options); }}
          onCancel={close}
        />
        <div className="project-create-dialog-actions">
          <Button type="button" variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    </OverlayBackdrop>,
  );
}
