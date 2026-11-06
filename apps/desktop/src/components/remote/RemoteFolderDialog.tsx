import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { RemoteHostBrowseProjectsResult } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { remoteHostErrorKey } from "../../lib/remote-host-errors";
import type { RemoteHostPrepareOptions } from "../../lib/remote-host-preparation";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { useRemoteHostPreparation, useRemoteHostPreparationSync } from "../../hooks/use-remote-host-preparation";
import { OverlayBackdrop, Button, Field, Input, TooltipButton } from "../ui";
import { IconChevronRight, IconClose, IconFolder } from "../icons";
import { RemoteHostPreparationNotice } from "./RemoteHostPreparationNotice";

/**
 * Directory navigation belongs to a separate modal, never the project form.
 *
 * Opening the picker is the user asking to browse a Host, so this dialog
 * prepares the Host first: an older Host is brought onto this Desktop's release
 * (or the user is shown the one action that would) before a single `browse`
 * call leaves the renderer. Preparation state is displayed, never a fabricated
 * progress bar.
 */
export function RemoteFolderDialog({ hostKey, hostLabel, initialPath, onChoose, onClose }: {
  hostKey: string; hostLabel: string; initialPath: string;
  onChoose: (path: string) => void; onClose: () => void;
}) {
  useBlockingOverlay();
  const { t } = useTranslation();
  const preparation = useRemoteHostPreparation();
  useRemoteHostPreparationSync(true);
  const view = preparation.view(hostKey);
  const [directory, setDirectory] = useState<RemoteHostBrowseProjectsResult | null>(null);
  const [path, setPath] = useState(initialPath);
  const [browsing, setBrowsing] = useState(false);
  const [preparing, setPreparing] = useState(true);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const prepareGeneration = useRef(0);
  const initialFocus = useRef(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const initialPathRef = useRef(initialPath);
  initialPathRef.current = initialPath;

  async function browse(nextPath?: string) {
    const request = ++generation.current;
    setBrowsing(true);
    setError("");
    try {
      const result = await api.remoteHostBrowseProjects(hostKey, nextPath);
      if (request !== generation.current) return;
      setDirectory(result);
      setPath(result.path);
    } catch (error) {
      if (request === generation.current) setError(t(remoteHostErrorKey(error)));
    } finally {
      if (request === generation.current) setBrowsing(false);
    }
  }

  const enter = useCallback(async (options?: RemoteHostPrepareOptions) => {
    const request = ++prepareGeneration.current;
    setPreparing(true);
    setStopped(false);
    setError("");
    const outcome = await preparation.prepare(hostKey, options).outcome;
    if (request !== prepareGeneration.current) return;
    setPreparing(false);
    if (!outcome.ok) {
      // A download consent, a maintenance stop or a retry is the next step;
      // browsing would only fail again on the Host.
      setStopped(true);
      return;
    }
    const start = initialPathRef.current;
    await browse(start.startsWith("/") ? start : undefined);
  }, [hostKey, preparation, t]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus());
    void enter();
    return () => {
      generation.current++;
      prepareGeneration.current++;
      preparation.cancel(hostKey);
      cancelAnimationFrame(frame);
      // The parent removes its inert state before focus is restored.
      requestAnimationFrame(() => { if (previouslyFocused?.isConnected) previouslyFocused.focus(); });
    };
    // One preparation per opened dialog; `enter` is stable for this Host.
  }, [hostKey]);

  useEffect(() => {
    if (preparing || browsing || !initialFocus.current) return;
    initialFocus.current = false;
    pathRef.current?.focus();
  }, [preparing, browsing]);

  const busy = preparing || browsing;
  const choose = () => {
    if (!directory || busy || error || path !== directory.path) return;
    onChoose(directory.path);
  };
  const dialog = <OverlayBackdrop className="overlay remote-folder-dialog-overlay" role="presentation"
    onClick={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}>
    <div ref={dialogRef} className="dialog remote-folder-dialog" role="dialog" aria-modal="true"
      aria-labelledby="remote-folder-dialog-title" aria-describedby="remote-folder-dialog-host"
      onKeyDown={(event) => {
        // The project dialog also traps focus; only this foreground modal handles keys.
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
        if (event.key !== "Tab") return;
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])');
        if (!controls?.length) return;
        const first = controls[0]; const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <div className="project-create-dialog-head">
        <div className="project-create-dialog-heading">
          <h2 id="remote-folder-dialog-title" className="project-create-dialog-title">{t("remote:folderPickerTitle")}</h2>
          <p id="remote-folder-dialog-host" className="project-edit-dialog-description">{hostLabel}</p>
        </div>
        <TooltipButton type="button" className="project-create-dialog-close" tooltip={t("project.createCancel")}
          ariaLabel={t("project.createCancel")} onClick={onClose}><IconClose size={17} /></TooltipButton>
      </div>
      <RemoteHostPreparationNotice hostKey={hostKey} view={view}
        onPrepare={(key, options) => { if (key === hostKey) void enter(options); }}
        onCancel={() => closeRef.current()} />
      <form className="remote-folder-dialog-navigation" onSubmit={(event) => { event.preventDefault(); event.stopPropagation(); if (path.startsWith("/") && !busy && !stopped) void browse(path); }}>
        <Field label={t("remote:folderPath")}>
          <div className="remote-folder-dialog-path-entry">
            <Input ref={pathRef} value={path} aria-label={t("remote:folderPath")} placeholder={t("remote:pathPlaceholder")}
              autoComplete="off" spellCheck={false} disabled={busy || stopped} onChange={(event) => setPath(event.target.value)} />
            <Button type="submit" disabled={busy || stopped || !path.startsWith("/")}>{t("remote:goToFolder")}</Button>
          </div>
        </Field>
        {path && !path.startsWith("/") ? <p className="remote-project-error" role="alert">{t("remote:REMOTE_ABSOLUTE_PATH_REQUIRED")}</p> : null}
        <Button type="button" variant="ghost" disabled={busy || stopped || !directory?.parent}
          onClick={() => void browse(directory?.parent)}>{t("remote:parent")}</Button>
      </form>
      <div className="remote-folder-dialog-directory" aria-busy={busy}>
        {preparing || browsing ? <p role="status">{t("remote:loading")}</p> : null}
        {error ? <p className="remote-project-error" role="alert">{error}</p> : null}
        {!busy && stopped && !view ? <p className="remote-project-error" role="alert">{t("remote:connectionUnavailable")}</p> : null}
        {!busy && !stopped && directory && !error ? <>
          <p className="remote-project-browser-path" title={directory.path}>{directory.path}</p>
          <div className="remote-folder-dialog-entries" role="list" aria-label={t("remote:browseFolders")}>
            {directory.entries.map((entry) => <div role="listitem" key={entry.path}>
              <Button type="button" variant="ghost" className="remote-folder-dialog-entry"
                aria-label={t("remote:openFolder", { name: entry.name })} title={entry.path} onClick={() => void browse(entry.path)}>
                <IconFolder size={18} aria-hidden /><span>{entry.name}</span><IconChevronRight size={16} aria-hidden />
              </Button>
            </div>)}
          </div>
          {!directory.entries.length ? <p className="project-edit-dialog-description">{t("remote:emptyFolders")}</p> : null}
        </> : null}
      </div>
      <div className="project-create-dialog-actions">
        <Button type="button" variant="ghost" onClick={onClose}>{t("project.createCancel")}</Button>
        <Button type="button" variant="primary" disabled={!directory || busy || stopped || !!error || path !== directory.path} onClick={choose}>{t("remote:useFolder")}</Button>
      </div>
    </div>
  </OverlayBackdrop>;
  return createPortal(dialog, document.body);
}
