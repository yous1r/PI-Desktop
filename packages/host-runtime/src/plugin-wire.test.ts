import { describe, expect, it } from "vitest";
import { encodePluginMessage, pluginFrames, PluginMessageDecoder, PLUGIN_MESSAGE_BYTES } from "./plugin-wire.js";
describe("plugin byte transfer", () => {
  it("carries the maximum 8 MiB file range without numeric-key expansion", () => {
    const bytes = new Uint8Array(8 * 1024 * 1024).fill(255); bytes[0] = 0; bytes[bytes.length-1] = 128;
    const encoded = encodePluginMessage({t:"res",value:{bytes,totalSize:bytes.length}});
    expect(encoded.length).toBeLessThan(PLUGIN_MESSAGE_BYTES);
    const decoder = new PluginMessageDecoder(); let result: unknown;
    for (const frame of pluginFrames(encoded)) result = decoder.accept(frame)?.message ?? result;
    const value = (result as {value:{bytes:number[];totalSize:number}}).value;
    expect(Array.isArray(value.bytes)).toBe(true); expect(value.bytes.length).toBe(bytes.length);
    expect(value.bytes[0]).toBe(0); expect(value.bytes[1024]).toBe(255); expect(value.bytes.at(-1)).toBe(128);
    expect(value.totalSize).toBe(bytes.length);
  }, 15000);
  it("still refuses oversized messages and clears mixed frame assemblies", () => {
    expect(()=>encodePluginMessage({text:"x".repeat(PLUGIN_MESSAGE_BYTES)})).toThrow(/limit/);
    const frames = [...pluginFrames(encodePluginMessage({text:"x".repeat(100000)}))];
    const decoder = new PluginMessageDecoder(); decoder.accept(frames[0]);
    expect(()=>decoder.accept({...frames[1],id:"different"})).toThrow(/sequence/);
    expect(decoder.accept([...pluginFrames(encodePluginMessage({ok:true}))][0])?.message).toEqual({ok:true});
  });
});
