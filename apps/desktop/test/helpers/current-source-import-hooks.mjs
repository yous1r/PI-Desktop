import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentSourceAliases } from "./current-source-vite.mjs";
import { resolve as resolveTypescript } from "./owner-runtime-import-hooks.mjs";
export { load } from "./owner-runtime-import-hooks.mjs";

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../../..");
const aliases = currentSourceAliases(root);

export async function resolve(specifier, context, next) {
  for (const { find, replacement } of aliases) {
    if (find.test(specifier)) return next(pathToFileURL(specifier.replace(find, replacement)).href, context);
  }
  return resolveTypescript(specifier, context, next);
}
