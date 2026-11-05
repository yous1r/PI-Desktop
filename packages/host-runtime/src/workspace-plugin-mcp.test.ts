import { describe, expect, it } from "vitest";
import type { PluginManifest } from "@pi-desktop/plugin-sdk";
import { WorkspacePluginMcp, workspaceMcpServer } from "./workspace-plugin-mcp.js";

const context = {workspaceId:"a",projectId:"a",authority:{kind:"local" as const},roots:[{path:process.cwd(),name:"a",primary:true}],platform:"linux" as const,connectionState:"connected" as const,generation:1};
const manifest:PluginManifest = {schemaVersion:1,id:"test.mcp",name:"MCP",version:"1.0.0",main:"main.js",execution:{main:"workspace"},permissions:["mcp.server.remote"],net:{domains:["allowed.test"]},contributes:{mcpServers:[{id:"api",transport:"http",url:"https://allowed.test/mcp",headers:{Authorization:{setting:"token"}}}]}};

describe("workspace MCP admission",()=>{
 it("uses declared placement and intersects permissions before opening a transport",async()=>{
  expect(workspaceMcpServer(manifest,{})).toBe(true);
  expect(workspaceMcpServer(manifest,{execution:"desktop"})).toBe(false);
  expect(workspaceMcpServer({execution:{main:"desktop",workspaceMain:"worker.js"}},{execution:"workspace"})).toBe(true);
  let calls=0;
  const service=new WorkspacePluginMcp({manifest,permissions:[],context,packagePath:process.cwd(),clientOptions:{fetchImpl:async()=>{calls++;throw Error("unexpected");}}});
  try {
   await expect(service.call("mcp.connect",["api",{token:"own"}])).rejects.toMatchObject({code:"PERMISSION_DENIED"});
   await expect(service.call("mcp.connect",["other",{}])).rejects.toMatchObject({code:"PLUGIN_INVALID"});
   expect(calls).toBe(0);
  } finally {service.dispose();}
 });
 it("checks redirect egress on the execution Host and closes admissions on dispose",async()=>{
  const urls:string[]=[];
  const service=new WorkspacePluginMcp({manifest,permissions:manifest.permissions!,context,packagePath:process.cwd(),clientOptions:{fetchImpl:async(url,init)=>{
   urls.push(String(url));expect(new Headers(init?.headers).get("Authorization")).toBe("own-token");
   return new Response(null,{status:307,headers:{location:"https://denied.test/mcp"}});
  }}});
  await expect(service.call("mcp.connect",["api",{token:"own-token"}])).rejects.toMatchObject({code:"PERMISSION_DENIED"});
  expect(urls).toEqual(["https://allowed.test/mcp"]);
  service.dispose();
  await expect(service.call("mcp.connect",["api",{token:"own-token"}])).rejects.toMatchObject({code:"PLUGIN_GONE"});
 });
});
