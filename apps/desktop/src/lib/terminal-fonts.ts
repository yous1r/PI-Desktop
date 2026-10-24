/**
 * Terminal font model for the Settings picker.
 *
 * The terminal picker is deliberately narrower than the global UI font picker:
 * a proportional face breaks the fixed-column grid a shell depends on, so only
 * families that are monospaced — by name convention or by being in the
 * allow-list below — are offered. The stored value is a CSS stack, matching
 * `AppSettings.terminal.fontFamily`.
 */
import { DEFAULT_TERMINAL_FONT_FAMILY } from "@pi-desktop/shared";

/** Quote a bare family name for use inside a CSS font-family stack. */
function cssFamily(name: string): string {
  return `'${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * The stack persisted for a chosen family. The chosen face leads, then the
 * built-in monospace stack keeps the grid intact when that family has no CJK
 * or box-drawing glyphs.
 */
export function terminalFontStack(family: string): string {
  if (!family.trim()) return "";
  return `${cssFamily(family)}, ${DEFAULT_TERMINAL_FONT_FAMILY}`;
}

/** Families that are monospaced even though their name does not say so. */
const KNOWN_MONOSPACE = new Set([
  "consolas",
  "courier",
  "courier new",
  "dejavu sans mono",
  "droid sans mono",
  "fira code",
  "fira mono",
  "hack",
  "ibm plex mono",
  "inconsolata",
  "jetbrains mono",
  "lucida console",
  "menlo",
  "monaco",
  "monoid",
  "noto sans mono",
  "pt mono",
  "roboto mono",
  "sf mono",
  "source code pro",
  "space mono",
  "ubuntu mono",
  "victor mono",
]);

/** Heuristic used for families the allow-list does not name. */
const MONOSPACE_HINT = /\b(mono|code|consol|courier|typewriter|fixed)\b/i;

export function isMonospaceFamily(family: string): boolean {
  const normalized = family.trim().toLowerCase();
  if (!normalized) return false;
  return KNOWN_MONOSPACE.has(normalized) || MONOSPACE_HINT.test(family);
}

/** Extract the first readable family name from a CSS stack. */
export function readableFamily(stack: string): string {
  const first = stack.split(",")[0]?.trim() ?? stack;
  return first.replace(/^['"]|['"]$/g, "");
}

export type TerminalFontOption = { id: string; label: string };

/**
 * Options for the terminal font picker: the built-in stack, then installed
 * monospaced families. The stored stack is re-added when it names a family the
 * machine no longer reports, so the current value never disappears from the
 * list and silently resets on the next write.
 */
export function buildTerminalFontOptions(
  systemFonts: readonly string[],
  selected: string | undefined,
): TerminalFontOption[] {
  const options: TerminalFontOption[] = [
    { id: "", label: "System monospace" },
    ...systemFonts
      .filter(isMonospaceFamily)
      .map((family) => ({ id: family, label: family })),
  ];
  const selectedFamily = selected ? readableFamily(selected) : "";
  if (
    selectedFamily &&
    selectedFamily !== readableFamily(DEFAULT_TERMINAL_FONT_FAMILY) &&
    !options.some((option) => option.id === selectedFamily)
  ) {
    options.push({ id: selectedFamily, label: selectedFamily });
  }
  return options;
}
