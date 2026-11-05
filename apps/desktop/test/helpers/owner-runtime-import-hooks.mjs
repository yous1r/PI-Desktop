/** Owner integration tests import the complete runtime, including TS parameter properties. */
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
export { resolve } from "./ts-import-hooks.mjs";
export async function load(url, context, next) {
  if (!url.endsWith(".ts")) return next(url, context);
  const source = await readFile(new URL(url), "utf8");
  const { code } = await transform(source, { loader: "ts", format: "esm", target: "node24", sourcefile: url });
  return { format: "module", source: code, shortCircuit: true };
}
