import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Field, Input, PasswordInput } from "../ui";
import { SettingsMenuSelect } from "../settings/SettingsMenuSelect";
import { readMcpCaFile, selectMcpAuthentication, type McpDraft } from "./mcp-editor-model";

export function McpHttpSecurityFields({ draft, setDraft, currentProjectPath, busy }: {
  draft: McpDraft; setDraft: (next: McpDraft) => void; currentProjectPath?: string | null; busy: boolean;
}) {
  const { t } = useTranslation();
  const latest = useRef(draft);
  latest.current = draft;
  const active = useRef(true);
  const caRequest = useRef(0);
  const [caError, setCaError] = useState("");
  useEffect(() => { active.current = true; return () => { active.current = false; caRequest.current += 1; }; }, []);
  const bindings = Object.entries(draft.memoryProjectBindings);
  const memory = draft.id === "superclaude-memory" || bindings.length > 0;

  return <>
    <p className="ext-sheet-note" role="note">{t("mcpSecurity.connectionDesktop")}</p>
    <Field label={t("mcpSecurity.authentication")} hint={t("mcpSecurity.authenticationHint")}>
      <SettingsMenuSelect value={draft.authType} label={t("mcpSecurity.authentication")} disabled={busy} fullWidth
        options={[{ id: "none", label: t("mcpSecurity.headersOrOauth") }, { id: "bearer", label: t("mcpSecurity.managedBearer") }]}
        onChange={(value) => setDraft(selectMcpAuthentication(draft, value === "bearer" ? "bearer" : "none"))} />
    </Field>
    {draft.authType === "bearer" ? <>
      <Field label={t("mcpSecurity.token")} hint={t("mcpSecurity.tokenHint")}>
        <PasswordInput value={draft.bearerToken} autoComplete="new-password" disabled={busy}
          showLabel={t("mcpSecurity.showToken")} hideLabel={t("mcpSecurity.hideToken")}
          placeholder={t(draft.clearBearerToken ? "mcpSecurity.tokenCleared" : draft.hasBearerToken ? "mcpSecurity.tokenRetained" : "mcpSecurity.tokenPlaceholder")}
          onChange={(event) => setDraft({ ...draft, bearerToken: event.target.value, clearBearerToken: false })} />
      </Field>
      <Button variant="ghost" disabled={busy || draft.clearBearerToken} onClick={() => setDraft({ ...draft, bearerToken: "", clearBearerToken: true })}>
        {t("mcpSecurity.clearToken")}
      </Button>
    </> : null}
    <Field label={t("mcpSecurity.ca")} hint={t("mcpSecurity.caHint")}>
      <Input type="file" accept=".pem,.crt,.cer" aria-label={t("mcpSecurity.importCa")} disabled={busy}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          const request = ++caRequest.current;
          if (!file) return;
          setCaError("");
          try {
            const pem = await readMcpCaFile(file);
            if (active.current && request === caRequest.current && latest.current.transport === "http") setDraft({ ...latest.current, caCertificate: pem });
          } catch {
            if (active.current && request === caRequest.current) setCaError(t("mcpSecurity.errorCa"));
          }
        }} />
    </Field>
    {caError ? <p role="alert" className="ext-sheet-error">{caError}</p> : null}
    {draft.caCertificate ? <div>
      <p className="ext-sheet-note">{t("mcpSecurity.caConfigured")}</p>
      <Button variant="ghost" disabled={busy} onClick={() => { caRequest.current += 1; setCaError(""); setDraft({ ...draft, caCertificate: "" }); }}>{t("mcpSecurity.removeCa")}</Button>
    </div> : null}
    {memory ? <div className="ext-field-group">
      <p className="ext-sheet-note" role="note">{t("mcpSecurity.bindingHint")}</p>
      {bindings.map(([path, id]) => <div key={path} className="ext-field-pair">
        <Field label={t("mcpSecurity.piProject")}><Input value={path} readOnly /></Field>
        <Field label={t("mcpSecurity.centralProject")}>
          <Input value={id} placeholder={t("mcpSecurity.centralPlaceholder")} disabled={busy}
            onChange={(event) => setDraft({ ...draft, memoryProjectBindings: { ...draft.memoryProjectBindings, [path]: event.target.value } })} />
          <Button variant="ghost" disabled={busy} onClick={() => {
            const next = { ...draft.memoryProjectBindings }; delete next[path]; setDraft({ ...draft, memoryProjectBindings: next });
          }}>{t("mcpSecurity.removeBinding")}</Button>
        </Field>
      </div>)}
      <Button variant="ghost" disabled={busy || !currentProjectPath || currentProjectPath in draft.memoryProjectBindings || bindings.length >= 64}
        onClick={() => { if (currentProjectPath) setDraft({ ...draft, memoryProjectBindings: { ...draft.memoryProjectBindings, [currentProjectPath]: "" } }); }}>
        {t("mcpSecurity.bindSelectedProject")}
      </Button>
      {!currentProjectPath ? <p className="ext-sheet-note">{t("mcpSecurity.chooseProject")}</p> : null}
    </div> : null}
  </>;
}
