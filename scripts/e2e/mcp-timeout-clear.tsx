import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import caCertificate from "./fixtures/certificates/localhost-cert.pem";
import {
  draftFromRecord,
  draftToInput,
  McpEditorSheet,
} from "../../apps/desktop/src/components/extensions/McpEditorSheet";

const record = {
  id: "slow-server",
  label: "Slow server",
  transport: "stdio" as const,
  command: "npx",
  enabled: true,
  timeoutSeconds: 45,
};

const i18n = createInstance();

function Harness() {
  const [draft, setDraft] = useState(() => draftFromRecord(record));
  const save = () => {
    window.__mcpTimeoutSaved = draftToInput(draft).timeoutSeconds;
  };

  return (
    <I18nextProvider i18n={i18n}>
      <McpEditorSheet
        draft={draft}
        setDraft={setDraft}
        editing={record}
        saving={false}
        testing={false}
        projects={[]}
        onClose={() => {}}
        onSave={save}
        onTest={() => {}}
      />
    </I18nextProvider>
  );
}

declare global {
  interface Window {
    __mcpTimeoutSaved?: number | null;
    mcpCertificateProbe: () => Record<string, boolean>;
    mcpTimeoutClearProbe: () => Promise<{
      originalValue: string;
      invalidValueBlocked: boolean;
      clearedValueEnabled: boolean;
      savedTimeoutSeconds: number | null | undefined;
    }>;
  }
}

void i18n
  .use(initReactI18next)
  .init({
    lng: "en",
    fallbackLng: "en",
    keySeparator: false,
    resources: { en: { translation: flattenCatalog(catalogs.en) } },
    interpolation: { escapeValue: false },
  })
  .then(() => {
    const root = createRoot(document.getElementById("root")!);
    flushSync(() => root.render(<Harness />));

    window.mcpTimeoutClearProbe = async () => {
      const input = document.querySelector<HTMLInputElement>(
        'input[type="number"]',
      );
      if (!input) throw new Error("MCP timeout input was not rendered");
      const originalValue = input.value;
      const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === "Save",
      );
      if (!save) throw new Error("MCP save button was not rendered");

      const setInputValue = (value: string) => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        if (!setter) throw new Error("HTML input value setter is unavailable");
        flushSync(() => {
          setter.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        });
      };

      setInputValue("601");
      const invalidValueBlocked = save.disabled;

      setInputValue("");
      const clearedValueEnabled = !save.disabled;
      if (clearedValueEnabled) {
        flushSync(() => save.click());
      }

      return {
        originalValue,
        invalidValueBlocked,
        clearedValueEnabled,
        savedTimeoutSeconds: window.__mcpTimeoutSaved,
      };
    };

    window.mcpCertificateProbe = () => {
      const httpRecord = { ...record, transport: "http" as const, url: "https://localhost/mcp", caCertificate };
      let savedCa: string | null | undefined;
      function CertificateHarness() {
        const [draft, setDraft] = useState(() => draftFromRecord(httpRecord));
        return <I18nextProvider i18n={i18n}><McpEditorSheet
          draft={draft} setDraft={setDraft} editing={httpRecord} saving={false}
          testing={false} projects={[]} onClose={() => {}} onTest={() => {}}
          onSave={() => {
            const input = draftToInput(draft);
            savedCa = input.caCertificate;
            setDraft(draftFromRecord({ ...httpRecord, caCertificate: input.caCertificate ?? undefined }));
          }}
        /></I18nextProvider>;
      }
      flushSync(() => root.render(<CertificateHarness />));
      const ca = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Custom CA certificate"]');
      const url = document.querySelector<HTMLInputElement>('input[placeholder="https://mcp.example.com/sse"]');
      const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Save");
      if (!ca || !url || !save) throw new Error("MCP certificate controls are missing");
      const change = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
        const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        if (!setter) throw new Error("Input value setter is unavailable");
        flushSync(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
      };
      const existingCertificateVisible = ca.value === caCertificate;
      change(ca, `  ${caCertificate}\n`);
      flushSync(() => save.click());
      const certificateSavedAndReopened = savedCa === caCertificate.trim() && ca.value === caCertificate.trim();
      change(url, "http://localhost/mcp");
      const plainHttpBlocked = save.disabled && document.querySelector(".ext-sheet-error")?.textContent === "A custom CA certificate requires an HTTPS address.";
      change(url, "https://localhost/mcp");
      change(ca, "");
      flushSync(() => save.click());
      const clearedCertificateReopenedEmpty = savedCa === null && ca.value === "" && !save.disabled;
      const local = document.querySelector<HTMLButtonElement>('button[role="radio"]');
      if (!local) throw new Error("MCP local transport choice is missing");
      flushSync(() => local.click());
      const stdioHidesCertificate = !document.querySelector('textarea[aria-label="Custom CA certificate"]');
      return { existingCertificateVisible, certificateSavedAndReopened, plainHttpBlocked, clearedCertificateReopenedEmpty, stdioHidesCertificate };
    };
  })
  .catch((error: unknown) => {
    console.error(error);
    throw error;
  });
