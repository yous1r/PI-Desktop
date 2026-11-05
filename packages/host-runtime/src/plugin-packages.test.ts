import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WorkspacePluginPackages } from "./plugin-packages.js";
const owner = {deviceId:"desktop",connectionId:"one"};
function artifact() {
  const manifest = {id:"test.package",version:"1",main:"main.cjs",execution:{main:"workspace"}};
  const bytes = Buffer.from(JSON.stringify({files:[{path:"manifest.json",data:Buffer.from(JSON.stringify(manifest)).toString("base64")},{path:"main.cjs",data:Buffer.from("exports.onLoad=()=>{};").toString("base64")}]}));
  return {bytes,digest:createHash("sha256").update(bytes).digest("hex")};
}
describe("workspace package admission", () => {
  it("rejects disconnected initialization and revoked extraction without admitting executable code", async () => {
    const root=await mkdtemp(join(tmpdir(),"plugin-admission-")); const service=new WorkspacePluginPackages(root); const pkg=artifact();
    try {
      const pending=service.begin(pkg.digest,pkg.bytes.length,owner); service.disconnect(owner.connectionId);
      await expect(pending).rejects.toMatchObject({code:"FORBIDDEN"});
      const begin=await service.begin(pkg.digest,pkg.bytes.length,owner);
      service.chunk(begin.uploadId!,0,pkg.bytes.toString("base64"),owner);
      const commit=service.commit(begin.uploadId!,owner); service.revoke(owner.deviceId);
      await expect(commit).rejects.toMatchObject({code:"FORBIDDEN"});
      expect(()=>service.get(pkg.digest)).toThrow(/uploaded/);
      const admitted=await service.begin(pkg.digest,pkg.bytes.length,owner);
      service.chunk(admitted.uploadId!,0,pkg.bytes.toString("base64"),owner);
      await service.commit(admitted.uploadId!,owner);
      expect(service.get(pkg.digest).manifest.id).toBe("test.package");
    } finally {service.dispose(); await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
  it("rejects digest mismatch and cross-device uploads", async () => {
    const root=await mkdtemp(join(tmpdir(),"plugin-digest-")); const service=new WorkspacePluginPackages(root); const pkg=artifact();
    try {
      const begin=await service.begin("a".repeat(64),pkg.bytes.length,owner);
      expect(()=>service.chunk(begin.uploadId!,0,pkg.bytes.toString("base64"),{...owner,deviceId:"other"})).toThrow(/unavailable/);
      service.chunk(begin.uploadId!,0,pkg.bytes.toString("base64"),owner);
      await expect(service.commit(begin.uploadId!,owner)).rejects.toMatchObject({code:"PLUGIN_INVALID"});
      expect(()=>service.get("a".repeat(64))).toThrow(/uploaded/);
    } finally {service.dispose(); await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
});
