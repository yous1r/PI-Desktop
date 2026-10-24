import { existsSync } from "node:fs";
import { join } from "node:path";
import { delimiter, sep } from "node:path";

import type { TerminalShellProfile } from "@pi-desktop/shared";

/**
 * Shell discovery for the work-panel terminal. Detection is filesystem-only:
 * candidate paths are probed with `existsSync`; no shell is ever executed to
 * learn the catalog, so a hostile PATH entry cannot run code during discovery.
 *
 * The probe order mirrors `crates/host-core/src/tools/shell.rs` so the
 * interactive terminal launches the same binaries the agent's Bash tool
 * resolves on this machine.
 */

export type ShellRegistryOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Cached scan lifetime; a `refresh` request bypasses it. */
  cacheMs?: number;
  fileExists?: (path: string) => boolean;
};

type ScanInput = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fileExists: (path: string) => boolean;
};

const DEFAULT_CACHE_MS = 30_000;

function searchPath(scan: ScanInput, name: string): string | null {
  const pathValue = scan.env.PATH ?? "";
  for (const rawDir of pathValue.split(delimiter)) {
    // A quoted PATH entry (`"C:\Program Files\Git\cmd"`) is common on Windows;
    // the quotes are not part of the directory name.
    const dir = rawDir.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const candidate = join(dir, name);
    if (scan.fileExists(candidate)) return candidate;
  }
  return null;
}

function firstExisting(scan: ScanInput, candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (scan.fileExists(candidate)) return candidate;
  }
  return null;
}

/** Expand `%SystemRoot%`-anchored and program-folder candidates on Windows. */
function windowsCommonRoots(scan: ScanInput): string[] {
  const roots: string[] = [];
  const systemRoot = scan.env.SystemRoot ?? "C:\\Windows";
  roots.push(systemRoot);
  for (const base of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "LocalAppData"]) {
    const value = scan.env[base];
    if (!value) continue;
    roots.push(base === "LocalAppData" ? join(value, "Programs") : value);
  }
  return roots;
}

/** Resolve Git Bash: relative to git.exe on PATH, then known install folders. */
function findGitBash(scan: ScanInput): string | null {
  if (scan.platform !== "win32") return null;
  const git = searchPath(scan, "git.exe");
  if (git) {
    // `…\Git\cmd\git.exe` or `…\Git\bin\git.exe` → the install root two levels up.
    const segments = git.split(sep);
    while (segments.length > 2) {
      segments.pop();
      const root = segments.join(sep);
      const candidate = firstExisting(scan, [join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe")]);
      if (candidate) return candidate;
    }
  }
  const roots = windowsCommonRoots(scan).map((root) => join(root, "Git", "bin", "bash.exe"));
  const direct = firstExisting(scan, roots);
  if (direct) return direct;
  // A PATH `bash.exe` outside System32 is a portable Git Bash install.
  const onPath = searchPath(scan, "bash.exe");
  if (onPath && !/System32/i.test(onPath)) return onPath;
  return null;
}

function findPwsh(scan: ScanInput): string | null {
  if (scan.platform !== "win32") {
    return searchPath(scan, "pwsh");
  }
  const roots = windowsCommonRoots(scan).map((root) => join(root, "PowerShell", "7", "pwsh.exe"));
  const machineScope = firstExisting(scan, roots);
  return machineScope ?? searchPath(scan, "pwsh.exe");
}

function findWindowsPowerShell(scan: ScanInput): string | null {
  const systemRoot = scan.env.SystemRoot ?? "C:\\Windows";
  const wellKnown = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return firstExisting(scan, [wellKnown]) ?? searchPath(scan, "powershell.exe");
}

function findCmd(scan: ScanInput): string | null {
  const comSpec = scan.env.ComSpec;
  if (comSpec && scan.fileExists(comSpec)) return comSpec;
  const systemRoot = scan.env.SystemRoot ?? "C:\\Windows";
  return firstExisting(scan, [join(systemRoot, "System32", "cmd.exe")]) ?? searchPath(scan, "cmd.exe");
}

function findWsl(scan: ScanInput): string | null {
  if (scan.platform !== "win32") return null;
  const systemRoot = scan.env.SystemRoot ?? "C:\\Windows";
  return firstExisting(scan, [join(systemRoot, "System32", "wsl.exe")]) ?? searchPath(scan, "wsl.exe");
}

const POSIX_FALLBACKS = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"];

function findPosixShell(scan: ScanInput, name: "bash" | "zsh" | "fish"): string | null {
  const candidates: string[] = [`/bin/${name}`, `/usr/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`];
  return firstExisting(scan, candidates) ?? searchPath(scan, name);
}

/**
 * The profile family a POSIX login shell maps to, or null when it is none of
 * the shells this panel can label. `/bin/sh` and `dash` deliberately map to
 * null: they are not bash, and claiming so would hide the real bash.
 */
function posixShellName(path: string): "zsh" | "bash" | "fish" | null {
  const base = path.split("/").pop() ?? "";
  if (base === "zsh") return "zsh";
  if (base === "fish") return "fish";
  if (base === "bash") return "bash";
  return null;
}

/**
 * Pure catalog builder: given the machine's probes, produce the ordered
 * profile list. Exposed separately so tests pin detection order without
 * touching the real filesystem.
 */
export function scanShellProfiles(input: ScanInput): TerminalShellProfile[] {
  const profiles: TerminalShellProfile[] = [];
  if (input.platform === "win32") {
    const pwsh = findPwsh(input);
    if (pwsh) {
      profiles.push({ id: "pwsh", label: "PowerShell 7", path: pwsh, family: "pwsh", isDefault: true });
    }
    const windowsPowerShell = findWindowsPowerShell(input);
    if (windowsPowerShell) {
      profiles.push({ id: "windows-powershell", label: "Windows PowerShell", path: windowsPowerShell, family: "powershell", ...(pwsh ? {} : { isDefault: true }) });
    }
    const cmd = findCmd(input);
    if (cmd) {
      profiles.push({ id: "cmd", label: "Command Prompt", path: cmd, family: "cmd" });
    }
    const gitBash = findGitBash(input);
    if (gitBash) {
      profiles.push({ id: "git-bash", label: "Git Bash", path: gitBash, family: "bash" });
    }
    const wsl = findWsl(input);
    if (wsl) {
      profiles.push({ id: "wsl", label: "WSL", path: wsl, family: "wsl" });
    }
    if (profiles.length === 0) {
      // No probe hit: still offer the in-box shells so the error surfaces at
      // create time with a real message instead of an empty dropdown.
      profiles.push({ id: "cmd", label: "Command Prompt", path: cmd ?? join(input.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), family: "cmd", isDefault: true });
    }
    return profiles;
  }
  // POSIX: $SHELL first, then the common login shells. Only a shell we can
  // actually name becomes a profile: mapping `/bin/sh` or `dash` onto `bash`
  // would mislabel the tab and evict the real bash from the list.
  const login = input.env.SHELL;
  const seenFamilies = new Set<string>();
  const pushPosix = (name: "zsh" | "bash" | "fish", path: string) => {
    if (seenFamilies.has(name)) return;
    seenFamilies.add(name);
    profiles.push({
      id: name,
      label: name === "zsh" ? "Zsh" : name === "bash" ? "Bash" : "Fish",
      path,
      family: name,
      ...(profiles.length === 0 ? { isDefault: true } : {}),
    });
  };
  const loginName = login ? posixShellName(login) : null;
  if (login && loginName && input.fileExists(login)) {
    pushPosix(loginName, login);
  }
  for (const name of ["zsh", "bash", "fish"] as const) {
    const path = findPosixShell(input, name);
    if (path) pushPosix(name, path);
  }
  if (profiles.length === 0) {
    const fallback = POSIX_FALLBACKS.find((candidate) => input.fileExists(candidate));
    if (fallback) {
      profiles.push({ id: "bash", label: "Bash", path: fallback, family: "bash", isDefault: true });
    }
  }
  return profiles;
}

/**
 * Cached registry. `listShells(true)` forces a rescan so a shell installed
 * while the app runs appears the next time the dropdown opens.
 */
export class ShellRegistry {
  private cache: TerminalShellProfile[] | null = null;
  private cachedAt = 0;
  private readonly options: ShellRegistryOptions;

  constructor(options: ShellRegistryOptions = {}) {
    this.options = options;
  }

  listShells(refresh = false): TerminalShellProfile[] {
    const cacheMs = this.options.cacheMs ?? DEFAULT_CACHE_MS;
    const now = Date.now();
    if (!refresh && this.cache && now - this.cachedAt < cacheMs) {
      return this.cache;
    }
    const scan: ScanInput = {
      platform: this.options.platform ?? process.platform,
      env: this.options.env ?? process.env,
      fileExists: this.options.fileExists ?? ((path) => {
        try {
          return existsSync(path);
        } catch {
          return false;
        }
      }),
    };
    this.cache = scanShellProfiles(scan);
    this.cachedAt = now;
    return this.cache;
  }

  find(shellId: string, refresh = false): TerminalShellProfile | undefined {
    return this.listShells(refresh).find((profile) => profile.id === shellId);
  }
}
