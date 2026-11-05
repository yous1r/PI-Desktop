import { describe, expect, it } from "vitest";
import {
  TERMINAL_ERROR_CODES,
  isTerminalBufferResult,
  isTerminalDataEvent,
  isTerminalErrorCode,
  isTerminalExitEvent,
  isTerminalOpenResult,
  isTerminalReplayResult,
  isTerminalShellFamily,
  isTerminalShellProfile,
  isTerminalTargetContext,
  createTerminalPendingBuffer,
  parseTerminalWorkspaceId,
  TERMINAL_PENDING_LIMIT_BYTES,
  terminalBufferChunk,
  terminalChunksAfterSnapshot,
  terminalErrorCodeOf,
  terminalWorkspaceId,
} from "./types/terminal.js";

/**
 * The work-panel terminal crosses the preload boundary in both directions, so
 * these payload guards and the target encoding are a contract: a payload that
 * slips through renders as a blank pane rather than as a stated failure.
 */
describe("work-panel terminal contract", () => {
  it("recognizes the shell families a registry can report", () => {
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
    // A host that reports only display data must still be usable: a remote
    // catalog may not expose an executable path at all.
    const { path: _path, ...labelOnly } = profile;
    expect(isTerminalShellProfile(labelOnly)).toBe(true);
    // A renderer must never be able to smuggle a non-string argv entry through.
    expect(isTerminalShellProfile({ ...profile, args: ["ok", 7] })).toBe(false);
    expect(isTerminalShellProfile({ ...profile, family: "nushell" })).toBe(false);
    expect(isTerminalShellProfile({ ...profile, path: 3 })).toBe(false);
    expect(isTerminalShellProfile(null)).toBe(false);
    expect(isTerminalShellProfile([])).toBe(false);
  });

  it("requires a tab id in a target context but not a session", () => {
    expect(isTerminalTargetContext({ tabId: "terminal:1" })).toBe(true);
    expect(
      isTerminalTargetContext({ sessionId: "remote:host:a", workspaceId: "ssh:host:/srv", tabId: "terminal:1" }),
    ).toBe(true);
    expect(isTerminalTargetContext({ tabId: "" })).toBe(false);
    expect(isTerminalTargetContext({ sessionId: "s" })).toBe(false);
    expect(isTerminalTargetContext({ tabId: "t", sessionId: 7 })).toBe(false);
  });

  it("round-trips a local and a remote workspace identity", () => {
    expect(terminalWorkspaceId({ path: "/home/me/project" })).toBe("local:/home/me/project");
    expect(terminalWorkspaceId({ hostKey: "host-a", path: "/srv/app" })).toBe("ssh:host-a:/srv/app");
    // No workspace at all means the host's own default directory.
    expect(terminalWorkspaceId({})).toBeUndefined();
    expect(terminalWorkspaceId(null)).toBeUndefined();

    expect(parseTerminalWorkspaceId("local:/home/me/project")).toEqual({ path: "/home/me/project" });
    expect(parseTerminalWorkspaceId("ssh:host-a:/srv/app")).toEqual({ hostKey: "host-a", path: "/srv/app" });
    // A Windows drive letter is a colon inside the path, not a host separator.
    expect(parseTerminalWorkspaceId("local:C:\\work\\app")).toEqual({ path: "C:\\work\\app" });
    expect(parseTerminalWorkspaceId("ssh:host-a:D:\\work\\app")).toEqual({ hostKey: "host-a", path: "D:\\work\\app" });
    expect(parseTerminalWorkspaceId("ssh:host-a")).toBeNull();
    expect(parseTerminalWorkspaceId("elsewhere:/srv")).toBeNull();
  });

  it("guards the create result, the event payloads and the replay result", () => {
    expect(isTerminalOpenResult({ terminalId: "term_1", shellId: "cmd", cols: 80, rows: 24 })).toBe(true);
    expect(isTerminalOpenResult({ terminalId: "", shellId: "cmd", cols: 80, rows: 24 })).toBe(false);
    expect(isTerminalOpenResult({ terminalId: "term_1", shellId: "cmd", cols: 80 })).toBe(false);

    expect(isTerminalDataEvent({ terminalId: "term_1", data: "aGk=" })).toBe(true);
    expect(isTerminalDataEvent({ terminalId: "term_1" })).toBe(false);

    expect(isTerminalExitEvent({ terminalId: "term_1", exitCode: 0 })).toBe(true);
    // A killed shell reports null, which the renderer treats as "unknown exit".
    expect(isTerminalExitEvent({ terminalId: "term_1", exitCode: null })).toBe(true);
    expect(isTerminalExitEvent({ terminalId: "term_1", exitCode: "0" })).toBe(false);

    // null means the process is gone and the tab must start a new shell.
    expect(isTerminalReplayResult({ data: null })).toBe(true);
    expect(isTerminalReplayResult({ data: "aGk=" })).toBe(true);
    expect(isTerminalReplayResult({})).toBe(false);

    expect(isTerminalBufferResult({ text: "hello" })).toBe(true);
    expect(isTerminalBufferResult({ text: "hello", truncated: true })).toBe(true);
    expect(isTerminalBufferResult({ text: 1 })).toBe(false);
  });

  it("carries an optional chunk sequence on events and on a replay snapshot", () => {
    expect(isTerminalDataEvent({ terminalId: "term_1", data: "aGk=" })).toBe(true);
    expect(isTerminalDataEvent({ terminalId: "term_1", data: "aGk=", sequence: 7 })).toBe(true);
    // A non-numeric sequence is a broken payload, not a legacy one.
    expect(isTerminalDataEvent({ terminalId: "term_1", data: "aGk=", sequence: "7" })).toBe(false);

    expect(isTerminalReplayResult({ data: "aGk=" })).toBe(true);
    expect(isTerminalReplayResult({ data: "aGk=", sequence: 3 })).toBe(true);
    expect(isTerminalReplayResult({ data: null, sequence: 0 })).toBe(true);
    expect(isTerminalReplayResult({ data: "aGk=", sequence: "3" })).toBe(false);
  });

  it("paints only the buffered chunks the snapshot does not already contain", () => {
    const chunks = [
      { terminalId: "t", data: "a", sequence: 1 },
      { terminalId: "t", data: "b", sequence: 2 },
      { terminalId: "t", data: "c", sequence: 3 },
    ];
    // Snapshot ends at 2: chunk 3 arrived after it and still has to be painted.
    expect(terminalChunksAfterSnapshot(chunks, 2)).toEqual({
      write: [chunks[2]],
      alreadyIncluded: 2,
    });
    expect(terminalChunksAfterSnapshot(chunks, 3).write).toEqual([]);
    expect(terminalChunksAfterSnapshot(chunks, 0).write).toEqual(chunks);
  });

  it("treats an older host without sequence numbers as snapshot-authoritative", () => {
    // Unknowable ordering must never paint a chunk twice, so the snapshot wins…
    expect(
      terminalChunksAfterSnapshot([{ terminalId: "t", data: "a" }], 4),
    ).toEqual({ write: [], alreadyIncluded: 1 });
    // …and a host that numbers events but not its replay is equally unknown.
    expect(
      terminalChunksAfterSnapshot([{ terminalId: "t", data: "a", sequence: 5 }], undefined).write,
    ).toEqual([]);
  });

  it("bounds the pre-attach buffer and reports overflow instead of dropping it", () => {
    const buffer = createTerminalPendingBuffer();
    terminalBufferChunk(buffer, { terminalId: "t", data: "a".repeat(TERMINAL_PENDING_LIMIT_BYTES - 1) });
    expect(buffer.overflowed).toBe(false);
    expect(buffer.bytes).toBe(TERMINAL_PENDING_LIMIT_BYTES - 1);

    terminalBufferChunk(buffer, { terminalId: "t", data: "ab" });
    expect(buffer.overflowed).toBe(true);
    expect(buffer.chunks).toEqual([]);
    expect(buffer.bytes).toBe(0);

    // A known terminal id scopes the buffer so another tab cannot fill it.
    const scoped = createTerminalPendingBuffer();
    terminalBufferChunk(scoped, { terminalId: "other", data: "x" }, "t");
    terminalBufferChunk(scoped, { terminalId: "t", data: "y" }, "t");
    expect(scoped.chunks.map((chunk) => chunk.terminalId)).toEqual(["t"]);
  });

  it("classifies a terminal failure from either error envelope", () => {
    for (const code of TERMINAL_ERROR_CODES) {
      expect(isTerminalErrorCode(code)).toBe(true);
    }
    expect(isTerminalErrorCode("INVALID_PARAMS")).toBe(false);

    expect(terminalErrorCodeOf({ code: "TERMINAL_HOST_OFFLINE" })).toBe("TERMINAL_HOST_OFFLINE");
    expect(terminalErrorCodeOf({ errorCode: "TERMINAL_GONE" })).toBe("TERMINAL_GONE");
    expect(terminalErrorCodeOf({ code: "RPC_ERROR", details: { errorCode: "TERMINAL_HOST_OFFLINE" } })).toBe(
      "TERMINAL_HOST_OFFLINE",
    );
    expect(terminalErrorCodeOf({ code: "RPC_ERROR", data: { errorCode: "TERMINAL_SHELL_UNAVAILABLE" } })).toBe(
      "TERMINAL_SHELL_UNAVAILABLE",
    );
    // An unrelated failure must stay a plain error, not become a terminal code.
    expect(terminalErrorCodeOf({ code: "INTERNAL_ERROR" })).toBeUndefined();
    expect(terminalErrorCodeOf(new Error("boom"))).toBeUndefined();
    expect(terminalErrorCodeOf(undefined)).toBeUndefined();
  });
});
