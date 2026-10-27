import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AppSettings } from "@pi-desktop/shared";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  resolveTerminalAppearance,
  resolveTerminalColorScheme,
} from "@pi-desktop/shared";

import { SettingsRow } from "../../features/settings/primitives";
import { useAppStore } from "../../stores/app-store";
import { Input, Textarea } from "../ui";
import { SettingsMenuSelect } from "./SettingsMenuSelect";
import { loadSystemFonts } from "../../lib/fonts";
import {
  buildTerminalFontOptions,
  readableFamily,
  terminalFontStack,
} from "../../lib/terminal-fonts";
import { buildTerminalSchemeOptions } from "../../lib/terminal-theme";
import { TerminalSchemePreview } from "./TerminalSchemePreview";
/**
 * Terminal card (Settings → General → Terminal).
 *
 * Two things are configurable because two things were wrong by default: the
 * face the grid is drawn with, and the argv the shell is started with. Both
 * persist under `AppSettings.terminal`; the appearance half is read by
 * TerminalTab, the launch half by Electron main when it spawns the PTY.
 *
 * The picker offers concrete monospace families only. A proportional family
 * would break column alignment, which is the whole point of a terminal.
 */
export function TerminalSettingsCard({
  settings,
  saveSettings,
}: {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const terminal = settings.terminal ?? {};
  const appearance = useMemo(() => resolveTerminalAppearance(terminal), [terminal]);
  const colorScheme = useMemo(() => resolveTerminalColorScheme(terminal), [terminal]);
  const schemeOptions = useMemo(
    () =>
      buildTerminalSchemeOptions((id, fallback) => {
        const key = `settings.terminalTheme.${id.replace(
          /-([a-z])/g,
          (_match: string, char: string) => char.toUpperCase(),
        )}`;
        const translated = t(key);
        // i18next echoes the key back when a locale has no entry; the scheme's
        // own English label is the honest fallback.
        return translated === key ? fallback : translated;
      }),
    [t],
  );

  const [fonts, setFonts] = useState<string[] | null>(null);
  const [fontSizeDraft, setFontSizeDraft] = useState(String(appearance.fontSize));
  const [launchArgsDraft, setLaunchArgsDraft] = useState(terminal.launchArgs ?? "");
  const [envDraft, setEnvDraft] = useState(terminal.env ?? "");

  useEffect(() => {
    let cancelled = false;
    void loadSystemFonts()
      .then((list) => {
        if (!cancelled) setFonts(list);
      })
      .catch(() => {
        // The built-in stack stays selectable; enumerating families is not
        // something the user asked for, so a failure only shortens the list.
        if (!cancelled) setFonts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Drafts follow the persisted value when another surface changes it.
  useEffect(() => {
    setFontSizeDraft(String(appearance.fontSize));
  }, [appearance.fontSize]);
  useEffect(() => {
    setLaunchArgsDraft(terminal.launchArgs ?? "");
  }, [terminal.launchArgs]);
  useEffect(() => {
    setEnvDraft(terminal.env ?? "");
  }, [terminal.env]);

  const fontOptions = useMemo(
    () => buildTerminalFontOptions(fonts ?? [], terminal.fontFamily),
    [fonts, terminal.fontFamily],
  );

  const save = async (patch: Partial<AppSettings["terminal"]>) => {
    try {
      await saveSettings({ terminal: { ...terminal, ...patch } });
    } catch {
      showToast(t("settings.terminalSaveError"), { variant: "error" });
    }
  };

  const commitFontSize = () => {
    const parsed = Number(fontSizeDraft.trim());
    if (!Number.isFinite(parsed)) {
      setFontSizeDraft(String(appearance.fontSize));
      return;
    }
    const next = Math.min(
      TERMINAL_FONT_SIZE_MAX,
      Math.max(TERMINAL_FONT_SIZE_MIN, Math.round(parsed)),
    );
    setFontSizeDraft(String(next));
    if (next === appearance.fontSize) return;
    void save({ fontSize: next });
  };

  return (
    <>
      <SettingsRow
        title={t("settings.terminalTheme")}
        description={t("settings.terminalThemeDesc")}
      >
        <div className="settings-terminal-theme">
          <SettingsMenuSelect
            className="settings-terminal-theme-select"
            label={t("settings.terminalTheme")}
            value={colorScheme}
            options={schemeOptions}
            onChange={(id) => {
              if (id === colorScheme) return;
              void save({ theme: id as typeof terminal.theme });
            }}
          />
          <TerminalSchemePreview
            schemeId={colorScheme}
            className="settings-terminal-theme-preview"
          />
        </div>
      </SettingsRow>

      <SettingsRow
        title={t("settings.terminalFont")}
        description={t("settings.terminalFontDesc")}
      >
        <SettingsMenuSelect
          className="settings-terminal-font-select"
          label={t("settings.terminalFont")}
          value={terminal.fontFamily ? readableFamily(terminal.fontFamily) : ""}
          options={fontOptions}
          onChange={(family) => void save({ fontFamily: terminalFontStack(family) })}
        />
      </SettingsRow>

      <SettingsRow
        title={t("settings.terminalFontSize")}
        description={t("settings.terminalFontSizeDesc")}
      >
        <div className="settings-number-control">
          <Input
            type="number"
            min={TERMINAL_FONT_SIZE_MIN}
            max={TERMINAL_FONT_SIZE_MAX}
            step={1}
            inputMode="numeric"
            value={fontSizeDraft}
            aria-label={t("settings.terminalFontSize")}
            placeholder={String(DEFAULT_TERMINAL_FONT_SIZE)}
            onChange={(event) => setFontSizeDraft(event.target.value)}
            onBlur={commitFontSize}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.currentTarget.blur();
            }}
          />
        </div>
      </SettingsRow>

      <SettingsRow
        title={t("settings.terminalLaunchArgs")}
        description={t("settings.terminalLaunchArgsDesc")}
      >
        <div className="settings-terminal-launch">
          <Input
            value={launchArgsDraft}
            aria-label={t("settings.terminalLaunchArgs")}
            placeholder={t("settings.terminalLaunchArgsPlaceholder")}
            spellCheck={false}
            onChange={(event) => setLaunchArgsDraft(event.target.value)}
            onBlur={() => {
              if (launchArgsDraft === (terminal.launchArgs ?? "")) return;
              void save({ launchArgs: launchArgsDraft });
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              event.currentTarget.blur();
            }}
          />
        </div>
      </SettingsRow>

      <SettingsRow
        title={t("settings.terminalEnv")}
        description={t("settings.terminalEnvDesc")}
      >
        <div className="settings-terminal-launch">
          <Textarea
            className="settings-terminal-env"
            value={envDraft}
            rows={3}
            aria-label={t("settings.terminalEnv")}
            placeholder={t("settings.terminalEnvPlaceholder")}
            onChange={(event) => setEnvDraft(event.target.value)}
            onBlur={() => {
              if (envDraft === (terminal.env ?? "")) return;
              void save({ env: envDraft });
            }}
          />
        </div>
      </SettingsRow>
    </>
  );
}
