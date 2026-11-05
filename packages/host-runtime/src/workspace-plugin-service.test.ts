import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WorkspacePluginRequest, WorkspacePluginEvent, WorkspaceExecutionContext } from "@pi-desktop/shared";
import { WorkspacePluginService } from "./workspace-plugin-service.js";
import { collectPluginPackage, safePluginPackagePath } from "./plugin-packages.js";
import { encodePluginMessage, pluginFrames, PluginMessageDecoder } from "./plugin-wire.js";

describe("workspace Node plugin service", () => {
  it("uploads verified code, runs native fs/process calls, bridges APIs, chunks media, and closes on disconnect", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "workspace-plugin-")));
    const packageDir = join(root, "plugin"); const workspace = join(root, "work");
    await mkdir(packageDir); await mkdir(workspace);
    const manifest = { schemaVersion: 1, id: "fixture.workspace", version: "1.0.0", main: "main.cjs", execution: { main: "workspace" } };
    await writeFile(join(packageDir, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(packageDir, "main.cjs"), `
      const fs = require('node:fs'); const cp = require('node:child_process');
      exports.onPanelInvoke = async (channel) => {
        const workspace = await pi.workspace.get();
        if (channel === 'mutate') fs.appendFileSync('marker.txt', 'one');
        return { cwd: process.cwd(), workspace, dataPath: await pi.plugin.getDataPath(),
          locale: await pi.app.getLocale(), child: cp.execFileSync(process.execPath, ['-p', 'process.cwd()'], {encoding:'utf8'}).trim(),
          text: channel === 'media' ? '字'.repeat(700000) : 'ok', secret: process.env.PROVIDER_API_KEY || null };
      };
    `);
    const service = new WorkspacePluginService({ dataDir: join(root, "state"), runner: resolve("packages/host-runtime/plugin-host-process.mjs"), env: { ...process.env, PROVIDER_API_KEY: "must-not-cross" } });
    const owner = { deviceId: "desktop", connectionId: "one" }; const decoder = new PluginMessageDecoder();
    const responses = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
    let next = 0; let frameCount = 0;
    const request = (input: WorkspacePluginRequest) => service.handle(input, owner, sink);
    const send = async (message: unknown) => { for (const frame of pluginFrames(encodePluginMessage(message))) await request({ action: "message", instanceId: "instance", frame }); };
    const sink = async (event: WorkspacePluginEvent) => {
      if (!("frame" in event)) return;
      frameCount++; const decoded = decoder.accept(event.frame); if (!decoded) return;
      const message = decoded.message as {t:string;id:string;api?:string;ok?:boolean;value?:unknown;error?:{message:string}};
      if (message.t === "call") {
        expect(message.api).toBe("app.getLocale");
        await send({ t: "res", id: message.id, ok: true, value: "en-test" });
      } else if (message.t === "res") {
        const pending = responses.get(message.id); responses.delete(message.id);
        if (message.ok) pending?.resolve(message.value); else pending?.reject(new Error(message.error?.message));
      }
    };
    const call = (message: Record<string, unknown>): Promise<unknown> => {
      const id = `p${++next}`;
      return new Promise((resolve, reject) => { responses.set(id, {resolve,reject}); void send({...message,id}).catch(reject); });
    };
    try {
      const pkg = await collectPluginPackage(packageDir);
      const begin = await request({action:"packageBegin",digest:pkg.digest,bytes:pkg.bytes.length}) as {uploadId:string};
      for (let offset = 0; offset < pkg.bytes.length; offset += 65536) await request({action:"packageChunk",uploadId:begin.uploadId,offset,data:pkg.bytes.subarray(offset,offset+65536).toString("base64")});
      await request({action:"packageCommit",uploadId:begin.uploadId});
      const context: WorkspaceExecutionContext = {workspaceId:"work",projectId:"project",authority:{kind:"remote",hostKey:"test-host"},roots:[{path:workspace,name:"Work",primary:true}],platform:"linux",connectionState:"connected",generation:1};
      await request({action:"open",instanceId:"instance",digest:pkg.digest,entry:"main.cjs",context,permissions:[]});
      await call({t:"init"});
      const result = await call({t:"call",method:"panel.invoke",payload:{channel:"mutate"}}) as {cwd:string;child:string;locale:string;secret:unknown;workspace:{path:string;executionContext:WorkspaceExecutionContext};dataPath:string};
      expect(result.cwd).toBe(workspace); expect(result.child).toBe(workspace); expect(result.workspace.path).toBe(workspace);
      expect(result.workspace.executionContext.authority).toEqual(context.authority);
      expect(result.locale).toBe("en-test"); expect(result.secret).toBeNull(); expect(result.dataPath.startsWith(join(root,"state"))).toBe(true);
      expect(await readFile(join(workspace,"marker.txt"),"utf8")).toBe("one");
      const media = await call({t:"call",method:"panel.invoke",payload:{channel:"media"}}) as {text:string};
      expect(media.text.length).toBe(700000); expect(frameCount).toBeGreaterThan(20);
      await expect(service.handle({action:"close",instanceId:"instance"},{deviceId:"other",connectionId:"one"},sink)).rejects.toMatchObject({code:"FORBIDDEN"});
      service.disconnect(owner.connectionId);
      await expect(request({action:"message",instanceId:"instance",frame:[...pluginFrames(encodePluginMessage({t:"call"}))][0]})).rejects.toMatchObject({code:"PLUGIN_GONE"});
      expect(await readFile(join(workspace,"marker.txt"),"utf8")).toBe("one");
    } finally { service.dispose(); await rm(root, {recursive:true,force:true,maxRetries:10,retryDelay:50}); }
  }, 15000);
  it("rejects traversal, credential paths, native modules, and malformed frame ordering", () => {
    for (const path of ["../escape", "/root", "a/../../b", "a\\b", "C:/root", ".env.local", ".ssh/id_rsa", "a.node", "CON.js", "node_modules/x.js"]) expect(safePluginPackagePath(path)).toBe(false);
    const decoder = new PluginMessageDecoder();
    expect(() => decoder.accept({id:"a",index:1,total:2,data:"eA=="})).toThrow();
    expect(() => decoder.accept({id:"a",index:0,total:1,data:"!"})).toThrow();
  });
});
