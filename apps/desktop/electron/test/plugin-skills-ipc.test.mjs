import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IPC, IPC_WHITELIST, isActiveInProject } from "@pi-desktop/shared";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "../../test/helpers/ts-import-hooks.mjs")));
// Electron is the external boundary; no window, picker or real user profile is used.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron") {
      return { url: "data:text/javascript,export const app = {}; export const dialog = {}; export const shell = {};", shortCircuit: true };
    }
    return next(specifier, context);
  },
});
const { registerSkillsIpc } = await import("../main/ipc/skills-ipc.ts");

function fixture() {
  const handlers = new Map();
  const state = {
    enabled: new Map([["workflow", true], ["scoped", true]]),
    skills: [
      { id: "workflow/implement", pluginId: "workflow", skillId: "implement", name: "sc-implement", description: "Implement scoped changes", path: "/plugins/workflow/skills/implement.md", bytes: 100 },
      { id: "scoped/test", pluginId: "scoped", skillId: "test", name: "sc-test", description: "Run focused tests", path: "/plugins/scoped/test.md", bytes: 200 },
    ],
  };
  const manifests = [
    { id: "workflow", name: "SuperClaude Workflow" },
    { id: "scoped", name: "Project testing" },
  ];
  registerSkillsIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => null,
    optionalWorkspaceRoot: async () => "/project-a",
    plugins: {
      getSkills: () => state.skills.filter((skill) => state.enabled.get(skill.pluginId)),
      listLoaded: () => manifests.filter((manifest) => state.enabled.get(manifest.id)).map((manifest) => ({ manifest })),
    },
    pluginActiveInProject: (id, projectPath) => isActiveInProject({
      enabled: state.enabled.get(id) === true,
      scope: id === "scoped" ? { mode: "projects", projects: ["/project-a"] } : { mode: "global" },
    }, projectPath),
    disabledBuiltinSkills: async () => [],
    disabledBuiltinSubagents: async () => [],
    activeUserSubagentDocuments: async () => [],
    stripWinLongPrefix: (value) => value,
    sendToRenderer: () => {},
    searchSkillMarket: async () => { throw new Error("Unexpected network access"); },
    fetchSkillMarketDocument: async () => { throw new Error("Unexpected network access"); },
    logger: { app: () => {} },
  });
  const list = (query) => {
    const handler = handlers.get("pi-desktop/skill/plugin/list");
    assert.equal(typeof handler, "function", "Settings must expose loaded plugin skills");
    return handler(query);
  };
  return { state, list };
}

test("plugin skill metadata queries are allowed through the preload gate", () => {
  assert.equal(IPC.invoke.skillPluginList, "pi-desktop/skill/plugin/list");
  assert.equal(IPC_WHITELIST.has(IPC.invoke.skillPluginList), true);
});

test("plugin skills list returns display metadata only and honors the selected project", async () => {
  const { list } = fixture();
  assert.deepEqual(await list({ projectPath: "/project-a" }), { skills: [
    { id: "workflow/implement", pluginId: "workflow", pluginName: "SuperClaude Workflow", name: "sc-implement", description: "Implement scoped changes" },
    { id: "scoped/test", pluginId: "scoped", pluginName: "Project testing", name: "sc-test", description: "Run focused tests" },
  ] });
  assert.deepEqual((await list({ projectPath: "/project-b" })).skills.map((skill) => skill.id), ["workflow/implement"]);
  assert.deepEqual((await list({ projectPath: null })).skills.map((skill) => skill.id), ["workflow/implement"]);
  assert.equal((await list()).skills.length, 2, "an omitted project uses the current workspace");
});

test("disable, enable, reload and uninstall are reflected without copying skill documents", async () => {
  const { state, list } = fixture();
  assert.equal((await list()).skills.length, 2);
  state.enabled.set("workflow", false);
  assert.deepEqual((await list()).skills.map((skill) => skill.id), ["scoped/test"]);
  state.enabled.set("workflow", true);
  state.skills[0].description = "Updated skill";
  assert.equal((await list()).skills[0].description, "Updated skill");
  state.skills = state.skills.filter((skill) => skill.pluginId !== "workflow");
  assert.deepEqual((await list()).skills.map((skill) => skill.id), ["scoped/test"]);
});

test("plugin skill queries reject malformed project values", async () => {
  const { list } = fixture();
  for (const query of [null, [], { projectPath: 42 }]) {
    await assert.rejects(async () => list(query), /invalid plugin skill query/);
  }
});
