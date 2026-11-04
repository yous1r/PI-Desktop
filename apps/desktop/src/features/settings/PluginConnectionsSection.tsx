import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Checkbox,
  CheckboxGroup,
  HelpIcon,
  Input,
  PasswordInput,
  SettingsToggle,
  Textarea,
  TooltipButton,
} from "../../components/ui";
import { IconPlus, IconTrash } from "../../components/icons";
import {
  buildConnectionSaveInput,
  connectionDraft,
  connectionRouteSummary,
  draftRoute,
  emptyConnectionDraft,
  endpointChanged,
  resolvedRouteUrl,
  upsertConnection,
  validateConnectionDraft,
  type ConnectionDraft,
  type ConnectionDraftIssue,
  type PluginConnectionMethod,
  type PluginConnectionRecord,
} from "./plugin-connections-form";

/**
 * Host-managed remote connections for one installed plugin.
 *
 * The credential never reaches the plugin and never comes back to this form:
 * the host stores the token, and a saved token is only ever represented as
 * "write-only, leave blank to keep". The section appears only for a plugin
 * that holds `net.connection`, and only once the host answers the list IPC — a
 * build without the channel renders nothing rather than promising a feature
 * it cannot provide.
 */

const CONNECTION_PERMISSION = "net.connection";

/**
 * Literal channels: the shared IPC catalog is owned by the host protocol, so
 * the renderer names the connection channels here and the host wiring binds
 * the same strings.
 */
const LIST_CHANNEL = "pi-desktop/plugins/connections/list";
const SAVE_CHANNEL = "pi-desktop/plugins/connections/save";
const DELETE_CHANNEL = "pi-desktop/plugins/connections/delete";

/**
 * Stable field ids: a row labels its own control with `htmlFor`, and a
 * validation message moves focus through the same id. `PasswordInput` wraps
 * its input, so the id is the one handle both paths can share.
 */
const FIELD_ID = {
  label: "plugin-connection-label",
  baseUrl: "plugin-connection-base-url",
  token: "plugin-connection-token",
  ca: "plugin-connection-ca",
  route: "plugin-connection-route-",
} as const;

function focusField(id: string): void {
  document.getElementById(id)?.focus();
}

type Props = {
  pluginId: string;
  /** Granted permissions of the plugin; absent means nothing is granted. */
  permissions?: readonly string[];
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; connections: PluginConnectionRecord[] }
  | { status: "error" }
  /** The host has no connection capability; the section stays out of the way. */
  | { status: "unsupported" };

/** The preload bridge, or null when this build exposes no plugin IPC at all. */
type PreloadBridge = NonNullable<Window["piDesktop"]>;

function bridge(): PreloadBridge | null {
  const value = window.piDesktop;
  if (typeof value?.invoke !== "function") return null;
  return value;
}

function errorFrom(result: { error: { code: string; message: string } }): Error {
  return Object.assign(new Error(result.error.message), { code: result.error.code });
}

/** A missing channel, an old preload allowlist, or a failed bridge. */
function isUnsupported(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  if (
    candidate &&
    typeof candidate.code === "string" &&
    ["UNSUPPORTED_OPERATION", "NOT_IMPLEMENTED", "METHOD_NOT_FOUND", "ENOTSUP"].includes(
      candidate.code,
    )
  ) {
    return true;
  }
  const message = candidate && typeof candidate.message === "string" ? candidate.message : "";
  return /channel not allowed|bridge unavailable|not implemented/i.test(message);
}

/** A form row in the sheet's own vocabulary: copy on the left, control right. */
function ConnectionRow({
  title,
  htmlFor,
  help,
  description,
  children,
}: {
  title?: string;
  /** Set when the title labels the control itself. */
  htmlFor?: string;
  help?: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="plugins-setting-row">
      <div className="plugins-setting-copy">
        {title ? (
          <div className="plugins-setting-title">
            {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : <span>{title}</span>}
            {help ? <HelpIcon label={help} /> : null}
          </div>
        ) : null}
        {description ? <p className="plugins-setting-description">{description}</p> : null}
      </div>
      {children ? <div className="plugins-setting-control">{children}</div> : null}
    </div>
  );
}

export function PluginConnectionsSection({ pluginId, permissions }: Props) {
  const { t } = useTranslation();
  const granted = (permissions ?? []).includes(CONNECTION_PERMISSION);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [issue, setIssue] = useState<ConnectionDraftIssue | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /**
   * Focus is a state transition, not a race: the editor asks for its first
   * field, and the closed editor asks for the entry it came from, both applied
   * after the commit that renders the target.
   */
  const [focusTarget, setFocusTarget] = useState<"label" | "add" | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const deleteRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!granted) return;
    let active = true;
    const api = bridge();
    if (!api) {
      setState({ status: "unsupported" });
      return;
    }
    setState({ status: "loading" });
    void api
      .invoke<{ connections: PluginConnectionRecord[] }>(LIST_CHANNEL, { pluginId })
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setState(
            isUnsupported(errorFrom(result)) ? { status: "unsupported" } : { status: "error" },
          );
          return;
        }
        setState({ status: "ready", connections: result.data.connections ?? [] });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState(isUnsupported(error) ? { status: "unsupported" } : { status: "error" });
      });
    return () => {
      active = false;
    };
  }, [granted, pluginId, reloadKey]);

  useLayoutEffect(() => {
    if (!focusTarget) return;
    if (focusTarget === "label") focusField(FIELD_ID.label);
    else addButtonRef.current?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  // The confirmation takes over the row, so focus starts on the safe choice.
  useLayoutEffect(() => {
    if (pendingDelete) cancelDeleteRef.current?.focus();
  }, [pendingDelete]);

  const startAdd = () => {
    setIssue(null);
    setActionError(null);
    setPendingDelete(null);
    setDraft(emptyConnectionDraft());
    setFocusTarget("label");
  };

  const startEdit = (connection: PluginConnectionRecord) => {
    setIssue(null);
    setActionError(null);
    setPendingDelete(null);
    setDraft(connectionDraft(connection));
    setFocusTarget("label");
  };

  const closeEditor = () => {
    setDraft(null);
    setIssue(null);
    setActionError(null);
    setFocusTarget("add");
  };

  const update = (patch: Partial<ConnectionDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setIssue(null);
    setActionError(null);
  };

  const updateRoute = (
    key: string,
    patch: { path?: string; methods?: PluginConnectionMethod[] },
  ) => {
    setDraft((current) =>
      current
        ? {
            ...current,
            routes: current.routes.map((route) =>
              route.key === key ? { ...route, ...patch } : route,
            ),
          }
        : current,
    );
    setIssue(null);
    setActionError(null);
  };

  const issueMessage = (current: ConnectionDraftIssue): string => {
    switch (current.kind) {
      case "label":
        return t("plugins.connections.errorLabel");
      case "baseUrl":
        return t("plugins.connections.errorBaseUrl");
      case "httpConsent":
        return t("plugins.connections.errorHttpConsent");
      case "tokenRequired":
        return t("plugins.connections.errorTokenRequired");
      case "routes":
        return t("plugins.connections.errorRoutes");
      case "routePath":
        return t("plugins.connections.errorRoutePath", { index: current.index + 1 });
      case "routeMethods":
        return t("plugins.connections.errorRouteMethods", { index: current.index + 1 });
      case "routeDuplicate":
        return t("plugins.connections.errorRouteDuplicate", { index: current.index + 1 });
    }
  };

  /** Back to the control that has to change, in reading order. */
  const revealIssue = (next: ConnectionDraftIssue) => {
    const route = "index" in next && draft ? draft.routes[next.index] : undefined;
    if (next.kind === "label") focusField(FIELD_ID.label);
    else if (next.kind === "baseUrl" || next.kind === "httpConsent") focusField(FIELD_ID.baseUrl);
    else if (next.kind === "tokenRequired") focusField(FIELD_ID.token);
    else if (route) focusField(`${FIELD_ID.route}${route.key}`);
  };

  /**
   * After a rejected compare-and-set: show the host's current list and let the
   * open editor compare against the re-issued revision, so the second save is a
   * real decision about what is on screen instead of a repeat conflict.
   */
  const reloadAfterConflict = async (id: string | undefined) => {
    const api = bridge();
    if (!api) return;
    const result = await api.invoke<{ connections: PluginConnectionRecord[] }>(LIST_CHANNEL, {
      pluginId,
    });
    if (!result.ok) return;
    const connections = result.data.connections ?? [];
    setState({ status: "ready", connections });
    if (id === undefined) return;
    const current = connections.find((entry) => entry.id === id);
    if (!current) {
      // Deleted elsewhere: there is nothing left to edit.
      setDraft(null);
      setFocusTarget("add");
      return;
    }
    setDraft((open) =>
      open && open.id === id
        ? {
            ...open,
            expectedRevision: current.revision,
            hasCredential: current.hasCredential,
            hasCustomCa: current.caConfigured,
          }
        : open,
    );
  };

  const save = async () => {
    if (!draft) return;
    const issues = validateConnectionDraft(draft);
    if (issues.length > 0) {
      setIssue(issues[0]);
      revealIssue(issues[0]);
      return;
    }
    const api = bridge();
    if (!api) {
      setActionError(t("plugins.connections.errorSave"));
      return;
    }
    setBusy(true);
    setActionError(null);
    setIssue(null);
    try {
      const result = await api.invoke<{ connection: PluginConnectionRecord }>(
        SAVE_CHANNEL,
        buildConnectionSaveInput(pluginId, draft),
      );
      if (!result.ok) throw errorFrom(result);
      // The host answer is the only record of what was stored; nothing here
      // is echoed back from the draft.
      const connection = result.data.connection;
      setState((current) =>
        // A save can outlive a failed list read; its answer is still the record
        // of a connection that now exists.
        current.status === "ready"
          ? { status: "ready", connections: upsertConnection(current.connections, connection) }
          : { status: "ready", connections: [connection] },
      );
      setDraft(null);
      setFocusTarget("add");
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "CONFLICT") {
        // Another writer moved this connection on. The row the user is editing
        // is now stale, so show the host's current copy and adopt its revision
        // before the next save; the typed values stay so nothing is retyped.
        setActionError(t("plugins.connections.errorConflict"));
        await reloadAfterConflict(draft.id);
        return;
      }
      setActionError(
        code === "HTTP_CONSENT_REQUIRED"
          ? t("plugins.connections.errorHttpConsent")
          : t("plugins.connections.errorSave"),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (connection: PluginConnectionRecord) => {
    const api = bridge();
    if (!api) {
      setActionError(t("plugins.connections.errorDelete"));
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const result = await api.invoke<{ ok: true }>(DELETE_CHANNEL, {
        pluginId,
        connectionId: connection.id,
      });
      if (!result.ok) throw errorFrom(result);
      setState((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              connections: current.connections.filter((entry) => entry.id !== connection.id),
            }
          : current,
      );
      setPendingDelete(null);
    } catch {
      setActionError(t("plugins.connections.errorDelete"));
    } finally {
      setBusy(false);
    }
  };

  if (!granted || state.status === "unsupported") return null;

  const connections = state.status === "ready" ? state.connections : [];
  const tokenPlaceholder =
    draft?.hasCredential && !draft.clearToken
      ? t("plugins.connections.tokenPlaceholderKeep")
      : t("plugins.connections.tokenPlaceholderNew");

  return (
    <>
      <ConnectionRow
        title={t("plugins.connections.title")}
        help={t("plugins.connections.description")}
        description={
          state.status === "ready" && connections.length === 0
            ? t("plugins.connections.empty")
            : undefined
        }
      >
        <Button ref={addButtonRef} size="sm" onClick={startAdd} disabled={busy}>
          <IconPlus size={14} />
          {t("plugins.connections.add")}
        </Button>
      </ConnectionRow>

      {state.status === "loading" ? (
        <p className="plugins-setting-description" role="status">
          {t("plugins.connections.loading")}
        </p>
      ) : null}

      {state.status === "error" ? (
        <ConnectionRow
          title={t("plugins.connections.loadFailed")}
          description={t("plugins.connections.loadFailedHint")}
        >
          <Button size="sm" onClick={() => setReloadKey((current) => current + 1)}>
            {t("plugins.connections.retry")}
          </Button>
        </ConnectionRow>
      ) : null}

      {connections.map((connection) => {
        if (pendingDelete === connection.id) {
          return (
            <div
              key={connection.id}
              className="plugins-setting-row"
              role="group"
              aria-label={t("plugins.connections.deleteTitle", { label: connection.label })}
            >
              <div className="plugins-setting-copy">
                <div className="plugins-setting-title">
                  {t("plugins.connections.deleteTitle", { label: connection.label })}
                </div>
                <p className="plugins-setting-description">
                  {t("plugins.connections.deleteBody")}
                </p>
              </div>
              <div className="plugins-setting-control">
                <Button
                  ref={cancelDeleteRef}
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setPendingDelete(null);
                    deleteRefs.current.get(connection.id)?.focus();
                  }}
                >
                  {t("plugins.connections.deleteCancel")}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => void remove(connection)}
                >
                  {t("plugins.connections.deleteConfirm")}
                </Button>
              </div>
            </div>
          );
        }
        const routes = connectionRouteSummary(connection);
        return (
          <div key={connection.id} className="plugins-setting-row">
            <div className="plugins-setting-copy">
              <div className="plugins-setting-title">
                <span>{connection.label}</span>
                <Badge tone={connection.hasCredential ? "neutral" : "warning"}>
                  {connection.hasCredential
                    ? t("plugins.connections.tokenStored")
                    : t("plugins.connections.tokenMissing")}
                </Badge>
                {connection.caConfigured ? (
                  <Badge tone="neutral">{t("plugins.connections.customCa")}</Badge>
                ) : null}
                {connection.allowHttp ? (
                  <Badge tone="warning">{t("plugins.connections.plainHttp")}</Badge>
                ) : null}
              </div>
              <p className="plugins-setting-description">
                <code>{connection.baseUrl}</code>
                {routes.length > 0 ? (
                  <>
                    <span className="plugins-dot" aria-hidden>
                      ·
                    </span>
                    <span>{routes.join(" · ")}</span>
                  </>
                ) : null}
              </p>
            </div>
            <div className="plugins-setting-control">
              <Button
                size="sm"
                disabled={busy}
                aria-label={t("plugins.connections.editConnection", {
                  label: connection.label,
                })}
                onClick={() => startEdit(connection)}
              >
                {t("plugins.connections.edit")}
              </Button>
              <TooltipButton
                ref={(node) => {
                  deleteRefs.current.set(connection.id, node);
                }}
                type="button"
                className="plugins-icon-btn"
                tooltip={t("plugins.connections.deleteConnection", {
                  label: connection.label,
                })}
                ariaLabel={t("plugins.connections.deleteConnection", {
                  label: connection.label,
                })}
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setActionError(null);
                  setPendingDelete(connection.id);
                }}
              >
                <IconTrash size={14} />
              </TooltipButton>
            </div>
          </div>
        );
      })}

      {draft ? (
        <>
          <ConnectionRow
            title={
              draft.id ? t("plugins.connections.editTitle") : t("plugins.connections.newTitle")
            }
            description={t("plugins.connections.formHint")}
          >
            <Button size="sm" disabled={busy} onClick={closeEditor}>
              {t("plugins.connections.cancel")}
            </Button>
          </ConnectionRow>

          {issue ? (
            <p className="plugins-settings-error" role="alert">
              {issueMessage(issue)}
            </p>
          ) : null}

          <ConnectionRow
            title={t("plugins.connections.labelField")}
            htmlFor={FIELD_ID.label}
          >
            <Input
              id={FIELD_ID.label}
              value={draft.label}
              placeholder={t("plugins.connections.labelPlaceholder")}
              aria-invalid={issue?.kind === "label" || undefined}
              onChange={(event) => update({ label: event.target.value })}
            />
          </ConnectionRow>

          <ConnectionRow
            title={t("plugins.connections.baseUrlField")}
            htmlFor={FIELD_ID.baseUrl}
            help={t("plugins.connections.baseUrlHint")}
            description={
              endpointChanged(draft) ? t("plugins.connections.endpointChangedNote") : undefined
            }
          >
            <Input
              id={FIELD_ID.baseUrl}
              type="url"
              inputMode="url"
              value={draft.baseUrl}
              placeholder={t("plugins.connections.baseUrlPlaceholder")}
              aria-invalid={
                issue?.kind === "baseUrl" || issue?.kind === "httpConsent" || undefined
              }
              onChange={(event) => update({ baseUrl: event.target.value })}
            />
          </ConnectionRow>

          <ConnectionRow
            title={t("plugins.connections.tokenField")}
            htmlFor={FIELD_ID.token}
            description={t("plugins.connections.tokenHint")}
          >
            <PasswordInput
              id={FIELD_ID.token}
              value={draft.token}
              placeholder={tokenPlaceholder}
              autoComplete="off"
              showLabel={t("plugins.connections.showToken")}
              hideLabel={t("plugins.connections.hideToken")}
              aria-invalid={issue?.kind === "tokenRequired" || undefined}
              onChange={(event) => update({ token: event.target.value, clearToken: false })}
            />
          </ConnectionRow>

          {draft.hasCredential ? (
            <div className="plugins-setting-row">
              <div className="plugins-setting-copy">
                <Checkbox
                  label={t("plugins.connections.tokenClear")}
                  checked={draft.clearToken}
                  onChange={(event) =>
                    update({ clearToken: event.target.checked, token: "" })
                  }
                />
                {draft.clearToken ? (
                  <p className="plugins-setting-description">
                    {t("plugins.connections.tokenClearNote")}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          <ConnectionRow
            title={t("plugins.connections.allowHttpTitle")}
            description={t("plugins.connections.allowHttpWarning")}
          >
            <SettingsToggle
              label={t("plugins.connections.allowHttpTitle")}
              checked={draft.allowHttp}
              onChange={() => update({ allowHttp: !draft.allowHttp })}
            />
          </ConnectionRow>

          <ConnectionRow
            title={t("plugins.connections.caField")}
            htmlFor={FIELD_ID.ca}
            help={t("plugins.connections.caHint")}
            description={draft.hasCustomCa ? t("plugins.connections.caConfigured") : undefined}
          >
            <Textarea
              id={FIELD_ID.ca}
              className="plugins-setting-json"
              value={draft.caPem}
              placeholder={t("plugins.connections.caPlaceholder")}
              onChange={(event) => update({ caPem: event.target.value, clearCa: false })}
            />
          </ConnectionRow>

          {draft.hasCustomCa ? (
            <div className="plugins-setting-row">
              <div className="plugins-setting-copy">
                <Checkbox
                  label={t("plugins.connections.caClear")}
                  checked={draft.clearCa}
                  onChange={(event) => update({ clearCa: event.target.checked, caPem: "" })}
                />
              </div>
            </div>
          ) : null}

          <ConnectionRow
            title={t("plugins.connections.routesTitle")}
            help={t("plugins.connections.routesHint")}
          >
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                setDraft((current) =>
                  current
                    ? { ...current, routes: [...current.routes, draftRoute()] }
                    : current,
                )
              }
            >
              <IconPlus size={14} />
              {t("plugins.connections.routeAdd")}
            </Button>
          </ConnectionRow>

          {draft.routes.map((route, index) => (
            <div key={route.key} className="plugins-setting-row">
              <div className="plugins-setting-copy">
                <div className="plugins-setting-title">
                  {t("plugins.connections.routeLabel", { index: index + 1 })}
                </div>
                <p className="plugins-setting-description">
                  {resolvedRouteUrl(draft.baseUrl, route.path) ??
                    t("plugins.connections.routePreviewEmpty")}
                </p>
              </div>
              <div className="plugins-setting-control">
                <Input
                  id={`${FIELD_ID.route}${route.key}`}
                  aria-label={t("plugins.connections.routePath", { index: index + 1 })}
                  value={route.path}
                  placeholder={t("plugins.connections.routePathPlaceholder")}
                  onChange={(event) => updateRoute(route.key, { path: event.target.value })}
                />
                <CheckboxGroup
                  label={t("plugins.connections.routeMethods", { index: index + 1 })}
                  values={route.methods}
                  options={[
                    { value: "GET" as const, label: t("plugins.connections.methodGet") },
                    { value: "POST" as const, label: t("plugins.connections.methodPost") },
                  ]}
                  onChange={(methods) => updateRoute(route.key, { methods })}
                />
                <TooltipButton
                  type="button"
                  className="plugins-icon-btn"
                  tooltip={t("plugins.connections.routeRemove", { index: index + 1 })}
                  ariaLabel={t("plugins.connections.routeRemove", { index: index + 1 })}
                  disabled={busy || draft.routes.length <= 1}
                  onClick={() =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            routes: current.routes.filter((entry) => entry.key !== route.key),
                          }
                        : current,
                    )
                  }
                >
                  <IconTrash size={14} />
                </TooltipButton>
              </div>
            </div>
          ))}

          <ConnectionRow>
            <Button size="sm" disabled={busy} onClick={closeEditor}>
              {t("plugins.connections.cancel")}
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
              {busy ? t("plugins.connections.saving") : t("plugins.connections.save")}
            </Button>
          </ConnectionRow>
        </>
      ) : null}

      {actionError ? (
        <p className="plugins-settings-error" role="alert">
          {actionError}
        </p>
      ) : null}
    </>
  );
}
