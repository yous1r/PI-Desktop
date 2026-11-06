import assert from "node:assert/strict";
import { register } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createWorkspaceExecutionResolver } = await import("../electron/main/workspace-execution-context.ts");

function fixture() {
  let selected = "remote-project:a";
  let remote = { hostKey: "host-a", path: "/project/repo" };
  let connection = { connected: true, generation: 1, platform: "linux" };
  let sessionPath = selected;
  let sessionExists = true;
  let projectExists = true;
  const local = resolve("local-project");
  const host = { call: async (method, input) => {
    if (method === "session.get") return { session: sessionExists ? { projectPath: sessionPath } : null };
    if (method === "project.groups.list") return { groups: [
      { id: "a", name: "Remote A", primaryPath: "remote-project:a", roots: [{path:"remote-project:a",name:"A",position:0}], remote },
      { id: "local", name: "Local", primaryPath: local, roots: [{path:local,name:"Local",position:0}] },
    ].filter(group => projectExists || group.id !== "a") };
    throw new Error(`Unexpected ${method}`);
  } };
  let active = host;
  const resolver = createWorkspaceExecutionResolver({getHost:()=>active,currentWorkspacePath:()=>selected, remoteState:async()=>connection});
  return { resolver, local, setSelected:value=>selected=value, setRemote:value=>remote=value,
    setConnection:value=>connection=value, setSession:value=>sessionPath=value,
    removeProject:()=>projectExists=false, removeSession:()=>sessionExists=false, removeHost:()=>active=null };
}

test("retained sessions keep their own remote authority when Desktop selects a local project", async () => {
  const f = fixture();
  const initial = await f.resolver({sessionId:"session-a"});
  f.setSelected(f.local);
  const retained = await f.resolver({sessionId:"session-a"});
  assert.deepEqual(retained,initial);
  assert.equal((await f.resolver()).authority.kind,"local");
});
test("reconnection and same-path Host replacement invalidate context generations", async () => {
  const f = fixture();
  const initial = await f.resolver();
  assert.equal((await f.resolver()).generation,initial.generation);
  f.setConnection({connected:true,generation:2,platform:"linux"});
  const reconnected = await f.resolver();
  assert.notEqual(reconnected.generation,initial.generation);
  f.setRemote({hostKey:"host-b",path:"/project/repo"});
  const other = await f.resolver();
  assert.notEqual(other.generation,reconnected.generation);
  assert.equal(other.authority.hostKey,"host-b");
});
test("missing session and unbound session never fall back to the selected workspace", async () => {
  const f = fixture();
  f.setSession(undefined);
  assert.equal(await f.resolver({sessionId:"session-a"}),null);
  f.removeSession();
  await assert.rejects(f.resolver({sessionId:"session-a"}),{code:"NOT_FOUND"});
});
test("disconnected or missing remote bindings fail closed", async () => {
  const f = fixture();
  f.setConnection({connected:false,generation:1,platform:"linux"});
  await assert.rejects(f.resolver(),{code:"HOST_UNAVAILABLE"});
  f.setRemote(undefined);
  await assert.rejects(f.resolver(),{code:"NOT_FOUND"});
  f.removeHost();
  await assert.rejects(f.resolver(),{code:"HOST_UNAVAILABLE"});
});
test("a caller cannot replace its durable workspace with an arbitrary path", async () => {
  const f=fixture();
  await assert.rejects(f.resolver({workspacePath:f.local}),{code:"WORKSPACE_CHANGED"});
  await assert.rejects(f.resolver({sessionId:"session-a",workspacePath:f.local}),{code:"WORKSPACE_CHANGED"});
});

test("a binding replaced while remote readiness resolves is rejected", async () => {
  let remote = {hostKey:"a",path:"/repo"};
  const host = {call:async()=>({groups:[{id:"p",primaryPath:"remote-project:p",name:"P",roots:[],remote}]})};
  const resolver=createWorkspaceExecutionResolver({getHost:()=>host,currentWorkspacePath:()=>"remote-project:p",remoteState:async()=>{
    remote={hostKey:"b",path:"/repo"};
    return {connected:true,generation:1,platform:"linux"};
  }});
  await assert.rejects(resolver(),{code:"WORKSPACE_CHANGED"});
});
test("replacing host-core invalidates otherwise identical local contexts", async () => {
  const local=resolve("local-project");
  let host={call:async()=>({groups:[]})};
  const resolver=createWorkspaceExecutionResolver({getHost:()=>host,currentWorkspacePath:()=>local,remoteState:async()=>{throw new Error("Unexpected remote lookup");}});
  const first=await resolver();
  host={call:async()=>({groups:[]})};
  const second=await resolver();
  assert.notEqual(first.generation,second.generation);
});

test("host-captured pages retain their workspace after selection changes and reject project removal", async () => {
  const f=fixture(); const context=await f.resolver();
  f.setSelected(f.local);
  assert.deepEqual(await f.resolver({context}),context);
  f.removeProject();
  await assert.rejects(f.resolver({context}),{code:"WORKSPACE_CHANGED"});
});
test("captured pages reject rebindings and terminal reattachment only relaxes the connection generation", async () => {
  const f=fixture(); const context=await f.resolver();
  f.setConnection({connected:true,generation:2,platform:"linux"});
  await assert.rejects(f.resolver({context}),{code:"WORKSPACE_CHANGED"});
  assert.notEqual((await f.resolver({context,allowReconnect:true})).generation,context.generation);
  f.setRemote({hostKey:"another-host",path:"/project/repo"});
  await assert.rejects(f.resolver({context,allowReconnect:true}),{code:"WORKSPACE_CHANGED"});
});

test("Windows native workspace paths retain their durable project and selected root", { skip: process.platform !== "win32" }, async () => {
  const native = String.raw`D:\Packages\PI-Desktop`;
  const stored = "D:/Packages/PI-Desktop";
  let selected = native;
  let groups = [{ id: "project", name: "Project", primaryPath: stored, roots: [
    { path: stored, name: "Primary", position: 0 },
    { path: "D:/Packages/member", name: "Member", position: 1 },
  ] }];
  const host = { call: async method => method === "session.get"
    ? { session: { projectPath: stored } } : { groups } };
  const resolver = createWorkspaceExecutionResolver({
    getHost: () => host, currentWorkspacePath: () => selected,
    remoteState: async () => { throw Error("Unexpected remote lookup"); },
  });
  const context = await resolver({ workspacePath: stored });
  assert.equal(context.projectId, "project");
  assert.equal(context.roots.find(root => root.primary).path, stored);
  assert.deepEqual(await resolver({ sessionId: "s", workspacePath: native }), context);
  selected = String.raw`D:\Other`;
  assert.deepEqual(await resolver({ context }), context);
  selected = String.raw`D:\Packages\member`;
  const member = await resolver();
  assert.equal(member.projectId, "project");
  assert.equal(member.roots[0].path, "D:/Packages/member");
  assert.equal(member.roots[0].primary, true);
  groups = [];
  await assert.rejects(resolver({ context }), { code: "WORKSPACE_CHANGED" });
});
