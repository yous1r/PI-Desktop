import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspacePluginService, collectPluginPackage, encodePluginMessage, pluginFrames, PluginMessageDecoder } from "@pi-desktop/host-runtime";
import type { WorkspacePluginEvent } from "@pi-desktop/shared";
import { harness, OWNER_TOKEN, VIEWER_TOKEN, flush } from "@pi-desktop/racp/test-harness";

describe("workspace plugins over RACP", () => {
  it("authorizes owners, runs a real Node child, carries reverse calls and media, and never replays writes", async () => {
    const root=await mkdtemp(join(tmpdir(),"racp-workspace-plugin-"));
    const pkgPath=join(root,"package");const workspace=join(root,"work");
    await mkdir(pkgPath);await mkdir(workspace);
    await writeFile(join(pkgPath,"manifest.json"),JSON.stringify({schemaVersion:1,id:"fixture.racp",name:"Fixture",version:"1.0.0",main:"main.cjs",execution:{main:"workspace"}}));
    await writeFile(join(pkgPath,"main.cjs"),`
      exports.onPanelInvoke=async(channel)=>{
        if(channel==='write')require('node:fs').appendFileSync('marker.txt','once');
        return {workspace:await pi.workspace.get(),locale:await pi.app.getLocale(),text:'字'.repeat(100000)};
      };
    `);
    const service=new WorkspacePluginService({dataDir:join(root,"host"),runner:fileURLToPath(new URL("../../../packages/host-runtime/plugin-host-process.mjs",import.meta.url))});
    const h=await harness({operations:{workspacePlugins:service}});
    const decoder=new PluginMessageDecoder();let next=0;let frames=0;
    const pending=new Map<string,{resolve(value:unknown):void;reject(error:Error):void}>();
    const owner=await h.connect(OWNER_TOKEN,{onServerRequest:async(method,raw)=>{
      expect(method).toBe("workspace/pluginEvent");
      const event=raw as WorkspacePluginEvent;
      if (!("frame" in event)) return {ok:true};
      frames++;const decoded=decoder.accept(event.frame);if(!decoded)return{ok:true};
      const message=decoded.message as {t:string;id:string;api:string;ok:boolean;value:unknown;error?:{code:string;message:string}};
      if(message.t==="call"){
        expect(message.api).toBe("app.getLocale");
        await send({t:"res",id:message.id,ok:true,value:"racp-locale"});
      }else if(message.t==="res"){
        const request=pending.get(message.id);pending.delete(message.id);
        if(message.ok)request?.resolve(message.value);else request?.reject(Object.assign(new Error(message.error?.message),{code:message.error?.code}));
      }
      return {ok:true};
    }});
    const viewer=await h.connect(VIEWER_TOKEN);
    const send=async(message:unknown)=>{
      for(const frame of pluginFrames(encodePluginMessage(message)))await owner.client.request("workspace/plugin",{action:"message",instanceId:"fixture",frame});
    };
    const call=(message:Record<string,unknown>)=>new Promise<unknown>((resolve,reject)=>{
      const id=`h${++next}`;pending.set(id,{resolve,reject});void send({...message,id}).catch(reject);
    });
    try{
      expect(owner.client.initialized?.capabilities.workspacePlugins).toBe(1);
      await expect(viewer.client.request("workspace/plugin",{action:"describe"})).rejects.toMatchObject({code:"FORBIDDEN"});
      await expect(owner.client.request("workspace/plugin",{action:"open",instanceId:"bad"})).rejects.toMatchObject({code:"INVALID_ARGUMENT"});
      const pkg=await collectPluginPackage(pkgPath);
      const upload=await owner.client.request<{uploadId:string}>("workspace/plugin",{action:"packageBegin",digest:pkg.digest,bytes:pkg.bytes.length});
      for(let offset=0;offset<pkg.bytes.length;offset+=65536)await owner.client.request("workspace/plugin",{action:"packageChunk",uploadId:upload.uploadId,offset,data:pkg.bytes.subarray(offset,offset+65536).toString("base64")});
      await owner.client.request("workspace/plugin",{action:"packageCommit",uploadId:upload.uploadId});
      await owner.client.request("workspace/plugin",{action:"open",instanceId:"fixture",digest:pkg.digest,entry:"main.cjs",permissions:[],context:{workspaceId:"project",projectId:"project",authority:{kind:"remote",hostKey:"host"},roots:[{path:workspace,name:"Work",primary:true}],platform:"linux",connectionState:"connected",generation:1}});
      await call({t:"init"});
      const result=await call({t:"call",method:"panel.invoke",payload:{channel:"write"}}) as {workspace:{path:string};locale:string;text:string};
      expect(result.workspace.path).toBe(workspace);expect(result.locale).toBe("racp-locale");expect(result.text).toHaveLength(100000);expect(frames).toBeGreaterThan(4);
      expect(await readFile(join(workspace,"marker.txt"),"utf8")).toBe("once");
      owner.link().drop();await flush();await owner.client.connect();
      await expect(send({t:"call",method:"panel.invoke",payload:{channel:"write"}})).rejects.toMatchObject({code:"PLUGIN_GONE"});
      expect(await readFile(join(workspace,"marker.txt"),"utf8")).toBe("once");expect(h.runtime.prompts).toHaveLength(0);
    }finally{
      await owner.client.close();await viewer.client.close();h.server.close();service.dispose();
      await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});
    }
  },15000);
});
