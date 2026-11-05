import { describe, expect, it } from "vitest";
import { pluginWorkspaceEntry, validateManifest } from "./index.js";

const base = { schemaVersion: 1, id: "test.workspace", name: "Workspace", version: "1.0.0", main: "main.js" };

describe("plugin backend placement", () => {
  it("keeps an old manifest desktop-only", () => {
    const result = validateManifest(base);
    expect(result.ok).toBe(true);
    expect(pluginWorkspaceEntry(result.manifest!)).toBeNull();
  });
  it("uses the existing main entry for a workspace backend", () => {
    const result = validateManifest({ ...base, execution: { main: "workspace" } });
    expect(result.ok).toBe(true);
    expect(pluginWorkspaceEntry(result.manifest!)).toBe("main.js");
  });
  it("keeps desktop main and selects the declared companion", () => {
    const result = validateManifest({ ...base, execution: { main: "desktop", workspaceMain: "workspace/main.cjs" } });
    expect(result.ok).toBe(true);
    expect(pluginWorkspaceEntry(result.manifest!)).toBe("workspace/main.cjs");
    expect(result.manifest!.main).toBe("main.js");
  });
  it.each([null, [], "remote", {}, { main: "remote" }, { main: "workspace", location: "ssh" }, { main: "workspace", workspaceMain: "other.js" }])("rejects ambiguous declarations %j", execution => {
    expect(validateManifest({ ...base, execution }).ok).toBe(false);
  });
  it.each(["../main.js", "/main.js", "C:/main.js", "C:main.js", "\\\\host\\main.js", "nested/../../main.js", "", "main.js\u0000", " main.js", "main.ts", "nested//main.js"])("rejects an unsafe companion entry %j", workspaceMain => {
    expect(validateManifest({ ...base, execution: { main: "desktop", workspaceMain } }).ok).toBe(false);
  });
});


it("requires a workspace entry for explicitly placed MCP servers", () => {
  const manifest = {schemaVersion:1,id:"test.mcp",name:"MCP",version:"1.0.0",main:"main.js",permissions:["mcp.server.local"],contributes:{mcpServers:[{id:"server",transport:"stdio",command:"node",execution:"workspace"}]}};
  expect(validateManifest(manifest).ok).toBe(false);
  expect(validateManifest({...manifest,execution:{main:"desktop",workspaceMain:"worker.js"}}).ok).toBe(true);
  expect(validateManifest({...manifest,execution:{main:"workspace"}}).ok).toBe(true);
});

it.each(["provider.register","provider.oauth","speech.provider","renderer.extension","composer.transform","audio.capture.background","audio.playback.background"])("keeps %s on a Desktop main", permission=>{
  const manifest={...base,permissions:[permission],execution:{main:"workspace"}};
  expect(validateManifest(manifest).ok).toBe(false);
  expect(validateManifest({...manifest,execution:{main:"desktop",workspaceMain:"worker.js"}}).ok).toBe(true);
});
