/**
 * Interactive terminal profiles for the work-panel terminal (spec: terminal
 * panel in the side work panel). A profile is one launchable shell program;
 * availability is probed by Electron main, never asserted by the renderer.
 */

export const TERMINAL_SHELL_FAMILIES = [
  "cmd",
  "powershell",
  "pwsh",
  "bash",
  "zsh",
  "fish",
  "wsl",
  "custom",
] as const;

export type TerminalShellFamily = (typeof TERMINAL_SHELL_FAMILIES)[number];

export function isTerminalShellFamily(value: unknown): value is TerminalShellFamily {
  return (
    typeof value === "string" &&
    (TERMINAL_SHELL_FAMILIES as readonly string[]).includes(value)
  );
}

/** One launchable shell discovered on this machine. */
export type TerminalShellProfile = {
  /** Stable id, e.g. `pwsh`, `git-bash`, `wsl`. */
  id: string;
  /** Display name, e.g. `PowerShell 7`. */
  label: string;
  /** Absolute executable path resolved by main. */
  path: string;
  /** Extra argv entries between the program and the interactive session. */
  args?: string[];
  family: TerminalShellFamily;
  /** Marks the profile the terminal opens when no shell is chosen. */
  isDefault?: boolean;
};

export function isTerminalShellProfile(value: unknown): value is TerminalShellProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  return (
    typeof profile.id === "string" &&
    profile.id.length > 0 &&
    typeof profile.label === "string" &&
    profile.label.length > 0 &&
    typeof profile.path === "string" &&
    profile.path.length > 0 &&
    isTerminalShellFamily(profile.family) &&
    (profile.args === undefined ||
      (Array.isArray(profile.args) &&
        profile.args.every((arg) => typeof arg === "string")))
  );
}

/** Result of `terminalCreate`: the handle the renderer drives afterwards. */
export type TerminalOpenResult = {
  terminalId: string;
  /** Profile id that produced this terminal, for tab labels and restart. */
  shellId: string;
  cols: number;
  rows: number;
};

export function isTerminalOpenResult(value: unknown): value is TerminalOpenResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.terminalId === "string" &&
    result.terminalId.length > 0 &&
    typeof result.shellId === "string" &&
    typeof result.cols === "number" &&
    typeof result.rows === "number"
  );
}

/** Payload of the `terminalData` event: one base64 PTY output chunk. */
export type TerminalDataEvent = {
  terminalId: string;
  data: string;
};

/** Payload of the `terminalExit` event. */
export type TerminalExitEvent = {
  terminalId: string;
  exitCode: number | null;
};

export function isTerminalDataEvent(value: unknown): value is TerminalDataEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.terminalId === "string" && typeof event.data === "string";
}

export function isTerminalExitEvent(value: unknown): value is TerminalExitEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.terminalId === "string" &&
    (event.exitCode === null || typeof event.exitCode === "number")
  );
}
