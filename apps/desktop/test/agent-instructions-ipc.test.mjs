import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { IPC, ErrorCodes } from "@pi-desktop/shared";

const require = createRequire(import.meta.url);
async function fixture(t) {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "pi-instructions-ipc-"));
  const globalPath = join(root, "AGENTS.md");
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = new URL("../electron/main/ipc/app-ipc.ts", import.meta.url);
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const dependencies = {
    electron: {},
    "@pi-desktop/shared": { IPC, ErrorCodes },
    "@pi-desktop/agent-runtime": { globalInstructionPath: () => globalPath },
    "../system-fonts": {},
    // Lazy so the same test can exercise the pre-fix module, which had no helper.
    get "../instruction-files"() { return require("../electron/main/instruction-files.ts"); },
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((name) => {
    if (name.startsWith("node:")) return require(name);
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected IPC dependency: ${name}`);
    return dependencies[name];
  }, module.exports, module);
  const handlers = new Map();
  module.exports.registerAppIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler), handleWithEvent: () => {} },
    getHost: () => ({ call: async (method) => {
      assert.equal(method, "projects.list");
      return { projects: [{ path: projectPath }] };
    } }),
    getPluginLauncherWindow: () => null,
    togglePluginLauncher: async () => {},
    safeOpenExternal: async () => {}, updater: {},
  });
  return { root, globalPath, projectPath, invoke: (channel, input) => handlers.get(channel)(input) };
}
const expected = (file) => ({ content: file.content, exists: file.exists });

test("global get and save remain compatible while snapshot-checked saves reject plugin updates", async (t) => {
  const { globalPath, invoke } = await fixture(t);
  const absent = (await invoke(IPC.invoke.agentInstructionsGet)).global;
  assert.equal(absent.exists, false);
  const saved = (await invoke(IPC.invoke.agentInstructionsSave, { scope: "global", content: "My rules", expected: expected(absent) })).file;
  assert.equal(saved.content, "My rules");
  assert.equal(saved.exists, true);
  const pluginUpdate = "My rules\n<!-- plugin:managed -->\nNew routing\n";
  await writeFile(globalPath, pluginUpdate);
  await assert.rejects(invoke(IPC.invoke.agentInstructionsSave, {
    scope: "global", content: "My unsaved draft", expected: expected(saved),
  }), (error) => error.errorCode === ErrorCodes.CONFLICT);
  assert.equal(await readFile(globalPath, "utf8"), pluginUpdate);
  const updated = (await invoke(IPC.invoke.agentInstructionsGet)).global;
  await invoke(IPC.invoke.agentInstructionsSave, { scope: "global", content: pluginUpdate + "Another rule", expected: expected(updated) });
  assert.equal(await readFile(globalPath, "utf8"), pluginUpdate + "Another rule");
  await invoke(IPC.invoke.agentInstructionsSave, { scope: "global", content: "Legacy explicit save" });
  assert.equal(await readFile(globalPath, "utf8"), "Legacy explicit save");
});

test("a file that appears after the editor read must not be erased by an empty-file snapshot", async (t) => {
  const { globalPath, invoke } = await fixture(t);
  const absent = (await invoke(IPC.invoke.agentInstructionsGet)).global;
  await writeFile(globalPath, "Installed plugin defaults");
  await assert.rejects(invoke(IPC.invoke.agentInstructionsSave, {
    scope: "global", content: "Old empty draft", expected: expected(absent),
  }), (error) => error.errorCode === ErrorCodes.CONFLICT);
  assert.equal(await readFile(globalPath, "utf8"), "Installed plugin defaults");
});

test("malformed save payloads never clear a valid global document", async (t) => {
  const { globalPath, invoke } = await fixture(t);
  await writeFile(globalPath, "Keep this");
  for (const input of [null, {}, { scope: "global", content: 42 }, { scope: "global", content: "invalid\0text" }, { scope: "global", content: "new", expected: null }, { scope: "global", content: "new", expected: { content: "Keep this", exists: "yes" } }]) {
    await assert.rejects(async () => invoke(IPC.invoke.agentInstructionsSave, input));
    assert.equal(await readFile(globalPath, "utf8"), "Keep this");
  }
});

test("nonregular or unreadable instructions report a failure rather than a fake blank file", async (t) => {
  const { globalPath, invoke } = await fixture(t);
  await mkdir(globalPath);
  await assert.rejects(invoke(IPC.invoke.agentInstructionsGet));
  await assert.rejects(invoke(IPC.invoke.agentInstructionsSave, { scope: "global", content: "must not write" }));
});

test("linked instruction documents are refused without changing the original", async (t) => {
  const { root, globalPath, invoke } = await fixture(t);
  const original = join(root, "original.md");
  await writeFile(original, "Protected original");
  await link(original, globalPath);
  await assert.rejects(invoke(IPC.invoke.agentInstructionsSave, { scope: "global", content: "must not write" }));
  assert.equal(await readFile(original, "utf8"), "Protected original");
  await rm(globalPath);
  await symlink(original, globalPath, "file");
  await assert.rejects(invoke(IPC.invoke.agentInstructionsSave, { scope: "global", content: "must not write" }));
  assert.equal(await readFile(original, "utf8"), "Protected original");
});

test("project instructions still require a registered existing project", async (t) => {
  const { root, projectPath, invoke } = await fixture(t);
  const before = (await invoke(IPC.invoke.agentInstructionsGet, { projectPath })).project;
  const result = await invoke(IPC.invoke.agentInstructionsSave, {
    scope: "project", projectPath, content: "Project rules", expected: expected(before),
  });
  assert.equal(result.file.path, join(projectPath, "AGENTS.md"));
  assert.equal(await readFile(result.file.path, "utf8"), "Project rules");
  await assert.rejects(invoke(IPC.invoke.agentInstructionsSave, {
    scope: "project", projectPath: root, content: "Not authorized",
  }), (error) => error.errorCode === ErrorCodes.NOT_FOUND);
});
