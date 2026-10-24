import assert from "node:assert/strict";
import test from "node:test";

const { buildTerminalFontOptions, isMonospaceFamily, readableFamily, terminalFontStack } =
  await import("../src/lib/terminal-fonts.ts");

/**
 * The terminal font picker is the fix for a terminal drawn in the browser's
 * default proportional face: it must offer only monospaced families, and it
 * must persist a concrete CSS stack rather than a bare family name.
 */

test("recognizes monospaced families by allow-list and by name hint", () => {
  assert.equal(isMonospaceFamily("Consolas"), true);
  assert.equal(isMonospaceFamily("JetBrains Mono"), true);
  assert.equal(isMonospaceFamily("Cascadia Code"), true);
  assert.equal(isMonospaceFamily("Fira Code"), true);
  assert.equal(isMonospaceFamily("SomeProportional"), false);
  assert.equal(isMonospaceFamily("Segoe UI"), false);
  assert.equal(isMonospaceFamily(""), false);
});

test("persists a quoted family followed by the built-in monospace fallbacks", () => {
  const stack = terminalFontStack("JetBrains Mono");
  assert.ok(stack.startsWith("'JetBrains Mono'"));
  // The built-in stack keeps columns intact when the chosen face lacks glyphs.
  assert.match(stack, /monospace$/);
  assert.equal(terminalFontStack(""), "");
});

test("offers the default plus only installed monospaced families", () => {
  const options = buildTerminalFontOptions(
    ["Segoe UI", "Consolas", "Inter", "Cascadia Code"],
    undefined,
  );
  assert.equal(options[0].id, "");
  assert.deepEqual(
    options.slice(1).map((option) => option.id),
    ["Consolas", "Cascadia Code"],
  );
});

test("keeps a stored family that the machine no longer reports", () => {
  const stack = terminalFontStack("Vanished Mono");
  const options = buildTerminalFontOptions(["Consolas"], stack);
  // Otherwise the trigger would show a value that is not in its own list and
  // the next write would silently reset it.
  assert.ok(options.some((option) => option.id === "Vanished Mono"));
  assert.equal(readableFamily(stack), "Vanished Mono");
});

test("does not duplicate the built-in default as a selectable family", () => {
  const options = buildTerminalFontOptions([], terminalFontStack("Consolas"));
  const ids = options.map((option) => option.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids, ["", "Consolas"]);
});
