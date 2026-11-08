import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/current-source-import-hooks.mjs", import.meta.url));
const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");
const { DesktopHandoffAdmission } = await import("../electron/main/runtime/handoff-admission.ts");

function fixture(t, pauseAt) {
  const entered = Promise.withResolvers();const pending = Promise.withResolvers();
  const calls = [];const resources = [];const admission = new DesktopHandoffAdmission();
  const pause = async key => { if (key === pauseAt) { entered.resolve();await pending.promise; } };
  const provider = { id: "fixture", name: "Fixture", authKind: "none", enabled: true, defaultModelId: "model", models: [] };
  const shell = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
  const host = { generation: "original", isAvailable: () => true, async call(method) {
    calls.push(method);await pause(method);
    switch (method) {
      case "commandShells.list": return { configuredId: "bash", effective: shell, fallback: false, choices: [shell] };
      case "providers.list": return { providers: [provider] };
      case "providers.getSecret": return {};
      case "skills.active": return { skills: [] };
      case "mcp.active": return { servers: [] };
      case "agents.active": return { subagents: [] };
      case "skills.disabledBuiltins": case "agents.disabledBuiltins": return { disabled: [] };
      default: throw new Error(`unexpected call ${method}`);
    }
  } };
  const runtimeState = { host, sidecar: { setVendorAuthBindings() { resources.push("vendor"); } }, handoffAdmission: admission, agentHostBridge: null };
  const runtime = createSessionLaunchRuntime({
    runtimeState, logger: { app() {} }, userMcp: { setRecords() { resources.push("mcp-records"); }, async toolsForProject() { resources.push("mcp-tools");return []; } },
    plugins: { listLoaded: () => [], getSkills: () => [], getToolsForSession: async () => [], getAgentExtensions: () => [] },
    sessionProjects: new Map(), dataDir: process.env.PI_SCRATCH_DIR, vendorOAuth: {},
    modelsDevCatalog: { configureAccount() {}, ensureLoaded: () => pause("catalog"), findModel: () => undefined },
    getWorkspacePath: () => null, pluginActiveInProject: () => true, bindingForModel: () => undefined,
    effectiveSubagentModelConfig: () => ({}), normalizeThinkingLevel: () => "off",
  });
  t.after(() => { pending.resolve();admission.dispose(); });
  return { runtimeState, admission, entered, pending, calls, resources,
    launch: () => runtime.resolveAgentRuntimeLaunch("session", { providerId: "fixture", modelId: "model" }, {}),
  };
}

for (const boundary of ["catalog", "providers.list", "mcp.active"]) {
for (const change of ["host", "closed"]) {
  test(`session launch stops after ${change} changes during ${boundary}`, async t => {
    const f = fixture(t, boundary);const replacementCalls = [];
    const result = f.launch();const rejected = assert.rejects(result);
    await f.entered.promise;
    if (change === "host") f.runtimeState.host = { isAvailable: () => true, async call(method) { replacementCalls.push(method);return {}; } };
    else f.admission.dispose();
    f.pending.resolve();await rejected;
    assert.deepEqual(replacementCalls, []);
    assert.deepEqual(f.resources, []);
  });
}
}
