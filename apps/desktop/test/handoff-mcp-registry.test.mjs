import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createMcpControlHandoffOwner } = await import("../electron/main/mcp-control-lifecycle.ts");

test("MCP registry retains every original instance across replacement and repeated registration", () => {
  const registry = createMcpControlHandoffOwner();
  assert.deepEqual(registry.getHandoffActivity(), { operations: 0, resources: 0, uncontainedResources: 0 });
  const old = { operations: 1, resources: 2, uncontainedResources: 1 };
  const first = { getHandoffActivity: () => ({ ...old }) };
  registry.retain(first);
  registry.retain(first);
  registry.retain({ getHandoffActivity: () => ({ operations: 3, resources: 1, uncontainedResources: 0 }) });
  assert.deepEqual(registry.getHandoffActivity(), { operations: 4, resources: 3, uncontainedResources: 1 });
  old.operations = 0; old.resources = 0;
  assert.deepEqual(registry.getHandoffActivity(), { operations: 3, resources: 1, uncontainedResources: 1 });
});

test("MCP registry cannot hide a malformed retained producer", () => {
  const registry = createMcpControlHandoffOwner();
  registry.retain({ getHandoffActivity: () => ({ operations: 0, resources: 0 }) });
  assert.throws(() => registry.getHandoffActivity(), /HANDOFF_INVENTORY_UNAVAILABLE/);
});
