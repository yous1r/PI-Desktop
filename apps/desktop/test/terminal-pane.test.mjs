import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeTerminalChunk,
  terminalFailureState,
  terminalHostIdentity,
  terminalPalette,
} from "../src/lib/terminal-pane.ts";

/**
 * What the user is told about a terminal must distinguish three different
 * situations: the host is offline (reconnect, then restart), no shell exists on
 * that host (nothing to reconnect), and the shell exited (start a new one).
 * These helpers own that mapping, so the component only renders it.
 */

test("an offline host is its own state, not a generic failure", () => {
  const offline = terminalFailureState(
    Object.assign(new Error("host is not connected"), { errorCode: "TERMINAL_HOST_OFFLINE" }),
  );
  assert.equal(offline.status, "offline");
  assert.equal(offline.code, "TERMINAL_HOST_OFFLINE");
  assert.equal(offline.detail, "host is not connected");
});

test("an offline code nested in the RPC error data still reads as offline", () => {
  const offline = terminalFailureState({
    code: "RPC_ERROR",
    message: "unreachable",
    data: { errorCode: "TERMINAL_HOST_OFFLINE" },
  });
  assert.equal(offline.status, "offline");
});

test("a missing shell is a failure that is not blamed on connectivity", () => {
  const failed = terminalFailureState(
    Object.assign(new Error("no shell"), { errorCode: "TERMINAL_SHELL_UNAVAILABLE" }),
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.code, "TERMINAL_SHELL_UNAVAILABLE");
});

test("an unrelated error stays a plain failure without inventing a code", () => {
  const failed = terminalFailureState(new Error("boom"));
  assert.deepEqual(failed, { status: "failed", detail: "boom" });
  assert.equal(terminalFailureState(undefined).status, "failed");
  assert.equal(terminalFailureState(undefined).detail, undefined);
});

test("base64 output decodes to the bytes xterm writes", () => {
  const bytes = decodeTerminalChunk("aGVsbG8=");
  assert.equal(new TextDecoder().decode(bytes), "hello");
  // ANSI escapes survive the round trip untouched.
  const ansi = decodeTerminalChunk(Buffer.from("\u001b[31mred\u001b[0m").toString("base64"));
  assert.equal(new TextDecoder().decode(ansi), "\u001b[31mred\u001b[0m");
});

test("a malformed chunk is dropped instead of throwing", () => {
  assert.equal(decodeTerminalChunk("not base64!!").length, 0);
  assert.equal(decodeTerminalChunk("").length, 0);
});

test("a local terminal names this machine, a remote one names its host", () => {
  const local = terminalHostIdentity({ localLabel: "Local", workspacePath: "/work/app" });
  assert.deepEqual(local, { label: "Local", detail: "/work/app", remote: false });

  const remote = terminalHostIdentity({
    hostLabel: "Build box",
    hostKey: "host-a",
    workspacePath: "/srv/app",
    localLabel: "Local",
  });
  assert.deepEqual(remote, { label: "Build box", detail: "/srv/app", remote: true });

  // A paired host with no label still names the routing key rather than lying.
  const keyOnly = terminalHostIdentity({ hostKey: "host-a", localLabel: "Local" });
  assert.deepEqual(keyOnly, { label: "host-a", remote: true });
});

test("the palette follows theme surface tokens and keeps ANSI colors fixed", () => {
  const palette = terminalPalette((name, fallback) =>
    name === "--ds-bg-elevated-opaque"
      ? "#101010"
      : name === "--ds-text-primary"
        ? "#eeeeee"
        : fallback,
  );
  assert.equal(palette.background, "#101010");
  assert.equal(palette.foreground, "#eeeeee");
  assert.equal(palette.cursor, "#eeeeee");
  assert.equal(palette.cursorAccent, "#101010");
  // Shell colors must not drift with the app theme.
  assert.equal(palette.red, "#e5534b");
  assert.equal(palette.green, "#3fb950");

  // A host without a computed style falls back to a readable dark surface.
  const fallback = terminalPalette((_name, value) => value);
  assert.equal(fallback.background, "#1b1c1f");
  assert.equal(fallback.foreground, "#e6e6e6");
});
