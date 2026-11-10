import { resolve as resolveTypescript } from "./ts-import-hooks.mjs";

/** Route `electron` to the controlled surface fixture for surface tests. */
export function resolve(specifier, context, next) {
  if (specifier === "electron") {
    return { url: new URL("./surface-electron.mjs", import.meta.url).href, shortCircuit: true };
  }
  return resolveTypescript(specifier, context, next);
}
