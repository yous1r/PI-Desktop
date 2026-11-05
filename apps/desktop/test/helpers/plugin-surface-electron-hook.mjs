import { resolve as resolveTypescript } from "./ts-import-hooks.mjs";
export function resolve(specifier, context, next) {
  if (specifier === "electron") return { url: new URL("./plugin-surface-electron.mjs", import.meta.url).href, shortCircuit: true };
  return resolveTypescript(specifier, context, next);
}
