import type { PluginHostApi } from "@pi-desktop/plugin-sdk";

/** Keep Desktop APIs and execution-host file APIs separate at the broker boundary. */
export function workspaceFileApi(call: <T>(api: string, args: unknown[]) => Promise<T>): PluginHostApi["fs"] {
  return {
    readText: path => call("fs.readText", [path]),
    stat: (path, grant) => call("fs.stat", [path, grant]),
    readRange: async (path, offset, length, grant) => {
      const result = await call<{bytes:number[];totalSize:number}>("fs.readRange", [path, offset, length, grant]);
      return {bytes:Uint8Array.from(result.bytes),totalSize:result.totalSize};
    },
    readPreview: (path, options) => call("fs.readPreview", [path, options]),
    openDefault: path => call("fs.openDefault", [path]),
    openInBrowser: path => call("fs.openInBrowser", [path]),
    reveal: path => call("fs.reveal", [path]),
    writeText: (path, text) => call("fs.writeText", [path, text]),
    glob: pattern => call("fs.glob", [pattern]),
    list: (path, options) => call("fs.list", [path, options]),
    remove: path => call("fs.remove", [path]),
    requestDirectory: () => call("fs.requestDirectory", []),
  };
}
