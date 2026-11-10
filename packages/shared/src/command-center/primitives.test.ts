import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMMAND_CENTER_MAX_AGENTS_PER_HOST, COMMAND_CENTER_MAX_AGENTS_PER_WORKSPACE,
  COMMAND_CENTER_MAX_ENABLED_WORKSPACES, COMMAND_CENTER_MAX_RECEIPT_BYTES,
  COMMAND_CENTER_MAX_REQUEST_BYTES, COMMAND_CENTER_MAX_SUMMARY_PAGE_BYTES, COMMAND_CENTER_MAX_SUMMARY_PAGE_ROWS,
  COMMAND_CENTER_VERSION, commandCenterCanonicalJson, commandCenterUtf8Bytes, commandCenterWithinBytes,
} from "./primitives.js";
import { COMMAND_CENTER_QUOTA } from "./identity.js";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/command-center-control.json", import.meta.url), "utf8"));

describe("command-center payload primitives", () => {
  it("keeps the approved first-release limits and page bounds", () => {
    expect(COMMAND_CENTER_VERSION).toBe(1);
    expect(COMMAND_CENTER_MAX_REQUEST_BYTES).toBe(256 * 1024);
    expect(COMMAND_CENTER_MAX_RECEIPT_BYTES).toBe(16 * 1024);
    expect(COMMAND_CENTER_MAX_SUMMARY_PAGE_ROWS).toBe(100);
    expect(COMMAND_CENTER_MAX_SUMMARY_PAGE_BYTES).toBe(256 * 1024);
    expect(COMMAND_CENTER_QUOTA).toEqual({ maxEnabledWorkspaces: 3, maxAgentsPerWorkspace: 12, maxAgentsPerHost: 36 });
    expect([COMMAND_CENTER_MAX_ENABLED_WORKSPACES, COMMAND_CENTER_MAX_AGENTS_PER_WORKSPACE, COMMAND_CENTER_MAX_AGENTS_PER_HOST])
      .toEqual([3, 12, 36]);
  });

  it("sorts object keys, preserves array order and omits absent optional fields", () => {
    const ordered = commandCenterCanonicalJson({ b: 2, a: { d: [3, 1], c: "x" } });
    const reordered = commandCenterCanonicalJson({ a: { c: "x", d: [3, 1] }, b: 2 });
    expect(ordered).toBe('{"a":{"c":"x","d":[3,1]},"b":2}');
    expect(reordered).toBe(ordered);
    expect(commandCenterCanonicalJson({ a: 1, omitted: undefined })).toBe('{"a":1}');
    // Array order is semantic and must not be normalized away.
    expect(commandCenterCanonicalJson({ a: [1, 2] })).not.toBe(commandCenterCanonicalJson({ a: [2, 1] }));
  });

  it("rejects values that cannot round-trip through JSON", () => {
    expect(() => commandCenterCanonicalJson({ n: Number.NaN })).toThrow("COMMAND_CENTER_INVALID_NUMBER");
    expect(() => commandCenterCanonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow("COMMAND_CENTER_INVALID_NUMBER");
    expect(() => commandCenterCanonicalJson({ big: 1n })).toThrow("COMMAND_CENTER_INVALID_VALUE");
    expect(() => commandCenterCanonicalJson({ fn: () => 1 })).toThrow("COMMAND_CENTER_INVALID_VALUE");
  });

  it("measures UTF-8 bytes rather than UTF-16 code units", () => {
    expect(commandCenterUtf8Bytes("abc")).toBe(3);
    expect(commandCenterUtf8Bytes("控制")).toBe(6);
    expect(commandCenterWithinBytes({ text: fixture.request.intent.objective }, COMMAND_CENTER_MAX_REQUEST_BYTES)).toBe(true);
    expect(commandCenterWithinBytes({ text: "控".repeat(COMMAND_CENTER_MAX_REQUEST_BYTES / 2) }, COMMAND_CENTER_MAX_REQUEST_BYTES)).toBe(false);
  });
});
