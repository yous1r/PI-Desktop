import { describe, expect, it } from "vitest";
import {
  IPC,
  IPC_WHITELIST,
  isTerminalDataEvent,
  isTerminalExitEvent,
  isTerminalOpenResult,
  isTerminalShellFamily,
  isTerminalShellProfile,
} from "./index.js";

/**
 * The work-panel terminal crosses the preload boundary, so its channel names
 * and payload guards are a contract: a rename here silently breaks the panel
 * in a build that still type-checks.
 */
describe("work-panel terminal protocol", () => {
  it("exposes every terminal invoke channel through the whitelist", () => {
    const channels = [
      IPC.invoke.terminalListShells,
      IPC.invoke.terminalCreate,
      IPC.invoke.terminalWrite,
      IPC.invoke.terminalResize,
      IPC.invoke.terminalClose,
      IPC.invoke.terminalGetBuffer,
    ];
    for (const channel of channels) {
      expect(channel.startsWith("pi-desktop/terminal/")).toBe(true);
      expect(IPC_WHITELIST.has(channel)).toBe(true);
    }
    expect(new Set(channels).size).toBe(channels.length);
  });

  it("keeps terminal events distinct from the invoke channels", () => {
    expect(IPC.event.terminalData).toBe("pi-desktop/terminal/event/data");
    expect(IPC.event.terminalExit).toBe("pi-desktop/terminal/event/exit");
    expect(IPC_WHITELIST.has(IPC.event.terminalData)).toBe(true);
    expect(IPC_WHITELIST.has(IPC.event.terminalExit)).toBe(true);
    // Events must not also exist as invokes: the renderer subscribes, it does
    // not poll, and a duplicate channel would silently swallow a payload.
    const invokeChannels: readonly string[] = Object.values(IPC.invoke);
    expect(invokeChannels.includes(IPC.event.terminalData)).toBe(false);
    expect(invokeChannels.includes(IPC.event.terminalExit)).toBe(false);
  });

  it("recognizes the shell families the registry can report", () => {
    for (const family of ["cmd", "powershell", "pwsh", "bash", "zsh", "fish", "wsl", "custom"]) {
      expect(isTerminalShellFamily(family)).toBe(true);
    }
    expect(isTerminalShellFamily("nushell")).toBe(false);
    expect(isTerminalShellFamily(undefined)).toBe(false);
  });

  it("guards a shell profile payload", () => {
    const profile = { id: "pwsh", label: "PowerShell 7", path: "C:\\pwsh.exe", family: "pwsh" };
    expect(isTerminalShellProfile(profile)).toBe(true);
    expect(isTerminalShellProfile({ ...profile, args: ["-NoLogo"] })).toBe(true);
    // A renderer must never be able to smuggle a non-string argv entry through.
    expect(isTerminalShellProfile({ ...profile, args: ["ok", 7] })).toBe(false);
    expect(isTerminalShellProfile({ ...profile, family: "nushell" })).toBe(false);
    expect(isTerminalShellProfile({ ...profile, path: "" })).toBe(false);
    expect(isTerminalShellProfile(null)).toBe(false);
    expect(isTerminalShellProfile([])).toBe(false);
  });

  it("guards the create result and the two event payloads", () => {
    expect(
      isTerminalOpenResult({ terminalId: "term_1", shellId: "cmd", cols: 80, rows: 24 }),
    ).toBe(true);
    expect(isTerminalOpenResult({ terminalId: "", shellId: "cmd", cols: 80, rows: 24 })).toBe(false);

    expect(isTerminalDataEvent({ terminalId: "term_1", data: "aGk=" })).toBe(true);
    expect(isTerminalDataEvent({ terminalId: "term_1" })).toBe(false);

    expect(isTerminalExitEvent({ terminalId: "term_1", exitCode: 0 })).toBe(true);
    // A killed PTY reports null, which the renderer treats as "unknown exit".
    expect(isTerminalExitEvent({ terminalId: "term_1", exitCode: null })).toBe(true);
    expect(isTerminalExitEvent({ terminalId: "term_1", exitCode: "0" })).toBe(false);
  });
});
