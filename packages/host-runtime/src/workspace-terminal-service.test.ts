import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceTerminalService, workspaceShellEnvironment, type WorkspacePty } from "./workspace-terminal-service.js";

function fixture() {
  const writes: string[] = []; const events: unknown[] = [];
  let onData = (_data: string) => {}; let onExit = (_event: {exitCode:number}) => {};
  let killed = 0; let launched: {cwd:string;env:NodeJS.ProcessEnv} | undefined;
  const pty: WorkspacePty = { pid: 123, write: data=>{writes.push(data);}, resize:()=>{}, kill:()=>{killed++;},
    onData: handler=>{onData=handler;return {dispose(){}};}, onExit:handler=>{onExit=handler;return {dispose(){}};} };
  const service=new WorkspaceTerminalService({pty:{spawn:(_file,_args,options)=>{launched=options;return pty;}},shells:()=>[{id:"test",label:"Test",family:"custom",path:process.execPath}],env:{PATH:"test",HOME:"home",PROVIDER_API_KEY:"secret",PI_DESKTOP_PROXY_JSON:"secret"}});
  return {service,writes,events,data:(text:string)=>onData(text),exit:()=>onExit({exitCode:0}),killed:()=>killed,launched:()=>launched,sink:async(event:unknown)=>{events.push(event);}};
}

describe("workspace terminal ownership",()=>{
  it("creates in the workspace, detaches, reattaches without replaying input, and closes",async()=>{
    const root=await mkdtemp(join(tmpdir(),"workspace-term-"));const f=fixture();
    const binding={workspaceId:"a",path:root};const owner={deviceId:"desktop-a",connectionId:"first"};
    try {
      const result=await f.service.handle({action:"create",...binding,tabId:"tab",shellId:"test",cols:80,rows:24},owner,f.sink) as {terminalId:string};
      expect(f.launched()?.cwd).toBe(await realpath(root));
      expect(f.launched()?.env.PROVIDER_API_KEY).toBeUndefined();
      await f.service.handle({action:"write",...binding,terminalId:result.terminalId,data:"ls\r"},owner,f.sink);
      f.data("one\n");await new Promise(resolve=>setImmediate(resolve));
      f.service.disconnect(owner.connectionId);f.data("two\n");
      const next={...owner,connectionId:"second"};
      await expect(f.service.handle({action:"write",...binding,terminalId:result.terminalId,data:"bad"},next,f.sink)).rejects.toMatchObject({code:"TERMINAL_HOST_OFFLINE"});
      const replay=await f.service.handle({action:"replay",...binding,terminalId:result.terminalId},next,f.sink) as {data:string};
      expect(Buffer.from(replay.data,"base64").toString()).toBe("one\ntwo\n");
      expect(f.writes).toEqual(["ls\r"]);
      await expect(f.service.handle({action:"write",...binding,terminalId:result.terminalId,data:"bad"},{...next,deviceId:"desktop-b"},f.sink)).rejects.toMatchObject({code:"FORBIDDEN"});
      await expect(f.service.handle({action:"write",...binding,workspaceId:"b",terminalId:result.terminalId,data:"bad"},next,f.sink)).rejects.toMatchObject({code:"FORBIDDEN"});
      await f.service.handle({action:"close",...binding,terminalId:result.terminalId},next,f.sink);
      expect(f.killed()).toBe(1);
      expect(await f.service.handle({action:"replay",...binding,terminalId:result.terminalId},next,f.sink)).toEqual({data:null});
    } finally {f.service.dispose();await rm(root,{recursive:true,force:true});}
  });
  it("rejects outside cwd, duplicate tabs, and unknown shells",async()=>{
    const root=await mkdtemp(join(tmpdir(),"workspace-term-"));const work=join(root,"work");await mkdir(work);const f=fixture();
    const owner={deviceId:"a",connectionId:"c"};const input={action:"create" as const,workspaceId:"p",path:work,tabId:"tab",shellId:"test",cols:80,rows:24};
    try {
      await expect(f.service.handle({...input,cwd:root},owner,f.sink)).rejects.toMatchObject({code:"REMOTE_PATH_FORBIDDEN"});
      await expect(f.service.handle({...input,shellId:"missing"},owner,f.sink)).rejects.toMatchObject({code:"TERMINAL_SHELL_UNAVAILABLE"});
      await f.service.handle(input,owner,f.sink);
      await expect(f.service.handle(input,owner,f.sink)).rejects.toMatchObject({code:"CONFLICT"});
      f.service.revoke(owner.deviceId);expect(f.killed()).toBe(1);
    } finally {f.service.dispose();await rm(root,{recursive:true,force:true});}
  });
  it("bounds output frames and replay for large Unicode output",async()=>{
    const root=await mkdtemp(join(tmpdir(),"workspace-term-"));const f=fixture();const owner={deviceId:"a",connectionId:"c"};const binding={workspaceId:"p",path:root};
    try {
      const opened=await f.service.handle({action:"create",...binding,tabId:"tab",shellId:"test",cols:80,rows:24},owner,f.sink) as {terminalId:string};
      f.data("汉".repeat(110000));await new Promise(resolve=>setImmediate(resolve));
      const output=f.events as {data:string}[];
      expect(output.every(event=>Buffer.from(event.data,"base64").length<=32768)).toBe(true);
      expect(output.map(event=>Buffer.from(event.data,"base64").toString()).join("") === "汉".repeat(110000)).toBe(true);
      const replay=await f.service.handle({action:"replay",...binding,terminalId:opened.terminalId},owner,f.sink) as {data:string};
      expect(Buffer.from(replay.data,"base64").length).toBeLessThanOrEqual(262144);
    } finally {f.service.dispose();await rm(root,{recursive:true,force:true});}
  });
  it("delivers final output before exit and advances replay after overflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-term-")); const f = fixture();
    const owner = { deviceId: "a", connectionId: "c" }; const binding = { workspaceId: "p", path: root };
    try {
      const opened = await f.service.handle({ action: "create", ...binding, tabId: "tab", shellId: "test", cols: 80, rows: 24 }, owner, f.sink) as { terminalId: string };
      f.data("x".repeat(1048577));
      const replay = await f.service.handle({ action: "replay", ...binding, terminalId: opened.terminalId }, owner, f.sink) as { sequence: number };
      expect(replay.sequence).toBeGreaterThan(0);
      f.data("last line"); f.exit();
      await new Promise(resolve => setImmediate(resolve));
      expect(f.events).toEqual([
        { terminalId: opened.terminalId, data: Buffer.from("last line").toString("base64"), sequence: replay.sequence + 1 },
        { terminalId: opened.terminalId, exitCode: 0 },
      ]);
    } finally { f.service.dispose(); await rm(root, { recursive: true, force: true }); }
  });
  it("does not inherit provider or process injection secrets",()=>{
    const env=workspaceShellEnvironment({HOME:"home",PATH:"path",NODE_OPTIONS:"--require secret",AWS_SECRET_ACCESS_KEY:"secret",PI_DESKTOP_TEST:"secret"});
    expect(env).toEqual({HOME:"home",PATH:"path",TERM:"xterm-256color"});
  });
});
