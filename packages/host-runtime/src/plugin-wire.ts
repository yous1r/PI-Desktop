import { randomUUID } from "node:crypto";
import type { PluginWireFrame } from "@pi-desktop/shared";

export const PLUGIN_FRAME_BYTES = 64 * 1024;
export const PLUGIN_MESSAGE_BYTES = 36 * 1024 * 1024;
export const pluginFailure = (code: string, message: string) => Object.assign(new Error(message), { code, errorCode: code });
export function encodePluginMessage(message: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(message, (_key, value) => value instanceof Uint8Array ? Array.from(value) : value));
  if (bytes.length > PLUGIN_MESSAGE_BYTES) throw pluginFailure("LIMIT_EXCEEDED", "Plugin message exceeds the transfer limit");
  return bytes;
}
export function* pluginFrames(bytes: Buffer): Generator<PluginWireFrame> {
  const id = randomUUID(); const total = Math.ceil(bytes.length / PLUGIN_FRAME_BYTES);
  for (let index = 0; index < total; index++) {
    yield { id, index, total, data: bytes.subarray(index * PLUGIN_FRAME_BYTES, (index + 1) * PLUGIN_FRAME_BYTES).toString("base64") };
  }
}
export function decodePluginChunk(data: string): Buffer {
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > PLUGIN_FRAME_BYTES || bytes.toString("base64") !== data) throw pluginFailure("INVALID_ARGUMENT", "Invalid plugin transfer chunk");
  return bytes;
}
/** One ordered transfer at a time; bounded memory and no orphaned partial maps. */
export class PluginMessageDecoder {
  private partial: { id: string; total: number; next: number; chunks: Buffer[]; bytes: number; started: number } | undefined;
  accept(frame: PluginWireFrame): { message: unknown } | undefined {
    const chunk = decodePluginChunk(frame.data);
    if (!this.partial) {
      if (frame.index !== 0 || frame.total < 1 || frame.total > Math.ceil(PLUGIN_MESSAGE_BYTES / PLUGIN_FRAME_BYTES)) throw pluginFailure("INVALID_ARGUMENT", "Invalid plugin frame sequence");
      this.partial = { id: frame.id, total: frame.total, next: 0, chunks: [], bytes: 0, started: Date.now() };
    }
    const part = this.partial;
    if (part.id !== frame.id || part.total !== frame.total || part.next !== frame.index || Date.now() - part.started > 60_000) {
      this.clear(); throw pluginFailure("INVALID_ARGUMENT", "Plugin frame sequence expired or changed");
    }
    part.bytes += chunk.length;
    if (part.bytes > PLUGIN_MESSAGE_BYTES) { this.clear(); throw pluginFailure("LIMIT_EXCEEDED", "Plugin message exceeds the transfer limit"); }
    part.chunks.push(chunk); part.next++;
    if (part.next !== part.total) return undefined;
    this.clear();
    try { return { message: JSON.parse(Buffer.concat(part.chunks, part.bytes).toString("utf8")) as unknown }; }
    catch { throw pluginFailure("INVALID_ARGUMENT", "Invalid plugin JSON message"); }
  }
  clear(): void { this.partial = undefined; }
}
