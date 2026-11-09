import { resolve } from "node:path";

/** Use this request's sources even when node_modules is shared with a checkout.
 * An optional already-provisioned dependency root avoids installing a second
 * environment; normal CI uses the repository's installed dependency versions. */
export function currentSourceAliases(root) {
  const aliases = ["shared", "agent-host", "host-runtime", "agent-runtime", "plugin-sdk", "racp", "i18n"].map(name => ({
    find: new RegExp(`^@pi-desktop/${name}$`), replacement: resolve(root, `packages/${name}/src/index.ts`),
  }));
  aliases.push({ find: /^@pi-desktop\/host-runtime\/mcp\/(.*)$/, replacement: resolve(root, "packages/host-runtime/src/mcp/$1.ts") });
  aliases.push({ find: /^@pi-desktop\/racp\/test-harness$/, replacement: resolve(root, "packages/racp/src/test-harness.ts") });
  aliases.push({ find: /^@pi-desktop\/voice-runtime\/live$/, replacement: resolve(root, "packages/voice-runtime/src/live/index.ts") });
  const dependencies = process.env.PI_COMMAND_CENTER_DEPENDENCIES;
  if (dependencies) {
    const pi = resolve(dependencies, "node_modules/@earendil-works");
    aliases.push(
      { find: /^@earendil-works\/pi-ai$/, replacement: `${pi}/pi-ai/dist/index.js` },
      { find: /^@earendil-works\/pi-ai\/(.*)$/, replacement: `${pi}/pi-ai/dist/$1.js` },
      { find: /^@earendil-works\/pi-agent-core$/, replacement: `${pi}/pi-agent-core/dist/index.js` },
      { find: /^@earendil-works\/pi-coding-agent$/, replacement: `${pi}/pi-coding-agent/dist/index.js` },
    );
  }
  return aliases;
}
