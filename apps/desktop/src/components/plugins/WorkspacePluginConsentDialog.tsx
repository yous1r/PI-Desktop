import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspacePluginConsentRequest } from "@pi-desktop/shared";
import { ShieldAlert } from "lucide-react";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { workspacePluginConsent } from "../../lib/workspace-plugin-consent";
import { Button, OverlayBackdrop, portalOverlay } from "../ui";

function ConsentSurface({ request, respond }: {
  request: WorkspacePluginConsentRequest;
  respond(allowed: boolean): void;
}) {
  const { t } = useTranslation();
  const deny = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useBlockingOverlay();
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => deny.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      // The app's quit confirmation owns keyboard focus while it is above us.
      if (document.querySelector(".lifecycle-confirmation-overlay")) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); respond(false); return;
      }
      if (event.key !== "Tab") return;
      const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
      if (!buttons?.length) return;
      const index = Array.from(buttons).indexOf(document.activeElement as HTMLButtonElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); buttons[buttons.length - 1].focus(); }
      else if (!event.shiftKey && (index === -1 || index === buttons.length - 1)) { event.preventDefault(); buttons[0].focus(); }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown, true);
      if (previous?.isConnected) previous.focus();
    };
  }, [request.requestId, respond]);
  const title = t("pluginWorkspaceConsent.message").replace(/\{(name|host)\}/g,
    (_, key: string) => key === "name" ? request.pluginName : request.hostKey);
  return portalOverlay(
    <OverlayBackdrop className="overlay workspace-plugin-consent-overlay" onClick={() => respond(false)}>
      <div ref={dialog} className="dialog workspace-plugin-consent-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby="workspace-plugin-consent-title" aria-describedby="workspace-plugin-consent-detail"
        onClick={(event) => event.stopPropagation()}>
        <div className="workspace-plugin-consent-heading">
          <ShieldAlert size={22} aria-hidden="true" />
          <h2 id="workspace-plugin-consent-title">{title}</h2>
        </div>
        <p id="workspace-plugin-consent-detail">{t("pluginWorkspaceConsent.detail")}</p>
        <div className="workspace-plugin-consent-actions">
          <Button ref={deny} type="button" variant="secondary" onClick={() => respond(false)}>{t("pluginWorkspaceConsent.deny")}</Button>
          <Button type="button" variant="primary" onClick={() => respond(true)}>{t("pluginWorkspaceConsent.allow")}</Button>
        </div>
      </div>
    </OverlayBackdrop>,
  );
}

export function WorkspacePluginConsentDialog() {
  const [request, setRequest] = useState<WorkspacePluginConsentRequest | null>(null);
  const active = useRef<WorkspacePluginConsentRequest | null>(null);
  const respond = useCallback((allowed: boolean) => {
    const current = active.current;
    if (!current) return;
    active.current = null;
    setRequest(null);
    void workspacePluginConsent.respond(current.requestId, allowed).catch((error: unknown) => {
      console.error("Failed to respond to workspace plugin consent", error);
    });
  }, []);
  useEffect(() => {
    const offRequest = workspacePluginConsent.onRequest((next) => { active.current = next; setRequest(next); });
    const offDismiss = workspacePluginConsent.onDismiss((id) => {
      if (active.current?.requestId === id) { active.current = null; setRequest(null); }
    });
    void workspacePluginConsent.ready(true).catch((error: unknown) => {
      console.error("Failed to register workspace plugin consent renderer", error);
    });
    return () => {
      offRequest(); offDismiss(); active.current = null;
      void workspacePluginConsent.ready(false).catch((error: unknown) => {
        console.error("Failed to unregister workspace plugin consent renderer", error);
      });
    };
  }, []);
  return request ? <ConsentSurface key={request.requestId} request={request} respond={respond} /> : null;
}
